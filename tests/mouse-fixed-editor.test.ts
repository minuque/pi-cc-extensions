import assert from "node:assert/strict";
import test from "node:test";

import { ToolExecutionComponent, initTheme } from "@earendil-works/pi-coding-agent";
import { Container, visibleWidth } from "@earendil-works/pi-tui";
import { createJiti } from "jiti";
import claudeCodeStyleExtension, {
	ExpandedToolIoView,
	fixedEditorWheelDispatchCount,
	installToolMouseInteraction,
	SHOW_MORE_LABEL,
} from "../extensions/claude-code-style.ts";
import {
	getFixedEditorScrollButtonHitbox,
	installFixedEditor,
	installFixedEditorImePatch,
	setBeforeFixedEditorStart,
} from "../extensions/fixed-editor.ts";
import { installToolGrouping, ToolGroupComponent } from "../extensions/tool-grouping.ts";

initTheme("dark");

test("fixed editor wheel dispatch averages five rows per tick", () => {
	installToolMouseInteraction({}, false, false);
	assert.deepEqual((["up", "up", "up"] as const).map(fixedEditorWheelDispatchCount), [1, 2, 2]);
	assert.deepEqual(
		(["down", "down", "down"] as const).map(fixedEditorWheelDispatchCount),
		[1, 2, 2],
	);
});

test("tool click uses fixed-editor visible rows without previousViewportTop", async () => {
	const inputListeners = new Set<(data: string) => { consume?: boolean } | undefined>();
	let expandedToolId: string | null = null;
	let editorInputCount = 0;
	const renderRequests: unknown[] = [];
	const createTool = (toolCallId: string, title: string) => ({
		toolCallId,
		expanded: false,
		renderCalls: 0,
		setExpanded(value: boolean) {
			this.expanded = value;
			if (value) expandedToolId = toolCallId;
		},
		invalidate() {},
		render() {
			this.renderCalls++;
			return ["", title, "  └ 1 line output (ctrl+o expand / click)"];
		},
	});
	const offscreenTool = createTool("tool-offscreen", "✓ Bash(echo old)");
	const visibleTool = createTool("tool-visible", "✓ Bash(echo ok)");
	const transcript = {
		children: [offscreenTool, visibleTool],
		render(width: number) {
			return this.children.flatMap((child) => child.render(width));
		},
	};
	const editor = {
		getText: () => "",
		setText() {},
		handleInput() {
			editorInputCount++;
		},
		render: () => ["editor"],
	};
	const status = { render: () => ["status"] };
	const above = {
		children: [] as any[],
		render(width: number) {
			return ["", ...this.children.flatMap((child) => child.render(width))];
		},
	};
	const editorContainer = { children: [editor], render: () => ["editor"] };
	const below = { render: () => ["below"] };
	const footer = { render: () => ["footer"] };
	const terminalPrototype = {
		get rows() {
			return 30;
		},
	};
	const terminal = Object.assign(Object.create(terminalPrototype), {
		columns: 80,
		write() {},
	});
	Object.defineProperty(terminal, "rows", { configurable: true, get: () => 25 });

	const tui = {
		terminal,
		children: [transcript, status, above, editorContainer, below, footer],
		focusedComponent: editor,
		// Zentui exposes only the three-row visible transcript window here.
		previousLines: ["", "✓ Bash(echo ok)", "  └ 1 line output (ctrl+o expand / click)"],
		// previousViewportTop is unrelated cursor bookkeeping.
		previousViewportTop: 17,
		requestRender(force?: boolean) {
			renderRequests.push(force);
		},
		render(width: number) {
			// Compositor-style visible root: only the on-screen transcript window.
			const full = transcript.children.flatMap((child: any) => child.render(width));
			return full.slice(-3);
		},
		doRender() {
			this.previousLines = this.render(80);
		},
		handleInput(data: string) {
			if (data === "\x1b[5;9~" && transcript.children.length > 0) {
				this.previousLines = [
					"",
					"✓ Bash(echo old)",
					"  └ 1 line output (ctrl+o expand / click)",
					"status",
					"editor",
					"below",
					"footer",
				];
			} else if (data === "\x1b[6~" && transcript.children.length > 0) {
				this.previousLines = [
					"",
					"✓ Bash(echo ok)",
					"  └ 1 line output (ctrl+o expand / click)",
					"status",
					"editor",
					"below",
					"footer",
				];
			}
			for (const listener of inputListeners) {
				if (listener(data)?.consume) return;
			}
			this.focusedComponent?.handleInput?.(data);
		},
	};
	const buttonForegrounds: string[] = [];
	const ui = {
		setStatus() {},
		setWidget(_key: string, factory: any) {
			if (!factory) return;
			scrollButton = factory(tui, {
				fg: (color: string, text: string) => {
					buttonForegrounds.push(color);
					return text;
				},
			});
			above.children.push(scrollButton);
		},
		onTerminalInput(handler: (data: string) => { consume?: boolean } | undefined) {
			inputListeners.add(handler);
			return () => inputListeners.delete(handler);
		},
	};
	let scrollButton: any;
	const events = new Map<string, (...args: any[]) => any>();
	const pi = {
		registerCommand() {},
		registerShortcut() {},
		registerTool() {},
		on(name: string, handler: (...args: any[]) => any) {
			events.set(name, handler);
		},
	};

	claudeCodeStyleExtension(pi as any, {
		fixedEditorFeatures: true,
		toolMouseInteraction: true,
	});
	await events.get("session_start")?.({}, { mode: "tui", hasUI: true, ui });
	class SnapshotCompositor {
		tui = tui;
		disposed = false;
		visibleRootStart = 3;
		visibleScrollableRows = 3;
		originalWrite() {}
		install() {}
		renderScrollableRoot() {
			return tui.previousLines;
		}
	}
	installFixedEditorImePatch(SnapshotCompositor as any);
	new SnapshotCompositor().renderScrollableRoot();
	tui.doRender();
	const offscreenRendersBeforeMotion = offscreenTool.renderCalls;
	const visibleRendersBeforeMotion = visibleTool.renderCalls;
	tui.handleInput("\x1b[<35;20;3M");
	assert.equal(offscreenTool.renderCalls - offscreenRendersBeforeMotion, 0);
	assert.equal(visibleTool.renderCalls - visibleRendersBeforeMotion, 0);
	tui.handleInput("\x1b[<0;20;3M");
	assert.equal(expandedToolId, "tool-visible");
	assert.equal(offscreenTool.expanded, false);
	assert.equal(visibleTool.expanded, true);

	// PageUp shows the affordance after the viewport actually moves, and a new
	// assistant message is counted.
	tui.handleInput("\x1b[5;9~");
	await new Promise<void>((resolve) => process.nextTick(resolve));
	events.get("message_start")?.({ message: { role: "assistant" } }, {});
	assert.match(scrollButton.render(80)[0], /1 new message/);
	assert.match(scrollButton.render(80)[0], /Ctrl\+End/);
	assert.doesNotMatch(scrollButton.render(80)[0], /click/i);

	// The Todo panel is registered after ccstyle, so it renders below the button.
	above.children.push({
		render: () => [" Todos (0/3)", " ├─ Todo 1", " ├─ Todo 2", " └─ Todo 3"],
	});
	const cluster = createJiti(import.meta.url)("@tifan/pi-fixed-editor/src/cluster.js") as {
		renderFixedEditorCluster(input: any): unknown;
	};
	const renderCluster = () =>
		cluster.renderFixedEditorCluster({
			width: 80,
			terminalRows: 30,
			statusLines: ["status"],
			aboveWidgetLines: above.render(80).filter((line) => visibleWidth(line) > 0),
			editorLines: ["editor"],
			belowWidgetLines: ["below"],
			footerLines: ["footer"],
		});
	renderCluster();
	tui.doRender();
	const hitbox = getFixedEditorScrollButtonHitbox();
	assert.ok(hitbox);
	const buttonCol = Math.floor((hitbox.startCol + hitbox.endCol) / 2);
	// Hover stays exact so the adjacent Todo row is not highlighted as the button.
	tui.handleInput(`\x1b[<35;${buttonCol};${hitbox.row}M`);
	scrollButton.render(80);
	assert.equal(buttonForegrounds.at(-1), "text");
	tui.handleInput(`\x1b[<35;${buttonCol};${hitbox.row + 1}M`);
	scrollButton.render(80);
	assert.equal(buttonForegrounds.at(-1), "accent");
	// The retained hitbox keeps the visible button clickable when the Todo cluster is present.
	const editorInputsBeforeButton = editorInputCount;
	tui.handleInput(`\x1b[<0;${buttonCol};${hitbox.row}M`);
	assert.deepEqual(scrollButton.render(80), []);
	assert.equal(editorInputCount, editorInputsBeforeButton);

	// Re-open the affordance so the existing PageDown path remains covered.
	tui.handleInput("\x1b[5;9~");
	await new Promise<void>((resolve) => process.nextTick(resolve));
	renderCluster();
	tui.doRender();
	assert.match(scrollButton.render(80)[0], /Back to bottom/);
	// PageDown reaching the root tail hides the button and clears the count.
	tui.handleInput("\x1b[6~");
	await new Promise<void>((resolve) => process.nextTick(resolve));
	assert.deepEqual(scrollButton.render(80), []);

	// Ctrl+End jumps through Zentui's normal Enter path without submitting.
	tui.handleInput("\x1b[5;9~");
	const editorInputsBeforeShortcut = editorInputCount;
	tui.handleInput("\x1b[8^");
	assert.deepEqual(scrollButton.render(80), []);
	assert.equal(editorInputCount, editorInputsBeforeShortcut);

	// Pi rebuilds the transcript on compaction without session_start. If another
	// fixed-editor owner replaces the root dispatcher, ccstyle must wrap it again.
	const replacementHandle = function (this: typeof tui, data: string) {
		for (const listener of inputListeners) {
			if (listener(data)?.consume) return;
		}
		this.focusedComponent?.handleInput?.(data);
	};
	tui.handleInput = replacementHandle;
	tui.previousLines = ["", "✓ Bash(echo ok)", "  └ 1 line output (ctrl+o expand / click)"];
	visibleTool.expanded = false;
	expandedToolId = null;
	await events.get("session_compact")?.({}, { mode: "tui", hasUI: true, ui });
	assert.notEqual(
		tui.handleInput,
		replacementHandle,
		"compaction reclaims the root input dispatcher",
	);
	tui.doRender();
	tui.handleInput("\x1b[<0;20;3M");
	assert.equal(expandedToolId, "tool-visible");

	// An empty transcript cannot move, so PageUp must never flash the affordance.
	transcript.children = [];
	tui.previousLines = [];
	tui.handleInput("\x1b[5;9~");
	assert.deepEqual(scrollButton.render(80), []);
	await new Promise<void>((resolve) => setTimeout(resolve, 80));
	assert.deepEqual(scrollButton.render(80), []);

	// Startup continuation, /reload, and /resume populate or rebuild transcripts
	// at different lifecycle points. All need a deferred forced repaint instead
	// of waiting for terminal input to reveal restored rows.
	for (const reason of ["startup", "reload", "resume"]) {
		renderRequests.length = 0;
		await events.get("session_start")?.({ reason }, { mode: "tui", hasUI: true, ui });
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
		assert.ok(renderRequests.includes(true), `${reason} forces a deferred repaint`);
	}

	renderRequests.length = 0;
	await events.get("session_start")?.({ reason: "reload" }, { mode: "tui", hasUI: true, ui });
	await events.get("session_shutdown")?.({}, { mode: "tui", hasUI: true, ui });
	await new Promise<void>((resolve) => setTimeout(resolve, 0));
	assert.ok(!renderRequests.includes(true), "shutdown cancels the deferred repaint");
});

