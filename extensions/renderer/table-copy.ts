/**
 * Add Grok-style whole-table copy actions to Pi's Markdown tables.
 *
 * Pi's transformer supplies provenance; a removable Markdown prototype patch
 * adds mouse actions only to fullscreen assistant-body instances. This module
 * deliberately does not implement cell selection or geometry.
 */
import {
	copyToClipboard,
	type ExtensionAPI,
	type ExtensionContext,
	type MarkdownTransformContext,
} from "@earendil-works/pi-coding-agent";
import {
	Markdown,
	stripTerminalSequences,
	visibleWidth,
	type TUI,
	type TuiMouseEvent,
	type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import { walkComponentTree } from "../utils/component-tree.ts";
import { isFullscreenTui } from "../utils/fullscreen-detect.ts";
import { isTranscriptComponent, markTranscriptComponent } from "./transcript-scope.ts";

const PATCH = Symbol.for("pi.ccstyle.markdown-table-copy");
const ACTIONS_KEY = Symbol.for("pi.ccstyle.markdown-table-copy.actions");
const ACTION_LINE = "[Copy TSV]   [Copy CSV]   [Copy Markdown]";
const COMPACT_ACTION_LINE = "[Copy TSV] [Copy CSV] [Copy Markdown]";
const FORMATS = ["tsv", "csv", "markdown"] as const;

type Format = (typeof FORMATS)[number];
type CopyText = (text: string) => Promise<void>;
type Notify = (message: string, isError: boolean) => void;
type Paint = (color: "dim" | "text", text: string) => string;

export interface TableCopyOptions {
	tui: { readonly mode?: string };
	paint: Paint;
	copy?: CopyText;
	notify?: Notify;
}

export interface TableCopyInstallation {
	/** Called by the entry point's combined transformer; never changes the source. */
	noteSource(context: MarkdownTransformContext): void;
	dispose(): void;
}

interface TableCopyOwner extends TableCopyOptions {
	copy: CopyText;
	notify: Notify;
}

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
	clearRenderCache?: () => void;
}

interface ActionHit {
	y: number;
	start: number;
	end: number;
	format: Format;
	table: TableToken;
}

interface ActionState {
	owner: TableCopyOwner;
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
	version: 2;
	active: boolean;
	owners: Set<TableCopyOwner>;
	components: Set<WeakRef<MarkdownWithActions>>;
	componentRefs: WeakMap<MarkdownWithActions, WeakRef<MarkdownWithActions>>;
	componentOwners: WeakMap<MarkdownWithActions, TableCopyOwner>;
	rendering?: { component: MarkdownWithActions; transcript: boolean };
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

function paintActions(
	lines: string[],
	hits: ActionHit[],
	hover: ActionState["hover"],
	paint: Paint,
): void {
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
			const styled = paint(hovered ? "text" : "dim", text);
			lines[y] = `${lines[y]!.slice(0, index)}${styled}${lines[y]!.slice(index + text.length)}`;
		}
	}
}

/** Rebuild hit regions after every new render; identical cached lines reuse them. */
function bindActions(component: MarkdownWithActions, lines: string[], owner: TableCopyOwner): void {
	if (component[ACTIONS_KEY]?.lines === lines && component[ACTIONS_KEY]?.owner === owner) return;
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
	paintActions(lines, hits, hover, owner.paint);
	component[ACTIONS_KEY] = { owner, lines, hits, hover };
}

function currentPatch(target: Prototype): Patch | undefined {
	const held = target[PATCH] as Partial<Patch> | undefined;
	return held?.version === 2 ? (held as Patch) : undefined;
}

function eligibleOwner(patch: Patch, component: MarkdownWithActions): TableCopyOwner | undefined {
	const owner = patch.componentOwners.get(component);
	return patch.active &&
		owner &&
		patch.owners.has(owner) &&
		isFullscreenTui(owner.tui) &&
		!isTranscriptComponent(component)
		? owner
		: undefined;
}

/** Hover changes only row colors, not block layout or syntax highlighting. */
function clearLineCache(component: MarkdownWithActions): void {
	const clear = (component as unknown as MarkdownInternals).clearRenderCache;
	if (typeof clear === "function") clear.call(component);
	else component.invalidate();
}

/** Cached messages may have rendered before session_start and missed our marker. */
function invalidateMountedMarkdown(tui: unknown): void {
	walkComponentTree(tui, (component) => {
		if (component instanceof Markdown) component.invalidate();
	});
}

