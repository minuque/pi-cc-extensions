/**
 * footer 的会话累计 token：统计 `sessionManager.getEntries()` 里每条条目的 usage。
 *
 * 口径是 `usage.totalTokens` 累加（输入 + 输出 + 缓存读 + 缓存写），
 * 覆盖 assistant / toolResult 消息，以及 compaction、branch_summary 与 `usage` 条目
 * 自己那次 LLM 调用的开销。整个会话全量累加，不沿当前分支裁剪：
 * 回退/重发放弃的节点也算进「这次对话烧掉了多少 token」。
 */

import { formatTokenCount } from "../../utils/format.ts";

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | undefined {
	return value && typeof value === "object" ? (value as UnknownRecord) : undefined;
}

/** `usage.totalTokens` 优先；缺失时用四项相加，非数字一律忽略。 */
export function usageTokenTotal(usage: unknown): number {
	const record = asRecord(usage);
	if (!record) return 0;
	const total = record.totalTokens;
	if (typeof total === "number" && Number.isFinite(total) && total > 0) return total;
	let sum = 0;
	for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const) {
		const part = record[key];
		if (typeof part === "number" && Number.isFinite(part) && part > 0) sum += part;
	}
	return sum;
}

/** 一条会话条目贡献的 token；user/system/自定义条目不消费 LLM token，返回 0。 */
export function sessionEntryTokens(entry: unknown): number {
	const record = asRecord(entry);
	if (!record) return 0;
	if (record.type === "message") {
		const message = asRecord(record.message);
		if (!message) return 0;
		if (message.role !== "assistant" && message.role !== "toolResult") return 0;
		return usageTokenTotal(message.usage);
	}
	if (record.type === "compaction" || record.type === "branch_summary" || record.type === "usage") {
		return usageTokenTotal(record.usage);
	}
	return 0;
}

/** 芯片文案：`<glyph> 402k`；没有数据返回空串（不占位置）。 */
export function formatSessionTokenTotal(total: number, glyph: string): string {
	if (!Number.isFinite(total) || total <= 0) return "";
	return `${glyph} ${formatTokenCount(Math.round(total))}`;
}
