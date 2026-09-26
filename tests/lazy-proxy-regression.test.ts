import assert from "node:assert/strict";
import test from "node:test";

import {
	AssistantMessageComponent,
	getMarkdownTheme,
	initTheme,
	SkillInvocationMessageComponent,
	ToolExecutionComponent,
	type ParsedSkillBlock,
} from "@earendil-works/pi-coding-agent";
import claudeCodeStyleExtension, {
	ExpandedToolIoView,
	installToolMouseInteraction,
	SHOW_MORE_LABEL,
} from "../extensions/renderer/index.ts";
import { showTextPreview } from "../extensions/feature/context.ts";
import { config } from "../extensions/config/config.ts";
import { sharedToolHoverState, isToolCallHovered } from "../extensions/renderer/mouse/hover.ts";
import { installCompactMode } from "../extensions/renderer/compact-mode.ts";
import {
	getMessageDisplayTheme,
	installMessageDisplayRendering,
	setMessageDisplayTheme,
} from "../extensions/renderer/tool/message-display.ts";
import { ToolGroupComponent } from "../extensions/renderer/tool/grouping.ts";
import {
	installCompactThinking,
	ThinkingPreviewBlock,
} from "../extensions/feature/compact-thinking.ts";
import { WriteExecutionMetadataStore } from "../extensions/renderer/tool/diff/write-execution.ts";
import {
	renderRichToolResult,
	DEFAULT_TOOL_DISPLAY_CONFIG,
} from "../extensions/renderer/tool/diff/index.ts";
import { insetComponent } from "../extensions/renderer/tool/result.ts";

// 0.84+ 的稳定 TUI 引用会在 renderer 切换时重绑方法。插件不得捕获后回写
// doRender/render/handleInput；regular 的工具点击改为按左键输入即时捕获内存 frame。

initTheme("dark");

/** 精确模拟 Pi 0.84.1 createInteractiveTuiReference 的 renderer 重绑语义。 */
function createLazyProxy<T extends object>(getRenderer: () => T): T {
	return new Proxy({} as T, {
		get: (_target, property) => {
			const tui = getRenderer();
			const value = Reflect.get(tui, property, tui);
			if (typeof value !== "function") return value;
			let methodTui = tui;
			let method = value;
			return (...args: any[]) => {
				const currentTui = getRenderer();
				if (currentTui !== methodTui) {
					const currentMethod = Reflect.get(currentTui, property, currentTui);
					if (typeof currentMethod !== "function") {
						throw new TypeError(`not callable: ${String(property)}`);
					}
					methodTui = currentTui;
					method = currentMethod;
				}
				return Reflect.apply(method, methodTui, args);
			};
		},
		set: (_target, property, value) => Reflect.set(getRenderer(), property, value),
		has: (_target, property) => Reflect.has(getRenderer(), property),
		getPrototypeOf: () => Reflect.getPrototypeOf(getRenderer()),
	});
}

function runtime() {
	const events = new Map<string, Function>();
	return {
		pi: {
			registerCommand() {},
			registerShortcut() {},
			registerTool() {},
			on(name: string, handler: Function) {
				events.set(name, handler);
			},
		},
		events,
	};
}

function theme() {
	return { fg: (color: string, text: string) => `<${color}>${text}</${color}>` };
}

/** 工具桩：模拟 Tool 的最小形状（resultRendererComponent 由个别用例注入）。 */
type ToolStub = {
	toolCallId: string;
	expanded: boolean;
	renderCalls: number;
	resultRendererComponent?: unknown;
	setExpanded(value: boolean): void;
	invalidate(): void;
	render(): string[];
};

function createTool(toolCallId: string): ToolStub {
	return {
		toolCallId,
		expanded: false,
		renderCalls: 0,
		setExpanded(value: boolean) {
			this.expanded = value;
		},
		invalidate() {},
		render() {
			this.renderCalls++;
			return ["✓ Bash(echo ok)", "  └ 1 line output (ctrl+o expand / click)"];
		},
	};
}

/** 官方 TuiAltScreen 的最小模型（regular/fullscreen 共用形状）。 */
type RendererStub = {
	mode: "regular" | "fullscreen";
	children: any[];
	previousViewportTop: number;
	doRenderCalls: number;
	terminal: any;
	requestRender(): void;
	render(width: number): string[];
	doRender(): void;
	handleInput(data: string): void;
};

function createRenderer(
	mode: "regular" | "fullscreen",
	children: any[],
	terminal: any,
): RendererStub {
	return {
		mode,
		children,
		previousViewportTop: 0,
		doRenderCalls: 0,
		terminal,
		requestRender() {},
		render(width: number) {
			return this.children.flatMap((child: any) => child.render(width));
		},
		doRender() {
			this.doRenderCalls++;
			this.render(80);
		},
		handleInput(_data: string) {},
	};
}

/** 带写入记录的终端 fixture：writes 收集插件写出的所有序列。 */
function createTerminalFixture() {
	const writes: string[] = [];
	const terminal = {
		columns: 80,
		rows: 24,
		write(data: string) {
			writes.push(data);
		},
	};
	return { terminal, writes };
}

function createUi(tui: any) {
	let inputHandler: ((data: string) => { consume?: boolean } | undefined) | undefined;
	let widget: any;
	let terminalInputCalls = 0;
	const notifications: string[] = [];
	return {
		ctx: {
			mode: "tui",
			hasUI: true,
			ui: {
				theme: theme(),
				setStatus() {},
				requestRender() {},
				setWidget(_key: string, content: any) {
					if (typeof content === "function") widget = content(tui, theme());
				},
				onTerminalInput(handler: typeof inputHandler) {
					terminalInputCalls++;
					inputHandler = handler;
					return () => {
						if (inputHandler === handler) inputHandler = undefined;
					};
				},
				notify(message: string) {
					notifications.push(message);
				},
				setFooter() {},
			},
		} as any,
		get inputHandler() {
			return inputHandler;
		},
		get widget() {
			return widget;
		},
		get terminalInputCalls() {
			return terminalInputCalls;
		},
		get notifications() {
			return notifications;
		},
	};
}

test("lazy-proxy tui: regular stands down without mouse reporting (terminal scrollback preserved)", async () => {
	const tool = createTool("tool-1");
	const { terminal, writes } = createTerminalFixture();
	let renderer = createRenderer("regular", [tool], terminal);
	const tui = createLazyProxy(() => renderer);
	const ui = createUi(tui);
	const { pi, events } = runtime();
	claudeCodeStyleExtension(pi as any, { mode: "on" });
	await events.get("session_start")?.({}, ui.ctx);

	assert.equal(ui.terminalInputCalls, 1);
	// regular lazy proxy 不启用任何 reporting：终端回滚（滚轮）必须保持原生行为。
	assert.ok(!writes.some((value) => value.includes("?1000h")), "no click reporting in regular");
	assert.ok(!writes.some((value) => value.includes("?1003h")), "no motion reporting in regular");

	// 不得捕获回写惰性 Proxy 方法，也不得递归。
	renderer.doRender();
	renderer.handleInput("x");
	assert.equal(renderer.doRenderCalls, 1);

	// 无 reporting：SGR 点击不会到达扩展（终端不产生），handler 对键盘/其他输入让位。
	const hintCol = tool.render()[1].indexOf("/ click") + 1;
	assert.equal(ui.inputHandler?.(`\x1b[<0;${hintCol};2M`), undefined);
	assert.equal(tool.expanded, false);

	installToolMouseInteraction({});
	assert.ok(
		!writes.some((value) => value.includes("?1000l") && value.includes("?1006l")),
		"teardown does not touch terminal mouse modes it never enabled",
	);
});

