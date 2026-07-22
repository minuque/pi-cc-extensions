import assert from "node:assert/strict";
import test from "node:test";

import claudeCodeStyleExtension from "../../extensions/claude-code-style.ts";

test("tool click uses fixed-editor visible rows without previousViewportTop", async () => {
	const inputListeners = new Set<(data: string) => { consume?: boolean } | undefined>();
	let expandedToolId: string | null = null;
	const createTool = (toolCallId: string, title: string) => ({
		toolCallId,
		expanded: false,
		setExpanded(value: boolean) {
			this.expanded = value;
			if (value) expandedToolId = toolCallId;
		},
		invalidate() {},
		render() {
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
		handleInput() {},
		render: () => ["editor"],
	};
	const status = { render: () => ["status"] };
	const above = { children: [] as any[], render: () => [] as string[] };
	const editorContainer = { children: [editor], render: () => ["editor"] };
	const below = { render: () => ["below"] };
	const footer = { render: () => ["footer"] };
	const terminalPrototype = { get rows() { return 30; } };
	const terminal = Object.assign(Object.create(terminalPrototype), {
		columns: 80,
		write() {},
	});
	Object.defineProperty(terminal, "rows", { configurable: true, get: () => 25 });

	const tui = {
		terminal,
		children: [transcript, status, above, editorContainer, below, footer],
		focusedComponent: editor,
		previousLines: [
			"",
			"✓ Bash(echo ok)",
			"  └ 1 line output (ctrl+o expand / click)",
			...Array(22).fill(""),
		],
		// Zentui retains Pi's cursor bookkeeping value, but previousLines already
		// contains only the fixed editor's visible transcript window.
		previousViewportTop: 17,
		requestRender() {},
		handleInput(data: string) {
			for (const listener of inputListeners) {
				if (listener(data)?.consume) return;
			}
			this.focusedComponent?.handleInput?.(data);
		},
	};
	const ui = {
		setStatus() {},
		setWidget(_key: string, factory: any) {
			if (!factory) return;
			above.children.push(factory(tui, { fg: (_color: string, text: string) => text }));
		},
		onTerminalInput(handler: (data: string) => { consume?: boolean } | undefined) {
			inputListeners.add(handler);
			return () => inputListeners.delete(handler);
		},
	};
	const events = new Map<string, (...args: any[]) => any>();
	const pi = {
		registerCommand() {},
		registerShortcut() {},
		registerTool() {},
		on(name: string, handler: (...args: any[]) => any) {
			events.set(name, handler);
		},
	};

	claudeCodeStyleExtension(pi as any);
	await events.get("session_start")?.({}, { mode: "tui", hasUI: true, ui });
	tui.handleInput("\x1b[<0;20;3M");
	await events.get("session_shutdown")?.({}, { mode: "tui", hasUI: true, ui });

	assert.equal(expandedToolId, "tool-visible");
	assert.equal(offscreenTool.expanded, false);
	assert.equal(visibleTool.expanded, true);
});
