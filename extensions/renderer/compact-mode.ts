/**
 * Compact mode：每条含 toolCall 的 assistant message 折叠为一条逐步累加的摘要行
 * （`Ran for 8s, bash×2, read×2`），edit/write 独立单行（`✓ write <path> (+25 -0)`），
 * 普通工具折叠时不显示独立行；展开（Ctrl+O / fullscreen 点击）在单个工具卡中恢复
 * compact-thinking/Pi 原生或专用 renderer。edit/write 折叠时显示统计，展开时显示 rich diff。
 * Agent/Task 族：调用只进摘要计数，tool 卡始终折叠（避免 pending→完成高度闪动）。
 * 底部 Agents/Tasks 面板由 pi-subagents/pi-tasks 独立 widget 负责，不经 tool 卡外置。
 *
 * 工具计数：read 按非空路径去重、其余按调用计数（首次出现顺序）；edit/write 不进摘要。
 * 时长 = 回合流逝挂钟；进行中 Running...，结束 Ran for。
 * abort/error/length 状态行挂在摘要外层，避免被折叠吞掉。
 * 最终 agent 回合摘要由 feature/agent-summary 独占（bash/read/edit/write/other）。
 *
 * 补丁生命周期遵循仓库既有模式：Symbol 所有权、dispose 仅恢复仍由本安装持有的
 * 方法、重入守卫防止 /reload 后残留闭包递归。
 */
import {
	AssistantMessageComponent,
	ToolExecutionComponent,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, Box } from "@earendil-works/pi-tui";
import { config, getToolDisplayConfig } from "../config/config.ts";
import { toolLoadingIcon } from "../utils/tool-loading-icon.ts";
import { sanitizeToolResultText } from "../utils/tool-result-sanitize.ts";
import { refreshTranscriptComponent } from "./transcript-refresh.ts";
import { getMessageDisplayTheme } from "./tool/message-display.ts";
import { showMoreHintText } from "./tool/show-more-hint.ts";
import {
	countEditDiffStats,
	countWriteDiffStats,
	isRichDiffComponent,
} from "./tool/diff/diff-renderer.ts";
import { renderRichToolResult } from "./tool/diff/index.ts";
import type { WriteExecutionMetadataStore } from "./tool/diff/write-execution.ts";
import { insetComponent, renderExpandedToolResult, scheduleAnimation } from "./tool/result.ts";
import { oneLine } from "../utils/format.ts";
import { paddedBackgroundRow } from "./tool/grouping.ts";
import { hasVisibleText, stripBackgroundAnsi } from "../utils/ansi-text.ts";
import { walkComponentTree } from "../utils/component-tree.ts";
import {
	ASSISTANT_REENTRY_DESCRIPTION,
	ASSISTANT_REENTRY_KEY,
	ASSISTANT_SET_EXPANDED_DESCRIPTION,
	ASSISTANT_SET_EXPANDED_KEY,
	ASSISTANT_TOGGLE_ROUND_DESCRIPTION,
	ASSISTANT_TOGGLE_ROUND_KEY,
	COMPACT_MODE_PATCH_KEY,
	COMPACT_THINKING_PATCH_KEY,
	patchRegistry,
	PROTOTYPE_ORIGINAL_KEY,
} from "../utils/patch-keys.ts";

/** compact 渲染层对 compact-thinking 的只读查询面（不建第二套计时器）。 */
export type CompactThinkingQuery = {
	getMessageThinkingDurationMs(messageTimestamp: number): number | undefined;
	isMessageThinkingActive?(messageTimestamp: number): boolean;
	getThinkingAnimationFrame?(): number;
	setCompactSummaryActive?(active: boolean): void;
};

const EDIT_WRITE_TOOLS = new Set(["edit", "write"]);

type CompactThinkingTheme = Pick<Theme, "fg" | "italic" | "bold">;

/** 与 compact-thinking 主渲染器共用的静态文字样式。 */
export function styleCompactThinkingText(
	text: string,
	theme: CompactThinkingTheme | undefined,
	bold = false,
): string {
	if (!theme) return text;
	const colored = typeof theme.fg === "function" ? theme.fg("thinkingText", text) : text;
	const weighted = bold && typeof theme.bold === "function" ? theme.bold(colored) : colored;
	return typeof theme.italic === "function" ? theme.italic(weighted) : weighted;
}

/** 与 compact-thinking 主渲染器共用的活动思考扫光动画。 */
export function animateCompactThinkingText(
	text: string,
	theme: CompactThinkingTheme | undefined,
	animationFrame: number,
	boldBase = false,
): string {
	if (!theme) return text;
	const characters = Array.from(text);
	if (characters.length === 0) return "";
	const highlightWidth = Math.max(1, Math.min(5, Math.ceil(characters.length * 0.28)));
	const start = (animationFrame % (characters.length + highlightWidth)) - highlightWidth;
	const end = start + highlightWidth;
	const before = characters.slice(0, Math.max(0, start)).join("");
	const highlighted = characters
		.slice(Math.max(0, start), Math.min(characters.length, end))
		.join("");
	const after = characters.slice(Math.max(0, end)).join("");
	const highlightedColored =
		highlighted && typeof theme.fg === "function" ? theme.fg("text", highlighted) : highlighted;
	const highlightedWeighted =
		highlightedColored && typeof theme.bold === "function"
			? theme.bold(highlightedColored)
			: highlightedColored;
	const highlightedText =
		highlightedWeighted && typeof theme.italic === "function"
			? theme.italic(highlightedWeighted)
			: highlightedWeighted;

	return (
		styleCompactThinkingText(before, theme, boldBase) +
		highlightedText +
		styleCompactThinkingText(after, theme, boldBase)
	);
}