/** 官方 LayoutFrame 树的最小模型。 */
type FakeBox = {
	component: any;
	parent?: FakeBox;
	rect: { x: number; y: number; width: number; height: number };
	clip: { x: number; y: number; width: number; height: number };
	children: FakeBox[];
	lines?: string[];
	scrollView?: FakeScrollView;
	scrollContentLines?: string[];
};

type FakeScrollView = {
	isScrollbarVisible: boolean;
	scrollTop: number;
	isFollowingEnd: boolean;
	getContentWidth(width: number): number;
};

/** 官方 TuiAltScreen 布局树的最小模型：leaf box 是容器（documentContainer/
 * widgetContainer），工具卡与按钮在其 children 内，按行定位。 */
function fullscreenLayout(tool: any, widget: any, scrollbarVisible = false) {
	const tools = Array.isArray(tool) ? tool : [tool];
	const toolLines = tools.flatMap((t: any) => t.render(80));
	const docContainer: any = { children: tools };
	const toolBox: FakeBox = {
		component: docContainer,
		rect: { x: 0, y: 0, width: 80, height: toolLines.length },
		clip: { x: 0, y: 0, width: 80, height: 20 },
		children: [],
		lines: toolLines,
	};
	const widgetLines = widget ? widget.render(80) : [];
	const widgetContainer: any = { children: widget ? [widget] : [] };
	const widgetBox: FakeBox = {
		component: widgetContainer,
		rect: { x: 0, y: 20, width: 80, height: Math.max(1, widgetLines.length) },
		clip: { x: 0, y: 20, width: 80, height: 4 },
		children: [],
		lines: widgetLines,
	};
	const scrollBox: FakeBox = {
		component: null,
		rect: { x: 0, y: 0, width: 80, height: 20 },
		clip: { x: 0, y: 0, width: 80, height: 20 },
		children: [toolBox],
		scrollView: {
			isScrollbarVisible: scrollbarVisible,
			scrollTop: 0,
			isFollowingEnd: true,
			// 与官方一致：滚动条可见时内容宽度让出最后一列。
			getContentWidth: (width: number) => (scrollbarVisible ? Math.max(1, width - 1) : width),
		},
		scrollContentLines: toolBox.lines,
	};
	const dockBox: FakeBox = {
		component: null,
		rect: { x: 0, y: 20, width: 80, height: 4 },
		clip: { x: 0, y: 20, width: 80, height: 4 },
		children: [widgetBox],
	};
	return {
		root: {
			component: null,
			rect: { x: 0, y: 0, width: 80, height: 24 },
			clip: { x: 0, y: 0, width: 80, height: 24 },
			children: [scrollBox, dockBox],
		},
		primaryScrollView: scrollBox.scrollView,
	};
}

class FullscreenRenderer {
	mode = "fullscreen";
	children: any[];
	terminal: any;
	officialInputs: string[] = [];
	currentLayout: any;
	scrollBottomCalls = 0;
	renderCalls = 0;
	wheelScrollLines = 1;
	altScreenActive = true;
	mouseEnabled = true;

	constructor(tool: any, widget: any, terminal: any) {
		this.children = [tool];
		this.terminal = terminal;
		this.currentLayout = fullscreenLayout(tool, widget);
	}

	// 官方链：原型方法，实例包装后作为 original 放行目标。
	handleViewportInput(data: string) {
		this.officialInputs.push(data);
		return { consume: true };
	}

	requestRender() {
		this.renderCalls++;
	}

	render(width: number) {
		return this.children.flatMap((child: any) => child.render(width));
	}

	hasOverlay() {
		return false;
	}

	scrollToBottom() {
		this.scrollBottomCalls++;
		this.currentLayout.primaryScrollView.isFollowingEnd = true;
	}

	getPrimaryScrollView() {
		return this.currentLayout.primaryScrollView;
	}

	get isFollowingOutput() {
		return this.currentLayout.primaryScrollView.isFollowingEnd;
	}
}

test("lazy-proxy tui: fullscreen owns all-motion under a multiplexer", () => {
	const previousTmux = process.env.TMUX;
	process.env.TMUX = "test";
	const tool = createTool("tool-motion");
	const { terminal, writes } = createTerminalFixture();
	let renderer: FullscreenRenderer | RendererStub = new FullscreenRenderer(tool, null, terminal);
	renderer.altScreenActive = false;
	const tui = createLazyProxy(() => renderer);
	const ui = createUi(tui);
	try {
		installToolMouseInteraction(ui.ctx);
		assert.ok(!writes.some((value) => value.includes("?1003h")), "startup is not preempted");
		renderer.altScreenActive = true;
		ui.widget.render();
		assert.ok(
			writes.some((value) => value.includes("?1003h")),
			"hover motion is enabled after startup",
		);
		const disablesBeforeSwitch = writes.filter((value) => value.includes("?1003l")).length;
		renderer = createRenderer("regular", [tool], terminal);
		ui.widget.render();
		assert.equal(
			writes.filter((value) => value.includes("?1003l")).length,
			disablesBeforeSwitch + 1,
			"fullscreen → regular releases owned motion",
		);
		installToolMouseInteraction({});
	} finally {
		installToolMouseInteraction({});
		if (previousTmux === undefined) delete process.env.TMUX;
		else process.env.TMUX = previousTmux;
	}
});