function trackComponent(patch: Patch, component: MarkdownWithActions): void {
	if (patch.componentRefs.has(component)) return;
	if (patch.components.size >= 100) {
		for (const ref of patch.components) if (!ref.deref()) patch.components.delete(ref);
	}
	const ref = new WeakRef(component);
	patch.componentRefs.set(component, ref);
	patch.components.add(ref);
}

const NO_INSTALLATION: TableCopyInstallation = { noteSource() {}, dispose() {} };

/**
 * Install only for a fullscreen owner. Shared wrappers stay inert after the last
 * owner releases them, even if another extension still holds a wrapper above us.
 */
export function installTableCopy(options: TableCopyOptions): TableCopyInstallation {
	if (!isFullscreenTui(options.tui)) return NO_INSTALLATION;
	const target = Markdown.prototype as unknown as Prototype;
	let patch = currentPatch(target);
	if (!patch?.active) {
		const originalRender = target.render as Render;
		const originalRenderTable = target.renderTable as RenderTable;
		if (typeof originalRender !== "function" || typeof originalRenderTable !== "function")
			return NO_INSTALLATION;
		const created: Patch = {
			version: 2,
			active: true,
			owners: new Set(),
			components: new Set(),
			componentRefs: new WeakMap(),
			componentOwners: new WeakMap(),
			originalRender,
			originalRenderTable,
			originalHandleMouse: target.handleMouse as HandleMouse | undefined,
			wrappedRenderTable(token, availableWidth, nextTokenType, styleContext) {
				const lines = created.originalRenderTable.call(
					this,
					token,
					availableWidth,
					nextTokenType,
					styleContext,
				);
				if (!eligibleOwner(created, this) || token.header.length === 0) return lines;
				const trailingBlank = lines.at(-1) === "" ? lines.pop() : undefined;
				lines.push(...actionLines(availableWidth));
				if (trailingBlank !== undefined) lines.push(trailingBlank);
				return lines;
			},
			wrappedRender(width) {
				if (!created.active) return created.originalRender.call(this, width);
				const previous = created.rendering;
				const transcript = isTranscriptComponent(this);
				if (transcript) markTranscriptComponent(this);
				created.rendering = { component: this, transcript };
				try {
					// Eligibility affects cached table blocks, unlike hover. Rebuild only
					// when it changes (including runtime regular/fullscreen switches).
					if (Boolean(this[ACTIONS_KEY]) !== Boolean(eligibleOwner(created, this))) {
						delete this[ACTIONS_KEY];
						this.invalidate();
					}
					const lines = created.originalRender.call(this, width);
					const owner = eligibleOwner(created, this);
					if (owner) {
						trackComponent(created, this);
						bindActions(this, lines, owner);
					}
					return lines;
				} finally {
					created.rendering = previous;
				}
			},
			wrappedHandleMouse(event) {
				const owner = eligibleOwner(created, this);
				const state = this[ACTIONS_KEY];
				if (!owner || state?.owner !== owner) return created.originalHandleMouse?.call(this, event);
				const hit = state.hits.find(
					(action) => action.y === event.y && event.x >= action.start && event.x < action.end,
				);
				if (event.type === "move") {
					const hover = hit ? { y: hit.y, format: hit.format } : undefined;
					if (state.hover?.y !== hover?.y || state.hover?.format !== hover?.format) {
						state.hover = hover;
						clearLineCache(this);
						return { handled: true, render: true };
					}
				}
				// Fullscreen release synthesizes click only after capturing this press.
				if (event.type === "press" && event.button === "left" && hit) return { handled: true };
				if (event.type === "click" && event.button === "left" && hit) {
					const text = serializeTable(hit.table, hit.format);
					const name = hit.format === "markdown" ? "Markdown" : hit.format.toUpperCase();
					// Capture the clicked component's owner, never the newest session.
					void Promise.resolve()
						.then(() => owner.copy(text))
						.then(
							() => {
								if (created.owners.has(owner)) owner.notify(`Copied table as ${name}`, false);
							},
							(error) => {
								if (created.owners.has(owner))
									owner.notify(
										`Table copy failed: ${error instanceof Error ? error.message : String(error)}`,
										true,
									);
							},
						);
					return { handled: true };
				}
				return created.originalHandleMouse?.call(this, event);
			},
		};
		target.renderTable = created.wrappedRenderTable;
		target.render = created.wrappedRender;
		target.handleMouse = created.wrappedHandleMouse;
		target[PATCH] = created;
		patch = created;
	}
	const owner: TableCopyOwner = {
		...options,
		copy: options.copy ?? copyToClipboard,
		notify: options.notify ?? (() => {}),
	};
	patch.owners.add(owner);
	invalidateMountedMarkdown(owner.tui);
	const held = patch;
	return {
		noteSource(context) {
			const frame = held.rendering;
			if (!held.active || !held.owners.has(owner) || !frame) return;
			const component = frame.component;
			const next = context.messageType === "assistant" && !frame.transcript ? owner : undefined;
			const previous = held.componentOwners.get(component);
			if (previous === next) return;
			const wasEligible = Boolean(eligibleOwner(held, component));
			if (next) {
				held.componentOwners.set(component, next);
				trackComponent(held, component);
			} else held.componentOwners.delete(component);
			if (wasEligible !== Boolean(eligibleOwner(held, component))) {
				delete component[ACTIONS_KEY];
				component.invalidate();
			}
		},
		dispose() {
			if (!held.owners.delete(owner)) return;
			if (held.owners.size === 0) held.active = false;
			for (const ref of held.components) {
				const component = ref.deref();
				if (!component) {
					held.components.delete(ref);
					continue;
				}
				if (held.owners.size > 0 && held.componentOwners.get(component) !== owner) continue;
				held.componentOwners.delete(component);
				held.componentRefs.delete(component);
				held.components.delete(ref);
				delete component[ACTIONS_KEY];
				component.invalidate();
			}
			if (held.active) return;
			if (target.render === held.wrappedRender) target.render = held.originalRender;
			if (target.renderTable === held.wrappedRenderTable)
				target.renderTable = held.originalRenderTable;
			if (target.handleMouse === held.wrappedHandleMouse) {
				if (held.originalHandleMouse) target.handleMouse = held.originalHandleMouse;
				else delete target.handleMouse;
			}
			if (currentPatch(target) === held) delete target[PATCH];
			held.componentOwners = new WeakMap();
		},
	};
}

