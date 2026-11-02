import assert from "node:assert/strict";
import test from "node:test";
import {
	formatSessionTokenTotal,
	sessionEntryTokens,
	usageTokenTotal,
} from "../extensions/feature/shell/session-tokens.ts";

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

test("session token total adds up entries and skips ones without usage", () => {
	const entries = [
		{ type: "message", message: { role: "assistant", usage: { totalTokens: 10 } } },
		{ type: "message", message: { role: "user", content: "hi" } },
		{ type: "message", message: { role: "toolResult", usage: { totalTokens: 20 } } },
		{ type: "compaction", usage: { totalTokens: 5 } },
		{ type: "usage", usage: { totalTokens: 15 } },
		{ type: "model_change" },
		null,
	];
	assert.equal(
		entries.reduce<number>((sum, entry) => sum + sessionEntryTokens(entry), 0),
		50,
	);
});

test("formatSessionTokenTotal abbreviates and hides when empty", () => {
	assert.equal(formatSessionTokenTotal(0), "");
	assert.equal(formatSessionTokenTotal(Number.NaN), "");
	assert.equal(formatSessionTokenTotal(999), "∑ 999");
	assert.equal(formatSessionTokenTotal(1234), "∑ 1.2k");
	assert.equal(formatSessionTokenTotal(402_000), "∑ 402k");
	assert.equal(formatSessionTokenTotal(1_250_000), "∑ 1.3M");
});