test("lazy-proxy tui: fullscreen tool clicks expand and official input passes through", async () => {
	// 步进数来自用户配置，测试固定为默认 3（避免受本机 pi-cc-extensions.json 影响）。
	const previousStep = config.scrollStepLines;
	config.scrollStepLines = 3;
	const tool = createTool("tool-fullscreen");
	const { terminal, writes } = createTerminalFixture();
	let renderer = new FullscreenRenderer(tool, null, terminal);
	const tui = createLazyProxy(() => renderer);
	const ui = createUi(tui);
	installToolMouseInteraction(ui.ctx);

	assert.equal(renderer.wheelScrollLines, 3, "fullscreen native wheel step is raised to 3");
	assert.ok(
		!writes.some((value) => value.includes("?1000h")),
		"click reporting belongs to official",
	);
	assert.ok(
		writes.some((value) => value.includes("?1003h")),
		"extension reasserts hover motion after official startup",
	);
	// collapsed 仅 hint 文本可点；同一行正文/留白必须放行官方。
	tui.handleViewportInput(`\x1b[<0;2;2M`);
	assert.equal(tool.expanded, false, "tool row outside hint is not clickable");
	assert.equal(renderer.officialInputs.length, 1);
	renderer.officialInputs.length = 0;
	const collapsedHintCol = tool.render()[1].indexOf("(ctrl+o expand / click)") + 1;
	tui.handleViewportInput(`\x1b[<0;${collapsedHintCol};2M`);
	assert.equal(tool.expanded, true);
	assert.equal(renderer.officialInputs.length, 0, "hint click consumed before official chain");
	assert.deepEqual(ui.widget.render(), []);

	// 展开卡：按下放行官方（选区/链接），位置不变的松手才收起。
	tui.handleViewportInput(`\x1b[<0;20;2M`);
	assert.equal(tool.expanded, true, "press alone does not collapse");
	assert.equal(renderer.officialInputs.length, 1, "expanded card press passes to official chain");
	tui.handleViewportInput(`\x1b[<0;26;2m`);
	assert.equal(tool.expanded, true, "drag release keeps the card expanded");
	// 带键拖动（32）越过容差后清掉按下记账：回到原格松手也不收起。
	tui.handleViewportInput(`\x1b[<0;20;2M`);
	tui.handleViewportInput(`\x1b[<32;30;2M`);
	tui.handleViewportInput(`\x1b[<0;20;2m`);
	assert.equal(tool.expanded, true, "left-button drag clears the pending collapse");
	tui.handleViewportInput(`\x1b[<0;20;2M`);
	tui.handleViewportInput(`\x1b[<0;20;2m`);
	assert.equal(tool.expanded, false, "single click collapses the expanded card");

	// hover：先经过 dock，再到 collapsed 工具行；dock 空缓存不得污染同一布局的工具缓存。
	// DECSET 1003：无按键移动是 35；32 是左键拖动（文本选区）。
	renderer.officialInputs.length = 0;
	tui.handleViewportInput(`\x1b[<35;20;22M`);
	const renderCallsBefore = renderer.renderCalls;
	tui.handleViewportInput(`\x1b[<35;20;2M`);
	assert.equal(renderer.officialInputs.length, 2, "motion reaches official chain");
	assert.ok(renderer.renderCalls > renderCallsBefore, "hover state change triggers render");
	// 同位置再 hover：状态无变化，不重复渲染。
	tui.handleViewportInput(`\x1b[<35;20;2M`);
	assert.equal(renderer.renderCalls, renderCallsBefore + 1, "unchanged hover skips render");
	// hover 移出工具行：清除高亮状态。
	tui.handleViewportInput(`\x1b[<35;20;22M`);
	assert.ok(renderer.renderCalls > renderCallsBefore + 1, "hover leave clears state");
	// 左键拖动不走 hover，避免选区每像素命中+重绘。
	const dragRenders = renderer.renderCalls;
	renderer.officialInputs.length = 0;
	tui.handleViewportInput(`\x1b[<32;20;2M`);
	assert.equal(renderer.renderCalls, dragRenders, "left-button drag does not run hover");
	assert.equal(renderer.officialInputs.length, 1, "drag still reaches official chain");

	// 滚动后 leaf.localRow 已是文档行，不得再次叠加 scrollTop。
	const filler = {
		render: () => Array.from({ length: 50 }, (_, i) => `history ${i}`),
	};
	const scrolledLayout = fullscreenLayout([filler, tool], null);
	const scrollBox = scrolledLayout.root.children[0];
	scrollBox.scrollView!.scrollTop = 50;
	scrollBox.children[0].rect.y = -50;
	renderer.currentLayout = scrolledLayout;
	const scrolledHoverRenders = renderer.renderCalls;
	tui.handleViewportInput(`\x1b[<35;20;2M`);
	assert.ok(
		renderer.renderCalls > scrolledHoverRenders,
		"scrolled tool hover uses document row once",
	);

	// single-expand：展开 A 后再点 B，A 自动收起。
	const toolA = createTool("tool-a");
	const toolB = createTool("tool-b");
	const motionWritesBeforeSwitch = writes.filter((value) => value.includes("?1003h")).length;
	renderer = new FullscreenRenderer([toolA, toolB], ui.widget, terminal);
	ui.widget.render(); // 官方每帧渲染 dock → 新 renderer 重装 wrapper/上报
	assert.equal(
		writes.filter((value) => value.includes("?1003h")).length,
		motionWritesBeforeSwitch + 1,
		"renderer switch re-enables hover motion",
	);
	const tui2 = createLazyProxy(() => renderer);
	renderer.currentLayout = fullscreenLayout([toolA, toolB], null);
	const toolAHintCol = toolA.render()[1].indexOf("(ctrl+o expand / click)") + 1;
	const toolBHintCol = toolB.render()[1].indexOf("(ctrl+o expand / click)") + 1;
	tui2.handleViewportInput(`\x1b[<0;${toolAHintCol};2M`);
	assert.equal(toolA.expanded, true, "first hint click expands A");
	tui2.handleViewportInput(`\x1b[<0;${toolBHintCol};4M`);
	assert.equal(toolA.expanded, false, "expanding B collapses A");
	assert.equal(toolB.expanded, true);

	// 回到底部按钮：滚动离开底部后按钮可见，点击触发 scrollToBottom。
	renderer = new FullscreenRenderer(tool, ui.widget, terminal);

	// 非工具区域（dock 行）：放行官方。
	tui.handleViewportInput(`\x1b[<0;20;22M`);
	assert.equal(renderer.officialInputs.length, 1, "dock click reaches official chain");

	// 滚动条列：放行官方拖动。
	renderer.currentLayout = fullscreenLayout(tool, null, true);
	tui.handleViewportInput(`\x1b[<0;80;2M`);
	assert.equal(renderer.officialInputs.length, 2, "scrollbar column reaches official chain");

	// 含 OSC8 链接行（普通/参数化）：放行官方 URL 点击。
	for (const [toolId, linkLine] of [
		["tool-url", `  \x1b]8;;https://x\x07link\x1b]8;;\x07`],
		["tool-url-param", `  \x1b]8;id=42;https://x\x07link\x1b]8;;\x07`],
	] as const) {
		renderer.currentLayout = fullscreenLayout(
			{ ...createTool(toolId), render: () => ["✓ url", linkLine] },
			null,
		);
		const officialBefore: number = renderer.officialInputs.length;
		tui.handleViewportInput(`\x1b[<0;10;2M`);
		assert.equal(
			renderer.officialInputs.length,
			officialBefore + 1,
			`OSC8 link row reaches official chain (${toolId})`,
		);
	}

	// show-more：expanded 工具卡渲染截断体末行，点击 [show more] 打开预览。
	// 真实 ANSI 主题：拆分样式（点 dim / 文字 text）后 indexOf 仍按可见文本命中。
	const ansiTheme = {
		fg: (color: string, text: string) =>
			`\x1b[${color === "text" ? "97" : color === "dim" ? "90" : "37"}m${text}\x1b[39m`,
	};
	const longOutput = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");
	const ioView = new ExpandedToolIoView(ansiTheme, "arg: 1", longOutput, false, 3, 3);
	ioView.render(80); // 触发截断状态与 show-more 头行记录
	const showMoreTool = createTool("tool-show-more");
	showMoreTool.expanded = true;
	showMoreTool.resultRendererComponent = ioView;
	showMoreTool.render = () => ioView.render(80);
	renderer = new FullscreenRenderer(showMoreTool, ui.widget, terminal);
	ui.widget.render(); // 官方每帧渲染 dock → 新 renderer 重装 wrapper
	renderer.currentLayout = fullscreenLayout(showMoreTool, null);
	const ioLines = ioView.render(80);
	const moreHeader = ioView.showMoreHeaderLineIndexes()[0];
	const moreRow = moreHeader.line;
	const moreCol =
		ioLines[moreRow].replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").indexOf(SHOW_MORE_LABEL) + 1;
	const notifiedBefore = ui.notifications.length;
	const officialBeforeShowMore = renderer.officialInputs.length;
	tui.handleViewportInput(`\x1b[<0;${moreCol};${moreRow + 1}M`);
	assert.ok(
		ui.notifications.length > notifiedBefore,
		"show-more click opens the preview (custom unavailable → notify)",
	);
	assert.equal(moreHeader.section, "output");
	assert.equal(
		renderer.officialInputs.length,
		officialBeforeShowMore,
		"show-more click consumed, official untouched",
	);

	// 回到底部按钮：滚动离开底部后按钮可见，点击触发 scrollToBottom。
	renderer = new FullscreenRenderer(tool, ui.widget, terminal);
	renderer.currentLayout.primaryScrollView.isFollowingEnd = false;
	renderer.currentLayout.primaryScrollView.scrollTop = 50;
	ui.widget.render(80); // renderer 切换后重新安装点击包装
	tui.handleViewportInput(`\x1b[<65;10;2M`); // wheel：同步按钮显隐
	await new Promise<void>((resolve) => process.nextTick(resolve));
	assert.ok(ui.widget.render(80)[0]?.includes("↓"), "wheel away from bottom shows the button");
	tui.handleViewportInput(`\x1b[<0;40;21M`);
	assert.equal(renderer.scrollBottomCalls, 1, "button click scrolls to bottom");
	assert.deepEqual(ui.widget.render(80), []);

	// 按钮 hover：motion 到按钮行高亮（accent → text），离开恢复。
	renderer.currentLayout.primaryScrollView.isFollowingEnd = false;
	renderer.currentLayout.primaryScrollView.scrollTop = 50;
	ui.widget.render(80);
	tui.handleViewportInput(`\x1b[<65;10;2M`); // wheel：按钮重新出现
	await new Promise<void>((resolve) => process.nextTick(resolve));
	renderer.currentLayout = fullscreenLayout(tool, ui.widget, false); // 重建布局（按钮行已可见）
	tui.handleViewportInput(`\x1b[<35;40;21M`); // motion 到按钮行
	assert.ok(
		ui.widget.render(80)[0]?.includes("<text>[ ↓"),
		"button hover switches label to text color",
	);
	tui.handleViewportInput(`\x1b[<35;10;21M`); // motion 移出按钮行
	assert.ok(ui.widget.render(80)[0]?.includes("<accent>[ ↓"), "hover leave restores accent color");

	// 键盘滚动（官方 PageUp）：同样同步按钮显隐（官方消费按键，扩展监听器无法补偿）。
	renderer.currentLayout.primaryScrollView.isFollowingEnd = false;
	renderer.currentLayout.primaryScrollView.scrollTop = 30;
	ui.widget.render(80);
	tui.handleViewportInput("\x1b[5~"); // PageUp
	await new Promise<void>((resolve) => process.nextTick(resolve));
	assert.ok(ui.widget.render(80)[0]?.includes("↓"), "PageUp away from bottom shows the button");
	ui.inputHandler?.("\x1b[8^"); // Ctrl+End 官方不消费，经 onTerminalInput 回到底部
	assert.equal(renderer.scrollBottomCalls, 2, "Ctrl+End scrolls to bottom");
	assert.deepEqual(ui.widget.render(80), []);
	installToolMouseInteraction({});
	config.scrollStepLines = previousStep;
	assert.equal(renderer.wheelScrollLines, 1, "teardown restores native wheel step");
});

