import assert from "node:assert/strict";
import test from "node:test";

import { existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";

import { ToolExecutionComponent, initTheme } from "@earendil-works/pi-coding-agent";
import { Container, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { createJiti } from "jiti";
import { CONFIG_PATH } from "../extensions/config/config.ts";
import claudeCodeStyleExtension, {
	ExpandedToolIoView,
	installToolMouseInteraction,
	SHOW_MORE_LABEL,
} from "../extensions/renderer/index.ts";
import { installToolGrouping, ToolGroupComponent } from "../extensions/renderer/tool/grouping.ts";
import {
	renderRichToolResult,
	DEFAULT_TOOL_DISPLAY_CONFIG,
} from "../extensions/renderer/tool/diff/index.ts";
import { WriteExecutionMetadataStore } from "../extensions/renderer/tool/diff/write-execution.ts";
import { insetComponent } from "../extensions/renderer/tool/result.ts";

initTheme("dark");

/** 与 interaction 里松开后 50ms 武装双击对齐。 */
function armExpandDoubleClick() {
	return new Promise((resolve) => setTimeout(resolve, 60));
}

test("tool groups expand from their hint and collapse from any expanded group row", async () => {
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
		installToolMouseInteraction({
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
		});
		tui.doRender();
		// regular 模式不启用鼠标上报，提示文本为默认展开快捷键。
		const headerRow = tui.previousLines.findIndex((line: string) => line.includes("to show more"));
		assert.ok(headerRow >= 0);
		const hintColumn = tui.previousLines[headerRow].indexOf("to show more") + 1;
		inputHandler?.(`\x1b[<35;${hintColumn};${headerRow + 1}M`);
		const hoveredHeader = group.render(100)[headerRow];
		assert.match(hoveredHeader, /• \x1b\[37m[^\x1b]*to show more\x1b\[39m/);
		assert.doesNotMatch(hoveredHeader, /\x1b\[37m•/);
		assert.equal(inputHandler?.(`\x1b[<0;${hintColumn};${headerRow + 1}M`)?.consume, true);
		assert.equal(group.expanded, true);

		tui.doRender();
		const bottomPaddingRow = tui.previousLines.length - 1;
		assert.equal(tui.previousLines[bottomPaddingRow].trim(), "");
		assert.equal(inputHandler?.(`\x1b[<0;100;${bottomPaddingRow + 1}M`)?.consume, true);
		assert.equal(group.expanded, true, "single click on expanded group does not collapse");
		inputHandler?.(`\x1b[<0;100;${bottomPaddingRow + 1}m`);
		await armExpandDoubleClick();
		assert.equal(inputHandler?.(`\x1b[<0;100;${bottomPaddingRow + 1}M`)?.consume, true);
		assert.equal(group.expanded, false);
	} finally {
		installToolMouseInteraction({});
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
	installToolMouseInteraction({
		mode: "tui",
		hasUI: true,
		ui: {
			setWidget(_key: string, factory: any) {
				if (typeof factory === "function") factory(tui, { fg: (_c: string, text: string) => text });
			},
			onTerminalInput(handler: typeof inputHandler) {
				inputHandler = handler;
				return () => undefined;
			},
		},
	});
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

	installToolMouseInteraction({});
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
	installToolMouseInteraction({
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
	});
	try {
		tui.doRender();
		inputHandler?.("\x1b[<35;35;2M");
		await new Promise<void>((resolve) => process.nextTick(resolve));
		assert.equal(renderRequests, 1, "hover requests a repaint for white hint text");
		assert.deepEqual(inputHandler?.("\x1b[<0;35;2M"), { consume: true });
		assert.equal(tool.expanded, true);
	} finally {
		installToolMouseInteraction({});
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
	installToolMouseInteraction(interactionCtx);
	// 外部替换 doRender 后重装 wrapper；compact 安装新 wrapper 时不叠加。
	const retainedRender = tui.doRender;
	tui.doRender = function (this: any, ...args: any[]) {
		return Reflect.apply(retainedRender, this, args);
	};
	installToolMouseInteraction(interactionCtx);
	try {
		tui.doRender();
		const footerRow = tui.previousLines.findIndex(
			(line: string) => line.includes("more lines") && line.includes("to show more"),
		);
		assert.ok(footerRow >= 0, "truncated body paints a show-more footer");
		const col = tui.previousLines[footerRow].indexOf("to show more") + 1;
		tui.handleInput(`\x1b[<35;${col};${footerRow + 1}M`);
		assert.match(
			currentView.render(78).find((line) => line.includes("more lines")) ?? "",
			/\x1b\[97m/,
		);
		assert.doesNotMatch(
			staleView.render(78).find((line) => line.includes("more lines")) ?? "",
			/\x1b\[97m/,
		);
	} finally {
		installToolMouseInteraction({});
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
		const childTool = group.children[0] as Component & {
			setExpanded: (value: boolean) => void;
			expanded: boolean;
		};
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
		installToolMouseInteraction({
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
		});
		tui.doRender();
		const showMoreRow = tui.previousLines.findIndex(
			(line: string) => line.includes("more lines") && line.includes("to show more"),
		);
		assert.ok(showMoreRow >= 0, "expanded group must paint a show-more affordance");
		const col = tui.previousLines[showMoreRow].indexOf("to show more") + 1;
		inputHandler?.(`\x1b[<35;${col};${showMoreRow + 1}M`);
		const beforeExpanded = group.expanded;
		assert.equal(inputHandler?.(`\x1b[<0;${col};${showMoreRow + 1}M`)?.consume, true);
		assert.equal(group.expanded, beforeExpanded, "show-more must not collapse the group");
		assert.equal(previewOpened, true, "show-more opens the text preview");
	} finally {
		installToolMouseInteraction({});
		grouping.shutdown();
	}
});

test("collapsed diff card swallows card-wide clicks outside its remainder row", () => {
	// 伪造 pi 0.87 的结果区 MouseRegion：左键 click 整卡 setExpanded。
	const prototype = (ToolExecutionComponent as any).prototype;
	const originalHandleMouse = prototype.handleMouse;
	const delegated: Array<Record<string, unknown>> = [];
	prototype.handleMouse = function (event: any) {
		delegated.push({ type: event?.type, button: event?.button, y: event?.y });
		return { handled: true };
	};
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
		{ args: { path: "a.ts" } },
		new WriteExecutionMetadataStore(),
		{ ...DEFAULT_TOOL_DISPLAY_CONFIG, editDiffCollapsedLines: 2 },
	);
	const result = insetComponent(inner);
	const card: any = {
		toolName: "edit",
		expanded: false,
		resultRendererComponent: result,
		render: (width: number) => ["✓ Edit a.ts", ...result.render(width)],
	};
	const strip = (line: string) => line.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
	const rows = (card.render(80) as string[]).map(strip);
	const bodyRow = rows.findIndex((line: string) => line.includes("2 lines returned"));
	const hintRow = rows.findIndex((line: string) => line.includes("more diff lines"));
	assert.ok(bodyRow >= 0 && hintRow >= 0, "collapsed diff renders body and remainder");
	const tui = {
		terminal: { columns: 80, write() {} },
		mode: "tui",
		requestRender() {},
	};
	try {
		installToolMouseInteraction({
			mode: "tui",
			hasUI: true,
			ui: {
				setWidget(_key: string, factory: any) {
					if (typeof factory === "function") factory(tui, plainTheme);
				},
				onTerminalInput() {
					return () => undefined;
				},
			},
		} as any);

		prototype.handleMouse.call(card, { type: "click", button: "left", y: bodyRow, width: 80 });
		assert.deepEqual(delegated, [], "正文行不能交给官方整卡 toggle");

		prototype.handleMouse.call(card, { type: "click", button: "left", y: hintRow, width: 80 });
		assert.equal(delegated.length, 1, "remainder 行仍走官方 toggle");
		assert.deepEqual(delegated[0], { type: "click", button: "left", y: hintRow });

		prototype.handleMouse.call(card, { type: "wheel", button: "none", y: bodyRow, width: 80 });
		prototype.handleMouse.call(
			{ ...card, expanded: true },
			{ type: "click", button: "left", y: bodyRow, width: 80 },
		);
		assert.equal(delegated.length, 3, "非左键/展开态不拦");
	} finally {
		installToolMouseInteraction({});
		prototype.handleMouse = originalHandleMouse;
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
	installToolMouseInteraction({
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
	});
	try {
		tui.doRender();
		// Screen row 2 = buffer index 3 (visible tool hint): 3 - 2 + 1 = 2.
		const hintCol = tui.previousLines[3].indexOf("/ click") + 1;
		assert.deepEqual(inputHandler?.(`\x1b[<0;${hintCol};2M`), { consume: true });
		assert.equal(expanded, "native-visible");
		assert.equal(offscreen.expanded, false);
	} finally {
		installToolMouseInteraction({});
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
	installToolMouseInteraction({
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
	});
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
		installToolMouseInteraction({});
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
		const childA = group.children[0] as Component & { expanded: boolean };
		const childB = group.children[1] as Component & { expanded: boolean };
		const childC = group.children[2] as Component & { expanded: boolean };
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
		installToolMouseInteraction({
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
		});
		tui.doRender();
		assert.ok(
			tui.previousLines.every((line) => !/\x1b_cc:[tv]/.test(line)),
			"markers must not leak into previousLines",
		);
		const showMoreRows = tui.previousLines
			.map((line, index) =>
				line.includes("more lines") && line.includes("to show more") ? index : -1,
			)
			.filter((index) => index >= 0);
		assert.ok(showMoreRows.length >= 2, "need two identical show-more footers");
		const plainLabels = showMoreRows.map((row) =>
			tui.previousLines[row]
				.replace(/\x1b\[[0-9;]*m/g, "")
				.replace(/\s+/g, " ")
				.trim(),
		);
		assert.equal(plainLabels[0], plainLabels[1], "labels must be text-identical");

		const secondRow = showMoreRows[1];
		const col = tui.previousLines[secondRow].indexOf("to show more") + 1;
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
		installToolMouseInteraction({});
		grouping.shutdown();
	}
});

test("ccstyle mode off restores native mouse input: no hover/click, wheel still scrolls", async () => {
	const inputListeners = new Set<(data: string) => { consume?: boolean } | undefined>();
	const terminalWrites: string[] = [];
	let renderRequests = 0;
	let expandedToolId: string | null = null;
	const contentBox = {
		render() {
			return ["  └ expanded card body"];
		},
	};
	const tool = {
		toolCallId: "tool-1",
		expanded: false,
		contentBox,
		children: [contentBox],
		setExpanded(value: boolean) {
			this.expanded = value;
			if (value) expandedToolId = "tool-1";
			else expandedToolId = null;
		},
		invalidate() {},
		render() {
			return this.expanded
				? ["✓ Bash(echo ok)", ...this.contentBox.render()]
				: ["✓ Bash(echo ok)", "  └ 1 line output (ctrl+o expand / click)"];
		},
	};
	const terminal = {
		columns: 80,
		rows: 24,
		write(data: string) {
			terminalWrites.push(data);
		},
	};
	const tui = {
		terminal,
		children: [tool],
		previousLines: [] as string[],
		previousViewportTop: 0,
		focusedComponent: null as { handleInput(data: string): void } | null,
		requestRender() {
			renderRequests++;
		},
		render(width: number) {
			return this.children.flatMap((child: any) => child.render(width));
		},
		doRender() {
			this.previousLines = this.render(80);
		},
		handleInput(data: string) {
			for (const listener of inputListeners) {
				if (listener(data)?.consume) return;
			}
			this.focusedComponent?.handleInput?.(data);
		},
	};
	const ctx = {
		mode: "tui",
		hasUI: true,
		ui: {
			notify() {},
			setStatus() {},
			setWidget(_key: string, factory: any) {
				factory?.(tui, { fg: (_color: string, text: string) => text });
			},
			onTerminalInput(handler: (data: string) => { consume?: boolean } | undefined) {
				inputListeners.add(handler);
				return () => inputListeners.delete(handler);
			},
		},
	};
	const commands = new Map<string, any>();
	const events = new Map<string, Function>();
	const pi = {
		registerCommand(name: string, options: any) {
			commands.set(name, options);
		},
		registerShortcut() {},
		registerEntryRenderer() {},
		on(name: string, handler: Function) {
			events.set(name, handler);
		},
	};
	try {
		claudeCodeStyleExtension(pi as any);
		const command = commands.get("ccstyle");
		// /ccstyle writes the user's real config; back it up and restore it.
		const savedConfig = existsSync(CONFIG_PATH) ? readFileSync(CONFIG_PATH, "utf8") : null;
		try {
			await events.get("session_start")?.({}, ctx);
			await new Promise<void>((resolve) => setTimeout(resolve, 0));
			tui.doRender();

			const hintLine = tui.previousLines.find((line: string) => line.includes("/ click"));
			assert.ok(hintLine);
			const row = tui.previousLines.indexOf(hintLine) + 1;
			const col = hintLine.indexOf("/ click") + 1;

			// Baseline in on mode: click expands (frame rebuilds), double-click collapses,
			// hover repaints.
			tui.handleInput(`\x1b[<0;${col};${row}M`);
			assert.equal(expandedToolId, "tool-1");
			tui.doRender();
			tui.handleInput(`\x1b[<0;${col};${row}M`);
			assert.equal(expandedToolId, "tool-1", "single click on expanded card does not collapse");
			tui.handleInput(`\x1b[<0;${col};${row}m`);
			await armExpandDoubleClick();
			tui.handleInput(`\x1b[<0;${col};${row}M`);
			assert.equal(expandedToolId, null);
			tui.doRender();
			const rendersBeforeHover = renderRequests;
			tui.handleInput(`\x1b[<35;${col};${row}M`);
			assert.ok(renderRequests > rendersBeforeHover, "hover repaints in on mode");

			// /ccstyle off: hover/click go native, motion reporting stops.
			await command.handler("off", ctx);
			assert.ok(
				terminalWrites.includes("\x1b[?1006l\x1b[?1003l\x1b[?1000l"),
				"off mode fully disables mouse reporting so terminal scrollback wheel scrolling resumes",
			);
			const rendersAfterOff = renderRequests;
			tui.handleInput(`\x1b[<35;${col};${row}M`);
			assert.equal(renderRequests, rendersAfterOff, "off mode: hover has no effect");
			tui.handleInput(`\x1b[<0;${col};${row}M`);
			assert.equal(expandedToolId, null, "off mode: tool click does not expand");
			assert.equal(tool.expanded, false, "off mode: tool stays collapsed");
			let editorInputs = 0;
			tui.focusedComponent = {
				handleInput(data: string) {
					if (data === "\x1b[<65;20;3M") editorInputs++;
				},
			};
			tui.handleInput("\x1b[<65;20;3M");
			assert.equal(editorInputs, 1, "off mode: wheel passes through to native scrolling");
			// No motion re-enable on subsequent paints while off.
			terminalWrites.length = 0;
			tui.doRender();
			assert.ok(
				!terminalWrites.some((write) => write.includes("?1003h")),
				"off mode: paints do not re-enable motion",
			);

			// Back to on: click affordances return.
			await command.handler("on", ctx);
			tui.handleInput(`\x1b[<0;${col};${row}M`);
			assert.equal(expandedToolId, "tool-1", "on mode: tool click expands again");
		} finally {
			if (savedConfig === null) rmSync(CONFIG_PATH, { force: true });
			else writeFileSync(CONFIG_PATH, savedConfig);
		}
	} finally {
		installToolMouseInteraction({});
	}
});
