import assert from "node:assert/strict";
import test from "node:test";

import { ToolExecutionComponent, initTheme } from "@earendil-works/pi-coding-agent";
import { Container } from "@earendil-works/pi-tui";

import { clearAllAnimations, scheduleAnimation } from "../extensions/renderer/tool/result.ts";
import { installToolGrouping, ToolGroupComponent } from "../extensions/renderer/tool/grouping.ts";
import { installToolMouseInteraction } from "../extensions/renderer/mouse/interaction.ts";
import { teardownToolMouseInteraction } from "../extensions/renderer/mouse/interaction.ts";
import { getToolMouseTui, setToolMouseTui } from "../extensions/renderer/mouse/scroll.ts";
import { isHeaderVisible } from "../extensions/renderer/tool/header-visibility.ts";
import { setToolTuiFullscreen } from "../extensions/renderer/tool/show-more-hint.ts";
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

test("卡片头部滚出视口后停掉 spinner 动画", async () => {
	const previous = getToolMouseTui();
	const { tui, state } = fakeTui();
	setToolMouseTui(tui);
	setToolTuiFullscreen(false);
	let invalidates = 0;
	const context = {
		state: { ccstyleHeaderVisible: false } as Record<string, unknown>,
		invalidate() {
			invalidates++;
		},
	};
	try {
		scheduleAnimation(context, { light: true });
		await tickWait();
		assert.equal(state.renders, 0, "视口外的 spinner 不该继续驱动重绘");
		assert.equal(invalidates, 0);
		assert.ok(!context.state.ccstyleAnimationScheduled, "视口外的上下文不该进入动画队列");
	} finally {
		clearAllAnimations();
		restoreTuiSlot(previous);
		setToolTuiFullscreen(true);
	}
});

test("分组卡头部滚出视口后停掉分组动画", async () => {
	const previous = getToolMouseTui();
	const hooks = installToolGrouping(() => true);
	const { ui, state } = toolUi();
	const { tui } = fakeTui(6);
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
	tui.children = [parent];
	setToolTuiFullscreen(false);
	try {
		installToolMouseInteraction({
			mode: "tui",
			hasUI: true,
			ui: {
				setWidget(_key: string, factory: any) {
					factory?.(tui, ui.theme);
				},
				onTerminalInput() {
					return () => undefined;
				},
			},
		});
		tui.doRender();
		assert.equal(isHeaderVisible(group), true, "分组头部在可视区内");
		tui.previousViewportTop = 40;
		tui.doRender();
		assert.equal(isHeaderVisible(group), false, "分组头部已在可视区上方");
		group.render(100);
		const before = state.renders;
		await tickWait();
		assert.equal(state.renders, before, "视口外的分组动画不该继续请求渲染");
	} finally {
		teardownToolMouseInteraction();
		restoreTuiSlot(previous);
		setToolTuiFullscreen(true);
		hooks.shutdown();
	}
});

test("帧捕获按视口位置标注卡片头部可见性", () => {
	const previous = getToolMouseTui();
	const { ui } = toolUi();
	const { tui } = fakeTui(6);
	const parent = new Container() as any;
	const tool = new ToolExecutionComponent(
		"read",
		"vis",
		{ path: "a.ts" },
		{},
		undefined,
		ui,
		process.cwd(),
	) as any;
	tool.markExecutionStarted();
	parent.addChild(tool);
	tui.children = [parent];
	setToolTuiFullscreen(false);
	try {
		installToolMouseInteraction({
			mode: "tui",
			hasUI: true,
			ui: {
				setWidget(_key: string, factory: any) {
					factory?.(tui, ui.theme);
				},
				onTerminalInput() {
					return () => undefined;
				},
			},
		});
		tui.doRender();
		assert.equal(isHeaderVisible(tool), true, "卡片首行在可视区内");
		// 转录长过视口后头部落到可视区上方
		tui.previousViewportTop = 50;
		tui.doRender();
		assert.equal(isHeaderVisible(tool), false, "卡片首行已在可视区上方");
	} finally {
		teardownToolMouseInteraction();
		restoreTuiSlot(previous);
		setToolTuiFullscreen(true);
	}
});

test("fullscreen 不看 regular 遗留的可见性标记", async () => {
	const previous = getToolMouseTui();
	const { tui, state } = fakeTui();
	setToolMouseTui(tui);
	setToolTuiFullscreen(true);
	let invalidates = 0;
	const context = {
		state: { ccstyleHeaderVisible: false } as Record<string, unknown>,
		invalidate() {
			invalidates++;
		},
	};
	try {
		// regular 阶段留下的 stale 标记不能把 fullscreen 的 spinner 冻住
		assert.equal(isHeaderVisible({ rendererState: { ccstyleHeaderVisible: false } }), true);
		scheduleAnimation(context, { light: true });
		await tickWait();
		assert.equal(state.renders, 1, "fullscreen 应照常按帧重绘");
		assert.equal(invalidates, 0);
	} finally {
		clearAllAnimations();
		restoreTuiSlot(previous);
	}
});
