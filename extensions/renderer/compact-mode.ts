/**
 * Compact mode：每条含 toolCall 的 assistant message 折叠为一条逐步累加的摘要行
 * （`Ran for 8s, bash×2, read×2`），edit/write 独立标题行（`✓ write <path> (+25 -0)`），
 * 普通工具折叠时不显示独立行；展开（Ctrl+O / fullscreen 点击）时助手文本按原生渲染，
 * thinking 与工具卡装进 userMessageBg 面板（卡内恢复 compact-thinking/Pi 原生或专用
 * renderer）。edit/write 复用 mode=on 的 rich diff
 * 与 `editDiffCollapsedLines` / `writeDiffCollapsedLines` / `expandedPreviewMaxLines`。
 * Agent/Task 族：调用只进摘要计数，tool 卡始终折叠（避免 pending→完成高度闪动）。
 * 底部 Agents/Tasks 面板由 pi-subagents/pi-tasks 独立 widget 负责，不经 tool 卡外置。
 *
 * live 围观态（回合进行中 / 收尾静默期）：正文跟折叠态同形；摘要行与单一槽位卡
 * （`↳` + 最新的一个块：仍在增长的思考预览，或本回合最近的工具，运行中优先）挂在
 * transcript 容器的回合末尾（尾行组件，anchor 与工具卡之后、下一消息之前）。
 * 思考原地增长不轮换，只有新的思考块或工具调用进来才换槽位内容。
 * 摘要行挂末尾是刻意的：运行中它恒在可写视口底缘，收尾时原地从 Running... 翻成
 * Ran for 真实落进 scrollback；放在 anchor 内部则会被工具/diff 顶出视口后定格。
 * （anchor 未挂载进容器的独立渲染场景退回组件内旧行为。）
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
import { truncateToWidth, visibleWidth, Box, Spacer } from "@earendil-works/pi-tui";
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
import { isToolCallHovered } from "./mouse/hover.ts";
import { getToolMouseTui } from "./mouse/scroll.ts";
import { insetComponent, renderExpandedToolResult, scheduleAnimation } from "./tool/result.ts";
import { paddedBackgroundRow } from "./tool/grouping.ts";
import { formatDisplayPath } from "./tool/names.ts";
import {
	hasVisibleText,
	removeStyledRange,
	stripBackgroundAnsi,
	stripTerminalSequencesPreservingLayout,
} from "../utils/ansi-text.ts";
import { walkComponentTree } from "../utils/component-tree.ts";
import {
	ASSISTANT_REENTRY_KEY,
	ASSISTANT_SET_EXPANDED_KEY,
	ASSISTANT_TOGGLE_ROUND_KEY,
	COMPACT_MODE_PATCH_KEY,
	COMPACT_THINKING_PATCH_KEY,
	patchRegistry,
	PROTOTYPE_ORIGINAL_KEY,
	TOOL_GROUPING_PARENT_KEY,
} from "../utils/patch-keys.ts";

/** Pi 的 native 组件与扩展可能各持一份 pi-tui，Spacer 不能只靠 instanceof 判。 */
function isSpacerComponent(value: any): boolean {
	return value instanceof Spacer || value?.constructor?.name === "Spacer";
}

/** compact 渲染层对 compact-thinking 的只读查询面（不建第二套计时器）。 */
export type CompactThinkingQuery = {
	getMessageThinkingDurationMs(messageTimestamp: number): number | undefined;
	isMessageThinkingActive?(messageTimestamp: number): boolean;
	getThinkingAnimationFrame?(): number;
	setCompactSummaryActive?(active: boolean): void;
};

const EDIT_WRITE_TOOLS = new Set(["edit", "write"]);

/**
 * 回合收尾后延迟收拢的静默期（ms）。正文 token 往往先于 toolCall 到达，
 * 立刻收拢会得到「先收再开」两次转场；静默期内被新回合接替则一并收拢。
 */
const FOLD_SETTLE_MS = 250;

type CompactThinkingTheme = Pick<Theme, "fg" | "italic" | "bold">;

