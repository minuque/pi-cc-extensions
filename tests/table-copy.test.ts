import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
	Markdown,
	TuiAltScreen,
	stripTerminalSequences,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { normalizeConfig } from "../extensions/config/config.ts";
import {
	createTableCopyNotifier,
	installTableCopy,
	serializeTable,
} from "../extensions/renderer/table-copy.ts";

const tuiEntry = fileURLToPath(import.meta.resolve("@earendil-works/pi-tui"));
const { dispatchMouseEvent } = await import(
	pathToFileURL(path.join(path.dirname(tuiEntry), "tui.js")).href
);
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

const TABLE = `| Name | Value | Note |
| --- | ---: | --- |
| ALPHA-17 | 42 | \`river-stone\` |
| BRAVO-88 | "a,b" | [文档](https://example.com) |
`;

function markdown(source: string): Markdown {
	return new Markdown(source, 0, 0, theme);
}

function click(component: Markdown, lines: string[], text: string, occurrence = 0) {
	const plain = lines.map(stripTerminalSequences);
	const rows = plain.flatMap((line, y) => (line.includes(text) ? [{ line, y }] : []));
	const row = rows[occurrence];
	assert.ok(row, `action ${text} occurrence ${occurrence} is rendered`);
	const index = row.line.indexOf(text);
	const result = dispatchMouseEvent(component, {
		type: "click",
		button: "left",
		x: visibleWidth(row.line.slice(0, index)) + 1,
		y: row.y,
		screenX: 0,
		screenY: 0,
		width: 80,
		height: lines.length,
		shift: false,
		alt: false,
		ctrl: false,
	});
	assert.equal(result?.handled, true);
}

async function settle(): Promise<void> {
	await new Promise((resolve) => setImmediate(resolve));
}

async function withPatch(
	body: () => void | Promise<void>,
	copy: (text: string) => Promise<void> = async () => {},
): Promise<void> {
	const uninstall = installTableCopy(copy, () => {});
	try {
		await body();
	} finally {
		uninstall();
	}
}

test("enableTableCopy defaults on and can be disabled", () => {
	assert.equal(normalizeConfig({}).enableTableCopy, true);
	assert.equal(normalizeConfig({ enableTableCopy: false }).enableTableCopy, false);
});

test("table actions copy TSV, CSV and original Markdown from the parsed table", async () => {
	const copies: string[] = [];
	await withPatch(
		async () => {
			const component = markdown(TABLE);
			const lines = component.render(80);
			const output = lines.map(stripTerminalSequences).join("\n");
			assert.match(output, /^\[Copy TSV\] {3}\[Copy CSV\] {3}\[Copy Markdown\]/m);
			assert.ok(lines.some((line) => line.includes("\x1b[2m[Copy TSV]\x1b[22m")));

			click(component, lines, "[Copy TSV]");
			click(component, lines, "[Copy CSV]");
			click(component, lines, "[Copy Markdown]");
			await settle();
			assert.equal(
				copies[0],
				`Name\tValue\tNote\nALPHA-17\t42\triver-stone\nBRAVO-88\t"a,b"\t文档`,
			);
			assert.equal(copies[1], `Name,Value,Note\nALPHA-17,42,river-stone\nBRAVO-88,"""a,b""",文档`);
			assert.equal(copies[2], TABLE.trimEnd());
		},
		async (text) => {
			copies.push(text);
		},
	);
});

test("cached renders, reused blocks and multiple tables keep the correct association", async () => {
	const copies: string[] = [];
	const second = "| A | B |\n| --- | --- |\n| second | table |\n";
	await withPatch(
		async () => {
			const component = markdown(TABLE);
			const initial = component.render(80);
			assert.equal(component.render(80), initial);
			component.setText(`Prefix\n\n${TABLE}\n\nBetween\n\n${second}`);
			const lines = component.render(80);
			click(component, lines, "[Copy TSV]", 0);
			click(component, lines, "[Copy TSV]", 1);
			await settle();
			assert.match(copies[0], /^Name\tValue\tNote/);
			assert.equal(copies[1], "A\tB\nsecond\ttable");

			const resized = component.render(50);
			click(component, resized, "[Copy CSV]", 1);
			await settle();
			assert.equal(copies[2], "A,B\nsecond,table");
		},
		async (text) => {
			copies.push(text);
		},
	);
});

