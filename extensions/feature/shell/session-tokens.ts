/**
 * footer 的会话累计 token：直接统计当前会话 jsonl。
 *
 * 口径是 `usage.totalTokens` 累加（输入 + 输出 + 缓存读 + 缓存写），
 * 覆盖 assistant / toolResult 消息，以及 compaction、branch_summary 与 `usage` 条目
 * 自己那次 LLM 调用的开销。整个文件全量累加，不沿当前分支裁剪：
 * 回退/重发放弃的节点也算进「这次对话烧掉了多少 token」。
 *
 * 文件是 append-only 的，所以读取做成增量：记住 inode + 已读字节偏移，
 * 每次只读新增部分。只有换文件、inode 变化或文件变小（SessionManager 在
 * 迁移/重写版本时会整份重写）才从头重算。最后一行可能正在写，读到不完整的
 * 尾行不推进偏移，等下一次刷新再算。
 */

import { closeSync, openSync, readSync, statSync } from "node:fs";
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

/** 多行 jsonl 文本求累计；解析失败的行（包括写了一半的尾行）直接跳过。 */
export function sumSessionTokens(text: string): number {
	let total = 0;
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(trimmed);
		} catch {
			continue;
		}
		total += sessionEntryTokens(parsed);
	}
	return total;
}

export type SessionTokenReader = {
	/** 读取新增部分并返回累计值；文件不存在或读失败时保持上一次的值。 */
	refresh(filePath: string | undefined): number;
	/** 丢弃已读进度，下一次 refresh 从头重算。 */
	reset(): void;
	/** 当前累计值，不触发读取。 */
	total(): number;
};

type FileState = { path: string; ino: number | bigint | null; offset: number };

export function createSessionTokenReader(): SessionTokenReader {
	let state: FileState | undefined;
	let total = 0;

	const reset = () => {
		state = undefined;
		total = 0;
	};

	const refresh = (filePath: string | undefined): number => {
		if (!filePath) {
			reset();
			return 0;
		}
		let info: { ino: number | bigint; size: number };
		try {
			const stat = statSync(filePath);
			info = { ino: stat.ino, size: stat.size };
		} catch {
			// 新会话还没有落盘文件（第一条消息才创建），保持当前值。
			return total;
		}
		if (!state || state.path !== filePath || state.ino !== info.ino || info.size < state.offset) {
			state = { path: filePath, ino: info.ino, offset: 0 };
			total = 0;
		}
		const length = info.size - state.offset;
		if (length <= 0) return total;
		let fd: number | undefined;
		try {
			fd = openSync(filePath, "r");
			const buffer = Buffer.allocUnsafe(length);
			const read = readSync(fd, buffer, 0, length, state.offset);
			if (read <= 0) return total;
			const chunk = buffer.subarray(0, read).toString("utf8");
			const end = chunk.lastIndexOf("\n");
			// 没有完整行：尾行还在写，不推进偏移。
			if (end < 0) return total;
			const complete = chunk.slice(0, end + 1);
			total += sumSessionTokens(complete);
			state.offset += Buffer.byteLength(complete, "utf8");
		} catch {
			// 权限/竞争失败就保持旧值，下次刷新重试。
		} finally {
			if (fd !== undefined) closeSync(fd);
		}
		return total;
	};

	return { refresh, reset, total: () => total };
}

/** 芯片文案：`∑ 402k`；没有数据返回空串（不占位置）。 */
export function formatSessionTokenTotal(total: number): string {
	if (!Number.isFinite(total) || total <= 0) return "";
	return `∑ ${formatTokenCount(Math.round(total))}`;
}
