import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	createBashToolDefinition,
	createEditToolDefinition,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
	generateDiffString,
	keyHint,
	renderDiff,
	ToolExecutionComponent,
} from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import powerlineFooter from "./ccstyle-powerline/powerline.ts";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Claude Code Style for pi
 *
 * Includes the bundled powerline footer (pipe separators, no Nerd Font arrows).
 * When fixed-editor chat scrolling is active, a Claude Code-like jump-to-bottom
 * button appears above the editor while the viewport is scrolled away from the
 * latest output, including when new messages arrive. Click it, or use the
 * displayed shortcut, to resume following the chat. Edit/write tool calls also
 * show a bounded, colorized diff preview with +/- lines after execution. A
 * collapsed tool result can be clicked on its Ctrl+O hint to expand only that tool.
 *
 * Dynamic commands:
 *   /ccstyle              toggle on/off
 *   /ccstyle on           enable
 *   /ccstyle off          disable
 *   /ccstyle status       show current state
 *   /ccstyle minimal      hide most tool output in collapsed view
 *   /ccstyle compact      show short summaries in collapsed view
 *   /ccstyle powerline compact|full|default|minimal|nerd|ascii|custom
 *
 * Shortcut:
 *   ctrl+shift+o          toggle on/off
 */

type StyleMode = "compact" | "minimal";

type Config = {
	enabled: boolean;
	mode: StyleMode;
};

const CONFIG_PATH = join(homedir(), ".pi", "agent", "claude-code-style.json");

let config: Config = loadConfig();

function loadConfig(): Config {
	try {
		if (existsSync(CONFIG_PATH)) {
			const parsed = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as Partial<Config>;
			return {
				enabled: parsed.enabled ?? true,
				mode: parsed.mode === "minimal" ? "minimal" : "compact",
			};
		}
	} catch {
		// Ignore bad config and fall back to defaults.
	}
	return { enabled: true, mode: "compact" };
}