test("tables in blockquotes work without disabling sibling table actions", async () => {
	const copies: string[] = [];
	await withPatch(
		async () => {
			const component = markdown(`${TABLE}\n> | Q | R |\n> | --- | --- |\n> | quoted | table |`);
			const lines = component.render(80);
			assert.ok(lines.some((line) => stripTerminalSequences(line).includes("│ [Copy TSV]")));
			click(component, lines, "[Copy TSV]", 0);
			click(component, lines, "[Copy TSV]", 1);
			await settle();
			assert.match(copies[0], /^Name\tValue\tNote/);
			assert.equal(copies[1], "Q\tR\nquoted\ttable");
		},
		async (text) => {
			copies.push(text);
		},
	);
});

test("mouse hover highlights one action and leaving restores the dim style", async () => {
	await withPatch(async () => {
		const component = markdown(TABLE);
		let lines = component.render(80);
		const move = (x: number, y: number) =>
			dispatchMouseEvent(component, {
				type: "move",
				button: "none",
				x,
				y,
				screenX: x,
				screenY: y,
				width: 80,
				height: lines.length,
				shift: false,
				alt: false,
				ctrl: false,
			});
		const y = lines.findIndex((line) => stripTerminalSequences(line).includes("[Copy TSV]"));
		const plain = stripTerminalSequences(lines[y]);
		const x = visibleWidth(plain.slice(0, plain.indexOf("[Copy TSV]"))) + 1;
		const entered = move(x, y);
		assert.equal(entered?.handled, true);
		assert.equal(entered?.render, true);
		lines = component.render(80);
		assert.ok(lines[y].includes("\x1b[1;4m[Copy TSV]\x1b[22;24m"));
		assert.ok(lines[y].includes("\x1b[2m[Copy CSV]\x1b[22m"));

		move(0, 0);
		lines = component.render(80);
		assert.ok(lines[y].includes("\x1b[2m[Copy TSV]\x1b[22m"));
		assert.ok(!lines[y].includes("\x1b[1;4m"));
	});
});

test("narrow terminals use compact or stacked actions without changing content", async () => {
	const copies: string[] = [];
	await withPatch(
		async () => {
			const component = markdown("| A | B |\n| --- | --- |\n| one | two |");
			const compact = component.render(40);
			assert.ok(
				compact.some(
					(line) => stripTerminalSequences(line).trim() === "[Copy TSV] [Copy CSV] [Copy Markdown]",
				),
			);
			click(component, compact, "[Copy CSV]");
			const stacked = component.render(30);
			assert.ok(stacked.some((line) => stripTerminalSequences(line).trim() === "[Copy Markdown]"));
			click(component, stacked, "[Copy Markdown]");
			await settle();
			assert.equal(copies[0], "A,B\none,two");
			assert.equal(copies[1], "| A | B |\n| --- | --- |\n| one | two |");
		},
		async (text) => {
			copies.push(text);
		},
	);
});

test("clicks outside actions retain Pi behaviour and uninstall restores methods", async () => {
	const original = {
		render: Markdown.prototype.render,
		renderTable: (Markdown.prototype as any).renderTable,
		handleMouse: (Markdown.prototype as any).handleMouse,
	};
	let copies = 0;
	const component = markdown(TABLE);
	const uninstall = installTableCopy(
		async () => {
			copies++;
		},
		() => {},
	);
	try {
		const lines = component.render(80);
		const result = dispatchMouseEvent(component, {
			type: "click",
			button: "left",
			x: 0,
			y: 0,
			screenX: 0,
			screenY: 0,
			width: 80,
			height: lines.length,
			shift: false,
			alt: false,
			ctrl: false,
		});
		assert.equal(result, undefined);
		await settle();
		assert.equal(copies, 0);
	} finally {
		uninstall();
	}
	assert.equal(Markdown.prototype.render, original.render);
	assert.equal((Markdown.prototype as any).renderTable, original.renderTable);
	assert.equal((Markdown.prototype as any).handleMouse, original.handleMouse);
	assert.doesNotMatch(component.render(80).join("\n"), /Copy TSV/);
});

