import assert from "node:assert/strict";
import test from "node:test";
import workingMessageExtension from "../extensions/feature/shell/working-message.ts";

function install() {
	const events = new Map<string, Function>();
	const messages: (string | undefined)[] = [];
	const ui = {
		setWorkingMessage(message?: string) {
			messages.push(message);
		},
	} as any;
	workingMessageExtension({
		on(name: string, handler: Function) {
			events.set(name, handler);
		},
	} as any);
	const ctx = { hasUI: true, ui };
	return { events, messages, ctx };
}

test("working message appends token count and elapsed time while streaming", async () => {
	const { events, messages, ctx } = install();

	await events.get("turn_start")?.({}, ctx);
	// No tokens yet and under the timer threshold: keep Pi's default "Working...".
	assert.equal(messages.at(-1), undefined);

	const delta = "This is a streaming response body long enough to count some tokens.";
	await events.get("message_update")?.(
		{ assistantMessageEvent: { type: "text_start", contentIndex: 0 } },
		ctx,
	);
	await events.get("message_update")?.(
		{ assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta } },
		ctx,
	);
	const working = messages.at(-1);
	assert.match(working ?? "", /^Working\.\.\. \(↓ \d+ tokens · \d+s\)$/);

	await events.get("turn_end")?.({}, ctx);
	assert.equal(messages.at(-1), undefined, "turn end restores default without a completion line");
	assert.equal(
		messages.some((message) => message?.startsWith("✻ Turn took")),
		false,
	);

	// Shutdown remains idempotent (undefined = Pi's default message).
	await events.get("session_shutdown")?.({}, ctx);
	assert.equal(messages.at(-1), undefined);
});

test("token count accumulates across deltas and resets on the next turn", async () => {
	const { events, messages, ctx } = install();
	await events.get("turn_start")?.({}, ctx);

	await events.get("message_update")?.(
		{ assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "abcd" } },
		ctx,
	);
	const first = messages.at(-1) ?? "";
	assert.match(first, /↓ 1 tokens/);

	await events.get("message_update")?.(
		{ assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "abcd" } },
		ctx,
	);
	assert.match(messages.at(-1) ?? "", /↓ 2 tokens/);

	// text_end provides the full block; it must replace, not double-count, deltas.
	await events.get("message_update")?.(
		{
			assistantMessageEvent: {
				type: "text_end",
				contentIndex: 0,
				content: "abcdefgh",
				partial: {},
			},
		},
		ctx,
	);
	assert.match(messages.at(-1) ?? "", /↓ 2 tokens/);

	// A second text block accumulates independently by contentIndex.
	await events.get("message_update")?.(
		{ assistantMessageEvent: { type: "text_start", contentIndex: 1, partial: {} } },
		ctx,
	);
	await events.get("message_update")?.(
		{
			assistantMessageEvent: {
				type: "text_delta",
				contentIndex: 1,
				delta: "abcdefgh",
				partial: {},
			},
		},
		ctx,
	);
	assert.match(messages.at(-1) ?? "", /↓ 4 tokens/);

	// Provider usage replaces the live estimate when available.
	await events.get("message_update")?.(
		{
			assistantMessageEvent: {
				type: "done",
				message: {
					content: [
						{ type: "text", text: "abcdefgh" },
						{ type: "text", text: "abcdefgh" },
					],
					usage: { output: 37 },
				},
			},
		},
		ctx,
	);
	assert.match(messages.at(-1) ?? "", /↓ 37 tokens/);

	// 同一条用户指令的下一段 turn 不清 token：工具后继续累计。
	await events.get("turn_end")?.({}, ctx);
	await events.get("turn_start")?.({}, ctx);
	assert.match(messages.at(-1) ?? "", /↓ 37 tokens/);
});

test("tool call argument deltas count toward the token total", async () => {
	const { events, messages, ctx } = install();
	await events.get("turn_start")?.({}, ctx);
	await events.get("message_update")?.(
		{ assistantMessageEvent: { type: "toolcall_start", contentIndex: 0, partial: {} } },
		ctx,
	);
	// 写文件这类工具的参数走 toolcall_delta。
	await events.get("message_update")?.(
		{
			assistantMessageEvent: {
				type: "toolcall_delta",
				contentIndex: 0,
				delta: '{"path":"a.txt"}',
				partial: {},
			},
		},
		ctx,
	);
	assert.match(messages.at(-1) ?? "", /↓ 4 tokens/);
	await events.get("turn_end")?.({}, ctx);
});

// compact 摘要不再改写 working message：无论是否在底部，都走默认文案。
test("compact 活动回合不改写 working message", async () => {
	const { events, messages, ctx } = install();
	const pushDelta = () =>
		events.get("message_update")?.(
			{ assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "abcd" } },
			ctx,
		);

	await events.get("turn_start")?.({}, ctx);
	await pushDelta();
	assert.match(messages.at(-1) ?? "", /^Working\.\.\. \(↓ \d+ tokens/, "保持默认文案");
});

// Pi 的 ctx 失效后 getter 会抛错；定时器里逃逸的异常会直接终止 Pi 进程 (#41)。
test("refresh timer stops quietly once the captured ctx goes stale", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const { events, messages } = install();
	let stale = false;
	let probes = 0;
	const ctx = {
		get hasUI() {
			probes++;
			if (stale)
				throw new Error("This extension ctx is stale after session replacement or reload.");
			return true;
		},
		get ui() {
			if (stale) throw new Error("stale");
			return { setWorkingMessage: (message?: string) => messages.push(message) };
		},
	};

	await events.get("turn_start")?.({}, ctx);
	stale = true;
	assert.doesNotThrow(() => t.mock.timers.tick(1_000));
	const probesAfterStale = probes;
	t.mock.timers.tick(5_000);
	assert.equal(probes, probesAfterStale, "loop must stop after the stale probe");

	// 失效窗口内到达的事件也不应抛错或重新拉起循环。
	await events.get("message_update")?.(
		{ assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "abcd" } },
		ctx,
	);
	await events.get("turn_start")?.({}, ctx);
	await events.get("session_shutdown")?.({}, ctx);
});
