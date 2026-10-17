/**
 * on ↔ compact 模式切换重塑。
 * 不依赖 /reload：切换后 transcript 必须立即对齐目标 mode 的文档样式。
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
	AssistantMessageComponent,
	ToolExecutionComponent,
	initTheme,
} from "@earendil-works/pi-coding-agent";

import { config } from "../extensions/config/config.ts";
import {
	installCompactMode,
	refreshCompactModeComponents,
} from "../extensions/renderer/compact-mode.ts";
import { WriteExecutionMetadataStore } from "../extensions/renderer/tool/diff/write-execution.ts";

initTheme("dark");

const ui = {
	theme: {
		fg: (_c: string, t: string) => t,
		bold: (t: string) => t,
		italic: (t: string) => t,
	},
	requestRender() {},
	getToolsExpanded: () => false,
} as any;

const strip = (s: string) =>
	s
		.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
		.replace(/\x1b\][^\x07]*\x07/g, "")
		.trim();

const renderText = (c: any, width = 120): string[] =>
	c
		.render(width)
		.map((line: string) => strip(line))
		.filter(Boolean);

function tool(name: string, id: string, args: any = {}) {
	return new ToolExecutionComponent(name, id, args, {}, undefined, ui, process.cwd()) as any;
}

function toolCallMsg(timestamp: number, tools: Array<{ id: string; name: string; args?: any }>) {
	return {
		role: "assistant",
		timestamp,
		content: tools.map((t) => ({
			type: "toolCall",
			id: t.id,
			name: t.name,
			arguments: t.args ?? {},
		})),
	} as unknown as AssistantMessage;
}

function textMsg(timestamp: number, text: string) {
	return {
		role: "assistant",
		timestamp,
		content: [{ type: "text", text }],
	} as unknown as AssistantMessage;
}

/** applyStyleMode 同款：collect → sync/refresh。emptyRoot 模拟面板扫空。 */
function switchMode(
	mode: "on" | "compact",
	hooks: ReturnType<typeof installCompactMode>,
	root: any,
	opts: { emptyRoot?: boolean } = {},
) {
	config.mode = mode;
	refreshCompactModeComponents(opts.emptyRoot ? { children: [] } : root);
	if (mode === "compact") hooks.sync({ ui });
	refreshCompactModeComponents(opts.emptyRoot ? { children: [] } : root);
	hooks.refresh();
}

// ─── live on ↔ compact ───────────────────────────────────────────────

test("on → compact reshapes to summary; compact → on restores tool cards", (t) => {
	// This assertion exercises summary-only diffs, not the default collapsed body preview.
	const previousCollapsedLines = config.editDiffCollapsedLines;
	config.editDiffCollapsedLines = 0;
	t.after(() => {
		config.editDiffCollapsedLines = previousCollapsedLines;
	});
	const previous = config.mode;
	config.mode = "on";
	const hooks = installCompactMode({
		query: {
			getMessageThinkingDurationMs: (ts) => (ts === 1 ? 9000 : undefined),
			isMessageThinkingActive: () => false,
		},
		writeMetadata: new WriteExecutionMetadataStore(),
	});
	try {
		const msg = toolCallMsg(1, [
			{ id: "b1", name: "bash", args: { command: "echo" } },
			{ id: "r1", name: "read", args: { path: "a.ts" } },
			{ id: "r2", name: "read", args: { path: "b.ts" } },
			{ id: "g1", name: "grep", args: { pattern: "x" } },
		]);
		const final = textMsg(2, "task done");
		const a1 = new AssistantMessageComponent(msg, true) as any;
		const aFinal = new AssistantMessageComponent(final, true) as any;
		a1.updateContent(msg);
		aFinal.updateContent(final);

		const bash = tool("bash", "b1", { command: "echo" });
		bash.updateResult({ content: [{ type: "text", text: "ok" }], isError: false });
		const edit = tool("edit", "e1", { path: "sample.ts" });
		edit.updateResult({
			content: [],
			details: {
				diff: "diff --git a/sample.ts b/sample.ts\nindex 1..2 100644\n--- a/sample.ts\n+++ b/sample.ts\n@@ -1 +1 @@\n-const x = 1\n+const x = 2\n",
			},
			isError: false,
		});

		const root = { children: [a1, aFinal, bash, edit] };

		// on：工具卡可见，无 compact 摘要
		assert.ok(renderText(bash).length > 0);
		assert.ok(!renderText(a1).some((l) => /Ran for .*bash×/.test(l)));

		// → compact：对齐 docs compact
		switchMode("compact", hooks, root);
		assert.match(renderText(a1).join("\n"), /^Ran for 9s, bash×1, read×2, grep×1/);
		assert.match(renderText(a1).join("\n"), /click to show more/);
		assert.deepEqual(renderText(bash), []);
		assert.doesNotMatch(renderText(edit).join("\n"), /edit sample\.ts \(\+\d+ -\d+\)/);
		assert.match(renderText(edit).join("\n"), /↳ diff \+1 -1 · .*to show more/);
		assert.match(renderText(aFinal).join("\n"), /task done/);

		// → on：工具卡恢复，摘要消失
		switchMode("on", hooks, root);
		assert.ok(renderText(bash).length > 0);
		assert.ok(!renderText(a1).some((l) => /Ran for 9s, bash×1/.test(l)));

		// → compact 再来一轮（所有权不得因 on 释放而丢）
		switchMode("compact", hooks, root);
		assert.match(renderText(a1).join("\n"), /^Ran for 9s, bash×1, read×2, grep×1/);
		assert.deepEqual(renderText(bash), []);
	} finally {
		config.mode = previous;
		hooks.shutdown();
	}
});

