/**
 * Agent 回合摘要：统计一次 agent 运行的工具使用，生成单行摘要。
 *
 * 分类：bash / read / edit / write / other（精确工具名；MCP 风格名归 other）。
 * 计数：bash/powershell 按调用次数；read/edit/write 按非空 path/file_path 去重；other 按调用次数。
 * 失败单独累计；另记回合耗时与完成时刻。
 *
 * 呈现：
 * - 工具 ≥2 次：`✻ Ran 4 commands · Read 2 files · Completed for 11s · done 6:51 PM`
 * - 工具 <2 次：`✻ Completed for 11s · done 6:51 PM`
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { formatDuration } from "../../utils/format.ts";

/** 工具分类。 */
export type AgentToolCategory = "bash" | "read" | "edit" | "write" | "other";

/** 一次 agent 回合的统计快照。 */
export type AgentSummaryData = {
	toolCount: number;
	commands: number;
	reads: number;
	edits: number;
	writes: number;
	others: number;
	failed: number;
	durationMs: number;
	doneAt: number;
};

export function classifyTool(toolName: string): AgentToolCategory {
	const base = toolName.split(".").pop() ?? toolName;
	if (base === "bash" || base === "powershell") return "bash";
	if (base === "read") return "read";
	if (base === "edit") return "edit";
	if (base === "write") return "write";
	return "other";
}

function nonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

function toolPath(args?: Record<string, unknown> | null): string | undefined {
	const path = args?.path ?? args?.file_path;
	return nonEmptyString(path) ? path : undefined;
}

/** 累积一次 agent 回合的工具统计；agent_start 时新建实例。 */
export class AgentRunSummary {
	toolCount = 0;
	commandCount = 0;
	readFiles = new Set<string>();
	editFiles = new Set<string>();
	writeFiles = new Set<string>();
	otherCount = 0;
	failedCount = 0;

	readonly startedAt: number;

	constructor(startedAt = Date.now()) {
		this.startedAt = startedAt;
	}

	/** tool_execution_start 时调用。 */
	recordToolStart(toolName: string, args?: Record<string, unknown> | null): void {
		this.toolCount++;
		const path = toolPath(args);
		switch (classifyTool(toolName)) {
			case "bash":
				this.commandCount++;
				break;
			case "read":
				if (path) this.readFiles.add(path);
				break;
			case "edit":
				if (path) this.editFiles.add(path);
				break;
			case "write":
				if (path) this.writeFiles.add(path);
				break;
			default:
				this.otherCount++;
		}
	}

	/** tool_execution_end 时调用；isError 为 true 计入失败。 */
	recordToolResult(isError: boolean): void {
		if (isError) this.failedCount++;
	}

	snapshot(now = Date.now()): AgentSummaryData {
		return {
			toolCount: this.toolCount,
			commands: this.commandCount,
			reads: this.readFiles.size,
			edits: this.editFiles.size,
			writes: this.writeFiles.size,
			others: this.otherCount,
			failed: this.failedCount,
			durationMs: now - this.startedAt,
			doneAt: now,
		};
	}
}

const plural = (count: number) => (count === 1 ? "" : "s");

/** 输出顺序：bash → read → edit → write → other → failed。 */
function summaryParts(data: AgentSummaryData): string[] {
	const parts: string[] = [];
	if (data.commands) parts.push(`ran ${data.commands} command${plural(data.commands)}`);
	if (data.reads) parts.push(`read ${data.reads} file${plural(data.reads)}`);
	if (data.edits) parts.push(`edited ${data.edits} file${plural(data.edits)}`);
	if (data.writes) parts.push(`wrote ${data.writes} file${plural(data.writes)}`);
	if (data.others) parts.push(`${data.others} other tool${plural(data.others)}`);
	if (data.failed) parts.push(`${data.failed} failed`);
	return parts;
}

/** 工具段：逗号分隔，只把第一个动词首字母大写。 */
function toolText(data: AgentSummaryData): string {
	const parts = summaryParts(data);
	if (parts.length === 0) return "";
	const [first, ...rest] = parts;
	return [first.charAt(0).toUpperCase() + first.slice(1), ...rest].join(", ");
}

/** `6:51 PM`，固定 en-US，和 Claude Code 的显示一致。 */
export function formatDoneClock(doneAt: number): string {
	const date = new Date(doneAt);
	if (Number.isNaN(date.getTime())) return "";
	return date
		.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })
		.replace(/\u202f/g, " ");
}

/** 单行摘要；工具 <2 次时只保留完成段。 */
export function summaryLine(data: AgentSummaryData): string {
	const parts: string[] = [];
	if (data.toolCount >= 2) {
		const tools = toolText(data);
		if (tools) parts.push(tools);
	}
	const duration = formatDuration(data.durationMs) || "0s";
	const done = formatDoneClock(data.doneAt);
	parts.push(`Completed for ${duration}${done ? ` · done ${done}` : ""}`);
	return `✻ ${parts.join(" · ")}`;
}

/**
 * 绑定 pi 事件到摘要统计：
 * - agent_start 重置
 * - tool_execution_start / end 累计
 * - agent_end 写出一条摘要
 */
export function bindAgentSummary(
	pi: ExtensionAPI,
	onSummary: (data: AgentSummaryData) => void,
): void {
	let summary = new AgentRunSummary();
	pi.on("agent_start", async () => {
		summary = new AgentRunSummary();
	});
	pi.on("tool_execution_start", async (event) => {
		summary.recordToolStart(event.toolName, event.args);
	});
	pi.on("tool_execution_end", async (event) => {
		summary.recordToolResult(event.isError === true);
	});
	pi.on("agent_end", async () => {
		onSummary(summary.snapshot());
	});
}