test("lazy-proxy tui: official jump-to-latest overlay is disabled", () => {
	const previousMode = config.mode;
	const tool = createTool("tool-overlay");
	const { terminal } = createTerminalFixture();
	const renderer = new FullscreenRenderer(tool, null, terminal);
	const indicator = () => "Jump to latest message";
	(renderer as any).scrollToEndIndicator = indicator;
	const tui = createLazyProxy(() => renderer);
	const ui = createUi(tui);
	try {
		config.mode = "on";
		installToolMouseInteraction(ui.ctx);
		ui.widget.render(80);
		assert.equal((renderer as any).scrollToEndIndicator, undefined, "官方 overlay 已关掉");
	} finally {
		config.mode = previousMode;
		installToolMouseInteraction({});
	}
});

test("lazy-proxy tui: off mode keeps official jump-to-latest overlay", () => {
	const previousMode = config.mode;
	const tool = createTool("tool-overlay-off");
	const { terminal } = createTerminalFixture();
	const renderer = new FullscreenRenderer(tool, null, terminal);
	const indicator = () => "Jump to latest message";
	(renderer as any).scrollToEndIndicator = indicator;
	const tui = createLazyProxy(() => renderer);
	const ui = createUi(tui);
	try {
		config.mode = "off";
		installToolMouseInteraction(ui.ctx);
		ui.widget.render(80);
		assert.equal((renderer as any).scrollToEndIndicator, indicator, "off 模式保留官方 overlay");
		assert.deepEqual(ui.widget.render(80), [], "off 模式不画 dock 回到底部按钮");

		config.mode = "on";
		ui.widget.render(80);
		assert.equal((renderer as any).scrollToEndIndicator, undefined, "切回 on 关掉官方 overlay");

		config.mode = "off";
		ui.widget.render(80);
		assert.equal(
			typeof (renderer as any).scrollToEndIndicator,
			"function",
			"再切 off 还回官方 overlay",
		);
		assert.equal(
			(renderer as any).scrollToEndIndicator(),
			"Jump to latest message",
			"还回的 overlay 文案与官方一致",
		);
	} finally {
		config.mode = previousMode;
		installToolMouseInteraction({});
	}
});

test("lazy-proxy tui: fullscreen compact assistant hint toggles and hovers", async () => {
	const previousMode = config.mode;
	const previousTheme = getMessageDisplayTheme();
	config.mode = "compact";
	setMessageDisplayTheme({ fg: (_color: string, text: string) => text } as any);
	const compact = installCompactMode({ writeMetadata: new WriteExecutionMetadataStore() });
	const message = {
		role: "assistant",
		timestamp: 1,
		content: [
			{ type: "text", text: "checking" },
			{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "echo" } },
		],
	};
	const assistant = new AssistantMessageComponent(message as any, true) as any;
	assistant.updateContent(message);
	const { terminal } = createTerminalFixture();
	const renderer = new FullscreenRenderer(assistant, null, terminal);
	const tui = createLazyProxy(() => renderer);
	const ui = createUi(tui);
	try {
		installToolMouseInteraction(ui.ctx);
		ui.widget.render();
		renderer.currentLayout = fullscreenLayout(assistant, null);
		const renderedAssistant = assistant.render(80);
		const hintRow = renderedAssistant.findIndex((line: string) =>
			line.includes("click to show more"),
		);
		const collapsedLine = renderedAssistant[hintRow] ?? "";
		const hintCol = collapsedLine.indexOf("click to show more") + 1;
		assert.ok(hintRow >= 0 && hintCol > 0);

		const rendersBeforeHover = renderer.renderCalls;
		tui.handleViewportInput(`\x1b[<35;${hintCol};${hintRow + 1}M`);
		assert.ok(renderer.renderCalls > rendersBeforeHover, "assistant hint hover triggers render");

		tui.handleViewportInput(`\x1b[<0;${hintCol};${hintRow + 1}M`);
		assert.equal(assistant.expanded, true);
		renderer.currentLayout = fullscreenLayout(assistant, null);
		tui.handleViewportInput(`\x1b[<0;2;1M`);
		assert.equal(assistant.expanded, true, "press alone does not collapse the assistant card");
		tui.handleViewportInput(`\x1b[<0;2;1m`);
		assert.equal(assistant.expanded, false, "single click collapses the assistant card");
	} finally {
		installToolMouseInteraction({});
		compact.shutdown();
		config.mode = previousMode;
		setMessageDisplayTheme(previousTheme);
	}
});