test("fullscreen press and release reaches the real synthesized click path", async () => {
	const copies: string[] = [];
	await withPatch(
		async () => {
			const component = markdown(TABLE);
			const terminal = {
				columns: 80,
				rows: 40,
				kittyProtocolActive: false,
				start: () => {},
				stop: () => {},
				drainInput: async () => {},
				write: () => {},
				moveBy: () => {},
				hideCursor: () => {},
				showCursor: () => {},
				clearLine: () => {},
				clearFromCursor: () => {},
				clearScreen: () => {},
				setTitle: () => {},
				setProgress: () => {},
				setProgramStatus: () => {},
			};
			const tui = new TuiAltScreen(terminal, false, undefined, { copyOnSelect: false });
			tui.addChild(component);
			try {
				tui.start();
				(tui as any).doRender();
				const screen = tui.getScreenLines();
				const y = screen.findIndex((line) => stripTerminalSequences(line).includes("[Copy CSV]"));
				assert.ok(y >= 0);
				const plain = stripTerminalSequences(screen[y]);
				const x = visibleWidth(plain.slice(0, plain.indexOf("[Copy CSV]"))) + 1;
				(tui as any).handleViewportInput(`\x1b[<0;${x + 1};${y + 1}M`);
				assert.ok((tui as any).mousePressTarget, "press captures the table action target");
				(tui as any).handleViewportInput(`\x1b[<0;${x + 1};${y + 1}m`);
				await settle();
				assert.equal(
					copies[0],
					`Name,Value,Note\nALPHA-17,42,river-stone\nBRAVO-88,"""a,b""",文档`,
				);
			} finally {
				tui.stop();
			}
		},
		async (text) => {
			copies.push(text);
		},
	);
});

test("copy success and failure are reported without changing the payload", async () => {
	const notices: Array<{ message: string; isError: boolean }> = [];
	let uninstall = installTableCopy(
		async () => {},
		(message, isError) => notices.push({ message, isError }),
	);
	try {
		const component = markdown(TABLE);
		const lines = component.render(80);
		click(component, lines, "[Copy TSV]");
		await settle();
		assert.deepEqual(notices.at(-1), { message: "Copied table as TSV", isError: false });
	} finally {
		uninstall();
	}
	uninstall = installTableCopy(
		async () => {
			throw new Error("clipboard unavailable");
		},
		(message, isError) => notices.push({ message, isError }),
	);
	try {
		const component = markdown(TABLE);
		const lines = component.render(80);
		click(component, lines, "[Copy CSV]");
		await settle();
		assert.deepEqual(notices.at(-1), {
			message: "Table copy failed: clipboard unavailable",
			isError: true,
		});
	} finally {
		uninstall();
	}
});

test("copy success uses Pi's native flash with the format in the message", () => {
	const flashes: string[] = [];
	const notices: Array<{ message: string; type: string }> = [];
	const widgets = new Map<string, any>();
	let placement: string | undefined;
	const ctx = {
		ui: {
			setWidget(key: string, factory: any, options?: { placement?: string }) {
				if (factory === undefined) {
					widgets.delete(key);
					return;
				}
				placement = options?.placement;
				widgets.set(key, factory({ flash: (message: string) => flashes.push(message) }));
			},
			notify: (message: string, type: string) => notices.push({ message, type }),
		},
	};
	const notifier = createTableCopyNotifier(ctx as any);
	const widget = widgets.get("ccstyle-table-copy-flash");
	assert.equal(placement, "belowEditor");
	assert.deepEqual(widget.render(80), []);
	notifier.notify("Copied table as CSV", false);
	assert.deepEqual(flashes, ["Copied table as CSV"]);
	assert.deepEqual(notices, []);
	notifier.notify("Table copy failed: unavailable", true);
	assert.deepEqual(notices, [{ message: "Table copy failed: unavailable", type: "error" }]);
	notifier.dispose();
	assert.equal(widgets.has("ccstyle-table-copy-flash"), false);
});

test("serializer flattens TSV control characters and escapes CSV quotes", () => {
	const token = {
		type: "table",
		raw: "ignored",
		header: [{ text: "A" }, { text: "B" }],
		rows: [[{ text: "x\ty" }, { text: 'say "hi", now' }]],
	};
	assert.equal(serializeTable(token as any, "tsv"), 'A\tB\nx y\tsay "hi", now');
	assert.equal(serializeTable(token as any, "csv"), 'A,B\nx\ty,"say ""hi"", now"');
});
