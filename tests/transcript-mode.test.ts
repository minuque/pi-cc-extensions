import assert from "node:assert/strict";
import test from "node:test";

import {
	AssistantMessageComponent,
	BashExecutionComponent,
	createBashToolDefinition,
	initTheme,
	ToolExecutionComponent,
	UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import {
	Container,
	getKeybindings,
	KeybindingsManager,
	setKeybindings,
	TUI_KEYBINDINGS,
} from "@earendil-works/pi-tui";
import { config } from "../extensions/config/config.ts";
import { installCompactMode } from "../extensions/renderer/compact-mode.ts";
import { installDefaultMode } from "../extensions/renderer/default-mode.ts";
import { setToolMouseTui } from "../extensions/renderer/mouse/scroll.ts";
import { WriteExecutionMetadataStore } from "../extensions/renderer/tool/diff/write-execution.ts";
import {
	collectTranscriptItems,
	findChatContainer,
	installTranscriptMode,
	isTranscriptModeActive,
	teardownTranscriptMode,
	followScreenSelection,
	TranscriptView,
} from "../extensions/renderer/transcript-mode.ts";
import { expandedLineLimit, withTranscriptScope } from "../extensions/renderer/transcript-scope.ts";

initTheme("dark");

const CTRL_O = "\x0f";
const stripAnsi = (text: string) =>
	text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/\x1b\][^\x07]*\x07/g, "");

const toolUi = { theme: { fg: (_c: string, t: string) => t }, requestRender() {} } as any;

function withExpandKey<T>(run: () => T): T {
	const previous = getKeybindings();
	setKeybindings(
		new KeybindingsManager({
			...TUI_KEYBINDINGS,
			"app.tools.expand": { defaultKeys: "ctrl+o", description: "Toggle tool output" },
		} as any),
	);
	try {
		return run();
	} finally {
		setKeybindings(previous);
	}
}

function bashTool(id: string, output: string): any {
	const cwd = process.cwd();
	const tool = new ToolExecutionComponent(
		"bash",
		id,
		{ command: "seq 100" },
		{},
		createBashToolDefinition(cwd),
		toolUi,
		cwd,
	) as any;
	tool.markExecutionStarted();
	tool.updateResult({ content: [{ type: "text", text: output }], isError: false });
	return tool;
}

function assistant(id: string): any {
	const message = {
		role: "assistant",
		timestamp: Date.now(),
		content: [{ type: "toolCall", id, name: "bash", arguments: { command: "seq 100" } }],
	};
	return new AssistantMessageComponent(message as any, false);
}

function user(text: string): any {
	return new UserMessageComponent(text);
}

const hundredLines = Array.from({ length: 100 }, (_, index) => `line-${index + 1}`).join("\n");

// ---------------------------------------------------------------------------
// 浏览层视图
// ---------------------------------------------------------------------------

function lineItems(count: number, prompts: number[] = []) {
	return Array.from({ length: count }, (_, index) => ({
		view: { render: () => [`row-${index}`] },
		prompt: prompts.includes(index),
	}));
}

function makeView(count: number, prompts: number[] = [], rows = 12) {
	let closed = 0;
	let focused = true;
	const view = new TranscriptView({
		rows: () => rows,
		items: () => lineItems(count, prompts),
		theme: undefined,
		close: () => closed++,
		focused: () => focused,
	});
	return {
		view,
		closed: () => closed,
		loseFocus: () => {
			focused = false;
		},
		body: () => view.render(80).slice(0, rows - 2),
	};
}

test("浏览层铺满屏幕：正文停在底部，最后一行是提示", () => {
	const t = makeView(30);
	const lines = t.view.render(100);
	assert.equal(lines.length, 12);
	assert.equal(lines[9], "row-29");
	assert.equal(lines[10], "");
	assert.match(
		stripAnsi(lines[11]!),
		/Showing detailed transcript \(100%\) · esc\/q to exit · ctrl\+o to toggle · j\/k scroll$/,
	);
});

