import assert from "node:assert/strict";
import test, { describe } from "node:test";
import workingMessageExtension from "../extensions/feature/shell/working-message.ts";
import { initTheme } from "@earendil-works/pi-coding-agent";
import {
	carryTokenRate,
	currentTokenRate,
	currentTtftMs,
	displayTokenRate,
	formatTokenRate,
	markFirstToken,
	pauseTokenRate,
	recordProviderUsage,
	resetTokenRate,
	resumeTokenRate,
	sampleTokenDelta,
	totalTokens,
} from "../extensions/feature/shell/token-rate.ts";

initTheme("dark");

// 模块级状态，必须串行；并行会互相清掉速率。
describe("token rate", { concurrency: false }, () => {
	function install() {
		const events = new Map<string, Function>();
		const ui = { setWorkingMessage() {} } as any;
		workingMessageExtension({
			on(name: string, handler: Function) {
				events.set(name, handler);
			},
		} as any);
		const ctx = { hasUI: true, ui };
		return { events, ctx };
	}

	test("formatTokenRate renders empty for no data, rounds below 1k, and uses k above", () => {
		assert.equal(formatTokenRate(0), "");
		assert.equal(formatTokenRate(-1), "");
		assert.equal(formatTokenRate(Number.NaN), "");
		assert.equal(formatTokenRate(42.4), "avg 42 tok/s");
		assert.equal(formatTokenRate(99.6), "avg 100 tok/s");
		assert.equal(formatTokenRate(1234), "avg 1.2k tok/s");
		assert.equal(formatTokenRate(10500), "avg 10.5k tok/s");
	});

	test("formatTokenRate appends TTFT only when present", () => {
		assert.equal(formatTokenRate(1200, 0), "avg 1.2k tok/s");
		assert.equal(formatTokenRate(1200, 812.4), "avg 1.2k tok/s (TTFT: 812ms)");
		assert.equal(formatTokenRate(1200, -5), "avg 1.2k tok/s");
		assert.equal(formatTokenRate(1200, 812, "live"), "live 1.2k tok/s (TTFT: 812ms)");
		assert.equal(formatTokenRate(1200, 812, "average", false), "avg 1.2k tok/s");
		assert.equal(formatTokenRate(1200, 999.4), "avg 1.2k tok/s (TTFT: 999ms)");
		assert.equal(formatTokenRate(1200, 1000), "avg 1.2k tok/s (TTFT: 1.0s)");
		assert.equal(formatTokenRate(1200, 12_340), "avg 1.2k tok/s (TTFT: 12.3s)");
	});

	test("live mode uses the trailing window and holds it through a tool wait", () => {
		resetTokenRate(1_000);
		sampleTokenDelta("a".repeat(400), 2_000); // 100 est tokens
		sampleTokenDelta("a".repeat(400), 2_500); // +100 over 0.5s
		assert.equal(displayTokenRate("live"), 200);
		assert.equal(displayTokenRate("average"), 200 / 1.5);

		pauseTokenRate(2_600);
		// 工具执行中没有 delta；暂停期 lastRate 保持，live 保留上一条窗口值。
		assert.equal(displayTokenRate("live"), 200, "暂停时保留窗口速率");

		resumeTokenRate();
		sampleTokenDelta("a".repeat(400), 4_200);
		sampleTokenDelta("a".repeat(400), 4_600); // 恢复后窗口 100 token / 0.4s
		assert.equal(displayTokenRate("live"), 250);
	});

	test("estimate counts CJK as one token and ascii as chars/4", () => {
		resetTokenRate(1_000);
		sampleTokenDelta("你好", 2_000); // 2 tokens
		sampleTokenDelta("a".repeat(8), 2_600); // +2 tokens，窗口增量 2 / 0.6s
		assert.equal(displayTokenRate("live"), 2 / 0.6);
		resumeTokenRate();
	});

	test("provider usage back-dates across the message window", () => {
		resetTokenRate(1_000);
		sampleTokenDelta("a".repeat(400), 2_000); // 估算先铺窗
		recordProviderUsage(300, 3_000); // 真实值 300，覆盖估算并摊回窗口
		assert.ok(displayTokenRate("average") >= 300 / 2);
		assert.ok(displayTokenRate("live") > 0);
	});

	test("carryTokenRate keeps the shown rate across a tool turn", () => {
		resetTokenRate(1_000);
		sampleTokenDelta("a".repeat(400), 11_000); // ~10 tok/s
		const rate = currentTokenRate();
		carryTokenRate(); // 工具调用结束，本段 token 结转
		assert.equal(currentTokenRate(), rate, "工具等待期间保留上一段速率");
	});

	test("TTFT records only the first content block of the turn and survives sampling", () => {
		resetTokenRate(1_000);
		assert.equal(currentTtftMs(), 0);
		markFirstToken(1_500); // first block: 500ms after turn start
		markFirstToken(2_000); // later block must not overwrite
		assert.equal(currentTtftMs(), 500);
		sampleTokenDelta("a".repeat(400), 11_000); // sampling does not touch TTFT
		assert.equal(currentTtftMs(), 500);

		resetTokenRate(5_000);
		assert.equal(currentTtftMs(), 0, "new turn clears TTFT until the first block");
	});

	test("toolcall_start marks the first token like text/thinking starts", async () => {
		const { events, ctx } = install();

		await events.get("before_agent_start")?.({}, ctx);
		await events.get("turn_start")?.({ timestamp: Date.now() - 5 }, ctx);
		// 模型直接发起 tool call：没有 thinking/text，首块是 toolcall_start
		await events.get("message_update")?.(
			{ assistantMessageEvent: { type: "toolcall_start", partial: { usage: { output: 10 } } } },
			ctx,
		);
		assert.ok(currentTtftMs() > 0, "toolcall_start should record TTFT");
		resumeTokenRate();
		await events.get("turn_end")?.({}, ctx);
		await events.get("agent_end")?.({}, ctx);
	});

	test("a tool turn keeps the rate and TTFT until the next user prompt", async () => {
		const { events, ctx } = install();

		await events.get("before_agent_start")?.({}, ctx);
		await events.get("turn_start")?.({ timestamp: Date.now() - 1_000 }, ctx);
		await events.get("message_update")?.(
			{ assistantMessageEvent: { type: "text_start", contentIndex: 0, partial: {} } },
			ctx,
		);
		await events.get("message_update")?.(
			{
				assistantMessageEvent: {
					type: "text_delta",
					contentIndex: 0,
					delta: "x".repeat(400),
					partial: { usage: { output: 100 } },
				},
			},
			ctx,
		);
		const rate = currentTokenRate();
		const ttft = currentTtftMs();
		assert.ok(rate > 0);
		assert.ok(ttft > 0);

		// 工具执行后回到 average 时仍累计；下一条指令才重置。resume 后 delta 才进窗。
		await events.get("turn_end")?.({}, ctx);
		assert.equal(currentTokenRate(), rate, "turn 结束不清速率");
		assert.equal(currentTtftMs(), ttft);

		// 工具结果之后的下一段 assistant 回复，仍属同一条用户指令。
		await events.get("turn_start")?.({}, ctx);
		assert.equal(currentTokenRate(), rate, "下一段 turn 不清速率");
		assert.equal(currentTtftMs(), ttft, "下一段 turn 不重记 TTFT");

		// 收尾，避免泄漏给同进程的其它测试文件。
		await events.get("turn_end")?.({}, ctx);
		await events.get("agent_end")?.({}, ctx);
	});

	test("later content blocks do not recount cumulative usage into the live window", async () => {
		const { events, ctx } = install();
		const originalNow = Date.now;
		let now = 1_000;
		Date.now = () => now;
		try {
			await events.get("before_agent_start")?.({}, ctx);
			await events.get("turn_start")?.({ timestamp: 1_000 }, ctx);
			now = 2_000;
			await events.get("message_update")?.(
				{
					assistantMessageEvent: {
						type: "thinking_start",
						partial: { usage: { output: 100 } },
					},
				},
				ctx,
			);
			now = 3_000;
			await events.get("message_update")?.(
				{
					assistantMessageEvent: {
						type: "text_start",
						partial: { usage: { output: 180 } },
					},
				},
				ctx,
			);
			assert.equal(totalTokens(), 180);
			assert.equal(displayTokenRate("live"), 80);
		} finally {
			Date.now = originalNow;
			await events.get("turn_end")?.({}, ctx);
			await events.get("agent_end")?.({}, ctx);
		}
	});

	test("placeholder usage keeps delta estimates and message_end finalizes the total", async () => {
		const { events, ctx } = install();
		const originalNow = Date.now;
		let now = 1_000;
		Date.now = () => now;
		// Anthropic 的 message_start 给出 output_tokens: 2，Pi 把它挂在之后每个 partial 上。
		const update = (type: string, delta?: string) =>
			events.get("message_update")?.(
				{ assistantMessageEvent: { type, delta, partial: { usage: { output: 2 } } } },
				ctx,
			);
		try {
			await events.get("before_agent_start")?.({}, ctx);
			await events.get("turn_start")?.({ timestamp: 1_000 }, ctx);
			now = 1_500;
			await update("text_start");
			now = 2_000;
			await update("text_delta", "a".repeat(400));
			now = 2_500;
			await update("text_delta", "a".repeat(400));
			assert.equal(totalTokens(), 202, "占位值不把 delta 累计拨回去");
			assert.equal(displayTokenRate("live"), 200);

			// Pi 不把 done 转成 message_update，message_delta 的累计值只在 message_end 上。
			now = 3_000;
			await events.get("message_end")?.(
				{ message: { role: "assistant", stopReason: "stop", usage: { output: 1_000 } } },
				ctx,
			);
			assert.equal(totalTokens(), 1_000);
			assert.equal(currentTokenRate(), 500, "平均按真实总量重算");
			assert.equal(displayTokenRate("live"), 200, "未逐字流出的 token 不回填 live 窗口");
		} finally {
			Date.now = originalNow;
			await events.get("turn_end")?.({}, ctx);
			await events.get("agent_end")?.({}, ctx);
		}
	});

	test("message_end only finalizes usage from a completed assistant message", async () => {
		const { events, ctx } = install();
		const update = (type: string, delta?: string) =>
			events.get("message_update")?.(
				{ assistantMessageEvent: { type, delta, partial: { usage: { output: 2 } } } },
				ctx,
			);
		await events.get("before_agent_start")?.({}, ctx);
		await events.get("turn_start")?.({ timestamp: Date.now() - 1_000 }, ctx);
		await update("text_start");
		await update("text_delta", "a".repeat(400));
		assert.equal(totalTokens(), 102);

		// 中断时 usage 还是 message_start 的占位值，不能覆盖估算。
		await events.get("message_end")?.(
			{ message: { role: "assistant", stopReason: "aborted", usage: { output: 2 } } },
			ctx,
		);
		assert.equal(totalTokens(), 102);

		// 工具结果可能带着嵌套调用的 usage，不属于本段输出。
		await events.get("message_end")?.(
			{ message: { role: "toolResult", usage: { output: 999 } } },
			ctx,
		);
		assert.equal(totalTokens(), 102);

		await events.get("turn_end")?.({}, ctx);
		await events.get("agent_end")?.({}, ctx);
	});
});
