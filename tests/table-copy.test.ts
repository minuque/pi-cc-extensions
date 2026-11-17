import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { MarkdownMessageType } from "@earendil-works/pi-coding-agent";
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
	type TableCopyInstallation,
	type TableCopyOptions,
} from "../extensions/renderer/table-copy.ts";
import { withTranscriptScope } from "../extensions/renderer/transcript-scope.ts";

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

const paint = (color: "dim" | "text", text: string) =>
	`\x1b[38;5;${color === "dim" ? 244 : 252}m${text}\x1b[39m`;
let activeInstallation: TableCopyInstallation | undefined;

function markdown(
	source: string,
	messageType: MarkdownMessageType | null = "assistant",
	installation = activeInstallation,
	markdownTheme = theme,
): Markdown {
	return new Markdown(source, 0, 0, markdownTheme, undefined, {
		transform:
			messageType === null
				? undefined
				: (text, availableWidth) => {
						installation?.noteSource({ messageType, availableWidth, isStreaming: false });
						return text;
					},
	});
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

function mouse(component: Markdown, type: "move" | "click", x: number, y: number) {
	return dispatchMouseEvent(component, {
		type,
		button: type === "click" ? "left" : "none",
		x,
		y,
		screenX: x,
		screenY: y,
		width: 80,
		height: 100,
		shift: false,
		alt: false,
		ctrl: false,
	});
}

function actionPosition(lines: string[], label = "[Copy TSV]") {
	const y = lines.findIndex((line) => stripTerminalSequences(line).includes(label));
	assert.ok(y >= 0);
	const plain = stripTerminalSequences(lines[y]!);
	return { y, x: visibleWidth(plain.slice(0, plain.indexOf(label))) + 1 };
}

async function settle(): Promise<void> {
	await new Promise((resolve) => setImmediate(resolve));
}

async function withPatch(
	body: () => void | Promise<void>,
	copy: (text: string) => Promise<void> = async () => {},
	options: Partial<Omit<TableCopyOptions, "copy">> = {},
): Promise<void> {
	const previous = activeInstallation;
	const installation = installTableCopy({ tui: { mode: "fullscreen" }, paint, ...options, copy });
	activeInstallation = installation;
	try {
		await body();
	} finally {
		installation.dispose();
		activeInstallation = previous;
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
			assert.ok(lines.some((line) => line.includes(paint("dim", "[Copy TSV]"))));

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
		assert.ok(lines[y].includes(paint("text", "[Copy TSV]")));
		assert.ok(lines[y].includes(paint("dim", "[Copy CSV]")));
		assert.doesNotMatch(lines[y], /\x1b\[(?:1|4|1;4)m/);

		move(0, 0);
		lines = component.render(80);
		assert.ok(lines[y].includes(paint("dim", "[Copy TSV]")));
		assert.ok(!lines[y].includes(paint("text", "[Copy TSV]")));
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
	const installation = installTableCopy({
		tui: { mode: "fullscreen" },
		paint,
		copy: async () => {
			copies++;
		},
	});
	const component = markdown(TABLE, "assistant", installation);
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
		installation.dispose();
	}
	assert.equal(Markdown.prototype.render, original.render);
	assert.equal((Markdown.prototype as any).renderTable, original.renderTable);
	assert.equal((Markdown.prototype as any).handleMouse, original.handleMouse);
	assert.doesNotMatch(component.render(80).join("\n"), /Copy TSV/);
});

test("fullscreen press and release reaches the real synthesized click path", async () => {
	const copies: string[] = [];
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
	await withPatch(
		async () => {
			const component = markdown(TABLE);
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
		{ tui },
	);
});

test("copy success and failure are reported without changing the payload", async () => {
	const notices: Array<{ message: string; isError: boolean }> = [];
	let installation = installTableCopy({
		tui: { mode: "fullscreen" },
		paint,
		copy: async () => {},
		notify: (message, isError) => notices.push({ message, isError }),
	});
	try {
		const component = markdown(TABLE, "assistant", installation);
		const lines = component.render(80);
		click(component, lines, "[Copy TSV]");
		await settle();
		assert.deepEqual(notices.at(-1), { message: "Copied table as TSV", isError: false });
	} finally {
		installation.dispose();
	}
	installation = installTableCopy({
		tui: { mode: "fullscreen" },
		paint,
		copy: async () => {
			throw new Error("clipboard unavailable");
		},
		notify: (message, isError) => notices.push({ message, isError }),
	});
	try {
		const component = markdown(TABLE, "assistant", installation);
		const lines = component.render(80);
		click(component, lines, "[Copy CSV]");
		await settle();
		assert.deepEqual(notices.at(-1), {
			message: "Table copy failed: clipboard unavailable",
			isError: true,
		});
	} finally {
		installation.dispose();
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

test("only assistant-body provenance enables actions; untyped previews stay native", async () => {
	let copies = 0;
	await withPatch(
		async () => {
			for (const source of [
				"assistant",
				"assistant-thinking",
				"user",
				"custom",
				"summary",
				"changelog",
				null,
			] as const) {
				const component = markdown(TABLE, source);
				const lines = component.render(80);
				if (source === "assistant") {
					assert.match(lines.join("\n"), /Copy TSV/);
					click(component, lines, "[Copy TSV]");
				} else {
					assert.doesNotMatch(lines.join("\n"), /Copy TSV/);
					assert.equal(mouse(component, "click", 0, 0), undefined);
				}
			}
			// A transform alone is not provenance, even with the assistant's theme.
			const unmarked = new Markdown(TABLE, 0, 0, theme, undefined, { transform: (text) => text });
			assert.doesNotMatch(unmarked.render(80).join("\n"), /Copy TSV/);
			await settle();
			assert.equal(copies, 1);
		},
		async () => {
			copies++;
		},
	);
});

test("transcript clones remain excluded even when redrawn outside transcript scope", async () => {
	await withPatch(() => {
		const clone = markdown(TABLE);
		assert.doesNotMatch(withTranscriptScope(() => clone.render(80)).join("\n"), /Copy TSV/);
		clone.invalidate();
		assert.doesNotMatch(clone.render(80).join("\n"), /Copy TSV/);
		assert.match(markdown(TABLE).render(80).join("\n"), /Copy TSV/);
	});
});

test("nested renders and thrown transforms do not leak the active Markdown scope", async () => {
	await withPatch(() => {
		const installation = activeInstallation!;
		const inner = markdown(TABLE);
		const outer = new Markdown(TABLE, 0, 0, theme, undefined, {
			transform: (text, availableWidth) => {
				inner.render(80);
				installation.noteSource({ messageType: "user", availableWidth, isStreaming: false });
				return text;
			},
		});
		assert.doesNotMatch(outer.render(80).join("\n"), /Copy TSV/);
		assert.match(inner.render(80).join("\n"), /Copy TSV/);
		const failing = new Markdown(TABLE, 0, 0, theme, undefined, {
			transform: () => {
				throw new Error("transform failed");
			},
		});
		assert.throws(() => failing.render(80), /transform failed/);
		installation.noteSource({ messageType: "assistant", availableWidth: 80, isStreaming: false });
		assert.doesNotMatch(markdown(TABLE, null).render(80).join("\n"), /Copy TSV/);
	});
});

test("regular and unknown screens do not install a prototype patch", () => {
	const original = Markdown.prototype.render;
	for (const mode of ["regular", "print", undefined]) {
		const installation = installTableCopy({ tui: { mode }, paint });
		try {
			assert.equal(Markdown.prototype.render, original);
			assert.doesNotMatch(
				markdown(TABLE, "assistant", installation).render(80).join("\n"),
				/Copy TSV/,
			);
		} finally {
			installation.dispose();
		}
	}
});

test("screen-mode changes invalidate table blocks and reject stale clicks", async () => {
	const tui = { mode: "fullscreen" };
	let copies = 0;
	await withPatch(
		async () => {
			const component = markdown(TABLE);
			const lines = component.render(80);
			const position = actionPosition(lines);
			tui.mode = "regular";
			assert.equal(mouse(component, "click", position.x, position.y), undefined);
			assert.doesNotMatch(component.render(80).join("\n"), /Copy TSV/);
			tui.mode = "fullscreen";
			const restored = component.render(80);
			assert.match(restored.join("\n"), /Copy TSV/);
			click(component, restored, "[Copy TSV]");
			await settle();
			assert.equal(copies, 1);
		},
		async () => {
			copies++;
		},
		{ tui },
	);
});

test("hover preserves live block caches and does not re-highlight code", async () => {
	let highlights = 0;
	const codeTheme = {
		...theme,
		highlightCode: (code: string) => {
			highlights++;
			return code.split("\n");
		},
	};
	await withPatch(() => {
		const component = markdown(
			`\`\`\`js\nconst value = 42;\n\`\`\`\n\n${TABLE}`,
			"assistant",
			activeInstallation,
			codeTheme,
		);
		const lines = component.render(80);
		const blocks = (component as any).blocks.deref() as Map<string, unknown>;
		const tokens = (component as any).cachedTokens.deref();
		const position = actionPosition(lines);
		assert.equal(highlights, 1);
		assert.equal(mouse(component, "move", position.x, position.y)?.render, true);
		component.render(80);
		assert.equal(highlights, 1);
		assert.equal((component as any).cachedTokens.deref(), tokens);
		for (const [key, block] of blocks)
			assert.equal((component as any).blocks.deref().get(key), block);
		mouse(component, "move", 0, 0);
		component.render(80);
		assert.equal(highlights, 1);
		component.invalidate();
		component.render(80);
		assert.equal(highlights, 2, "full invalidation still rebuilds theme-dependent blocks");
	});
});

test("theme invalidation repaints cached buttons with the current semantic palette", async () => {
	let version = 0;
	const dynamicPaint = (color: "dim" | "text", text: string) =>
		version === 0 ? paint(color, text) : `\x1b[38;5;${color === "dim" ? 240 : 250}m${text}\x1b[39m`;
	await withPatch(
		() => {
			const component = markdown(TABLE);
			assert.match(component.render(80).join("\n"), /\x1b\[38;5;244m\[Copy TSV\]/);
			version = 1;
			component.invalidate();
			assert.match(component.render(80).join("\n"), /\x1b\[38;5;240m\[Copy TSV\]/);
		},
		async () => {},
		{ paint: dynamicPaint },
	);
});

test("shared patches route copies and notices to each component's owner", async () => {
	const copiesA: string[] = [];
	const copiesB: string[] = [];
	const noticesA: string[] = [];
	const noticesB: string[] = [];
	const a = installTableCopy({
		tui: { mode: "fullscreen" },
		paint,
		copy: async (text) => {
			copiesA.push(text);
		},
		notify: (text) => {
			noticesA.push(text);
		},
	});
	const componentA = markdown(TABLE, "assistant", a);
	const b = installTableCopy({
		tui: { mode: "fullscreen" },
		paint,
		copy: async (text) => {
			copiesB.push(text);
		},
		notify: (text) => {
			noticesB.push(text);
		},
	});
	try {
		const componentB = markdown(TABLE, "assistant", b);
		click(componentA, componentA.render(80), "[Copy TSV]");
		click(componentB, componentB.render(80), "[Copy CSV]");
		await settle();
		assert.equal(copiesA.length, 1);
		assert.equal(copiesB.length, 1);
		assert.deepEqual(noticesA, ["Copied table as TSV"]);
		assert.deepEqual(noticesB, ["Copied table as CSV"]);
		b.dispose();
		assert.doesNotMatch(componentB.render(80).join("\n"), /Copy TSV/);
		click(componentA, componentA.render(80), "[Copy Markdown]");
		await settle();
		assert.equal(copiesA.length, 2);
		assert.equal(copiesB.length, 1);
	} finally {
		b.dispose();
		a.dispose();
	}
});

test("other render wrappers survive shared installs and become inert after cleanup", () => {
	const original = Markdown.prototype.render;
	const a = installTableCopy({ tui: { mode: "fullscreen" }, paint });
	const captured = Markdown.prototype.render;
	const outer = function (this: Markdown, width: number) {
		return captured.call(this, width);
	};
	Markdown.prototype.render = outer;
	const b = installTableCopy({ tui: { mode: "fullscreen" }, paint });
	try {
		assert.equal(
			Markdown.prototype.render,
			outer,
			"do not stack another patch over the outer wrapper",
		);
		const component = markdown(TABLE, "assistant", b);
		assert.equal(
			component.render(80).filter((line) => stripTerminalSequences(line).includes("[Copy TSV]"))
				.length,
			1,
		);
		b.dispose();
		a.dispose();
		assert.equal(Markdown.prototype.render, outer);
		assert.doesNotMatch(component.render(80).join("\n"), /Copy TSV/);
		const c = installTableCopy({ tui: { mode: "fullscreen" }, paint });
		try {
			const next = markdown(TABLE, "assistant", c);
			assert.equal(
				next.render(80).filter((line) => stripTerminalSequences(line).includes("[Copy TSV]"))
					.length,
				1,
			);
		} finally {
			c.dispose();
		}
	} finally {
		b.dispose();
		a.dispose();
		Markdown.prototype.render = original;
	}
});