interface FlashTui {
	flash(message: string): void;
}

/** Capture Pi's native flash through an empty below-editor widget. */
export function createTableCopyNotifier(
	ctx: ExtensionContext,
	onTuiReady?: (tui: TUI, notify: Notify) => void,
): {
	notify: Notify;
	dispose: () => void;
} {
	let flashTui: FlashTui | undefined;
	let disposed = false;
	const key = "ccstyle-table-copy-flash";
	const notify: Notify = (message, isError) => {
		if (disposed) return;
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
	try {
		ctx.ui?.setWidget?.(
			key,
			(tui) => {
				const candidate = tui as unknown as FlashTui;
				flashTui = typeof candidate.flash === "function" ? candidate : undefined;
				const sync = () => {
					if (!disposed) onTuiReady?.(tui, notify);
				};
				sync();
				return {
					render: () => {
						sync();
						return [];
					},
					invalidate: sync,
					dispose: () => {
						if (flashTui === candidate) flashTui = undefined;
					},
				};
			},
			{ placement: "belowEditor" },
		);
	} catch {
		// Without a captured TUI, provenance/mode checks fail closed.
	}
	return {
		notify,
		dispose: () => {
			if (disposed) return;
			disposed = true;
			flashTui = undefined;
			try {
				ctx.ui?.setWidget?.(key, undefined);
			} catch {
				// The host may already have disposed its UI during shutdown.
			}
		},
	};
}

/** Lifecycle only; the package entry point composes our marker with enhancement. */
export default function tableCopyExtension(
	pi: ExtensionAPI,
): Pick<TableCopyInstallation, "noteSource"> {
	let installation: TableCopyInstallation | undefined;
	let installedTui: TUI | undefined;
	let disposeNotifier: (() => void) | undefined;
	let active = false;
	const cleanup = () => {
		active = false;
		installation?.dispose();
		installation = undefined;
		installedTui = undefined;
		disposeNotifier?.();
		disposeNotifier = undefined;
	};
	pi.on("session_start", (_event, ctx: ExtensionContext) => {
		cleanup();
		if (ctx.mode !== "tui" || !ctx.hasUI) return;
		active = true;
		const notifier = createTableCopyNotifier(ctx, (tui, notify) => {
			if (!active) return;
			const fullscreen = isFullscreenTui(tui);
			if (fullscreen && installation && installedTui === tui) return;
			if (!fullscreen && !installation) return;
			installation?.dispose();
			installation = undefined;
			installedTui = undefined;
			if (fullscreen) {
				installation = installTableCopy({
					tui,
					notify,
					paint: (color, text) => ctx.ui.theme.fg(color, text),
				});
				installedTui = tui;
			}
			tui.requestRender();
		});
		disposeNotifier = notifier.dispose;
	});
	pi.on("session_shutdown", cleanup);
	return { noteSource: (context) => installation?.noteSource(context) };
}
