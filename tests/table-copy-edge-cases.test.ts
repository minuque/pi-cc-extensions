import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	Markdown,
	TuiAltScreen,
	stripTerminalSequences,
	visibleWidth,
} from "@earendil-works/pi-tui";
import {
	installTableCopy,
	type TableCopyInstallation,
	type TableCopyOptions,
} from "../extensions/renderer/table-copy.ts";

const TABLE = "| A | B |\n| --- | --- |\n| one | two |";
const ACTIONS = Symbol.for("pi.ccstyle.markdown-table-copy.actions");
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

function markdown(source: string, installation: TableCopyInstallation, padding = 0): Markdown {
	return new Markdown(source, padding, 0, theme, undefined, {
		transform(text, availableWidth) {
			installation.noteSource({ messageType: "assistant", availableWidth, isStreaming: false });
			return text;
		},
	});
}

function hits(component: Markdown): Array<{
	y: number;
	start: number;
	end: number;
	format: string;
}> {
	return (component as any)[ACTIONS]?.hits ?? [];
}

function click(component: Markdown, hit: ReturnType<typeof hits>[number], width = 80): void {
	const result = (component as any).handleMouse({
		type: "click",
		button: "left",
		x: hit.start + 1,
		y: hit.y,
		screenX: 0,
		screenY: 0,
		width,
		height: 100,
		shift: false,
		alt: false,
		ctrl: false,
	});
	assert.equal(result?.handled, true);
}

async function settle(): Promise<void> {
	await new Promise((resolve) => setImmediate(resolve));
}

function setup(options: Partial<TableCopyOptions> = {}) {
	const copies: string[] = [];
	const diagnostics: string[] = [];
	const installation = installTableCopy({
		tui: { mode: "fullscreen" },
		paint,
		copy: async (text) => {
			copies.push(text);
		},
		debug: (message: string) => {
			diagnostics.push(message);
		},
		...options,
	} as TableCopyOptions);
	return { installation, copies, diagnostics };
}

