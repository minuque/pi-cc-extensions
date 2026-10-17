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
	visibleWidth,
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
import { sharedToolHoverState } from "../extensions/renderer/mouse/hover.ts";
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

const theme = {
	fg: (_color: string, text: string) => `\x1b[37m${text}\x1b[39m`,
	bg: (_color: string, text: string) => `\x1b[44m${text}\x1b[49m`,
};

/** Controlled card geometry with real native MouseRegion press/click dispatch. */
class Card extends Container {
	toolCallId = "native-indicator-underlying-card";
	expanded = false;
	toggles = 0;
	mouseEvents: string[] = [];
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
					if (event.type === "wheel") return undefined;
					this.mouseEvents.push(event.type);
					if (event.type === "click") this.setExpanded(!this.expanded);
					return { handled: true };
				},
			),
		);
	}
	setExpanded(expanded: boolean) {
		this.expanded = expanded;
		this.toggles++;
	}
}

function realFrame(t: TestContext, custom = true, width = 80) {
	const previous = { ...config };
	const bindings = getKeybindings();
	const keybindings = new KeybindingsManager();
	setKeybindings(keybindings);
	config.mode = "on";
	config.scrollButtonMode = "native";
	config.customNativeScrollToEndIndicatorText = custom;
	const terminal: any = {
		columns: width,
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
	const nativeIndicator = renderer.scrollToEndIndicator;
	let nativeLabel = "Jump to latest message";
	const original = function (this: any) {
		return nativeIndicator.call(this).replace("Jump to latest message", nativeLabel);
	};
	renderer.scrollToEndIndicator = original;
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
	let input: ((data: string) => any) | undefined;
	const ctx = {
		mode: "tui",
		hasUI: true,
		ui: {
			theme,
			setWidget(key: string, content: any, options?: { placement: "aboveEditor" | "belowEditor" }) {
				host.setExtensionWidget(key, content, options);
			},
			onTerminalInput(handler: typeof input) {
				input = handler;
				const unsubscribe = renderer.addInputListener(handler);
				return () => {
					unsubscribe();
					if (input === handler) input = undefined;
				};
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
		render,
		get widget() {
			return host.extensionWidgetsAbove.get("ccstyle-tool-mouse");
		},
		get input() {
			return input;
		},
		install() {
			installToolMouseInteraction(ctx, owner);
		},
		setLabel(label: string) {
			nativeLabel = label;
		},
		packet(code: number, final = "M", rect = renderer.scrollToEndIndicatorRect) {
			assert.ok(rect, "native renderer supplied a hitbox");
			return `\x1b[<${code};${rect.column + 1};${rect.row + 1}${final}`;
		},
	};
}

for (const width of [1, 8, 20, 80]) {
	test(`real native indicator: identical native compositing/style/viewport at width ${width}`, (t) => {
		const frame = realFrame(t, true, width);
		frame.setLabel("Back to bottom");
		const baseline = frame.render();
		const rect = frame.renderer.scrollToEndIndicatorRect;
		const height = frame.scroll.viewportHeight;
		frame.setLabel("Jump to latest message");
		frame.install();
		assert.deepEqual(frame.widget.render(width), [], "lifecycle widget adds no lines");
		assert.deepEqual(frame.render(), baseline, "only the native compositor paints the indicator");
		assert.equal(frame.scroll.viewportHeight, height, "no dock row steals viewport height");
		assert.deepEqual(
			frame.renderer.scrollToEndIndicatorRect,
			rect,
			"native clipping and hitbox are unchanged",
		);
		assert.ok(frame.render().every((line) => visibleWidth(line) <= width));
		if (width === 80)
			assert.equal(
				frame.renderer.scrollToEndIndicator(),
				frame.original().replace("Jump to latest message", "Back to bottom"),
			);
		frame.renderer.scrollToBottom();
		frame.render();
		assert.equal(
			frame.renderer.scrollToEndIndicatorRect,
			undefined,
			"native visibility follows output",
		);
	});
}

test("real native indicator: preserves the host spacer and vertical geometry for either label setting", (t) => {
	const frame = realFrame(t, false);
	assert.deepEqual(
		frame.widgetsAbove.render(80),
		[""],
		"empty host widgets include one spacer row",
	);
	assert.equal(frame.editor.render(80).length, 3, "real editor has two borders and an input row");
	const geometry = () => {
		const lines = frame.render().map(stripTerminalSequences);
		const rect = frame.renderer.scrollToEndIndicatorRect;
		assert.ok(rect);
		const editorRow = lines.findIndex((line) => line.startsWith("──"));
		assert.equal(
			rect.row,
			frame.scroll.viewportHeight - 1,
			"indicator stays on the last transcript row",
		);
		assert.equal(
			editorRow - rect.row - 1,
			1,
			"host spacer separates the indicator and editor border",
		);
		assert.equal(lines[rect.row + 1].trim(), "", "indicator does not paint the host spacer");
		return {
			transcriptHeight: frame.scroll.viewportHeight,
			indicatorRow: rect.row,
			editorRow,
			dock: lines.slice(rect.row + 1),
		};
	};
	const baseline = geometry();
	frame.install();
	for (const custom of [false, true, false]) {
		config.customNativeScrollToEndIndicatorText = custom;
		assert.deepEqual(geometry(), baseline, "label customization never changes vertical layout");
		assert.deepEqual(
			frame.widgetsAbove.render(80),
			[""],
			"lifecycle widget retains the host spacer",
		);
		assert.ok(
			frame.renderer
				.scrollToEndIndicator()
				.includes(custom ? "Back to bottom" : "Jump to latest message"),
		);
	}
});

for (const custom of [true, false]) {
	test(`real native indicator: remains transcript-anchored above another host widget, custom=${custom}`, (t) => {
		const frame = realFrame(t, custom);
		const initialHeight = frame.scroll.viewportHeight;
		frame.ctx.ui.setWidget("host-widget", ["Above-editor widget", "Second widget line"], {
			placement: "aboveEditor",
		});
		const baseline = frame.render().map(stripTerminalSequences);
		const widgetLines = frame.widgetsAbove.render(80);
		frame.install();
		const lines = frame.render().map(stripTerminalSequences);
		const rect = frame.renderer.scrollToEndIndicatorRect;
		assert.ok(rect);
		assert.equal(
			frame.scroll.viewportHeight,
			initialHeight - 2,
			"only the visible widget takes transcript space",
		);
		assert.equal(
			rect.row,
			frame.scroll.viewportHeight - 1,
			"indicator remains inside the transcript",
		);
		assert.equal(lines.findIndex((line) => line.startsWith("──")) - rect.row - 1, 3);
		assert.deepEqual(
			frame.widgetsAbove.render(80),
			widgetLines,
			"installing the lifecycle widget preserves the existing host widget and spacer",
		);
		assert.deepEqual(
			lines.slice(rect.row + 1),
			baseline.slice(rect.row + 1),
			"native label never paints the dock",
		);
		assert.deepEqual(
			lines.slice(rect.row + 1, rect.row + 4).map((line) => line.trim()),
			["", "Above-editor widget", "Second widget line"],
		);
		assert.ok(lines[rect.row].includes(custom ? "Back to bottom" : "Jump to latest message"));
	});

	for (const expanded of [true, false]) {
		test(`real native indicator: click passes through ${expanded ? "expanded" : "collapsed"} card, custom=${custom}`, (t) => {
			const frame = realFrame(t, custom);
			frame.card.expanded = expanded;
			frame.install();
			frame.render();
			assert.deepEqual(frame.widget.render(80), []);
			if (!custom) assert.equal(frame.renderer.scrollToEndIndicator, frame.original);
			const rect = { ...frame.renderer.scrollToEndIndicatorRect };
			assert.equal(frame.scroll.isFollowingEnd, false);
			frame.tui.handleViewportInput(frame.packet(35));
			assert.equal(
				sharedToolHoverState().toolCallId,
				null,
				"no underlying tool hover on native label",
			);
			frame.tui.handleViewportInput(frame.packet(0));
			assert.equal(frame.scroll.isFollowingEnd, true, "native press scrolls to bottom");
			frame.render();
			assert.equal(frame.renderer.scrollToEndIndicatorRect, undefined);
			frame.tui.handleViewportInput(frame.packet(0, "m", rect));
			assert.equal(
				frame.card.toggles,
				0,
				"release after the native hitbox disappears cannot toggle the card",
			);
			assert.equal(frame.card.expanded, expanded);
			assert.ok(!frame.card.mouseEvents.includes("click"), "no native card click is synthesized");
			frame.scroll.scrollTo(10, { disableFollow: true });
			frame.render();
			if (custom) assert.match(frame.renderer.scrollToEndIndicator(), /Back to bottom/);
		});
	}
}

for (const custom of [true, false]) {
	test(`real scroll modes: dock keeps its row, text and click behavior, native text=${custom}`, (t) => {
		const frame = realFrame(t, custom);
		const nativeHeight = frame.scroll.viewportHeight;
		config.scrollButtonMode = "dock";
		frame.install();
		let lines = frame.render().map(stripTerminalSequences);
		const dockRow = lines.findIndex((line) => line.includes("[ ↓ Back to bottom · Ctrl+End ]"));
		assert.ok(dockRow >= 0);
		assert.equal(
			frame.renderer.scrollToEndIndicatorRect,
			undefined,
			"dock suppresses native overlay",
		);
		assert.equal(frame.scroll.viewportHeight, nativeHeight - 1, "dock retains its dedicated row");
		assert.equal(lines[dockRow - 1].trim(), "", "host spacer remains above dock button");
		assert.equal(
			lines.findIndex((line) => line.startsWith("──")),
			dockRow + 1,
		);
		noteNewTranscriptItem();
		noteNewTranscriptItem();
		const counted = frame.render();
		assert.match(stripTerminalSequences(counted[dockRow]), /\[ ↓ 2 new messages · Ctrl\+End \]/);
		config.customNativeScrollToEndIndicatorText = !custom;
		assert.deepEqual(
			frame.render(),
			counted,
			"native text toggle cannot reset or change dock text",
		);
		config.customNativeScrollToEndIndicatorText = custom;
		lines = frame.render().map(stripTerminalSequences);
		const column = lines[dockRow].indexOf("[ ↓");
		frame.tui.handleViewportInput(`\x1b[<35;${column + 1};${dockRow + 1}M`);
		assert.notEqual(frame.render()[dockRow], counted[dockRow], "dock hover styling is preserved");
		frame.tui.handleViewportInput(`\x1b[<0;${column + 1};${dockRow + 1}M`);
		assert.equal(frame.scroll.isFollowingEnd, true, "dock press scrolls to end");
		frame.render();
		assert.deepEqual(frame.widgetsAbove.render(80), [""], "only the host spacer remains at end");
		assert.equal(frame.scroll.viewportHeight, nativeHeight);
		frame.tui.handleViewportInput(`\x1b[<0;${column + 1};${dockRow + 1}m`);
		assert.equal(frame.card.toggles, 0);
	});

	test(`real scroll modes: switching dock/native/off restores each renderer, native text=${custom}`, (t) => {
		const frame = realFrame(t, custom);
		frame.install();
		const nativeHeight = frame.scroll.viewportHeight;
		for (let cycle = 0; cycle < 2; cycle++) {
			config.scrollButtonMode = "dock";
			assert.match(stripTerminalSequences(frame.render().join("\n")), /\[ ↓ Back to bottom/);
			assert.equal(frame.renderer.scrollToEndIndicatorRect, undefined);
			noteNewTranscriptItem();
			assert.match(stripTerminalSequences(frame.render().join("\n")), /\[ ↓ 1 new message/);
			config.scrollButtonMode = "native";
			const lines = frame.render().map(stripTerminalSequences);
			assert.equal(frame.scroll.viewportHeight, nativeHeight);
			assert.deepEqual(frame.widgetsAbove.render(80), [""]);
			assert.doesNotMatch(lines.join("\n"), /\[ ↓/);
			assert.ok(frame.renderer.scrollToEndIndicatorRect);
			assert.match(
				frame.renderer.scrollToEndIndicator(),
				custom ? /Back to bottom/ : /Jump to latest message/,
			);
			noteNewTranscriptItem();
			assert.match(
				frame.renderer.scrollToEndIndicator(),
				custom ? /1 new message/ : /Jump to latest message/,
			);
		}
		config.scrollButtonMode = "dock";
		frame.render();
		config.mode = "off";
		frame.render();
		assert.deepEqual(frame.widgetsAbove.render(80), [""]);
		assert.equal(frame.renderer.scrollToEndIndicator, frame.original);
		assert.ok(frame.renderer.scrollToEndIndicatorRect);
		config.mode = "on";
		frame.render();
		assert.equal(frame.renderer.scrollToEndIndicatorRect, undefined);
		teardownToolMouseInteraction(frame.owner);
		frame.render();
		assert.equal(frame.renderer.scrollToEndIndicator, frame.original);
		assert.deepEqual(frame.widgetsAbove.render(80), [""]);
		assert.ok(frame.renderer.scrollToEndIndicatorRect);
	});
}

test("real dock indicator: a retained foreign wrapper survives widget rebuilds without duplicate buttons", (t) => {
	const frame = realFrame(t);
	frame.install();
	const installed = frame.renderer.scrollToEndIndicator;
	const foreign = function (this: any) {
		return installed.call(this);
	};
	frame.renderer.scrollToEndIndicator = foreign;
	config.scrollButtonMode = "dock";
	frame.render();
	assert.equal(frame.renderer.scrollToEndIndicatorRect, undefined);
	frame.install(); // session_compact replaces the widget but preserves the foreign callback chain
	const lines = frame.render().map(stripTerminalSequences);
	assert.match(lines.join("\n"), /\[ ↓ Back to bottom/);
	assert.equal(
		frame.renderer.scrollToEndIndicatorRect,
		undefined,
		"native overlay stays suppressed after rebuild",
	);
	config.scrollButtonMode = "native";
	frame.render();
	assert.equal(
		frame.renderer.scrollToEndIndicator,
		foreign,
		"leaving dock restores the foreign callback itself",
	);
	assert.equal(
		foreign.call(frame.renderer),
		frame.original(),
		"native customization does not reclaim a yielded callback",
	);
	config.scrollButtonMode = "dock";
	frame.render();
	assert.equal(frame.renderer.scrollToEndIndicatorRect, undefined);
	teardownToolMouseInteraction(frame.owner);
	assert.equal(frame.renderer.scrollToEndIndicator, foreign);
	assert.equal(foreign.call(frame.renderer), frame.original());
});

test("real dock indicator: temporarily suppresses and restores a replacement native callback", (t) => {
	const frame = realFrame(t);
	frame.install();
	const foreign = () => "another extension's native indicator";
	frame.renderer.scrollToEndIndicator = foreign;
	config.scrollButtonMode = "dock";
	frame.render();
	assert.equal(frame.renderer.scrollToEndIndicatorRect, undefined);
	assert.equal(frame.widget.render(80).length, 1);
	config.scrollButtonMode = "native";
	frame.render();
	assert.equal(frame.renderer.scrollToEndIndicator, foreign);
	assert.deepEqual(frame.widget.render(80), []);
	assert.ok(frame.renderer.scrollToEndIndicatorRect);
	config.scrollButtonMode = "dock";
	frame.render();
	teardownToolMouseInteraction(frame.owner);
	assert.equal(frame.renderer.scrollToEndIndicator, foreign);
});

test("real dock indicator: keyboard, submit and programmatic follow reset the shared count", (t) => {
	const frame = realFrame(t);
	config.scrollButtonMode = "dock";
	frame.install();
	const awayWithItem = () => {
		frame.scroll.scrollTo(10, { disableFollow: true });
		frame.render();
		noteNewTranscriptItem();
		assert.match(stripTerminalSequences(frame.widget.render(80).join("\n")), /1 new message/);
	};
	const assertReset = () => {
		assert.equal(frame.scroll.isFollowingEnd, true);
		frame.render();
		assert.deepEqual(frame.widget.render(80), []);
		frame.scroll.scrollTo(10, { disableFollow: true });
		assert.match(stripTerminalSequences(frame.render().join("\n")), /\[ ↓ Back to bottom/);
	};
	awayWithItem();
	getKeybindings().setUserBindings({ "tui.altScreen.bottom": ["ctrl+j"] });
	frame.renderer.handleTerminalInput("\x1b[1;5F");
	assertReset();
	awayWithItem();
	frame.editor.setText("submit");
	frame.editor.onSubmit = () => {
		frame.renderer.scrollToBottom();
		noteNewTranscriptItem();
	};
	frame.renderer.handleTerminalInput("\r");
	assertReset();
	awayWithItem();
	frame.renderer.scrollToBottom();
	assertReset();
});

test("real native indicator: clears pending custom collapse before native press/release", (t) => {
	const frame = realFrame(t);
	frame.card.expanded = true;
	frame.install();
	frame.render();
	frame.tui.handleViewportInput("\x1b[<0;2;2M");
	assert.equal(frame.card.toggles, 0);
	// Cancel the native component gesture (focus loss), then click the native indicator.
	frame.tui.handleViewportInput("\x1b[O");
	const rect = { ...frame.renderer.scrollToEndIndicatorRect };
	frame.tui.handleViewportInput(frame.packet(0));
	frame.render();
	frame.tui.handleViewportInput(frame.packet(0, "m", rect));
	assert.equal(frame.card.toggles, 0);
	assert.equal(frame.scroll.isFollowingEnd, true);
	// And the next ordinary expanded-card click still works.
	frame.tui.handleViewportInput("\x1b[<0;2;2M");
	frame.tui.handleViewportInput("\x1b[<0;2;2m");
	assert.equal(frame.card.expanded, false);
});

test("real native indicator: reinstallation does not reclaim a foreign callback", (t) => {
	const frame = realFrame(t);
	frame.install();
	const foreign = () => "foreign indicator";
	frame.renderer.scrollToEndIndicator = foreign;
	frame.render();
	for (let i = 0; i < 2; i++) {
		frame.install(); // session_compact rebuilds the widget on the same renderer
		assert.equal(frame.renderer.scrollToEndIndicator, foreign);
		assert.match(stripTerminalSequences(frame.render().join("\n")), /foreign indicator/);
	}
});

for (const custom of [true, false]) {
	test(`real native indicator: dynamically suppressed callback adds no button, custom=${custom}`, (t) => {
		const frame = realFrame(t, custom);
		let text = "";
		frame.renderer.scrollToEndIndicator = () => text;
		const baseline = frame.render();
		assert.equal(frame.renderer.scrollToEndIndicatorRect, undefined);
		frame.install();
		for (const hidden of ["", "\x1b[37m\x1b[39m"]) {
			text = hidden;
			assert.deepEqual(frame.render(), baseline);
			assert.equal(frame.renderer.scrollToEndIndicatorRect, undefined);
		}
		text = "visible native label";
		frame.render();
		assert.ok(frame.renderer.scrollToEndIndicatorRect);
		text = "";
		assert.deepEqual(frame.render(), baseline);
		assert.equal(frame.renderer.scrollToEndIndicatorRect, undefined);
	});

	test(`real native indicator: remains above sticky prompt in a one-row viewport, custom=${custom}`, (t) => {
		const frame = realFrame(t, custom);
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
		// Leave one transcript row without shrinking away the real editor or host spacer.
		frame.terminal.rows =
			1 +
			frame.editor.render(frame.terminal.columns).length +
			frame.widgetsAbove.render(frame.terminal.columns).length;
		const lines = frame.render().map(stripTerminalSequences);
		assert.equal(frame.scroll.viewportHeight, 1);
		assert.match(lines[0], /pinned prompt/);
		assert.ok(lines[0].includes(custom ? "Back to bottom" : "Jump to latest message"));
		assert.ok(frame.renderer.scrollToEndIndicatorRect);
		// The uncovered sticky text still jumps to the prompt, not the transcript bottom.
		frame.tui.handleViewportInput("\x1b[<0;1;1M");
		assert.equal(frame.scroll.scrollTop, 0);
		assert.equal(frame.scroll.isFollowingEnd, false);
		frame.scroll.scrollTo(10, { disableFollow: true });
		frame.render();
		frame.tui.handleViewportInput(frame.packet(0));
		assert.equal(
			frame.scroll.isFollowingEnd,
			true,
			"visible native label keeps native input priority",
		);
		assert.equal(frame.card.toggles, 0);
	});
}

test("real native indicator: counts reset after native keyboard, wheel, submit and programmatic follow", (t) => {
	const frame = realFrame(t);
	frame.install();
	frame.render();
	const awayWithItem = () => {
		frame.scroll.scrollTo(10, { disableFollow: true });
		frame.render();
		noteNewTranscriptItem();
		assert.match(frame.renderer.scrollToEndIndicator(), /1 new message/);
	};
	const assertReset = () => {
		assert.equal(frame.scroll.isFollowingEnd, true);
		frame.render(); // callback not invoked while following, widget still reconciles
		frame.scroll.scrollTo(10, { disableFollow: true });
		frame.render();
		assert.match(frame.renderer.scrollToEndIndicator(), /Back to bottom/);
	};
	awayWithItem();
	getKeybindings().setUserBindings({ "tui.altScreen.bottom": ["ctrl+j"] });
	assert.match(frame.renderer.scrollToEndIndicator(), /Ctrl\+J/);
	assert.equal(frame.input?.("\x1b[8^"), undefined, "no hardcoded Ctrl+End consumption");
	frame.tui.handleViewportInput("\x1b[1;5F");
	assert.equal(frame.scroll.isFollowingEnd, false, "unbound Ctrl+End does not navigate");
	frame.tui.handleViewportInput("\n");
	assertReset();
	awayWithItem();
	frame.scroll.scrollToEnd();
	frame.scroll.scrollBy(-1); // One wheel step reaches the end at any editor/dock height.
	frame.render();
	frame.tui.handleViewportInput("\x1b[<65;75;5M");
	assertReset();
	awayWithItem();
	frame.editor.setText("submit");
	frame.editor.onSubmit = () => {
		frame.renderer.scrollToBottom();
		noteNewTranscriptItem(); // submit bookkeeping occurs after viewport input returns
	};
	frame.renderer.setFocus(frame.editor);
	frame.renderer.handleTerminalInput("\r");
	assertReset();
	awayWithItem();
	frame.renderer.scrollToBottom();
	frame.widget.render(80);
	assertReset();
	awayWithItem();
	frame.install(); // session_start/compaction rebind resets the count
	assert.match(frame.renderer.scrollToEndIndicator(), /Back to bottom/);
	noteNewTranscriptItem();
	noteNewTranscriptItem();
	noteNewTranscriptItem();
	assert.match(frame.renderer.scrollToEndIndicator(), /3 new messages/);
	resetScrollIndicatorCount(); // session_tree
	assert.match(frame.renderer.scrollToEndIndicator(), /Back to bottom/);
	for (const enabled of [false, true, false, true]) {
		config.customNativeScrollToEndIndicatorText = enabled;
		frame.render();
		if (enabled) {
			assert.match(frame.renderer.scrollToEndIndicator(), /Back to bottom/);
			noteNewTranscriptItem();
		} else assert.equal(frame.renderer.scrollToEndIndicator, frame.original);
	}
});

test("real native indicator: native overlay and mouse capture keep precedence", (t) => {
	const frame = realFrame(t, false);
	frame.install();
	frame.render();
	const rect = { ...frame.renderer.scrollToEndIndicatorRect };
	const events: string[] = [];
	const overlay = new MouseRegion(new Text("overlay", 0, 0), (event) => {
		events.push(event.type);
		return { handled: true, capture: event.type === "press" };
	});
	const handle = frame.renderer.showOverlay(overlay, {
		row: rect.row,
		col: rect.column,
		width: rect.width,
		maxHeight: 1,
	});
	frame.render();
	frame.tui.handleViewportInput(frame.packet(0, "M", rect));
	assert.equal(frame.scroll.isFollowingEnd, false, "overlay receives native indicator hit first");
	assert.ok(events.includes("press"));
	handle.hide();
	frame.render();
	frame.tui.handleViewportInput(frame.packet(32, "M", rect));
	frame.tui.handleViewportInput(frame.packet(0, "m", rect));
	assert.equal(
		frame.scroll.isFollowingEnd,
		false,
		"capture survives hidden overlay and wins over indicator",
	);
	assert.ok(events.includes("release"));
	frame.tui.handleViewportInput(frame.packet(0));
	assert.equal(frame.scroll.isFollowingEnd, true, "native button works after capture ends");
});

test("real native indicator: stale factories, widget disposal and shutdown leave replacement owner intact", (t) => {
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
	const owner = {};
	installToolMouseInteraction(frame.ctx, owner);
	const next = frame.renderer.scrollToEndIndicator;
	try {
		assert.deepEqual(staleFactory(frame.tui, theme).render(80), []);
		oldWidget.dispose();
		oldWidget.render(80);
		teardownToolMouseInteraction(frame.owner);
		assert.equal(frame.renderer.scrollToEndIndicator, next);
		assert.match(next(), /Back to bottom/);
		noteNewTranscriptItem();
		assert.match(next(), /1 new message/, "new owner still receives count bookkeeping");
		assert.equal(oldWrapper(), frame.original());
		frame.render();
		frame.tui.handleViewportInput(frame.packet(0));
		assert.equal(frame.scroll.isFollowingEnd, true);
	} finally {
		teardownToolMouseInteraction(owner);
	}
});

test("real native indicator: consecutive bottom/page-up keys reset counts before the next frame", (t) => {
	const frame = realFrame(t);
	frame.install();
	noteNewTranscriptItem();
	assert.match(frame.renderer.scrollToEndIndicator(), /1 new message/);
	frame.tui.handleViewportInput("\x1b[1;5F");
	assert.equal(frame.scroll.isFollowingEnd, true);
	frame.tui.handleViewportInput("\x1b[5~");
	assert.equal(frame.scroll.isFollowingEnd, false);
	frame.render();
	assert.match(frame.renderer.scrollToEndIndicator(), /Back to bottom/);
});

test("real native indicator: live foreign wrappers retain custom text until disposal", (t) => {
	const frame = realFrame(t);
	frame.install();
	const installed = frame.renderer.scrollToEndIndicator;
	const foreign = function (this: any) {
		return `foreign:${installed.call(this)}`;
	};
	frame.renderer.scrollToEndIndicator = foreign;
	frame.render();
	noteNewTranscriptItem();
	assert.match(frame.renderer.scrollToEndIndicator(), /1 new message/);
	assert.equal(frame.renderer.scrollToEndIndicator, foreign);
	config.customNativeScrollToEndIndicatorText = false;
	frame.render();
	noteNewTranscriptItem();
	assert.equal(foreign.call(frame.renderer), `foreign:${frame.original()}`);
	config.customNativeScrollToEndIndicatorText = true;
	frame.render();
	assert.match(foreign.call(frame.renderer), /Back to bottom/);
	assert.equal(frame.renderer.scrollToEndIndicator, foreign, "no rewrapping on option changes");
	teardownToolMouseInteraction(frame.owner);
	assert.equal(frame.renderer.scrollToEndIndicator, foreign);
	assert.equal(foreign.call(frame.renderer), `foreign:${frame.original()}`);
});

test("real native input: restores inherited handlers and deactivates retained foreign chains", (t) => {
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
	assert.equal(frame.card.toggles, 0, "disposed extension must not expand on the native press");
	frame.tui.handleViewportInput("\x1b[<0;22;2m");
	assert.equal(frame.card.toggles, 1, "the retained chain still reaches native click dispatch");
});

test("real native indicator: leaving the sticky prompt for the button clears its hover", (t) => {
	const frame = realFrame(t);
	config.stickyUserMessage = true;
	setStickyPromptTheme({
		...theme,
		fg: (color: string, text: string) => `\x1b[${color === "dim" ? 90 : 37}m${text}\x1b[39m`,
	});
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
	const resting = frame.render()[0];
	frame.tui.handleViewportInput("\x1b[<35;1;1M");
	assert.notEqual(frame.render()[0], resting, "sticky row highlights under pointer");
	frame.tui.handleViewportInput(frame.packet(35));
	assert.equal(frame.render()[0], resting, "sticky row unhighlights over native button");
});

test("real native indicator: mode off restores original text and native input", (t) => {
	const frame = realFrame(t);
	frame.install();
	config.mode = "off";
	frame.render();
	assert.equal(frame.renderer.scrollToEndIndicator, frame.original);
	assert.match(stripTerminalSequences(frame.render().join("\n")), /Jump to latest message/);
	frame.tui.handleViewportInput(frame.packet(0));
	assert.equal(frame.scroll.isFollowingEnd, true);
});
