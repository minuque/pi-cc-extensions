import { test } from "node:test";
import assert from "node:assert/strict";
import agentSummaryFeature, {
	AGENT_SUMMARY_ENTRY_TYPE,
} from "../extensions/feature/agent-summary/index.ts";
import {
	AgentRunSummary,
	bindAgentSummary,
	classifyTool,
	summaryLine,
	type AgentSummaryData,
} from "../extensions/feature/agent-summary/core.ts";

function stripAnsi(text: string): string {
	return text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
}

test("classifyTool：bash/read/edit/write/other", () => {
	assert.equal(classifyTool("bash"), "bash");
	assert.equal(classifyTool("powershell"), "bash");
	assert.equal(classifyTool("read"), "read");
	assert.equal(classifyTool("edit"), "edit");
	assert.equal(classifyTool("write"), "write");
	assert.equal(classifyTool("grep"), "other");
	// MCP 风格名不是精确工具名：归 other
	assert.equal(classifyTool("mcp__server__read"), "other");
});

test("AgentRunSummary：bash/powershell 计数；read/edit/write 按路径去重；other 计数", () => {
	const summary = new AgentRunSummary(1_000);
	summary.recordToolStart("bash", { command: "npm test" });
	summary.recordToolStart("powershell", { command: "Get-ChildItem" });
	summary.recordToolStart("bash", { command: "ls" });
	summary.recordToolStart("read", { path: "a.ts" });
	summary.recordToolStart("read", { path: "a.ts" }); // 去重
	summary.recordToolStart("read", { path: "b.ts" });
	summary.recordToolStart("edit", { file_path: "c.ts" }); // file_path 别名
	summary.recordToolStart("write", { path: "d.ts" });
	summary.recordToolStart("write", { path: "d.ts" }); // 去重
	summary.recordToolStart("grep", { pattern: "x" });
	summary.recordToolResult(true);
	summary.recordToolResult(false);

	assert.equal(summary.toolCount, 10);
	const data = summary.snapshot(61_000);
	assert.deepEqual(data, {
		toolCount: 10,
		commands: 3,
		reads: 2,
		edits: 1,
		writes: 1,
		others: 1,
		failed: 1,
		durationMs: 60_000,
		doneAt: 61_000,
	} satisfies AgentSummaryData);
});

test("summaryLine：单行拼接工具段与完成段", () => {
	const doneAt = new Date(2026, 9, 21, 18, 51).getTime();
	const data: AgentSummaryData = {
		toolCount: 7,
		commands: 3,
		reads: 2,
		edits: 1,
		writes: 1,
		others: 0,
		failed: 0,
		durationMs: 11_000,
		doneAt,
	};
	assert.equal(
		summaryLine(data),
		"✻ Ran 3 commands, read 2 files, edited 1 file, wrote 1 file · Completed for 11s · done 6:51 PM",
	);
	assert.equal(
		summaryLine({ ...data, failed: 2 }),
		"✻ Ran 3 commands, read 2 files, edited 1 file, wrote 1 file, 2 failed · Completed for 11s · done 6:51 PM",
	);
	// 工具不足 2 次：只保留完成段
	assert.equal(
		summaryLine({
			...data,
			toolCount: 1,
			commands: 1,
			reads: 0,
			edits: 0,
			writes: 0,
		}),
		"✻ Completed for 11s · done 6:51 PM",
	);
});

test("bindAgentSummary 事件绑定：agent_start 重置、agent_end 写出摘要", async () => {
	const handlers = new Map<string, Function>();
	const fakePi = {
		on: (event: string, handler: Function) => handlers.set(event, handler),
	} as any;

	const calls: AgentSummaryData[] = [];
	bindAgentSummary(fakePi, (data) => calls.push(data));

	await handlers.get("agent_start")!();
	await handlers.get("tool_execution_start")!({ toolName: "read", args: { path: "a.ts" } });
	await handlers.get("tool_execution_end")!({ isError: false });
	await handlers.get("agent_end")!();
	assert.equal(calls.length, 1);
	assert.equal(calls[0].toolCount, 1);
	assert.match(summaryLine(calls[0]), /^✻ Completed for /);

	await handlers.get("agent_start")!();
	await handlers.get("tool_execution_start")!({ toolName: "bash", args: { command: "ls" } });
	await handlers.get("tool_execution_end")!({ isError: true });
	await handlers.get("tool_execution_start")!({ toolName: "grep", args: {} });
	await handlers.get("tool_execution_end")!({ isError: false });
	await handlers.get("agent_end")!();
	assert.equal(calls.length, 2);
	assert.deepEqual(calls[1], {
		toolCount: 2,
		commands: 1,
		reads: 0,
		edits: 0,
		writes: 0,
		others: 1,
		failed: 1,
		durationMs: calls[1].durationMs,
		doneAt: calls[1].doneAt,
	});
});

test("agent-summary 注册 renderer，输出单行摘要", async () => {
	const renderers = new Map<string, Function>();
	const appended: unknown[] = [];
	const events = new Map<string, Function>();
	const fakePi = {
		on: (event: string, handler: Function) => events.set(event, handler),
		registerEntryRenderer: (type: string, renderer: Function) => renderers.set(type, renderer),
		appendEntry: (type: string, data: unknown) => appended.push({ type, data }),
	} as any;

	agentSummaryFeature(fakePi);
	assert.ok(renderers.has(AGENT_SUMMARY_ENTRY_TYPE));

	await events.get("agent_start")!();
	await events.get("tool_execution_start")!({ toolName: "read", args: { path: "a.ts" } });
	await events.get("tool_execution_end")!({ isError: false });
	await events.get("tool_execution_start")!({ toolName: "bash", args: { command: "ls" } });
	await events.get("tool_execution_end")!({ isError: false });
	await events.get("agent_end")!();

	assert.equal(appended.length, 1);
	const renderer = renderers.get(AGENT_SUMMARY_ENTRY_TYPE)!;
	const theme = { fg: (_color: string, text: string) => text };
	const component = renderer({ data: (appended[0] as any).data }, { expanded: false }, theme);
	const plain = stripAnsi((component as any).render(160).map(String).join("\n")).trim();
	assert.match(plain, /^✻ Ran 1 command, read 1 file · Completed for \d+s · done /);
	assert.doesNotMatch(plain, />/);
	assert.doesNotMatch(plain, /[┌├└]/);
	assert.doesNotMatch(plain, /TIP/);

	// 工具不足 2 次：只有完成段
	const completionOnly = renderer(
		{
			data: {
				toolCount: 0,
				commands: 0,
				reads: 0,
				edits: 0,
				writes: 0,
				others: 0,
				failed: 0,
				durationMs: 0,
				doneAt: Date.now(),
			},
		},
		{ expanded: false },
		theme,
	);
	const completionPlain = stripAnsi(
		(completionOnly as any).render(160).map(String).join("\n"),
	).trim();
	assert.match(completionPlain, /^✻ Completed for 0s · done /);
	assert.doesNotMatch(completionPlain, /Ran/);
});