function mounted(source: string, width = 80, rows = 40) {
	const selected: string[] = [];
	const terminal = {
		columns: width,
		rows,
		kittyProtocolActive: false,
		start() {},
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
	const host = setup({ tui });
	const component = markdown(source, host.installation);
	tui.addChild(component);
	tui.start();
	const render = () => {
		(tui as any).doRender();
		return tui.getScreenLines();
	};
	render();
	const send = (x: number, y: number, button: number, release = false) => {
		(tui as any).handleViewportInput(`\x1b[<${button};${x + 1};${y + 1}${release ? "m" : "M"}`);
	};
	return {
		...host,
		tui,
		component,
		selected,
		render,
		async drag(start: { x: number; y: number }, end: { x: number; y: number }) {
			tui.resetTextSelection();
			send(start.x, start.y, 0);
			send(end.x, end.y, 32);
			render();
			send(end.x, end.y, 0, true);
			await settle();
			return render();
		},
		dispose() {
			tui.stop();
			host.installation.dispose();
		},
	};
}

test("internal markers use terminal-safe ST and preserve visible spacing", () => {
	const host = setup();
	try {
		const output = markdown(TABLE, host.installation).render(80).join("\n");
		assert.equal(output.match(/\x1b_pi:ccstyle-table-copy:[^\x1b]*\x1b\\/g)?.length, 7);
		assert.ok(!output.includes("\x07"), "BEL cannot terminate an APC sequence in a real terminal");
		assert.match(
			stripTerminalSequences(output),
			/\[Copy TSV\] {3}\[Copy CSV\] {3}\[Copy Markdown\]/,
		);
	} finally {
		host.installation.dispose();
	}
});

test("model-written action labels do not disable or become table actions", async () => {
	const host = setup();
	try {
		const component = markdown(
			`${TABLE}\n\n[Copy TSV]\n\n[Copy CSV]\n\n[Copy Markdown]`,
			host.installation,
		);
		const lines = component.render(80);
		assert.equal(hits(component).length, 3);
		for (const hit of hits(component)) click(component, hit);
		await settle();
		assert.deepEqual(host.copies, ["A\tB\none\ttwo", "A,B\none,two", TABLE]);
		const y = lines.findIndex((line) => stripTerminalSequences(line).trim() === "[Copy TSV]");
		assert.ok(y >= 0);
		assert.equal(
			(component as any).handleMouse({
				type: "click",
				button: "left",
				x: 1,
				y,
				screenX: 0,
				screenY: 0,
				width: 80,
				height: lines.length,
				shift: false,
				alt: false,
				ctrl: false,
			}),
			undefined,
		);
	} finally {
		host.installation.dispose();
	}
});

test("visible action-row collisions before and between tables preserve payload ownership", async () => {
	const host = setup();
	try {
		const prose = "[Copy TSV]   [Copy CSV]   [Copy Markdown]";
		const second = "| A | B |\n| --- | --- |\n| second | table |";
		const component = markdown(
			`${prose}\n\n${TABLE}\n\n${prose}\n\n> ${second.replaceAll("\n", "\n> ")}`,
			host.installation,
		);
		component.render(80);
		assert.equal(hits(component).length, 6);
		for (const hit of hits(component).filter((hit) => hit.format === "csv")) click(component, hit);
		await settle();
		assert.deepEqual(host.copies, ["A,B\none,two", "A,B\nsecond,table"]);
	} finally {
		host.installation.dispose();
	}
});

test("identical cached table blocks retain separate clickable occurrences", async () => {
	const host = setup();
	try {
		const component = markdown(`${TABLE}\n\n${TABLE}`, host.installation);
		for (const width of [80, 14, 40, 80]) {
			component.render(width);
			assert.equal(hits(component).length, 6);
			for (const hit of hits(component).filter((hit) => hit.format === "markdown"))
				click(component, hit, width);
		}
		await settle();
		assert.deepEqual(host.copies, Array(8).fill(TABLE));
	} finally {
		host.installation.dispose();
	}
});

test("narrow labels stay intact and all visible formats copy correctly", async () => {
	const host = setup();
	try {
		for (const padding of [0, 1]) {
			const component = markdown(TABLE, host.installation, padding);
			for (const width of [5, 7, 9, 12, 14, 15, 16, 30, 40, 80]) {
				const lines = component.render(width);
				const actions = hits(component);
				const availableWidth = Math.max(1, width - padding * 2);
				assert.equal(
					actions.length,
					availableWidth < 5 ? 0 : 3,
					`width=${width}, padding=${padding}`,
				);
				for (const line of lines) assert.ok(visibleWidth(line) <= width);
				for (const hit of actions) {
					const plain = stripTerminalSequences(lines[hit.y]!);
					assert.match(plain.slice(hit.start, hit.end), /^\[[^\]]+\]$/);
					click(component, hit, width);
				}
				await settle();
				if (actions.length)
					assert.deepEqual(host.copies.slice(-3), ["A\tB\none\ttwo", "A,B\none,two", TABLE]);
			}
		}
	} finally {
		host.installation.dispose();
	}
});

test("a too-narrow quoted table does not steal a sibling table's action payload", async () => {
	const host = setup();
	try {
		const quote = `> > > ${TABLE.replaceAll("\n", "\n> > > ")}`;
		const component = markdown(
			`${quote}\n\n| X | Y |\n| --- | --- |\n| sibling | table |`,
			host.installation,
		);
		component.render(9);
		assert.equal(hits(component).length, 3);
		for (const hit of hits(component)) click(component, hit, 9);
		await settle();
		assert.deepEqual(host.copies, [
			"X\tY\nsibling\ttable",
			"X,Y\nsibling,table",
			"| X | Y |\n| --- | --- |\n| sibling | table |",
		]);
	} finally {
		host.installation.dispose();
	}
});