test("浏览层按键：逐行、半页、整页、首尾、跳消息", () => {
	withExpandKey(() => {
		const t = makeView(100, [10, 50]);
		t.view.render(80);
		const top = () => t.body()[0];
		t.view.handleInput("g");
		assert.equal(top(), "row-0");
		t.view.handleInput("j");
		assert.equal(top(), "row-1");
		t.view.handleInput("k");
		assert.equal(top(), "row-0");
		t.view.handleInput("\x04");
		assert.equal(top(), "row-5");
		t.view.handleInput("\x15");
		assert.equal(top(), "row-0");
		t.view.handleInput(" ");
		assert.equal(top(), "row-6");
		t.view.handleInput("}");
		assert.equal(top(), "row-10");
		t.view.handleInput("}");
		assert.equal(top(), "row-50");
		t.view.handleInput("{");
		assert.equal(top(), "row-10");
		t.view.handleInput("G");
		assert.equal(top(), "row-90");
		// 普通字符不做任何事。
		t.view.handleInput("x");
		assert.equal(top(), "row-90");
		assert.equal(t.closed(), 0);
	});
});

test("浏览层退出键：Esc、q、ctrl+c、展开键", () => {
	withExpandKey(() => {
		for (const key of ["\x1b", "q", "\x03", CTRL_O]) {
			const t = makeView(5);
			t.view.handleInput(key);
			assert.equal(t.closed(), 1, JSON.stringify(key));
		}
	});
});

test("浏览层只接管滚轮，其余鼠标事件交给 Pi 做选中复制", () => {
	const t = makeView(50);
	t.view.render(80);
	for (const type of ["press", "drag", "release", "click", "move"]) {
		assert.equal(t.view.handleMouse({ type, button: "left" }), undefined, type);
	}
	assert.deepEqual(t.view.handleMouse({ type: "wheel", wheelDelta: 1 }), { handled: true });
});

test("浏览层滚轮滚动；离开底部后新内容不拉回", () => {
	const t = makeView(50);
	t.view.render(80);
	t.view.handleMouse({ type: "wheel", wheelDelta: -1 });
	assert.equal(t.body()[0], "row-37");
	t.view.handleMouse({ type: "wheel", wheelDelta: 1 });
	assert.equal(t.body()[0], "row-40");
});

test("焦点被对话框抢走：浏览层自动关闭", async () => {
	const t = makeView(5);
	t.view.render(80);
	t.loseFocus();
	t.view.render(80);
	await Promise.resolve();
	assert.equal(t.closed(), 1);
});

// ---------------------------------------------------------------------------
// 副本
// ---------------------------------------------------------------------------

test("浏览层作用域内展开内容不限行数", () => {
	assert.equal(expandedLineLimit(20), 20);
	assert.equal(
		withTranscriptScope(() => expandedLineLimit(20)),
		Number.MAX_SAFE_INTEGER,
	);
	assert.equal(
		expandedLineLimit(20, { state: { ccstyleTranscript: true } }),
		Number.MAX_SAFE_INTEGER,
	);
});

test("on 模式：工具副本全展开且不限行数，对话区工具不变", () => {
	const previousMode = config.mode;
	const previousLimit = config.expandedOutputMaxLines;
	config.mode = "on";
	config.expandedOutputMaxLines = 5;
	const hooks = installDefaultMode(new WriteExecutionMetadataStore());
	try {
		const live = bashTool("t-on", hundredLines);
		const chat = new Container();
		chat.children.push(user("run it"), assistant("t-on"), live);
		const items = collectTranscriptItems(chat);
		assert.equal(items.length, 3);
		assert.equal(items[0]!.prompt, true);
		assert.equal(items[0]!.view, chat.children[0], "用户消息直接用原组件");
		const clone = items[2]!.view;
		assert.notEqual(clone, live);
		assert.equal(live.expanded, false, "对话区工具保持折叠");
		const text = withTranscriptScope(() => clone.render(120))
			.map(stripAnsi)
			.join("\n");
		assert.match(text, /line-1\b/);
		assert.match(text, /line-100\b/);
		// 内容没变时复用同一个副本。
		assert.equal(collectTranscriptItems(chat)[2]!.view, clone);
	} finally {
		hooks.shutdown();
		config.mode = previousMode;
		config.expandedOutputMaxLines = previousLimit;
	}
});