test("panel empty-root scan keeps live tracking (no /reload required)", () => {
	const previous = config.mode;
	config.mode = "on";
	const hooks = installCompactMode({
		query: {
			getMessageThinkingDurationMs: () => 4000,
			isMessageThinkingActive: () => false,
		},
		writeMetadata: new WriteExecutionMetadataStore(),
	});
	try {
		const msg = toolCallMsg(1, [{ id: "b1", name: "bash", args: { command: "x" } }]);
		const a1 = new AssistantMessageComponent(msg, true) as any;
		a1.updateContent(msg);
		const bash = tool("bash", "b1", { command: "x" });
		bash.updateResult({ content: [{ type: "text", text: "ok" }], isError: false });

		// live 跟踪已建立；切换时 root 扫空（面板/custom UI）
		config.mode = "compact";
		refreshCompactModeComponents({ children: [] });
		hooks.sync({ ui });
		hooks.refresh();

		// 无最终文本时 round 仍 active → Running...；关键是计数与工具隐藏仍在。
		assert.match(renderText(a1).join("\n"), /4s, bash×1/);
		assert.deepEqual(renderText(bash), []);
	} finally {
		config.mode = previous;
		hooks.shutdown();
	}
});

test("round accumulation survives on → compact switch", () => {
	const previous = config.mode;
	config.mode = "on";
	const hooks = installCompactMode({
		query: {
			getMessageThinkingDurationMs: (ts) => ({ 1: 400, 2: 500, 3: 600 })[ts],
			isMessageThinkingActive: () => false,
		},
		writeMetadata: new WriteExecutionMetadataStore(),
	});
	try {
		const m1 = toolCallMsg(1, [{ id: "b1", name: "bash", args: { command: "one" } }]);
		const m2 = toolCallMsg(2, [{ id: "f1", name: "fffind", args: { pattern: "x" } }]);
		const m3 = toolCallMsg(3, [
			{ id: "r1", name: "read", args: { path: "a.ts" } },
			{ id: "r2", name: "read", args: { path: "a.ts" } },
			{ id: "b2", name: "bash", args: { command: "two" } },
		]);
		const a1 = new AssistantMessageComponent(m1, true) as any;
		const a2 = new AssistantMessageComponent(m2, true) as any;
		const a3 = new AssistantMessageComponent(m3, true) as any;
		a1.updateContent(m1);
		a2.updateContent(m2);
		a3.updateContent(m3);
		const root = { children: [a1, a2, a3] };

		switchMode("compact", hooks, root);
		assert.match(renderText(a1).join("\n"), /2s, bash×2, fffind×1, read×1/);
		assert.deepEqual(renderText(a2), []);
		assert.deepEqual(renderText(a3), []);
	} finally {
		config.mode = previous;
		hooks.shutdown();
	}
});

test("messages created while mode=on stay tracked for later compact switch", () => {
	const previous = config.mode;
	config.mode = "on";
	const hooks = installCompactMode({
		query: {
			getMessageThinkingDurationMs: () => 1000,
			isMessageThinkingActive: () => false,
		},
		writeMetadata: new WriteExecutionMetadataStore(),
	});
	try {
		// 先 refresh 一次（旧逻辑会在 on 下释放所有权；现应保持补丁）
		hooks.refresh();

		const msg = toolCallMsg(10, [{ id: "g1", name: "grep", args: { pattern: "z" } }]);
		const a1 = new AssistantMessageComponent(msg, true) as any;
		a1.updateContent(msg);
		const grep = tool("grep", "g1", { pattern: "z" });
		grep.updateResult({ content: [{ type: "text", text: "hit" }], isError: false });

		assert.ok(renderText(grep).length > 0);
		assert.ok(!renderText(a1).some((l) => /grep×1/.test(l)));

		// 不依赖树扫描：仅靠 live tracked
		config.mode = "compact";
		hooks.sync({ ui });
		hooks.refresh();

		assert.match(renderText(a1).join("\n"), /1s, grep×1/);
		assert.deepEqual(renderText(grep), []);
	} finally {
		config.mode = previous;
		hooks.shutdown();
	}
});