function formatThoughtDuration(durationMs: number) {
	if (durationMs < 1_000) {
		return `${Math.max(1, Math.round(durationMs))}ms`;
	}

	const totalSeconds = Math.max(1, Math.round(durationMs / 1_000));
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	if (minutes === 0) return `${seconds}s`;
	return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
}

export { formatThoughtDuration };

/** assistant stopReason → 外层状态文案（与 Pi 原生口径对齐）。 */
export function messageStopStatus(message: any): string | undefined {
	const reason = message?.stopReason;
	if (reason === "aborted") {
		return message.errorMessage && message.errorMessage !== "Request was aborted"
			? String(message.errorMessage)
			: "Operation aborted";
	}
	if (reason === "error") {
		return `Error: ${message.errorMessage || "Unknown error"}`;
	}
	if (reason === "length") {
		return "Response was truncated before completion.";
	}
	return undefined;
}

function roundStopStatus(messages: Iterable<any>): string | undefined {
	for (const message of messages) {
		const status = messageStopStatus(message);
		if (status) return status;
	}
	return undefined;
}

/**
 * 逐条 assistant message 的摘要文本（无工具计数时可为空串）：
 * 时长 = max(thinking query, durationFloorMs 挂钟)；工具首次出现顺序；read 路径去重。
 */
function buildMessagesSummary(
	messages: Iterable<any>,
	query?: CompactThinkingQuery,
	runningActiveOverride?: boolean,
	durationFloorMs?: number,
): string {
	const parts: string[] = [];
	const counts = new Map<string, number>();
	const readPaths = new Set<string>();
	const durationTimestamps = new Set<number>();
	let durationMs = 0;
	let runningActive = false;

	for (const message of messages) {
		if (typeof message?.timestamp === "number" && !durationTimestamps.has(message.timestamp)) {
			durationTimestamps.add(message.timestamp);
			if (query?.isMessageThinkingActive?.(message.timestamp)) runningActive = true;
			const value = query?.getMessageThinkingDurationMs(message.timestamp);
			if (typeof value === "number" && Number.isFinite(value) && value > 0) durationMs += value;
		}
		const content = Array.isArray(message?.content) ? message.content : [];
		for (const item of content) {
			if (item?.type !== "toolCall") continue;
			const rawName = typeof item.name === "string" ? item.name : "tool";
			if (EDIT_WRITE_TOOLS.has(rawName)) continue;
			const name = sanitizeToolResultText(rawName);
			if (rawName.split(".").pop() === "read") {
				const args = item.arguments ?? item.args ?? {};
				const path = args.path ?? args.file_path ?? args.file;
				if (typeof path === "string" && path.length > 0) {
					if (readPaths.has(path)) continue;
					readPaths.add(path);
				}
			}
			counts.set(name, (counts.get(name) ?? 0) + 1);
		}
	}

	if (
		typeof durationFloorMs === "number" &&
		Number.isFinite(durationFloorMs) &&
		durationFloorMs > durationMs
	) {
		durationMs = durationFloorMs;
	}

	runningActive = runningActiveOverride ?? runningActive;
	if (runningActive) {
		parts.push(durationMs > 0 ? `Running... · ${formatThoughtDuration(durationMs)}` : "Running...");
	} else if (durationMs > 0) parts.push(`Ran for ${formatThoughtDuration(durationMs)}`);
	for (const [name, count] of counts) parts.push(`${name}×${count}`);
	return parts.join(", ");
}

export function buildMessageSummary(
	message: any,
	query?: CompactThinkingQuery,
	durationFloorMs?: number,
): string {
	return buildMessagesSummary([message], query, undefined, durationFloorMs);
}

function fallbackTheme(): any {
	return {
		fg: (_color: string, text: string) => text,
		italic: (text: string) => text,
		bold: (text: string) => text,
	};
}

function themeOf(): any {
	return getMessageDisplayTheme() ?? fallbackTheme();
}

/** RGB → HSL（h∈[0,1), l/s∈[0,1]）。 */
function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
	r /= 255;
	g /= 255;
	b /= 255;
	const max = Math.max(r, g, b);
	const min = Math.min(r, g, b);
	const l = (max + min) / 2;
	if (max === min) return [0, 0, l];
	const d = max - min;
	const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
	let h: number;
	switch (max) {
		case r:
			h = (g - b) / d + (g < b ? 6 : 0);
			break;
		case g:
			h = (b - r) / d + 2;
			break;
		default:
			h = (r - g) / d + 4;
	}
	return [h / 6, l, s];
}

/** HSL → RGB（h∈[0,1)，l/s∈[0,1]）。 */
function hslToRgb(h: number, l: number, s: number): [number, number, number] {
	if (s === 0) {
		const v = Math.round(l * 255);
		return [v, v, v];
	}
	const hue2rgb = (p: number, q: number, t: number): number => {
		if (t < 0) t += 1;
		if (t > 1) t -= 1;
		if (t < 1 / 6) return p + (q - p) * 6 * t;
		if (t < 1 / 2) return q;
		if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
		return p;
	};
	const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
	const p = 2 * l - q;
	return [
		Math.round(hue2rgb(p, q, h + 1 / 3) * 255),
		Math.round(hue2rgb(p, q, h) * 255),
		Math.round(hue2rgb(p, q, h - 1 / 3) * 255),
	];
}

/** 内部 tool call card 背景：在 userMessageBg 基础上按 HSL 变暗（l×0.7），
 *  与外卡片形成嵌套层次；非 RGB 色或已足够暗时原样返回。 */
function darkenBgAnsi(theme: any, slot: string): string {
	const prefix = typeof theme?.getBgAnsi === "function" ? String(theme.getBgAnsi(slot)) : "";
	const m = prefix.match(/48;2;(\d+);(\d+);(\d+)/);
	if (!m) return prefix;
	const [h, l, s] = rgbToHsl(Number(m[1]), Number(m[2]), Number(m[3]));
	if (l <= 0.05) return prefix; // 已足够暗，不再变暗
	const [r, g, b] = hslToRgb(h, l * 0.7, s);
	return `\x1b[48;2;${r};${g};${b}m`;
}

