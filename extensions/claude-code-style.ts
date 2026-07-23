import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	keyHint,
	getSettingsListTheme,
	ToolExecutionComponent,
} from "@earendil-works/pi-coding-agent";
import { Container, SettingsList, Text, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Claude Code Style for pi
 *
 * Tool calls and results use a compact fallback renderer by default. Renderers
 * listed in excludeRenderers remain untouched. A collapsed tool result can be
 * clicked on its Ctrl+O hint to expand only that tool.
 *
 * Dynamic commands:
 *   /ccstyle              open interactive settings
 *   /ccstyle on           enable
 *   /ccstyle off          disable
 *   /ccstyle status       show current state
 *
 * Shortcut:
 *   ctrl+shift+o          toggle on/off
 */

type Config = {
	enabled: boolean;
	excludeRenderers: string[];
};

const CONFIG_PATH = join(homedir(), ".pi", "agent", "claude-code-style.json");

let config: Config = loadConfig();

function loadConfig(): Config {
	try {
		if (existsSync(CONFIG_PATH)) {
			const parsed = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as Partial<Config>;
			const excludeRenderers = Array.isArray(parsed.excludeRenderers)
				? [...new Set(parsed.excludeRenderers.filter((name): name is string => typeof name === "string" && name.length > 0))]
				: [];
			return {
				enabled: parsed.enabled ?? true,
				excludeRenderers,
			};
		}
	} catch {
		// Ignore bad config and fall back to defaults.
	}
	return { enabled: true, excludeRenderers: [] };
}

function saveConfig() {
	writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

function oneLine(value: unknown, max = 72): string {
	const text = String(value ?? "")
		.replace(/\s+/g, " ")
		.trim();
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

const UNSAFE_TERMINAL_ESCAPE = new RegExp(
	"\\u001B\\][\\s\\S]*?(?:\\u0007|\\u001B\\x5C)"
	+ "|\\u001B[PX^_][\\s\\S]*?\\u001B\\x5C"
	+ "|(?:\\u001B\\[|\\u009B)[0-?]*[ -/]*[@-~]"
	+ "|\\u001B[@-_]",
	"g",
);

/** Prevent captured terminal control responses from being replayed by tool renderers. */
function sanitizeToolResultText(value: string): string {
	return value
		.replace(UNSAFE_TERMINAL_ESCAPE, "")
		.replace(/\x1B/g, "")
		.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g, "")
		.replace(/\r\n/g, "\n")
		.replace(/\r/g, "\n");
}

function textFromResult(result: any): string {
	const item = result?.content?.find?.((c: any) => c.type === "text");
	return item?.type === "text" ? sanitizeToolResultText(item.text ?? "") : "";
}

function countLines(text: string): number {
	return text.trim().split("\n").filter((line) => line.trim().length > 0).length;
}

function hasExpandableResult(text: string): boolean {
	return countLines(text) > 1;
}

function toolIcon(_name: string): string {
	return "●";
}

// Match the braille loader shown to the left of pi's "Working..." row.
// Every frame is one cell wide, so tool titles remain horizontally stable.
const WORKING_LOADER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const TOOL_PENDING_FRAMES: Record<string, string[]> = {
	read: WORKING_LOADER_FRAMES,
	bash: WORKING_LOADER_FRAMES,
	edit: WORKING_LOADER_FRAMES,
	write: WORKING_LOADER_FRAMES,
	find: WORKING_LOADER_FRAMES,
	grep: WORKING_LOADER_FRAMES,
	ls: WORKING_LOADER_FRAMES,
};

function animationFrame(frames: string[], intervalMs = 120): string {
	return frames[Math.floor(Date.now() / intervalMs) % frames.length] ?? frames[0] ?? "";
}

const activeAnimationContexts = new Set<any>();
let sharedAnimationTimer: ReturnType<typeof setTimeout> | null = null;

function clearAnimation(context: any) {
	if (!context?.state?.ccstyleAnimationScheduled) return;
	context.state.ccstyleAnimationScheduled = false;
	activeAnimationContexts.delete(context);
	if (activeAnimationContexts.size === 0 && sharedAnimationTimer) {
		clearTimeout(sharedAnimationTimer);
		sharedAnimationTimer = null;
	}
}

function clearAllAnimations() {
	for (const ctx of activeAnimationContexts) {
		ctx.state.ccstyleAnimationScheduled = false;
	}
	activeAnimationContexts.clear();
	if (sharedAnimationTimer) {
		clearTimeout(sharedAnimationTimer);
		sharedAnimationTimer = null;
	}
}

function scheduleAnimation(context: any, intervalMs = 80) {
	const state = (context.state ??= {});
	if (state.ccstyleAnimationScheduled) return;
	state.ccstyleAnimationScheduled = true;
	activeAnimationContexts.add(context);
	if (!sharedAnimationTimer) {
		sharedAnimationTimer = setTimeout(() => {
			sharedAnimationTimer = null;
			const contexts = Array.from(activeAnimationContexts);
			activeAnimationContexts.clear();
			for (const ctx of contexts) {
				ctx.state.ccstyleAnimationScheduled = false;
				ctx.invalidate?.();
			}
		}, intervalMs);
	}
}

function pendingIcon(name: string): string {
	return animationFrame(TOOL_PENDING_FRAMES[name] ?? [toolIcon(name)], 80);
}

type ToolVisualState = "pending" | "success" | "error";

function settledIcon(name: string, state: ToolVisualState | undefined): string {
	if (state === "success") return "✓";
	if (state === "error") return "✗";
	return toolIcon(name);
}

function setToolVisualState(context: any, visualState: ToolVisualState) {
	const state = (context.state ??= {});
	if (visualState !== "pending") clearAnimation(context);
	if (state.ccstyleToolVisualState === visualState) return;
	state.ccstyleToolVisualState = visualState;
	// Do not invalidate synchronously from renderResult. Pi is already rendering
	// this tool row; recursively scheduling another render here can retain both
	// the finalized result component and its previous secondary/partial component,
	// which displays the result summary twice. The current render pass also
	// refreshes renderCall, so the settled icon still updates immediately.
}

function getToolVisualState(context: any): ToolVisualState | undefined {
	return context?.state?.ccstyleToolVisualState as ToolVisualState | undefined;
}

function resolveToolVisualState(context: any): ToolVisualState | undefined {
	const visualState = getToolVisualState(context);
	if (visualState || context?.isPartial !== false) return visualState;
	const settledState: ToolVisualState = context?.isError ? "error" : "success";
	setToolVisualState(context, settledState);
	return settledState;
}

function toolIconColor(context: any): "accent" | "error" | "success" | "muted" {
	const visualState = getToolVisualState(context);
	if (context?.isError || visualState === "error") return "error";
	if (visualState === "success") return "success";
	if (context?.isPartial || context?.executionStarted || visualState === "pending") return "accent";
	return "muted";
}

function isToolExpanded(options: any, context: any): boolean {
	const local = context?.state?.ccstyleToolExpanded;
	return typeof local === "boolean" ? local : Boolean(options?.expanded ?? context?.expanded);
}

/** Keep the guide aligned when long result lines wrap at the viewport edge. */
export class ExpandedToolResultText {
	private text: string;
	private prefix: string;
	private normalizedText: string;
	private cachedWidth: number | undefined;
	private cachedLines: string[] | undefined;

	constructor(text: string, prefix: string) {
		this.text = text;
		this.prefix = prefix;
		this.normalizedText = text.replace(/\t/g, "   ").replace(/\n+$/, "");
	}

	setText(text: string): void {
		if (this.text === text) return;
		this.text = text;
		this.normalizedText = text.replace(/\t/g, "   ").replace(/\n+$/, "");
		this.invalidate();
	}

	setPrefix(prefix: string): void {
		if (this.prefix === prefix) return;
		this.prefix = prefix;
		this.invalidate();
	}

	render(width: number): string[] {
		if (this.cachedLines !== undefined && this.cachedWidth === width) return this.cachedLines;

		const prefixWidth = visibleWidth(this.prefix);
		const contentWidth = Math.max(1, width - prefixWidth);
		const lines = wrapTextWithAnsi(this.normalizedText, contentWidth)
			.map((line) => truncateToWidth(this.prefix + line, width, ""));
		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}
}

function renderCollapsedToolResult(body: string, collapsedHint = ""): string {
	return `  ⎿ ${body}${collapsedHint}`;
}

function renderExpandedToolResult(
	body: string,
	theme: any,
	isError: boolean,
	lastComponent?: unknown,
): ExpandedToolResultText | Text {
	const color = isError ? "error" : "muted";
	if (!body.trim()) {
		return new Text(theme.fg(color, renderCollapsedToolResult("Done")), 0, 0);
	}

	const text = theme.fg(color, body);
	const prefix = theme.fg(color, "  │ ");
	if (lastComponent instanceof ExpandedToolResultText) {
		lastComponent.setText(text);
		lastComponent.setPrefix(prefix);
		return lastComponent;
	}
	return new ExpandedToolResultText(text, prefix);
}

function expandHint(theme: any): string {
	// Keep interaction guidance neutral; it should not inherit success/error
	// coloring from the tool result surrounding it.
	return `${theme.fg("muted", " (")}${keyHint("app.tools.expand", "expand")}${theme.fg("muted", " / click)")}`;
}

type SgrMousePacket = {
	code: number;
	col: number;
	row: number;
	final: "M" | "m";
};

type ToolRenderHit = {
	component: any;
	start: number;
	end: number;
};

const TOOL_MOUSE_WIDGET_KEY = "ccstyle-tool-mouse";
const TOOL_MOUSE_ENABLE = "\x1b[?1000h\x1b[?1006h";
const TOOL_MOUSE_DISABLE = "\x1b[?1006l\x1b[?1000l";
const ZENTUI_PAGE_UP_INPUT = /^\x1b\[5;9(?::[12])?~$|^\x1b\[57421;9(?::[12])?u$|^\x1b\[1;6A$/;
const ZENTUI_PAGE_DOWN_INPUT = /^\x1b\[6;9(?::[12])?~$|^\x1b\[57422;9(?::[12])?u$|^\x1b\[1;6B$/;
const SCROLL_BOTTOM_SHORTCUT = "ctrl+end";
let toolMouseTui: any = null;
let toolMouseUi: any = null;
let toolMouseInputUnsubscribe: (() => void) | null = null;
let toolMouseInputPatchTui: any = null;
let toolMouseInputPatchOriginalHandle: ((...args: any[]) => any) | null = null;
let toolMouseInputPatchWrapper: ((...args: any[]) => any) | null = null;
let scrollButtonVisible = false;
let scrollButtonWidget: any = null;
let pendingScrollMessages = 0;
let assistantMessageActive = false;
let scrollButtonSyncScheduled = false;
let sessionRenderTimer: ReturnType<typeof setTimeout> | null = null;

function parseSgrMousePackets(data: string): SgrMousePacket[] | null {
	const pattern = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;
	const packets: SgrMousePacket[] = [];
	let offset = 0;

	for (const match of data.matchAll(pattern)) {
		if (match.index !== offset) return null;
		offset = match.index + match[0].length;
		packets.push({
			code: Number(match[1]),
			col: Number(match[2]),
			row: Number(match[3]),
			final: match[4] as "M" | "m",
		});
	}

	return packets.length > 0 && offset === data.length ? packets : null;
}

function isSgrLeftPress(packet: SgrMousePacket): boolean {
	const baseButton = packet.code & ~(4 | 8 | 16 | 32);
	return packet.final === "M" && baseButton === 0 && (packet.code & 32) === 0;
}

function stripTerminalSequences(value: string): string {
	return value
		.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
		.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
		.replace(/\s+/g, " ")
		.trim();
}

function isToolExecutionComponent(value: any): boolean {
	return Boolean(
		value
		&& typeof value === "object"
		&& typeof value.toolCallId === "string"
		&& typeof value.setExpanded === "function"
		&& typeof value.render === "function",
	);
}

function renderedLineCount(component: any, width: number, cache: WeakMap<object, number>): number {
	if (!component || typeof component !== "object") return 0;
	const cached = cache.get(component);
	if (cached !== undefined) return cached;

	let count = 0;
	try {
		const lines = component.render(width);
		count = Array.isArray(lines) ? lines.length : 0;
	} catch {
		count = 0;
	}
	cache.set(component, count);
	return count;
}

function collectToolRenderHits(
	component: any,
	start: number,
	width: number,
	hits: ToolRenderHit[],
	cache: WeakMap<object, number>,
	seen: Set<object>,
): number {
	if (!component || typeof component !== "object" || seen.has(component)) return start;
	seen.add(component);

	const count = renderedLineCount(component, width, cache);
	if (isToolExecutionComponent(component)) {
		if (count > 0) hits.push({ component, start, end: start + count });
		return start + count;
	}

	let childStart = start;
	if (Array.isArray(component.children)) {
		for (const child of component.children) {
			collectToolRenderHits(child, childStart, width, hits, cache, seen);
			childStart += renderedLineCount(child, width, cache);
		}
	}
	return start + count;
}

function collectToolComponents(component: any, tools: any[], seen = new Set<any>()): void {
	if (!component || typeof component !== "object" || seen.has(component)) return;
	seen.add(component);
	if (isToolExecutionComponent(component)) {
		tools.push(component);
		return;
	}
	if (!Array.isArray(component.children)) return;
	for (const child of component.children) collectToolComponents(child, tools, seen);
}

function fixedEditorLineMatch(rendered: string, visible: string): boolean {
	return rendered === visible
		|| (visible.length >= 8 && (rendered.includes(visible) || visible.includes(rendered)));
}

function fixedEditorContextScore(
	renderedLines: string[],
	renderedRow: number,
	visibleLines: string[],
	visibleRow: number,
): number {
	let score = renderedLines[renderedRow] === visibleLines[visibleRow] ? 100 : 50;
	for (const direction of [-1, 1]) {
		for (let distance = 1; distance <= 4; distance++) {
			const candidate = renderedLines[renderedRow + direction * distance];
			const visible = visibleLines[visibleRow + direction * distance];
			if (candidate === undefined || visible === undefined || candidate !== visible) break;
			score += 5 - distance;
		}
	}
	return score;
}

function findToolAtFixedEditorRow(
	tui: any,
	visibleRow: number,
	previousLines: string[],
	width: number,
): ToolRenderHit | null {
	if (visibleRow < 0 || visibleRow >= previousLines.length) return null;
	const visibleLines = previousLines.map((line) => stripTerminalSequences(String(line)));
	const clickedLine = visibleLines[visibleRow] ?? "";
	if (!clickedLine) return null;

	const tools: any[] = [];
	collectToolComponents(tui, tools);
	let best: { hit: ToolRenderHit; score: number } | null = null;
	for (const component of tools) {
		const expanded = Boolean(component.expanded);
		if (!expanded && !/(?:expand|\/ click)/i.test(clickedLine)) continue;
		const renderedLines = renderComponentTree(component, width)
			.map((line) => stripTerminalSequences(String(line)));
		for (let renderedRow = 0; renderedRow < renderedLines.length; renderedRow++) {
			if (!fixedEditorLineMatch(renderedLines[renderedRow] ?? "", clickedLine)) continue;
			const score = fixedEditorContextScore(renderedLines, renderedRow, visibleLines, visibleRow);
			if (!best || score > best.score) {
				best = {
					hit: { component, start: visibleRow, end: visibleRow + renderedLines.length },
					score,
				};
			}
		}
	}
	return best?.hit ?? null;
}

function findToolAtScreenRow(tui: any, screenRow: number): ToolRenderHit | null {
	const previousLines = Array.isArray(tui?.previousLines) ? tui.previousLines : [];
	const width = Math.max(1, Number(tui?.terminal?.columns) || 80);
	if (isFixedEditorTui(tui)) {
		// Zentui replaces Pi's root render with the already-sliced visible
		// transcript. previousViewportTop remains cursor bookkeeping and must not
		// be added to a physical mouse row here.
		return findToolAtFixedEditorRow(tui, screenRow - 1, previousLines, width);
	}
	const viewportTop = Number.isFinite(tui?.previousViewportTop) ? tui.previousViewportTop : 0;
	const bufferRow = viewportTop + screenRow - 1;
	if (bufferRow < 0 || bufferRow >= previousLines.length) return null;

	const hits: ToolRenderHit[] = [];
	const cache = new WeakMap<object, number>();
	collectToolRenderHits(tui, 0, width, hits, cache, new Set<object>());

	const clickedLine = stripTerminalSequences(String(previousLines[bufferRow] ?? ""));
	for (const hit of hits) {
		if (bufferRow < hit.start || bufferRow >= hit.end) continue;
		const component = hit.component;
		const expanded = Boolean(component.expanded);
		// Match Pi's old click contract: collapsed results expose a click hint;
		// expanded results can be collapsed by clicking any rendered line.
		if (!expanded && !/(?:expand|\/ click)/i.test(clickedLine)) continue;
		return hit;
	}
	return null;
}

function isFixedEditorTui(tui: any): boolean {
	const terminal = tui?.terminal;
	if (!terminal) return false;
	const ownRows = Object.getOwnPropertyDescriptor(terminal, "rows");
	const prototype = Object.getPrototypeOf(terminal);
	const inheritedRows = prototype
		? Object.getOwnPropertyDescriptor(prototype, "rows")
		: undefined;
	return typeof ownRows?.get === "function" && ownRows.get !== inheritedRows?.get;
}

function formatShortcut(shortcut: string): string {
	return shortcut
		.split("+")
		.map((part) => part.length <= 1 ? part.toUpperCase() : `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
		.join("+");
}

function isScrollBottomInput(data: string): boolean {
	return matchesKey(data, SCROLL_BOTTOM_SHORTCUT);
}

function isScrollNavigationInput(data: string): boolean {
	if (
		matchesKey(data, "pageUp")
		|| matchesKey(data, "pageDown")
		|| ZENTUI_PAGE_UP_INPUT.test(data)
		|| ZENTUI_PAGE_DOWN_INPUT.test(data)
	) {
		return true;
	}
	const packets = parseSgrMousePackets(data);
	return Boolean(packets?.some((packet) => {
		const baseButton = packet.code & ~(4 | 8 | 16 | 32);
		return packet.final === "M" && (baseButton === 64 || baseButton === 65);
	}));
}

function directRenderLines(component: any, width: number): string[] {
	try {
		const lines = component?.render?.(width);
		return Array.isArray(lines) ? lines : [];
	} catch {
		return [];
	}
}

/** Render only the transcript portion that fixed-editor leaves scrollable. */
function renderFixedScrollableRoot(tui: any, width: number): string[] {
	const children = Array.isArray(tui?.children) ? tui.children : [];
	const editorIndex = children.findIndex((child: any) =>
		containsEditorLike(child, tui.focusedComponent),
	);
	const end = editorIndex >= 2 ? editorIndex - 2 : children.length;
	return children.slice(0, end).flatMap((child: any) => directRenderLines(child, width));
}

function isFixedEditorAtBottom(tui: any): boolean {
	if (!isFixedEditorTui(tui)) return true;
	const visibleLines = Array.isArray(tui?.previousLines) ? tui.previousLines : [];
	if (visibleLines.length === 0) return true;
	const width = Math.max(1, Number(tui?.terminal?.columns) || 80);
	const rootLines = renderFixedScrollableRoot(tui, width);
	if (rootLines.length <= visibleLines.length) return true;
	const tail = rootLines.slice(-visibleLines.length);
	return tail.every((line, index) =>
		stripTerminalSequences(String(line)) === stripTerminalSequences(String(visibleLines[index] ?? "")),
	);
}

function hideScrollButton(tui: any): void {
	const changed = scrollButtonVisible || pendingScrollMessages > 0;
	scrollButtonVisible = false;
	pendingScrollMessages = 0;
	if (changed) tui.requestRender?.();
}

function scheduleScrollButtonSync(tui: any, data: string): void {
	if (!isScrollNavigationInput(data) || scrollButtonSyncScheduled) return;
	scrollButtonSyncScheduled = true;
	const previousLines = tui.previousLines;
	const check = (attempt: number) => {
		scrollButtonSyncScheduled = false;
		if (toolMouseTui !== tui) return;
		// Pi renders on its own frame timer. Inspect the resulting viewport before
		// showing the button so empty or non-scrollable transcripts never flash it.
		const rendered = tui.previousLines !== previousLines;
		if (!rendered && attempt < 4) {
			scrollButtonSyncScheduled = true;
			const timer = setTimeout(() => check(attempt + 1), 16);
			if (typeof timer === "object" && timer !== null && "unref" in timer) {
				(timer as { unref: () => void }).unref();
			}
			return;
		}
		const nextVisible = !isFixedEditorAtBottom(tui);
		if (!nextVisible) pendingScrollMessages = 0;
		if (nextVisible !== scrollButtonVisible) {
			scrollButtonVisible = nextVisible;
			tui.requestRender?.();
		}
	};
	process.nextTick(() => check(0));
}

function updateScrollButtonFromInput(tui: any, data: string): void {
	if (!isFixedEditorTui(tui)) return;
	if (matchesKey(data, "enter") || matchesKey(data, "return") || isScrollBottomInput(data)) {
		hideScrollButton(tui);
	}
}

function renderComponentTree(component: any, width: number): string[] {
	if (!component || typeof component !== "object") return [];
	try {
		const lines = component.render?.(width);
		if (Array.isArray(lines) && lines.length > 0) return lines;
	} catch {
		// Fall through to children for hidden container renderers.
	}
	if (!Array.isArray(component.children)) return [];
	return component.children.flatMap((child: any) => renderComponentTree(child, width));
}

function renderTreeWithTarget(
	component: any,
	target: any,
	width: number,
	seen = new Set<any>(),
): { lines: string[]; targetStart: number | null } {
	if (!component || typeof component !== "object" || seen.has(component)) {
		return { lines: [], targetStart: null };
	}
	seen.add(component);
	if (component === target) {
		return { lines: renderComponentTree(component, width), targetStart: 0 };
	}

	if (Array.isArray(component.children)) {
		const lines: string[] = [];
		let targetStart: number | null = null;
		for (const child of component.children) {
			const result = renderTreeWithTarget(child, target, width, seen);
			if (result.targetStart !== null) targetStart = lines.length + result.targetStart;
			lines.push(...result.lines);
		}
		if (targetStart !== null) return { lines, targetStart };
	}

	return { lines: renderComponentTree(component, width), targetStart: null };
}

function normalizedClusterLines(component: any, width: number): string[] {
	if (!component) return [];
	const lines = renderComponentTree(component, width);
	let end = lines.length;
	while (end > 0 && visibleWidth(lines[end - 1] ?? "") === 0) end--;
	return lines.slice(0, Math.max(end, 1));
}

function rawTerminalRows(tui: any): number {
	const terminal = tui?.terminal;
	if (!terminal) return 0;
	const prototype = Object.getPrototypeOf(terminal);
	const rows = prototype ? Object.getOwnPropertyDescriptor(prototype, "rows") : undefined;
	if (typeof rows?.get === "function") {
		try {
			const value = rows.get.call(terminal);
			if (typeof value === "number" && Number.isFinite(value)) return value;
		} catch {
			// Fall through to the current terminal value.
		}
	}
	return typeof terminal.rows === "number" && Number.isFinite(terminal.rows) ? terminal.rows : 0;
}

function containsEditorLike(component: any, focused: any, seen = new Set<any>()): boolean {
	if (!component || typeof component !== "object" || seen.has(component)) return false;
	seen.add(component);
	if (component === focused) return true;
	if (
		typeof component.getText === "function"
		&& typeof component.setText === "function"
		&& typeof component.handleInput === "function"
	) return true;
	return Array.isArray(component.children)
		&& component.children.some((child: any) => containsEditorLike(child, focused, seen));
}

function scrollButtonScreenRow(tui: any, width: number): number | null {
	if (!scrollButtonVisible || !isFixedEditorTui(tui) || !scrollButtonWidget) return null;
	const children = Array.isArray(tui?.children) ? tui.children : [];
	const editorIndex = children.findIndex((child: any) =>
		containsEditorLike(child, tui.focusedComponent),
	);
	if (editorIndex < 2 || editorIndex + 2 >= children.length) return null;

	const above = children[editorIndex - 1];
	const widthValue = Math.max(1, width || Number(tui?.terminal?.columns) || 80);
	const target = renderTreeWithTarget(above, scrollButtonWidget, widthValue);
	if (target.targetStart === null) return null;

	const rawRows = rawTerminalRows(tui);
	if (rawRows <= 0) return null;
	const maxRows = Math.max(1, rawRows - 1);
	const status = normalizedClusterLines(children[editorIndex - 2], widthValue);
	const editor = normalizedClusterLines(children[editorIndex], widthValue);
	const below = normalizedClusterLines(children[editorIndex + 1], widthValue);
	const footer = normalizedClusterLines(children[editorIndex + 2], widthValue);
	const aboveLines = target.lines.length > 0 ? target.lines : normalizedClusterLines(above, widthValue);

	const takeLast = (lines: string[], count: number): string[] =>
		count > 0 ? lines.slice(-count) : [];
	const editorVisible = takeLast(editor, Math.min(editor.length, maxRows));
	let remaining = Math.max(0, maxRows - editorVisible.length);
	const footerVisible = takeLast(footer, remaining);
	remaining -= footerVisible.length;
	const belowVisible = takeLast(below, remaining);
	remaining -= belowVisible.length;
	const aboveVisible = takeLast(aboveLines, remaining);
	const statusVisible = takeLast(status, Math.max(0, remaining - aboveVisible.length));
	const aboveStart = aboveLines.length - aboveVisible.length;
	const targetRow = target.targetStart - aboveStart;
	if (targetRow < 0 || targetRow >= aboveVisible.length) return null;

	const allLines = [...statusVisible, ...aboveVisible, ...editorVisible, ...belowVisible, ...footerVisible];
	let leadingBlank = 0;
	while (leadingBlank < allLines.length - 1 && visibleWidth(allLines[leadingBlank] ?? "") === 0) {
		leadingBlank++;
	}
	const clusterRow = statusVisible.length + targetRow - leadingBlank;
	if (clusterRow < 0 || clusterRow >= allLines.length - leadingBlank) return null;
	return rawRows - allLines.length + clusterRow + 1;
}

function isScrollButtonAtScreenRow(tui: any, packet: SgrMousePacket): boolean {
	const width = Math.max(1, Number(tui?.terminal?.columns) || 80);
	if (scrollButtonScreenRow(tui, width) !== packet.row || !scrollButtonWidget) return false;
	const rendered = scrollButtonWidget.render?.(width)?.[0];
	if (typeof rendered !== "string") return false;
	const plain = rendered
		.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
		.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
	const leading = plain.length - plain.trimStart().length;
	const end = visibleWidth(plain.trimEnd());
	return packet.col >= leading + 1 && packet.col <= end;
}

function jumpToBottomWithoutSubmit(tui: any): boolean {
	const originalHandle = toolMouseInputPatchTui === tui
		? toolMouseInputPatchOriginalHandle
		: null;
	if (!originalHandle) return false;

	// Route Enter through Pi's normal listener chain so pi-zentui can update its
	// private scroll offset, but suppress the focused editor for this synthetic
	// dispatch so clicking the button never submits the current input.
	const focused = tui.focusedComponent;
	try {
		tui.focusedComponent = null;
		Reflect.apply(originalHandle, tui, ["\r"]);
	} finally {
		tui.focusedComponent = focused;
	}
	hideScrollButton(tui);
	return true;
}

function handleScrollButtonClick(tui: any, packet: SgrMousePacket): boolean {
	if (!isScrollButtonAtScreenRow(tui, packet)) return false;
	return jumpToBottomWithoutSubmit(tui);
}

function toggleToolAtMouseClick(tui: any, packet: SgrMousePacket): boolean {
	const hit = findToolAtScreenRow(tui, packet.row);
	if (!hit) return false;

	const nextExpanded = !Boolean(hit.component.expanded);
	hit.component.setExpanded(nextExpanded);
	hit.component.invalidate?.();
	tui.requestRender?.();
	return true;
}

function renderScrollButton(width: number, theme: any): string[] {
	if (!scrollButtonVisible || !isFixedEditorTui(toolMouseTui)) return [];
	const shortcut = formatShortcut(SCROLL_BOTTOM_SHORTCUT);
	const messageText = pendingScrollMessages > 0
		? `${pendingScrollMessages} new message${pendingScrollMessages === 1 ? "" : "s"}`
		: "Back to bottom";
	const label = theme.fg("accent", `[ ↓ ${messageText} · ${shortcut} · click ]`);
	const leftPad = Math.max(0, Math.floor((width - visibleWidth(label)) / 2));
	return [`${" ".repeat(leftPad)}${truncateToWidth(label, width, "…")}`];
}

/**
 * pi-zentui consumes left-button presses for text selection. Intercept only a
 * tool-row click at the TUI input boundary, before extension listeners run.
 * Keyboard, wheel, drag, release, and non-tool clicks continue through Pi's
 * original dispatcher, preserving pi-zentui's scroll-to-bottom behavior.
 */
function patchToolMouseInputCapture(tui: any): void {
	if (toolMouseInputPatchTui === tui) return;

	restoreToolMouseInputCapture();
	const originalHandle = tui?.handleInput;
	if (typeof originalHandle !== "function") return;

	const wrapper = function (this: any, ...args: any[]): any {
		const data = args[0];
		if (typeof data === "string") {
			updateScrollButtonFromInput(this, data);
			// Capture the current viewport before Pi/Zentui applies the scroll input.
			scheduleScrollButtonSync(this, data);
			if (isFixedEditorTui(this) && isScrollBottomInput(data) && jumpToBottomWithoutSubmit(this)) return;
			const packets = parseSgrMousePackets(data);
			if (packets) {
				for (const packet of packets) {
					if (!isSgrLeftPress(packet)) continue;
					if (handleScrollButtonClick(this, packet) || toggleToolAtMouseClick(this, packet)) return;
				}
			}
		}
		const result = Reflect.apply(originalHandle, this, args);
		if (typeof data === "string") scheduleScrollButtonSync(this, data);
		return result;
	};

	try {
		tui.handleInput = wrapper;
	} catch {
		return;
	}
	toolMouseInputPatchTui = tui;
	toolMouseInputPatchOriginalHandle = originalHandle;
	toolMouseInputPatchWrapper = wrapper;
}

function restoreToolMouseInputCapture(): void {
	if (
		toolMouseInputPatchTui
		&& toolMouseInputPatchOriginalHandle
		&& toolMouseInputPatchTui.handleInput === toolMouseInputPatchWrapper
	) {
		toolMouseInputPatchTui.handleInput = toolMouseInputPatchOriginalHandle;
	}
	toolMouseInputPatchTui = null;
	toolMouseInputPatchOriginalHandle = null;
	toolMouseInputPatchWrapper = null;
}

function handleToolMouseInput(data: string): { consume: true } | undefined {
	if (!toolMouseTui) return undefined;
	updateScrollButtonFromInput(toolMouseTui, data);
	if (isFixedEditorTui(toolMouseTui) && isScrollBottomInput(data) && jumpToBottomWithoutSubmit(toolMouseTui)) {
		return { consume: true };
	}
	const packets = parseSgrMousePackets(data);
	if (!packets) {
		scheduleScrollButtonSync(toolMouseTui, data);
		return undefined;
	}

	let consumed = false;
	for (const packet of packets) {
		if (!isSgrLeftPress(packet)) continue;
		if (handleScrollButtonClick(toolMouseTui, packet) || toggleToolAtMouseClick(toolMouseTui, packet)) {
			consumed = true;
		}
	}

	// Let scrolling, motion, release, and clicks outside tool results reach the
	// normal TUI input chain (including other extensions such as pi-zentui).
	scheduleScrollButtonSync(toolMouseTui, data);
	return consumed ? { consume: true } : undefined;
}

function teardownToolMouseInteraction(): void {
	if (sessionRenderTimer) {
		clearTimeout(sessionRenderTimer);
		sessionRenderTimer = null;
	}
	toolMouseInputUnsubscribe?.();
	toolMouseInputUnsubscribe = null;
	try {
		toolMouseTui?.terminal?.write?.(TOOL_MOUSE_DISABLE);
	} catch {
		// The terminal may already be closed during shutdown.
	}
	try {
		toolMouseUi?.setWidget?.(TOOL_MOUSE_WIDGET_KEY, undefined);
	} catch {
		// The UI context may already have been reset during /reload.
	}
	restoreToolMouseInputCapture();
	scrollButtonVisible = false;
	scrollButtonWidget = null;
	pendingScrollMessages = 0;
	assistantMessageActive = false;
	scrollButtonSyncScheduled = false;
	toolMouseTui = null;
	toolMouseUi = null;
}

function installToolMouseInteraction(ctx: any): void {
	teardownToolMouseInteraction();
	if (ctx?.mode !== "tui" || !ctx?.hasUI) return;
	if (typeof ctx.ui?.onTerminalInput !== "function" || typeof ctx.ui?.setWidget !== "function") return;

	toolMouseUi = ctx.ui;
	ctx.ui.setWidget(TOOL_MOUSE_WIDGET_KEY, (tui: any, theme: any) => {
		toolMouseTui = tui;
		patchToolMouseInputCapture(tui);
		tui?.terminal?.write?.(TOOL_MOUSE_ENABLE);
		const widget = {
			render: (width: number) => renderScrollButton(width, theme),
			invalidate() {},
		};
		scrollButtonWidget = widget;
		return widget;
	});
	toolMouseInputUnsubscribe = ctx.ui.onTerminalInput(handleToolMouseInput);
}

function scheduleSessionRender(): void {
	const tui = toolMouseTui;
	if (!tui || typeof tui.requestRender !== "function") return;
	if (sessionRenderTimer) clearTimeout(sessionRenderTimer);
	// Restored transcripts are populated at different points for startup, reload,
	// and session replacement. Repaint after session_start and the surrounding UI
	// rebuild finish so messages are not left hidden until the next terminal input.
	sessionRenderTimer = setTimeout(() => {
		sessionRenderTimer = null;
		if (toolMouseTui === tui) tui.requestRender(true);
	}, 0);
}

// Bright green for success icon (truecolor ANSI escape)
const BRIGHT_GREEN = "\x1b[38;2;80;220;100m";
const ANSI_RESET = "\x1b[0m";

function applyEnabledState(enabled: boolean, ctx: any): void {
	config.enabled = enabled;
	saveConfig();
	ctx.ui.notify(`Claude Code style: ${enabled ? "on" : "off"}`, "info");
}

async function showCcstylePanel(ctx: any): Promise<void> {
	if (ctx?.mode !== "tui" || !ctx?.hasUI || typeof ctx.ui?.custom !== "function") {
		ctx.ui?.notify?.("/ccstyle requires TUI mode", "warning");
		return;
	}

	await ctx.ui.custom((tui: any, theme: any, _keybindings: any, done: (value?: void) => void) => {
		const container = new Container();
		container.addChild(new Text(theme.fg("accent", theme.bold("Claude Code Style")), 1, 1));
		const settingsList = new SettingsList(
			[{
				id: "enabled",
				label: "Output style",
				description: "Use compact Claude Code-like tool rendering",
				currentValue: config.enabled ? "on" : "off",
				values: ["on", "off"],
			}],
			3,
			getSettingsListTheme(),
			(id: string, newValue: string) => {
				if (id !== "enabled" || (newValue !== "on" && newValue !== "off")) return;
				applyEnabledState(newValue === "on", ctx);
				settingsList.updateValue(id, newValue);
				tui.requestRender();
			},
			() => done(),
		);
		container.addChild(settingsList);
		return {
			render: (width: number) => container.render(width),
			invalidate: () => container.invalidate(),
			handleInput(data: string) {
				settingsList.handleInput?.(data);
				tui.requestRender();
			},
		};
	});
}

function renderDefault(tool: any, slot: "renderCall" | "renderResult", args: any[], fallback = "") {
	try {
		if (typeof tool?.[slot] === "function") return tool[slot](...args);
	} catch {
		// Fall through to raw fallback.
	}
	return new Text(fallback, 0, 0);
}

/**
 * Generate a descriptive label for an unknown tool from its args.
 * Uses the tool label + first stringable arg value.
 */
function toolCallLabel(toolName: string, toolLabel: string, args: any): string {
	if (!args) return toolLabel;
	const keys = Object.keys(args);
	if (keys.length === 0) return toolLabel;
	// Prefer "query" or "question" args, then fall back to the first stringable value
	const preferred = ["query", "question", "command", "pattern", "name", "path", "url", "message"];
	for (const key of preferred) {
		const val = args[key];
		if (val !== undefined && val !== null && typeof val !== "object") {
			return `${toolLabel}(${oneLine(val, 60)})`;
		}
	}
	const firstKey = keys[0];
	const firstVal = args[firstKey];
	if (firstVal !== undefined && firstVal !== null && typeof firstVal !== "object") {
		return `${toolLabel}(${oneLine(firstVal, 60)})`;
	}
	return toolLabel;
}

/** Wrap an arbitrary tool definition with ccstyle call/result rendering. */
function createCcstyleTool(originalTool: any): any {
	const toolName = originalTool.name;
	const label = isMcpToolDefinition(originalTool, toolName)
		? toolName
		: originalTool.label || toolName;

	return {
		...originalTool,
		renderShell: "self",
		renderCall(args: any, theme: any, context: any) {
			if (!config.enabled) {
				return renderDefault(originalTool, "renderCall", [args, theme, context], String(toolName));
			}

			const visualState = resolveToolVisualState(context);
			const isPending =
				visualState === "pending" ||
				(!visualState && (context?.isPartial || context?.executionStarted));
			if (isPending) scheduleAnimation(context);
			const rawIcon = isPending ? pendingIcon(toolName) : settledIcon(toolName, visualState);
			const icon =
				visualState === "success"
					? `${BRIGHT_GREEN}${rawIcon}${ANSI_RESET}`
					: theme.fg(toolIconColor(context), rawIcon);

			const title = `${icon} ${theme.fg("toolTitle", toolCallLabel(toolName, label, args))}`;
			return new Text(title, 0, 0);
		},
		renderResult(result: any, options: any, theme: any, context: any) {
			if (!config.enabled) {
				return renderDefault(originalTool, "renderResult", [result, options, theme, context], textFromResult(result));
			}

			if (options?.isPartial) {
				return new Text(theme.fg("muted", "  ⎿ Pending…"), 0, 0);
			}

			const isError = options?.isError || context?.isError;
			setToolVisualState(context, isError ? "error" : "success");
			const expanded = isToolExpanded(options, context);

			const text = textFromResult(result);
			const rendered = !expanded ? (text ? oneLine(text, 96) : "Done") : text;

			const hint = !expanded && hasExpandableResult(text) ? expandHint(theme) : "";
			if (expanded) return renderExpandedToolResult(rendered, theme, isError, context?.lastComponent);
			return new Text(
				theme.fg(isError ? "error" : "muted", renderCollapsedToolResult(rendered, hint)),
				0,
				0,
			);
		},
	};
}

/**
 * This extension does not register tools. ToolExecutionComponent is shared by
 * the TUI and exported by pi; patch its renderer lookup once so tools use the
 * same compact fallback shell by default. Tools named in excludeRenderers keep
 * their original renderer; subagent rendering remains protected.
 */
const GLOBAL_TOOL_RENDER_PATCH = Symbol.for("pi.ccstyle.global-tool-render-patch");
const COMPONENT_TOOL_RENDER_MODE = Symbol.for("pi.ccstyle.component-tool-render-mode");
const COMPONENT_TOOL_SELF_SHELL_MODE = Symbol.for("pi.ccstyle.component-tool-self-shell-mode");
const SUBAGENT_TOOL_NAMES = new Set(["Agent"]);
const globalToolRenderOwner = {};

type GlobalToolRenderPatch = {
	prototype: any;
	owner: object;
	enabled: () => boolean;
	wrap: (tool: any) => any;
	byDefinition: WeakMap<object, any>;
	byName: Map<string, any>;
	originalHasRendererDefinition: (...args: any[]) => boolean;
	originalGetRenderShell: (...args: any[]) => "default" | "self";
	originalGetCallRenderer: (...args: any[]) => any;
	originalGetResultRenderer: (...args: any[]) => any;
};

function isMcpToolDefinition(definition: any, toolName: string): boolean {
	const label = typeof definition?.label === "string" ? definition.label : "";
	return toolName === "mcp" || label === "MCP" || label.startsWith("MCP: ");
}

/** Return true when this tool must keep its original renderer. */
export function preservesOriginalRenderer(
	extensionDefinition: any,
	toolName: string,
	builtInToolDefinition?: any,
	excludeRenderers: readonly string[] = config.excludeRenderers,
): boolean {
	if (SUBAGENT_TOOL_NAMES.has(toolName)) return true;
	if (!excludeRenderers.includes(toolName)) return false;
	return [extensionDefinition, builtInToolDefinition].some((definition) =>
		definition?.renderShell === "self"
		|| typeof definition?.renderCall === "function"
		|| typeof definition?.renderResult === "function",
	);
}

function shouldGloballyStyleTool(component: any, patch: GlobalToolRenderPatch): boolean {
	const selectedMode = component[COMPONENT_TOOL_RENDER_MODE];
	if (typeof selectedMode === "boolean") return selectedMode;

	const extensionDefinition = component.toolDefinition;
	const builtInDefinition = component.builtInToolDefinition;
	const definition = extensionDefinition ?? builtInDefinition;
	const toolName = String(component.toolName || definition?.name || "");
	const useCcstyle =
		patch.enabled() &&
		!preservesOriginalRenderer(extensionDefinition, toolName, builtInDefinition);
	// ToolExecutionComponent chooses its child shell in the constructor. Keep that
	// choice stable for this row so toggling ccstyle cannot switch containers later.
	component[COMPONENT_TOOL_RENDER_MODE] = useCcstyle;
	return useCcstyle;
}

function shouldUseSelfShell(component: any, patch: GlobalToolRenderPatch): boolean {
	const selectedMode = component[COMPONENT_TOOL_SELF_SHELL_MODE];
	if (typeof selectedMode === "boolean") return selectedMode;

	const definition = component.toolDefinition ?? component.builtInToolDefinition;
	const toolName = String(component.toolName || definition?.name || "");
	const useSelfShell =
		patch.enabled() &&
		SUBAGENT_TOOL_NAMES.has(toolName) &&
		definition?.renderShell !== "self";
	component[COMPONENT_TOOL_SELF_SHELL_MODE] = useSelfShell;
	return useSelfShell;
}

function getGloballyStyledTool(component: any, patch: GlobalToolRenderPatch): any {
	const definition = component.toolDefinition ?? component.builtInToolDefinition;
	if (definition && typeof definition === "object") {
		let wrapped = patch.byDefinition.get(definition);
		if (!wrapped) {
			wrapped = patch.wrap(definition);
			patch.byDefinition.set(definition, wrapped);
		}
		return wrapped;
	}

	const name = String(component.toolName || "tool");
	let wrapped = patch.byName.get(name);
	if (!wrapped) {
		wrapped = patch.wrap({ name, label: name });
		patch.byName.set(name, wrapped);
	}
	return wrapped;
}

function installGlobalToolRendering() {
	const prototype = (ToolExecutionComponent as any).prototype;
	const host = globalThis as any;
	let patch = host[GLOBAL_TOOL_RENDER_PATCH] as GlobalToolRenderPatch | undefined;

	if (!patch || patch.prototype !== prototype) {
		patch = {
			prototype,
			owner: globalToolRenderOwner,
			enabled: () => config.enabled,
			wrap: createCcstyleTool,
			byDefinition: new WeakMap(),
			byName: new Map(),
			originalHasRendererDefinition: prototype.hasRendererDefinition,
			originalGetRenderShell: prototype.getRenderShell,
			originalGetCallRenderer: prototype.getCallRenderer,
			originalGetResultRenderer: prototype.getResultRenderer,
		};

		host[GLOBAL_TOOL_RENDER_PATCH] = patch;
	}

	patch.owner = globalToolRenderOwner;
	patch.enabled = () => config.enabled;
	patch.wrap = createCcstyleTool;
	patch.byDefinition = new WeakMap();
	patch.byName.clear();

	// Rebind on every load. /reload preserves the shared prototype and global
	// patch object, so leaving these closures installed only in the initialization
	// branch would keep the previous extension version's rendering logic alive.
	prototype.hasRendererDefinition = function (...args: any[]) {
		if (shouldGloballyStyleTool(this, patch!)) return true;
		return patch!.originalHasRendererDefinition.apply(this, args);
	};
	prototype.getRenderShell = function (...args: any[]) {
		if (shouldUseSelfShell(this, patch!) || shouldGloballyStyleTool(this, patch!)) return "self";
		return patch!.originalGetRenderShell.apply(this, args);
	};
	prototype.getCallRenderer = function (...args: any[]) {
		if (shouldGloballyStyleTool(this, patch!)) return getGloballyStyledTool(this, patch!).renderCall;
		return patch!.originalGetCallRenderer.apply(this, args);
	};
	prototype.getResultRenderer = function (...args: any[]) {
		if (shouldGloballyStyleTool(this, patch!)) return getGloballyStyledTool(this, patch!).renderResult;
		return patch!.originalGetResultRenderer.apply(this, args);
	};
}

function deactivateGlobalToolRendering() {
	const patch = (globalThis as any)[GLOBAL_TOOL_RENDER_PATCH] as GlobalToolRenderPatch | undefined;
	if (patch?.owner !== globalToolRenderOwner) return;
	patch.enabled = () => false;
	patch.byDefinition = new WeakMap();
	patch.byName.clear();
}

const GLOBAL_COMPACTION_RENDER_PATCH = Symbol.for("pi.ccstyle.compaction-render-patch");

type LegacyCompactionRenderPatch = {
	enabled?: () => boolean;
};

/** Disable the pre-native compaction monkey patch left alive by /reload. */
function deactivateLegacyCompactionRendering() {
	const patch = (globalThis as any)[GLOBAL_COMPACTION_RENDER_PATCH] as LegacyCompactionRenderPatch | undefined;
	if (patch) patch.enabled = () => false;
}

function notePendingScrollMessage(role: unknown): void {
	if (!toolMouseTui || !isFixedEditorTui(toolMouseTui) || !scrollButtonVisible) return;
	if (role === "assistant") {
		if (assistantMessageActive) return;
		assistantMessageActive = true;
	} else if (role !== "toolResult") {
		return;
	}
	pendingScrollMessages += 1;
	toolMouseTui.requestRender?.();
}

export default function (pi: ExtensionAPI) {
	installGlobalToolRendering();
	deactivateLegacyCompactionRendering();

	pi.registerCommand("ccstyle", {
		description: "Configure Claude Code style",
		getArgumentCompletions: (prefix) => {
			const topLevel = [
				{ value: "on", label: "on", description: "Enable Claude Code style" },
				{ value: "off", label: "off", description: "Disable Claude Code style" },
				{ value: "status", label: "status", description: "Show current state" },
			];
			return topLevel.filter((item) => item.value.startsWith(prefix));
		},
		handler: async (args, ctx) => {
			const arg = args.trim().toLowerCase();
			if (!arg) {
				await showCcstylePanel(ctx);
				return;
			}
			if (arg === "on" || arg === "off") {
				applyEnabledState(arg === "on", ctx);
				return;
			}
			if (arg === "status") {
				ctx.ui.notify(`Claude Code style: ${config.enabled ? "on" : "off"}`, "info");
				return;
			}
			ctx.ui.notify("Usage: /ccstyle [on|off|status]", "warning");
		},
	});

	pi.registerShortcut("ctrl+shift+o", {
		description: "Toggle Claude Code-like output style",
		handler: async (ctx) => {
			config.enabled = !config.enabled;
			saveConfig();
			ctx.ui.notify(`Claude Code style: ${config.enabled ? "on" : "off"}`, "info");
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		pendingScrollMessages = 0;
		assistantMessageActive = false;
		ctx.ui.setStatus("ccstyle", undefined);
		installToolMouseInteraction(ctx);
		scheduleSessionRender();
	});

	pi.on("message_start", async (event) => {
		notePendingScrollMessage(event?.message?.role);
	});

	pi.on("message_update", async (event) => {
		if (event?.message?.role === "assistant") notePendingScrollMessage("assistant");
	});

	pi.on("message_end", async (event) => {
		if (event?.message?.role === "assistant") assistantMessageActive = false;
	});

	pi.on("session_shutdown", async () => {
		teardownToolMouseInteraction();
		deactivateGlobalToolRendering();
		deactivateLegacyCompactionRendering();
		clearAllAnimations();
	});

}