test("compact 模式：工具副本不被整轮折叠，对话区仍是摘要", () => {
	const previousMode = config.mode;
	config.mode = "compact";
	const hooks = installCompactMode({ writeMetadata: new WriteExecutionMetadataStore() });
	try {
		const live = bashTool("t-compact", "done-output");
		const chat = new Container();
		chat.children.push(user("run it"), assistant("t-compact"), live);
		assert.deepEqual(live.render(120), [], "compact 下对话区工具不单独成行");
		const items = collectTranscriptItems(chat);
		const clone = items.find((item) => item.view instanceof ToolExecutionComponent)!.view;
		const text = withTranscriptScope(() => clone.render(120))
			.map(stripAnsi)
			.join("\n");
		assert.match(text, /done-output/);
		assert.deepEqual(live.render(120), [], "对话区不受影响");
	} finally {
		hooks.shutdown();
		config.mode = previousMode;
	}
});

test("找对话区：直接装着消息的容器", () => {
	const chat = new Container();
	chat.children.push(user("hi"));
	const root = new Container();
	const other = new Container();
	root.children.push(other, chat);
	assert.equal(findChatContainer(root), chat);
	assert.equal(findChatContainer(other), undefined);
});

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

function fakeTui(editorFocused = true) {
	const editor = { actionHandlers: new Map([["app.tools.expand", () => {}]]) };
	return {
		mode: "fullscreen",
		overlay: false,
		focusedComponent: editorFocused ? (editor as any) : ({} as any),
		terminal: { rows: 20 },
		get requestRender() {
			return () => undefined;
		},
		hasOverlay() {
			return this.overlay;
		},
	};
}

function setupEntry(mode: "on" | "compact" | "off", tui = fakeTui()) {
	const previousMode = config.mode;
	config.mode = mode;
	setToolMouseTui(tui);
	let handler: ((data: string) => any) | undefined;
	const opened: any[] = [];
	const ctx = {
		mode: "tui",
		hasUI: true,
		ui: {
			onTerminalInput(next: typeof handler) {
				handler = next;
				return () => {
					handler = undefined;
				};
			},
			custom(factory: any, options: any) {
				opened.push(options);
				return new Promise<void>((resolve) => {
					factory(tui, undefined, undefined, () => resolve());
				});
			},
		},
	};
	installTranscriptMode(ctx);
	return {
		tui,
		opened,
		send: (data: string) => handler?.(data),
		hasHandler: () => handler !== undefined,
		restore() {
			teardownTranscriptMode();
			setToolMouseTui(null);
			config.mode = previousMode;
		},
	};
}

test("展开键打开全屏浏览层", () => {
	withExpandKey(() => {
		const t = setupEntry("compact");
		try {
			assert.deepEqual(t.send(CTRL_O), { consume: true });
			assert.equal(isTranscriptModeActive(), true);
			assert.equal(t.opened.length, 1);
			assert.equal(t.opened[0].overlay, true);
			assert.equal(t.opened[0].overlayOptions.width, "100%");
			assert.equal(t.opened[0].overlayOptions.maxHeight, "100%");
			// 已打开时按键交给浏览层自己处理。
			assert.equal(t.send(CTRL_O), undefined);
		} finally {
			t.restore();
		}
	});
});

function bashOutput(tui: any, lines: number): BashExecutionComponent {
	const component = new BashExecutionComponent("seq 30", tui, false, 1);
	component.appendOutput(
		Array.from({ length: lines }, (_, index) => `bash-line-${index + 1}`).join("\n"),
	);
	component.setComplete(0, false);
	return component;
}

test("对话区有可展开的 ! 输出时，展开键交还 Pi", () => {
	withExpandKey(() => {
		const tui: any = fakeTui();
		const chat = new Container();
		chat.children.push(bashOutput(tui, 40));
		tui.children = [chat];
		const t = setupEntry("on", tui);
		try {
			assert.equal(t.send(CTRL_O), undefined, "让 Pi 展开命令行输出");
			assert.equal(t.opened.length, 0);
			assert.equal(isTranscriptModeActive(), false);
		} finally {
			t.restore();
		}
	});
});

