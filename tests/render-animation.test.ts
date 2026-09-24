import assert from "node:assert/strict";
import test from "node:test";

import { ToolExecutionComponent, initTheme } from "@earendil-works/pi-coding-agent";
import { Container } from "@earendil-works/pi-tui";

import { clearAllAnimations, scheduleAnimation } from "../extensions/renderer/tool/result.ts";
import { installToolGrouping, ToolGroupComponent } from "../extensions/renderer/tool/grouping.ts";
import { getToolMouseTui, setToolMouseTui } from "../extensions/renderer/mouse/scroll.ts";
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

function fakeTui(rows = 24) {
	const state = { renders: 0 };
	return {
		tui: {
			terminal: { columns: 100, rows, write() {} },
			children: [] as any[],
			previousLines: [] as string[],
			previousViewportTop: 0,
			requestRender() {
				state.renders++;
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