test("lazy-proxy tui: collapsed diff body text is not an expand entry", () => {
	const plainTheme = {
		fg: (_color: string, text: string) => text,
		bg: (_color: string, text: string) => text,
		bold: (text: string) => text,
	};
	const diff = ["@@ -1,6 +1,6 @@"];
	// 正文里出现与 remainder 同款的文案，不能变成展开入口。
	diff.push("+   ↳ 2 lines returned • click to show more");
	for (let index = 2; index <= 6; index++) diff.push(`+code line ${index}`);
	const inner: any = renderRichToolResult(
		"edit",
		{ details: { diff: diff.join("\n") }, content: [] },
		{ expanded: false },
		plainTheme,
		{ args: { path: "docs/example.md" } },
		new WriteExecutionMetadataStore(),
		// 保持折叠卡在 fullscreen 夹具的 20 行 clip 内。
		{ ...DEFAULT_TOOL_DISPLAY_CONFIG, editDiffCollapsedLines: 2 },
	);
	const result = insetComponent(inner);
	const card: any = {
		toolCallId: "edit-diff",
		expanded: false,
		setExpanded(value: boolean) {
			this.expanded = value;
		},
		invalidate() {},
		resultRendererComponent: result,
		render() {
			return ["✓ Edit docs/example.md", ...result.render(80)];
		},
	};
	const { terminal } = createTerminalFixture();
	const renderer = new FullscreenRenderer(card, null, terminal);
	const tui = createLazyProxy(() => renderer);
	const ui = createUi(tui);
	try {
		installToolMouseInteraction(ui.ctx);
		ui.widget.render();
		renderer.currentLayout = fullscreenLayout(card, null);
		const strip = (line: string) => line.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
		const rows = card.render(80).map(strip);
		const bodyRow = rows.findIndex((line: string) => line.includes("2 lines returned"));
		const hintRow = rows.findIndex((line: string) => line.includes("more diff lines"));
		assert.ok(bodyRow > 0 && hintRow > 0, "collapsed card renders body text and remainder");

		const bodyCol = rows[bodyRow]!.indexOf("click to show more") + 1;
		tui.handleViewportInput(`\x1b[<0;${bodyCol};${bodyRow + 1}M`);
		assert.equal(card.expanded, false, "body text does not expand the card");

		const hintCol = rows[hintRow]!.indexOf("click to show more") + 1;
		tui.handleViewportInput(`\x1b[<0;${hintCol};${hintRow + 1}M`);
		assert.equal(card.expanded, true, "remainder row still expands the card");
	} finally {
		installToolMouseInteraction({});
	}
});

test("lazy-proxy tui: fullscreen compact expanded round thinking hint expands in place", async () => {
	const previousMode = config.mode;
	config.mode = "compact";
	const dirHandlers = new Map<string, Function[]>();
	const pi = {
		on(name: string, handler: Function) {
			const list = dirHandlers.get(name) ?? [];
			list.push(handler);
			dirHandlers.set(name, list);
		},
		appendEntry() {},
	} as any;
	const emit = (name: string, event: any = {}, ctx: any = {}) => {
		for (const handler of dirHandlers.get(name) ?? []) handler(event, ctx);
	};
	const thinkingCtx = {
		mode: "tui",
		sessionManager: { getBranch: () => [], getEntries: () => [] },
		ui: { theme: {}, setWidget() {}, requestRender() {} },
	};
	installCompactThinking(pi, {
		useSummaryTitlesAsThinkingTitle: false,
		previewLines: 0,
		animationIntervalMs: 30,
	});
	emit("session_start", {}, thinkingCtx);
	const compact = installCompactMode({ writeMetadata: new WriteExecutionMetadataStore() });
	const message = {
		role: "assistant",
		timestamp: 1,
		content: [
			{ type: "thinking", thinking: "plan the click path" },
			{ type: "toolCall", id: "b1", name: "bash", arguments: { command: "echo" } },
		],
	};
	const assistant = new AssistantMessageComponent(message as any, true) as any;
	assistant.updateContent(message);
	const { terminal } = createTerminalFixture();
	const renderer = new FullscreenRenderer(assistant, null, terminal);
	const tui = createLazyProxy(() => renderer);
	const ui = createUi(tui);
	try {
		installToolMouseInteraction(ui.ctx);
		ui.widget.render();
		assistant.setExpanded(true);
		renderer.currentLayout = fullscreenLayout(assistant, null);
		const rendered = assistant.render(80);
		const hintRow = rendered.findIndex((line: string) => line.includes("to show more"));
		const plain = (rendered[hintRow] ?? "").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
		const hintCol = plain.indexOf("to show more") + 1;
		assert.ok(hintRow >= 0 && hintCol > 0, `expected thinking hint, got: ${plain}`);

		const findThinking = (node: any): ThinkingPreviewBlock | undefined => {
			if (node instanceof ThinkingPreviewBlock) return node;
			for (const child of node?.children ?? []) {
				const hit = findThinking(child);
				if (hit) return hit;
			}
		};
		const block = findThinking(assistant);
		assert.ok(block, "expanded round keeps the thinking block in the tree");

		tui.handleViewportInput(`\x1b[<0;${hintCol};${hintRow + 1}M`);
		assert.equal(block!.expanded, true, "thinking hint click expands the preview");
		assert.equal(assistant.expanded, true, "round stays open");
		renderer.currentLayout = fullscreenLayout(assistant, null);
		const expandedRow = assistant
			.render(80)
			.findIndex((line: string) => line.includes("plan the click path"));
		assert.ok(expandedRow >= 0, "expanded thinking body is visible");
		tui.handleViewportInput(`\x1b[<0;4;${expandedRow + 1}M`);
		assert.equal(block!.expanded, true, "press alone keeps nested thinking expanded");
		tui.handleViewportInput(`\x1b[<0;4;${expandedRow + 1}m`);
		assert.equal(block!.expanded, false, "single click collapses nested thinking");
		assert.equal(assistant.expanded, true, "round stays open after thinking collapse");
	} finally {
		installToolMouseInteraction({});
		compact.shutdown();
		emit("session_shutdown", {}, thinkingCtx);
		config.mode = previousMode;
	}
});

