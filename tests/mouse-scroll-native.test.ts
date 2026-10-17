import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { tmpdir } from "node:os";
import { CustomEditor, initTheme, InteractiveMode } from "@earendil-works/pi-coding-agent";
import {
	Container,
	getKeybindings,
	Input,
	MouseRegion,
	setKeybindings,
	stripTerminalSequences,
	Text,
	truncateToWidth,
} from "@earendil-works/pi-tui";
import { config } from "../extensions/config/config.ts";
import {
	installToolMouseInteraction,
	teardownToolMouseInteraction,
} from "../extensions/renderer/mouse/interaction.ts";
import {
	disposeStickyPromptPatches,
	installStickyPromptFramePatch,
	setStickyPromptTheme,
} from "../extensions/renderer/mouse/sticky-prompt.ts";
import { createLazyProxy } from "./fixtures/lazy-tui.ts";

// Use Pi's actual renderer, chat layout, widget lifecycle and editor presentation.
const hostModule = (path: string) =>
	new URL(path, import.meta.resolve("@earendil-works/pi-coding-agent")).href;
const [
	{ createInteractiveTui },
	{ createChatViewport },
	{ getEditorTheme },
	{ KeybindingsManager },
] = await Promise.all([
	import(hostModule("./modes/interactive/tui-renderer.js")),
	import(hostModule("./modes/interactive/chat-viewport.js")),
	import(hostModule("./modes/interactive/theme/theme.js")),
	import(hostModule("./core/keybindings.js")),
]);
initTheme("dark");

const WIDTH = 80;
const theme = {
	fg: (_color: string, text: string) => `\x1b[37m${text}\x1b[39m`,
	bg: (_color: string, text: string) => `\x1b[44m${text}\x1b[49m`,
};

/** Controlled card geometry with real native MouseRegion press/click dispatch. */
class Card extends Container {
	toolCallId = "native-indicator-underlying-card";
	expanded = false;
	toggles = 0;
	constructor() {
		super();
		this.addChild(
			new MouseRegion(
				{
					render: (width) =>
						Array.from({ length: 80 }, () =>
							truncateToWidth("  ↳ tool output · click to show more", width, ""),
						),
					invalidate() {},
				},
				(event) => {
					if (event.type === "click") this.setExpanded(!this.expanded);
					return event.type === "wheel" ? undefined : { handled: true };
				},
			),
		);
	}
	setExpanded(expanded: boolean) {
		this.expanded = expanded;
		this.toggles++;
	}
}

function realFrame(t: TestContext) {
	const previous = { ...config };
	const bindings = getKeybindings();
	const keybindings = new KeybindingsManager();
	setKeybindings(keybindings);
	config.mode = "on";
	config.scrollButtonMode = "native";
	const terminal: any = {
		columns: WIDTH,
		rows: 12,
		isTTY: true,
		write() {},
		onData: () => () => {},
		setRawMode() {},
		getColorMode: () => "truecolor",
		start() {},
		stop() {},
		showCursor() {},
		hideCursor() {},
	};
	const renderer: any = createInteractiveTui({
		tuiMode: "fullscreen",
		showHardwareCursor: false,
		logDirectory: tmpdir(),
		terminal,
		fullscreenWheelScrollLines: 3,
	});
	const original = renderer.scrollToEndIndicator;
	const originalViewportInput = renderer.handleViewportInput;
	renderer.altScreenActive = true;
	// Deterministic frames, no terminal/timer loop. All layout/compositing/input code is real Pi.
	renderer.requestRender = () => {};
	const tui = createLazyProxy(() => renderer);
	const card = new Card();
	const messages = new Container();
	messages.addChild(card);
	// Minimal host state, not a copied layout: renderWidgets owns the default spacer,
	// and setExtensionWidget owns placement, coexistence and disposal of widgets.
	const host = Object.assign(Object.create(InteractiveMode.prototype), {
		ui: tui,
		widgetContainerAbove: new Container(),
		widgetContainerBelow: new Container(),
		extensionWidgetsAbove: new Map(),
		extensionWidgetsBelow: new Map(),
	});
	host.renderWidgets();
	const editor = new CustomEditor(tui, getEditorTheme(), keybindings, {
		embedWorkingStatus: true,
	});
	const editorContainer = new Container();
	editorContainer.addChild(editor);
	const viewport = createChatViewport({
		document: messages,
		pendingMessages: new Container(),
		status: new Container(),
		widgetsAbove: host.widgetContainerAbove,
		editor: editorContainer,
		widgetsBelow: host.widgetContainerBelow,
		footer: new Container(),
		scrollbar: "always", // Avoid the native auto-scrollbar's hide timer.
	});
	const scroll = viewport.transcript;
	renderer.setLayoutRoot(viewport.root);
	renderer.setFocus(editor);
	const ctx = {
		mode: "tui",
		hasUI: true,
		ui: {
			theme,
			setWidget(key: string, content: any, options?: { placement: "aboveEditor" | "belowEditor" }) {
				host.setExtensionWidget(key, content, options);
			},
			onTerminalInput(handler: (data: string) => any) {
				return renderer.addInputListener(handler);
			},
		},
	};
	const owner = {};
	t.after(() => {
		teardownToolMouseInteraction(owner);
		host.clearExtensionWidgets();
		renderer.stop();
		Object.assign(config, previous);
		setKeybindings(bindings);
	});
	const render = () => {
		renderer.doRender();
		return renderer.getScreenLines() as string[];
	};
	render();
	scroll.scrollTo(10, { disableFollow: true });
	render();
	return {
		renderer,
		tui,
		editor,
		widgetsAbove: host.widgetContainerAbove as Container,
		scroll,
		card,
		ctx,
		owner,
		terminal,
		original,
		originalViewportInput,
		render,
		get widget() {
			return host.extensionWidgetsAbove.get("ccstyle-tool-mouse");
		},
		install() {
			installToolMouseInteraction(ctx, owner);
		},
		packet(code: number, final = "M", rect = renderer.scrollToEndIndicatorRect) {
			assert.ok(rect, "native renderer supplied a hitbox");
			return `\x1b[<${code};${rect.column + 1};${rect.row + 1}${final}`;
		},
	};
}

