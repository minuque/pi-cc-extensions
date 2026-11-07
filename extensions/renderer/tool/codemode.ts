/**
 * codemode 的结果渲染：折叠态把子调用摊成工具组那样的树，最后一行用 └ 收尾。
 *
 * 数据来自 `result.details.calls`（CodemodeNestedCall[]，partial 更新里也有），所以运行中就能
 * 看到子调用进度。两个坑：
 *
 * - 子调用不会单独成行：pi 会跳过带 `parentToolCallId` 的 tool_execution_start，进度只能在这里显示。
 * - 输出以 "Script completed\nWall time …\nOutput:\n" 开头（pi 原生也切掉），行数统计与展开正文都得去掉它，
 *   否则折叠摘要会多算 3 行。
 */
import { highlightCode } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { config } from "../../config/config.ts";
import { expandedLineLimit } from "../transcript-scope.ts";
import { stripAnsi } from "../../utils/ansi-text.ts";
import { oneLine } from "../../utils/format.ts";
import { toolLoadingIcon } from "../../utils/tool-loading-icon.ts";
import { sanitizeToolResultText } from "../../utils/tool-result-sanitize.ts";
import { mcpToolTitle } from "./mcp-title.ts";
import {
	type ToolCallSummary,
	humanizeToolLabel,
	renderToolSummary,
	toolCallSummary,
} from "./names.ts";
import { showMoreHintText } from "./names.ts";
import { formatToolDuration, headTruncateToWidth, toolViewportWidth } from "./result.ts";

export const CODEMODE_TOOL_NAME = "codemode";

/** 折叠态最多列几条子调用（与 pi 原生一致，更早的折叠成一行）。 */
const COLLAPSED_CALL_LIMIT = 8;
/** 折叠态正文缩进：1 格，让 ├/└ 落在标题行勾号（" ✓"）的正下方。 */
const INDENT = " ";

/** 脚本结果头；只有整块正文恰好等于它时才算头。 */
const SCRIPT_HEADER = /^Script (completed|failed)\nWall time [\d.]+ seconds\nOutput:\n$/;

export type CodemodeNestedCall = {
	name?: unknown;
	/** 紧凑 JSON；过长时 pi 会截断，截断后 JSON.parse 会失败。 */
	args?: unknown;
	status?: unknown;
	durationMs?: unknown;
	error?: unknown;
	cost?: unknown;
};

export function codemodeCalls(result: any): CodemodeNestedCall[] {
	const calls = result?.details?.calls;
	return Array.isArray(calls) ? calls : [];
}

/** 去掉脚本头之后的输出正文（已清理终端转义）。 */
export function codemodeOutputText(result: any): string {
	const content = Array.isArray(result?.content) ? result.content : [];
	const blocks = content
		.filter((item: any) => item?.type === "text")
		.map((item: any) => String(item?.text ?? ""));
	if (blocks.length > 0 && SCRIPT_HEADER.test(blocks[0]!)) blocks.shift();
	return sanitizeToolResultText(blocks.join("\n"), 16_384).trim();
}

export function codemodeOutputLineCount(result: any): number {
	const text = codemodeOutputText(result).replace(/\n+$/, "");
	return text ? text.split("\n").length : 0;
}

/** 汇总行片段（按重要度先后排列，渲染时从尾部丢以适配宽度）。 */
export function codemodeSummaryParts(
	calls: readonly CodemodeNestedCall[],
	outputLines: number,
	running: boolean,
): string[] {
	const total = calls.length;
	const failed = calls.filter((call) => call?.status === "error").length;
	const runningCount = calls.filter((call) => !call?.status || call?.status === "running").length;
	const parts: string[] = [];
	if (running) {
		if (runningCount)
			parts.push(`${runningCount} ${runningCount === 1 ? "call" : "calls"} running`);
		const done = total - runningCount;
		if (done) parts.push(`${done} done`);
		if (failed) parts.push(`${failed} failed`);
		return parts.length ? parts : ["running…"];
	}
	if (total) parts.push(`${total} ${total === 1 ? "call" : "calls"}`);
	if (failed) parts.push(`${failed} failed`);
	if (outputLines) parts.push(`${outputLines} ${outputLines === 1 ? "line" : "lines"} output`);
	return parts.length ? parts : ["Done"];
}

