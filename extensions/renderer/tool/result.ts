import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { inspect } from "node:util";
import { config } from "../../config/config.ts";
import { sanitizeToolResultText } from "../../utils/tool-result-sanitize.ts";
import { oneLine } from "../../utils/format.ts";

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

/**
 * 折叠行的结果文案：`N lines returned`（read 说 loaded）、`Done`、失败时首行错误。
 * 单卡折叠行与工具组的子行共用这一处口径；TaskList 的树形摘要不走这里，由调用方先判。
 */
export function collapsedResultSummary(options: {
	result: any;
	toolName: string;
	text: string;
	isError: boolean;
}): string {
	const { result, toolName, text, isError } = options;
	if (isError) {
		// 72 与原 result.ts 默认一致，保持错误摘要截断宽度。
		return text ? oneLine(text, 72) : "Failed";
	}
	const outputLines = outputLineCount(result) || countLines(text);
	if (!outputLines) return "Done";
	const action = toolName === "read" ? "loaded" : "returned";
	return `${outputLines} ${outputLines === 1 ? "line" : "lines"} ${action}`;
}

/**
 * 工具耗时：不到 1 秒报毫秒，分钟级起带上分/时。
 * 只报到秒的话，几分钟的长命令会显示成 `300.0s`。
 */
export function formatToolDuration(ms: number): string {
	const seconds = ms / 1000;
	if (seconds < 1) return `${Math.round(ms)}ms`;
	if (seconds < 60) return `${seconds.toFixed(1)}s`;
	const totalSeconds = Math.floor(seconds);
	const minutes = Math.floor(totalSeconds / 60);
	const remainder = totalSeconds % 60;
	if (minutes < 60) return `${minutes}m ${remainder}s`;
	return `${Math.floor(minutes / 60)}h ${minutes % 60}m ${remainder}s`;
}
/** 截断体末行 `… N more lines` 旁的展开提示，点击打开全量预览。 */
export const SHOW_MORE_LABEL = "· click to show more";

/** 折叠结果行：`   ↳ <body>`。 */
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