test("lazy-proxy tui: fullscreen hover uses scroll ancestor content width after reload", async () => {
	const wrap = (label: string) => ({
		render: (width: number) => (width === 80 ? [label] : [label, `${label}-2`]),
		invalidate() {},
	});
	const toolA = createTool("width-tool-a");
	const toolB = createTool("width-tool-b");
	const { terminal } = createTerminalFixture();
	const renderer = new FullscreenRenderer(toolB, null, terminal);
	const doc: any = { children: [wrap("message-1"), toolA, wrap("message-2"), toolB] };
	const docLines = doc.children.flatMap((child: any) => child.render(79));
	const toolBox: FakeBox = {
		component: doc,
		rect: { x: 0, y: 0, width: 79, height: docLines.length },
		clip: { x: 0, y: 0, width: 79, height: 20 },
		children: [],
		lines: docLines,
	};
	const scrollBox: FakeBox = {
		component: null,
		rect: { x: 0, y: 0, width: 80, height: 20 },
		clip: { x: 0, y: 0, width: 80, height: 20 },
		children: [toolBox],
		scrollView: {
			isScrollbarVisible: true,
			scrollTop: 0,
			isFollowingEnd: true,
			getContentWidth: (width: number) => Math.max(1, width - 1),
		},
		scrollContentLines: docLines,
	};
	const root: FakeBox = {
		component: null,
		rect: { x: 0, y: 0, width: 80, height: 24 },
		clip: { x: 0, y: 0, width: 80, height: 24 },
		children: [scrollBox],
	};
	toolBox.parent = scrollBox;
	scrollBox.parent = root;
	renderer.currentLayout = { root, primaryScrollView: scrollBox.scrollView };
	const tui = createLazyProxy(() => renderer);
	const ui = createUi(tui);
	installToolMouseInteraction(ui.ctx);

	const hintCol = docLines[7].indexOf("/ click") + 1;
	const rendersBefore = renderer.renderCalls;
	tui.handleViewportInput(`\x1b[<35;${hintCol};8M`);
	assert.equal(sharedToolHoverState().toolCallId, "width-tool-b");
	assert.equal(renderer.renderCalls, rendersBefore + 1);
	// isToolCallHovered 已移入 hover.ts（interaction.ts 不再 re-export）；
	// reload 语义不变：reset 走 interaction.ts 原生导出，状态读 globalThis 槽。
	assert.equal(isToolCallHovered("width-tool-b"), true);
	const reloadSpecifier = `../extensions/renderer/mouse/interaction.ts?reload=${Date.now()}`;
	const reloadedMouse: typeof import("../extensions/renderer/mouse/interaction.ts") = await import(
		reloadSpecifier
	);
	reloadedMouse.resetToolHoverState();
	assert.equal(isToolCallHovered("width-tool-b"), false, "hover state is shared across reloads");
	installToolMouseInteraction({});
});

test("lazy-proxy tui: fullscreen multitool group hover and click toggle", async () => {
	const patch = { groups: new Set(), theme: { fg: (_color: string, text: string) => text } };
	const group = new ToolGroupComponent(patch as any);
	const first = Object.assign(createTool("group-1"), {
		toolName: "read",
		result: { isError: false },
	});
	const second = Object.assign(createTool("group-2"), {
		toolName: "bash",
		result: { isError: false },
	});
	group.addTool(first);
	group.addTool(second);
	const { terminal } = createTerminalFixture();
	const renderer = new FullscreenRenderer(group, null, terminal);
	const tui = createLazyProxy(() => renderer);
	const ui = createUi(tui);
	installToolMouseInteraction(ui.ctx);

	const hintCol = group.render(80)[1].indexOf("click to show more") + 1;
	tui.handleViewportInput(`\x1b[<35;${hintCol};2M`);
	assert.equal((group as any).hintHovered, true, "group hint hover is enabled");
	tui.handleViewportInput(`\x1b[<35;1;2M`);
	assert.equal((group as any).hintHovered, false, "moving outside hint clears hover");
	tui.handleViewportInput(`\x1b[<0;${hintCol};2M`);
	assert.equal((group as any).expanded, true, "group click expands all children");
	assert.match(group.render(80)[1], /↑ Collapse/, "fullscreen group shows the collapse hint");
	const collapseCol = group.render(80)[1].indexOf("↑ Collapse") + 1;
	tui.handleViewportInput(`\x1b[<35;${collapseCol};2M`);
	assert.equal((group as any).hintHovered, true, "expanded collapse hint hovers in fullscreen");
	tui.handleViewportInput(`\x1b[<35;1;2M`);
	assert.equal((group as any).hintHovered, false, "moving outside clears the collapse hint hover");
	tui.handleViewportInput(`\x1b[<0;${hintCol};2M`);
	assert.equal((group as any).expanded, true, "press alone does not collapse the group");
	tui.handleViewportInput(`\x1b[<0;${hintCol};2m`);
	assert.equal((group as any).expanded, false, "single click collapses all children");
	installToolMouseInteraction({});
});

test("lazy-proxy tui: official tool cards collapse from the official click", () => {
	// 伪造 pi 0.87 的结果区 MouseRegion：左键 click 整卡 setExpanded。
	const prototype = (ToolExecutionComponent as any).prototype;
	const originalHandleMouse = prototype.handleMouse;
	const delegated: Array<Record<string, unknown>> = [];
	prototype.handleMouse = function (event: any) {
		delegated.push({ type: event?.type, button: event?.button, y: event?.y });
		return { handled: true };
	};
	const toolUi = {
		theme: { fg: (_color: string, text: string) => text },
		requestRender() {},
	} as any;
	const tool = new ToolExecutionComponent(
		"bash",
		"official-1",
		{},
		{},
		undefined,
		toolUi,
		process.cwd(),
	) as any;
	tool.updateResult({ content: [{ type: "text", text: "one\ntwo" }], isError: false });
	tool.setExpanded(true);
	const { terminal } = createTerminalFixture();
	const renderer = new FullscreenRenderer(tool, null, terminal);
	const tui = createLazyProxy(() => renderer);
	const ui = createUi(tui);
	installToolMouseInteraction(ui.ctx);
	try {
		renderer.currentLayout = fullscreenLayout(tool, null);
		// 按下/松手交给官方（选区、click 合成），扩展不直接收起官方卡。
		tui.handleViewportInput("\x1b[<0;2;1M");
		tui.handleViewportInput("\x1b[<0;2;1m");
		assert.equal(
			tool.expanded,
			true,
			"press and release leave official cards to the official click",
		);
		// 官方 MouseRegion 合成的 click 经 guard 接管为收起，不再调用官方 toggle。
		prototype.handleMouse.call(tool, { type: "click", button: "left", y: 0, width: 80 });
		assert.equal(tool.expanded, false, "guard collapses the official card on click");
		assert.deepEqual(delegated, [], "official toggle is suppressed");
	} finally {
		installToolMouseInteraction({});
		prototype.handleMouse = originalHandleMouse;
	}
});