test("native mode changes only the real native label and preserves host geometry", (t) => {
	const frame = realFrame(t);
	const geometry = () => {
		const lines = frame.render();
		const plain = lines.map(stripTerminalSequences);
		const rect = frame.renderer.scrollToEndIndicatorRect;
		assert.ok(rect);
		const editorRow = plain.findIndex((line) => line.startsWith("──"));
		assert.equal(rect.row, frame.scroll.viewportHeight - 1);
		assert.equal(editorRow - rect.row - 1, 1, "the host spacer remains above the editor");
		assert.equal(plain[rect.row + 1].trim(), "");
		return { lines, rect, editorRow, viewportHeight: frame.scroll.viewportHeight };
	};

	// Unmodified Pi, before the extension installs.
	const baseline = geometry();
	assert.equal(frame.renderer.scrollToEndIndicator, frame.original);
	assert.match(frame.original.call(frame.renderer), /Jump to latest message/);

	frame.install();
	const seeded = geometry();
	assert.deepEqual(frame.widget.render(WIDTH), [], "the lifecycle widget adds no rows");
	assert.deepEqual(frame.widgetsAbove.render(WIDTH), [""], "Pi's Spacer(1) remains installed");
	assert.equal(frame.editor.render(WIDTH).length, 3, "the real editor keeps its three rows");
	assert.match(frame.renderer.scrollToEndIndicator(), /Back to bottom/);
	assert.equal(seeded.rect.row, baseline.rect.row);
	assert.equal(seeded.editorRow, baseline.editorRow);
	assert.equal(seeded.viewportHeight, baseline.viewportHeight);
	assert.deepEqual(
		seeded.lines.filter((_line, row) => row !== seeded.rect.row),
		baseline.lines.filter((_line, row) => row !== baseline.rect.row),
		"only the native indicator row changes",
	);

	config.scrollButtonMode = "dock";
	frame.render();
	assert.equal(
		frame.renderer.scrollToEndIndicator,
		undefined,
		"dock uses main's overlay suppression",
	);
	config.scrollButtonMode = "native";
	assert.deepEqual(frame.render(), seeded.lines);

	config.mode = "off";
	assert.deepEqual(frame.render(), baseline.lines, "ccstyle off restores Pi's original label");
	const originalAfterOff = frame.renderer.scrollToEndIndicator;
	assert.match(originalAfterOff(), /Jump to latest message/);
	config.mode = "on";
	assert.deepEqual(frame.render(), seeded.lines);
	assert.notEqual(frame.renderer.scrollToEndIndicator, originalAfterOff);
	frame.render();
	teardownToolMouseInteraction(frame.owner);
	assert.equal(
		frame.renderer.scrollToEndIndicator,
		originalAfterOff,
		"widget disposal restores only native text",
	);
});

test("native indicator over a collapsed tool hint follows output without expanding the card", (t) => {
	const frame = realFrame(t);
	frame.install();
	frame.render();
	assert.equal(frame.scroll.isFollowingEnd, false);
	assert.equal(frame.card.expanded, false);
	frame.tui.handleViewportInput(frame.packet(0));
	assert.equal(
		frame.card.expanded,
		false,
		"the hidden tool hint must not receive the indicator press",
	);
	assert.equal(frame.card.toggles, 0);
	assert.equal(frame.scroll.isFollowingEnd, true, "Pi receives the press and follows output again");
});

