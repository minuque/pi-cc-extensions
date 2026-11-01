/**
 * Agent 回合摘要展示：agent_end 时把本回合工具统计写入会话条目，
 * 由 entry renderer 渲染成一行引用行 `│ Ran 1 command, wrote 1 file · 15s`。
 *
 * 统计复用 ./core.ts（bash|powershell/read/edit/write/other）。
 * appendEntry 不进 LLM 上下文，只显示在聊天区。
 *
 * 不走 Markdown：pi 的 Markdown 组件会剥掉输入里的终端序列，
 * 数字的语义色只能由组件自己拼。竖线取 mdQuoteBorder，文字取 mdQuote + 斜体，数字取 success/error。
 */

import { wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { formatDuration } from "../../utils/format.ts";
import { bindAgentSummary, summarySegments, type SummarySegment } from "./core.ts";
import type { AgentSummaryData } from "./core.ts";

export const AGENT_SUMMARY_ENTRY_TYPE = "agent-summary";

type SummaryTheme = {
	fg(color: string, text: string): string;
	italic(text: string): string;
	getFgAnsi(color: string): string;
};

/** 取样式函数在正文前产生的 SGR 前缀；行内 reset 之后要靠它把样式续上。 */
function stylePrefix(style: (text: string) => string): string {
	const sentinel = "\u0000";
	const styled = style(sentinel);
	const index = styled.indexOf(sentinel);
	return index >= 0 ? styled.slice(0, index) : "";
}

/** 只给段内第一个数字上色；没有数字的段原样返回。 */
function paintNumber(segment: SummarySegment, theme: SummaryTheme): string {
	const match = /(\d+)/.exec(segment.text);
	if (!match) return segment.text;
	const ansi = theme.getFgAnsi(segment.tone === "failed" ? "error" : "success");
	if (!ansi) return segment.text;
	const start = match.index;
	return `${segment.text.slice(0, start)}${ansi}${match[1]}\x1b[0m${segment.text.slice(start + match[1].length)}`;
}

/** 摘要行：左侧 mdQuoteBorder 竖线 + 斜体 mdQuote 正文，数字按成功/失败上色。 */
class AgentSummaryLine {
	private readonly body: string;
	private readonly border: string;
	private readonly theme: SummaryTheme;

	constructor(segments: readonly SummarySegment[], duration: string, theme: SummaryTheme) {
		this.theme = theme;
		this.border = theme.fg("mdQuoteBorder", "│");
		const quoteStyle = (text: string) => theme.italic(theme.fg("mdQuote", text));
		const counts = segments.map((segment) => paintNumber(segment, theme)).join(", ");
		const text = duration ? `${counts} · ${duration}` : counts;
		const prefix = stylePrefix(quoteStyle);
		this.body = quoteStyle(prefix ? text.replace(/\x1b\[0m/g, `\x1b[0m${prefix}`) : text);
	}

	invalidate(): void {}

	render(width: number): string[] {
		const contentWidth = Math.max(1, width - 4);
		return wrapTextWithAnsi(this.body, contentWidth).map((line) => ` ${this.border} ${line}`);
	}
}

export default function (pi: ExtensionAPI): void {
	pi.registerEntryRenderer(AGENT_SUMMARY_ENTRY_TYPE, (entry, _options, theme) => {
		const segments = summarySegments(entry.data as AgentSummaryData);
		if (segments.length === 0) return undefined;
		const duration = formatDuration((entry.data as AgentSummaryData).durationMs);
		return new AgentSummaryLine(segments, duration, theme as unknown as SummaryTheme);
	});

	bindAgentSummary(pi, (data) => {
		pi.appendEntry(AGENT_SUMMARY_ENTRY_TYPE, data);
	});
}
