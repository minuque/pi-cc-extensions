import { Text, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { inspect } from "node:util";
import { config } from "../../config/config.ts";
import { createCodeBlockHighlighter } from "./diff/diff-highlight.ts";
import { showMoreHintText } from "./show-more-hint.ts";
import { TOOL_LOADING_INTERVAL_MS, toolLoadingIcon } from "../../utils/tool-loading-icon.ts";
import { getToolMouseTui } from "../mouse/scroll.ts";
import { sanitizeToolResultText } from "../../utils/tool-result-sanitize.ts";

const TOOL_VIEWPORT_WIDTH_RATIO = 0.8;
/** 宽屏右侧留白上限：比例留白超过这么多列时改用固定留白。 */
const TOOL_VIEWPORT_MAX_GUTTER = 24;

export function toolViewportWidth(width: number): number {
	return Math.max(
		1,
		Math.floor(width * TOOL_VIEWPORT_WIDTH_RATIO),
		Math.floor(width) - TOOL_VIEWPORT_MAX_GUTTER,
	);
}

/** 与默认工具结果相同的一级缩进包装。子组件只扣始终加上的 1 列；↳ 行多出的 2 列由 truncateToWidth 吃掉。 */
export function insetComponent(component: any): any {
	const wrapped: Record<string, unknown> = {
		render: (width: number) =>
			component.render(Math.max(1, width - 1)).map((line: string) => {
				const nestedMarker = line.replace(/^((?:\x1b\[[0-?]*[ -/]*[@-~])*)↳/, "$1  ↳");
				return truncateToWidth(` ${nestedMarker}`, Math.max(0, width), "");
			}),
		invalidate: () => component.invalidate?.(),
	};
	// 内层 diff 声明的 remainder 行：鼠标层只能看到这个包装组件。
	if (typeof component.isCollapsedHintLine === "function") {
		wrapped.isCollapsedHintLine = (line: string) => component.isCollapsedHintLine(line);
	}
	return wrapped;
}

function rawTextFromResult(result: any): string {
	return Array.isArray(result?.content)
		? result.content
				.filter((item: any) => item?.type === "text")
				.map((item: any) => String(item.text ?? ""))
				.join("\n")
		: "";
}

function detailsFromResult(result: any): string {
	if (result?.details === undefined) return "";
	const details =
		typeof result.details === "string"
			? result.details
			: inspect(result.details, { depth: 8, breakLength: 100, compact: false });
	return sanitizeToolResultText(details, 16_384);
}

export function textFromResult(result: any, expanded = false): string {
	// Compact previews only need short text; bound sanitize work.
	const content = sanitizeToolResultText(rawTextFromResult(result), 16_384);
	const details = detailsFromResult(result);
	if (!content) return details;
	if (!expanded || !details || details === content) return content;
	return `${content}\nDetails:\n${details}`;
}

export function outputLineCount(result: any): number {
	const text = rawTextFromResult(result).replace(/\r\n?/g, "\n").replace(/\n+$/, "");
	return text ? text.split("\n").length : 0;
}

export function countLines(text: string): number {
	return text
		.trim()
		.split("\n")
		.filter((line) => line.trim().length > 0).length;
}

function hasExpandableResult(text: string): boolean {
	return countLines(text) > 1;
}

const activeAnimationContexts = new Set<any>();
let sharedAnimationTimer: ReturnType<typeof setTimeout> | null = null;

function clearAnimation(context: any) {
	if (context?.state) context.state.ccstyleAnimationLight = false;
	if (!context?.state?.ccstyleAnimationScheduled) return;
	context.state.ccstyleAnimationScheduled = false;
	activeAnimationContexts.delete(context);
	if (activeAnimationContexts.size === 0 && sharedAnimationTimer) {
		clearTimeout(sharedAnimationTimer);
		sharedAnimationTimer = null;
	}
}

export function clearAllAnimations() {
	for (const ctx of activeAnimationContexts) {
		ctx.state.ccstyleAnimationScheduled = false;
		ctx.state.ccstyleAnimationLight = false;
	}
	activeAnimationContexts.clear();
	if (sharedAnimationTimer) {
		clearTimeout(sharedAnimationTimer);
		sharedAnimationTimer = null;
	}
}

export function scheduleAnimation(
	context: any,
	options: { light?: boolean; intervalMs?: number } = {},
) {
	const state = (context.state ??= {});
	// light：调用方自己在 render() 内重取 loading 帧，定时器只需请求重绘；
	// 否则定时器走 context.invalidate()（compact 摘要等靠它重建）。
	// 每次调用都按本次 options 写入，避免上次 light 残留后非 light 调用仍跳过 invalidate。
	state.ccstyleAnimationLight = Boolean(options.light);
	if (state.ccstyleAnimationScheduled) return;
	state.ccstyleAnimationScheduled = true;
	activeAnimationContexts.add(context);
	if (!sharedAnimationTimer) {
		sharedAnimationTimer = setTimeout(() => {
			sharedAnimationTimer = null;
			const contexts = Array.from(activeAnimationContexts);
			activeAnimationContexts.clear();
			const tui = getToolMouseTui();
			const canRequestRender = typeof tui?.requestRender === "function";
			let lightFrames = false;
			for (const ctx of contexts) {
				ctx.state.ccstyleAnimationScheduled = false;
				if (ctx.state.ccstyleAnimationLight && canRequestRender) lightFrames = true;
				else ctx.invalidate?.();
			}
			if (lightFrames) tui.requestRender();
		}, options.intervalMs ?? TOOL_LOADING_INTERVAL_MS);
	}
}

export function pendingIcon(_name: string): string {
	return toolLoadingIcon();
}

type ToolVisualState = "pending" | "success" | "error";

export function settledIcon(name: string, state: ToolVisualState | undefined): string {
	if (state === "success") return "✓";
	if (state === "error") return "✗";
	// toolIcon(name) 曾恒返回 "●"，已内联；name 保留以稳定导出签名。
	return "●";
}

export function setToolVisualState(context: any, visualState: ToolVisualState) {
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

export function resolveToolVisualState(context: any): ToolVisualState | undefined {
	const visualState = getToolVisualState(context);
	if (visualState || context?.isPartial !== false) return visualState;
	const settledState: ToolVisualState = context?.isError ? "error" : "success";
	setToolVisualState(context, settledState);
	return settledState;
}

export function toolIconColor(context: any): "accent" | "error" | "success" | "muted" {
	const visualState = getToolVisualState(context);
	if (context?.isError || visualState === "error") return "error";
	if (visualState === "success") return "success";
	if (context?.isPartial || context?.executionStarted || visualState === "pending") return "accent";
	return "muted";
}

export function isToolExpanded(options: any, context: any): boolean {
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
		const lines = wrapTextWithAnsi(this.normalizedText, contentWidth).map((line) =>
			truncateToWidth(this.prefix + line, width, ""),
		);
		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}
}

/** 截断体末行 `… +N more lines` 旁的展开提示，点击打开全量预览。 */
export const SHOW_MORE_LABEL = "· click to show more";

export type ToolIoSection = "input" | "output";

// Module-local token: /reload creates a fresh token, so stale view instances are
// replaced instead of retaining their old render implementation.
const EXPANDED_TOOL_IO_VIEW_GENERATION = Symbol("ccstyle-expanded-tool-io-view");

/**
 * Expanded tool body with clear Input / Output sections (Grok Build–style).
 *
 * Visual frame:
 *   ├ Input  click to show more
 *   │ path: src/a.ts
 *   │
 *   └ Output  click to show more
 *     result line…
 *
 * flushLeft=true（仅 mode=on 展开卡）：去掉树线前导空格，由外层 Box(1,1) 提供 1 格 padding。
 *
 * Reused across re-renders via context.lastComponent when possible.
 */
export class ExpandedToolIoView {
	readonly [EXPANDED_TOOL_IO_VIEW_GENERATION] = true;
	private inputBody: string;
	private outputBody: string;
	private isError: boolean;
	private theme: any;
	private maxOutputLines: number;
	private maxInputLines: number;
	private cachedWidth: number | undefined;
	private cachedLines: string[] | undefined;
	private hoveredSection: ToolIoSection | null = null;
	/** Which sections currently show the show-more affordance (after last render). */
	private truncated: { input: boolean; output: boolean } = { input: false, output: false };
	/** 0-based header line indexes that carry show-more after last render. */
	private showMoreHeaderRows: { input?: number; output?: number } = {};
	/** Input 里的代码块（codemode 的 `code`）：着色行覆盖默认 dim/muted 样式。 */
	private inputCode?:
		| {
				startLine: number;
				language: string;
				standalone: boolean;
				code: string;
				theme: unknown;
				rows: () => string[];
		  }
		| undefined;

	/** flushLeft：贴左渲染（mode=on 展开卡）；默认 false 保留前导空格（compact 等共用路径）。 */
	private flushLeft: boolean;

	constructor(
		theme: any,
		inputBody: string,
		outputBody: string,
		isError: boolean,
		maxOutputLines = config.expandedOutputMaxLines,
		maxInputLines = config.expandedInputMaxLines,
		flushLeft = false,
	) {
		this.theme = theme;
		this.inputBody = inputBody;
		this.outputBody = outputBody;
		this.isError = isError;
		this.maxOutputLines = Math.max(1, maxOutputLines);
		this.maxInputLines = Math.max(1, maxInputLines);
		this.flushLeft = flushLeft;
	}

	setContent(
		inputBody: string,
		outputBody: string,
		isError: boolean,
		maxOutputLines?: number,
		maxInputLines?: number,
		flushLeft?: boolean,
	): void {
		const nextOut =
			maxOutputLines !== undefined ? Math.max(1, maxOutputLines) : this.maxOutputLines;
		const nextIn = maxInputLines !== undefined ? Math.max(1, maxInputLines) : this.maxInputLines;
		const nextFlush = flushLeft !== undefined ? flushLeft : this.flushLeft;
		if (
			this.inputBody === inputBody &&
			this.outputBody === outputBody &&
			this.isError === isError &&
			this.maxOutputLines === nextOut &&
			this.maxInputLines === nextIn &&
			this.flushLeft === nextFlush
		) {
			return;
		}
		this.inputBody = inputBody;
		this.outputBody = outputBody;
		this.isError = isError;
		this.maxOutputLines = nextOut;
		this.maxInputLines = nextIn;
		this.flushLeft = nextFlush;
		this.invalidate();
	}

	getInputBody(): string {
		return this.inputBody;
	}

	/**
	 * 登记 Input 里的代码块：同步 cli-highlight 打底，shiki 异步升级，落地后
	 * 经 invalidate 重画。同一份代码与主题只建一次（视图按宽度缓存行）。
	 */
	setInputCode(block: InputCodeBlock | undefined): void {
		if (!block) {
			if (this.inputCode) {
				this.inputCode = undefined;
				this.invalidate();
			}
			return;
		}
		if (this.inputCode?.code === block.code && this.inputCode.theme === this.theme) {
			this.inputCode.startLine = block.startLine;
			this.inputCode.standalone = block.standalone;
			return;
		}
		this.inputCode = {
			startLine: block.startLine,
			language: block.language,
			standalone: block.standalone,
			code: block.code,
			theme: this.theme,
			rows: createCodeBlockHighlighter(block.code, block.language, this.theme, () => {
				// 视图自己的行缓存 + 外层工具卡（清 paint 缓存并 requestRender）
				this.invalidate();
				invalidateIoView(this);
			}),
		};
		this.invalidate();
	}

	/**
	 * 整段 Input 就是代码块时给出语言与代码，供全量预览包一层围栏（弹框按 Markdown
	 * 渲染，围栏代码块由 pi 的 highlightCode 着色）。混了别的字段时返回 undefined。
	 */
	getInputCodeFence(): { language: string; code: string } | undefined {
		const block = this.inputCode;
		return block?.standalone ? { language: block.language, code: block.code } : undefined;
	}

	/** 代码块里某一源行的着色内容（已剥掉行首缩进）；不在块内时为 undefined。 */
	private inputCodeLine(sourceIndex: number): string | undefined {
		const block = this.inputCode;
		if (!block) return undefined;
		const offset = sourceIndex - block.startLine;
		if (offset < 0) return undefined;
		const rows = block.rows();
		return offset < rows.length ? rows[offset] : undefined;
	}

	getOutputBody(): string {
		return this.outputBody.trim() ? this.outputBody : "Done";
	}

	setHoveredSection(section: ToolIoSection | null): void {
		if (this.hoveredSection === section) return;
		this.hoveredSection = section;
		this.invalidate();
	}

	getHoveredSection(): ToolIoSection | null {
		return this.hoveredSection;
	}

	/** True when the plain truncation footer carries show-more. Input 续行带 │，Output 不带。 */
	matchShowMoreLine(plainLine: string): ToolIoSection | null {
		const line = plainLine.replace(/\x1b\[[0-9;]*m/g, "");
		if (!line.includes(` · ${showMoreHintText()}`) || !/\+\d+ more lines/.test(line)) return null;
		if (this.truncated.input && line.includes("│")) return "input";
		if (this.truncated.output) return "output";
		return null;
	}

	/** Precise header rows marked for show-more hit testing (last render). */
	showMoreHeaderLineIndexes(): ReadonlyArray<{ section: ToolIoSection; line: number }> {
		const out: Array<{ section: ToolIoSection; line: number }> = [];
		if (this.showMoreHeaderRows.input !== undefined) {
			out.push({ section: "input", line: this.showMoreHeaderRows.input });
		}
		if (this.showMoreHeaderRows.output !== undefined) {
			out.push({ section: "output", line: this.showMoreHeaderRows.output });
		}
		return out;
	}

	/** Column range (1-based, visible cells) of show-more on a rendered header, if present. */
	showMoreHitbox(plainLine: string): { startCol: number; endCol: number } | null {
		const line = plainLine.replace(/\x1b\[[0-9;]*m/g, "");
		const label = ` · ${showMoreHintText()}`;
		const idx = line.lastIndexOf(label);
		if (idx < 0) return null;
		const before = line.slice(0, idx);
		const startCol = visibleWidth(before) + 1;
		const endCol = startCol + visibleWidth(label) - 1;
		return { startCol, endCol };
	}

	render(width: number): string[] {
		if (this.cachedLines !== undefined && this.cachedWidth === width) {
			return withIoViewMarkers(this, this.cachedLines);
		}

		const theme = this.theme;
		const safeWidth = Math.max(1, Math.floor(width));
		// flushLeft：贴左（外层 Box 负责 1 格 pad）；否则保留 1 格前导空格（compact 共用）
		const lead = this.flushLeft ? "" : " ";
		const rail = `${lead}│ `;
		const railWidth = visibleWidth(rail);
		const bodyWidth = toolViewportWidth(safeWidth);
		const contentWidth = Math.max(1, bodyWidth - railWidth);
		const bodyColor = this.isError ? "error" : "toolOutput";
		const lines: string[] = [];
		this.truncated = { input: false, output: false };
		this.showMoreHeaderRows = {};

		const pushHeader = (corner: "├" | "└", label: string) => {
			const mark = theme.fg("dim", `${lead}${corner} `);
			const title = theme.fg(
				"accent",
				typeof theme.bold === "function" ? theme.bold(label) : label,
			);
			lines.push(truncateToWidth(mark + title, safeWidth, ""));
		};

		const pushRailLine = (styledContent: string, continued = true) => {
			// 续行 rail；Output 正文相对 └ 缩进 2 格（+ 可选 lead）
			const prefix = continued ? rail : `${lead}  `;
			lines.push(truncateToWidth(theme.fg("dim", prefix) + styledContent, safeWidth, ""));
		};

		const pushBlankRail = () => {
			lines.push(truncateToWidth(theme.fg("dim", `${lead}│`), safeWidth, ""));
		};

		const pushBody = (
			body: string,
			opts: { input?: boolean; limit: number; continued?: boolean; section: ToolIoSection },
		): boolean /* truncated */ => {
			const raw = body.replace(/\t/g, "   ").replace(/\n+$/, "");
			if (!raw.trim()) {
				pushRailLine(theme.fg("dim", "(empty)"), opts.continued);
				return false;
			}
			const sourceLines = raw.split("\n");
			const wrapped: string[] = [];
			for (const [index, source] of sourceLines.entries()) {
				if (opts.input) {
					// 代码块的行用着色版本（已剥缩进），其余走默认 dim/muted
					wrapped.push(...wrapInputLine(source, contentWidth, theme, this.inputCodeLine(index)));
					continue;
				}
				const styled = theme.fg(bodyColor, source);
				const parts = wrapTextWithAnsi(styled, contentWidth);
				if (parts.length === 0) wrapped.push(styled);
				else wrapped.push(...parts);
			}
			// Prefer source-line count so plain multi-line dumps always cap, even when
			// theme/wrap measurements disagree slightly.
			const truncated = wrapped.length > opts.limit || sourceLines.length > opts.limit;
			const visible = truncated ? wrapped.slice(0, Math.min(opts.limit, wrapped.length)) : wrapped;
			for (const line of visible) pushRailLine(line, opts.continued);
			if (truncated) {
				const hidden = Math.max(0, wrapped.length - visible.length);
				if (hidden > 0) {
					// hover 只高亮文字，圆点保持 dim（与 group hint 一致）。
					const more =
						theme.fg("dim", " ·") +
						theme.fg(
							this.hoveredSection === opts.section ? "text" : "dim",
							` ${showMoreHintText()}`,
						);
					pushRailLine(theme.fg("dim", `… +${hidden} more lines`) + more, opts.continued);
					this.showMoreHeaderRows[opts.section] = lines.length - 1;
				}
			}
			return truncated;
		};

		const hasInput = this.inputBody.trim().length > 0;
		const outputText = this.getOutputBody();

		// Decide show-more from the same truncation rules as pushBody.
		const inputWouldTruncate =
			hasInput &&
			bodyExceedsLineLimit(
				this.inputBody,
				this.maxInputLines,
				contentWidth,
				true,
				theme,
				bodyColor,
				(inputIndex: number) => this.inputCodeLine(inputIndex),
			);
		const outputWouldTruncate = bodyExceedsLineLimit(
			outputText,
			this.maxOutputLines,
			contentWidth,
			false,
			theme,
			bodyColor,
		);

		if (hasInput) {
			this.truncated.input = inputWouldTruncate;
			pushHeader("├", "Input");
			pushBody(this.inputBody, {
				input: true,
				limit: this.maxInputLines,
				continued: true,
				section: "input",
			});
			pushBlankRail();
			this.truncated.output = outputWouldTruncate;
			pushHeader("└", "Output");
			pushBody(outputText, {
				limit: this.maxOutputLines,
				continued: false,
				section: "output",
			});
		} else {
			this.truncated.output = outputWouldTruncate;
			pushHeader("└", "Output");
			pushBody(outputText, {
				limit: this.maxOutputLines,
				continued: false,
				section: "output",
			});
		}

		this.cachedWidth = width;
		this.cachedLines = lines;
		return withIoViewMarkers(this, lines);
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}
}

export function isExpandedToolIoView(value: unknown): value is ExpandedToolIoView {
	return Boolean(
		value &&
			typeof value === "object" &&
			(value as ExpandedToolIoView)[EXPANDED_TOOL_IO_VIEW_GENERATION] === true &&
			typeof (value as ExpandedToolIoView).getInputBody === "function" &&
			typeof (value as ExpandedToolIoView).getOutputBody === "function" &&
			typeof (value as ExpandedToolIoView).setHoveredSection === "function" &&
			typeof (value as ExpandedToolIoView).render === "function",
	);
}

/** Input 行着色：`key: value` 拆成 dim 键 + muted 值，其余整行 muted。 */
function styleInputSourceLine(line: string, theme: any): string {
	const match = line.match(/^([A-Za-z_][\w.-]*)(:\s*)(.*)$/);
	if (!match) return theme.fg("muted", line);
	const [, key, sep, rest] = match;
	return theme.fg("dim", key + sep) + theme.fg("muted", rest ?? "");
}

/**
 * 折一行 Input 源码。不带 styledBody 时与改动前完全一致（其他工具不受影响）；
 * 代码块（styledBody = 已着色且已剥缩进的行）续行跟着源码前导缩进：顶到 rail
 * 会被读成新的一行，所以缩进先剥掉、折行宽度相应扣减，再给每一行加回去。
 * 行数判断（bodyExceedsLineLimit）与实际渲染共用这一套，展开提示才对得上。
 */
function wrapInputLine(
	source: string,
	contentWidth: number,
	theme: any,
	styledBody?: string,
): string[] {
	if (styledBody === undefined) {
		const styled = styleInputSourceLine(source, theme);
		const parts = wrapTextWithAnsi(styled, contentWidth);
		return parts.length ? parts : [styled];
	}
	const lead = /^[ \t]*/.exec(source)?.[0] ?? "";
	const leadWidth = visibleWidth(lead);
	const parts = wrapTextWithAnsi(styledBody, Math.max(1, contentWidth - leadWidth));
	const rows = parts.length ? parts : [styledBody];
	if (!leadWidth) return rows;
	const prefix = theme.fg("muted", lead);
	return rows.map((row) => prefix + row);
}

/** True when body needs truncation at the given line limit (source lines or wrapped rows). */
function bodyExceedsLineLimit(
	body: string,
	limit: number,
	contentWidth: number,
	asInput: boolean,
	theme: any,
	bodyColor = "toolOutput",
	/** 代码块的源行取着色内容，行数判断与实际渲染保持同一套规则。 */
	codeLine?: (sourceIndex: number) => string | undefined,
): boolean {
	const raw = body.replace(/\t/g, "   ").replace(/\n+$/, "");
	if (!raw.trim()) return false;
	const sourceLines = raw.split("\n");
	if (sourceLines.length > limit) return true;
	let total = 0;
	for (const [index, source] of sourceLines.entries()) {
		const parts = asInput
			? wrapInputLine(source, contentWidth, theme, codeLine?.(index))
			: wrapTextWithAnsi(theme.fg(bodyColor, source), contentWidth);
		total += Math.max(1, parts.length);
		if (total > limit) return true;
	}
	return false;
}

export function renderCollapsedToolResult(body: string, collapsedHint = ""): string {
	return `   ↳ ${body}${collapsedHint}`;
}

export function renderCollapsedToolResultToWidth(
	body: string,
	collapsedHint: string,
	width: number,
	prefix = "   ↳ ",
): string {
	const previewWidth = toolViewportWidth(width);
	const bodyWidth = Math.max(1, previewWidth - visibleWidth(prefix) - visibleWidth(collapsedHint));
	return truncateToWidth(
		prefix + middleTruncateToWidth(body, bodyWidth) + collapsedHint,
		previewWidth,
		"",
	);
}

/** 从头截断到宽度（保留开头、省略尾部），不插入 ANSI reset（背景卡片下安全）。 */
export function headTruncateToWidth(text: string, width: number): string {
	if (visibleWidth(text) <= width) return text;
	if (width <= 1) return "…";
	let left = "";
	for (const char of Array.from(text)) {
		if (visibleWidth(left + "…" + char) > width) break;
		left += char;
	}
	return `${left}…`;
}

/** 截断到宽度时保留首尾内容（渲染折叠行与工具标题用）。 */
export function middleTruncateToWidth(text: string, width: number): string {
	if (visibleWidth(text) <= width) return text;
	if (width <= 1) return "…";
	const chars = Array.from(text);
	const leftWidth = Math.ceil((width - 1) / 2);
	let left = "";
	let right = "";
	for (const char of chars) {
		if (visibleWidth(left + char) > leftWidth) break;
		left += char;
	}
	for (const char of chars.reverse()) {
		if (visibleWidth(left + "…" + char + right) > width) break;
		right = char + right;
	}
	return `${left}…${right}`;
}

/**
 * 展开卡 Input 的代码块：源行起始下标（相对 text）+ 语言 + 剥掉行首缩进的代码。
 * standalone = 整段 Input 就是这块代码（没有 `code:` 标签），全量预览可以整段包围栏。
 */
export type InputCodeBlock = {
	startLine: number;
	language: string;
	code: string;
	standalone: boolean;
};

export type ToolInputBody = { text: string; codeBlock?: InputCodeBlock };

/** 按字段名判定可着色的入参：codemode / mcpscript 的 `code` 都是 JS 脚本。 */
const INPUT_CODE_LANGUAGES: Record<string, string> = { code: "javascript" };

/** Pretty-print tool call args for the expanded Input section. */
export function formatToolInputBody(args: unknown, maxChars = 8_000): ToolInputBody {
	if (args === undefined || args === null) return { text: "" };
	if (typeof args !== "object") {
		const text = sanitizeToolResultText(String(args));
		return { text: text.length > maxChars ? `${text.slice(0, maxChars)}…` : text };
	}
	if (Array.isArray(args)) {
		try {
			const json = JSON.stringify(args, null, 2);
			return { text: json.length > maxChars ? `${json.slice(0, maxChars)}…` : json };
		} catch {
			return { text: sanitizeToolResultText(String(args)) };
		}
	}

	const entries = Object.entries(args as Record<string, unknown>).filter(
		([, value]) => value !== undefined,
	);
	if (entries.length === 0) return { text: "" };

	// Stable, human-first field order for common tools.
	const preferred = [
		"path",
		"file_path",
		"command",
		"query",
		"pattern",
		"url",
		"name",
		"message",
		"content",
		"old_string",
		"new_string",
	];
	entries.sort(([left], [right]) => {
		const li = preferred.indexOf(left);
		const ri = preferred.indexOf(right);
		if (li === -1 && ri === -1) return left.localeCompare(right);
		if (li === -1) return 1;
		if (ri === -1) return -1;
		return li - ri;
	});

	const lines: string[] = [];
	let codeBlock: InputCodeBlock | undefined;
	for (const [rawKey, value] of entries) {
		const key = sanitizeToolResultText(rawKey);
		if (typeof value === "string") {
			const safeValue = sanitizeToolResultText(value);
			if (safeValue.includes("\n")) {
				const expanded = safeValue.replace(/\t/g, "   ");
				const language = INPUT_CODE_LANGUAGES[key];
				// 只有一个 code 字段时（codemode 等）整块 Input 就是脚本，`code:` 标签是噪音
				const standaloneCode = Boolean(language) && entries.length === 1;
				if (!standaloneCode) lines.push(`${key}:`);
				if (language) {
					// 缩进由 wrapInputLine 负责，着色只喂剥掉行首缩进的正文
					codeBlock = {
						startLine: lines.length,
						language,
						code: expanded
							.split("\n")
							.map((line) => line.replace(/^[ \t]*/, ""))
							.join("\n"),
						standalone: standaloneCode,
					};
				}
				for (const line of expanded.split("\n")) {
					lines.push(`  ${line}`);
				}
			} else {
				lines.push(`${key}: ${safeValue}`);
			}
			continue;
		}
		if (typeof value === "number" || typeof value === "boolean" || value === null) {
			lines.push(`${key}: ${String(value)}`);
			continue;
		}
		try {
			const json = JSON.stringify(value, null, 2);
			if (json.includes("\n")) {
				lines.push(`${key}:`);
				for (const line of json.split("\n")) lines.push(`  ${line}`);
			} else {
				lines.push(`${key}: ${json}`);
			}
		} catch {
			lines.push(`${key}: [unserializable]`);
		}
	}
	const text = lines.join("\n");
	// 截断后的行号与着色行不再对齐，这时只给纯文本
	if (text.length > maxChars) return { text: `${text.slice(0, maxChars)}…` };
	return codeBlock ? { text, codeBlock } : { text };
}

export function formatToolInputArgs(args: unknown, maxChars = 8_000): string {
	return formatToolInputBody(args, maxChars).text;
}

export function hasExpandableDetail(outputText: string, args: unknown): boolean {
	if (hasExpandableResult(outputText)) return true;
	return formatToolInputArgs(args).trim().length > 0;
}

export function renderExpandedToolResult(
	body: string,
	theme: any,
	isError: boolean,
	lastComponent?: unknown,
	args?: unknown,
	context?: any,
	/** mode=on 展开卡贴左；compact 等保持默认前导空格 */
	flushLeft = false,
): ExpandedToolIoView | ExpandedToolResultText | Text {
	const { text: inputBody, codeBlock } = formatToolInputBody(args);
	const outputBody = body;
	const maxOutputLines = config.expandedOutputMaxLines;
	const maxInputLines = config.expandedInputMaxLines;

	// Prefer structured Input/Output when we have args or non-empty output.
	if (inputBody.trim() || outputBody.trim()) {
		let view: ExpandedToolIoView;
		if (isExpandedToolIoView(lastComponent)) {
			lastComponent.setContent(
				inputBody,
				outputBody,
				isError,
				maxOutputLines,
				maxInputLines,
				flushLeft,
			);
			view = lastComponent;
		} else {
			view = new ExpandedToolIoView(
				theme,
				inputBody,
				outputBody,
				isError,
				maxOutputLines,
				maxInputLines,
				flushLeft,
			);
		}
		view.setInputCode(codeBlock);
		if (context) rememberIoView(context, view);
		return view;
	}

	if (context?.state) context.state.ccstyleIoView = undefined;
	const color = isError ? "error" : "muted";
	return new Text(theme.fg(color, renderCollapsedToolResult("Done")), 0, 0);
}

const toolViewMarker = (id: number, section: ToolIoSection) =>
	`_cc:v${id}:${section === "input" ? "i" : "o"}`;

/** Per-frame ExpandedToolIoView ids for unambiguous show-more hit testing. */
export type IoViewFrameState = {
	viewIds: Map<ExpandedToolIoView, number>;
	idToView: Map<number, ExpandedToolIoView>;
	nextId: number;
};
let activeIoViewFrame: IoViewFrameState | null = null;

function frameViewId(view: ExpandedToolIoView): number | null {
	if (!activeIoViewFrame) return null;
	let id = activeIoViewFrame.viewIds.get(view);
	if (id === undefined) {
		id = activeIoViewFrame.nextId++;
		activeIoViewFrame.viewIds.set(view, id);
		activeIoViewFrame.idToView.set(id, view);
	}
	return id;
}

/** cachedLines stay clean; only the returned paint copy carries show-more view markers. */
function withIoViewMarkers(view: ExpandedToolIoView, lines: string[]): string[] {
	const id = frameViewId(view);
	if (id === null) return lines;
	// Mark by exact header row from render — never scan body text for Input/Output labels.
	const marked = lines.slice();
	for (const { section, line } of view.showMoreHeaderLineIndexes()) {
		if (line < 0 || line >= marked.length) continue;
		marked[line] = `${marked[line]}${toolViewMarker(id, section)}`;
	}
	return marked;
}
const ioViewInvalidators = new WeakMap<ExpandedToolIoView, () => void>();
function rememberIoView(context: any, view: ExpandedToolIoView): void {
	if (!context || typeof context !== "object") return;
	if (typeof context.invalidate === "function") {
		ioViewInvalidators.set(view, () => context.invalidate());
	}
	if (!context.state || typeof context.state !== "object") context.state = {};
	context.state.ccstyleIoView = view;
}

/** hover 状态变更后刷新上一个/下一个视图（context.invalidate 缓存于 ioViewInvalidators）。 */
export function invalidateIoView(view: ExpandedToolIoView): void {
	ioViewInvalidators.get(view)?.();
}

/** 鼠标帧渲染期间读写当前 IoView 帧 id 表（mouse-interaction 的 doRender 包装使用）。 */
export function getActiveIoViewFrame(): IoViewFrameState | null {
	return activeIoViewFrame;
}

export function setActiveIoViewFrame(frame: IoViewFrameState | null): void {
	activeIoViewFrame = frame;
}