test("fullscreen drag omits a partially selected action row and its highlight", async () => {
	const host = mounted(TABLE);
	try {
		const hit = hits(host.component).find((hit) => hit.format === "markdown")!;
		const expected = host
			.render()
			.slice(0, hit.y)
			.map(stripTerminalSequences)
			.map((line) => line.trimEnd())
			.join("\n");
		const screen = await host.drag({ x: 0, y: 0 }, { x: hit.start + 5, y: hit.y });
		assert.deepEqual(host.selected, [expected]);
		assert.doesNotMatch(screen[hit.y]!, /\x1b\[7m/);
		assert.equal(host.copies.length, 0, "selection never triggers a whole-table action");
	} finally {
		host.dispose();
	}
});

test("reverse drag retains model-written action text but excludes generated action rows", async () => {
	const host = mounted(`[Copy TSV]\n\n${TABLE}\n\nAfter 表格 👩‍💻`);
	try {
		const screen = host.render();
		const row = screen.findIndex((line) => stripTerminalSequences(line).startsWith("After"));
		const end = visibleWidth(stripTerminalSequences(screen[row]!).trimEnd()) - 1;
		await host.drag({ x: end, y: row }, { x: 0, y: 0 });
		assert.equal(host.selected.length, 1);
		assert.ok(host.selected[0]!.startsWith("[Copy TSV]\n"));
		assert.ok(host.selected[0]!.endsWith("After 表格 👩‍💻"));
		assert.equal(host.selected[0]!.match(/\[Copy TSV\]/g)?.length, 1);
		assert.doesNotMatch(host.selected[0]!, /Copy CSV|Copy Markdown|pi:ccstyle/);
	} finally {
		host.dispose();
	}
});

test("stacked quoted action rows are excluded without deleting surrounding text", async () => {
	const host = mounted(`${TABLE}\n\n> ${TABLE.replaceAll("\n", "\n> ")}\n\nTail`, 14);
	try {
		const screen = host.render();
		const row = screen.findIndex((line) => stripTerminalSequences(line).startsWith("Tail"));
		assert.ok(row > 0);
		await host.drag({ x: 0, y: 0 }, { x: 3, y: row });
		assert.equal(host.selected.length, 1);
		assert.ok(host.selected[0]!.endsWith("Tail"));
		assert.doesNotMatch(host.selected[0]!, /\[Copy|\[TSV\]|\[CSV\]|\[MD\]|Markdown\]/);
	} finally {
		host.dispose();
	}
});

test("scrolled native selections exclude actions using document rather than screen rows", async () => {
	const prefix = Array.from({ length: 30 }, (_value, index) => `Prefix ${index}`).join("\n\n");
	const host = mounted(`${prefix}\n\n${TABLE}\n\n[Copy TSV]\n\nTail`, 80, 12);
	try {
		host.tui.scrollToBottom();
		host.tui.scrollBy(-1);
		const screen = host.render();
		const plain = screen.map(stripTerminalSequences);
		const start = plain.findIndex((line) => line.startsWith("┌"));
		const end = plain.findIndex((line) => line.includes("[Copy CSV]"));
		assert.ok(start >= 0 && end > start, "table and action row are visible after scrolling");
		const x = plain[end]!.indexOf("[Copy Markdown]") + 5;
		const expected = plain
			.slice(start, end)
			.map((line) => line.trimEnd())
			.join("\n");
		await host.drag({ x: 0, y: start }, { x, y: end });
		assert.deepEqual(host.selected, [expected]);
		assert.ok((host.tui as any).selectionAnchor.scrollView.scrollTop > 0);
		assert.ok((host.tui as any).selectionAnchor.row > start);
		host.selected.length = 0;
		// A press on a real button is intentionally captured for clicking, so
		// begin the reverse drag in ordinary model text below the action row.
		const modelRow = plain.findIndex((line) => line.trim() === "[Copy TSV]");
		assert.ok(modelRow > end);
		const reverseExpected = plain
			.slice(start, modelRow + 1)
			.filter((_line, offset) => start + offset !== end)
			.map((line) => line.trimEnd())
			.join("\n");
		await host.drag(
			{ x: visibleWidth(plain[modelRow]!.trimEnd()) - 1, y: modelRow },
			{ x: 0, y: start },
		);
		assert.deepEqual(
			host.selected,
			[reverseExpected],
			"reverse selection uses the same document rows",
		);
	} finally {
		host.dispose();
	}
});

test("an action-only selection has no selectable text or clipboard write", async () => {
	const host = mounted(TABLE, 14);
	try {
		const first = hits(host.component).find((hit) => hit.format === "tsv")!;
		const last = hits(host.component).find((hit) => hit.format === "markdown")!;
		(host.tui as any).selectionAnchor = { row: first.y, col: 0 };
		(host.tui as any).selectionFocus = { row: last.y, col: last.end - 1 };
		assert.equal(host.tui.hasActiveSelection(), false);
		assert.equal(await host.tui.copyActiveSelectionToClipboard(), false);
		assert.equal(host.selected.length, 0);
	} finally {
		host.dispose();
	}
});

test("missing private render or selection APIs fail closed with diagnostics", () => {
	for (const [prototype, key] of [
		[Markdown.prototype, "renderTable"],
		[Markdown.prototype, "clearRenderCache"],
		[TuiAltScreen.prototype, "getActiveSelectionText"],
		[TuiAltScreen.prototype, "getSelectionColumns"],
	] as const) {
		const target = prototype as any;
		const original = target[key];
		const originalRender = Markdown.prototype.render;
		target[key] = undefined;
		try {
			const host = setup();
			host.installation.dispose();
			assert.equal(Markdown.prototype.render, originalRender);
			assert.equal(host.diagnostics.length, 1);
			assert.ok(host.diagnostics[0]!.includes(key));
		} finally {
			target[key] = original;
		}
	}
});

test("a renamed token cache skips buttons and reports the incompatibility once", () => {
	const host = setup();
	try {
		const component = markdown(TABLE, host.installation);
		Object.defineProperty(component, "cachedTokens", {
			get: () => undefined,
			set() {},
			configurable: true,
		});
		for (const width of [80, 40, 14]) {
			assert.doesNotMatch(
				component.render(width).map(stripTerminalSequences).join("\n"),
				/\[Copy|\[TSV\]|\[CSV\]|\[MD\]/,
			);
		}
		assert.equal(host.diagnostics.length, 1);
		assert.match(host.diagnostics[0]!, /cachedTokens/);
	} finally {
		host.installation.dispose();
	}
});

test("compatibility diagnostics go to a debug file instead of terminal output", () => {
	const dir = mkdtempSync(join(tmpdir(), "table-copy-debug-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	const target = Markdown.prototype as any;
	const original = target.renderTable;
	process.env.PI_CODING_AGENT_DIR = dir;
	target.renderTable = undefined;
	try {
		const installation = installTableCopy({ tui: { mode: "fullscreen" }, paint });
		installation.dispose();
		const log = readFileSync(join(dir, "logs", "pi-cc-extensions-table-copy.log"), "utf8");
		assert.match(log, /table-copy.*Pi .*renderTable/);
	} finally {
		target.renderTable = original;
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		rmSync(dir, { recursive: true, force: true });
	}
});

test("selection hooks restore on disposal and do not clobber later wrappers", () => {
	const target = TuiAltScreen.prototype as any;
	const originalText = target.getActiveSelectionText;
	const originalColumns = target.getSelectionColumns;
	const a = setup();
	const b = setup();
	const captured = target.getActiveSelectionText;
	const outer = function (this: any) {
		return captured.call(this);
	};
	target.getActiveSelectionText = outer;
	try {
		a.installation.dispose();
		assert.notEqual(target.getSelectionColumns, originalColumns);
		b.installation.dispose();
		assert.equal(target.getSelectionColumns, originalColumns);
		assert.equal(target.getActiveSelectionText, outer);
		assert.equal(outer.call({ getSelectionBounds: () => undefined }), undefined);
	} finally {
		a.installation.dispose();
		b.installation.dispose();
		target.getActiveSelectionText = originalText;
		target.getSelectionColumns = originalColumns;
	}
});
