import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { AssistantMessageComponent, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { homedir } from "node:os";
import { sanitizeToolResultText } from "./tool-result-sanitize.ts";

/**
 * Compact transcript rendering is adapted from pi-compact-transcript v0.6.2
 * (MIT, Alan Hagedorn). This module is internal so claude-code-style.ts remains
 * the package's only extension entry point.
 */

export type CompactStyleMode = "on" | "off" | "compact";

export type CompactStyleHost = {
	getMode: () => CompactStyleMode;
	getExcludeRenderers: () => readonly string[];
};

export type CompactRendererRoute = "claude" | "native" | "compact";

type ToolPrototypePatch = {
	prototype: any;
	active: boolean;
	originalUpdateDisplay: (...args: any[]) => any;
	originalRender: (...args: any[]) => any;
	patchedUpdateDisplay: (...args: any[]) => any;
	patchedRender: (...args: any[]) => any;
};

type AssistantPrototypePatch = {
	prototype: any;
	active: boolean;
	originalUpdateContent: (...args: any[]) => any;
	nativeUpdateContent: (...args: any[]) => any;
	patchedUpdateContent: (...args: any[]) => any;
};

type CompactInstallation = {
	active: boolean;
	toolPatch?: ToolPrototypePatch;
	assistantPatch?: AssistantPrototypePatch;
};

export function rendererRoute(
	mode: CompactStyleMode,
	toolName: string,
	excludeRenderers: readonly string[] = [],
): CompactRendererRoute {
	if (toolName === "Agent" || excludeRenderers.includes(toolName)) return "native";
	if (mode === "compact") return "compact";
	if (mode === "on") return "claude";
	return "native";
}

export function shouldUseCompactRenderer(
	mode: CompactStyleMode,
	toolName: string,
	excludeRenderers: readonly string[] = [],
): boolean {
	return rendererRoute(mode, toolName, excludeRenderers) === "compact";
}

type ToolInfo = {
	id: string;
	name: string;
	args: any;
	preview: string;
	hidden?: boolean;
	running?: boolean;
	burstCount?: number;
	startedAt?: number;
	durationMs?: number;
	burstDurationMs?: number;
	result?: string;
	isError?: boolean;
	invalidate?: () => void;
};

type RunStats = {
	startedAt: number;
	toolCount: number;
	readFiles: Set<string>;
	editFiles: Set<string>;
	commandCount: number;
	otherCount: number;
	failedCount: number;
};

export type CompactSummaryData = {
	reads: number;
	edits: number;
	commands: number;
	others: number;
	failed: number;
	durationMs: number;
};

type RuntimeState = {
	getMode: () => CompactStyleMode;
	getExcludeRenderers: () => readonly string[];
	pi?: ExtensionAPI;
	toolsById: Map<string, ToolInfo>;
	currentBurst: ToolInfo[];
	hiddenToolIds: Set<string>;
	runningToolIds: Set<string>;
	agentActive: boolean;
	blinkTimer?: ReturnType<typeof setInterval>;
	runStats: RunStats;
	toolComponents: Set<any>;
	assistantComponents: Set<any>;
	currentTheme?: Theme;
	lastTui?: any;
	thinkingHidden: boolean;
	currentThoughtHeading?: string;
	thoughtAnchorId?: string;
	activeInstallation?: CompactInstallation;
};

const SUMMARY_ENTRY_TYPE = "compact-transcript-summary";
const STATUS_KEY = "compact-transcript";
const MIN_PREVIEW_WIDTH = 20;
const MAX_PREVIEW_WIDTH = 104;
// Leave room for pi's row gutter/padding so compact lines never wrap.
const PREVIEW_MARGIN = 6;
// Keep the running marker in sync with Claude mode's braille loader.
const BLINK_INTERVAL_MS = 80;
const CLAUDE_LOADING_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const CLAUDE_LOADING_TOOLS = new Set(["read", "bash", "edit", "write", "find", "grep", "ls"]);
// Status marker is two cells wide ("✓ ", "✗ ", or the Claude-style running frame).
const MARKER_WIDTH = 2;
const STATE_KEY = Symbol.for("pi.ccstyle.compact-style.state");
const TOOL_PATCH_KEY = Symbol.for("pi.ccstyle.compact-style.tool-patch");
const ASSISTANT_PATCH_KEY = Symbol.for("pi.ccstyle.compact-style.assistant-patch");
const ASSISTANT_REENTRY_KEY = Symbol.for("pi.ccstyle.compact-style.assistant-reentry");
const TOOL_NATIVE_CHILD_KEY = Symbol.for("pi.ccstyle.compact-style.native-tool-child");

function newRunStats(): RunStats {
	return {
		startedAt: Date.now(),
		toolCount: 0,
		readFiles: new Set(),
		editFiles: new Set(),
		commandCount: 0,
		otherCount: 0,
		failedCount: 0,
	};
}

function getState(): RuntimeState {
	const globalWithState = globalThis as typeof globalThis & { [STATE_KEY]?: RuntimeState };
	globalWithState[STATE_KEY] ??= {
		getMode: () => "on",
		getExcludeRenderers: () => [],
		toolsById: new Map(),
		currentBurst: [],
		hiddenToolIds: new Set(),
		runningToolIds: new Set(),
		agentActive: false,
		runStats: newRunStats(),
		toolComponents: new Set(),
		assistantComponents: new Set(),
		thinkingHidden: true,
	};
	return globalWithState[STATE_KEY]!;
}

const state = getState();

function currentMode(): CompactStyleMode {
	try {
		const mode = state.getMode();
		return mode === "on" || mode === "off" || mode === "compact" ? mode : "on";
	} catch {
		return "off";
	}
}

function isCompact(): boolean {
	return currentMode() === "compact";
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function shortenPath(path: unknown): string {
	if (typeof path !== "string" || !path) return "";
	const clean = sanitizeToolResultText(path);
	const home = homedir();
	return clean.startsWith(home) ? `~${clean.slice(home.length)}` : clean;
}

function oneLine(value: unknown): string {
	return sanitizeToolResultText(String(value ?? ""))
		.replace(/\s+/g, " ")
		.trim();
}

function previewWidth(base = process.stdout.columns || 100): number {
	return Math.max(MIN_PREVIEW_WIDTH, Math.min(MAX_PREVIEW_WIDTH, base - PREVIEW_MARGIN));
}

function limitPlain(text: string, max = previewWidth()): string {
	const clean = oneLine(text);
	if (clean.length <= max) return clean;
	return `${clean.slice(0, Math.max(0, max - 1))}…`;
}

function quote(s: string): string {
	return JSON.stringify(s);
}

function safeJson(value: unknown): string {
	try {
		return JSON.stringify(value ?? {});
	} catch {
		return sanitizeToolResultText(String(value));
	}
}

/** Durations below one second are intentionally omitted. */
export function formatDuration(ms: number): string {
	if (!Number.isFinite(ms) || ms < 1000) return "";
	const totalSeconds = Math.round(ms / 1000);
	if (totalSeconds < 60) return `${totalSeconds}s`;
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	return seconds ? `${minutes}m${seconds}s` : `${minutes}m`;
}

const PREFERRED_ARG_KEYS = [
	"command",
	"code",
	"query",
	"pattern",
	"path",
	"file_path",
	"filePath",
	"file",
	"url",
	"prompt",
	"text",
	"description",
	"name",
];
const PATH_ARG_KEYS = new Set(["path", "file_path", "filePath", "file"]);

export function previewFor(name: string, args: any): string {
	switch (name) {
		case "bash":
			return `$ ${oneLine(args?.command || "...")}`;
		case "read": {
			let out = `read ${shortenPath(args?.path) || "..."}`;
			if (args?.offset !== undefined || args?.limit !== undefined) {
				const start = args.offset ?? 1;
				const end = args.limit !== undefined ? start + args.limit - 1 : "";
				out += `:${start}${end ? `-${end}` : ""}`;
			}
			return out;
		}
		case "write": {
			const lines = typeof args?.content === "string" ? args.content.split("\n").length : 0;
			return `write ${shortenPath(args?.path) || "..."}${lines ? ` (${lines} lines)` : ""}`;
		}
		case "edit": {
			const edits = Array.isArray(args?.edits) ? args.edits.length : 0;
			return `edit ${shortenPath(args?.path) || "..."}${edits > 1 ? ` (${edits} edits)` : ""}`;
		}
		case "grep": {
			const pattern = args?.pattern ? quote(String(args.pattern)) : "...";
			const path = shortenPath(args?.path) || ".";
			return `grep ${pattern} ${path}${args?.glob ? ` (${args.glob})` : ""}`;
		}
		case "find":
			return `find ${args?.pattern ? quote(String(args.pattern)) : "..."} ${shortenPath(args?.path) || "."}`;
		case "ls":
			return `ls ${shortenPath(args?.path) || "."}`;
		default: {
			if (args && typeof args === "object") {
				for (const key of PREFERRED_ARG_KEYS) {
					const value = (args as Record<string, unknown>)[key];
					if (isNonEmptyString(value)) {
						const rendered = PATH_ARG_KEYS.has(key) ? shortenPath(value) : oneLine(value);
						return `${name} ${rendered}`;
					}
				}
				const firstString = Object.values(args).find(isNonEmptyString);
				if (firstString) return `${name} ${oneLine(firstString)}`;
			}
			return `${name} ${safeJson(args ?? {})}`;
		}
	}
}

export function resultPreview(result: any, isPartial = false): string {
	const text = Array.isArray(result?.content)
		? result.content.find((c: any) => c?.type === "text" && typeof c.text === "string")?.text
		: undefined;
	if (!text) return isPartial ? "running" : "";
	const lines = sanitizeToolResultText(text).trim().split("\n").filter((line) => line.trim().length > 0);
	if (lines.length === 0) return isPartial ? "running" : "";
	if (lines.length === 1) return lines[0];
	return `${lines.length} lines`;
}

function resetToolRun() {
	state.toolsById = new Map();
	state.currentBurst = [];
	state.hiddenToolIds = new Set();
	state.runningToolIds = new Set();
	state.currentThoughtHeading = undefined;
	state.thoughtAnchorId = undefined;
	stopBlinkTimer();
}

function clearSessionState() {
	resetToolRun();
	state.agentActive = false;
	state.runStats = newRunStats();
	state.toolComponents = new Set();
	state.assistantComponents = new Set();
	state.currentTheme = undefined;
	state.lastTui = undefined;
	state.thinkingHidden = true;
}

function captureTheme(ctx: ExtensionContext) {
	state.currentTheme = ctx.ui.theme;
}

function setToolHidden(info: ToolInfo, hidden: boolean) {
	info.hidden = hidden;
	if (hidden) state.hiddenToolIds.add(info.id);
	else state.hiddenToolIds.delete(info.id);
}

function restoreBurstSegment(tools: ToolInfo[], changed: Set<ToolInfo>): void {
	const lastIndex = tools.length - 1;
	for (let index = 0; index < tools.length; index++) {
		const tool = tools[index]!;
		const hidden = index !== lastIndex;
		const burstCount = hidden ? 1 : tools.length;
		if (tool.hidden !== hidden || tool.burstCount !== burstCount) changed.add(tool);
		setToolHidden(tool, hidden);
		tool.burstCount = burstCount;
	}
}

function markToolFailed(info: ToolInfo): void {
	const burst = state.currentBurst;
	const failedIndex = burst.findIndex((tool) => tool.id === info.id);
	const changed = new Set<ToolInfo>();

	// Publish the boundary before invalidating peers: their updateDisplay calls
	// must not be able to rejoin the failed burst.
	state.currentBurst = [];
	if (failedIndex >= 0) {
		restoreBurstSegment(burst.slice(0, failedIndex), changed);
		restoreBurstSegment(burst.slice(failedIndex + 1), changed);
	}

	info.isError = true;
	info.burstCount = 1;
	setToolHidden(info, false);
	for (const tool of changed) {
		if (tool !== info) tool.invalidate?.();
	}
}

function applyResult(info: ToolInfo, result: any, isError: boolean, isPartial: boolean) {
	const suffix = resultPreview(result, isPartial);
	if (suffix) info.result = suffix;
	if (isError && (!info.isError || state.currentBurst.includes(info))) markToolFailed(info);
}

function ensureBlinkTimer() {
	if (state.blinkTimer || state.runningToolIds.size === 0) return;
	state.blinkTimer = setInterval(() => {
		if (state.runningToolIds.size === 0) {
			stopBlinkTimer();
			return;
		}
		for (const id of state.runningToolIds) state.toolsById.get(id)?.invalidate?.();
	}, BLINK_INTERVAL_MS);
	state.blinkTimer.unref?.();
}

function stopBlinkTimer() {
	if (state.blinkTimer) clearInterval(state.blinkTimer);
	state.blinkTimer = undefined;
}

function statusMarker(
	theme: Theme,
	name: string,
	opts: { running?: boolean; isError?: boolean; hasResult?: boolean },
): string {
	if (opts.isError) return theme.fg("error", "✗ ");
	if (opts.running) {
		if (!CLAUDE_LOADING_TOOLS.has(name)) return theme.fg("accent", "● ");
		const frame = CLAUDE_LOADING_FRAMES[Math.floor(Date.now() / BLINK_INTERVAL_MS) % CLAUDE_LOADING_FRAMES.length] ?? "⠋";
		return theme.fg("accent", `${frame} `);
	}
	if (opts.hasResult) return theme.fg("success", "✓ ");
	return theme.fg("dim", "● ");
}

function textSignalHasVisibleContent(assistantMessageEvent: any): boolean {
	const type = assistantMessageEvent?.type;
	if (type === "text_delta") {
		return typeof assistantMessageEvent.delta === "string" && assistantMessageEvent.delta.trim().length > 0;
	}
	if (type === "text_end") {
		return typeof assistantMessageEvent.content === "string" && assistantMessageEvent.content.trim().length > 0;
	}
	return false;
}

function thoughtTickerEnabled(): boolean {
	return isCompact() && state.thinkingHidden;
}

function cleanThoughtHeading(line: string): string {
	let clean = oneLine(line)
		.replace(/^#{1,6}\s+/, "")
		.replace(/^[-*]\s+/, "")
		.trim();
	clean = clean
		.replace(/^\*\*(.+)\*\*$/, "$1")
		.replace(/^__(.+)__$/, "$1")
		.replace(/^`(.+)`$/, "$1");
	return clean.trim();
}

function extractThoughtHeading(text: unknown): string {
	if (typeof text !== "string") return "";
	const firstLine = text.split(/\r?\n/).find((line) => line.trim().length > 0);
	return firstLine ? cleanThoughtHeading(firstLine) : "";
}

function latestThoughtHeading(message: any): string {
	if (!Array.isArray(message?.content)) return "";
	for (let i = message.content.length - 1; i >= 0; i--) {
		const content = message.content[i];
		if (content?.type === "thinking") return extractThoughtHeading(content.thinking);
	}
	return "";
}

function invalidateToolById(id: string | undefined) {
	if (!id) return;
	state.toolsById.get(id)?.invalidate?.();
}

function latestVisibleTool(): ToolInfo | undefined {
	return Array.from(state.toolsById.values())
		.reverse()
		.find((tool) => !tool.hidden);
}

function clearCurrentThought() {
	if (!state.currentThoughtHeading && !state.thoughtAnchorId) return;
	const previousAnchorId = state.thoughtAnchorId;
	state.currentThoughtHeading = undefined;
	state.thoughtAnchorId = undefined;
	invalidateToolById(previousAnchorId);
}

function setCurrentThought(heading: string) {
	const nextHeading = oneLine(heading);
	if (!thoughtTickerEnabled() || !nextHeading) {
		clearCurrentThought();
		return;
	}

	const previousAnchorId = state.thoughtAnchorId;
	const nextAnchorId = latestVisibleTool()?.id;
	const changed = state.currentThoughtHeading !== nextHeading || previousAnchorId !== nextAnchorId;
	state.currentThoughtHeading = nextHeading;
	state.thoughtAnchorId = nextAnchorId;
	if (!changed) return;

	invalidateToolById(previousAnchorId);
	if (nextAnchorId !== previousAnchorId) invalidateToolById(nextAnchorId);
}

function updateCurrentThoughtFromMessage(message: any) {
	const heading = latestThoughtHeading(message);
	// Keep the previous heading while a replacement thinking block is empty.
	if (heading) setCurrentThought(heading);
}

function anchorCurrentThoughtTo(info: ToolInfo) {
	if (!thoughtTickerEnabled() || !state.currentThoughtHeading || state.thoughtAnchorId === info.id) return;
	const previousAnchorId = state.thoughtAnchorId;
	state.thoughtAnchorId = info.id;
	invalidateToolById(previousAnchorId);
	info.invalidate?.();
}

function currentThoughtLine(toolCallId: string, theme: Theme): string {
	if (!thoughtTickerEnabled() || state.thoughtAnchorId !== toolCallId || !state.currentThoughtHeading) return "";
	const prefix = " ↳ ";
	const budget = previewWidth((process.stdout.columns || 100) - prefix.length);
	return theme.fg("dim", prefix) + theme.fg("thinkingText", limitPlain(state.currentThoughtHeading, budget));
}

function upsertToolInfo(id: string, name: string, args: any, invalidate?: () => void): ToolInfo {
	let info = state.toolsById.get(id);
	if (!info) {
		info = { id, name, args, preview: previewFor(name, args) };
		state.toolsById.set(id, info);
	}
	info.name = name;
	info.args = args;
	info.preview = previewFor(name, args);
	if (invalidate) info.invalidate = invalidate;
	return info;
}

function recordToolStart(name: string, args: any) {
	const base = name.split(".").pop() ?? name;
	state.runStats.toolCount++;
	if (base === "read") {
		if (isNonEmptyString(args?.path)) state.runStats.readFiles.add(args.path);
	} else if (base === "edit" || base === "write") {
		if (isNonEmptyString(args?.path)) state.runStats.editFiles.add(args.path);
	} else if (base === "bash") {
		state.runStats.commandCount++;
	} else {
		state.runStats.otherCount++;
	}
}

function joinBurst(info: ToolInfo) {
	const previous = state.currentBurst[state.currentBurst.length - 1];

	if (!isCompact()) {
		state.currentBurst = [];
		return;
	}

	// Only consecutive uses of the same tool are grouped.
	if (state.currentBurst.length && state.currentBurst[state.currentBurst.length - 1].name !== info.name) {
		state.currentBurst = [];
	}

	if (!state.currentBurst.some((tool) => tool.id === info.id)) state.currentBurst.push(info);
	for (const tool of state.currentBurst.slice(0, -1)) setToolHidden(tool, true);
	info.burstCount = state.currentBurst.length;
	previous?.invalidate?.();
}

function beginTool(id: string, name: string, args: any) {
	const info = upsertToolInfo(id, name, args);
	setToolHidden(info, false);
	info.burstCount = 1;
	info.running = true;
	info.isError = false;
	info.startedAt = Date.now();
	state.runningToolIds.add(id);
	ensureBlinkTimer();
	recordToolStart(name, args);
	joinBurst(info);
	anchorCurrentThoughtTo(info);
	info.invalidate?.();
}

// Rebuilds do not emit tool_execution_start, so reconstruct burst grouping from
// the persisted transcript without treating old tools as running.
function hydrateTool(id: string, name: string, args: any, isError: boolean): ToolInfo {
	const info = upsertToolInfo(id, name, args);
	setToolHidden(info, false);
	info.burstCount = 1;
	if (isError) {
		markToolFailed(info);
		return info;
	}
	joinBurst(info);
	return info;
}

function updateToolResult(toolCallId: string, result: any, isError = false, isPartial = false) {
	if (!isPartial) {
		state.runningToolIds.delete(toolCallId);
		if (state.runningToolIds.size === 0) stopBlinkTimer();
	}
	const info = state.toolsById.get(toolCallId);
	if (!info) return;
	if (!isPartial) {
		info.running = false;
		if (info.startedAt) info.durationMs = Date.now() - info.startedAt;
		if (state.currentBurst.includes(info) && state.currentBurst.length > 1) {
			info.burstDurationMs = state.currentBurst.reduce((total, tool) => total + (tool.durationMs ?? 0), 0);
		}
		if (isError) state.runStats.failedCount++;
	}
	applyResult(info, result, isError, isPartial);
	info.invalidate?.();
}

function compactToolLine(
	toolCallId: string,
	name: string,
	args: any,
	theme: Theme,
	invalidate?: () => void,
	result?: any,
	isError = false,
	isPartial = false,
): string {
	if (!state.toolsById.has(toolCallId)) hydrateTool(toolCallId, name, args, isError);
	const info = upsertToolInfo(toolCallId, name, args, invalidate);
	applyResult(info, result, isError, isPartial);
	if (info.hidden) return "";

	const isBurst = (info.burstCount ?? 1) > 1;
	const durationText = formatDuration((isBurst ? (info.burstDurationMs ?? info.durationMs) : info.durationMs) ?? 0);
	const inner = [info.result ? oneLine(info.result) : "", durationText].filter(Boolean).join(" · ");
	const status = inner ? ` {${inner}}` : info.running ? " {running}" : "";
	const details = `${info.preview}${status}`;
	const marker = statusMarker(theme, name, {
		running: info.running,
		isError: info.isError,
		hasResult: result != null || !!info.result,
	});
	const indent = " ";
	if (!isBurst) return indent + marker + theme.fg("muted", limitPlain(details));

	const prefix = `${info.burstCount}× `;
	const budget = previewWidth((process.stdout.columns || 100) - indent.length - prefix.length - MARKER_WIDTH);
	return indent + marker + theme.fg("muted", prefix + limitPlain(details, budget));
}

function shouldCompactComponent(component: any, mode: CompactStyleMode): boolean {
	const name = String(component?.toolName || component?.toolDefinition?.name || "");
	let exclusions: readonly string[] = [];
	try {
		exclusions = state.getExcludeRenderers();
	} catch {
		// A failed/unloaded host must fall back to the native renderer.
		return false;
	}
	return shouldUseCompactRenderer(mode, name, exclusions);
}

function nativeToolShellChild(component: any): any {
	const extensionDefinition = component.toolDefinition;
	const builtInDefinition = component.builtInToolDefinition;
	if (!extensionDefinition && !builtInDefinition) return component.contentText;

	let shell: "default" | "self";
	if (!builtInDefinition) {
		shell = extensionDefinition?.renderShell ?? "default";
	} else if (!extensionDefinition) {
		shell = builtInDefinition.renderShell ?? "default";
	} else {
		shell = extensionDefinition.renderShell ?? builtInDefinition.renderShell ?? "default";
	}
	return shell === "self" ? component.selfRenderContainer : component.contentBox;
}

function toolShellChildren(component: any): any[] {
	return [component.contentText, component.contentBox, component.selfRenderContainer].filter(Boolean);
}

function syncToolShellChild(component: any, target: any, preferredIndex?: number): void {
	if (!target || !Array.isArray(component.children)) return;
	const candidates = new Set(toolShellChildren(component));
	const shellIndexes = component.children
		.map((child: any, index: number) => candidates.has(child) ? index : -1)
		.filter((index: number) => index >= 0);
	const targetIndex = preferredIndex !== undefined && shellIndexes.includes(preferredIndex)
		? preferredIndex
		: shellIndexes[0];
	if (targetIndex === undefined) {
		if (preferredIndex !== undefined && preferredIndex >= 0 && preferredIndex <= component.children.length) {
			component.children.splice(preferredIndex, 0, target);
		} else if (typeof component.addChild === "function") {
			component.addChild(target);
		}
		return;
	}

	component.children[targetIndex] = target;
	for (const index of shellIndexes.sort((left: number, right: number) => right - left)) {
		if (index !== targetIndex) component.children.splice(index, 1);
	}
}

function rememberNativeToolShell(component: any): void {
	if (component[TOOL_NATIVE_CHILD_KEY]) return;
	const child = nativeToolShellChild(component);
	const candidates = new Set(toolShellChildren(component));
	const index = Array.isArray(component.children)
		? component.children.findIndex((entry: any) => candidates.has(entry))
		: -1;
	component[TOOL_NATIVE_CHILD_KEY] = { child, index };
}

function restoreNativeToolShell(component: any): void {
	const saved = component[TOOL_NATIVE_CHILD_KEY] as { child: any; index: number } | undefined;
	const child = saved?.child ?? nativeToolShellChild(component);
	syncToolShellChild(component, child, saved?.index);
	delete component[TOOL_NATIVE_CHILD_KEY];
}

function patchToolExecutionComponent(installation: CompactInstallation): ToolPrototypePatch | undefined {
	const prototype = ToolExecutionComponent.prototype as any;
	if (typeof prototype.updateDisplay !== "function" || typeof prototype.render !== "function") return undefined;

	const patch: ToolPrototypePatch = {
		prototype,
		active: true,
		originalUpdateDisplay: prototype.updateDisplay,
		originalRender: prototype.render,
		patchedUpdateDisplay: undefined as any,
		patchedRender: undefined as any,
	};

	patch.patchedUpdateDisplay = function patchedUpdateDisplay(this: any) {
		if (!patch.active || !installation.active || state.activeInstallation !== installation) {
			this.__compactStyleForceSelf = false;
			this.__compactStyleHidden = false;
			restoreNativeToolShell(this);
			return patch.originalUpdateDisplay.call(this);
		}

		state.toolComponents.add(this);
		state.lastTui = this.ui;
		const mode = currentMode();
		const useCompact = shouldCompactComponent(this, mode);
		if (!useCompact || this.expanded) {
			this.__compactStyleForceSelf = false;
			this.__compactStyleHidden = false;
			if (mode === "off" || mode === "compact" || this[TOOL_NATIVE_CHILD_KEY]) {
				restoreNativeToolShell(this);
			}
			return patch.originalUpdateDisplay.call(this);
		}
		if (!this.toolCallId || !this.toolName || !this.selfRenderContainer || typeof this.selfRenderContainer.clear !== "function") {
			this.__compactStyleForceSelf = false;
			this.__compactStyleHidden = false;
			restoreNativeToolShell(this);
			return patch.originalUpdateDisplay.call(this);
		}

		const theme = state.currentTheme;
		if (!theme) {
			this.__compactStyleForceSelf = false;
			this.__compactStyleHidden = false;
			restoreNativeToolShell(this);
			return patch.originalUpdateDisplay.call(this);
		}

		const invalidate = () => {
			this.invalidate();
			this.ui?.requestRender?.();
		};
		if (!state.toolsById.has(this.toolCallId)) {
			hydrateTool(this.toolCallId, this.toolName, this.args, this.result?.isError ?? false);
		}
		const info = upsertToolInfo(this.toolCallId, this.toolName, this.args, invalidate);
		applyResult(info, this.result, this.result?.isError ?? false, this.isPartial);

		this.__compactStyleForceSelf = true;
		this.__compactStyleHidden = false;
		rememberNativeToolShell(this);
		syncToolShellChild(this, this.selfRenderContainer);
		this.selfRenderContainer.clear();
		for (const image of this.imageComponents ?? []) this.removeChild?.(image);
		for (const spacer of this.imageSpacers ?? []) this.removeChild?.(spacer);
		this.imageComponents = [];
		this.imageSpacers = [];

		const line = compactToolLine(
			this.toolCallId,
			this.toolName,
			this.args,
			theme,
			invalidate,
			this.result,
			this.result?.isError ?? false,
			this.isPartial,
		);
		if (!line) {
			this.__compactStyleHidden = true;
			return;
		}

		const thoughtLine = currentThoughtLine(this.toolCallId, theme);
		// Keep a compact tool group visually separate from its thinking ticker,
		// without adding vertical space to ordinary compact tool rows.
		if (thoughtLine) this.selfRenderContainer.addChild(new Spacer(1));
		this.selfRenderContainer.addChild(new Text(line, 0, 0));
		if (thoughtLine) this.selfRenderContainer.addChild(new Text(thoughtLine, 0, 0));
	};

	patch.patchedRender = function patchedRender(this: any, width: number) {
		if (!patch.active || !installation.active || state.activeInstallation !== installation) {
			return patch.originalRender.call(this, width);
		}
		if (this.hideComponent || this.__compactStyleHidden) return [];
		if (this.__compactStyleForceSelf) return this.selfRenderContainer.render(width);
		return patch.originalRender.call(this, width);
	};

	prototype.updateDisplay = patch.patchedUpdateDisplay;
	prototype.render = patch.patchedRender;
	prototype[TOOL_PATCH_KEY] = patch;
	return patch;
}

function appendNativeStopReason(component: any, message: any, theme: Theme): void {
	const hasToolCalls = message.content.some((content: any) => content.type === "toolCall");
	component.hasToolCalls = hasToolCalls;
	if (message.stopReason === "length") {
		component.contentContainer.addChild(new Spacer(1));
		component.contentContainer.addChild(new Text(
			theme.fg("error", "Error: Model stopped because it reached the maximum output token limit. The response may be incomplete."),
			component.outputPad,
			0,
		));
	} else if (!hasToolCalls) {
		if (message.stopReason === "aborted") {
			const abortMessage = message.errorMessage && message.errorMessage !== "Request was aborted"
				? message.errorMessage
				: "Operation aborted";
			component.contentContainer.addChild(new Spacer(1));
			component.contentContainer.addChild(new Text(theme.fg("error", abortMessage), component.outputPad, 0));
		} else if (message.stopReason === "error") {
			const errorMessage = message.errorMessage || "Unknown error";
			component.contentContainer.addChild(new Spacer(1));
			component.contentContainer.addChild(new Text(theme.fg("error", `Error: ${errorMessage}`), component.outputPad, 0));
		}
	}
}

function patchAssistantMessageComponent(installation: CompactInstallation): AssistantPrototypePatch | undefined {
	const prototype = AssistantMessageComponent.prototype as any;
	if (typeof prototype.updateContent !== "function") return undefined;

	const patch: AssistantPrototypePatch = {
		prototype,
		active: true,
		originalUpdateContent: prototype.updateContent,
		nativeUpdateContent: prototype.updateContent,
		patchedUpdateContent: undefined as any,
	};

	patch.patchedUpdateContent = function patchedUpdateContent(this: any, message: any) {
		// A renderer loaded after ccstyle may call the previous ccstyle wrapper.
		// Bypass the newly linked downstream wrapper on that re-entry to avoid a
		// recursion loop while preserving the original native renderer.
		if (this[ASSISTANT_REENTRY_KEY] === patch) {
			return patch.nativeUpdateContent.call(this, message);
		}
		if (!patch.active || !installation.active || state.activeInstallation !== installation) {
			return patch.originalUpdateContent.call(this, message);
		}

		state.assistantComponents.add(this);
		const mode = currentMode();
		// Compact owns thinking presentation: always suppress the full native block
		// and surface only the short ticker, without changing Pi's persisted setting.
		state.thinkingHidden = mode === "compact" || !!this.hideThinkingBlock;
		if (mode !== "compact" || !Array.isArray(message?.content)) {
			if (mode !== "compact") clearCurrentThought();
			this[ASSISTANT_REENTRY_KEY] = patch;
			try {
				return patch.originalUpdateContent.call(this, message);
			} finally {
				delete this[ASSISTANT_REENTRY_KEY];
			}
		}
		const theme = state.currentTheme;
		if (!theme || !this.contentContainer || typeof this.contentContainer.clear !== "function") {
			return patch.originalUpdateContent.call(this, message);
		}

		// Native children are not tagged as text vs. thinking, so removing only the
		// thinking children after native rendering is not safe. Mirror pi 0.80.10's
		// text and stop-reason paths exactly, while intentionally omitting thinking.
		this.lastMessage = message;
		this.contentContainer.clear();
		const texts = message.content.filter((content: any) => content.type === "text" && content.text?.trim());
		const hasToolCalls = message.content.some((content: any) => content.type === "toolCall");
		const hasTerminalNotice = message.stopReason === "length"
			|| (!hasToolCalls && (message.stopReason === "aborted" || message.stopReason === "error"));
		if (texts.length > 0) {
			this.contentContainer.addChild(new Spacer(1));
			for (const content of texts) {
				this.contentContainer.addChild(new Markdown(content.text.trim(), this.outputPad, 0, this.markdownTheme));
			}
		}
		if (texts.length > 0 || hasTerminalNotice) {
			clearCurrentThought();
			state.currentBurst = [];
		}
		appendNativeStopReason(this, message, theme);
	};

	prototype.updateContent = patch.patchedUpdateContent;
	prototype[ASSISTANT_PATCH_KEY] = patch;
	return patch;
}

/** Reclaim the outermost assistant renderer after another extension patches it. */
function ensureAssistantPatchOwnership(installation: CompactInstallation): void {
	const patch = installation.assistantPatch;
	if (!installation.active || !patch) return;
	const prototype = patch.prototype;
	if (prototype.updateContent === patch.patchedUpdateContent) return;
	patch.originalUpdateContent = prototype.updateContent;
	prototype.updateContent = patch.patchedUpdateContent;
	prototype[ASSISTANT_PATCH_KEY] = patch;
}

function patchRenderers(installation: CompactInstallation): void {
	installation.toolPatch = patchToolExecutionComponent(installation);
	installation.assistantPatch = patchAssistantMessageComponent(installation);
}

function restorePrototypePatches(installation: CompactInstallation): void {
	const toolPatch = installation.toolPatch;
	if (toolPatch) {
		toolPatch.active = false;
		if (toolPatch.prototype.updateDisplay === toolPatch.patchedUpdateDisplay) {
			toolPatch.prototype.updateDisplay = toolPatch.originalUpdateDisplay;
		}
		if (toolPatch.prototype.render === toolPatch.patchedRender) {
			toolPatch.prototype.render = toolPatch.originalRender;
		}
		if (toolPatch.prototype[TOOL_PATCH_KEY] === toolPatch) delete toolPatch.prototype[TOOL_PATCH_KEY];
	}

	const assistantPatch = installation.assistantPatch;
	if (assistantPatch) {
		assistantPatch.active = false;
		if (assistantPatch.prototype.updateContent === assistantPatch.patchedUpdateContent) {
			assistantPatch.prototype.updateContent = assistantPatch.originalUpdateContent;
		}
		if (assistantPatch.prototype[ASSISTANT_PATCH_KEY] === assistantPatch) {
			delete assistantPatch.prototype[ASSISTANT_PATCH_KEY];
		}
	}
}

/** Re-render all rows touched by compact mode, including persisted summaries. */
export function refreshCompactTranscript(): void {
	for (const component of state.toolComponents) {
		try {
			component.invalidate?.();
		} catch {
			state.toolComponents.delete(component);
		}
	}
	for (const component of state.assistantComponents) {
		try {
			if (typeof component.invalidate === "function") component.invalidate();
			else if (component.lastMessage) component.updateContent?.(component.lastMessage);
		} catch {
			state.assistantComponents.delete(component);
		}
	}
	try {
		state.lastTui?.requestRender?.(true);
	} catch {
		state.lastTui = undefined;
	}
}

export function normalizeSummary(input: unknown): CompactSummaryData {
	const source = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
	const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0);
	return {
		reads: num(source.reads),
		edits: num(source.edits),
		commands: num(source.commands),
		others: num(source.others),
		failed: num(source.failed),
		durationMs: num(source.durationMs),
	};
}

export function summaryLine(input: CompactSummaryData | unknown): string {
	const data = normalizeSummary(input);
	const plural = (count: number) => (count === 1 ? "" : "s");
	const parts: string[] = [];
	if (data.reads) parts.push(`read ${data.reads} file${plural(data.reads)}`);
	if (data.edits) parts.push(`edited ${data.edits} file${plural(data.edits)}`);
	if (data.commands) parts.push(`ran ${data.commands} command${plural(data.commands)}`);
	if (data.others) parts.push(`${data.others} other tool${plural(data.others)}`);
	if (data.failed) parts.push(`${data.failed} failed`);
	if (parts.length === 0) return "";
	const text = parts.join(", ");
	const capitalized = text[0].toUpperCase() + text.slice(1);
	const duration = formatDuration(data.durationMs);
	return duration ? `${capitalized} · ${duration}` : capitalized;
}

/**
 * Entry renderer component whose output follows the current mode on every
 * render. The host keeps this component mounted, so a normal requestRender is
 * enough to hide or reveal persisted summaries without patching private entry
 * components.
 */
export class DynamicSummaryComponent {
	private readonly data: unknown;
	private readonly theme: Theme;

	constructor(data: unknown, theme: Theme) {
		this.data = data;
		this.theme = theme;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const line = currentMode() !== "off" ? summaryLine(this.data) : "";
		if (!line) return [];
		const italic = typeof (this.theme as any).italic === "function"
			? (this.theme as any).italic(this.theme.fg("muted", line))
			: this.theme.fg("muted", line);
		const prefix = this.theme.fg("borderMuted", "│ ");
		return new Text(prefix + italic, 0, 0).render(width);
	}
}

function appendRunSummary() {
	const stats = state.runStats;
	// A single tool row is already the summary.
	if (currentMode() === "off" || stats.toolCount < 2 || !state.pi?.appendEntry) return;
	const data: CompactSummaryData = {
		reads: stats.readFiles.size,
		edits: stats.editFiles.size,
		commands: stats.commandCount,
		others: stats.otherCount,
		failed: stats.failedCount,
		durationMs: Date.now() - stats.startedAt,
	};
	state.pi.appendEntry(SUMMARY_ENTRY_TYPE, data);
}

export type CompactStyleHooks = {
	onSessionStart(event: unknown, ctx: ExtensionContext): void;
	onSessionShutdown(event: unknown, ctx: ExtensionContext): void;
	onAgentStart(event: unknown, ctx: ExtensionContext): void;
	onAgentEnd(event: unknown, ctx: ExtensionContext): void;
	onTurnStart(event: unknown, ctx: ExtensionContext): void;
	onMessageUpdate(event: any, ctx: ExtensionContext): void;
	onToolExecutionStart(event: any, ctx: ExtensionContext): void;
	onToolExecutionUpdate(event: any, ctx: ExtensionContext): void;
	onToolExecutionEnd(event: any, ctx: ExtensionContext): void;
	refresh(): void;
};

function teardownCompactInstallation(installation: CompactInstallation): void {
	if (!installation.active) return;
	installation.active = false;
	if (installation.toolPatch) installation.toolPatch.active = false;
	if (installation.assistantPatch) installation.assistantPatch.active = false;

	if (state.activeInstallation === installation) {
		// Make every retained wrapper a native pass-through before rebuilding rows.
		// This also severs callbacks into an unloaded extension module.
		state.getMode = () => "off";
		state.getExcludeRenderers = () => [];
		state.pi = undefined;
		refreshCompactTranscript();
	}

	restorePrototypePatches(installation);
	if (state.activeInstallation === installation) {
		clearSessionState();
		state.activeInstallation = undefined;
	}
}

/** Install compact renderers without registering another Pi package entry. */
export function installCompactStyle(pi: ExtensionAPI, host: CompactStyleHost): CompactStyleHooks {
	if (state.activeInstallation) {
		teardownCompactInstallation(state.activeInstallation);
	} else {
		// Recover state left by an older/failed installation before taking ownership.
		state.getMode = () => "off";
		state.getExcludeRenderers = () => [];
		refreshCompactTranscript();
		clearSessionState();
	}

	const installation: CompactInstallation = { active: true };
	state.activeInstallation = installation;
	state.getMode = host.getMode;
	state.getExcludeRenderers = host.getExcludeRenderers;
	state.pi = pi;

	try {
		patchRenderers(installation);
		if (typeof (pi as any).registerEntryRenderer === "function") {
			pi.registerEntryRenderer(SUMMARY_ENTRY_TYPE, (entry: any, _options: any, theme: Theme) =>
				new DynamicSummaryComponent(entry.data, theme),
			);
		}
	} catch (error) {
		teardownCompactInstallation(installation);
		throw error;
	}

	const isOwner = () => installation.active && state.activeInstallation === installation;
	return {
		onSessionStart: (_event, ctx) => {
			if (!isOwner()) return;
			ensureAssistantPatchOwnership(installation);
			captureTheme(ctx);
			state.agentActive = false;
			state.runStats = newRunStats();
			// /reload and /resume rebuild transcript components before this event.
			// Keep those new references and repaint now that the new theme is known.
			refreshCompactTranscript();
			ctx.ui.setStatus(STATUS_KEY, undefined);
		},
		onSessionShutdown: (_event, ctx) => {
			if (isOwner()) teardownCompactInstallation(installation);
			ctx.ui.setStatus(STATUS_KEY, undefined);
		},
		onAgentStart: (_event, ctx) => {
			if (!isOwner()) return;
			state.agentActive = true;
			captureTheme(ctx);
			resetToolRun();
			state.runStats = newRunStats();
		},
		onAgentEnd: (_event, _ctx) => {
			if (!isOwner()) return;
			state.agentActive = false;
			state.currentBurst = [];
			clearCurrentThought();
			state.runningToolIds.clear();
			stopBlinkTimer();
			appendRunSummary();
		},
		onTurnStart: (_event, ctx) => {
			if (!isOwner()) return;
			captureTheme(ctx);
		},
		onMessageUpdate: (event, ctx) => {
			if (!isOwner()) return;
			ensureAssistantPatchOwnership(installation);
			captureTheme(ctx);
			const type = event?.assistantMessageEvent?.type;
			if (typeof type === "string" && type.startsWith("thinking_")) updateCurrentThoughtFromMessage(event.message);
			if (textSignalHasVisibleContent(event?.assistantMessageEvent)) {
				clearCurrentThought();
				state.currentBurst = [];
			}
		},
		onToolExecutionStart: (event, ctx) => {
			if (!isOwner()) return;
			captureTheme(ctx);
			beginTool(event.toolCallId, event.toolName, event.args);
		},
		onToolExecutionUpdate: (event, ctx) => {
			if (!isOwner()) return;
			captureTheme(ctx);
			updateToolResult(event.toolCallId, event.partialResult, false, true);
		},
		onToolExecutionEnd: (event, ctx) => {
			if (!isOwner()) return;
			captureTheme(ctx);
			updateToolResult(event.toolCallId, event.result, event.isError, false);
		},
		refresh: () => {
			if (isOwner()) refreshCompactTranscript();
		},
	};
}

export { SUMMARY_ENTRY_TYPE };
