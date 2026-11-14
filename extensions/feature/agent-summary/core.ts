/**
 * Agent 回合摘要：统计一次 agent 运行的工具使用并格式化成摘要文本。
 *
 * 分类：bash / read / edit / other（精确工具名；MCP 风格名归 other）。write 并入 edit。
 * 计数：bash/powershell 按调用次数；read/edit（含 write）按非空 path/file_path 去重；other 按调用次数。
 * 失败单独累计；另记回合耗时与结束时刻。
 *
 * 呈现：`summarySegments` 分段（文字 + 语义色），渲染层自己拼行并上色。
 * 不要经 Markdown 渲染：pi 的 Markdown 组件会剥掉输入里的终端序列，数字会失去语义色。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** 工具分类。 */
export type AgentToolCategory = "bash" | "read" | "edit" | "other";

/** 一次 agent 回合的统计快照。 */
export type AgentSummaryData = {
	commands: number;
	reads: number;
	edits: number;
	others: number;
	failed: number;
	durationMs: number;
	/** 回合结束时刻（epoch ms）。存进 entry，会话恢复时才能显示原来的时刻而不是“现在几点”。 */
	endedAt: number;
};

export function classifyTool(toolName: string): AgentToolCategory {
	const base = toolName.split(".").pop() ?? toolName;
	if (base === "bash" || base === "powershell") return "bash";
	if (base === "read") return "read";
	if (base === "edit" || base === "write") return "edit";
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
			commands: this.commandCount,
			reads: this.readFiles.size,
			edits: this.editFiles.size,
			others: this.otherCount,
			failed: this.failedCount,
			durationMs: now - this.startedAt,
			endedAt: now,
		};
	}
}

const plural = (count: number) => (count === 1 ? "" : "s");

/** 输出顺序：bash → read → edit → other → failed。 */
function summaryParts(data: AgentSummaryData): string[] {
	const parts: string[] = [];
	if (data.commands) parts.push(`ran ${data.commands} command${plural(data.commands)}`);
	if (data.reads) parts.push(`read ${data.reads} file${plural(data.reads)}`);
	if (data.edits) parts.push(`edited ${data.edits} file${plural(data.edits)}`);
	if (data.others) parts.push(`${data.others} other tool${plural(data.others)}`);
	if (data.failed) parts.push(`${data.failed} failed`);
	return parts;
}

/** 摘要段：一段文字 + 语义色；数字上色由渲染层完成。 */
export type SummarySegment = { text: string; tone: "success" | "failed" };

export function summarySegments(data: AgentSummaryData): SummarySegment[] {
	const parts = summaryParts(data);
	if (parts.length === 0) return [];
	const capitalizeFirst = (part: string, first: boolean) => {
		const verb = part.match(/^[a-z]+/)?.[0] ?? "";
		return first && verb ? verb[0].toUpperCase() + verb.slice(1) + part.slice(verb.length) : part;
	};
	return parts.map((part, index) => ({
		text: capitalizeFirst(part, index === 0),
		tone: part.endsWith("failed") ? "failed" : "success",
	}));
}

/**
 * 绑定 pi 事件到摘要统计：
 * - agent_start 重置
 * - tool_execution_start / end 累计
 * - agent_end 回调（toolCount < minToolCount 跳过）
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
		if (summary.toolCount >= 2) onSummary(summary.snapshot());
	});
}
