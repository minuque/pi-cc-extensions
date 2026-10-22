/**
 * Agent 回合摘要展示：agent_end 时把本回合工具统计与完成时间写入会话条目，
 * 由 entry renderer 渲染为单行 `✻ Ran 4 commands · Completed for 11s · done 6:51 PM`。
 *
 * appendEntry 不进 LLM 上下文，只显示在聊天区。
 * 整个功能由 enableAgentSummary 控制；关闭时不会注册本扩展。
 */

import { Text } from "@earendil-works/pi-tui";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { bindAgentSummary, summaryLine, type AgentSummaryData } from "./core.ts";

export const AGENT_SUMMARY_ENTRY_TYPE = "agent-summary";

export default function (pi: ExtensionAPI): void {
	pi.registerEntryRenderer(AGENT_SUMMARY_ENTRY_TYPE, (entry, _options, theme) => {
		const data = entry.data as AgentSummaryData | undefined;
		if (!data) return undefined;
		return new Text(theme.fg("dim", summaryLine(data)), 0, 0);
	});

	bindAgentSummary(pi, (data) => {
		pi.appendEntry(AGENT_SUMMARY_ENTRY_TYPE, data);
	});
}
