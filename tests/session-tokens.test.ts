import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	createSessionTokenReader,
	formatSessionTokenTotal,
	sessionEntryTokens,
	sumSessionTokens,
	usageTokenTotal,
} from "../extensions/feature/shell/session-tokens.ts";

const assistant = (totalTokens: number, extra: Record<string, number> = {}) =>
	JSON.stringify({
		type: "message",
		id: `m${totalTokens}`,
		parentId: null,
		timestamp: "2026-01-01T00:00:00.000Z",
		message: {
			role: "assistant",
			content: [],
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				...extra,
			},
		},
	});

test("usageTokenTotal prefers totalTokens and falls back to the four buckets", () => {
	assert.equal(usageTokenTotal({ totalTokens: 120, input: 1, output: 2 }), 120);
	assert.equal(usageTokenTotal({ input: 10, output: 5, cacheRead: 100, cacheWrite: 2 }), 117);
	// 缺失/异常值一律忽略，负数不当抵扣
	assert.equal(usageTokenTotal({ totalTokens: 0, input: 7 }), 7);
	assert.equal(usageTokenTotal({ totalTokens: Number.NaN, input: -5, output: 3 }), 3);
	assert.equal(usageTokenTotal(undefined), 0);
	assert.equal(usageTokenTotal("nope"), 0);
});

test("sessionEntryTokens counts assistant, toolResult, compaction, branch_summary and usage entries", () => {
	const usage = { totalTokens: 50 };
	assert.equal(sessionEntryTokens({ type: "message", message: { role: "assistant", usage } }), 50);
	assert.equal(sessionEntryTokens({ type: "message", message: { role: "toolResult", usage } }), 50);
	assert.equal(sessionEntryTokens({ type: "compaction", usage }), 50);
	assert.equal(sessionEntryTokens({ type: "branch_summary", usage }), 50);
	assert.equal(sessionEntryTokens({ type: "usage", usage }), 50);
	// user/system/custom 条目不消耗 token
	assert.equal(sessionEntryTokens({ type: "message", message: { role: "user" } }), 0);
	assert.equal(sessionEntryTokens({ type: "message", message: { role: "system", usage } }), 0);
	assert.equal(sessionEntryTokens({ type: "message", message: { role: "toolResult" } }), 0);
	assert.equal(sessionEntryTokens({ type: "custom", usage }), 0);
	assert.equal(sessionEntryTokens({ type: "model_change" }), 0);
	assert.equal(sessionEntryTokens(null), 0);
});

test("sumSessionTokens skips blank and unparsable lines", () => {
	const text = [
		JSON.stringify({ type: "session", id: "s" }),
		assistant(10),
		"",
		"{not json",
		assistant(5),
	].join("\n");
	assert.equal(sumSessionTokens(text), 15);
	assert.equal(sumSessionTokens(""), 0);
});

test("the reader accumulates whole lines and keeps a half-written tail for later", (t) => {
	const dir = mkdtempSync(join(tmpdir(), "pi-session-tokens-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const file = join(dir, "session.jsonl");
	writeFileSync(file, `${assistant(10)}\n${assistant(20)}\n`);
	const reader = createSessionTokenReader();
	assert.equal(reader.refresh(file), 30);

	// 同一路径重复读：不重复累加
	assert.equal(reader.refresh(file), 30);
	assert.equal(reader.total(), 30);

	// 追加一整个条目
	appendFileSync(file, `${assistant(15)}\n`);
	assert.equal(reader.refresh(file), 45);

	// 尾行只写了一半：保留已读偏移，等下一次刷新
	appendFileSync(file, assistant(7).slice(0, 40));
	assert.equal(reader.refresh(file), 45);
	appendFileSync(file, `${assistant(7).slice(40)}\n`);
	assert.equal(reader.refresh(file), 52);

	// 没有换行结尾的完整 JSON 仍算未完成，不进入累计
	appendFileSync(file, assistant(3));
	assert.equal(reader.refresh(file), 52);
	appendFileSync(file, "\n");
	assert.equal(reader.refresh(file), 55);
});

test("the reader recounts from scratch when the file is replaced or shrinks", (t) => {
	const dir = mkdtempSync(join(tmpdir(), "pi-session-tokens-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const file = join(dir, "session.jsonl");
	writeFileSync(file, `${assistant(100)}\n`);
	const reader = createSessionTokenReader();
	assert.equal(reader.refresh(file), 100);

	// SessionManager 在版本迁移时会整份重写：文件变小必须从头算，而不是把差额当新数据
	writeFileSync(file, `${assistant(5)}\n`);
	assert.equal(reader.refresh(file), 5);

	// 换成另一个会话文件
	const other = join(dir, "other.jsonl");
	writeFileSync(other, `${assistant(11)}\n`);
	assert.equal(reader.refresh(other), 11);
	assert.equal(reader.refresh(file), 5);
});

test("the reader keeps the last total while the session file does not exist yet", (t) => {
	const dir = mkdtempSync(join(tmpdir(), "pi-session-tokens-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const file = join(dir, "session.jsonl");
	const reader = createSessionTokenReader();
	// 新会话要等第一条消息才落盘
	assert.equal(reader.refresh(file), 0);
	assert.equal(reader.refresh(undefined), 0);
	writeFileSync(file, `${assistant(42)}\n`);
	assert.equal(reader.refresh(file), 42);
	// 宿主暂时取不到路径（会话切换中）不清零
	assert.equal(reader.refresh(undefined), 0);
	reader.reset();
	assert.equal(reader.total(), 0);
});

test("formatSessionTokenTotal abbreviates and hides when empty", () => {
	assert.equal(formatSessionTokenTotal(0), "");
	assert.equal(formatSessionTokenTotal(Number.NaN), "");
	assert.equal(formatSessionTokenTotal(999), "∑ 999");
	assert.equal(formatSessionTokenTotal(1234), "∑ 1.2k");
	assert.equal(formatSessionTokenTotal(402_000), "∑ 402k");
	assert.equal(formatSessionTokenTotal(1_250_000), "∑ 1.3M");
});