function saveConfig() {
	writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

function shortenPath(path: string): string {
	const home = homedir();
	if (path.startsWith(home)) return `~${path.slice(home.length)}`;
	return path;
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

function parsePathCount(text: string): number {
	const files = new Set<string>();
	for (const line of text.split("\n")) {
		const match = line.match(/^([^:\n]+):(\d+:)?/);
		if (match?.[1]) files.add(match[1]);
	}
	return files.size;
}

function summarizeBash(text: string): string {
	const clean = text.trim();
	if (!clean) return "Done";
	const lower = clean.toLowerCase();
	const lines = clean.split("\n").filter(Boolean);
	const errorLine = lines.find((line) => /\b(error|failed|exception|fatal)\b/i.test(line));
	if (errorLine) return `Failed: ${oneLine(errorLine, 88)}`;
	if (/\b(warning|warn)\b/i.test(lower)) {
		const warnings = lines.filter((line) => /\b(warning|warn)\b/i.test(line)).length;
		return `Completed with ${warnings} warning${warnings === 1 ? "" : "s"}`;
	}
	if (/\b(success|passed|compiled|built|done)\b/i.test(lower)) return oneLine(lines.at(-1) ?? "Done", 88);
	return lines.length > 1 ? `${lines.length} lines output: ${oneLine(lines.at(-1), 72)}` : oneLine(clean, 88);
}

function summarizeEdit(text: string): string {
	const clean = text.trim();
	if (!clean) return "Edited";
	const added = (clean.match(/^\+/gm) ?? []).length;
	const removed = (clean.match(/^-/gm) ?? []).length;
	if (added || removed) return `Updated ${added} added, ${removed} removed`;
	return oneLine(clean, 88);
}

function summarizeDiffStats(preview: FileDiffPreview | undefined): string | undefined {
	if (!preview?.diff) return undefined;
	const { added, removed } = preview.stats ?? diffStats(preview.lines ?? preview.diff.split("\n"));
	if (!added && !removed) return undefined;
	return `Added ${added} line${added === 1 ? "" : "s"}, removed ${removed} line${removed === 1 ? "" : "s"}`;
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

const activeAnimationTimers = new Set<ReturnType<typeof setTimeout>>();

function clearAnimation(context: any) {
	const timer = context?.state?.ccstyleAnimationTimer as ReturnType<typeof setTimeout> | undefined;
	if (!timer) return;
	clearTimeout(timer);
	activeAnimationTimers.delete(timer);
	context.state.ccstyleAnimationTimer = undefined;
}

function clearAllAnimations() {
	for (const timer of activeAnimationTimers) clearTimeout(timer);
	activeAnimationTimers.clear();
}

function scheduleAnimation(context: any, intervalMs = 80) {
	const state = (context.state ??= {});
	if (state.ccstyleAnimationTimer) return;
	const timer = setTimeout(() => {
		activeAnimationTimers.delete(timer);
		state.ccstyleAnimationTimer = undefined;
		context.invalidate?.();
	}, intervalMs);
	state.ccstyleAnimationTimer = timer;
	activeAnimationTimers.add(timer);
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
class ExpandedToolResultText {
	private readonly text: string;
	private readonly prefix: string;

	constructor(text: string, prefix: string) {
		this.text = text;
		this.prefix = prefix;
	}

	render(width: number): string[] {
		const prefixWidth = visibleWidth(this.prefix);
		const contentWidth = Math.max(1, width - prefixWidth);
		return wrapTextWithAnsi(this.text.replace(/\t/g, "   ").replace(/\n+$/, ""), contentWidth)
			.map((line) => truncateToWidth(this.prefix + line, width, ""));
	}

	invalidate() {}
}

function renderCollapsedToolResult(body: string, collapsedHint = ""): string {
	return `  ⎿ ${body}${collapsedHint}`;
}

function renderExpandedToolResult(body: string, theme: any, isError: boolean): ExpandedToolResultText | Text {
	const color = isError ? "error" : "muted";
	if (!body.trim()) {
		return new Text(theme.fg(color, renderCollapsedToolResult("Done")), 0, 0);
	}
	return new ExpandedToolResultText(theme.fg(color, body), theme.fg(color, "  │ "));
}

function expandHint(theme: any): string {
	// Keep interaction guidance neutral; it should not inherit success/error
	// coloring from the tool result surrounding it.
	return `${theme.fg("muted", " (")}${keyHint("app.tools.expand", "expand")}${theme.fg("muted", " / click)")}`;
}

// Bright green for success icon (truecolor ANSI escape)
const BRIGHT_GREEN = "\x1b[38;2;80;220;100m";
const ANSI_RESET = "\x1b[0m";

function fileAction(args: any, verb: string): string {
	const path = shortenPath(args?.path || "...");
	return `${verb}(${path})`;
}

type DiffStats = { added: number; removed: number };
type FileDiffPreview = {
	diff: string;
	error?: string;
	notice?: string;
	stats?: DiffStats;
	/** Pre-split outside the render hot path. */
	lines?: string[];
};

// Diff generation is intentionally bounded: it runs before the mutation, but
// should never add unbounded latency or memory pressure to a tool call.
const MAX_DIFF_INPUT_BYTES = 2 * 1024 * 1024;
const COLLAPSED_DIFF_LINES = 12;
const EXPANDED_DIFF_LINES = 40;
const diffPreviewByCall = new Map<string, FileDiffPreview | undefined>();

function diffStats(lines: readonly string[]): DiffStats {
	let added = 0;
	let removed = 0;
	for (const line of lines) {
		if (/^\+\s*\d+\s/.test(line)) added++;
		else if (/^-\s*\d+\s/.test(line)) removed++;
	}
	return { added, removed };
}

function diffPreview(diff: string): FileDiffPreview {
	const lines = diff.split("\n");
	return { diff, lines, stats: diffStats(lines) };
}

function normalizeDiffText(text: string): string {
	return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function editEntries(args: any): Array<{ oldText: string; newText: string }> {
	if (Array.isArray(args?.edits)) {
		return args.edits.filter((edit: any) =>
			typeof edit?.oldText === "string" && typeof edit?.newText === "string",
		);
	}
	if (typeof args?.oldText === "string" && typeof args?.newText === "string") {
		return [{ oldText: args.oldText, newText: args.newText }];
	}
	return [];
}

/** Build the preview before mutation, outside the renderer's hot path. */
async function buildFileDiffPreview(toolName: string, args: any, cwd: string): Promise<FileDiffPreview | undefined> {
	const rawPath = typeof args?.path === "string" ? args.path : typeof args?.file_path === "string" ? args.file_path : "";
	if (!rawPath) return undefined;

	if (toolName === "write" && typeof args?.content === "string" && Buffer.byteLength(args.content, "utf8") > MAX_DIFF_INPUT_BYTES) {
		return { diff: "", notice: "Diff omitted: new content exceeds 2 MiB" };
	}

	const absolutePath = resolve(cwd || process.cwd(), rawPath);
	let before = "";
	try {
		const info = await stat(absolutePath);
		if (info.size > MAX_DIFF_INPUT_BYTES) {
			return { diff: "", notice: "Diff omitted: existing file exceeds 2 MiB" };
		}
		before = await readFile(absolutePath, "utf8");
	} catch (error: any) {
		if (error?.code !== "ENOENT") {
			return { diff: "", error: `Cannot read ${shortenPath(rawPath)}: ${oneLine(error, 72)}` };
		}
		if (toolName === "edit") return { diff: "", error: `File not found: ${shortenPath(rawPath)}` };
	}

	before = normalizeDiffText(before);
	let after = before;
	if (toolName === "write") {
		if (typeof args?.content !== "string") return undefined;
		after = normalizeDiffText(args.content);
	} else {
		const edits = editEntries(args);
		if (edits.length === 0) return undefined;
		const replacements: Array<{ start: number; end: number; text: string }> = [];
		for (const edit of edits) {
			const oldText = normalizeDiffText(edit.oldText);
			const start = after.indexOf(oldText);
			if (start < 0) return { diff: "", error: "Preview unavailable: old text was not found" };
			if (after.indexOf(oldText, start + 1) >= 0) {
				return { diff: "", error: "Preview unavailable: old text is not unique" };
			}
			replacements.push({ start, end: start + oldText.length, text: normalizeDiffText(edit.newText) });
		}
		for (const replacement of replacements.sort((a, b) => b.start - a.start)) {
			after = after.slice(0, replacement.start) + replacement.text + after.slice(replacement.end);
		}
	}

	if (Buffer.byteLength(after, "utf8") > MAX_DIFF_INPUT_BYTES) {
		return { diff: "", notice: "Diff omitted: resulting content exceeds 2 MiB" };
	}
	const diff = generateDiffString(before, after).diff;
	return diff ? diffPreview(diff) : undefined;
}

function diffLineCount(preview: FileDiffPreview | undefined): number {
	if (!preview?.diff) return 0;
	return preview.lines?.length ?? preview.diff.split("\n").length;
}

function hasExpandableDiff(preview: FileDiffPreview | undefined): boolean {
	return diffLineCount(preview) > COLLAPSED_DIFF_LINES;
}

function renderDiffPreview(preview: FileDiffPreview | undefined, theme: any, expanded: boolean): string {
	if (!preview) return "";
	if (preview.error) return theme.fg("error", `  ${preview.error}`);
	if (preview.notice) return theme.fg("muted", `  ${preview.notice}`);
	if (!preview.diff.trim()) return "";

	// Bound work before calling pi's renderer. Rendering only the visible raw
	// lines avoids repeatedly running intra-line diffing over a multi-megabyte diff.
	const rawLines = preview.lines ?? preview.diff.split("\n");
	const maxLines = expanded ? EXPANDED_DIFF_LINES : COLLAPSED_DIFF_LINES;
	const shown = renderDiff(rawLines.slice(0, maxLines).join("\n"))
		.split("\n")
		.map((line) => `  ${line}`);
	if (rawLines.length > maxLines) {
		shown.push(theme.fg("muted", `  … ${rawLines.length - maxLines} more diff lines`));
	}
	return shown.join("\n");
}

function renderFileDiffPreview(_toolName: string, _args: any, theme: any, context: any): string {
	const state = (context.state ??= {});
	if (diffPreviewByCall.has(context.toolCallId)) {
		state.ccstyleDiffPreview = diffPreviewByCall.get(context.toolCallId);
		diffPreviewByCall.delete(context.toolCallId);
	}
	return renderDiffPreview(state.ccstyleDiffPreview, theme, isToolExpanded(undefined, context));
}

function statusText() {
	return config.enabled ? `CC ${config.mode}` : "CC off";
}

function updateStatus(ctx: any) {
	ctx.ui.setStatus("ccstyle", statusText());
}

function renderDefault(tool: any, slot: "renderCall" | "renderResult", args: any[], fallback = "") {
	try {
		if (typeof tool?.[slot] === "function") return tool[slot](...args);
	} catch {
		// Fall through to raw fallback.
	}
	return new Text(fallback, 0, 0);
}

function createBuiltInTools(cwd: string) {
	return {
		// Keep complete definitions so wrapped tools retain prompt metadata,
		// argument preparation, execution mode, and native fallback renderers.
		read: createReadToolDefinition(cwd),
		bash: createBashToolDefinition(cwd),
		edit: createEditToolDefinition(cwd),
		write: createWriteToolDefinition(cwd),
		find: createFindToolDefinition(cwd),
		grep: createGrepToolDefinition(cwd),
		ls: createLsToolDefinition(cwd),
	};
}

const toolCache = new Map<string, ReturnType<typeof createBuiltInTools>>();
function getBuiltInTools(cwd: string) {
	let tools = toolCache.get(cwd);
	if (!tools) {
		tools = createBuiltInTools(cwd);
		toolCache.set(cwd, tools);
	}
	return tools;
}

/** Tools explicitly wrapped with bespoke call/result renderers. Skip these in the generic interceptor. */
const WRAPPED_BUILTINS = new Set<string>();

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
			let rendered = "";
			if (config.mode === "minimal" && !expanded) {
				rendered = "";
			} else if (!expanded) {
				rendered = text ? oneLine(text, 96) : "Done";
			} else {
				rendered = text;
			}

			const hint = !expanded && hasExpandableResult(text) ? expandHint(theme) : "";
			if (expanded) return renderExpandedToolResult(rendered, theme, isError);
			return new Text(
				theme.fg(isError ? "error" : "muted", renderCollapsedToolResult(rendered, hint)),
				0,
				0,
			);
		},
	};
}

/**
 * Extension APIs are isolated per plugin, so replacing this extension's
 * pi.registerTool cannot see SDK tools or tools registered by other plugins.
 * ToolExecutionComponent is shared by the TUI and exported by pi; patch its
 * renderer lookup once so every generic tool uses the same compact shell.
 * Only subagent tools keep their specialized renderers. Every other tool,
 * including MCP and extension tools, uses the same compact ccstyle shell.
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

function preservesOriginalRenderer(_definition: any, toolName: string): boolean {
	return SUBAGENT_TOOL_NAMES.has(toolName);
}

function shouldGloballyStyleTool(component: any, patch: GlobalToolRenderPatch): boolean {
	const selectedMode = component[COMPONENT_TOOL_RENDER_MODE];
	if (typeof selectedMode === "boolean") return selectedMode;

	const definition = component.toolDefinition ?? component.builtInToolDefinition;
	const toolName = String(component.toolName || definition?.name || "");
	const useCcstyle =
		patch.enabled() &&
		!preservesOriginalRenderer(definition, toolName) &&
		definition?.renderShell !== "self";
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
		preservesOriginalRenderer(definition, toolName) &&
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

function registerWrappedTool(pi: ExtensionAPI, name: keyof ReturnType<typeof createBuiltInTools>, renderer: {
	call: (args: any, theme: any) => string;
	result: (result: any, options: any, theme: any, context: any) => string;
	diff?: (args: any, theme: any, context: any) => string;
	/** Use pi's built-in call/result renderers, including native diff panels. */
	defaultRenderer?: boolean;
	defaultResult?: boolean;
	diffAfterResult?: boolean;
}) {
	WRAPPED_BUILTINS.add(name);
	const initial = getBuiltInTools(process.cwd())[name] as any;

	pi.registerTool({
		// Spread the full definition instead of copying a subset. In particular,
		// edit requires prepareArguments and tools may declare executionMode.
		...initial,
		name,
		label: initial.label ?? name,
		renderShell: "self",
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const tool = (getBuiltInTools(ctx.cwd)[name] as any);
			if (config.enabled && (name === "edit" || name === "write")) {
				// Await the old-file snapshot before mutation to avoid races, while
				// keeping all filesystem and diff work out of the TUI renderer.
				diffPreviewByCall.set(toolCallId, await buildFileDiffPreview(name, params, ctx.cwd));
			}
			let result: any;
			try {
				result = await tool.execute(toolCallId, params, signal, onUpdate, ctx);
			} catch (error) {
				diffPreviewByCall.delete(toolCallId);
				throw error;
			}
			if (name === "edit" && typeof result?.details?.diff === "string") {
				const actualDiff = result.details.diff as string;
				diffPreviewByCall.set(toolCallId,
					Buffer.byteLength(actualDiff, "utf8") <= MAX_DIFF_INPUT_BYTES
						? diffPreview(actualDiff)
						: { diff: "", notice: "Diff omitted: result exceeds 2 MiB" },
				);
			}
			return result;
		},
		renderCall(args, theme, context) {
			const tool = (getBuiltInTools(context.cwd)[name] as any);
			if (!config.enabled || renderer.defaultRenderer) {
				return renderDefault(tool, "renderCall", [args, theme, context], String(name));
			}

			const toolName = String(name);
			const visualState = resolveToolVisualState(context);
			const isPending = visualState === "pending" || (!visualState && (context?.isPartial || context?.executionStarted));
			if (isPending) scheduleAnimation(context);
			const rawIcon = isPending ? pendingIcon(toolName) : settledIcon(toolName, visualState);
			const icon = visualState === "success"
				? `${BRIGHT_GREEN}${rawIcon}${ANSI_RESET}`
				: theme.fg(toolIconColor(context), rawIcon);
			const title = `${icon} ${theme.fg("toolTitle", renderer.call(args, theme))}`;
			// Prime the per-tool snapshot, but keep the call row stable while arguments
			// stream in. The diff is rendered only after the result is finalized below.
			if (renderer.diffAfterResult) renderer.diff?.(args, theme, context);
			return new Text(title, 0, 0);
		},
		renderResult(result, options, theme, context) {
			const tool = (getBuiltInTools(context.cwd)[name] as any);
			if (!config.enabled || renderer.defaultResult) {
				diffPreviewByCall.delete(context.toolCallId);
				return renderDefault(tool, "renderResult", [result, options, theme, context], textFromResult(result));
			}

			if (options?.isPartial) {
				return new Text(theme.fg("muted", "  ⎿ Pending…"), 0, 0);
			}

			const isError = options?.isError || context?.isError;
			if (isError) {
				diffPreviewByCall.delete(context.toolCallId);
				if (context.state) context.state.ccstyleDiffPreview = undefined;
			}
			setToolVisualState(context, isError ? "error" : "success");
			const expanded = isToolExpanded(options, context);
			// Hydrate the cached preview before building the summary so edit uses
			// the authoritative result.details.diff rather than its estimate.
			const diff = !isError && renderer.diffAfterResult
				? renderer.diff?.(context.args, theme, context)
				: "";
			const rendered = renderer.result(result, { ...options, expanded }, theme, context);
			if (!rendered) return new Text("", 0, 0);
			const fullText = textFromResult(result);
			const preview = context?.state?.ccstyleDiffPreview as FileDiffPreview | undefined;
			const hint = !expanded && (hasExpandableResult(fullText) || hasExpandableDiff(preview))
				? expandHint(theme)
				: "";
			const body = `${rendered}${diff ? `\n${diff}` : ""}`;
			if (expanded) return renderExpandedToolResult(body, theme, isError);
			const output = `  ⎿ ${rendered}${hint}${diff ? `\n${diff}` : ""}`;
			return new Text(
				theme.fg(isError ? "error" : "muted", output),
				0,
				0,
			);
		},
	});
}

