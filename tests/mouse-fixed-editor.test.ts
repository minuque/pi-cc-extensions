import assert from "node:assert/strict";
import test from "node:test";

import claudeCodeStyleExtension from "../extensions/claude-code-style.ts";

test("tool click uses fixed-editor visible rows without previousViewportTop", async () => {
	const inputListeners = new Set<(data: string) => { consume?: boolean } | undefined>();
	let expandedToolId: string | null = null;
	let editorInputCount = 0;
	const renderRequests: unknown[] = [];
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
		handleInput() { editorInputCount++; },
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
		// Zentui exposes only the three-row visible transcript window here.
		previousLines: [
			"",
			"✓ Bash(echo ok)",
			"  └ 1 line output (ctrl+o expand / click)",
		],
		// previousViewportTop is unrelated cursor bookkeeping.
		previousViewportTop: 17,
		requestRender(force?: boolean) { renderRequests.push(force); },
		handleInput(data: string) {
			if (data === "\x1b[5;9~" && transcript.children.length > 0) {
				this.previousLines = ["", "✓ Bash(echo old)", "  └ 1 line output (ctrl+o expand / click)"];
			} else if (data === "\x1b[6~" && transcript.children.length > 0) {
				this.previousLines = ["", "✓ Bash(echo ok)", "  └ 1 line output (ctrl+o expand / click)"];
			}
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
			scrollButton = factory(tui, { fg: (_color: string, text: string) => text });
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

	claudeCodeStyleExtension(pi as any);
	await events.get("session_start")?.({}, { mode: "tui", hasUI: true, ui });
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