/** 与 compact-thinking 主渲染器共用的静态文字样式。 */
export function styleCompactThinkingText(
	text: string,
	theme: CompactThinkingTheme | undefined,
	bold = false,
): string {
	if (!theme) return text;
	const color = config.dimThinkingText ? "dim" : "thinkingText";
	const colored = typeof theme.fg === "function" ? theme.fg(color, text) : text;
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
/** edit/write 展开卡：保持原样式（展开卡背景 Box），不应用工具卡深色/间距改动。 */
function editWriteExpandedCard(theme: any): any {
	return new Box(
		1,
		1,
		typeof theme.bg === "function"
			? (text: string) => theme.bg(config.expandedCardBackground, text)
			: undefined,
	);
}

/** compact 展开面板：外卡片保持展开卡背景；展开的 thinking 另包一层更深的
 *  内卡（自身 Box 背景与外卡同色，不区分会糊在一起），工具卡直接铺在外卡背景上。
 *  每个子卡前面补 1 行分隔（上一条已经是空行时不再补），子卡自带的首尾空行会被裁掉，
 *  避免与外卡/内卡 padding 叠出双空行。
 *  hits：子卡的行区间与命中目标（thinking 命中自身，工具命中 tool 组件），
 *  供展开后点击 hint。未开启 toolHits 时不映射工具，点击仍归外层面板。
 *  live=true：live 槽位用，不铺底色也不留上下空行，首行紧跟 `↳`、其余行缩进对齐
 *  （Claude Code 的 ⎿ 口径）。行的产出仍是一行对一行，hits 行号无需平移。
 */
function layoutExpandedToolCard(
	theme: any,
	children: any[],
	width: number,
	paints?: string[][],
	toolHits = false,
	live = false,
): { lines: string[]; hits: Array<{ child: any; start: number; end: number }> } {
	const slot = config.expandedCardBackground;
	const toolBgAnsi = darkenBgAnsi(theme, slot);
	/** live 每行前面的标记宽度（首行 `↳ `，其余对齐空格）。 */
	const markerWidth = live ? 2 : 0;
	const innerWidth = Math.max(0, width - 2 - markerWidth);
	const lines: string[] = [];
	const hits: Array<{ child: any; start: number; end: number }> = [];
	const isThinkingPreview = (child: any) => typeof child?.setHintHovered === "function";
	let lastBlank = false;
	/** live 首行被吃掉的前导缩进：续行同步左移同样格数，保持块内相对对齐。 */
	let liveLead = 0;
	const pushRow = (raw: string) => {
		if (!live) {
			lines.push(paddedBackgroundRow(theme, slot, raw, width));
			return;
		}
		// 槽位里不重复展开入口（见 SLOT_HINT_PATTERNS）。
		const line = stripSlotHint(raw);
		// 工具卡行首带 SGR：ANSI 之后才是缩进空格。
		const head = line.match(/^((?:\x1b\[[0-9;]*m)*)( *)/);
		const ansi = head?.[1] ?? "";
		const spaces = head?.[2]?.length ?? 0;
		const first = lines.length === 0;
		if (first) liveLead = spaces;
		// 首行挂 muted 的 `↳`（与 default-mode 工具结果行同色）；续行按 liveLead 去缩进。
		// 两侧都保留行首 SGR：丢掉它整行会掉回终端默认前景色。
		const marker = first ? `${theme.fg("muted", "↳")} ` : "  ";
		const lead = first ? spaces : Math.min(spaces, liveLead);
		lines.push(
			`${marker}${ansi}${truncateToWidth(line.slice(ansi.length + lead), innerWidth, "")}`,
		);
	};
	const pushBlank = () => {
		if (live || lastBlank) return;
		lines.push(paddedBackgroundRow(theme, slot, "", width));
		lastBlank = true;
	};
	for (let childIndex = 0; childIndex < children.length; childIndex++) {
		const child = children[childIndex];
		const painted = paints?.[childIndex];
		const childLines = Array.isArray(painted) ? painted : child.render(innerWidth);
		// live 不留空行、也不叠深色内卡：槽位没有边框。
		const innerCard = !live && isThinkingPreview(child) && child.expanded === true;
		let first = -1;
		let last = -1;
		for (let i = 0; i < childLines.length; i++) {
			if (hasVisibleText(childLines[i])) {
				if (first < 0) first = i;
				last = i;
			}
		}
		if (first < 0) {
			if (live) continue;
			for (const line of childLines) {
				lines.push(paddedBackgroundRow(theme, slot, line, width));
				lastBlank = !hasVisibleText(line);
			}
			continue;
		}
		if (!innerCard) pushBlank();
		const rangeStart = lines.length;
		// 展开的 thinking 走深色内卡（上下各 1 行 padding），工具卡直接铺在外卡上。
		const paintRow = innerCard
			? (line: string) => lines.push(toolCardBgRow(theme, slot, toolBgAnsi, line, width))
			: pushRow;
		if (innerCard) paintRow("");
		for (let i = first; i <= last; i++) paintRow(childLines[i]);
		if (innerCard) paintRow("");
		// 内卡的下 padding 不能当分隔：后面的子卡要再留 1 行外卡空行。
		lastBlank = false;
		// thinking 命中自身；工具在展开卡内需要能二次展开时才映射回 tool 组件。
		if (isThinkingPreview(child)) hits.push({ child, start: rangeStart, end: lines.length });
		else if (toolHits && child.__ccTool) {
			hits.push({ child: child.__ccTool, start: rangeStart, end: lines.length });
		}
	}
	pushBlank();
	return { lines, hits };
}

function compactRoundCard(
	cardItems: Array<{ child?: any; tool?: any }>,
	toolRender: (tool: any, width: number) => string[],
	/** true 时卡内工具行归 tool 组件，可点击二次展开（整回合展开卡）。 */
	toolHits = false,
	/** true 时走 live 槽位排布：不留空行、首行紧跟 `↳`。 */
	live = false,
): any {
	const children: any[] = [];
	for (const item of cardItems) {
		if (item.child) children.push(item.child);
		else if (item.tool) {
			const tool = item.tool;
			children.push({
				__ccToolCard: true,
				__ccTool: tool,
				render: (innerWidth: number) => toolRender(tool, innerWidth),
				invalidate: () => tool.invalidate?.(),
			});
		}
	}
	/** 子块可用宽度：live 还要让出首行 `↳ ` 的标记位。 */
	const contentWidth = (width: number) => Math.max(0, width - 2 - (live ? 2 : 0));
	let paint:
		| {
				width: number;
				theme: unknown;
				/** 背景槽位也是面板行的输入：改配置后不能复用旧底色的整卡。 */
				bgSlot: string;
				paints: unknown[];
				lines: string[];
				hits: Array<{ child: any; start: number; end: number }>;
		  }
		| undefined;
	const layout = (width: number) => {
		const theme = themeOf();
		const bgSlot = config.expandedCardBackground;
		const innerWidth = contentWidth(width);
		const paints = children.map((child) => {
			const lines = child.render?.(innerWidth);
			return Array.isArray(lines) ? lines : [];
		});
		if (
			paint &&
			paint.width === width &&
			paint.theme === theme &&
			paint.bgSlot === bgSlot &&
			paint.paints.length === paints.length &&
			paint.paints.every((item, index) => item === paints[index])
		) {
			return paint;
		}
		const laid = layoutExpandedToolCard(theme, children, width, paints, toolHits, live);
		paint = {
			width,
			theme,
			bgSlot,
			paints,
			lines: laid.lines,
			hits: laid.hits,
		};
		return paint;
	};
	return {
		children,
		render(width: number): string[] {
			return layout(width).lines;
		},
		childAtRow(localRow: number, width: number) {
			for (const hit of layout(width).hits) {
				if (localRow >= hit.start && localRow < hit.end) return hit.child;
			}
			return null;
		},
		invalidate() {
			paint = undefined;
			for (const child of children) child.invalidate?.();
		},
	};
}

function isAssistantComponent(value: any): boolean {
	return value instanceof AssistantMessageComponent;
}

function isToolComponent(value: any): boolean {
	return value instanceof ToolExecutionComponent;
}

/** 成员离开回合后不再算外层面板，避免点别的卡时被跳过收起。 */
function clearRoundAnchor(component: any): void {
	if (!component || Object.getOwnPropertyDescriptor(component, "roundAnchor")?.get) return;
	delete component.roundAnchor;
}

function detachAssistantExpansion(component: any): void {
	if (
		typeof component?.[ASSISTANT_SET_EXPANDED_KEY] !== "function" ||
		component.setExpanded !== component[ASSISTANT_SET_EXPANDED_KEY]
	) {
		return;
	}
	delete component.setExpanded;
	delete component[ASSISTANT_SET_EXPANDED_KEY];
	delete component[ASSISTANT_TOGGLE_ROUND_KEY];
	delete component[ASSISTANT_REENTRY_KEY];
	clearRoundAnchor(component);
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

/**
 * 活动回合摘要 getter：常驻状态行（pi working row）镜像用。
 * installCompactMode 注册、卸载时清空，直接读 activeRound，不持有回合闭包。
 */
let compactRunStatusGetter: (() => string | undefined) | undefined;

/** 活动回合的摘要文本（`Running... · 9s, bash×1`）；无活动回合返回 undefined。 */
export function getCompactRunStatusText(): string | undefined {
	return compactRunStatusGetter?.();
}

/**
 * 回合尾行记录：摘要行（live 时连槽位卡）挂成 transcript 容器里回合末尾的
 * 兄弟组件，而不是 anchor 内部。anchor 内部的可变内容一旦被工具/diff 顶出视口
 * 就再也写不进 scrollback（regular 主屏只能差分可视区），运行态 Running 会永久
 * 定格在挤出前最后一帧；尾行恒在可写底缘，收尾的 Ran for 才真实落进历史。
 * 模块级持有（与 trackedAssistantComponents 同理）：跨 /reload 去重与清理。
 */
type MountedRoundTail = {
	host: any;
	container: any;
	parts: any[];
	round: any;
};
const tailByAnchor = new WeakMap<object, MountedRoundTail>();
const mountedTails = new Set<MountedRoundTail>();

export function setHoveredCompactAssistant(component: any): boolean {
	if (hoveredAssistantComponent === component) return false;
	hoveredAssistantComponent = component;
	return true;
}

/**
 * 整回合展开卡内的工具被点击展开时调用：让 compact 的强制折叠放行这一个，
 * 并把同一回合里其他展开的工具收回去（保持单开）。非 round 内工具是空操作。
 */
let roundToolExpansion: { markUserExpanded(tool: any): void } | undefined;

export function markCompactRoundToolExpanded(tool: any): void {
	roundToolExpansion?.markUserExpanded(tool);
}

/** 面板展开前的视口位置：收起时还原，避免面板撑高后收起导致视口错位。 */
const panelViewportBeforeExpand = new WeakMap<
	object,
	{ scrollTop: number; followingEnd: boolean }
>();

function capturePanelViewport(card: any): void {
	if (!card || panelViewportBeforeExpand.has(card)) return;
	const view = getToolMouseTui()?.getPrimaryScrollView?.();
	if (!view || typeof view.scrollTop !== "number" || typeof view.scrollTo !== "function") return;
	panelViewportBeforeExpand.set(card, {
		scrollTop: view.scrollTop,
		followingEnd: view.isFollowingEnd !== false,
	});
}

function restorePanelViewport(card: any): void {
	const snapshot = panelViewportBeforeExpand.get(card);
	if (!snapshot) return;
	panelViewportBeforeExpand.delete(card);
	const view = getToolMouseTui()?.getPrimaryScrollView?.();
	if (!view) return;
	// 展开前就在底部：交回官方 follow；否则回到展开前的滚动偏移。
	if (snapshot.followingEnd && typeof view.scrollToEnd === "function") view.scrollToEnd();
	else if (typeof view.scrollTo === "function") view.scrollTo(snapshot.scrollTop);
}

function compactEditWriteLine(
	component: any,
	width: number,
	writeMetadata?: WriteExecutionMetadataStore,
	options: { hint?: boolean; flushLeft?: boolean } = {},
): string[] {
	const theme = themeOf();
	const name = String(component.toolName ?? "tool");
	const args = component.args ?? {};
	const path =
		typeof args.path === "string" && args.path
			? args.path
			: typeof args.file_path === "string" && args.file_path
				? args.file_path
				: "";
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
	// 展开卡 Box(1,1) 已 pad；折叠行自己留 1 格前导空格
	const iconPart = `${options.flushLeft ? "" : " "}${theme.fg(iconColor, icon)} `;
	const namePart = theme.fg("toolTitle", name);
	const hintText =
		options.hint !== false && component.expanded !== true ? ` · ${showMoreHintText()}` : "";
	const fixedWidth =
		visibleWidth(iconPart) +
		visibleWidth(namePart) +
		visibleWidth(statsText) +
		visibleWidth(hintText);
	const pathWidth = Math.max(0, width - fixedWidth - (path ? 1 : 0));
	const pathPart =
		pathWidth > 0 && path ? ` ${formatDisplayPath(path, component.cwd, pathWidth)}` : "";
	const line = `${iconPart}${namePart}${theme.fg("toolTitle", pathPart)}${statsStyled}${hintText ? theme.fg("dim", hintText) : ""}`;
	return ["", truncateToWidth(line, width, "")];
}

/** expanded 写进 rich diff 闭包，折叠/展开分槽缓存，避免每帧 parseDiff。 */
const compactRichDiffCache = new WeakMap<
	object,
	{ result: unknown; collapsed?: unknown; expanded?: unknown }
>();

type CompactEditPaintHit = {
	width: number;
	theme: unknown;
	/** 展开卡的背景槽位同样参与命中判断。 */
	bgSlot: string;
	expanded: boolean;
	result: unknown;
	isPartial: boolean;
	args: unknown;
	hover: boolean;
	ioHover: unknown;
	lines: string[];
};
const compactEditPaintCache = new WeakMap<object, CompactEditPaintHit>();

function compactEditIoHover(component: any): unknown {
	const view = component?.resultRendererComponent;
	return typeof view?.getHoveredSection === "function" ? view.getHoveredSection() : null;
}

/**
 * compact edit/write：标题行 + mode=on 同一套 rich diff。
 * 折叠/展开都走 `renderRichToolResult`，limits 不另开一套。
 * 已完成的结果跨帧复用行；pending 不缓存，避免 loader 动画冻住。
 */
function compactEditWriteLines(
	component: any,
	width: number,
	writeMetadata?: WriteExecutionMetadataStore,
): string[] {
	const expanded = component.expanded === true;
	const isPartial = component.isPartial === true;
	const pending = !component.result || isPartial;
	const hover = isToolCallHovered(component.toolCallId);
	const ioHover = compactEditIoHover(component);
	const theme = themeOf();
	if (!pending) {
		const hit = compactEditPaintCache.get(component);
		if (
			hit &&
			hit.width === width &&
			hit.theme === theme &&
			hit.bgSlot === config.expandedCardBackground &&
			hit.expanded === expanded &&
			hit.result === component.result &&
			hit.isPartial === isPartial &&
			hit.args === component.args &&
			hit.hover === hover &&
			hit.ioHover === ioHover
		) {
			return hit.lines;
		}
	}
	const lines = paintCompactEditWrite(component, width, writeMetadata);
	if (!pending) {
		compactEditPaintCache.set(component, {
			width,
			theme,
			bgSlot: config.expandedCardBackground,
			expanded,
			result: component.result,
			isPartial,
			args: component.args,
			hover,
			ioHover: compactEditIoHover(component),
			lines,
		});
	}
	return lines;
}

function paintCompactEditWrite(
	component: any,
	width: number,
	writeMetadata?: WriteExecutionMetadataStore,
): string[] {
	const theme = themeOf();
	const result = component.result;
	const expanded = component.expanded === true;
	const isError = result?.isError === true;
	const isPending = !result || component.isPartial === true;
	let candidate: unknown;
	if (!isPending && writeMetadata) {
		let entry = compactRichDiffCache.get(component);
		if (!entry || entry.result !== result) {
			entry = { result };
			compactRichDiffCache.set(component, entry);
		}
		const slot = expanded ? "expanded" : "collapsed";
		candidate = entry[slot];
		if (!isRichDiffComponent(candidate)) {
			candidate = renderRichToolResult(
				String(component.toolName ?? ""),
				result,
				{
					expanded,
					isPartial: component.isPartial === true,
					isError,
					isHovered: () => isToolCallHovered(component.toolCallId),
				},
				theme,
				component,
				writeMetadata,
				getToolDisplayConfig,
			);
			if (isRichDiffComponent(candidate)) entry[slot] = candidate;
		}
	}
	const hasRich = isRichDiffComponent(candidate);
	if (hasRich) {
		component.resultRendererComponent = candidate;
	}

	const title = compactEditWriteLine(component, width, writeMetadata, { hint: !hasRich });
	if (!hasRich && !expanded) {
		return title;
	}

	let detail: any;
	if (hasRich) {
		detail = expanded ? candidate : insetComponent(candidate as any);
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
			true, // 外层 Box(1,1) 已 pad
		);
		component.resultRendererComponent = detail;
	}

	if (!expanded) {
		return [...title, ...detail.render(width)];
	}

	const box = editWriteExpandedCard(theme);
	box.addChild({
		render(innerWidth: number): string[] {
			return compactEditWriteLine(component, innerWidth, writeMetadata, {
				hint: false,
				flushLeft: true,
			}).slice(1);
		},
		invalidate() {},
	});
	box.addChild(detail);
	// 与原生 ToolExecutionComponent 一样：Spacer(1) + Box，否则贴上一条 tool 少 1 行间距
	return ["", ...box.render(width)];
}

function compactAssistantLineComponent(
	component: any,
	/** 静态串或每次 render 重算（Running 时长需逐步跳动）。 */
	summary: string | (() => string),
	query?: CompactThinkingQuery,
	options: { hint?: boolean; leadingBlank?: boolean; pad?: number } = {},
): any {
	const self = component as any;
	let paint:
		| {
				width: number;
				theme: unknown;
				resolved: string;
				hover: boolean;
				hint: boolean;
				pad: number;
				frame: number;
				leadingBlank: boolean;
				lines: string[];
		  }
		| undefined;
	return {
		render(width: number): string[] {
			const theme = themeOf();
			const pad = Math.max(0, options.pad ?? (Number(self.outputPad) || 0));
			const available = Math.max(0, width - pad);
			const hint = options.hint !== false;
			const hintText = hint ? ` · ${showMoreHintText()}` : "";
			const summaryWidth = Math.max(0, available - visibleWidth(hintText));
			const resolved = typeof summary === "function" ? summary() : summary;
			const runningActive = resolved.startsWith("Running...");
			const hover = hoveredAssistantComponent === component;
			const frame = runningActive ? (query?.getThinkingAnimationFrame?.() ?? 0) : 0;
			const leadingBlank = options.leadingBlank !== false;
			if (
				paint &&
				paint.width === width &&
				paint.theme === theme &&
				paint.resolved === resolved &&
				paint.hover === hover &&
				paint.hint === hint &&
				paint.pad === pad &&
				paint.frame === frame &&
				paint.leadingBlank === leadingBlank
			) {
				return paint.lines;
			}
			const plainText = truncateToWidth(resolved, summaryWidth, "…");
			// Dim thinking text 开启时整行统一 dim，否则工具计数保持 muted。
			const plain = (value: string) => theme.fg(config.dimThinkingText ? "dim" : "muted", value);
			let text = plain(plainText);
			if (runningActive || plainText.startsWith("Ran for ")) {
				const separator = plainText.indexOf(", ");
				const heading = separator < 0 ? plainText : plainText.slice(0, separator);
				const tools = separator < 0 ? "" : plainText.slice(separator);
				if (runningActive) {
					const durationSeparator = heading.indexOf(" · ");
					const label = durationSeparator < 0 ? heading : heading.slice(0, durationSeparator);
					const duration = durationSeparator < 0 ? "" : heading.slice(durationSeparator);
					text = `${animateCompactThinkingText(label, theme, query?.getThinkingAnimationFrame?.() ?? 0)}${styleCompactThinkingText(duration, theme)}${plain(tools)}`;
				} else {
					text = `${styleCompactThinkingText(heading, theme)}${plain(tools)}`;
				}
			}
			// 圆点保持 dim；hover 只高亮可点击文字。
			const hintPart = hint
				? `${theme.fg("dim", " · ")}${theme.fg(hover ? "text" : "dim", showMoreHintText())}`
				: "";
			const line = `${text}${hintPart}`;
			const rendered = `${" ".repeat(pad)}${truncateToWidth(line, available, "")}`;
			const lines = leadingBlank ? ["", rendered] : [rendered];
			paint = {
				width,
				theme,
				resolved,
				hover,
				hint,
				pad,
				frame,
				leadingBlank,
				lines,
			};
			return lines;
		},
		invalidate() {
			paint = undefined;
		},
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

/**
 * 槽位卡内的展开入口：卡里是只读围观，展开走摘要行自己的 hint，卡内不再重复提示。
 * 提示有两处来源——我们的 showMoreHintText（`… +N more lines · click to show more`）与
 * pi 原生工具卡（`… (N earlier lines, ctrl+o to expand)`），所以按渲染结果收尾裁剪。
 * 只去掉动作词，`(N more lines)` 这类计数保留。
 */
/** 展开入口的动作词：我们的 `click to show more`、pi 的 `<key> to expand`（键名可能取不到）。 */
const EXPAND_ACTION = String.raw`(?:click to show more|(?:[\w/+]+\s+)?to (?:show more|expand))`;

const SLOT_HINT_PATTERNS: RegExp[] = [
	// 卡在括号里：`(9 more lines, click to show more)` / `(195 earlier lines, ctrl+o to expand)`，
	// 只去掉动作词，收尾括号与计数保留。
	new RegExp(String.raw`,\s*[^()]*?${EXPAND_ACTION}(?=\))`),
	// 直接挂在行尾：整段去掉。
	// 尾部分隔点：ccstyle 统一 `·`，同时兼容旧帧与 pi 原生的 `•`
	new RegExp(String.raw`\s*(?:[•·]\s*)?${EXPAND_ACTION}\s*$`),
];

function stripSlotHint(line: string): string {
	const plain = stripTerminalSequencesPreservingLayout(line);
	for (const re of SLOT_HINT_PATTERNS) {
		const match = re.exec(plain);
		if (!match) continue;
		// 删除区间而非截断后拼纯文本：收尾括号留在原样式里（dim），不会掉回默认前景色。
		return removeStyledRange(line, match.index, match.index + match[0].length);
	}
	return line;
}

/** live 槽位卡：按 pad 缩进；首行 `↳` 由卡自身的 live 排布加，行不增不减。 */
function compactLiveSlot(card: any, pad = 0): any {
	const innerOf = (width: number) => Math.max(0, width - Math.max(0, pad));
	return {
		render(width: number): string[] {
			const indent = " ".repeat(Math.max(0, pad));
			return card.render(innerOf(width)).map((line: string) => `${indent}${line}`);
		},
		childAtRow(localRow: number, width: number) {
			return card.childAtRow?.(localRow, innerOf(width)) ?? null;
		},
		invalidate() {
			card.invalidate();
		},
	};
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
		/** live 槽位内联渲染的工具 id；回合结束时随槽位一起交还外层。 */
		liveSlotToolIds: Set<string>;
		/** 收尾后的静默期截止时间戳；期间仍按围观态渲染，到点才收拢。 */
		settleUntil?: number;
		foldTimer?: ReturnType<typeof setTimeout>;
		/** 回合挂钟起点，保证 Running 时长连续递增。 */
		startedAt: number;
		endedAt?: number;
		/** 回合尾行（摘要 + live 槽位），挂在 transcript 容器的回合末尾。 */
		tail?: MountedRoundTail;
	};
	let activeRound: CompactRound | undefined;
	let roundByComponent = new WeakMap<object, CompactRound>();
	const expandedRoundToolIds = new Set<string>();
	/** 用户显式点开的 round 内工具；强制折叠不压回这些 id。 */
	const explicitRoundToolIds = new Set<string>();
	const liveSlotToolIds = new Set<string>();
	const pendingFoldRounds = new Set<CompactRound>();
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
			settleStrandedRounds();
			try {
				// 非 force：保留 fullscreen 布局缓存和差分绘制。
				uiRef?.requestRender?.();
			} catch {
				/* 无 UI */
			}
		}, 250);
	};

	/** 围观中：活动回合，或收尾静默期还没走完的回合（槽位卡仍挂在屏幕上）。 */
	const roundLive = (round: CompactRound): boolean =>
		round.active || (round.settleUntil !== undefined && Date.now() < round.settleUntil);

	const clearFoldTimer = (round: CompactRound): void => {
		if (round.foldTimer !== undefined) {
			clearTimeout(round.foldTimer);
			round.foldTimer = undefined;
		}
		round.settleUntil = undefined;
		pendingFoldRounds.delete(round);
	};

	/** 结束回合活动态；不做任何重绘。 */
	const finalizeRound = (round: CompactRound): void => {
		clearFoldTimer(round);
		round.active = false;
		if (round.endedAt === undefined) round.endedAt = Date.now();
		if (activeRound === round) {
			activeRound = undefined;
			deps.query?.setCompactSummaryActive?.(false);
			stopRoundTick();
		}
	};

	/**
	 * 结束回合活动态；render=true 时走静默期，延迟 FOLD_SETTLE_MS 再收拢。
	 * 分组语义不受影响：activeRound 立即让位，新消息不会被并进已收尾的回合。
	 */
	const endRound = (round: CompactRound, render = false): void => {
		if (!render || !round.active) {
			finalizeRound(round);
			if (render) renderRound(round);
			return;
		}
		finalizeRound(round);
		if (round.foldTimer !== undefined) return;
		round.settleUntil = Date.now() + FOLD_SETTLE_MS;
		pendingFoldRounds.add(round);
		round.foldTimer = setTimeout(() => {
			round.foldTimer = undefined;
			round.settleUntil = undefined;
			pendingFoldRounds.delete(round);
			renderRound(round);
		}, FOLD_SETTLE_MS);
	};

	/** 新回合接替时立即收掉还在静默期的回合，把两次转场并成一次。 */
	const flushSettle = (): void => {
		for (const round of [...pendingFoldRounds]) {
			clearFoldTimer(round);
			renderRound(round);
		}
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

	/** compact 只允许单开：收回一张工具卡的展开态。 */
	const collapseTool = (tool: any): void => {
		if (typeof tool?.setExpanded === "function") tool.setExpanded(false);
		else {
			tool.expanded = false;
			tool.updateDisplay?.();
		}
	};

	/** 按条件收回已展开的工具卡。 */
	const collapseTools = (shouldCollapse: (tool: any) => boolean): void => {
		for (const tool of trackedToolComponents) {
			if (tool.expanded === true && shouldCollapse(tool)) collapseTool(tool);
		}
	};

	const markRoundToolUserExpanded = (tool: any): void => {
		const id = String(tool?.toolCallId ?? "");
		if (!id || !expandedRoundToolIds.has(id)) return;
		for (const other of trackedToolComponents) {
			const otherId = String(other?.toolCallId ?? "");
			if (other === tool || !expandedRoundToolIds.has(otherId) || other.expanded !== true) continue;
			explicitRoundToolIds.delete(otherId);
			collapseTool(other);
		}
		explicitRoundToolIds.add(id);
	};
	roundToolExpansion = { markUserExpanded: markRoundToolUserExpanded };

	const roundMessages = (round: CompactRound): any[] => [
		...round.messages.values(),
		...round.detachedMessages,
	];

	/** 镜像给常驻状态行的文案：只认当前活动回合（摘要行被顶出视口时由 working-message 取用）。 */
	compactRunStatusGetter = () => {
		const round = activeRound;
		return round?.active ? summarize(roundMessages(round), true, round) || undefined : undefined;
	};

	const roundToolCallIds = (round: CompactRound): Set<string> => {
		const ids = new Set<string>();
		for (const message of roundMessages(round)) {
			for (const item of Array.isArray(message?.content) ? message.content : []) {
				if (item?.type === "toolCall" && typeof item.id === "string") ids.add(item.id);
			}
		}
		return ids;
	};

	/**
	 * anchor 所在的 transcript 容器（pi chatContainer）。
	 * 优先走分组补丁在 addChild 时挂的父指针；没有则沿 tui 组件树找直属父容器。
	 */
	const tailContainerOf = (anchor: any): any => {
		const keyed = anchor?.[TOOL_GROUPING_PARENT_KEY];
		if (keyed && Array.isArray(keyed.children) && keyed.children.includes(anchor)) {
			return keyed;
		}
		let found: any;
		walkComponentTree(getToolMouseTui(), (value: any) => {
			if (found) return false;
			if (Array.isArray(value?.children) && value.children.includes(anchor)) {
				found = value;
				return false;
			}
			return undefined;
		});
		return found;
	};

	/** 组件在树里的直属父容器。TUI 切换/reparent 后缓存的 container 会过期。 */
	const containerOfHost = (host: any): any => {
		let found: any;
		walkComponentTree(getToolMouseTui(), (value: any) => {
			if (found) return false;
			if (Array.isArray(value?.children) && value.children.includes(host)) {
				found = value;
				return false;
			}
			return undefined;
		});
		return found;
	};

	/** 尾行实际所在容器；缓存的 container 过期时按树找回来。 */
	const tailHostContainer = (tail: MountedRoundTail): any =>
		containerOfHost(tail.host) ??
		(tail.container?.children?.includes?.(tail.host) === true ? tail.container : undefined);

	/** 摘尾行：按实际所在容器摘，避免缓存过期时摘了个空、行留在树上。 */
	const removeTailHost = (tail: MountedRoundTail): void => {
		tailHostContainer(tail)?.removeChild?.(tail.host);
	};

	const ensureTailHost = (round: CompactRound): MountedRoundTail => {
		if (round.tail) return round.tail;
		// 同一 anchor 上残留的旧回合尾行（reset/重组后建新回合）先摘除，避免双摘要。
		const stale = tailByAnchor.get(round.anchor);
		if (stale) {
			removeTailHost(stale);
			mountedTails.delete(stale);
			tailByAnchor.delete(round.anchor);
		}
		const tail: MountedRoundTail = { host: undefined, container: undefined, parts: [], round };
		const host: any = {
			outputPad: Number(round.anchor?.outputPad) || 0,
			children: [],
			render: (width: number) => tail.parts.flatMap((part: any) => part?.render?.(width) ?? []),
			childAtRow(localRow: number, width: number) {
				let offset = 0;
				for (const part of tail.parts) {
					const lines = part?.render?.(width);
					const count = Array.isArray(lines) ? lines.length : 0;
					if (localRow < offset + count) {
						return part?.childAtRow?.(localRow - offset, width) ?? null;
					}
					offset += count;
				}
				return null;
			},
			invalidate: () => {
				for (const part of tail.parts) part?.invalidate?.();
			},
		};
		Object.defineProperty(host, "expanded", {
			configurable: true,
			get: () => tail.round?.anchor?.expanded === true,
			set: (value: boolean) => {
				const anchor = tail.round?.anchor;
				if (anchor) anchor.expanded = value;
			},
		});
		// 点击/悬停归属与 anchor 同一展开入口；toggle 每次 renderRound 重建，按值转发。
		// 经 tail.round 动态解引用：重建过户时 anchor 可能换成别的组件。
		ensureAssistantSetExpanded(host);
		Object.defineProperty(host, "roundAnchor", {
			configurable: true,
			get: () => tail.round?.anchor,
		});
		host[ASSISTANT_TOGGLE_ROUND_KEY] = (expanded: boolean) =>
			tail.round?.anchor?.[ASSISTANT_TOGGLE_ROUND_KEY]?.(expanded);
		tail.host = host;
		tailByAnchor.set(round.anchor, tail);
		mountedTails.add(tail);
		round.tail = tail;
		return tail;
	};

	/**
	 * 尾行归位。运行中（含收尾静默期）尾行恒为容器最末一行：计数行钉在
	 * transcript 底缘，运行中到达的提示行/custom 条目只能落在它上方，计数
	 * 不会被顶离底部截成两行。回合收尾后摘要行回落到回合最后一个成员之后，
	 * 外来行统一换到摘要行之下，通知行永远落在回合边界外。
	 */
	const syncTailPosition = (round: CompactRound): void => {
		const tail = round.tail;
		if (!tail?.host) return;
		const container =
			tail.container?.children?.includes?.(round.anchor) === true
				? tail.container
				: tailContainerOf(round.anchor);
		if (!container || !Array.isArray(container.children)) return;
		tail.container = container;
		const children = container.children as any[];
		const current = children.indexOf(tail.host);
		if (current >= 0) children.splice(current, 1);
		const ids = roundToolCallIds(round);
		const matchesTool = (value: any): boolean =>
			typeof value?.toolCallId === "string" && ids.has(value.toolCallId);
		const isMember = (value: any): boolean =>
			round.messages.has(value) ||
			matchesTool(value) ||
			(Array.isArray(value?.children) && value.children.some(matchesTool));
		let first = -1;
		let last = -1;
		for (let i = 0; i < children.length; i++) {
			if (!isMember(children[i])) continue;
			if (first < 0) first = i;
			last = i;
		}
		const lastMember = last >= 0 ? children[last] : undefined;
		const intruders: any[] = [];
		for (let i = last - 1; i > first; i--) {
			if (!isMember(children[i])) intruders.unshift(children.splice(i, 1)[0]);
		}
		if (lastMember) last = children.indexOf(lastMember);
		const insertAt = last < 0 ? children.length : last + 1;
		if (roundLive(round)) {
			// 活回合：外来行压到最后成员之后，尾行占容器最末。
			children.splice(insertAt, 0, ...intruders);
			children.push(tail.host);
		} else {
			children.splice(insertAt, 0, tail.host, ...intruders);
		}
		tail.host[TOOL_GROUPING_PARENT_KEY] = container;
	};

	const unmountRoundTail = (round: CompactRound): void => {
		const tail = round.tail;
		if (!tail) return;
		round.tail = undefined;
		removeTailHost(tail);
		mountedTails.delete(tail);
		if (tailByAnchor.get(round.anchor) === tail) tailByAnchor.delete(round.anchor);
	};

	/**
	 * pi 把新工具卡 append 在容器末尾（尾行之后）：updateDisplay 时把所属回合的
	 * 尾行压回末尾。只有 live/收尾静默期的回合还会长工具。
	 */
	const syncTailForTool = (toolCallId: string): void => {
		if (!toolCallId) return;
		for (const round of [activeRound, ...pendingFoldRounds]) {
			if (round?.tail && roundToolCallIds(round).has(toolCallId)) {
				syncTailPosition(round);
				return;
			}
		}
	};

	/**
	 * refresh 重建时继承旧回合：resetRounds 只清索引不摘 compact 尾行，
	 * 残留尾行带着旧 round。同一组件重放同一消息（lastMessage 回放）
	 * 才算重建——保留挂钟起点、已脱离的工具历史与尾行组件本身；
	 * 旧回合已收尾的直接落成折叠态（不回摆 Running、不重演静默期），
	 * 仍活动的只接回挂钟，Running 时长继续走。
	 */
	const adoptPriorRound = (round: CompactRound, message: any): void => {
		let prior: CompactRound | undefined;
		for (const tail of mountedTails) {
			const stale = tail.round as CompactRound | undefined;
			if (
				stale &&
				// 先认组件：重放时消息对象未必是同一个（会话重读/重建），
				// 只认消息身份会漏掉本该接回的回合，摘要行就此掉队。
				(stale.anchor === round.anchor ||
					stale.messages.has(round.anchor) ||
					stale.detachedMessages.includes(message))
			) {
				prior = stale;
				break;
			}
		}
		if (!prior) return;
		round.startedAt = prior.startedAt;
		if (prior.detachedMessages.length) round.detachedMessages.push(...prior.detachedMessages);
		if (!prior.active) {
			round.active = false;
			round.endedAt = prior.endedAt ?? round.startedAt;
		}
		const tail = prior.tail;
		if (tail) {
			prior.tail = undefined;
			if (tailByAnchor.get(prior.anchor) === tail) tailByAnchor.delete(prior.anchor);
			tail.round = round;
			tailByAnchor.set(round.anchor, tail);
			round.tail = tail;
		}
	};

	/** 新建活回合：literal + 激活 + refresh 重建时的旧回合收编。 */
	const createRound = (anchor: any, message: any): CompactRound => {
		const round: CompactRound = {
			anchor,
			messages: new Map(),
			detachedMessages: [],
			active: true,
			suppressedToolIds: new Set(),
			liveSlotToolIds: new Set(),
			startedAt: Date.now(),
		};
		activateRound(round);
		adoptPriorRound(round, message);
		return round;
	};

	/**
	 * 尾行挂载入口：makeParts 按渲染态产出内容（折叠态 [摘要行]，live 态
	 * [摘要行, 槽位卡]），identity 决定行内 hover/点击归属组件（尾行模式下是
	 * host，hit-test 直达它）。anchor 未挂进任何容器时（独立渲染）退回
	 * contentContainer——与旧行为一致。
	 */
	const mountRoundTail = (round: CompactRound, makeParts: (identity: any) => any[]): void => {
		if (!tailContainerOf(round.anchor)) {
			// anchor 不在任何容器里（独立渲染/未挂载）：退回 anchor 内部，与旧行为一致。
			unmountRoundTail(round);
			for (const part of makeParts(round.anchor)) {
				round.anchor?.contentContainer?.addChild?.(part);
			}
			return;
		}
		const tail = ensureTailHost(round);
		tail.parts = makeParts(tail.host);
		tail.host.children = tail.parts;
		syncTailPosition(round);
	};

	/**
	 * 末块仍是 thinking = 思考还在长；后面跟了正文或工具调用就算结束。
	 * 围观态只预览这一种，已完成的思考直接回收进摘要行，不在屏幕上留 Thought 行。
	 */
	const hasTrailingThinking = (message: any): boolean => {
		const content = Array.isArray(message?.content) ? message.content : [];
		for (let i = content.length - 1; i >= 0; i--) {
			const item = content[i];
			if (item?.type === "thinking") return true;
			if (item?.type === "toolCall") return false;
			if (item?.type === "text" && String(item.text ?? "").trim()) return false;
		}
		return false;
	};

	/** 运行中的工具：已开始且尚无最终结果。 */
	const isRunningTool = (tool: any): boolean =>
		tool?.executionStarted === true && (!tool.result || tool.isPartial === true);

	/**
	 * live 围观态：正文 + 摘要行照折叠态渲染，只在摘要行下多一张槽位卡。
	 * - 思考：只预览最后一条仍在思考的消息，它的块是当前最新内容；
	 * - 工具：没有活动思考时才占槽位，运行中优先，否则取本回合最近的，完成也留着；
	 * - 槽位只放一个块（思考或工具），新的思考块/工具调用进来才轮换；
	 * - 本回合所有工具都由槽位卡接管，外层不再单独成行。
	 * 可见性判断只在这里发生；回合结束（renderRound 非 active）只剩槽位卡消失。
	 */
	const renderRoundLive = (
		round: CompactRound,
		stopStatus: string | undefined,
		getSummary: () => string,
	): void => {
		// 仍在思考的消息 = 当前最新内容，优先占槽位。
		let previewComponent: any;
		for (const [component, message] of round.messages) {
			if (hasTrailingThinking(message)) previewComponent = component;
		}

		const thinkingKids: any[] = [];
		for (const [component, message] of round.messages) {
			if (component !== previewComponent) {
				component.contentContainer?.clear?.();
				continue;
			}
			passThroughAssistant(component, message);
			const kids = Array.isArray(component.contentContainer?.children)
				? [...component.contentContainer.children]
				: [];
			component.contentContainer?.clear?.();
			// 只摘思考预览块进槽位；已收尾的思考回收进摘要行。
			for (const kid of kids) {
				if (typeof kid?.setHintHovered === "function") thinkingKids.push(kid);
			}
		}
		// 正文照折叠态渲染（不含 thinking）：live 与收尾后同形，收尾只剩槽位卡消失。
		renderAssistantWithoutThinking(round.anchor, round.messages.get(round.anchor));

		const toolsById = new Map<string, any>();
		for (const tool of trackedToolComponents) {
			if (typeof tool?.toolCallId === "string") toolsById.set(tool.toolCallId, tool);
		}
		let runningTool: any;
		let lastTool: any;
		for (const [, message] of round.messages) {
			for (const item of Array.isArray(message?.content) ? message.content : []) {
				if (item?.type !== "toolCall" || typeof item.id !== "string") continue;
				const tool = toolsById.get(item.id);
				// edit/write 保留自己的 compact 行，不进槽位。
				if (EDIT_WRITE_TOOLS.has(String(tool?.toolName ?? item.name ?? ""))) continue;
				round.liveSlotToolIds.add(item.id);
				liveSlotToolIds.add(item.id);
				if (!tool) continue;
				lastTool = tool;
				if (isRunningTool(tool)) runningTool = tool;
			}
		}
		// 槽位单块：活动思考最新；否则本回合最近的工具（运行中原位增长，完成也留着）。
		const slotTool = thinkingKids.length > 0 ? undefined : (runningTool ?? lastTool);
		const cardItems: Array<{ child?: any; tool?: any }> = slotTool
			? [{ tool: slotTool }]
			: thinkingKids.map((child) => ({ child }));

		const anchor = round.anchor;
		const pad = Number(anchor.outputPad) || 0;
		// 摘要行与槽位卡挂回合尾行（transcript 容器内回合末尾，而非 anchor 内部）：
		// 运行中恒在可写视口底缘，收尾的 Ran for 原地落进 scrollback，不再留下
		// 被挤出视口后定格的 Running 帧。
		mountRoundTail(round, (identity) => {
			const parts: any[] = [compactAssistantLineComponent(identity, getSummary, deps.query)];
			if (cardItems.length > 0) {
				parts.push(
					compactLiveSlot(
						compactRoundCard(
							cardItems,
							(tool, innerWidth) => patch.toolOriginalRender.call(tool, innerWidth),
							false,
							true,
						),
						pad,
					),
				);
			}
			return parts;
		});
		appendStopStatus(anchor, stopStatus);
	};

	const renderRound = (round: CompactRound): void => {
		const messages = roundMessages(round);
		const stopStatus = roundStopStatus(messages);
		if (stopStatus) endRound(round);
		// Running 时每次 render 重算时长（含挂钟下限）；结束后固定。
		// 静默期内回合已收尾，摘要行直接给 Ran for，只有槽位卡多留一拍。
		const getSummary = () => summarize(roundMessages(round), round.active, round);
		const summary = getSummary();
		for (const id of round.suppressedToolIds) expandedRoundToolIds.delete(id);
		round.suppressedToolIds.clear();
		// 回合收起（或本回合不在展开态）时忘掉用户的单开选择，并把面板接管的工具一起收回：
		// 少了后一步，被点开的工具会带着自身的 expanded 落到 toolInstalledRender 的放行分支，
		// 面板一收就单独渲染成一张卡。
		if (round.anchor.expanded !== true) {
			const ids = roundToolCallIds(round);
			for (const id of ids) explicitRoundToolIds.delete(id);
			collapseTools(
				(tool) =>
					ids.has(String(tool.toolCallId ?? "")) &&
					!EDIT_WRITE_TOOLS.has(String(tool.toolName ?? "")),
			);
		}
		for (const id of round.liveSlotToolIds) liveSlotToolIds.delete(id);
		round.liveSlotToolIds.clear();

		for (const [component, message] of round.messages) {
			component.lastMessage = message;
			ensureAssistantSetExpanded(component);
			// 尾行用 getter 指向 anchor；成员用同名属性，点内部工具时能认出同一回合。
			if (!Object.getOwnPropertyDescriptor(component, "roundAnchor")?.get) {
				component.roundAnchor = round.anchor;
			}
			component[ASSISTANT_TOGGLE_ROUND_KEY] = (expanded: boolean) => {
				const wasExpanded = round.anchor.expanded === true;
				if (expanded && !wasExpanded) capturePanelViewport(round.anchor);
				for (const member of round.messages.keys()) member.expanded = expanded;
				if (!expanded) {
					for (const id of round.suppressedToolIds) expandedRoundToolIds.delete(id);
					round.suppressedToolIds.clear();
				}
				renderRound(round);
				if (!expanded && wasExpanded) restorePanelViewport(round.anchor);
			};
		}

		if (round.anchor.expanded === true) {
			// 展开内容留在摘要行那个位置：回合最后一个成员（含 write/edit）之后。
			// 放进 anchor 内部会跳到回合起点，盖到中间的 write/edit 上面。
			// anchor 未挂进 transcript 时没有这个位置，退回 anchor 内部。
			const mounted = Boolean(tailContainerOf(round.anchor));
			const toolsById = new Map<string, any>();
			for (const tool of trackedToolComponents) {
				if (typeof tool?.toolCallId === "string") toolsById.set(tool.toolCallId, tool);
			}
			// 助手文本按原生渲染、不进面板（面板只留 thinking 与工具卡）。
			// thinking/工具卡按连续段各包一张面板；先出文本再出面板，
			// 否则消息内容里的 thinking（[thinking, text, toolCall]）会盖到文本上面。
			const anchorChildren: any[] = [];
			let cardItems: Array<{ child?: any; tool?: any }> = [];
			const flushPanel = () => {
				if (cardItems.length === 0) return;
				if (cardItems.every((item) => !item.tool && isSpacerComponent(item.child))) {
					for (const item of cardItems) anchorChildren.push(item.child);
				} else {
					// 面板上沿留 1 行卡外空行：面板底色与 userMessage 同色，
					// 贴在一起会看成一个块；卡内顶部再加 1 行 padding 保持上下对称。
					anchorChildren.push(new Spacer(1));
					anchorChildren.push(
						compactRoundCard(
							cardItems,
							(tool, innerWidth) => patch.toolOriginalRender.call(tool, innerWidth),
							// 整回合展开卡：卡内工具行归 tool 组件，可单击二次展开。
							true,
						),
					);
				}
				cardItems = [];
			};
			const takeChild = (child: any, outside: boolean) => {
				if (!outside) {
					cardItems.push({ child });
					return;
				}
				flushPanel();
				anchorChildren.push(child);
			};
			const placedToolIds = new Set<string>();
			const placeTool = (id: string, fallbackName?: string) => {
				const tool = toolsById.get(id);
				if (!tool || EDIT_WRITE_TOOLS.has(String(tool.toolName ?? fallbackName ?? ""))) return;
				if (placedToolIds.has(id)) return;
				placedToolIds.add(id);
				cardItems.push({ tool });
			};
			type LocalEntry = { outside: boolean; child?: any; toolId?: string; toolName?: string };
			for (const [component, message] of round.messages) {
				passThroughAssistant(component, message);
				const kids = Array.isArray(component.contentContainer?.children)
					? [...component.contentContainer.children]
					: [];
				component.contentContainer?.clear?.();
				const cursor = { i: 0 };
				let inThinkingRun = false;
				// 本消息产出先收集再发射：文本（含其前导 Spacer）统一排在面板前面。
				const local: LocalEntry[] = [];
				const takeRun = (outside: boolean) => {
					while (cursor.i < kids.length && isSpacerComponent(kids[cursor.i])) {
						local.push({ outside, child: kids[cursor.i++] });
					}
					if (cursor.i < kids.length) local.push({ outside, child: kids[cursor.i++] });
				};
				for (const item of Array.isArray(message?.content) ? message.content : []) {
					if (item?.type === "thinking") {
						if (!String(item.thinking ?? "").trim()) continue;
						if (!inThinkingRun) {
							takeRun(false);
							inThinkingRun = true;
						}
						continue;
					}
					inThinkingRun = false;
					if (item?.type === "text" && String(item.text ?? "").trim()) {
						takeRun(true);
						continue;
					}
					if (item?.type === "toolCall" && typeof item.id === "string") {
						local.push({ outside: false, toolId: item.id, toolName: item.name });
					}
				}
				while (cursor.i < kids.length) local.push({ outside: false, child: kids[cursor.i++] });
				for (const entry of local) if (entry.outside) takeChild(entry.child, true);
				for (const entry of local) {
					if (entry.outside) continue;
					if (entry.toolId) placeTool(entry.toolId, entry.toolName);
					else takeChild(entry.child, false);
				}
			}
			for (const message of round.detachedMessages) {
				for (const item of Array.isArray(message?.content) ? message.content : []) {
					if (item?.type === "toolCall" && typeof item.id === "string") {
						placeTool(item.id, item.name);
					}
				}
			}
			const ids = roundToolCallIds(round);
			for (const id of ids) {
				round.suppressedToolIds.add(id);
				expandedRoundToolIds.add(id);
				if (!placedToolIds.has(id)) placeTool(id);
			}
			// Round 展开只打开外层卡片。普通工具保持折叠，避免长输出递归撑满屏幕；
			// 用户单独点开的（explicitRoundToolIds）不压回去。
			collapseTools(
				(tool) =>
					ids.has(String(tool.toolCallId ?? "")) &&
					!EDIT_WRITE_TOOLS.has(String(tool.toolName ?? "")) &&
					!explicitRoundToolIds.has(String(tool.toolCallId ?? "")),
			);
			flushPanel();
			if (mounted) {
				// 正文留在各自的 assistant 消息上，面板挂回摘要行原位。
				const outside: any[] = [];
				const panel: any[] = [];
				for (const child of anchorChildren) {
					(typeof child?.childAtRow === "function" ? panel : outside).push(child);
				}
				for (const child of outside) round.anchor.contentContainer.addChild(child);
				if (panel.length > 0) mountRoundTail(round, () => panel);
				else unmountRoundTail(round);
			} else {
				unmountRoundTail(round);
				for (const child of anchorChildren) round.anchor.contentContainer.addChild(child);
			}
			// 展开卡内工具会显示 error，外层仍挂 abort/length，避免只藏在折叠工具里。
			appendStopStatus(round.anchor, stopStatus);
			return;
		}

		if (roundLive(round)) {
			// 围观态：单一槽位卡（活动思考预览 + 当前工具），回合结束自动收回。
			renderRoundLive(round, stopStatus, getSummary);
			return;
		}

		for (const [component, message] of round.messages) {
			if (component === round.anchor) {
				renderAssistantWithoutThinking(component, message);
				// 空摘要不挂行（getter 在 Running 启动瞬间也可能短暂为空）
				if (summary || round.active) {
					mountRoundTail(round, (identity) => [
						compactAssistantLineComponent(identity, getSummary, deps.query),
					]);
				} else {
					unmountRoundTail(round);
				}
				// 折叠时工具行被隐藏：abort/error/length 必须挂在摘要外层。
				appendStopStatus(component, stopStatus);
			} else {
				component.contentContainer?.clear?.();
			}
		}
	};

	const activateRound = (round: CompactRound): void => {
		flushSettle();
		round.active = true;
		if (!round.startedAt) round.startedAt = Date.now();
		delete round.endedAt;
		activeRound = round;
		deps.query?.setCompactSummaryActive?.(true);
		ensureRoundTick();
	};

	const finishRound = (round: CompactRound): void => endRound(round, true);

	const resetRounds = (): void => {
		for (const round of [...pendingFoldRounds]) clearFoldTimer(round);
		activeRound = undefined;
		roundByComponent = new WeakMap();
		expandedRoundToolIds.clear();
		explicitRoundToolIds.clear();
		liveSlotToolIds.clear();
		// 尾行是 transcript 兄弟组件：compact 下保留为静态行（与原 anchor 内摘要
		// 一致；同 anchor 重建回合时 ensureTailHost 去重摘除），非 compact 摘掉，
		// 别把紧凑摘要带进 default 渲染。
		for (const tail of [...mountedTails]) {
			const container = tailHostContainer(tail);
			if (!container) {
				mountedTails.delete(tail);
				continue;
			}
			tail.container = container;
			if (config.mode === "compact") continue;
			container.removeChild(tail.host);
			mountedTails.delete(tail);
			if (tail.round?.tail === tail) tail.round.tail = undefined;
			if (tail.round?.anchor && tailByAnchor.get(tail.round.anchor) === tail) {
				tailByAnchor.delete(tail.round.anchor);
			}
		}
		deps.query?.setCompactSummaryActive?.(false);
		stopRoundTick();
	};

	/**
	 * 兜底：resetRounds 会丢掉回合索引但保留已挂的尾行，重放没能接回的回合会一直
	 * active——尾行永远显示 Running...（时长还在涨）却不再计入新工具。既不是活动
	 * 回合也不在收尾静默期的活回合就地收尾，不让它永远挂在屏幕上。
	 */
	const settleStrandedRounds = (): void => {
		for (const tail of [...mountedTails]) {
			const round = tail.round as CompactRound | undefined;
			if (!round?.active || round === activeRound || pendingFoldRounds.has(round)) continue;
			endRound(round, true);
		}
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
				if (round) {
					round.messages.delete(this);
					clearRoundAnchor(this);
				}
				if (activeRound) finishRound(activeRound);
				round = createRound(this, message);
				roundByComponent.set(this, round);
			} else if (!round) {
				round = activeRound ?? createRound(this, message);
				roundByComponent.set(this, round);
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
				clearRoundAnchor(this);
				round.detachedMessages.push(previousMessage);
				roundByComponent.delete(this);
				finishRound(round);
				return renderAssistantWithoutThinking(this, message);
			}
			if (round) {
				// 围观态下 anchor 还挂着槽位卡，必须重绘才能收回。
				endRound(round, true);
				roundByComponent.delete(this);
				clearRoundAnchor(this);
				return passThroughAssistant(this, message);
			}
			if (activeRound) finishRound(activeRound);
			return renderAssistantWithoutThinking(this, message);
		}

		const hasThinking = content.some((item: any) => item?.type === "thinking");
		if (hasThinking) {
			let round = roundByComponent.get(this);
			if (!round) {
				round = activeRound ?? createRound(this, message);
				roundByComponent.set(this, round);
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
			if (this.executionStarted && (!this.result || this.isPartial === true))
				scheduleAnimation(this);
			return compactEditWriteLines(this, width, deps.writeMetadata);
		}
		// Agent/Task 等同普通工具：折叠不外置（live 面板走独立 widget）。
		if (expandedRoundToolIds.has(String(this.toolCallId ?? ""))) return [];
		// live 围观态：本回合工具交由槽位卡内联渲染，外层不再单独成行，
		// 卡片因此不会随工具完成反复挂载/卸载。
		if (liveSlotToolIds.has(String(this.toolCallId ?? ""))) return [];
		// 普通工具折叠时不显示独立行（摘要行已统计），独立展开走原 renderer。
		if (this.expanded === true) {
			return patch.toolOriginalRender.call(this, width);
		}
		return [];
	};

	patch.toolInstalledUpdateDisplay = function (this: any) {
		const id = String(this.toolCallId ?? "");
		if (patch.active && config.mode === "compact" && expandedRoundToolIds.has(id)) {
			// 用户点开的保留展开；其余（含全局展开被收回的）继续强制折叠。
			if (this.expanded !== true) explicitRoundToolIds.delete(id);
			else if (!explicitRoundToolIds.has(id)) this.expanded = false;
		}
		const result = patch.toolOriginalUpdateDisplay.call(this);
		if (!patch.active) return result;
		trackedToolComponents.add(this);
		if (config.mode === "compact") syncTailForTool(id);
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
		if (roundToolExpansion?.markUserExpanded === markRoundToolUserExpanded) {
			roundToolExpansion = undefined;
		}
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
		compactRunStatusGetter = undefined;
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
