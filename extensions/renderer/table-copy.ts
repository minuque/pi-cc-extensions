/**
 * Add Grok-style whole-table copy actions to Pi's Markdown tables.
 *
 * Pi already parses tables and exposes a robust copyToClipboard(), but its
 * extension Markdown transformer cannot attach mouse actions. This module installs a small, removable patch on Pi's component
 * prototype. It deliberately does not implement cell selection or geometry.
 */
import {
	copyToClipboard,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	Markdown,
	stripTerminalSequences,
	visibleWidth,
	type TuiMouseEvent,
	type TuiMouseEventResult,
} from "@earendil-works/pi-tui";

const PATCH = Symbol.for("pi.ccstyle.markdown-table-copy");
const ACTIONS_KEY = Symbol("actions");
const ACTION_LINE = "[Copy TSV]   [Copy CSV]   [Copy Markdown]";
const COMPACT_ACTION_LINE = "[Copy TSV] [Copy CSV] [Copy Markdown]";
const FORMATS = ["tsv", "csv", "markdown"] as const;

type Format = (typeof FORMATS)[number];
type CopyText = (text: string) => Promise<void>;
type Notify = (message: string, isError: boolean) => void;

interface InlineToken {
	type?: string;
	text?: string;
	raw?: string;
	tokens?: InlineToken[];
}

interface TableCell {
	text: string;
	tokens?: InlineToken[];
}

interface TableToken {
	type: "table";
	raw: string;
	header: TableCell[];
	rows: TableCell[][];
	tokens?: MarkdownToken[];
	items?: MarkdownToken[];
}

interface MarkdownToken {
	type?: string;
	raw?: string;
	tokens?: MarkdownToken[];
	items?: Array<{ tokens?: MarkdownToken[] }>;
}

interface MarkdownInternals {
	cachedTokens?: { deref(): { tokens: MarkdownToken[] } | undefined };
}

interface ActionHit {
	y: number;
	start: number;
	end: number;
	format: Format;
	table: TableToken;
}

interface ActionState {
	lines: string[];
	hits: ActionHit[];
	hover?: { y: number; format: Format };
}

interface MarkdownWithActions extends Markdown {
	[ACTIONS_KEY]?: ActionState;
}

type Render = (this: MarkdownWithActions, width: number) => string[];
type RenderTable = (
	this: MarkdownWithActions,
	token: TableToken,
	availableWidth: number,
	nextTokenType?: string,
	styleContext?: unknown,
) => string[];
type HandleMouse = (
	this: MarkdownWithActions,
	event: TuiMouseEvent,
) => TuiMouseEventResult | undefined;

interface Patch {
	owners: Map<object, { copy: CopyText; notify: Notify }>;
	components: Set<WeakRef<MarkdownWithActions>>;
	componentRefs: WeakMap<MarkdownWithActions, WeakRef<MarkdownWithActions>>;
	copy: CopyText;
	notify: Notify;
	originalRender: Render;
	originalRenderTable: RenderTable;
	originalHandleMouse?: HandleMouse;
	wrappedRender: Render;
	wrappedRenderTable: RenderTable;
	wrappedHandleMouse: HandleMouse;
}

type Prototype = Record<PropertyKey, unknown>;

function label(format: Format): string {
	return `[Copy ${format === "markdown" ? "Markdown" : format.toUpperCase()}]`;
}

/** Inline Markdown copies as readable cell text, without ANSI or formatting markers. */
function inlineText(tokens: InlineToken[] | undefined, fallback: string): string {
	if (!tokens?.length) return fallback;
	return tokens
		.map((token) => {
			if (token.type === "br") return " ";
			if (token.tokens?.length) return inlineText(token.tokens, "");
			return token.text ?? token.raw ?? "";
		})
		.join("");
}

function cellText(cell: TableCell): string {
	return inlineText(cell.tokens, cell.text).replaceAll("\r\n", "\n").replaceAll("\r", "\n");
}

function tableRows(token: TableToken): string[][] {
	return [token.header, ...token.rows].map((row) => row.map(cellText));
}

