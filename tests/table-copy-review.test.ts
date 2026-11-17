import assert from "node:assert/strict";
import test from "node:test";
import { AssistantMessageComponent, initTheme } from "@earendil-works/pi-coding-agent";
import {
	HStack,
	Markdown,
	Text,
	TuiAltScreen,
	sliceByColumn,
	stripTerminalSequences,
	visibleWidth,
} from "@earendil-works/pi-tui";
import {
	clearTableCopyHover,
	installTableCopy,
	retainTableCopyHover,
	type TableCopyInstallation,
} from "../extensions/renderer/table-copy.ts";
import { applyFullscreenHover } from "../extensions/renderer/mouse/hover.ts";

initTheme("dark");

const ACTIONS = Symbol.for("pi.ccstyle.markdown-table-copy.actions");
const TABLE = "| A | B |\n| --- | --- |\n| one | two |";
const identity = (text: string) => text;
const theme = Object.fromEntries(
	[
		"heading",
		"link",
		"linkUrl",
		"code",
		"codeBlock",
		"codeBlockBorder",
		"quote",
		"quoteBorder",
		"hr",
		"listBullet",
		"bold",
		"italic",
		"strikethrough",
		"underline",
	].map((key) => [key, identity]),
) as any;
const paint = (color: "dim" | "text", text: string) =>
	`\x1b[38;5;${color === "dim" ? 244 : 252}m${text}\x1b[39m`;

interface State {
	hits: Array<{ y: number; start: number; end: number; format: string }>;
	hover?: { y: number; format: string };
}

function state(component: unknown): State | undefined {
	return (component as any)?.[ACTIONS];
}