export default function (pi: ExtensionAPI) {
	installGlobalToolRendering();
	deactivateLegacyCompactionRendering();

	// Bundle the full powerline footer into ccstyle so it is loaded as one plugin.
	const powerline = powerlineFooter(pi);

	pi.registerCommand("ccstyle", {
		description: "Configure Claude Code style and Powerline preset",
		getArgumentCompletions: (prefix) => {
			const topLevel = [
				{ value: "on", label: "on", description: "Enable Claude Code style" },
				{ value: "off", label: "off", description: "Disable Claude Code style" },
				{ value: "status", label: "status", description: "Show current toggle and mode" },
				{ value: "minimal", label: "minimal", description: "Hide most tool output in collapsed view" },
				{ value: "compact", label: "compact", description: "Show short summaries in collapsed view" },
				{ value: "powerline", label: "powerline", description: "Set Powerline preset (e.g. powerline compact)" },
			];
			// If the user typed "powerline " — suggest available presets
			const match = prefix.match(/^powerline\s+/i);
			if (match) {
				const after = prefix.slice(match[0].length);
				return powerline.getPresets()
					.filter((p) => p.startsWith(after))
					.map((p) => ({ value: `powerline ${p}`, label: p, description: `Powerline preset: ${p}` }));
			}
			return topLevel.filter((item) => item.value.startsWith(prefix));
		},
		handler: async (args, ctx) => {
			const arg = args.trim().toLowerCase();
			const parts = arg.split(/\s+/).filter(Boolean);
			if (parts[0] === "powerline") {
				const requested = parts[1] === "mode" ? parts[2] : parts[1];
				if (!requested) {
					ctx.ui.notify(`Powerline preset: ${powerline.getPreset()}. Available: ${powerline.getPresets().join(", ")}`, "info");
					return;
				}
				const result = powerline.setPreset(requested, ctx);
				if (!result.valid) {
					ctx.ui.notify(`Unknown Powerline preset: ${requested}. Available: ${powerline.getPresets().join(", ")}`, "warning");
					return;
				}
				ctx.ui.notify(
					`Powerline preset set to: ${requested}${result.persisted ? "" : " (not persisted; check settings.json)"}`,
					result.persisted ? "info" : "warning",
				);
				return;
			}
			if (arg === "on" || arg === "enable") config.enabled = true;
			else if (arg === "off" || arg === "disable") config.enabled = false;
			else if (arg === "minimal") {
				config.enabled = true;
				config.mode = "minimal";
			} else if (arg === "compact") {
				config.enabled = true;
				config.mode = "compact";
			} else if (arg === "status") {
				updateStatus(ctx);
				ctx.ui.notify(
					`Claude Code style: ${config.enabled ? "on" : "off"}, mode=${config.mode}, powerline=${powerline.getPreset()}`,
					"info",
				);
				return;
			} else {
				config.enabled = !config.enabled;
			}
			saveConfig();
			updateStatus(ctx);
			ctx.ui.notify(`Claude Code style: ${config.enabled ? "on" : "off"}, mode=${config.mode}`, "info");
		},
	});

	pi.registerShortcut("ctrl+shift+o", {
		description: "Toggle Claude Code-like output style",
		handler: async (ctx) => {
			config.enabled = !config.enabled;
			saveConfig();
			updateStatus(ctx);
			ctx.ui.notify(`Claude Code style: ${config.enabled ? "on" : "off"}`, "info");
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		diffPreviewByCall.clear();
		updateStatus(ctx);
	});

	pi.on("session_shutdown", async () => {
		deactivateGlobalToolRendering();
		deactivateLegacyCompactionRendering();
		clearAllAnimations();
		diffPreviewByCall.clear();
		toolCache.clear();
	});

	registerWrappedTool(pi, "read", {
		call: (args) => fileAction(args, "Read"),
		result: (result, { expanded }) => {
			const text = textFromResult(result);
			if (config.mode === "minimal" && !expanded) return "";
			if (!expanded) return `${countLines(text)} lines read`;
			return text;
		},
	});

	registerWrappedTool(pi, "bash", {
		call: (args) => `Bash(${oneLine(args?.command, 86) || "..."})`,
		result: (result, { expanded }) => {
			const text = textFromResult(result).trim();
			if (config.mode === "minimal" && !expanded) return "";
			if (!expanded) return summarizeBash(text);
			return text;
		},
	});

	registerWrappedTool(pi, "edit", {
		call: (args) => fileAction(args, "Edit"),
		diff: (args, theme, context) => renderFileDiffPreview("edit", args, theme, context),
		diffAfterResult: true,
		result: (result, { expanded }, _theme, context) => {
			const text = textFromResult(result).trim();
			if (config.mode === "minimal" && !expanded) return "";
			return summarizeDiffStats(context?.state?.ccstyleDiffPreview) ?? summarizeEdit(text);
		},
	});

	registerWrappedTool(pi, "write", {
		call: (args) => {
			const path = shortenPath(args?.path || "...");
			const lines = args?.content ? countLines(args.content) : 0;
			return `Write(${path}${lines ? `, ${lines} lines` : ""})`;
		},
		diff: (args, theme, context) => renderFileDiffPreview("write", args, theme, context),
		diffAfterResult: true,
		result: (result, { expanded }, _theme, context) => {
			const text = textFromResult(result).trim();
			if (config.mode === "minimal" && !expanded) return "";
			return summarizeDiffStats(context?.state?.ccstyleDiffPreview) ?? (text ? oneLine(text, 96) : "Written");
		},
	});

	registerWrappedTool(pi, "find", {
		call: (args) => `Find(${args?.pattern || "..."}${args?.path ? ` in ${shortenPath(args.path)}` : ""})`,
		result: (result, { expanded }) => {
			const text = textFromResult(result).trim();
			if (config.mode === "minimal" && !expanded) return "";
			if (!expanded) return `${countLines(text)} files`;
			return text;
		},
	});

	registerWrappedTool(pi, "grep", {
		call: (args) => `Grep(${args?.pattern ? `/${oneLine(args.pattern, 48)}/` : "..."})`,
		result: (result, { expanded }) => {
			const text = textFromResult(result).trim();
			if (config.mode === "minimal" && !expanded) return "";
			if (!expanded) {
				const matches = countLines(text);
				const files = parsePathCount(text);
				return files ? `Found ${matches} matches in ${files} files` : `${matches} matches`;
			}
			return text;
		},
	});

	registerWrappedTool(pi, "ls", {
		call: (args) => `List(${shortenPath(args?.path || ".")})`,
		result: (result, { expanded }) => {
			const text = textFromResult(result).trim();
			if (config.mode === "minimal" && !expanded) return "";
			if (!expanded) return `${countLines(text)} entries`;
			return text;
		},
	});

}