/** 宽度不够时从尾部丢片段（先丢输出行数，再丢条数），不断词。 */
function fitSummaryParts(parts: readonly string[], width: number): string {
	const kept = [...parts];
	while (kept.length > 1 && visibleWidth(kept.join(" · ")) > width) kept.pop();
	const text = kept.join(" · ");
	return visibleWidth(text) <= width ? text : headTruncateToWidth(text, width);
}

/**
 * 摘要行的打分：调用最能说明脚本在干什么，字符串次之，行长只在前两者相同时决胜。
 * 调用权重必须大于「字符串分 + 行长上限」，否则长赋值会压过短调用。
 */
const CODE_SUMMARY_CALL_SCORE = 4;
const CODE_SUMMARY_STRING_SCORE = 2;

/**
 * 无子调用时的脚本摘要：取信息量最大的一行语句，压成单行。
 *
 * 要的是一段真实的 JavaScript 片段，折叠行才能用 highlightCode 着色；
 * 标识符链（`a → b → c`）着色器认不出，染不上。跳过注释、空行和 `// @options`。
 * 只是折叠行的提示，不求还原语义；看代码还是展开 Input。
 */
export function codemodeCodeSummary(code: unknown): string | undefined {
	if (typeof code !== "string" || !code.trim()) return undefined;
	let best: { text: string; score: number } | undefined;
	let skippingBlock = false;
	for (const raw of code.split("\n")) {
		const line = raw.trim();
		if (skippingBlock) {
			if (line.includes("*/")) skippingBlock = false;
			continue;
		}
		if (line.startsWith("/*")) {
			if (!line.includes("*/")) skippingBlock = true;
			continue;
		}
		if (!line || line.startsWith("//") || line.startsWith("*")) continue;
		const text = oneLine(line);
		if (!text) continue;
		const score =
			(text.includes("(") ? CODE_SUMMARY_CALL_SCORE : 0) +
			(/["'`]/.test(text) ? CODE_SUMMARY_STRING_SCORE : 0) +
			Math.min(text.length, 100) / 100;
		if (!best || score > best.score) best = { text, score };
	}
	return best?.text;
}

/**
 * 没有子调用时的脚本行：语句逐行用 │ 树线列出，行数跟 expandedInputMaxLines。
 * 超出的收成一行 `… N more lines`。注释、空行和 `// @options` 不占行。
 */
export function codemodeCodeLines(
	code: unknown,
	fg: (color: string, text: string) => string,
	rowWidth: number,
): string[] {
	if (typeof code !== "string" || !code.trim()) return [];
	const statements: string[] = [];
	let skippingBlock = false;
	for (const raw of code.split("\n")) {
		const line = raw.trim();
		if (skippingBlock) {
			if (line.includes("*/")) skippingBlock = false;
			continue;
		}
		if (line.startsWith("/*")) {
			if (!line.includes("*/")) skippingBlock = true;
			continue;
		}
		if (!line || line.startsWith("//") || line.startsWith("*")) continue;
		const text = oneLine(line);
		if (text) statements.push(text);
	}
	if (statements.length === 0) return [];
	const limit = Math.max(1, expandedLineLimit(config.expandedInputMaxLines));
	const visible = statements.slice(0, limit);
	const rail = `${INDENT}${fg("dim", "│")} `;
	const lines = visible.map((statement) =>
		truncateToWidth(`${rail}${highlightCodeSummary(statement)}`, rowWidth, ""),
	);
	const hidden = statements.length - visible.length;
	if (hidden > 0) {
		lines.push(
			truncateToWidth(
				`${rail}${fg("dim", `… ${hidden} more ${hidden === 1 ? "line" : "lines"}`)}`,
				rowWidth,
				"",
			),
		);
	}
	return lines;
}

/**
 * 所以包一层 `() => { … }` 再取中间那一行。失败或没着色时退回原文。
 */
export function highlightCodeSummary(summary: string): string {
	try {
		const lines = highlightCode(`() => { ${summary} }`, "javascript");
		const colored = lines[0]?.replace(/^\(\) => \{ /, "").replace(/ \}$/, "");
		return colored && stripAnsi(colored) === summary ? colored : summary;
	} catch {
		return summary;
	}
}

/** 与 pi 原生一致：不到 1 分显示两位有效数字。 */
function formatCost(cost: number): string {
	return `$${cost >= 0.01 ? cost.toFixed(2) : cost.toPrecision(2)}`;
}

/** 单次子调用的耗时/费用（纯文本，着色由调用方决定）。 */
function callMeta(call: CodemodeNestedCall): string[] {
	const out: string[] = [];
	const duration = call?.durationMs;
	if (typeof duration === "number" && Number.isFinite(duration) && duration >= 0) {
		out.push(formatToolDuration(duration));
	}
	const cost = call?.cost;
	if (typeof cost === "number" && Number.isFinite(cost) && cost > 0) out.push(formatCost(cost));
	return out;
}

/** 截断的紧凑 JSON 里能恢复出的对象；complete 标记是否原本就完整。 */
type ParsedCallArgs = { args: Record<string, unknown>; complete: boolean };

/** 截断串尾部补闭合符号的候选：先试收字符串，再收数组与对象。 */
const REPAIR_CLOSERS = ['"}', '"}]}', '"}}', "}", "]}"];

/**
 * 子调用参数：先直接解析；pi 从尾部截断过（超 200 字符）的串再补救一次——
 * 逐字回退补上缺少的闭合符号，取最长能解析出的对象。截断保留的是开头字段，
 * path/command/pattern 这类先出现的取得到；被切掉的尾部值本就无从恢复。
 */
function parseCallArgs(raw: string): ParsedCallArgs | undefined {
	try {
		const parsed = JSON.parse(raw);
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			return { args: parsed, complete: true };
		}
		return undefined;
	} catch {
		// 截断串：走补救
	}
	const body = raw.endsWith("...") ? raw.slice(0, -3) : raw;
	if (!body.startsWith("{")) return undefined;
	for (let end = body.length; end > 0; end--) {
		for (const closer of REPAIR_CLOSERS) {
			try {
				const parsed = JSON.parse(body.slice(0, end) + closer);
				if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
				// 空对象等于没恢复出字段，再短也只会更空
				if (Object.keys(parsed).length === 0) return undefined;
				return { args: parsed, complete: false };
			} catch {
				// 试下一个闭合符号 / 下一个长度
			}
		}
	}
	return undefined;
}

/** 子调用参数：能解析就复用字段链摘要，认不出（截断后也不成形）就贴原文。 */
function callSummary(call: CodemodeNestedCall): ToolCallSummary {
	const name = String(call?.name ?? "tool");
	const title = mcpToolTitle({ toolName: name }) ?? humanizeToolLabel(name);
	const raw = typeof call?.args === "string" ? call.args : "";
	if (!raw) return { main: title, detail: "" };
	const parsed = parseCallArgs(raw);
	if (parsed) {
		const summary = toolCallSummary(name, parsed.args, { title, variant: "default" });
		// 截断串只恢复出部分字段：字段链认出来了才用（payload 是字段链挑出的值，
		// path/main 的兜底标题不算）；认不出仍旧贴原文，免得把不完整的 JSON 当成完整入参摊开。
		const recognized = summary.payload !== undefined || summary.path !== undefined;
		// 完全还原的入参：标题与载荷分色后的 summary 直接用；恢复了字段的也用结构化
		// 结果（字段链认出的值比截断原文更可读）。认不出的才退回贴原文。
		if (parsed.complete || recognized) return summary;
	}
	return { main: title, detail: "", payload: raw };
}

function statusIcon(status: unknown, theme: any): string {
	switch (status) {
		case "ok":
			return theme.fg("success", "✓");
		case "error":
			return theme.fg("error", "✗");
		case "cancelled":
			return theme.fg("muted", "⊘");
		default:
			// 运行中：帧在 render() 内取，动画定时器只负责 requestRender
			return theme.fg("dim", toolLoadingIcon());
	}
}

function callRow(call: CodemodeNestedCall, theme: any, rowWidth: number): string {
	const fg = theme.fg.bind(theme);
	const prefix = `${INDENT}${fg("dim", "├")} ${statusIcon(call?.status, theme)} `;
	// detail（read 的 offset/limit 等）与工具组行一样接在标题后
	const summary = callSummary(call);
	const detail = fg("dim", summary.detail);
	const suffix = callMeta(call)
		.map((text) => ` ${fg("dim", text)}`)
		.join("");
	const mainWidth = Math.max(
		0,
		rowWidth - visibleWidth(prefix) - visibleWidth(detail) - visibleWidth(suffix),
	);
	const row = `${prefix}${renderToolSummary(summary, mainWidth, fg)}${detail}${suffix}`;
	return truncateToWidth(row, rowWidth, "");
}

/**
 * 折叠态（含运行中的 partial 更新）的行：子调用全用 ├，最后一行用 └ 收汇总，
 * 与工具组的树一致。
 */
export function codemodeCollapsedLines(options: {
	result: any;
	theme: any;
	running: boolean;
	isError: boolean;
	width: number;
	/** 鼠标悬停整卡时展开提示用 text 色，与其它折叠卡一致。 */
	hovered?: boolean;
	/** 脚本源码；没有子调用时用来补一行 `code:` 摘要。 */
	code?: unknown;
}): string[] {
	const { result, theme, running, isError } = options;
	const fg = theme.fg.bind(theme);
	const calls = codemodeCalls(result);
	const rowWidth = toolViewportWidth(options.width);
	const shown = calls.slice(-COLLAPSED_CALL_LIMIT);
	const lines: string[] = [];
	// 没有子调用时脚本本身是唯一线索：逐行用 │ 树线列出，行数跟 expandedInputMaxLines，
	// 汇总行仍用 └ 收尾。
	if (shown.length === 0) {
		lines.push(...codemodeCodeLines(options.code, fg, rowWidth));
	}
	if (shown.length < calls.length) {
		const hidden = calls.length - shown.length;
		lines.push(
			truncateToWidth(
				`${INDENT}${fg("dim", "├")} ${fg("dim", `… ${hidden} earlier ${hidden === 1 ? "call" : "calls"}`)}`,
				rowWidth,
				"",
			),
		);
	}
	for (const call of shown) lines.push(callRow(call, theme, rowWidth));

	const summary = codemodeSummaryParts(calls, codemodeOutputLineCount(result), running);
	// 上面已有行（子调用或代码摘要）时用 └ 收尾，否则不画衔接符
	const prefix = lines.length > 0 ? `${INDENT}${fg("dim", "└")} ` : INDENT;
	// 圆点保持 dim；hover 只高亮可点击文字。
	const hint = running
		? ""
		: ` ${fg("dim", "·")} ${fg(options.hovered ? "text" : "dim", showMoreHintText())}`;
	const bodyWidth = Math.max(1, rowWidth - visibleWidth(prefix) - visibleWidth(hint));
	const body = fg(isError ? "error" : "muted", fitSummaryParts(summary, bodyWidth));
	lines.push(truncateToWidth(`${prefix}${body}${hint}`, rowWidth, ""));
	return lines;
}

/** 展开态正文：全部子调用（含错误文本）+ 去掉脚本头的输出 + 全量输出路径。 */
export function codemodeExpandedBody(result: any): string {
	const parts: string[] = [];
	const calls = codemodeCalls(result);
	if (calls.length > 0) {
		parts.push(
			calls
				.map((call) => {
					const name = String(call?.name ?? "tool");
					const raw = typeof call?.args === "string" ? call.args : "";
					const meta = callMeta(call);
					const head = [name, raw, ...meta].filter(Boolean).join(" ");
					const error =
						typeof call?.error === "string" && call.error
							? `\n    ${call.error.split("\n").join("\n    ")}`
							: "";
					return `${head}${error}`;
				})
				.join("\n"),
		);
	}
	const output = codemodeOutputText(result);
	if (output) parts.push(output);
	const full = result?.details?.fullOutputPath;
	if (typeof full === "string" && full.trim()) parts.push(`Full output: ${full.trim()}`);
	return parts.join("\n\n");
}

/**
 * 折叠态结果组件。只有汇总行是展开入口，与 diff 卡一致；行本身很便宜，
 * 不自己缓存（settled 卡另有整行 paint 缓存，运行中本就按帧重算）。hover 状态在
 * render() 内取，才能跟鼠标 motion 的 requestRender 同步。
 */
export function createCodemodeResultComponent(options: {
	result: any;
	theme: any;
	running: boolean;
	isError: boolean;
	/** 折叠态 hover 查询，与 diff 卡同一套（mouse/hover）。 */
	isHovered?: () => boolean;
	/** 脚本源码；没有子调用时用来补一行 `code:` 摘要。 */
	code?: unknown;
}): any {
	const { result, theme, running, isError } = options;
	return {
		render(width: number): string[] {
			return codemodeCollapsedLines({
				result,
				theme,
				running,
				isError,
				width,
				hovered: options.isHovered?.() ?? false,
				code: options.code,
			});
		},
		invalidate(): void {},
		isCollapsedHintLine(plainLine: string): boolean {
			return !running && /(click to show more|to show more)\s*$/.test(stripAnsi(plainLine));
		},
	};
}