function assistant(source: string, installation: TableCopyInstallation): AssistantMessageComponent {
	const message = {
		role: "assistant",
		content: [{ type: "text", text: source }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "review-probe",
		timestamp: 1,
		stopReason: "stop",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	} as any;
	return new AssistantMessageComponent(message, false, theme, "", 1, [
		(text: string, context: any) => {
			installation.noteSource(context);
			return text;
		},
	]);
}

function markdown(source: string, installation?: TableCopyInstallation): Markdown {
	return new Markdown(
		source,
		0,
		0,
		theme,
		undefined,
		installation
			? {
					transform: (text, availableWidth) => {
						installation.noteSource({
							messageType: "assistant",
							availableWidth,
							isStreaming: false,
						});
						return text;
					},
				}
			: undefined,
	);
}

/** Real fullscreen screen with a working resize callback and captured clipboard. */
function screen(options: { columns?: number; rows?: number } = {}) {
	const copies: string[] = [];
	const selected: string[] = [];
	const notices: string[] = [];
	const diagnostics: string[] = [];
	let onResize: (() => void) | undefined;
	const terminal = {
		columns: options.columns ?? 80,
		rows: options.rows ?? 30,
		kittyProtocolActive: false,
		start(_input: unknown, resize: () => void) {
			onResize = resize;
		},
		stop() {},
		drainInput: async () => {},
		write() {},
		moveBy() {},
		hideCursor() {},
		showCursor() {},
		clearLine() {},
		clearFromCursor() {},
		clearScreen() {},
		setTitle() {},
		setProgress() {},
		setProgramStatus() {},
	};
	const tui = new TuiAltScreen(terminal, false, undefined, {
		copySelection: async (text) => {
			selected.push(text);
			return true;
		},
	});
	const installation = installTableCopy({
		tui,
		paint,
		copy: async (text) => {
			copies.push(text);
		},
		notify: (message) => {
			notices.push(message);
		},
		debug: (message) => {
			diagnostics.push(message);
		},
	});
	const render = () => {
		(tui as any).doRender();
		return tui.getScreenLines();
	};
	const send = (type: "press" | "release" | "move", x: number, y: number) => {
		const code = type === "move" ? 35 : 0;
		(tui as any).handleViewportInput(
			`\x1b[<${code};${x + 1};${y + 1}${type === "release" ? "m" : "M"}`,
		);
	};
	return {
		tui,
		installation,
		copies,
		selected,
		notices,
		diagnostics,
		render,
		send,
		add(component: unknown) {
			tui.addChild(component as any);
			tui.start();
			render();
		},
		resize(columns: number) {
			terminal.columns = columns;
			onResize?.();
			render();
		},
		plain() {
			return render().map(stripTerminalSequences);
		},
		litRows() {
			const lit = paint("text", "[").replace(/\x1b\[39m$/, "");
			return render().flatMap((line, y) => (line.includes(lit) ? [y] : []));
		},
		/** Drive Pi's own selection state: HStack child hit boxes are the host's, not ours. */
		async select(start: { x: number; y: number }, end: { x: number; y: number }) {
			tui.resetTextSelection();
			(tui as any).selectionAnchor = { row: start.y, col: start.x };
			(tui as any).selectionFocus = { row: end.y, col: end.x };
			render();
			await tui.copyActiveSelectionToClipboard();
			await settle();
			render();
		},
		async drag(start: { x: number; y: number }, end: { x: number; y: number }) {
			tui.resetTextSelection();
			send("press", start.x, start.y);
			(tui as any).handleViewportInput(`\x1b[<32;${end.x + 1};${end.y + 1}M`);
			render();
			send("release", end.x, end.y);
			await new Promise((resolve) => setImmediate(resolve));
			render();
		},
		dispose() {
			tui.stop();
			installation.dispose();
		},
	};
}

async function settle(): Promise<void> {
	await new Promise((resolve) => setImmediate(resolve));
}

test("a resize between press and release never copies a different format", async () => {
	const host = screen();
	try {
		const component = assistant(TABLE, host.installation);
		host.add(component);
		const before = host.plain();
		const y = before.findIndex((line) => line.includes("[Copy CSV]"));
		const x = before[y]!.indexOf("[Copy CSV]") + "[Copy CSV]".length - 1;
		host.send("press", x, y);
		host.resize(40);
		const after = host.plain();
		assert.ok(
			after[y]!.includes("[Copy Markdown]"),
			"reflow moved another button under the pointer",
		);
		host.send("release", x, y);
		await settle();
		assert.deepEqual(
			host.copies,
			[],
			"the pressed format is gone: cancel instead of copying Markdown",
		);
		assert.deepEqual(host.notices, []);
	} finally {
		host.dispose();
	}
});

test("an unchanged layout still copies after press, including a streaming redraw", async () => {
	const host = screen();
	try {
		const component = assistant(TABLE, host.installation);
		host.add(component);
		const rows = host.plain();
		const y = rows.findIndex((line) => line.includes("[Copy CSV]"));
		const x = rows[y]!.indexOf("[Copy CSV]") + 2;
		host.send("press", x, y);
		// A streaming update repaints the same geometry while the button is held.
		component.updateContent({
			...(component as any).message,
			content: [{ type: "text", text: `${TABLE}\n\nStreaming tail` }],
		} as any);
		host.render();
		host.send("release", x, y);
		await settle();
		assert.deepEqual(host.copies, ["A,B\none,two"]);
		assert.deepEqual(host.notices, ["Copied table as CSV"]);
	} finally {
		host.dispose();
	}
});

test("selection keeps a neighbouring column that shares the action row", async () => {
	const host = screen();
	try {
		const left = assistant(TABLE, host.installation);
		const right = new Text(Array.from({ length: 12 }, (_v, i) => `Right${i}`).join("\n"), 0, 0);
		host.add(
			new HStack(
				[
					{ component: left, basis: 40, grow: 0, shrink: 0 },
					{ component: right, basis: 40, grow: 0, shrink: 0 },
				],
				{ gap: 0, align: "start" },
			),
		);
		const rows = host.plain();
		const y = rows.findIndex((line) => line.includes("[Copy TSV]"));
		const x = rows[y]!.indexOf("Right");
		assert.ok(y >= 0 && x > 0, "action row and neighbour text share one screen row");
		const expected = rows[y]!.slice(x).trimEnd();
		await host.select({ x, y }, { x: x + expected.length - 1, y });
		assert.deepEqual(host.selected, [expected], "unrelated column text stays selectable");
		const highlighted = host.render()[y]!;
		assert.match(highlighted, /\x1b\[7m/, "neighbour keeps its selection highlight");
		assert.ok(
			!stripTerminalSequences(sliceByColumn(highlighted, 0, x, true)).includes("Right"),
			"only the neighbour range is highlighted",
		);
		const selectedColumns = highlighted.includes(paint("text", "[Copy")) ? "lit" : "dim";
		assert.equal(selectedColumns, "dim", "buttons are never highlighted by the neighbour drag");
	} finally {
		host.dispose();
	}
});

test("a full-width drag still drops generated buttons but keeps neighbour text", async () => {
	const host = screen();
	try {
		const left = assistant(TABLE, host.installation);
		const right = new Text(Array.from({ length: 12 }, (_v, i) => `Right${i}`).join("\n"), 0, 0);
		host.add(
			new HStack(
				[
					{ component: left, basis: 40, grow: 0, shrink: 0 },
					{ component: right, basis: 40, grow: 0, shrink: 0 },
				],
				{ gap: 0, align: "start" },
			),
		);
		const rows = host.plain();
		const y = rows.findIndex((line) => line.includes("[Copy TSV]"));
		const expected = rows[y]!.slice(rows[y]!.indexOf("Right")).trimEnd();
		await host.select({ x: 0, y }, { x: 70, y });
		assert.equal(host.selected.length, 1);
		assert.ok(host.selected[0]!.includes(expected));
		assert.doesNotMatch(host.selected[0]!, /Copy TSV|Copy CSV|Copy Markdown/);
	} finally {
		host.dispose();
	}
});

test("quoted action rows stay unselectable without leaving border-only lines", async () => {
	const host = screen({ columns: 14 });
	try {
		host.add(assistant(`> ${TABLE.replaceAll("\n", "\n> ")}\n\nTail`, host.installation));
		const rows = host.plain();
		const y = rows.findIndex((line) => line.trimStart().startsWith("Tail"));
		assert.ok(y > 0);
		await host.select({ x: 0, y: 0 }, { x: rows[y]!.trimEnd().length - 1, y });
		assert.equal(host.selected.length, 1);
		assert.ok(host.selected[0]!.endsWith("Tail"));
		assert.doesNotMatch(host.selected[0]!, /\[TSV\]|\[CSV\]|\[MD\]/);
		const borderOnly = host.selected[0]!.split("\n").filter(
			(line) => line.length > 0 && /^[\s│]+$/.test(line),
		);
		assert.deepEqual(borderOnly, [], "no border-only remnant of a generated action row");
	} finally {
		host.dispose();
	}
});

test("a cached foreign renderTable array is never mutated, leaked or accumulated", () => {
	const proto = Markdown.prototype as any;
	const native = proto.renderTable;
	const cache = new Map<string, string[]>();
	let calls = 0;
	proto.renderTable = function (token: any, width: number, next: unknown, style: unknown) {
		const key = JSON.stringify([token.raw, width, next]);
		if (!cache.has(key)) {
			calls++;
			cache.set(key, native.call(this, token, width, next, style));
		}
		return cache.get(key)!;
	};
	const diagnostics: string[] = [];
	const installation = installTableCopy({
		tui: { mode: "fullscreen" },
		paint,
		copy: async () => {},
		notify() {},
		debug: (message) => {
			diagnostics.push(message);
		},
	});
	try {
		const owner = markdown(TABLE, installation);
		owner.render(80);
		const preview = markdown(TABLE).render(80).map(stripTerminalSequences).join("\n");
		assert.doesNotMatch(preview, /Copy TSV/, "untyped preview must not inherit cached buttons");
		const counts: number[] = [];
		for (let pass = 0; pass < 3; pass++) {
			owner.invalidate();
			const lines = owner.render(80).map(stripTerminalSequences);
			counts.push(lines.filter((line) => line.includes("[Copy TSV]")).length);
		}
		assert.deepEqual(counts, [1, 1, 1], "no accumulation across invalidations");
		assert.equal(state(owner)?.hits.length, 3);
		assert.equal(calls, 1, "the foreign cache really was reused");
		assert.deepEqual(diagnostics, []);
	} finally {
		installation.dispose();
		proto.renderTable = native;
	}
});

test("a frozen foreign renderTable result renders instead of throwing", () => {
	const proto = Markdown.prototype as any;
	const native = proto.renderTable;
	proto.renderTable = function (...args: unknown[]) {
		return Object.freeze(native.apply(this, args));
	};
	const installation = installTableCopy({
		tui: { mode: "fullscreen" },
		paint,
		copy: async () => {},
		notify() {},
		debug() {},
	});
	try {
		const lines = markdown(TABLE, installation).render(80).map(stripTerminalSequences);
		assert.ok(lines.some((line) => line.includes("[Copy TSV]")));
	} finally {
		installation.dispose();
		proto.renderTable = native;
	}
});

test("only one assistant body keeps a lit action, and leaving the leaf clears it", () => {
	const host = screen();
	try {
		const first = assistant(TABLE, host.installation);
		const second = assistant(TABLE, host.installation);
		host.add(first);
		host.tui.addChild(second);
		host.tui.addChild(new Text("Editor placeholder", 0, 0));
		host.render();
		const rows = host.plain();
		const actionRows = rows.flatMap((line, y) => (line.includes("[Copy TSV]") ? [y] : []));
		assert.equal(actionRows.length, 2);
		const firstBody = (first as any).contentContainer.children.find(
			(child: unknown) => child instanceof Markdown,
		);
		const secondBody = (second as any).contentContainer.children.find(
			(child: unknown) => child instanceof Markdown,
		);

		host.send("move", 2, actionRows[0]!);
		host.render();
		host.send("move", 2, actionRows[1]!);
		host.render();
		assert.deepEqual(
			host.litRows(),
			[actionRows[1]],
			"the previous reply dims when another action is hovered",
		);

		// The mouse layer arbitrates by leaf component: same leaf keeps the light,
		// a different leaf (or no leaf) clears it without waiting for a Markdown event.
		assert.equal(retainTableCopyHover(secondBody), false);
		assert.deepEqual(host.litRows(), [actionRows[1]]);
		assert.equal(retainTableCopyHover(firstBody), true);
		assert.deepEqual(host.litRows(), []);

		host.send("move", 2, actionRows[0]!);
		host.render();
		assert.deepEqual(host.litRows(), [actionRows[0]]);
		applyFullscreenHover(host.tui, null, undefined);
		assert.deepEqual(host.litRows(), [], "pointer outside the transcript clears the action");
		assert.equal(clearTableCopyHover(), false, "clearing twice is a no-op");
	} finally {
		host.dispose();
	}
});

test("a stationary pointer loses hover when a resize moves the labels", () => {
	const host = screen();
	try {
		const component = assistant(TABLE, host.installation);
		host.add(component);
		const rows = host.plain();
		const y = rows.findIndex((line) => line.includes("[Copy TSV]"));
		const x = rows[y]!.indexOf("[Copy TSV]") + "[Copy TSV]".length - 1;
		host.send("move", x, y);
		host.render();
		assert.deepEqual(host.litRows(), [y]);
		host.resize(14);
		assert.deepEqual(host.litRows(), [], "compact labels no longer sit under the pointer");
		assert.equal(
			state(
				(component as any).contentContainer.children.find((c: unknown) => c instanceof Markdown),
			)?.hover,
			undefined,
		);
	} finally {
		host.dispose();
	}
});

test("hover survives a resize that keeps the button under the pointer", () => {
	const host = screen();
	try {
		host.add(assistant(TABLE, host.installation));
		const rows = host.plain();
		const y = rows.findIndex((line) => line.includes("[Copy TSV]"));
		host.send("move", 2, y);
		host.render();
		host.resize(60);
		assert.deepEqual(host.litRows(), [y], "same geometry keeps the hover");
	} finally {
		host.dispose();
	}
});

test("emptying a body clears actions without a false incompatibility report", () => {
	const diagnostics: string[] = [];
	const installation = installTableCopy({
		tui: { mode: "fullscreen" },
		paint,
		copy: async () => {},
		notify() {},
		debug: (message) => {
			diagnostics.push(message);
		},
	});
	try {
		const component = markdown(TABLE, installation);
		component.render(80);
		component.setText("");
		assert.deepEqual(component.render(80), []);
		assert.deepEqual(state(component)?.hits, []);
		assert.deepEqual(diagnostics, [], "an empty body is not a Pi incompatibility");
		component.setText(TABLE);
		component.render(80);
		assert.equal(state(component)?.hits.length, 3, "actions return when the table comes back");
		assert.deepEqual(diagnostics, []);
	} finally {
		installation.dispose();
	}
});

test("an enclosing leaf keeps the lit action so dense motion never repaints", () => {
	const host = screen();
	try {
		const component = assistant(TABLE, host.installation);
		host.add(component);
		const rows = host.plain();
		const y = rows.findIndex((line) => line.includes("[Copy TSV]"));
		host.send("move", 2, y);
		host.render();
		assert.deepEqual(host.litRows(), [y]);
		const body = (component as any).contentContainer.children.find(
			(child: unknown) => child instanceof Markdown,
		);
		let clears = 0;
		const nativeClear = (body as any).clearRenderCache;
		(body as any).clearRenderCache = function (this: unknown) {
			clears++;
			return nativeClear.call(this);
		};
		try {
			// Compact panels and OSC-8 rows resolve to an enclosing component, not the
			// Markdown body: repeated motion must not clear and relight the button.
			for (let pass = 0; pass < 5; pass++) {
				assert.equal(retainTableCopyHover(component), false, "ancestor keeps ownership");
				assert.equal(retainTableCopyHover((component as any).contentContainer), false);
			}
			assert.equal(clears, 0, "no repaint churn while the pointer stays on the button");
			assert.deepEqual(host.litRows(), [y]);
			// A verified ancestor is remembered, so later motions skip the tree walk.
			let visited = 0;
			const container = (component as any).contentContainer;
			const children = Object.getOwnPropertyDescriptor(container, "children");
			Object.defineProperty(container, "children", {
				configurable: true,
				get() {
					visited++;
					return children?.value;
				},
			});
			try {
				for (let pass = 0; pass < 5; pass++) retainTableCopyHover(container);
				assert.equal(visited, 0, "dense motion over one leaf does not re-walk the subtree");
			} finally {
				if (children) Object.defineProperty(container, "children", children);
				else delete (container as any).children;
			}
			assert.equal(retainTableCopyHover(new Text("unrelated", 0, 0)), true);
			assert.deepEqual(host.litRows(), []);
		} finally {
			(body as any).clearRenderCache = nativeClear;
		}
	} finally {
		host.dispose();
	}
});

test("a clipped trailing marker still keeps the label out of the selection", () => {
	const host = screen();
	try {
		const component = assistant(TABLE, host.installation);
		host.add(component);
		const body = (component as any).contentContainer.children.find(
			(child: unknown) => child instanceof Markdown,
		) as Markdown;
		const rendered = body.render(80).find((line) => line.includes("[Copy TSV]"))!;
		const actionMarker = /\x1b_pi:ccstyle-table-copy:[^\x1b]*action:tsv\x1b\\/.exec(rendered)![0];
		// Compositing may cut the row after the label, dropping the end marker.
		const clipped = `${actionMarker}[Copy TSV]   Neighbour`;
		const selection = {
			start: { row: 0, col: 0 },
			end: { row: 0, col: visibleWidth(clipped), boundary: true },
		};
		const columns = (host.tui as any).getSelectionColumns(clipped, 0, selection);
		const kept = stripTerminalSequences(
			sliceByColumn(clipped, columns.start, columns.end - columns.start, true),
		);
		assert.doesNotMatch(kept, /Copy TSV/);
		assert.match(kept, /Neighbour/);
	} finally {
		host.dispose();
	}
});

test("a surviving column keeps its offset so multi-row copies stay aligned", async () => {
	const host = screen();
	try {
		const left = assistant(TABLE, host.installation);
		const right = new Text(Array.from({ length: 12 }, (_v, i) => `Right${i}`).join("\n"), 0, 0);
		host.add(
			new HStack(
				[
					{ component: left, basis: 40, grow: 0, shrink: 0 },
					{ component: right, basis: 40, grow: 0, shrink: 0 },
				],
				{ gap: 0, align: "start" },
			),
		);
		const rows = host.plain();
		const action = rows.findIndex((line) => line.includes("[Copy TSV]"));
		const offsets = rows.slice(action - 2, action + 1).map((line) => line.indexOf("Right"));
		assert.ok(
			offsets.every((offset) => offset > 0),
			"neighbour column is present on each row",
		);
		await host.select({ x: 0, y: action - 2 }, { x: 70, y: action });
		assert.equal(host.selected.length, 1);
		const copied = host.selected[0]!.split("\n");
		assert.equal(copied.length, 3);
		assert.deepEqual(
			copied.map((line) => line.indexOf("Right")),
			offsets,
			"the action row keeps the same column offset as its neighbours",
		);
		assert.doesNotMatch(host.selected[0]!, /Copy TSV|Copy CSV|Copy Markdown/);
	} finally {
		host.dispose();
	}
});

test("visible width helpers still treat markers as zero-width after the column rework", () => {
	const installation = installTableCopy({
		tui: { mode: "fullscreen" },
		paint,
		copy: async () => {},
		notify() {},
		debug() {},
	});
	try {
		const lines = markdown(TABLE, installation).render(80);
		const row = lines.find((line) => stripTerminalSequences(line).includes("[Copy TSV]"))!;
		assert.equal(visibleWidth(row), 80);
		assert.match(stripTerminalSequences(row), /^\[Copy TSV\] {3}\[Copy CSV\] {3}\[Copy Markdown\]/);
	} finally {
		installation.dispose();
	}
});