test("lazy-proxy tui: single click collapses thinking after preview rebuild", async () => {
	const dirHandlers = new Map<string, Function[]>();
	const pi = {
		on(name: string, handler: Function) {
			const list = dirHandlers.get(name) ?? [];
			list.push(handler);
			dirHandlers.set(name, list);
		},
		appendEntry() {},
	} as any;
	const emit = (name: string, event: any = {}, ctx: any = {}) => {
		for (const handler of dirHandlers.get(name) ?? []) handler(event, ctx);
	};
	const thinkingCtx = {
		mode: "tui",
		sessionManager: { getBranch: () => [], getEntries: () => [] },
		ui: { theme: {}, setWidget() {}, requestRender() {} },
	};
	installCompactThinking(pi, {
		useSummaryTitlesAsThinkingTitle: false,
		previewLines: 3,
		animationIntervalMs: 30,
	});
	emit("session_start", {}, thinkingCtx);
	const timestamp = 42;
	const body = Array.from({ length: 20 }, (_, i) => `line-${i}`).join("\n");
	const theme = {
		fg: (_color: string, text: string) => text,
		bg: (_slot: string, text: string) => text,
	} as any;
	const makeBlock = () =>
		new ThinkingPreviewBlock("Thought for 1s", body, 1, timestamp, (text) => text, theme);
	const first = makeBlock();
	const { terminal } = createTerminalFixture();
	const renderer = new FullscreenRenderer(first, null, terminal);
	const tui = createLazyProxy(() => renderer);
	const ui = createUi(tui);
	try {
		installToolMouseInteraction(ui.ctx);
		const hintCol = (first.render(80)[0] ?? "").indexOf("click to show more") + 1;
		assert.ok(hintCol > 0, "expected click hint");
		tui.handleViewportInput(`\x1b[<0;${hintCol};1M`);
		assert.equal(first.expanded, true);
		renderer.currentLayout = fullscreenLayout(first, null);
		const rebuilt = makeBlock();
		assert.equal(rebuilt.expanded, true, "rebuild keeps expanded via timestamp");
		renderer.currentLayout = fullscreenLayout(rebuilt, null);
		tui.handleViewportInput("\x1b[<0;2;1M");
		assert.equal(rebuilt.expanded, true, "press alone does not collapse the rebuilt preview");
		tui.handleViewportInput("\x1b[<0;2;1m");
		assert.equal(rebuilt.expanded, false, "single click collapses the rebuilt preview");
	} finally {
		installToolMouseInteraction({});
		emit("session_shutdown", {}, thinkingCtx);
	}
});

test("lazy-proxy tui: thinking collapse targets the run under the pointer", async () => {
	const dirHandlers = new Map<string, Function[]>();
	const pi = {
		on(name: string, handler: Function) {
			const list = dirHandlers.get(name) ?? [];
			list.push(handler);
			dirHandlers.set(name, list);
		},
		appendEntry() {},
	} as any;
	const emit = (name: string, event: any = {}, ctx: any = {}) => {
		for (const handler of dirHandlers.get(name) ?? []) handler(event, ctx);
	};
	const thinkingCtx = {
		mode: "tui",
		sessionManager: { getBranch: () => [], getEntries: () => [] },
		ui: { theme: {}, setWidget() {}, requestRender() {} },
	};
	installCompactThinking(pi, {
		useSummaryTitlesAsThinkingTitle: false,
		previewLines: 3,
		animationIntervalMs: 30,
	});
	emit("session_start", {}, thinkingCtx);
	const timestamp = 99;
	const body = Array.from({ length: 20 }, (_, i) => `line-${i}`).join("\n");
	const theme = {
		fg: (_color: string, text: string) => text,
		bg: (_slot: string, text: string) => text,
	} as any;
	const runA = new ThinkingPreviewBlock(
		"Thought for 1s",
		body,
		1,
		timestamp,
		(text) => text,
		theme,
		0,
	);
	const runB = new ThinkingPreviewBlock(
		"Thought for 2s",
		body,
		1,
		timestamp,
		(text) => text,
		theme,
		4,
	);
	runA.setExpanded(true);
	runB.setExpanded(true);
	const { terminal } = createTerminalFixture();
	const renderer = new FullscreenRenderer(runA, null, terminal);
	const tui = createLazyProxy(() => renderer);
	const ui = createUi(tui);
	try {
		installToolMouseInteraction(ui.ctx);
		renderer.currentLayout = fullscreenLayout(runA, null);
		tui.handleViewportInput("\x1b[<0;2;1M");
		assert.equal(runA.expanded, true, "press on run A does not collapse");
		tui.handleViewportInput("\x1b[<0;2;1m");
		assert.equal(runA.expanded, false, "release on run A collapses run A");
		assert.equal(runB.expanded, true, "run B instance stays expanded");
	} finally {
		installToolMouseInteraction({});
		emit("session_shutdown", {}, thinkingCtx);
	}
});

test("lazy-proxy tui: fullscreen skill hint click expands like other cards", async () => {
	const previousMode = config.mode;
	config.mode = "on";
	const dispose = installMessageDisplayRendering();
	setMessageDisplayTheme({ fg: (_color: string, text: string) => text } as any);
	const skill = new SkillInvocationMessageComponent(
		{
			name: "ponytail",
			content: "**lazy** content",
			userMessage: null,
		} as unknown as ParsedSkillBlock,
		getMarkdownTheme(),
	);
	const { terminal } = createTerminalFixture();
	const renderer = new FullscreenRenderer(skill, null, terminal);
	const tui = createLazyProxy(() => renderer);
	const ui = createUi(tui);
	try {
		installToolMouseInteraction(ui.ctx);
		const heading = skill.render(80)[0] ?? "";
		const plain = heading.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
		const hintCol = plain.indexOf("to show more") + 1;
		assert.ok(hintCol > 0, `expected show-more hint, got: ${plain}`);
		tui.handleViewportInput(`\x1b[<35;${hintCol};1M`);
		assert.equal((skill as any).hintHovered, true, "skill hint hover is enabled");
		tui.handleViewportInput(`\x1b[<35;1;1M`);
		assert.equal((skill as any).hintHovered, false, "moving outside hint clears hover");
		tui.handleViewportInput(`\x1b[<0;${hintCol};1M`);
		assert.equal((skill as any).expanded, true, "skill hint click expands");
		renderer.currentLayout = fullscreenLayout(skill, null);
		tui.handleViewportInput(`\x1b[<0;2;1M`);
		assert.equal((skill as any).expanded, true, "press alone does not collapse the skill card");
		tui.handleViewportInput(`\x1b[<0;2;1m`);
		assert.equal((skill as any).expanded, false, "single click collapses skill");
	} finally {
		installToolMouseInteraction({});
		dispose();
		config.mode = previousMode;
	}
});