test("identical fixed-editor tools hit the visible first tool, not the offscreen second", () => {
	let expanded: string | null = null;
	const createTool = (id: string) => ({
		toolCallId: id,
		expanded: false,
		setExpanded(value: boolean) {
			this.expanded = value;
			if (value) expanded = id;
		},
		invalidate() {},
		render: () => ["✓ Bash(same)", "  └ same output (1 more line / click)"],
	});
	const visible = createTool("visible-first");
	const offscreen = createTool("offscreen-second");
	const terminalPrototype = {
		get rows() {
			return 20;
		},
		write() {},
	};
	const terminal = Object.assign(Object.create(terminalPrototype), { columns: 80 });
	Object.defineProperty(terminal, "rows", { configurable: true, get: () => 15 });
	const tui = {
		terminal,
		children: [visible, offscreen],
		previousLines: visible.render() as string[],
		previousViewportTop: 99,
		handleInput() {},
		requestRender() {},
		// Visible root already sliced to the first tool (compositor window).
		render(width: number) {
			return visible.render(width);
		},
		doRender() {
			this.previousLines = this.render(80);
		},
	};
	installToolMouseInteraction(
		{
			mode: "tui",
			hasUI: true,
			ui: {
				setWidget(_key: string, factory: any) {
					factory?.(tui, { fg: (_color: string, text: string) => text });
				},
				onTerminalInput() {
					return () => undefined;
				},
			},
		},
		true,
		true,
	);
	class SnapshotCompositor {
		tui = tui;
		disposed = false;
		visibleRootStart = 0;
		visibleScrollableRows = 2;
		originalWrite() {}
		install() {}
		renderScrollableRoot() {
			return tui.previousLines;
		}
	}
	installFixedEditorImePatch(SnapshotCompositor as any);
	new SnapshotCompositor().renderScrollableRoot();
	try {
		tui.doRender();
		tui.handleInput("\x1b[<35;25;2M");
		tui.handleInput("\x1b[<0;25;2M");
		assert.equal(expanded, "visible-first");
		assert.equal(offscreen.expanded, false);
	} finally {
		installToolMouseInteraction({}, false, false);
	}
});