/** 工具卡深色行：左右内缩（左 2 右 3 格，含工具卡自身 padding），背景只到内容区，
 *  修复行尾 reset 截断。 */
function toolCardBgRow(
	theme: any,
	slot: string,
	bgAnsi: string,
	line: string,
	width: number,
): string {
	const leftInset = 2;
	const rightInset = 3;
	const contentWidth = Math.max(0, width - leftInset - rightInset);
	// 深色块内左右各 1 格内部 padding；去掉行首原有空格后重新对齐
	const text = stripBackgroundAnsi(line).replace(/^ +/, "");
	const innerPad = 2;
	const clipped = truncateToWidth(text, Math.max(0, contentWidth - innerPad), "");
	const pad = Math.max(0, contentWidth - innerPad - visibleWidth(clipped));
	const body = ` ${clipped}${" ".repeat(pad)} `;
	const stable = body.replace(/\x1b\[(?:0)?m/g, (reset) => reset + bgAnsi);
	const outerBg = typeof theme?.getBgAnsi === "function" ? String(theme.getBgAnsi(slot)) : "";
	const inset = (n: number) => (outerBg ? `${outerBg}${" ".repeat(n)}\x1b[49m` : " ".repeat(n));
	return `${inset(leftInset)}${bgAnsi}${stable}\x1b[49m${inset(rightInset)}`;
}
/** edit/write 展开卡：保持原样式（userMessageBg Box），不应用工具卡深色/间距改动。 */
function editWriteExpandedCard(theme: any): any {
	return new Box(
		1,
		1,
		typeof theme.bg === "function" ? (text: string) => theme.bg("userMessageBg", text) : undefined,
	);
}

/** compact 展开卡：外卡片保持 userMessageBg 原色；内部 tool call card（addToolChild）
 *  背景更深一层且只覆盖内容区（左右内缩、上下限首尾文本行），形成嵌套层次。
 *  逐行重建背景同时修复嵌套 Box 的右侧截断。 */
function expandedToolCard(theme: any): any {
	const slot = "userMessageBg";
	const toolBgAnsi = darkenBgAnsi(theme, slot);
	const children: any[] = [];
	return {
		children,
		addChild(child: any) {
			children.push(child);
		},
		addToolChild(child: any) {
			child.__ccToolCard = true;
			children.push(child);
		},
		render(width: number): string[] {
			const innerWidth = Math.max(0, width - 2);
			const lines: string[] = [];
			lines.push(paddedBackgroundRow(theme, slot, "", width));
			// 展开不再显示摘要行：跳过第一个 child 的首行空白，避免白占一行
			let skipLeadingBlank = true;
			for (const child of children) {
				const childLines = child.render(innerWidth);
				if (!child.__ccToolCard) {
					let start = 0;
					if (skipLeadingBlank) {
						while (start < childLines.length && !hasVisibleText(childLines[start])) start++;
						skipLeadingBlank = false;
					}
					for (let i = start; i < childLines.length; i++) {
						lines.push(paddedBackgroundRow(theme, slot, childLines[i], width));
					}
					continue;
				}
				// 工具卡：前导 1 空行 + 首尾文本行之间的内容区（深色）；不保留尾随，
				// 相邻工具卡之间正好 1 空行，底部由卡片 padding 收尾。
				skipLeadingBlank = false;
				let first = -1;
				let last = -1;
				for (let i = 0; i < childLines.length; i++) {
					if (hasVisibleText(childLines[i])) {
						if (first < 0) first = i;
						last = i;
					}
				}
				if (first < 0) {
					for (const line of childLines) {
						lines.push(paddedBackgroundRow(theme, slot, line, width));
					}
					continue;
				}
				lines.push(paddedBackgroundRow(theme, slot, "", width));
				// 子卡片内部上下各 1 行深色 padding
				lines.push(toolCardBgRow(theme, slot, toolBgAnsi, "", width));
				for (let i = first; i <= last; i++) {
					lines.push(toolCardBgRow(theme, slot, toolBgAnsi, childLines[i], width));
				}
				lines.push(toolCardBgRow(theme, slot, toolBgAnsi, "", width));
			}
			lines.push(paddedBackgroundRow(theme, slot, "", width));
			return lines;
		},
		invalidate() {},
	};
}

function isAssistantComponent(value: any): boolean {
	return value instanceof AssistantMessageComponent;
}

function isToolComponent(value: any): boolean {
	return value instanceof ToolExecutionComponent;
}

function detachAssistantExpansion(component: any): void {
	let owned =
		typeof component?.[ASSISTANT_SET_EXPANDED_KEY] === "function" &&
		component.setExpanded === component[ASSISTANT_SET_EXPANDED_KEY];
	if (!owned && component && typeof component === "object") {
		// 首次升级时清理旧模块使用 Symbol() 留下的实例方法。
		owned = Object.getOwnPropertySymbols(component).some(
			(symbol) =>
				symbol.description === ASSISTANT_SET_EXPANDED_DESCRIPTION && component[symbol] === true,
		);
	}
	if (!owned) return;

	delete component.setExpanded;
	for (const symbol of Object.getOwnPropertySymbols(component)) {
		if (
			symbol.description === ASSISTANT_SET_EXPANDED_DESCRIPTION ||
			symbol.description === ASSISTANT_TOGGLE_ROUND_DESCRIPTION ||
			symbol.description === ASSISTANT_REENTRY_DESCRIPTION
		) {
			delete component[symbol];
		}
	}
}

/** 供 mouse-interaction 识别可点击的 compact assistant 行（仅 compact 模式下生效）。 */
export function isCompactAssistantComponent(value: unknown): boolean {
	if (config.mode !== "compact" || !value || typeof value !== "object") return false;
	const component = value as any;
	return (
		typeof component[ASSISTANT_SET_EXPANDED_KEY] === "function" &&
		component.setExpanded === component[ASSISTANT_SET_EXPANDED_KEY]
	);
}

export type CompactModeHooks = {
	/** 会话事件后同步：所有权、全局展开状态、已挂载组件。 */
	sync(ctx: any): void;
	/** 重绘所有被跟踪的 assistant/tool 组件（模式切换用）。 */
	refresh(): void;
	/** compact 模式下重新认领 assistant patch（位于 compact-thinking 之上）。 */
	assertOwnership(): void;
	/** 重新渲染包含指定 toolCallId 的 assistant 消息（思考收尾时刷新）。 */
	refreshToolCallMessage(toolCallId: string | undefined): void;
	shutdown(): void;
};

type CompactModeInstallDeps = {
	query?: CompactThinkingQuery;
	writeMetadata: WriteExecutionMetadataStore;
};

type CompactModePatch = {
	active: boolean;
	prototype: any;
	assistantInstalled: (...args: any[]) => any;
	assistantOriginal: (...args: any[]) => any;
	assistantNative: (...args: any[]) => any;
	toolInstalledRender: (width: number) => string[];
	toolInstalledUpdateDisplay: () => void;
	toolOriginalRender: (width: number) => string[];
	toolOriginalUpdateDisplay: () => void;
	assertAssistantOwnership: () => void;
	dispose: () => void;
};

const trackedAssistantComponents = new Set<any>();
const trackedToolComponents = new Set<any>();
let hoveredAssistantComponent: any;

export function setHoveredCompactAssistant(component: any): boolean {
	if (hoveredAssistantComponent === component) return false;
	hoveredAssistantComponent = component;
	return true;
}

function compactEditWriteLine(
	component: any,
	width: number,
	writeMetadata?: WriteExecutionMetadataStore,
): string[] {
	const theme = themeOf();
	const name = String(component.toolName ?? "tool");
	const args = component.args ?? {};
	const path = sanitizeToolResultText(
		typeof args.path === "string" && args.path
			? args.path
			: typeof args.file_path === "string" && args.file_path
				? args.file_path
				: "",
	);
	const isError = component.result?.isError === true;
	const isPending = !component.result || component.isPartial === true;
	const icon = isError ? "✗" : isPending ? toolLoadingIcon() : "✓";
	const iconColor = isError ? "error" : isPending ? "accent" : "success";
	let statsText = "";
	let statsStyled = "";
	if (!isError && !isPending) {
		const stats =
			name === "edit"
				? countEditDiffStats(component.result?.details)
				: name === "write"
					? countWriteDiffStats(
							typeof args.content === "string" ? args.content : undefined,
							writeMetadata?.get(component.toolCallId)?.previousContent,
							writeMetadata?.get(component.toolCallId)?.fileExistedBeforeWrite,
						)
					: undefined;
		if (stats) {
			statsText = ` (+${stats.added} -${stats.removed})`;
			statsStyled = ` ${theme.fg("dim", "(")}${theme.fg("success", `+${stats.added}`)} ${theme.fg("error", `-${stats.removed}`)}${theme.fg("dim", ")")}`;
		}
	}
	const iconPart = ` ${theme.fg(iconColor, icon)} `;
	const namePart = theme.fg("toolTitle", name);
	const hintText = component.expanded ? "" : ` • ${showMoreHintText()}`;
	const fixedWidth =
		visibleWidth(iconPart) +
		visibleWidth(namePart) +
		visibleWidth(statsText) +
		visibleWidth(hintText);
	const pathWidth = Math.max(0, width - fixedWidth - (path ? 1 : 0));
	const pathPart = pathWidth > 0 && path ? ` ${oneLine(path, pathWidth)}` : "";
	const line = `${iconPart}${namePart}${theme.fg("toolTitle", pathPart)}${statsStyled}${hintText ? theme.fg("dim", hintText) : ""}`;
	return ["", truncateToWidth(line, width, "")];
}

/** compact edit/write 展开：复用 mode=on 的 rich diff；不可用时回退 Input/Output。 */
function compactEditWriteExpandedLines(
	component: any,
	width: number,
	writeMetadata?: WriteExecutionMetadataStore,
): string[] {
	const theme = themeOf();
	const result = component.result;
	const isError = result?.isError === true;
	const candidate = writeMetadata
		? renderRichToolResult(
				String(component.toolName ?? ""),
				result,
				{
					expanded: true,
					isPartial: component.isPartial === true,
					isError,
				},
				theme,
				component,
				writeMetadata,
				getToolDisplayConfig,
			)
		: undefined;
	let detail: any;
	if (isRichDiffComponent(candidate)) {
		component.resultRendererComponent = candidate;
		detail = insetComponent(candidate as any);
	} else {
		const outputText = sanitizeToolResultText(
			Array.isArray(result?.content)
				? result.content
						.filter((item: any) => item?.type === "text")
						.map((item: any) => String(item.text ?? ""))
						.join("\n")
				: "",
		);
		const state = (component.state ??= {});
		detail = renderExpandedToolResult(
			outputText,
			theme,
			isError,
			state.ccstyleIoView,
			component.args,
			component,
		);
		component.resultRendererComponent = detail;
	}

	const box = editWriteExpandedCard(theme);
	box.addChild({
		render(innerWidth: number): string[] {
			return compactEditWriteLine(component, innerWidth, writeMetadata).slice(1);
		},
		invalidate() {},
	});
	box.addChild(detail);
	return box.render(width);
}

function compactAssistantLineComponent(
	component: any,
	/** 静态串或每次 render 重算（Running 时长需逐步跳动）。 */
	summary: string | (() => string),
	query?: CompactThinkingQuery,
	options: { hint?: boolean; leadingBlank?: boolean; pad?: number } = {},
): any {
	const self = component as any;
	return {
		render(width: number): string[] {
			const theme = themeOf();
			const pad = Math.max(0, options.pad ?? (Number(self.outputPad) || 0));
			const available = Math.max(0, width - pad);
			const hintText = options.hint === false ? "" : ` • ${showMoreHintText()}`;
			const summaryWidth = Math.max(0, available - visibleWidth(hintText));
			const resolved = typeof summary === "function" ? summary() : summary;
			const runningActive = resolved.startsWith("Running...");
			const plainText = truncateToWidth(resolved, summaryWidth, "…");
			let text = theme.fg("muted", plainText);
			if (runningActive || plainText.startsWith("Ran for ")) {
				const separator = plainText.indexOf(", ");
				const heading = separator < 0 ? plainText : plainText.slice(0, separator);
				const tools = separator < 0 ? "" : plainText.slice(separator);
				if (runningActive) {
					const durationSeparator = heading.indexOf(" · ");
					const label = durationSeparator < 0 ? heading : heading.slice(0, durationSeparator);
					const duration = durationSeparator < 0 ? "" : heading.slice(durationSeparator);
					text = `${animateCompactThinkingText(
						label,
						theme,
						query?.getThinkingAnimationFrame?.() ?? 0,
					)}${styleCompactThinkingText(duration, theme)}${theme.fg("muted", tools)}`;
				} else {
					text = `${styleCompactThinkingText(heading, theme)}${theme.fg("muted", tools)}`;
				}
			}
			const hintColor = hoveredAssistantComponent === component ? "text" : "dim";
			const line = `${text}${hintText ? theme.fg(hintColor, hintText) : ""}`;
			const rendered = `${" ".repeat(pad)}${truncateToWidth(line, available, "")}`;
			return options.leadingBlank === false ? [rendered] : ["", rendered];
		},
		invalidate() {},
	};
}

function compactStopStatusLine(status: string, pad = 0): any {
	return {
		render(width: number): string[] {
			const theme = themeOf();
			const prefix = " ".repeat(Math.max(0, pad));
			const line = `${prefix}${theme.fg("error", status)}`;
			return ["", truncateToWidth(line, width, "")];
		},
		invalidate() {},
	};
}

function compactAssistantLine(
	component: any,
	summary: string | (() => string),
	query?: CompactThinkingQuery,
): void {
	// 空静态串跳过；getter 留给 render 判断（Running 可能稍后才有时长）。
	if (typeof summary === "string" && !summary) return;
	component.contentContainer.addChild(compactAssistantLineComponent(component, summary, query));
}

function appendStopStatus(component: any, status: string | undefined): void {
	if (!status || !component?.contentContainer?.addChild) return;
	component.contentContainer.addChild(
		compactStopStatusLine(status, Number(component.outputPad) || 0),
	);
}

function ensureAssistantSetExpanded(component: any): void {
	if (
		typeof component[ASSISTANT_SET_EXPANDED_KEY] === "function" &&
		component.setExpanded === component[ASSISTANT_SET_EXPANDED_KEY]
	) {
		return;
	}
	if (typeof component.setExpanded === "function") {
		detachAssistantExpansion(component);
		if (typeof component.setExpanded === "function") return;
	}
	const installed = function (this: any, expanded: boolean) {
		if (config.mode !== "compact") {
			detachAssistantExpansion(this);
			return;
		}
		const toggleRound = this[ASSISTANT_TOGGLE_ROUND_KEY];
		if (typeof toggleRound === "function") {
			toggleRound(expanded);
			return;
		}
		this.expanded = expanded;
		if (typeof this.updateContent === "function" && this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	};
	component[ASSISTANT_SET_EXPANDED_KEY] = installed;
	component.setExpanded = installed;
}

function collectMountedComponents(root: any): void {
	if (!root || typeof root !== "object") return;
	const assistants = new Set<any>();
	const tools = new Set<any>();
	walkComponentTree(root, (value: any) => {
		if (isAssistantComponent(value)) {
			assistants.add(value);
			// 仅在 compact 模式给实例装 setExpanded，避免 on/off 下 Ctrl+O/mouse 回归。
			if (config.mode === "compact") ensureAssistantSetExpanded(value);
		} else if (isToolComponent(value)) {
			tools.add(value);
		}
	});
	// 扫到组件才替换跟踪表。面板/custom UI 打开时 root 往往扫不到 transcript，
	// 若此时清空会丢掉 live updateContent/updateDisplay 已登记的实例，
	// /ccstyle 切换就只能靠 /reload 重建。
	if (assistants.size > 0 || tools.size > 0) {
		trackedAssistantComponents.clear();
		trackedToolComponents.clear();
		for (const component of assistants) trackedAssistantComponents.add(component);
		for (const component of tools) trackedToolComponents.add(component);
	} else if (config.mode === "compact") {
		for (const component of trackedAssistantComponents) ensureAssistantSetExpanded(component);
	}
}

export function installCompactMode(deps: CompactModeInstallDeps): CompactModeHooks {
	const previous = patchRegistry.get<CompactModePatch>(COMPACT_MODE_PATCH_KEY);
	if (previous) previous.dispose();

	const assistantPrototype = AssistantMessageComponent.prototype as any;
	const toolPrototype = ToolExecutionComponent.prototype as any;
	const patch: CompactModePatch = {
		active: true,
		prototype: assistantPrototype,
		assistantInstalled: undefined as any,
		assistantOriginal: assistantPrototype.updateContent,
		assistantNative: assistantPrototype.updateContent,
		toolInstalledRender: undefined as any,
		toolInstalledUpdateDisplay: undefined as any,
		toolOriginalRender: toolPrototype.render,
		toolOriginalUpdateDisplay: toolPrototype.updateDisplay,
		assertAssistantOwnership: () => {},
		dispose: () => {},
	};

	const passThroughAssistant = (component: any, message: any, isStreaming?: boolean): any => {
		const self = component as any;
		if (self[ASSISTANT_REENTRY_KEY] === patch)
			return patch.assistantNative.call(component, message, isStreaming);
		self[ASSISTANT_REENTRY_KEY] = patch;
		try {
			return patch.assistantOriginal.call(component, message, isStreaming);
		} finally {
			delete self[ASSISTANT_REENTRY_KEY];
		}
	};

	type CompactRound = {
		anchor: any;
		messages: Map<any, any>;
		detachedMessages: any[];
		active: boolean;
		suppressedToolIds: Set<string>;
		/** 回合挂钟起点，保证 Running 时长连续递增。 */
		startedAt: number;
		endedAt?: number;
	};
	let activeRound: CompactRound | undefined;
	let roundByComponent = new WeakMap<object, CompactRound>();
	const expandedRoundToolIds = new Set<string>();
	let uiRef: { requestRender?: (force?: boolean) => void } | undefined;
	let roundTickTimer: ReturnType<typeof setInterval> | undefined;

	const roundWallMs = (round: CompactRound): number => {
		const end = round.active ? Date.now() : (round.endedAt ?? Date.now());
		return Math.max(1, end - round.startedAt);
	};

	const summarize = (messages: Iterable<any>, runningActive?: boolean, round?: CompactRound) =>
		buildMessagesSummary(
			messages,
			deps.query,
			runningActive,
			round ? roundWallMs(round) : undefined,
		);

	const stopRoundTick = (): void => {
		if (!roundTickTimer) return;
		clearInterval(roundTickTimer);
		roundTickTimer = undefined;
	};

	// 自备 tick：getter 在 render 重算挂钟；兼驱动 Running 扫光（setCompactSummaryActive）。
	const ensureRoundTick = (): void => {
		if (roundTickTimer) return;
		roundTickTimer = setInterval(() => {
			if (!patch.active || !activeRound?.active) {
				stopRoundTick();
				return;
			}
			try {
				uiRef?.requestRender?.(true);
			} catch {
				/* 无 UI */
			}
		}, 250);
	};

	/** 结束回合活动态；可选立即重绘。 */
	const endRound = (round: CompactRound, render = false): void => {
		round.active = false;
		if (round.endedAt === undefined) round.endedAt = Date.now();
		if (activeRound === round) {
			activeRound = undefined;
			deps.query?.setCompactSummaryActive?.(false);
			stopRoundTick();
		}
		if (render) renderRound(round);
	};

	const renderAssistantWithoutThinking = (
		component: any,
		message: any,
		isStreaming?: boolean,
	): any => {
		const content = Array.isArray(message?.content) ? message.content : [];
		const result = passThroughAssistant(
			component,
			{
				...message,
				content: content.filter((item: any) => item?.type !== "thinking"),
			},
			isStreaming,
		);
		component.lastMessage = message;
		return result;
	};

	const roundMessages = (round: CompactRound): any[] => [
		...round.messages.values(),
		...round.detachedMessages,
	];

	const roundToolCallIds = (round: CompactRound): Set<string> => {
		const ids = new Set<string>();
		for (const message of roundMessages(round)) {
			for (const item of Array.isArray(message?.content) ? message.content : []) {
				if (item?.type === "toolCall" && typeof item.id === "string") ids.add(item.id);
			}
		}
		return ids;
	};

	const renderRound = (round: CompactRound): void => {
		const messages = roundMessages(round);
		const stopStatus = roundStopStatus(messages);
		if (stopStatus) endRound(round);
		// Running 时每次 render 重算时长（含挂钟下限）；结束后固定。
		const getSummary = () => summarize(roundMessages(round), round.active, round);
		const summary = getSummary();
		for (const id of round.suppressedToolIds) expandedRoundToolIds.delete(id);
		round.suppressedToolIds.clear();

		for (const [component, message] of round.messages) {
			component.lastMessage = message;
			ensureAssistantSetExpanded(component);
			component[ASSISTANT_TOGGLE_ROUND_KEY] = (expanded: boolean) => {
				for (const member of round.messages.keys()) member.expanded = expanded;
				if (!expanded) {
					for (const id of round.suppressedToolIds) expandedRoundToolIds.delete(id);
					round.suppressedToolIds.clear();
				}
				renderRound(round);
			};
		}

		if (round.anchor.expanded === true) {
			const assistantChildren: any[] = [];
			for (const [component, message] of round.messages) {
				passThroughAssistant(component, message);
				if (Array.isArray(component.contentContainer?.children)) {
					assistantChildren.push(...component.contentContainer.children);
				}
				component.contentContainer?.clear?.();
			}
			const ids = roundToolCallIds(round);
			for (const id of ids) {
				round.suppressedToolIds.add(id);
				expandedRoundToolIds.add(id);
			}
			// Round 展开只打开外层卡片。普通工具保持折叠，避免长输出递归撑满屏幕。
			for (const tool of trackedToolComponents) {
				if (
					!ids.has(tool.toolCallId) ||
					EDIT_WRITE_TOOLS.has(String(tool.toolName ?? "")) ||
					tool.expanded !== true
				) {
					continue;
				}
				if (typeof tool.setExpanded === "function") tool.setExpanded(false);
				else {
					tool.expanded = false;
					tool.updateDisplay?.();
				}
			}
			round.anchor.contentContainer.addChild({
				render(width: number): string[] {
					const theme = themeOf();
					const box = expandedToolCard(theme);
					for (const child of assistantChildren) box.addChild(child);
					const ids = roundToolCallIds(round);
					for (const tool of trackedToolComponents) {
						if (!ids.has(tool.toolCallId) || EDIT_WRITE_TOOLS.has(String(tool.toolName ?? ""))) {
							continue;
						}
						box.addToolChild({
							render: (innerWidth: number) => patch.toolOriginalRender.call(tool, innerWidth),
							invalidate: () => tool.invalidate?.(),
						});
					}
					return ["", ...box.render(width)];
				},
				invalidate() {
					for (const child of assistantChildren) child.invalidate?.();
				},
			});
			// 展开卡内工具会显示 error，外层仍挂 abort/length，避免只藏在折叠工具里。
			appendStopStatus(round.anchor, stopStatus);
			return;
		}

		for (const [component, message] of round.messages) {
			if (component === round.anchor) {
				renderAssistantWithoutThinking(component, message);
				// 空摘要不挂行（getter 在 Running 启动瞬间也可能短暂为空）
				if (summary || round.active) compactAssistantLine(component, getSummary, deps.query);
				// 折叠时工具行被隐藏：abort/error/length 必须挂在摘要外层。
				appendStopStatus(component, stopStatus);
			} else {
				component.contentContainer?.clear?.();
			}
		}
	};

	const activateRound = (round: CompactRound): void => {
		round.active = true;
		if (!round.startedAt) round.startedAt = Date.now();
		delete round.endedAt;
		activeRound = round;
		deps.query?.setCompactSummaryActive?.(true);
		ensureRoundTick();
	};

	const finishRound = (round: CompactRound): void => endRound(round, true);

	const resetRounds = (): void => {
		activeRound = undefined;
		roundByComponent = new WeakMap();
		expandedRoundToolIds.clear();
		deps.query?.setCompactSummaryActive?.(false);
		stopRoundTick();
	};

	patch.assistantInstalled = function (this: any, message: any, isStreaming?: boolean) {
		const self = this as any;
		// 同 compact-thinking：isStreaming 丢失 → mermaid 流式误渲染来回闪。
		if (isStreaming !== undefined) self.isStreaming = isStreaming;
		if (self[ASSISTANT_REENTRY_KEY] === patch) {
			return patch.assistantNative.call(this, message, isStreaming);
		}
		self.lastMessage = message;
		trackedAssistantComponents.add(this);
		if (!patch.active || config.mode !== "compact") {
			return passThroughAssistant(this, message, isStreaming);
		}
		if (!self.contentContainer || typeof self.contentContainer.clear !== "function") {
			return passThroughAssistant(this, message, isStreaming);
		}

		const content = Array.isArray(message?.content) ? message.content : [];
		const hasToolCalls = content.some((item: any) => item?.type === "toolCall");
		const hasText = content.some(
			(item: any) => item?.type === "text" && typeof item.text === "string" && item.text.trim(),
		);
		self.hasToolCalls = hasToolCalls;

		if (hasToolCalls) {
			let round = roundByComponent.get(this);
			if (hasText && (!round || round.anchor !== this)) {
				if (round) round.messages.delete(this);
				if (activeRound) finishRound(activeRound);
				round = {
					anchor: this,
					messages: new Map(),
					detachedMessages: [],
					active: true,
					suppressedToolIds: new Set(),
					startedAt: Date.now(),
				};
				roundByComponent.set(this, round);
				activateRound(round);
			} else if (!round) {
				round = activeRound ?? {
					anchor: this,
					messages: new Map(),
					detachedMessages: [],
					active: true,
					suppressedToolIds: new Set(),
					startedAt: Date.now(),
				};
				roundByComponent.set(this, round);
				if (!activeRound) activateRound(round);
			}
			round.messages.set(this, message);
			renderRound(round);
			return undefined;
		}

		if (hasText) {
			const round = roundByComponent.get(this);
			const previousMessage = round?.messages.get(this);
			if (round && previousMessage && (round.anchor !== this || round.messages.size > 1)) {
				// 最终回答开始后，当前组件恢复原生文本；它已完成的 thinking
				// 留在上一轮摘要中，避免再次生成独立 Thought 行。
				round.messages.delete(this);
				round.detachedMessages.push(previousMessage);
				roundByComponent.delete(this);
				finishRound(round);
				return renderAssistantWithoutThinking(this, message);
			}
			if (round) {
				endRound(round);
				roundByComponent.delete(this);
				return passThroughAssistant(this, message);
			}
			if (activeRound) finishRound(activeRound);
			return renderAssistantWithoutThinking(this, message);
		}

		const hasThinking = content.some((item: any) => item?.type === "thinking");
		if (hasThinking) {
			let round = roundByComponent.get(this);
			if (!round) {
				round = activeRound ?? {
					anchor: this,
					messages: new Map(),
					detachedMessages: [],
					active: true,
					suppressedToolIds: new Set(),
					startedAt: Date.now(),
				};
				roundByComponent.set(this, round);
				if (!activeRound) activateRound(round);
			}
			round.messages.set(this, message);
			renderRound(round);
			return undefined;
		}

		// 无可见内容的 abort/error/length：直接外层状态行，并结束进行中的回合。
		const loneStatus = messageStopStatus(message);
		if (loneStatus) {
			if (activeRound) finishRound(activeRound);
			self.contentContainer.clear();
			appendStopStatus(this, loneStatus);
			return undefined;
		}

		self.contentContainer.clear();
		return undefined;
	};

	patch.toolInstalledRender = function (this: any, width: number) {
		if (!patch.active || config.mode !== "compact") {
			return patch.toolOriginalRender.call(this, width);
		}
		const name = String(this.toolName ?? "");
		if (EDIT_WRITE_TOOLS.has(name)) {
			if (!this.result || this.isPartial === true) scheduleAnimation(this);
			const lines = compactEditWriteLine(this, width, deps.writeMetadata);
			if (this.expanded !== true) return lines;
			return compactEditWriteExpandedLines(this, width, deps.writeMetadata);
		}
		// Agent/Task 等同普通工具：折叠不外置（live 面板走独立 widget）。
		if (expandedRoundToolIds.has(String(this.toolCallId ?? ""))) return [];
		// 普通工具折叠时不显示独立行（摘要行已统计），独立展开走原 renderer。
		if (this.expanded === true) {
			return patch.toolOriginalRender.call(this, width);
		}
		return [];
	};

	patch.toolInstalledUpdateDisplay = function (this: any) {
		if (
			patch.active &&
			config.mode === "compact" &&
			expandedRoundToolIds.has(String(this.toolCallId ?? ""))
		) {
			this.expanded = false;
		}
		const result = patch.toolOriginalUpdateDisplay.call(this);
		if (!patch.active) return result;
		trackedToolComponents.add(this);
		return result;
	};

	patch.assertAssistantOwnership = () => {
		// compact 必须在外层：从 compact-thinking 包装器认领，或收回 mode=on/off
		// 时主动释放给 original/native 的所有权。未知外部包装器不抢，避免递归。
		if (!patch.active || assistantPrototype.updateContent === patch.assistantInstalled) return;
		const current = assistantPrototype.updateContent;
		if ((current as any)[COMPACT_THINKING_PATCH_KEY] === true) {
			patch.assistantOriginal = current;
			assistantPrototype.updateContent = patch.assistantInstalled;
			return;
		}
		if (current === patch.assistantOriginal || current === patch.assistantNative) {
			assistantPrototype.updateContent = patch.assistantInstalled;
		}
	};

	(patch.assistantInstalled as any)[PROTOTYPE_ORIGINAL_KEY] = patch.assistantNative;

	patch.dispose = () => {
		if (!patch.active) return;
		patch.active = false;
		if (assistantPrototype.updateContent === patch.assistantInstalled) {
			assistantPrototype.updateContent = patch.assistantOriginal;
		}
		if (toolPrototype.render === patch.toolInstalledRender) {
			toolPrototype.render = patch.toolOriginalRender;
		}
		if (toolPrototype.updateDisplay === patch.toolInstalledUpdateDisplay) {
			toolPrototype.updateDisplay = patch.toolOriginalUpdateDisplay;
		}
		patchRegistry.dispose(COMPACT_MODE_PATCH_KEY, patch);
		for (const component of trackedAssistantComponents) detachAssistantExpansion(component);
		trackedAssistantComponents.clear();
		trackedToolComponents.clear();
		hoveredAssistantComponent = undefined;
		resetRounds();
	};

	assistantPrototype.updateContent = patch.assistantInstalled;
	toolPrototype.render = patch.toolInstalledRender;
	toolPrototype.updateDisplay = patch.toolInstalledUpdateDisplay;
	patchRegistry.install(COMPACT_MODE_PATCH_KEY, patch);

	const syncGlobalExpanded = (ctx: any): void => {
		let globalExpanded = false;
		try {
			globalExpanded = ctx?.ui?.getToolsExpanded?.() === true;
		} catch {
			// 测试或无 UI 上下文时保持折叠。
		}
		for (const component of trackedAssistantComponents) component.expanded = globalExpanded;
		for (const component of trackedToolComponents) component.expanded = globalExpanded;
	};

	return {
		sync(ctx: any) {
			if (!patch.active) return;
			uiRef = ctx?.ui;
			resetRounds();
			// 始终保持补丁在链上：mode=on/off 走 passThrough，仍写入 lastMessage
			// 与 tracked 集合，这样 /ccstyle 切回 compact 时不必 /reload。
			patch.assertAssistantOwnership();
			if (config.mode === "compact") syncGlobalExpanded(ctx);
			else hoveredAssistantComponent = undefined;
			refreshTrackedComponents();
		},
		refresh() {
			if (!patch.active) return;
			resetRounds();
			patch.assertAssistantOwnership();
			if (config.mode !== "compact") hoveredAssistantComponent = undefined;
			refreshTrackedComponents();
		},
		assertOwnership() {
			if (!patch.active) return;
			patch.assertAssistantOwnership();
		},
		refreshToolCallMessage(toolCallId: string | undefined) {
			if (!patch.active || typeof toolCallId !== "string" || !toolCallId) return;
			for (const component of [...trackedAssistantComponents]) {
				const message = component.lastMessage;
				const contains =
					Array.isArray(message?.content) &&
					message.content.some((item: any) => item?.type === "toolCall" && item.id === toolCallId);
				if (!contains) continue;
				try {
					component.updateContent?.(message);
				} catch {
					trackedAssistantComponents.delete(component);
				}
			}
		},
		shutdown() {
			patch.dispose();
		},
	};
}

function refreshTrackedComponents(): void {
	for (const component of [...trackedAssistantComponents]) {
		try {
			if (config.mode !== "compact") detachAssistantExpansion(component);
			refreshTranscriptComponent(component);
		} catch {
			trackedAssistantComponents.delete(component);
		}
	}
	for (const component of [...trackedToolComponents]) {
		try {
			// 共享实现负责 updateDisplay；invalidate 属于 compact-mode 的跟踪语义。
			refreshTranscriptComponent(component);
			component.invalidate?.();
		} catch {
			trackedToolComponents.delete(component);
		}
	}
}

/** 供 renderer/index.ts 在 session 事件后收集 /reload 重建的组件。 */
export function refreshCompactModeComponents(root: any): void {
	collectMountedComponents(root);
}