test("native indicator clears a pending card press and still yields to an overlay", (t) => {
	const frame = realFrame(t);
	frame.card.expanded = true;
	frame.install();
	frame.render();
	frame.tui.handleViewportInput("\x1b[<0;2;2M");
	// Cancel Pi's own MouseRegion gesture without passing through the extension wrapper;
	// the extension's pending expanded-card press must still be cleared by indicator input.
	frame.originalViewportInput.call(frame.renderer, "\x1b[O");
	frame.tui.handleViewportInput(frame.packet(0));
	assert.equal(frame.scroll.isFollowingEnd, true);
	frame.tui.handleViewportInput("\x1b[<0;2;2m");
	assert.equal(frame.card.expanded, true, "the indicator does not toggle its underlying card");
	assert.equal(frame.card.toggles, 0, "the earlier card press was cleared before its release");

	frame.scroll.scrollTo(10, { disableFollow: true });
	frame.render();
	const rect = { ...frame.renderer.scrollToEndIndicatorRect };
	const overlayEvents: string[] = [];
	const overlay = new MouseRegion(new Text("overlay", 0, 0), (event) => {
		overlayEvents.push(event.type);
		return { handled: true };
	});
	const handle = frame.renderer.showOverlay(overlay, {
		row: rect.row,
		col: rect.column,
		width: rect.width,
		maxHeight: 1,
	});
	frame.render();
	frame.tui.handleViewportInput(frame.packet(0, "M", rect));
	assert.deepEqual(overlayEvents, ["press"], "the overlay receives the indicator input first");
	assert.equal(frame.scroll.isFollowingEnd, false);
	handle.hide();
});

test("one-row sticky prompt paints after native and wins clicks", (t) => {
	const frame = realFrame(t);
	config.stickyUserMessage = true;
	setStickyPromptTheme(theme);
	assert.equal(installStickyPromptFramePatch(), true);
	t.after(() => {
		disposeStickyPromptPatches();
		setStickyPromptTheme(null);
	});
	frame.card.children.unshift({
		render: () => ["pinned prompt\x1b_cc:p\x07\x1b_cc:P\x07"],
		invalidate() {},
	});
	frame.install();
	frame.terminal.rows =
		1 + frame.editor.render(WIDTH).length + frame.widgetsAbove.render(WIDTH).length;

	frame.scroll.scrollTo(10, { disableFollow: true });
	const lines = frame.render().map(stripTerminalSequences);
	assert.equal(frame.scroll.viewportHeight, 1);
	assert.match(lines[0], /pinned prompt/);
	assert.doesNotMatch(lines[0], /Back to bottom|Jump to latest message/);
	assert.ok(frame.renderer.scrollToEndIndicatorRect);
	assert.match(frame.renderer.scrollToEndIndicator(), /Back to bottom/);
	frame.tui.handleViewportInput(frame.packet(0));
	assert.equal(frame.scroll.scrollTop, 0, "the sticky row handles the overlapping click");
	assert.equal(frame.scroll.isFollowingEnd, false);
});

test("rebound bottom key stays with a focused overlay and only Pi's binding follows output", async (t) => {
	const frame = realFrame(t);
	config.scrollButtonMode = "dock";
	getKeybindings().setUserBindings({ "tui.altScreen.bottom": "end" });
	frame.install();
	const dockRow = () =>
		frame
			.render()
			.map(stripTerminalSequences)
			.find((line) => line.includes("Back to bottom"))
			?.trim();
	const settle = () => new Promise((resolve) => process.nextTick(resolve));
	frame.renderer.handleTerminalInput("\x1b[<64;2;2M"); // Wheel up through the real input chain.
	await settle();
	assert.equal(dockRow(), "[ ↓ Back to bottom · End ]");

	const input = new Input();
	input.setValue("abc");
	input.handleInput("\x1b[H"); // Home: cursor before abc.
	const overlay = frame.renderer.showOverlay(input, { width: 30, maxHeight: 1 });
	frame.render();
	frame.renderer.handleTerminalInput("\x1b[F"); // End
	frame.renderer.handleTerminalInput("z");
	assert.equal(input.getValue(), "abcz", "Pi defers End to the focused overlay input");
	assert.equal(frame.scroll.isFollowingEnd, false, "the transcript underneath does not move");
	overlay.hide();

	frame.renderer.handleTerminalInput("\x1b[1;5F"); // Ctrl+End
	assert.equal(frame.scroll.isFollowingEnd, false, "the old default is not a hidden shortcut");
	frame.renderer.handleTerminalInput("\x1b[F"); // End
	await settle();
	assert.equal(frame.scroll.isFollowingEnd, true, "the rebound key follows output");
	assert.equal(dockRow(), undefined, "the dock row hides at the bottom");
});