test("fixed editor uses the rendered frame when dynamic Todo rows change", () => {
	let firstTitle = "✓ Todo 1";
	let secondTitle = "✓ Todo 3";
	let expandedToolId: string | null = null;
	const createTool = (toolCallId: string, getTitle: () => string) => ({
		toolCallId,
		expanded: false,
		setExpanded(value: boolean) {
			this.expanded = value;
			if (value) expandedToolId = toolCallId;
		},
		invalidate() {},
		render() {
			return [getTitle(), "  ↳ 1 line returned • click to show more"];
		},
	});
	const first = createTool("todo-1", () => firstTitle);
	const second = createTool("todo-3", () => secondTitle);
	const terminalPrototype = {
		get rows() {
			return 30;
		},
		write() {},
	};
	const terminal = Object.assign(Object.create(terminalPrototype), { columns: 80 });
	Object.defineProperty(terminal, "rows", { configurable: true, get: () => 25 });
	const tui = {
		terminal,
		children: [first, second],
		previousLines: [] as string[],
		previousViewportTop: 0,
		handleInput() {},
		requestRender() {},
		doRender() {
			this.previousLines = this.children.flatMap((tool) => tool.render());
		},
	};
	installToolMouseInteraction(
		{
			mode: "tui",
			hasUI: true,
			ui: {
				setWidget(_key: string, factory: any) {
					factory?.(tui, { fg: (_color: string, text: string) => text });
				},
				onTerminalInput() {
					return () => undefined;
				},
			},
		},
		true,
		true,
	);
	try {
		tui.doRender();
		assert.equal(tui.previousLines[2], "✓ Todo 3");
		// Dynamic Todo renderers now expose the latest state for both historical components.
		firstTitle = "✓ Todo 3";
		secondTitle = "✓ Todo 3";
		const summaryRow = 4;
		const hintCol = tui.previousLines[summaryRow - 1].indexOf("click to show more") + 1;
		tui.handleInput(`\x1b[<0;${hintCol};${summaryRow}M`);
		assert.equal(expandedToolId, "todo-3");
		assert.equal(first.expanded, false);
		assert.equal(second.expanded, true);
	} finally {
		installToolMouseInteraction({}, false, false);
	}
});