function csvCell(text: string): string {
	return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** Serialize the parsed table, never the terminal border or its wrapping. */
export function serializeTable(token: TableToken, format: Format): string {
	if (format === "markdown") return token.raw.replace(/(?:\r?\n)+$/, "");
	const rows = tableRows(token);
	if (format === "tsv") {
		return rows.map((row) => row.map((cell) => cell.replace(/[\t\n]/g, " ")).join("\t")).join("\n");
	}
	return rows.map((row) => row.map(csvCell).join(",")).join("\n");
}

function actionLines(availableWidth: number): string[] {
	if (visibleWidth(ACTION_LINE) <= availableWidth) return [ACTION_LINE];
	if (visibleWidth(COMPACT_ACTION_LINE) <= availableWidth) return [COMPACT_ACTION_LINE];
	return FORMATS.map(label);
}

function collectTables(tokens: MarkdownToken[], output: TableToken[] = []): TableToken[] {
	for (const token of tokens) {
		if (token.type === "table") {
			const table = token as TableToken;
			if (table.header.length > 0) output.push(table);
		}
		if (token.tokens?.length) collectTables(token.tokens, output);
		for (const item of token.items ?? []) {
			if (item.tokens?.length) collectTables(item.tokens, output);
		}
	}
	return output;
}

function actionLineFormats(line: string): Format[] {
	// Blockquotes prefix every rendered content line, including our action row.
	const trimmed = line
		.trim()
		.replace(/^(?:│\s*)+/, "")
		.trim();
	if (trimmed === ACTION_LINE || trimmed === COMPACT_ACTION_LINE) return [...FORMATS];
	return FORMATS.filter((format) => trimmed === label(format));
}

function paintActions(lines: string[], hits: ActionHit[], hover: ActionState["hover"]): void {
	const byLine = new Map<number, ActionHit[]>();
	for (const hit of hits) {
		const row = byLine.get(hit.y) ?? [];
		row.push(hit);
		byLine.set(hit.y, row);
	}
	for (const [y, row] of byLine) {
		const replacements = row
			.map((hit) => ({ hit, index: lines[y]!.indexOf(label(hit.format)) }))
			.filter(({ index }) => index >= 0)
			.sort((a, b) => b.index - a.index);
		for (const { hit, index } of replacements) {
			const text = label(hit.format);
			const hovered = hover?.y === hit.y && hover.format === hit.format;
			const styled = hovered ? `\x1b[1;4m${text}\x1b[22;24m` : `\x1b[2m${text}\x1b[22m`;
			lines[y] = `${lines[y]!.slice(0, index)}${styled}${lines[y]!.slice(index + text.length)}`;
		}
	}
}

/** Rebuild hit regions after every new render; identical cached lines reuse them. */
function bindActions(component: MarkdownWithActions, lines: string[]): void {
	if (component[ACTIONS_KEY]?.lines === lines) return;
	const hits: ActionHit[] = [];
	const groups: Array<Array<Omit<ActionHit, "table">>> = [];
	for (let y = 0; y < lines.length; y++) {
		const plain = stripTerminalSequences(lines[y]!);
		const formats = actionLineFormats(plain);
		if (formats.length === 0) continue;
		const group: Array<Omit<ActionHit, "table">> = [];
		for (const format of formats) {
			const text = label(format);
			const index = plain.indexOf(text);
			if (index < 0) continue;
			const start = visibleWidth(plain.slice(0, index));
			group.push({ y, start, end: start + visibleWidth(text), format });
		}
		if (group.length === 0) continue;
		const previous = groups.at(-1);
		if (previous?.at(-1)?.y === y - 1) previous.push(...group);
		else groups.push(group);
	}

	const tokens = (component as unknown as MarkdownInternals).cachedTokens?.deref()?.tokens;
	const tables = tokens ? collectTables(tokens) : [];
	const previousHover = component[ACTIONS_KEY]?.hover;
	// A pathological collision with model-written action text must not associate
	// a button with the wrong table. In that case leave clicks to Pi's selection.
	if (groups.length === tables.length) {
		for (let index = 0; index < groups.length; index++) {
			for (const hit of groups[index]!) hits.push({ ...hit, table: tables[index]! });
		}
	}
	const hover = hits.some(
		(hit) => hit.y === previousHover?.y && hit.format === previousHover?.format,
	)
		? previousHover
		: undefined;
	paintActions(lines, hits, hover);
	component[ACTIONS_KEY] = { lines, hits, hover };
}

function currentPatch(target: Prototype): Patch | undefined {
	const held = target[PATCH];
	return held !== undefined && typeof held === "object" ? (held as Patch) : undefined;
}

/**
 * Install the shared prototype patch. Each TUI session owns one reference;
 * the final shutdown restores Pi's methods, including on package reload.
 */
export function installTableCopy(
	copy: CopyText = copyToClipboard,
	notify: Notify = () => {},
): () => void {
	const target = Markdown.prototype as unknown as Prototype;
	let patch = currentPatch(target);
	if (
		!patch ||
		target.render !== patch.wrappedRender ||
		target.renderTable !== patch.wrappedRenderTable
	) {
		const originalRender = target.render as Render;
		const originalRenderTable = target.renderTable as RenderTable;
		if (typeof originalRender !== "function" || typeof originalRenderTable !== "function")
			return () => {};
		const originalHandleMouse = target.handleMouse as HandleMouse | undefined;
		const created = {} as Patch;
		created.owners = new Map();
		created.components = new Set();
		created.componentRefs = new WeakMap();
		created.copy = copy;
		created.notify = notify;
		created.originalRender = originalRender;
		created.originalRenderTable = originalRenderTable;
		created.originalHandleMouse = originalHandleMouse;
		created.wrappedRenderTable = function (token, availableWidth, nextTokenType, styleContext) {
			const lines = created.originalRenderTable.call(
				this,
				token,
				availableWidth,
				nextTokenType,
				styleContext,
			);
			if (token.header.length === 0) return lines;
			const trailingBlank = lines.at(-1) === "" ? lines.pop() : undefined;
			lines.push(...actionLines(availableWidth));
			if (trailingBlank !== undefined) lines.push(trailingBlank);
			return lines;
		};
		created.wrappedRender = function (width) {
			const lines = created.originalRender.call(this, width);
			if (!created.componentRefs.has(this)) {
				// Keep cleanup reachable without pinning messages dropped by /tree or compaction.
				if (created.components.size >= 100) {
					for (const ref of created.components) if (!ref.deref()) created.components.delete(ref);
				}
				const ref = new WeakRef(this);
				created.componentRefs.set(this, ref);
				created.components.add(ref);
			}
			bindActions(this, lines);
			return lines;
		};
		created.wrappedHandleMouse = function (event) {
			const state = this[ACTIONS_KEY];
			const hit = state?.hits.find(
				(action) => action.y === event.y && event.x >= action.start && event.x < action.end,
			);
			if (event.type === "move" && state) {
				const hover = hit ? { y: hit.y, format: hit.format } : undefined;
				if (state.hover?.y !== hover?.y || state.hover?.format !== hover?.format) {
					state.hover = hover;
					this.invalidate();
					return { handled: true, render: true };
				}
			}
			// Fullscreen records the press target first; release then synthesizes the click.
			if (event.type === "press" && event.button === "left" && hit) return { handled: true };
			if (event.type === "click" && event.button === "left") {
				if (hit) {
					const text = serializeTable(hit.table, hit.format);
					const name = hit.format === "markdown" ? "Markdown" : hit.format.toUpperCase();
					void Promise.resolve()
						.then(() => created.copy(text))
						.then(
							() => created.notify(`Copied table as ${name}`, false),
							(error) =>
								created.notify(
									`Table copy failed: ${error instanceof Error ? error.message : String(error)}`,
									true,
								),
						);
					return { handled: true };
				}
			}
			return created.originalHandleMouse?.call(this, event);
		};
		target.renderTable = created.wrappedRenderTable;
		target.render = created.wrappedRender;
		target.handleMouse = created.wrappedHandleMouse;
		target[PATCH] = created;
		patch = created;
	}
	patch.copy = copy;
	patch.notify = notify;
	const owner = {};
	patch.owners.set(owner, { copy, notify });
	return () => {
		patch.owners.delete(owner);
		const previous = [...patch.owners.values()].at(-1);
		if (previous) {
			patch.copy = previous.copy;
			patch.notify = previous.notify;
			return;
		}
		if (target.render === patch.wrappedRender) target.render = patch.originalRender;
		if (target.renderTable === patch.wrappedRenderTable)
			target.renderTable = patch.originalRenderTable;
		if (target.handleMouse === patch.wrappedHandleMouse) {
			if (patch.originalHandleMouse) target.handleMouse = patch.originalHandleMouse;
			else delete target.handleMouse;
		}
		if (currentPatch(target) === patch) delete target[PATCH];
		for (const ref of patch.components) {
			const component = ref.deref();
			if (!component) continue;
			delete component[ACTIONS_KEY];
			component.invalidate();
		}
		patch.components.clear();
	};
}

interface FlashTui {
	flash(message: string): void;
}

/** Capture Pi's native flash through an empty below-editor widget. */
export function createTableCopyNotifier(ctx: ExtensionContext): {
	notify: Notify;
	dispose: () => void;
} {
	let flashTui: FlashTui | undefined;
	const key = "ccstyle-table-copy-flash";
	try {
		ctx.ui?.setWidget?.(
			key,
			(tui) => {
				const candidate = tui as unknown as FlashTui;
				flashTui = typeof candidate.flash === "function" ? candidate : undefined;
				return {
					render: () => [],
					invalidate: () => {},
					dispose: () => {
						if (flashTui === candidate) flashTui = undefined;
					},
				};
			},
			{ placement: "belowEditor" },
		);
	} catch {
		// Older hosts without widget factories use the ordinary notification path.
	}
	const notify: Notify = (message, isError) => {
		try {
			if (!isError && flashTui) {
				flashTui.flash(message);
				return;
			}
			ctx.ui?.notify?.(message, isError ? "error" : "info");
		} catch {
			// Copying must not fail merely because the host has no notification UI.
		}
	};
	return {
		notify,
		dispose: () => {
			flashTui = undefined;
			try {
				ctx.ui?.setWidget?.(key, undefined);
			} catch {
				// The host may already have disposed its UI during shutdown.
			}
		},
	};
}

export default function tableCopyExtension(pi: ExtensionAPI): void {
	let uninstall: (() => void) | undefined;
	let disposeNotifier: (() => void) | undefined;
	pi.on("session_start", (_event, ctx: ExtensionContext) => {
		if (ctx.mode !== "tui") return;
		uninstall?.();
		disposeNotifier?.();
		const notifier = createTableCopyNotifier(ctx);
		disposeNotifier = notifier.dispose;
		uninstall = installTableCopy(copyToClipboard, notifier.notify);
	});
	pi.on("session_shutdown", () => {
		uninstall?.();
		uninstall = undefined;
		disposeNotifier?.();
		disposeNotifier = undefined;
	});
}
