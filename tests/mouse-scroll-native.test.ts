import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { tmpdir } from "node:os";
import { CustomEditor, initTheme, InteractiveMode } from "@earendil-works/pi-coding-agent";
import {
	Container,
	getKeybindings,
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
	noteNewTranscriptItem,
	resetScrollIndicatorCount,
} from "../extensions/renderer/mouse/scroll.ts";
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

function realFrame(t: TestContext, custom = true) {
	const previous = { ...config };
	const bindings = getKeybindings();
	const keybindings = new KeybindingsManager();
	setKeybindings(keybindings);
	config.mode = "on";
	config.scrollButtonMode = "native";
	config.customNativeScrollToEndIndicatorText = custom;
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

test("native text toggle changes only the real native label and preserves host geometry", (t) => {
	const frame = realFrame(t, false);
	frame.install();
	assert.deepEqual(frame.widget.render(WIDTH), [], "the lifecycle widget adds no rows");
	assert.deepEqual(frame.widgetsAbove.render(WIDTH), [""], "Pi's Spacer(1) remains installed");
	assert.equal(frame.editor.render(WIDTH).length, 3, "the real editor keeps its three rows");

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

	const baseline = geometry();
	assert.equal(frame.renderer.scrollToEndIndicator, frame.original);
	assert.match(frame.original.call(frame.renderer), /Jump to latest message/);

	config.customNativeScrollToEndIndicatorText = true;
	const custom = geometry();
	assert.match(frame.renderer.scrollToEndIndicator(), /Back to bottom/);
	assert.equal(custom.rect.row, baseline.rect.row);
	assert.equal(custom.editorRow, baseline.editorRow);
	assert.equal(custom.viewportHeight, baseline.viewportHeight);
	assert.deepEqual(
		custom.lines.filter((_line, row) => row !== custom.rect.row),
		baseline.lines.filter((_line, row) => row !== baseline.rect.row),
		"only the native indicator row changes",
	);

	config.customNativeScrollToEndIndicatorText = false;
	const restored = geometry();
	assert.equal(frame.renderer.scrollToEndIndicator, frame.original);
	assert.deepEqual(restored.lines, baseline.lines);
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

test("dock to native to off keeps each mode's lifecycle and shared dock state", (t) => {
	const frame = realFrame(t, true);
	const nativeHeight = frame.scroll.viewportHeight;
	config.scrollButtonMode = "dock";
	frame.install();
	let lines = frame.render().map(stripTerminalSequences);
	const dockRow = lines.findIndex((line) => line.includes("[ ↓ Back to bottom · Ctrl+End ]"));
	assert.ok(dockRow >= 0);
	assert.equal(frame.scroll.viewportHeight, nativeHeight - 1, "dock owns one dedicated row");
	assert.equal(frame.renderer.scrollToEndIndicatorRect, undefined);
	assert.equal(lines[dockRow - 1].trim(), "", "the host spacer remains above dock");

	noteNewTranscriptItem();
	noteNewTranscriptItem();
	const counted = frame.render();
	assert.match(stripTerminalSequences(counted[dockRow]), /2 new messages/);
	config.customNativeScrollToEndIndicatorText = false;
	assert.deepEqual(
		frame.render(),
		counted,
		"the native-text option cannot alter dock label or count",
	);
	lines = frame.render().map(stripTerminalSequences);
	const column = lines[dockRow].indexOf("[ ↓");
	frame.tui.handleViewportInput(`\x1b[<0;${column + 1};${dockRow + 1}M`);
	assert.equal(frame.scroll.isFollowingEnd, true, "the dock button still follows the bottom");

	frame.scroll.scrollTo(10, { disableFollow: true });
	config.scrollButtonMode = "native";
	frame.render();
	assert.equal(frame.scroll.viewportHeight, nativeHeight);
	assert.deepEqual(frame.widgetsAbove.render(WIDTH), [""]);
	assert.equal(frame.renderer.scrollToEndIndicator, frame.original);
	assert.match(frame.renderer.scrollToEndIndicator(), /Jump to latest message/);
	config.customNativeScrollToEndIndicatorText = true;
	frame.render();
	assert.match(frame.renderer.scrollToEndIndicator(), /Back to bottom/);

	config.mode = "off";
	frame.render();
	assert.equal(frame.renderer.scrollToEndIndicator, frame.original);
	config.mode = "on";
	frame.render();
	assert.notEqual(frame.renderer.scrollToEndIndicator, frame.original);
	teardownToolMouseInteraction(frame.owner);
	assert.equal(
		frame.renderer.scrollToEndIndicator,
		frame.original,
		"shutdown restores Pi's callback",
	);
	assert.deepEqual(frame.widgetsAbove.render(WIDTH), [""]);
});

test("native count resets between consecutive bottom/page-up input and on explicit reset", (t) => {
	const frame = realFrame(t);
	frame.install();
	noteNewTranscriptItem();
	assert.match(frame.renderer.scrollToEndIndicator(), /1 new message/);
	frame.tui.handleViewportInput("\x1b[1;5F");
	assert.equal(frame.scroll.isFollowingEnd, true);
	frame.tui.handleViewportInput("\x1b[5~");
	assert.equal(frame.scroll.isFollowingEnd, false);
	assert.match(
		frame.renderer.scrollToEndIndicator(),
		/Back to bottom/,
		"the transient bottom state resets the count before another frame",
	);

	noteNewTranscriptItem();
	noteNewTranscriptItem();
	assert.match(frame.renderer.scrollToEndIndicator(), /2 new messages/);
	resetScrollIndicatorCount();
	assert.match(frame.renderer.scrollToEndIndicator(), /Back to bottom/);
});

test("one-row sticky prompt paints after native and wins clicks for either text setting", (t) => {
	const frame = realFrame(t, false);
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

	for (const custom of [false, true]) {
		config.customNativeScrollToEndIndicatorText = custom;
		frame.scroll.scrollTo(10, { disableFollow: true });
		const lines = frame.render().map(stripTerminalSequences);
		assert.equal(frame.scroll.viewportHeight, 1);
		assert.match(lines[0], /pinned prompt/);
		assert.doesNotMatch(lines[0], /Back to bottom|Jump to latest message/);
		assert.ok(frame.renderer.scrollToEndIndicatorRect);
		assert.match(
			frame.renderer.scrollToEndIndicator(),
			custom ? /Back to bottom/ : /Jump to latest message/,
		);
		frame.tui.handleViewportInput(frame.packet(0));
		assert.equal(frame.scroll.scrollTop, 0, "the sticky row handles the overlapping click");
		assert.equal(frame.scroll.isFollowingEnd, false);
	}
});

test("stale factories, widgets, and owners cannot dispose a replacement installation", (t) => {
	const frame = realFrame(t);
	const setWidget = frame.ctx.ui.setWidget;
	let staleFactory: any;
	frame.ctx.ui.setWidget = (key, factory) => {
		if (typeof factory === "function") staleFactory ??= factory;
		setWidget(key, factory);
	};
	frame.install();
	const oldWidget = frame.widget;
	const oldWrapper = frame.renderer.scrollToEndIndicator;
	const replacementOwner = {};
	installToolMouseInteraction(frame.ctx, replacementOwner);
	const replacement = frame.renderer.scrollToEndIndicator;
	try {
		assert.deepEqual(staleFactory(frame.tui, theme).render(WIDTH), []);
		oldWidget.dispose();
		oldWidget.render(WIDTH);
		teardownToolMouseInteraction(frame.owner);
		assert.equal(frame.renderer.scrollToEndIndicator, replacement);
		assert.match(replacement(), /Back to bottom/);
		noteNewTranscriptItem();
		assert.match(replacement(), /1 new message/);
		assert.equal(oldWrapper(), frame.original.call(frame.renderer));
		frame.render();
		frame.tui.handleViewportInput(frame.packet(0));
		assert.equal(frame.scroll.isFollowingEnd, true);
	} finally {
		teardownToolMouseInteraction(replacementOwner);
	}
});

test("dispose restores inherited input while a retained foreign chain stays native", (t) => {
	const frame = realFrame(t);
	const original = frame.renderer.handleViewportInput;
	assert.equal(Object.hasOwn(frame.renderer, "handleViewportInput"), false);
	frame.install();
	teardownToolMouseInteraction(frame.owner);
	assert.equal(Object.hasOwn(frame.renderer, "handleViewportInput"), false);
	assert.equal(frame.renderer.handleViewportInput, original);

	frame.install();
	const installed = frame.renderer.handleViewportInput;
	const foreign = function (this: any, data: string) {
		return installed.call(this, data);
	};
	frame.renderer.handleViewportInput = foreign;
	teardownToolMouseInteraction(frame.owner);
	assert.equal(frame.renderer.handleViewportInput, foreign);
	frame.render();
	frame.tui.handleViewportInput("\x1b[<0;22;2M");
	assert.equal(frame.card.toggles, 0, "disposed extension no longer expands on press");
	frame.tui.handleViewportInput("\x1b[<0;22;2m");
	assert.equal(
		frame.card.toggles,
		1,
		"the retained chain still reaches Pi's native click dispatch",
	);
});

test("retained foreign native wrapper survives dock widget reinstall and shutdown", (t) => {
	const frame = realFrame(t);
	frame.install();
	const installed = frame.renderer.scrollToEndIndicator;
	const foreign = function (this: any) {
		return installed.call(this);
	};
	frame.renderer.scrollToEndIndicator = foreign;
	config.scrollButtonMode = "dock";
	frame.render();
	frame.install(); // session compaction rebuilds the widget and adapter
	const dock = frame.render().map(stripTerminalSequences).join("\n");
	assert.equal((dock.match(/\[ ↓ Back to bottom · Ctrl\+End \]/g) ?? []).length, 1);
	assert.equal(frame.renderer.scrollToEndIndicatorRect, undefined, "only dock remains visible");

	config.scrollButtonMode = "native";
	frame.render();
	assert.equal(frame.renderer.scrollToEndIndicator, foreign);
	assert.equal(foreign.call(frame.renderer), frame.original.call(frame.renderer));
	config.scrollButtonMode = "dock";
	frame.render();
	assert.equal(frame.renderer.scrollToEndIndicatorRect, undefined);
	teardownToolMouseInteraction(frame.owner);
	assert.equal(frame.renderer.scrollToEndIndicator, foreign);
	assert.equal(foreign.call(frame.renderer), frame.original.call(frame.renderer));
});

test("concatenated tool and native-indicator presses are dispatched in order", (t) => {
	const frame = realFrame(t);
	frame.install();
	frame.render();
	assert.equal(frame.card.expanded, false);
	assert.equal(frame.scroll.isFollowingEnd, false);
	const toolPress = "\x1b[<0;22;2M";
	const indicatorPress = frame.packet(0);
	frame.tui.handleViewportInput(toolPress + indicatorPress);
	assert.equal(frame.card.expanded, true, "the first packet expands the collapsed tool");
	assert.equal(frame.scroll.isFollowingEnd, true, "the second packet follows the viewport bottom");
});