test("短的 ! 输出不占展开键：仍打开浏览层", () => {
	withExpandKey(() => {
		const tui: any = fakeTui();
		const chat = new Container();
		chat.children.push(bashOutput(tui, 5));
		tui.children = [chat];
		const t = setupEntry("on", tui);
		try {
			assert.deepEqual(t.send(CTRL_O), { consume: true });
			assert.equal(t.opened.length, 1);
		} finally {
			t.restore();
		}
	});
});

test("ccstyle 关闭、非全屏、有弹窗、焦点不在输入框时，展开键交还 Pi", () => {
	withExpandKey(() => {
		const cases: Array<[string, "on" | "off", (tui: any) => void]> = [
			["off", "off", () => {}],
			["regular", "on", (tui) => (tui.mode = "regular")],
			["overlay", "on", (tui) => (tui.overlay = true)],
			["focus", "on", (tui) => (tui.focusedComponent = {})],
		];
		for (const [name, mode, arrange] of cases) {
			const tui = fakeTui();
			arrange(tui);
			const t = setupEntry(mode, tui);
			try {
				assert.equal(t.send(CTRL_O), undefined, name);
				assert.equal(t.opened.length, 0, name);
			} finally {
				t.restore();
			}
		}
	});
});

test("卸载后关闭浏览层并停止拦截", async () => {
	await withExpandKey(async () => {
		const t = setupEntry("on");
		try {
			t.send(CTRL_O);
			teardownTranscriptMode();
			await new Promise((resolve) => setTimeout(resolve, 0));
			assert.equal(isTranscriptModeActive(), false);
			assert.equal(t.hasHandler(), false);
		} finally {
			t.restore();
		}
	});
});

// ---------------------------------------------------------------------------
// 选区跟随
// ---------------------------------------------------------------------------

test("正文滚动后选区跟着原来的文字走", () => {
	const scrolls: number[] = [];
	const view = new TranscriptView({
		rows: () => 12,
		items: () => lineItems(50),
		theme: undefined,
		close: () => {},
		focused: () => true,
		scrolled: (delta) => scrolls.push(delta),
	});
	view.render(80);
	view.handleInput("k");
	view.render(80);
	view.handleMouse({ type: "wheel", wheelDelta: -1 });
	view.render(80);
	view.render(80);
	assert.deepEqual(scrolls, [-1, -3], "没滚动的帧不通知");
});

test("选区按滚动行数平移；滚出正文区就清掉", () => {
	const tui: any = {
		selectionAnchor: { row: 3, col: 2 },
		selectionFocus: { row: 5, col: 10 },
		selectionInitialRange: { start: { row: 3, col: 0 }, end: { row: 3, col: 8 } },
		lastClick: { row: 3, col: 2, count: 2 },
		resetCount: 0,
		resetTextSelection() {
			this.resetCount++;
			this.selectionAnchor = undefined;
			this.selectionFocus = undefined;
		},
	};
	// 向上翻 2 行：文字下移，选区行号 +2。
	followScreenSelection(tui, -2, 10);
	assert.deepEqual(tui.selectionAnchor, { row: 5, col: 2 });
	assert.deepEqual(tui.selectionFocus, { row: 7, col: 10 });
	assert.deepEqual(tui.selectionInitialRange.start, { row: 5, col: 0 });
	assert.equal(tui.lastClick, undefined);
	// 再向上翻 3 行：focus 落到第 10 行，超出正文区。
	followScreenSelection(tui, -3, 10);
	assert.equal(tui.resetCount, 1);
	assert.equal(tui.selectionAnchor, undefined);
});

test("挂在对话区滚动视图上的选区不动", () => {
	const scrollView = {};
	const tui: any = {
		selectionAnchor: { row: 3, col: 2, scrollView },
		selectionFocus: { row: 5, col: 10, scrollView },
	};
	followScreenSelection(tui, 2, 10);
	assert.equal(tui.selectionAnchor.row, 3);
});
