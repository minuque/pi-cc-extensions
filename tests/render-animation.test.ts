import assert from "node:assert/strict";
import test from "node:test";

import { ToolExecutionComponent, initTheme } from "@earendil-works/pi-coding-agent";
import { Container } from "@earendil-works/pi-tui";

import { config } from "../extensions/config/config.ts";
import { installDefaultMode } from "../extensions/renderer/default-mode.ts";
import { installToolGrouping, ToolGroupComponent } from "../extensions/renderer/tool/grouping.ts";
import { getToolMouseTui, setToolMouseTui } from "../extensions/renderer/mouse/scroll.ts";
import { WriteExecutionMetadataStore } from "../extensions/renderer/tool/diff/index.ts";
import { clearAllAnimations, scheduleAnimation } from "../extensions/renderer/tool/result.ts";
import { TOOL_LOADING_INTERVAL_MS } from "../extensions/utils/tool-loading-icon.ts";

initTheme("dark");

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const tickWait = () => wait(TOOL_LOADING_INTERVAL_MS + 40);

function toolUi() {
	const state = { renders: 0 };
	const ui = {
		theme: { fg: (_color: string, text: string) => text },
		requestRender() {
			state.renders++;
		},
	} as any;
	return { ui, state };
}

function fakeTui(rows = 24, onRender?: () => void) {
	const state = { renders: 0 };
	return {
		tui: {
			terminal: { columns: 100, rows, write() {} },
			children: [] as any[],
			previousLines: [] as string[],
			previousViewportTop: 0,
			requestRender() {
				state.renders++;
				onRender?.();
			},
			doRender() {
				this.previousLines = this.children.flatMap((child: any) => child.render(100));
			},
		} as any,
		state,
	};
}

function restoreTuiSlot(previous: unknown) {
	setToolMouseTui(previous);
}

async function waitForRenderCount(state: { renders: number }, expected: number): Promise<void> {
	for (let attempt = 0; attempt < 30 && state.renders < expected; attempt++) await wait(10);
	assert.equal(state.renders, expected);
}

test("pending 分组的动画 tick 自己请求渲染", async () => {
	const hooks = installToolGrouping(() => true);
	const { ui, state } = toolUi();
	try {
		const parent = new Container() as any;
		for (const id of ["a", "b"]) {
			const tool = new ToolExecutionComponent(
				"read",
				id,
				{ path: `${id}.ts` },
				{},
				undefined,
				ui,
				process.cwd(),
			) as any;
			tool.markExecutionStarted();
			parent.addChild(tool);
		}
		const group = parent.children[0] as ToolGroupComponent;
		group.render(100);
		const before = state.renders;
		await tickWait();
		assert.ok(
			state.renders > before,
			"分组卡 invalidate() 不会请求渲染，tick 必须补一次，否则 spinner 只在别人渲染时跳帧",
		);
	} finally {
		hooks.shutdown();
	}
});

test("pending 单工具的 paint cache 不得冻住 spinner", async () => {
	const previousMode = config.mode;
	const previousTui = getToolMouseTui();
	const originalNow = Date.now;
	let now = 0;
	Date.now = () => now;
	config.mode = "on";
	const hooks = installDefaultMode(new WriteExecutionMetadataStore());
	const { ui } = toolUi();
	const paintedFrames: string[] = [];
	let tool: any;
	const { tui, state } = fakeTui(24, () => paintedFrames.push(tool.render(80).join("\n")));
	setToolMouseTui(tui);
	try {
		tool = new ToolExecutionComponent(
			"read",
			"animated-single-tool",
			{ path: "a.ts" },
			{},
			undefined,
			ui,
			process.cwd(),
		) as any;
		const restored = tool.render(80);
		assert.equal(tool.render(80), restored, "an unstarted restored row remains cacheable");

		tool.markExecutionStarted();
		const first = tool.render(80);
		assert.match(first.join("\n"), /⠋/, "time zero should render the first spinner frame");

		now = TOOL_LOADING_INTERVAL_MS;
		await waitForRenderCount(state, 1);
		assert.match(paintedFrames.at(-1)!, /⠙/, "the first tick must paint the next frame");

		now = TOOL_LOADING_INTERVAL_MS * 2;
		await waitForRenderCount(state, 2);
		assert.match(paintedFrames.at(-1)!, /⠹/, "painting must renew the animation timer");
		assert.notDeepEqual(paintedFrames[0], first.join("\n"));

		tool.updateResult({ content: [{ type: "text", text: "done" }], isError: false });
		const settled = tool.render(80);
		assert.equal(tool.render(80), settled, "a completed tool regains settled paint caching");
	} finally {
		Date.now = originalNow;
		clearAllAnimations();
		restoreTuiSlot(previousTui);
		hooks.shutdown();
		config.mode = previousMode;
	}
});

test("light 动画 tick 只请求重绘，不重建工具卡", async () => {
	const previous = getToolMouseTui();
	const { tui, state } = fakeTui();
	setToolMouseTui(tui);
	let invalidates = 0;
	const context = {
		state: {},
		invalidate() {
			invalidates++;
		},
	};
	try {
		scheduleAnimation(context, { light: true });
		await tickWait();
		assert.equal(state.renders, 1, "light 上下文应由 TUI 重绘一次");
		assert.equal(invalidates, 0, "light 上下文不该再走 updateDisplay 全量重建");
	} finally {
		clearAllAnimations();
		restoreTuiSlot(previous);
	}
});

test("light 标志结束后复位，后续非 light 走 invalidate", async () => {
	const previous = getToolMouseTui();
	const { tui, state } = fakeTui();
	setToolMouseTui(tui);
	let invalidates = 0;
	const context = {
		state: {},
		invalidate() {
			invalidates++;
		},
	};
	try {
		scheduleAnimation(context, { light: true });
		await tickWait();
		assert.equal(state.renders, 1);
		assert.equal(invalidates, 0);

		scheduleAnimation(context);
		await tickWait();
		assert.equal(invalidates, 1, "light 结束后非 light 应走 invalidate");
		assert.equal(state.renders, 1, "非 light 不应再只靠 TUI requestRender");
	} finally {
		clearAllAnimations();
		restoreTuiSlot(previous);
	}
});