test("lazy-proxy tui: fullscreen expanded group child show-more hover highlights the header", async () => {
	const patch = {
		groups: new Set(),
		theme: { fg: (_color: string, text: string) => text },
	};
	const group = new ToolGroupComponent(patch as any);
	const longOutput = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");
	// 真实 ANSI 主题：拆分后的 show-more 样式（点 dim / 文字 text）可被命中逻辑识别。
	const ansiTheme = {
		fg: (color: string, text: string) =>
			`\x1b[${color === "text" ? "97" : color === "dim" ? "90" : "37"}m${text}\x1b[39m`,
	};
	const ioView = new ExpandedToolIoView(ansiTheme, "", longOutput, false, 2, 2);
	const child = Object.assign(createTool("group-child"), {
		toolName: "read",
		result: { isError: false },
		resultRendererComponent: ioView,
		render: (width: number) => ioView.render(width),
	});
	group.addTool(child);
	group.addTool(
		Object.assign(createTool("group-sibling"), {
			toolName: "bash",
			result: { isError: false },
		}),
	);
	group.setExpanded(true);

	const { terminal } = createTerminalFixture();
	const renderer = new FullscreenRenderer(group, null, terminal);
	const tui = createLazyProxy(() => renderer);
	const ui = createUi(tui);
	installToolMouseInteraction(ui.ctx);
	try {
		const stripAnsi = (line: string) => line.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
		const lines = group.render(80);
		const row = lines.findIndex(
			(line, index) => index > 1 && stripAnsi(line).includes(SHOW_MORE_LABEL),
		);
		assert.ok(row > 1, "grouped child renders an Output show-more footer");
		const col = stripAnsi(lines[row]).indexOf(SHOW_MORE_LABEL) + 1;
		const before = lines[row];

		tui.handleViewportInput(`\x1b[<35;${col};${row + 1}M`);

		const after = group.render(80)[row];
		assert.notEqual(after, before);
		assert.match(after, /\x1b\[90m •\x1b\[39m\x1b\[97m click to show more\x1b\[39m/);

		tui.handleViewportInput(`\x1b[<0;${col};${row + 1}M`);
		assert.equal(ui.notifications.length, 1, "child show-more click opens preview");
		assert.equal(group.expanded, true, "show-more click keeps the group expanded");
		const bodyRow = group.render(80).findIndex((line) => line.includes("line 0"));
		assert.ok(bodyRow >= 0 && bodyRow < row, "body sits above the show-more footer");
		tui.handleViewportInput(`\x1b[<0;10;${bodyRow + 1}M`);
		assert.equal(group.expanded, true, "press on expanded group body does not collapse");
		tui.handleViewportInput(`\x1b[<0;10;${bodyRow + 1}m`);
		assert.equal(group.expanded, false, "single click collapses the whole group");
	} finally {
		installToolMouseInteraction({});
	}
});

test("lazy-proxy tui: fullscreen hover ignores non-IO result renderer components", () => {
	const tool = createTool("tool-foreign-renderer");
	tool.expanded = true;
	tool.resultRendererComponent = { render: () => ["third-party result"] };
	const { terminal } = createTerminalFixture();
	const renderer = new FullscreenRenderer(tool, null, terminal);
	const tui = createLazyProxy(() => renderer);
	const ui = createUi(tui);
	installToolMouseInteraction(ui.ctx);

	assert.doesNotThrow(() => tui.handleViewportInput(`\x1b[<35;20;2M`));
	assert.equal(renderer.officialInputs.length, 1, "motion still reaches official chain");
	installToolMouseInteraction({});
});

test("lazy-proxy tui: fullscreen text preview receives mouse before official selection", async () => {
	const tool = createTool("tool-overlay");
	const terminal = { columns: 80, rows: 24, write() {} };
	const renderer = new FullscreenRenderer(tool, null, terminal);
	renderer.hasOverlay = () => true;
	const tui = createLazyProxy(() => renderer);
	const ui = createUi(tui);
	installToolMouseInteraction(ui.ctx);

	let component: any;
	const preview = showTextPreview(
		{
			ui: {
				custom: async (factory: any) =>
					await new Promise<void>((resolve) => {
						component = factory(tui, theme(), null, resolve);
					}),
			},
		} as any,
		"Output",
		"hello",
	);
	const result = tui.handleViewportInput(`\x1b[<0;67;4M`);
	assert.equal(result, undefined, "preview mouse continues to the focused custom component");
	assert.equal(
		renderer.officialInputs.length,
		0,
		"official selection does not consume preview mouse",
	);
	component.handleInput("\x1b");
	await preview;
	installToolMouseInteraction({});
});

test("lazy-proxy tui: renderer replacement preserves fullscreen mouse ownership", () => {
	const tool = createTool("tool-switch");
	const { terminal, writes } = createTerminalFixture();
	// 交替持有官方全屏 renderer 与 regular/fullscreen 桩，验证切换不泄漏 mouse 状态。
	let renderer: FullscreenRenderer | RendererStub = new FullscreenRenderer(tool, null, terminal);
	const tui = createLazyProxy(() => renderer);
	const ui = createUi(tui);
	installToolMouseInteraction(ui.ctx);

	assert.ok(!writes.some((value) => value.includes("?1000h")), "initial fullscreen is untouched");
	const hintCol = tool.render()[1].indexOf("/ click") + 1;
	assert.equal(ui.inputHandler?.(`\x1b[<0;${hintCol};2M`), undefined);
	assert.equal(tool.expanded, false);
	assert.deepEqual(ui.widget.render(), []);

	// fullscreen → regular：渲染层/上报均让位，插件不写任何 mouse reporting。
	renderer = createRenderer("regular", [tool], terminal);
	ui.widget.render();
	assert.ok(!writes.some((value) => value.includes("?1000h")), "regular never enables reporting");

	// regular → fullscreen：官方先启用点击模式，插件只补 hover 所需的 1003。
	renderer = createRenderer("fullscreen", [tool], terminal);
	writes.push("OFFICIAL:\x1b[?1000h\x1b[?1002h\x1b[?1006h");
	const writesBeforeFullscreenRender = writes.length;
	ui.widget.render();
	assert.equal(writes.length, writesBeforeFullscreenRender + 1);
	assert.match(writes.at(-1) ?? "", /\?1003h/);

	// fullscreen stop 后切回 regular：官方关闭其模式；插件仍不写上报，保持终端原生回滚。
	writes.push("OFFICIAL:\x1b[?1006l\x1b[?1002l\x1b[?1000l");
	renderer = createRenderer("regular", [tool], terminal);
	ui.widget.render();
	assert.ok(
		!writes.some((value) => value.includes("?1000h") && !value.startsWith("OFFICIAL")),
		"back to regular stays reporting-free",
	);

	// 当前 fullscreen teardown 不能误关官方 mouse mode。
	renderer = createRenderer("fullscreen", [tool], terminal);
	ui.widget.render();
	const writesBeforeTeardown = writes.length;
	installToolMouseInteraction({});
	const teardownWrites = writes.slice(writesBeforeTeardown);
	assert.ok(
		!teardownWrites.some((value) => value.includes("?1000l") || value.includes("?1006l")),
		"teardown keeps official click reporting",
	);
});

test("lazy-proxy frame capture rolls back partial render wrappers on failure", () => {
	const first = createTool("tool-first");
	const originalRender = first.render;
	let reads = 0;
	const hostile = {
		toolCallId: "tool-hostile",
		expanded: false,
		setExpanded() {},
		invalidate() {},
		get render() {
			reads++;
			if (reads > 1) throw new Error("render getter failed");
			return () => ["✓ hostile", "  └ 1 line output (ctrl+o expand / click)"];
		},
	};
	const { terminal } = createTerminalFixture();
	let renderer = createRenderer("regular", [first, hostile], terminal);
	const tui = createLazyProxy(() => renderer);
	const ui = createUi(tui);
	installToolMouseInteraction(ui.ctx);

	assert.equal(ui.inputHandler?.("\x1b[<0;20;2M"), undefined);
	assert.equal(first.render, originalRender, "earlier component render is restored after failure");
	assert.ok(first.render().every((line) => !line.includes("\x1b_cc:")));
	installToolMouseInteraction({});
});
