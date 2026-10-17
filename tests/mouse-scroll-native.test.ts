import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import {
	Container,
	getKeybindings,
	MouseRegion,
	ScrollView,
	stripTerminalSequences,
	Text,
	truncateToWidth,
	TuiAltScreen,
	VStack,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { config } from "../extensions/config/config.ts";
import {
	installToolMouseInteraction,
	teardownToolMouseInteraction,
} from "../extensions/renderer/mouse/interaction.ts";
import { noteNewTranscriptItem } from "../extensions/renderer/mouse/scroll.ts";
import { sharedToolHoverState } from "../extensions/renderer/mouse/hover.ts";
import { createLazyProxy } from "./fixtures/lazy-tui.ts";

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
	const bindings = getKeybindings().getUserBindings();
	getKeybindings().setUserBindings({});
	config.mode = "on";
	config.customScrollToEndIndicatorText = custom;
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
	let nativeLabel = "Jump to latest message";
	const original = () => theme.bg("selectedBg", theme.fg("text", ` ↓ ${nativeLabel} · Ctrl+End `));
	const renderer: any = new TuiAltScreen(terminal, false, undefined, {
		mouse: true,
		scrollToEndIndicator: original,
	});
	renderer.altScreenActive = true;
	// Deterministic frames, no terminal/timer loop. All layout/compositing/input code is real Pi.
	renderer.requestRender = () => {};
	const tui = createLazyProxy(() => renderer);
	const card = new Card();
	const messages = new Container();
	messages.addChild(card);
	const scroll = new ScrollView(messages, { follow: "end", primary: true, scrollbar: "always" });
	const widgets = new Container();
	const editor = new Text("> ", 0, 0);
	renderer.setLayoutRoot(
		new VStack([
			{ component: scroll, basis: 0, grow: 1, shrink: 1, minSize: 1 },
			{ component: widgets, basis: "auto", grow: 0, shrink: 0 },
			{ component: editor, basis: "auto", grow: 0, shrink: 0 },
		]),
	);
	let widget: any;
	let input: ((data: string) => any) | undefined;
	const ctx = {
		mode: "tui",
		hasUI: true,
		ui: {
			theme,
			setWidget(_key: string, factory: any) {
				widget?.dispose?.();
				widgets.clear();
				widget = typeof factory === "function" ? factory(tui, theme) : undefined;
				if (widget) widgets.addChild(widget);
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
		renderer.stop();
		Object.assign(config, previous);
		getKeybindings().setUserBindings(bindings);
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
		scroll,
		card,
		ctx,
		owner,
		terminal,
		original,
		render,
		get widget() {
			return widget;
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
				theme.bg("selectedBg", theme.fg("text", " ↓ Back to bottom · Ctrl+End ")),
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

for (const custom of [true, false]) {
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
	frame.scroll.scrollTo(69, { disableFollow: true });
	frame.render();
	frame.tui.handleViewportInput("\x1b[<65;75;5M");
	assertReset();
	awayWithItem();
	(frame.editor as any).handleInput = (data: string) => {
		if (data !== "\r") return;
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

test("real native indicator: stale widget disposal and shutdown leave replacement owner intact", (t) => {
	const frame = realFrame(t);
	frame.install();
	const oldWidget = frame.widget;
	const oldWrapper = frame.renderer.scrollToEndIndicator;
	const owner = {};
	installToolMouseInteraction(frame.ctx, owner);
	const next = frame.renderer.scrollToEndIndicator;
	try {
		oldWidget.dispose();
		oldWidget.render(80);
		teardownToolMouseInteraction(frame.owner);
		assert.equal(frame.renderer.scrollToEndIndicator, next);
		assert.match(next(), /Back to bottom/);
		assert.equal(oldWrapper(), frame.original());
		frame.render();
		frame.tui.handleViewportInput(frame.packet(0));
		assert.equal(frame.scroll.isFollowingEnd, true);
	} finally {
		teardownToolMouseInteraction(owner);
	}
});

test("real native indicator: input reconciliation runs even when the downstream handler throws", (t) => {
	const frame = realFrame(t);
	const original = frame.renderer.handleViewportInput;
	frame.renderer.handleViewportInput = function (this: any, data: string) {
		if (data === "test-follow") {
			this.scrollToBottom();
			throw new Error("downstream failure");
		}
		return Reflect.apply(original, this, [data]);
	};
	frame.install();
	noteNewTranscriptItem();
	assert.match(frame.renderer.scrollToEndIndicator(), /1 new message/);
	assert.throws(() => frame.tui.handleViewportInput("test-follow"), /downstream failure/);
	// Leave follow again before any widget render or native label callback can observe it.
	frame.scroll.scrollTo(10, { disableFollow: true });
	assert.match(frame.renderer.scrollToEndIndicator(), /Back to bottom/);
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