test("tool groups expand from their hint and collapse from any expanded group row", () => {
	const grouping = installToolGrouping(() => true);
	grouping.setTheme({
		fg: (color: string, text: string) => (color === "text" ? `\x1b[37m${text}\x1b[39m` : text),
	});
	let inputHandler: ((data: string) => { consume?: boolean } | undefined) | undefined;
	try {
		const ui = { theme: { fg: (_color: string, text: string) => text }, requestRender() {} } as any;
		const parent = new Container() as any;
		for (const [name, id] of [
			["read", "one"],
			["bash", "two"],
		] as const) {
			const component = new ToolExecutionComponent(
				name,
				id,
				{},
				{},
				undefined,
				ui,
				process.cwd(),
			) as any;
			component.updateResult({ content: [{ type: "text", text: "one\ntwo" }], isError: false });
			parent.addChild(component);
		}
		const group = parent.children[0] as any;
		assert.ok(group instanceof ToolGroupComponent);
		const tui = {
			terminal: { columns: 100, write() {} },
			children: [parent],
			previousLines: group.render(100),
			previousViewportTop: 0,
			requestRender() {},
			doRender() {
				this.previousLines = group.render(100);
			},
		};
		installToolMouseInteraction(
			{
				mode: "tui",
				hasUI: true,
				ui: {
					setWidget(_key: string, factory: any) {
						factory?.(tui, ui.theme);
					},
					onTerminalInput(handler: typeof inputHandler) {
						inputHandler = handler;
						return () => undefined;
					},
				},
			},
			false,
			true,
		);
		tui.doRender();
		const headerRow = tui.previousLines.findIndex((line: string) =>
			line.includes("click to show more"),
		);
		assert.ok(headerRow >= 0);
		const hintColumn = tui.previousLines[headerRow].indexOf("click to show more") + 1;
		inputHandler?.(`\x1b[<32;${hintColumn};${headerRow + 1}M`);
		assert.match(group.render(100)[headerRow], /\x1b\[37m• click to show more\x1b\[39m/);
		assert.equal(inputHandler?.(`\x1b[<0;${hintColumn};${headerRow + 1}M`)?.consume, true);
		assert.equal(group.expanded, true);

		tui.doRender();
		const bottomPaddingRow = tui.previousLines.length - 1;
		assert.equal(tui.previousLines[bottomPaddingRow].trim(), "");
		assert.equal(inputHandler?.(`\x1b[<0;100;${bottomPaddingRow + 1}M`)?.consume, true);
		assert.equal(group.expanded, false);
	} finally {
		installToolMouseInteraction({}, false, false);
		grouping.shutdown();
	}
});

test("truncated tool summary remains clickable and highlights on hover", async () => {
	let inputHandler: ((data: string) => { consume?: boolean } | undefined) | undefined;
	const writes: string[] = [];
	let renderRequests = 0;
	let toolRenderCalls = 0;
	const tool = {
		toolCallId: "tool-truncated",
		expanded: false,
		setExpanded(value: boolean) {
			this.expanded = value;
		},
		invalidate() {},
		render() {
			toolRenderCalls++;
			return ["✓ Agent(task)", "  └ output (23 more lines / click)"];
		},
	};
	const tui = {
		terminal: { columns: 40, write: (value: string) => writes.push(value) },
		children: [tool],
		previousLines: tool.render(),
		previousViewportTop: 0,
		handleInput() {},
		requestRender() {
			renderRequests++;
		},
		doRender() {
			this.previousLines = tool.render();
		},
	};
	installToolMouseInteraction(
		{
			mode: "tui",
			hasUI: true,
			ui: {
				setWidget(_key: string, factory: any) {
					if (typeof factory === "function")
						factory(tui, { fg: (_c: string, text: string) => text });
				},
				onTerminalInput(handler: typeof inputHandler) {
					inputHandler = handler;
					return () => undefined;
				},
			},
		},
		false,
		true,
	);
	tui.doRender();

	toolRenderCalls = 0;
	inputHandler?.("\x1b[<35;20;2M");
	await new Promise<void>((resolve) => process.nextTick(resolve));
	assert.equal(renderRequests, 1, "hover invalidates the summary renderer");
	assert.equal(toolRenderCalls, 0);

	tui.previousLines = ["ordinary transcript row"];
	inputHandler?.("\x1b[<35;20;1M");
	assert.equal(toolRenderCalls, 0, "input hit-testing does not render the tool tree");
	assert.equal(renderRequests, 2, "ordinary motion clears the old hover");

	tui.previousLines = ["✓ Agent(task)", "\x1b[31m  └ output (23 more lines / click)\x1b[0m"];
	inputHandler?.("\x1b[<35;20;2M");
	assert.equal(renderRequests, 3, "ANSI summary hints remain hoverable");
	assert.equal(inputHandler?.("\x1b[<0;5;2M"), undefined);
	assert.equal(tool.expanded, false, "summary text and row padding are not clickable");
	assert.deepEqual(inputHandler?.("\x1b[<0;30;2M"), { consume: true });
	assert.equal(tool.expanded, true);

	installToolMouseInteraction({}, false, false);
});

test("parenthesized rich diff hint highlights and expands on click", async () => {
	let inputHandler: ((data: string) => { consume?: boolean } | undefined) | undefined;
	let renderRequests = 0;
	const tool = {
		toolCallId: "edit-diff",
		expanded: false,
		setExpanded(value: boolean) {
			this.expanded = value;
		},
		invalidate() {},
		render() {
			return ["✓ Edit sample.ts", " … (29 more diff lines • click to show more)"];
		},
	};
	const tui = {
		terminal: { columns: 80, write() {} },
		children: [tool],
		previousLines: tool.render(),
		previousViewportTop: 0,
		handleInput() {},
		requestRender() {
			renderRequests++;
		},
		doRender() {
			this.previousLines = tool.render();
		},
	};
	installToolMouseInteraction(
		{
			mode: "tui",
			hasUI: true,
			ui: {
				setWidget(_key: string, factory: any) {
					if (typeof factory === "function")
						factory(tui, { fg: (_color: string, text: string) => text });
				},
				onTerminalInput(handler: typeof inputHandler) {
					inputHandler = handler;
					return () => undefined;
				},
			},
		},
		false,
		true,
	);
	try {
		tui.doRender();
		inputHandler?.("\x1b[<35;35;2M");
		await new Promise<void>((resolve) => process.nextTick(resolve));
		assert.equal(renderRequests, 1, "hover requests a repaint for white hint text");
		assert.deepEqual(inputHandler?.("\x1b[<0;35;2M"), { consume: true });
		assert.equal(tool.expanded, true);
	} finally {
		installToolMouseInteraction({}, false, false);
	}
});

test("show-more hover targets the view rendered in the current frame after compact", () => {
	let inputHandler: ((data: string) => { consume?: boolean } | undefined) | undefined;
	const theme = {
		fg: (color: string, text: string) => (color === "text" ? `\x1b[97m${text}\x1b[0m` : text),
		bold: (text: string) => text,
	};
	const staleView = new ExpandedToolIoView(theme, "old\ninput", "old\noutput", false, 1, 1);
	const currentView = new ExpandedToolIoView(
		theme,
		"current\ninput",
		"current\noutput",
		false,
		1,
		1,
	);
	const tool = {
		toolCallId: "tool-after-compact",
		expanded: true,
		state: { ccstyleIoView: staleView },
		setExpanded(value: boolean) {
			this.expanded = value;
		},
		invalidate() {},
		render() {
			return ["✓ Tool", ...currentView.render(78)];
		},
	};
	const terminalPrototype = {
		get rows() {
			return 30;
		},
		write() {},
	};
	const terminal = Object.assign(Object.create(terminalPrototype), { columns: 80 });
	Object.defineProperty(terminal, "rows", { configurable: true, get: () => 25 });
	const tui: any = {
		terminal,
		children: [tool],
		previousLines: [] as string[],
		previousViewportTop: 0,
		handleInput(data: string) {
			inputHandler?.(data);
		},
		requestRender() {},
		doRender() {
			this.previousLines = tool.render();
		},
	};
	const interactionCtx = {
		mode: "tui",
		hasUI: true,
		ui: {
			setWidget(_key: string, factory: any) {
				if (typeof factory === "function") factory(tui, theme);
			},
			onTerminalInput(handler: typeof inputHandler) {
				inputHandler = handler;
				return () => undefined;
			},
		},
	};
	installToolMouseInteraction(interactionCtx, true, true);
	// fixed-editor can retain the prior doRender wrapper while compact installs a new one.
	const retainedRender = tui.doRender;
	tui.doRender = function (this: any, ...args: any[]) {
		return Reflect.apply(retainedRender, this, args);
	};
	installToolMouseInteraction(interactionCtx, true, true);
	try {
		tui.doRender();
		const inputHeader = tui.previousLines[1];
		const col = inputHeader.indexOf(SHOW_MORE_LABEL) + 1;
		tui.handleInput(`\x1b[<35;${col};2M`);
		assert.match(currentView.render(78)[0], /\x1b\[97m/);
		assert.doesNotMatch(staleView.render(78)[0], /\x1b\[97m/);
	} finally {
		installToolMouseInteraction({}, false, false);
	}
});

test("expanded native card collapses on click and preserves the viewport", async () => {
	let wheelDownDispatches = 0;
	const inputListeners = new Set<(data: string) => { consume?: boolean } | undefined>();
	inputListeners.add((data) => {
		if (/^\x1b\[<65;/.test(data)) wheelDownDispatches++;
		return undefined;
	});
	const cardLines = ["✓ Bash(echo ok)", "  │ one", "  │ two", "  │ three", "  │ four", "  │ five"];
	const contentBox = { render: () => cardLines };
	const tool = {
		toolCallId: "tool-expanded",
		expanded: true,
		contentBox,
		children: [{ render: () => [""] }, contentBox],
		setExpanded(value: boolean) {
			this.expanded = value;
		},
		invalidate() {},
		render() {
			return this.expanded
				? ["", ...contentBox.render()]
				: ["", "✓ Bash(echo ok)", "  └ 5 lines (5 more lines / click)"];
		},
	};
	const terminalPrototype = {
		get rows() {
			return 30;
		},
	};
	const terminal = Object.assign(Object.create(terminalPrototype), {
		columns: 80,
		write() {},
	});
	Object.defineProperty(terminal, "rows", { configurable: true, get: () => 25 });
	const tui = {
		terminal,
		children: [tool],
		previousLines: tool.render(),
		previousViewportTop: 0,
		handleInput(data: string) {
			for (const listener of inputListeners) {
				if (listener(data)?.consume) return;
			}
		},
		requestRender() {
			this.previousLines = tool.render();
		},
		doRender() {
			this.previousLines = tool.render();
		},
	};
	const ctx = {
		mode: "tui",
		hasUI: true,
		ui: {
			setWidget(_key: string, factory: any) {
				if (typeof factory === "function") {
					factory(tui, { fg: (_color: string, text: string) => text });
				}
			},
			onTerminalInput(handler: (data: string) => { consume?: boolean } | undefined) {
				inputListeners.add(handler);
				return () => inputListeners.delete(handler);
			},
		},
	};

	installToolMouseInteraction(ctx, true, true);
	tui.doRender();
	tui.handleInput("\x1b[<0;10;2M");
	await new Promise<void>((resolve) => process.nextTick(resolve));
	assert.equal(tool.expanded, false);
	assert.equal(wheelDownDispatches, 1);
	installToolMouseInteraction({}, false, false);
});

test("fixed editor restores motion reporting after the right-click menu pause", async () => {
	const writes: string[] = [];
	let inputListener: ((data: string) => unknown) | undefined;
	const terminal = {
		columns: 80,
		rows: 20,
		write(data: string) {
			writes.push(data);
		},
	};
	const tui = {
		children: [],
		terminal,
		render: () => ["root"],
		doRender() {
			terminal.write("\x1b[?1002h\x1b[?1006h");
		},
		requestRender() {},
		addInputListener(listener: (data: string) => unknown) {
			inputListener = listener;
			return () => {
				inputListener = undefined;
			};
		},
		hasOverlay: () => false,
	};
	const { TerminalSplitCompositor } = createJiti(import.meta.url)(
		"@tifan/pi-fixed-editor/src/terminal-split.js",
	) as { TerminalSplitCompositor: new (options: any) => any };
	const compositor = new TerminalSplitCompositor({
		tui,
		terminal,
		renderCluster: () => ({ lines: ["editor"], cursor: null }),
	});
	try {
		compositor.install();
		tui.doRender();
		assert.ok(writes.at(-1)?.includes("?1003h"));
		assert.ok(!writes.at(-1)?.includes("?1002h"));
		inputListener?.("\x1b[<2;1;1M");
		await new Promise<void>((resolve) => setTimeout(resolve, 1250));
		assert.ok(writes.at(-1)?.includes("?1003h"));
		assert.ok(!writes.at(-1)?.includes("?1002h"));
	} finally {
		compositor.dispose();
	}
	terminal.write("\x1b[?1002h");
	assert.equal(writes.at(-1), "\x1b[?1002h", "dispose restores the native terminal writer");
});

test("native tool mouse mode retains capture and Ctrl+End after fixed editor is disabled", () => {
	const writes: string[] = [];
	const widgetValues: unknown[] = [];
	const renderRequests: unknown[] = [];
	let inputHandler: ((data: string) => { consume?: boolean } | undefined) | undefined;
	const tui = {
		terminal: {
			columns: 80,
			write(value: string) {
				writes.push(value);
			},
		},
		handleInput() {},
		requestRender(force?: boolean) {
			renderRequests.push(force);
		},
	};
	const ctx = {
		mode: "tui",
		hasUI: true,
		ui: {
			setWidget(_key: string, value: any) {
				widgetValues.push(value);
				if (typeof value === "function") {
					value(tui, { fg: (_color: string, text: string) => text });
				}
			},
			onTerminalInput(handler: (data: string) => { consume?: boolean } | undefined) {
				inputHandler = handler;
				return () => {
					if (inputHandler === handler) inputHandler = undefined;
				};
			},
		},
	};

	installToolMouseInteraction(ctx, true, true);
	assert.ok(!writes.some((value) => value.includes("?1000h")));
	const disabledWritesStart = writes.length;
	installToolMouseInteraction(ctx, false, true);
	const disabledWrites = writes.slice(disabledWritesStart);
	assert.ok(!disabledWrites.some((value) => value.includes("?1000l")));
	assert.ok(disabledWrites.some((value) => value.includes("?1003h")));
	assert.equal(typeof widgetValues.at(-1), "function");

	const result = inputHandler?.("\x1b[8^");
	assert.deepEqual(result, { consume: true });
	assert.equal(writes.at(-1), "\x1b[0m");
	assert.deepEqual(renderRequests, [undefined]);

	installToolMouseInteraction({}, false, false);
});

test("tool mouse off releases reporting and cannot re-enable it on render", () => {
	const writes: string[] = [];
	const widgetValues: unknown[] = [];
	let inputHandler: ((data: string) => { consume?: boolean } | undefined) | undefined;
	let renderCalls = 0;
	const originalDoRender = () => {
		renderCalls++;
	};
	const tui = {
		terminal: {
			columns: 80,
			rows: 24,
			write(value: string) {
				writes.push(value);
			},
		},
		children: [],
		previousLines: [] as string[],
		previousViewportTop: 0,
		handleInput() {},
		requestRender() {},
		render: () => [] as string[],
		doRender: originalDoRender,
	};
	const ctx = {
		mode: "tui",
		hasUI: true,
		ui: {
			setWidget(_key: string, value: any) {
				widgetValues.push(value);
				if (typeof value === "function") {
					value(tui, { fg: (_color: string, text: string) => text });
				}
			},
			onTerminalInput(handler: (data: string) => { consume?: boolean } | undefined) {
				inputHandler = handler;
				return () => {
					if (inputHandler === handler) inputHandler = undefined;
				};
			},
		},
	};

	try {
		installToolMouseInteraction(ctx, false, true);
		assert.notEqual(tui.doRender, originalDoRender);
		tui.doRender();
		assert.ok(writes.some((value) => value.includes("?1003h") && value.includes("?1006h")));

		const disabledWritesStart = writes.length;
		installToolMouseInteraction(ctx, false, false);
		const disabledWrites = writes.slice(disabledWritesStart).join("");
		assert.match(disabledWrites, /\?1006l/);
		assert.match(disabledWrites, /\?1003l/);
		assert.match(disabledWrites, /\?1002l/);
		assert.match(disabledWrites, /\?1000l/);
		assert.doesNotMatch(disabledWrites, /\?100[236]h/);
		assert.equal(tui.doRender, originalDoRender);
		assert.equal(inputHandler, undefined);
		assert.equal(widgetValues.at(-1), undefined);

		const enableWrites = writes.filter((value) => /\?100[236]h/.test(value)).length;
		tui.doRender();
		assert.equal(renderCalls, 2);
		assert.equal(
			writes.filter((value) => /\?100[236]h/.test(value)).length,
			enableWrites,
			"renders after disabling must not re-enable mouse reporting",
		);
	} finally {
		installToolMouseInteraction({}, false, false);
	}
});

test("tool mouse off leaves fixed-editor mouse ownership untouched", () => {
	let widgetCalls = 0;
	let inputListenerCalls = 0;
	installToolMouseInteraction(
		{
			mode: "tui",
			hasUI: true,
			ui: {
				setWidget() {
					widgetCalls++;
				},
				onTerminalInput() {
					inputListenerCalls++;
					return () => undefined;
				},
			},
		},
		true,
		false,
	);
	assert.equal(widgetCalls, 0);
	assert.equal(inputListenerCalls, 0);
	installToolMouseInteraction({}, false, false);
});

test("doRender replacement is rebound so the next painted frame stays clickable", () => {
	let expanded: string | null = null;
	const tool = {
		toolCallId: "after-rebind",
		expanded: false,
		setExpanded(value: boolean) {
			this.expanded = value;
			if (value) expanded = this.toolCallId;
		},
		invalidate() {},
		render: () => ["✓ Bash(echo ok)", "  └ 1 line (ctrl+o expand / click)"],
	};
	const terminalPrototype = {
		get rows() {
			return 20;
		},
		write() {},
	};
	const terminal = Object.assign(Object.create(terminalPrototype), { columns: 80 });
	Object.defineProperty(terminal, "rows", { configurable: true, get: () => 15 });
	const tui: any = {
		terminal,
		children: [tool],
		previousLines: [] as string[],
		previousViewportTop: 0,
		handleInput() {},
		requestRender() {},
		render(width: number) {
			return tool.render(width);
		},
		doRender() {
			this.previousLines = this.render(80);
		},
	};
	const ctx = {
		mode: "tui",
		hasUI: true,
		ui: {
			setWidget(_key: string, factory: any) {
				if (typeof factory === "function") {
					factory(tui, { fg: (_c: string, text: string) => text });
				}
			},
			onTerminalInput() {
				return () => undefined;
			},
		},
	};
	installToolMouseInteraction(ctx, true, true);
	const firstWrapper = tui.doRender;
	// Compositor rebuild replaces doRender; the old instrumentation must not stick to a dead wrapper.
	const compositorDoRender = function (this: any) {
		this.previousLines = this.render(80);
	};
	tui.doRender = compositorDoRender;
	installToolMouseInteraction(ctx, true, true);
	try {
		assert.notEqual(tui.doRender, firstWrapper);
		assert.notEqual(tui.doRender, compositorDoRender);
		tui.doRender();
		const hintCol = tui.previousLines[1].indexOf("/ click") + 1;
		tui.handleInput(`\x1b[<0;${hintCol};2M`);
		assert.equal(expanded, "after-rebind");
	} finally {
		installToolMouseInteraction({}, false, false);
	}
});

test("expanded tool group show-more opens preview instead of collapsing the group", () => {
	const grouping = installToolGrouping(() => true);
	grouping.setTheme({
		fg: (color: string, text: string) => text,
		bold: (text: string) => text,
		bg: (_slot: string, text: string) => text,
	});
	let inputHandler: ((data: string) => { consume?: boolean } | undefined) | undefined;
	let previewOpened = false;
	try {
		const theme = {
			fg: (_color: string, text: string) => text,
			bold: (text: string) => text,
			bg: (_slot: string, text: string) => text,
		};
		const ui = {
			theme,
			requestRender() {},
			custom: async (factory: any) => {
				previewOpened = true;
				factory?.(
					{
						requestRender() {},
						rows: 40,
						columns: 100,
					},
					theme,
					{},
					() => {},
				);
				return undefined;
			},
			notify() {},
		} as any;
		const parent = new Container() as any;
		for (const [name, id, body] of [
			["read", "g1", "line1\nline2\nline3\nline4\nline5\nline6"],
			["bash", "g2", "out1\nout2\nout3\nout4\nout5\nout6"],
		] as const) {
			const component = new ToolExecutionComponent(
				name,
				id,
				{},
				{},
				undefined,
				ui,
				process.cwd(),
			) as any;
			component.updateResult({ content: [{ type: "text", text: body }], isError: false });
			parent.addChild(component);
		}
		const group = parent.children[0] as any;
		assert.ok(group instanceof ToolGroupComponent);
		group.setExpanded(true);
		const longOut = "x\n".repeat(30);
		const ioView = new ExpandedToolIoView(theme, "a\nb\nc\nd\ne", longOut, false, 2, 2);
		const childTool = group.children[0];
		childTool.render = (width: number) => [`✓ child`, ...ioView.render(Math.max(1, width - 2))];
		childTool.setExpanded = (value: boolean) => {
			childTool.expanded = value;
		};
		childTool.expanded = true;
		const tui = {
			terminal: { columns: 100, write() {} },
			children: [parent],
			previousLines: [] as string[],
			previousViewportTop: 0,
			requestRender() {},
			doRender() {
				this.previousLines = group.render(100);
			},
		};
		installToolMouseInteraction(
			{
				mode: "tui",
				hasUI: true,
				ui: {
					...ui,
					setWidget(_key: string, factory: any) {
						factory?.(tui, theme);
					},
					onTerminalInput(handler: typeof inputHandler) {
						inputHandler = handler;
						return () => undefined;
					},
				},
			},
			false,
			true,
		);
		tui.doRender();
		const showMoreRow = tui.previousLines.findIndex((line: string) =>
			line.includes(SHOW_MORE_LABEL),
		);
		assert.ok(showMoreRow >= 0, "expanded group must paint [show more]");
		const col = tui.previousLines[showMoreRow].indexOf(SHOW_MORE_LABEL) + 1;
		inputHandler?.(`\x1b[<35;${col};${showMoreRow + 1}M`);
		const beforeExpanded = group.expanded;
		assert.equal(inputHandler?.(`\x1b[<0;${col};${showMoreRow + 1}M`)?.consume, true);
		assert.equal(group.expanded, beforeExpanded, "show-more must not collapse the group");
		assert.equal(previewOpened, true, "show-more opens the text preview");
	} finally {
		installToolMouseInteraction({}, false, false);
		grouping.shutdown();
	}
});

test("native mode hits the visible identical tool, not the offscreen duplicate", () => {
	let expanded: string | null = null;
	let inputHandler: ((data: string) => { consume?: boolean } | undefined) | undefined;
	const createTool = (id: string) => ({
		toolCallId: id,
		expanded: false,
		setExpanded(value: boolean) {
			this.expanded = value;
			if (value) expanded = id;
		},
		invalidate() {},
		render: () => ["✓ Bash(same)", "  └ same output (1 more line / click)"],
	});
	const offscreen = createTool("native-offscreen");
	const visible = createTool("native-visible");
	const tui = {
		terminal: { columns: 80, rows: 4, write() {} },
		children: [offscreen, visible],
		previousLines: [] as string[],
		previousViewportTop: 0,
		handleInput() {},
		requestRender() {},
		render(width: number) {
			return this.children.flatMap((child: any) => child.render(width));
		},
		doRender() {
			this.previousLines = this.render(80);
			// Native TUI keeps the full buffer; viewport top selects the on-screen window.
			this.previousViewportTop = 2;
		},
	};
	installToolMouseInteraction(
		{
			mode: "tui",
			hasUI: true,
			ui: {
				setWidget(_key: string, factory: any) {
					factory?.(tui, { fg: (_c: string, text: string) => text });
				},
				onTerminalInput(handler: typeof inputHandler) {
					inputHandler = handler;
					return () => undefined;
				},
			},
		},
		false,
		true,
	);
	try {
		tui.doRender();
		// Screen row 2 = buffer index 3 (visible tool hint): 3 - 2 + 1 = 2.
		const hintCol = tui.previousLines[3].indexOf("/ click") + 1;
		assert.deepEqual(inputHandler?.(`\x1b[<0;${hintCol};2M`), { consume: true });
		assert.equal(expanded, "native-visible");
		assert.equal(offscreen.expanded, false);
	} finally {
		installToolMouseInteraction({}, false, false);
	}
});

test("native mode hits offset columns after parent layout prefix", async () => {
	let inputHandler: ((data: string) => { consume?: boolean } | undefined) | undefined;
	let renderRequests = 0;
	const PREFIX = "    ";
	const toolLines = ["✓ Bash(echo ok)", "  └ 1 line output (ctrl+o expand / click)"];
	const tool = {
		toolCallId: "prefixed-tool",
		expanded: false,
		setExpanded(value: boolean) {
			this.expanded = value;
		},
		invalidate() {},
		render: () => toolLines.slice(),
	};
	const tui = {
		terminal: { columns: 80, rows: 10, write() {} },
		children: [tool],
		previousLines: [] as string[],
		previousViewportTop: 0,
		handleInput() {},
		requestRender() {
			renderRequests++;
		},
		render() {
			// Parent layout adds a visible indent after the tool paints its own lines.
			return this.children.flatMap((child: any) =>
				child.render().map((line: string) => PREFIX + line),
			);
		},
		doRender() {
			this.previousLines = this.render();
		},
	};
	installToolMouseInteraction(
		{
			mode: "tui",
			hasUI: true,
			ui: {
				setWidget(_key: string, factory: any) {
					factory?.(tui, { fg: (_c: string, text: string) => text });
				},
				onTerminalInput(handler: typeof inputHandler) {
					inputHandler = handler;
					return () => undefined;
				},
			},
		},
		false,
		true,
	);
	try {
		tui.doRender();
		const finalHint = tui.previousLines[1];
		assert.equal(finalHint, PREFIX + toolLines[1]);
		assert.doesNotMatch(finalHint, /\x1b_cc:t/);
		assert.ok(tui.previousLines.every((line) => !/\x1b_cc:t/.test(line)));

		const oldCol = toolLines[1].indexOf("(ctrl+o expand / click)") + 1;
		const offsetCol = finalHint.indexOf("(ctrl+o expand / click)") + 1;
		assert.notEqual(oldCol, offsetCol);

		// Pre-prefix columns must miss; only the final painted columns hit.
		assert.equal(inputHandler?.(`\x1b[<35;${oldCol};2M`), undefined);
		await new Promise<void>((resolve) => process.nextTick(resolve));
		assert.equal(renderRequests, 0, "old columns do not hover the offset hint");
		assert.equal(tool.expanded, false);
		assert.equal(inputHandler?.(`\x1b[<0;${oldCol};2M`), undefined);
		assert.equal(tool.expanded, false);

		inputHandler?.(`\x1b[<35;${offsetCol};2M`);
		await new Promise<void>((resolve) => process.nextTick(resolve));
		assert.equal(renderRequests, 1, "offset columns hover the final painted hint");
		assert.deepEqual(inputHandler?.(`\x1b[<0;${offsetCol};2M`), { consume: true });
		assert.equal(tool.expanded, true);
	} finally {
		installToolMouseInteraction({}, false, false);
	}
});

test("expanded group identical show-more labels open their own content", () => {
	const grouping = installToolGrouping(() => true);
	grouping.setTheme({
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
		bg: (_slot: string, text: string) => text,
	});
	let inputHandler: ((data: string) => { consume?: boolean } | undefined) | undefined;
	const opened: string[] = [];
	try {
		const theme = {
			fg: (_color: string, text: string) => text,
			bold: (text: string) => text,
			bg: (_slot: string, text: string) => text,
		};
		const ui = {
			theme,
			requestRender() {},
			notify() {},
			async custom(factory: any) {
				const host = {
					requestRender() {},
					terminal: { rows: 40, columns: 100 },
				};
				const view = factory?.(host, theme, {}, () => {});
				if (view && typeof view.render === "function") {
					opened.push(view.render(100).join("\n"));
				}
				return undefined;
			},
		} as any;
		const parent = new Container() as any;
		// Three tools so A/B share the same branch prefix (not the last-child └).
		for (const [name, id] of [
			["read", "dup-a"],
			["bash", "dup-b"],
			["grep", "dup-c"],
		] as const) {
			const component = new ToolExecutionComponent(
				name,
				id,
				{},
				{},
				undefined,
				ui,
				process.cwd(),
			) as any;
			component.updateResult({
				content: [{ type: "text", text: "placeholder" }],
				isError: false,
			});
			parent.addChild(component);
		}
		const group = parent.children[0] as any;
		assert.ok(group instanceof ToolGroupComponent);
		group.setExpanded(true);

		const longOut = (tag: string) => `${tag}\n${"line\n".repeat(20)}`;
		const viewA = new ExpandedToolIoView(theme, "", longOut("UNIQUE_A_CONTENT"), false, 2, 2);
		const viewB = new ExpandedToolIoView(theme, "", longOut("UNIQUE_B_CONTENT"), false, 2, 2);
		const childA = group.children[0];
		const childB = group.children[1];
		const childC = group.children[2];
		childA.expanded = true;
		childB.expanded = true;
		childC.expanded = true;
		childA.render = (width: number) => [`✓ child A`, ...viewA.render(Math.max(1, width - 2))];
		childB.render = (width: number) => [`✓ child B`, ...viewB.render(Math.max(1, width - 2))];
		childC.render = () => ["✓ child C", "  └ short"];

		const tui = {
			terminal: { columns: 100, write() {} },
			children: [parent],
			previousLines: [] as string[],
			previousViewportTop: 0,
			requestRender() {},
			doRender() {
				this.previousLines = group.render(100);
			},
		};
		installToolMouseInteraction(
			{
				mode: "tui",
				hasUI: true,
				ui: {
					...ui,
					setWidget(_key: string, factory: any) {
						factory?.(tui, theme);
					},
					onTerminalInput(handler: typeof inputHandler) {
						inputHandler = handler;
						return () => undefined;
					},
				},
			},
			false,
			true,
		);
		tui.doRender();
		assert.ok(
			tui.previousLines.every((line) => !/\x1b_cc:[tv]/.test(line)),
			"markers must not leak into previousLines",
		);
		const showMoreRows = tui.previousLines
			.map((line, index) => (line.includes(SHOW_MORE_LABEL) ? index : -1))
			.filter((index) => index >= 0);
		assert.ok(showMoreRows.length >= 2, "need two identical show-more headers");
		const plainLabels = showMoreRows.map((row) =>
			tui.previousLines[row]
				.replace(/\x1b\[[0-9;]*m/g, "")
				.replace(/\s+/g, " ")
				.trim(),
		);
		assert.equal(plainLabels[0], plainLabels[1], "labels must be text-identical");

		const secondRow = showMoreRows[1];
		const col = tui.previousLines[secondRow].indexOf(SHOW_MORE_LABEL) + 1;
		assert.equal(inputHandler?.(`\x1b[<0;${col};${secondRow + 1}M`)?.consume, true);
		assert.ok(
			opened.some((text) => text.includes("UNIQUE_B_CONTENT")),
			`second show-more must open second body, got ${JSON.stringify(opened)}`,
		);
		assert.ok(
			!opened.some((text) => text.includes("UNIQUE_A_CONTENT")),
			"second show-more must not open first body",
		);
	} finally {
		installToolMouseInteraction({}, false, false);
		grouping.shutdown();
	}
});

test("footer rebuild and fixed toggle do not stack inactive doRender wrappers", async () => {
	const write = process.stdout.write;
	process.stdout.write = (() => true) as typeof process.stdout.write;
	try {
		let baseRenderCalls = 0;
		const tool = {
			toolCallId: "chain-tool",
			expanded: false,
			setExpanded(value: boolean) {
				this.expanded = value;
			},
			invalidate() {},
			render: () => ["✓ Bash(echo ok)", "  └ 1 line (ctrl+o expand / click)"],
		};
		const editor = {
			focused: true,
			getText: () => "",
			setText() {},
			handleInput() {},
			render: () => [`editor\x1b_pi:c\x07`],
			invalidate() {},
		};
		const component = (line: string, children: any[] = []) => ({
			children,
			render: (width: number) =>
				children.length > 0 ? children.flatMap((child) => child.render(width)) : [line],
			invalidate() {},
		});
		const baseDoRender = function (this: any) {
			baseRenderCalls++;
			this.previousLines = [tool.render()[0], tool.render()[1]];
		};
		const tui: any = {
			children: [
				component("status"),
				component("above"),
				component("", [editor]),
				component("below"),
				component("footer"),
				tool,
			],
			focusedComponent: editor,
			previousLines: [] as string[],
			previousViewportTop: 0,
			terminal: {
				columns: 80,
				rows: 24,
				write() {},
			},
			getShowHardwareCursor: () => false,
			requestRender() {},
			handleInput() {},
			render(width: number) {
				return this.children.flatMap((child: any) =>
					typeof child.render === "function" ? child.render(width) : [],
				);
			},
			doRender: baseDoRender,
			addInputListener() {
				return () => {};
			},
			hasOverlay: () => false,
		};

		const inputListeners = new Set<(data: string) => { consume?: boolean } | undefined>();
		const widgets = new Map<string, unknown>();
		const fixedEvents = new Map<string, Function>();
		const controller = installFixedEditor(
			{
				on(name: string, handler: Function) {
					fixedEvents.set(name, handler);
				},
			} as any,
			true,
		);
		const ctx = {
			mode: "tui",
			hasUI: true,
			ui: {
				setFooter() {},
				setWidget(key: string, value: unknown) {
					widgets.set(key, value);
				},
				onTerminalInput(handler: (data: string) => { consume?: boolean } | undefined) {
					inputListeners.add(handler);
					return () => inputListeners.delete(handler);
				},
			},
		};
		// Mirror extension wiring: unwrap before construct, re-wrap after install.
		setBeforeFixedEditorStart(() => {
			installToolMouseInteraction({}, false, false);
		});
		controller.onRebuild(() => {
			installToolMouseInteraction(ctx, true, true);
			const factory = widgets.get("ccstyle-tool-mouse");
			if (typeof factory === "function") {
				factory(tui, { fg: (_c: string, text: string) => text });
			}
		});

		const probeAndPaint = async () => {
			const factory = widgets.get("pi-fixed-editor-probe");
			assert.equal(typeof factory, "function", "fixed-editor probe factory");
			const probe = (factory as Function)(tui, {});
			probe.render(80);
			await Promise.resolve();
			tui.doRender();
		};

		fixedEvents.get("session_start")?.({}, ctx);
		await probeAndPaint();
		for (let i = 0; i < 3; i++) {
			ctx.ui.setFooter();
			await Promise.resolve();
			await probeAndPaint();
		}

		// fixed on → off → on
		controller.setEnabled(false);
		installToolMouseInteraction(ctx, false, true);
		const factoryOff = widgets.get("ccstyle-tool-mouse");
		if (typeof factoryOff === "function") {
			factoryOff(tui, { fg: (_c: string, text: string) => text });
		}
		baseRenderCalls = 0;
		tui.doRender();
		assert.equal(baseRenderCalls, 1, "fixed off: single-level doRender");

		controller.setEnabled(true);
		await probeAndPaint();

		baseRenderCalls = 0;
		tui.doRender();
		assert.equal(baseRenderCalls, 1, "one top-level doRender reaches base renderer once");

		// Hover/click on the live chain after fixed off restores a single wrapper.
		controller.setEnabled(false);
		installToolMouseInteraction(ctx, false, true);
		const factoryNative = widgets.get("ccstyle-tool-mouse");
		if (typeof factoryNative === "function") {
			factoryNative(tui, { fg: (_c: string, text: string) => text });
		}
		baseRenderCalls = 0;
		tui.doRender();
		assert.equal(baseRenderCalls, 1, "fixed off after rebuilds: single-level doRender");
		const hintLine = tui.previousLines.find((line: string) => line.includes("/ click"));
		assert.ok(hintLine);
		const row = tui.previousLines.indexOf(hintLine) + 1;
		const col = hintLine.indexOf("/ click") + 1;
		for (const listener of inputListeners) listener(`\x1b[<0;${col};${row}M`);
		assert.equal(tool.expanded, true);

		fixedEvents.get("session_shutdown")?.({}, ctx);
		baseRenderCalls = 0;
		tui.doRender();
		assert.equal(baseRenderCalls, 1, "dispose restores a single-level doRender");
	} finally {
		process.stdout.write = write;
		setBeforeFixedEditorStart(undefined);
		installToolMouseInteraction({}, false, false);
	}
});
