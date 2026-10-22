import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
	AssistantMessageComponent,
	CustomMessageComponent,
	ToolExecutionComponent,
	UserMessageComponent,
	createBashToolDefinition,
	createEditToolDefinition,
	createGrepToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
	initTheme,
} from "@earendil-works/pi-coding-agent";
import { Container, visibleWidth } from "@earendil-works/pi-tui";

import { config, formatConfigStatus, normalizeConfig } from "../extensions/config/config.ts";
import { installCompactThinking } from "../extensions/feature/compact-thinking.ts";
import { installDefaultMode } from "../extensions/renderer/default-mode.ts";
import {
	buildMessageSummary,
	installCompactMode,
	isCompactAssistantComponent,
	markCompactRoundToolExpanded,
	refreshCompactModeComponents,
	setHoveredCompactAssistant,
	stripSlotHint,
	styleCompactThinkingText,
} from "../extensions/renderer/compact-mode.ts";
import { componentAtLocalRow } from "../extensions/renderer/mouse/layout.ts";
import { setHoveredToolCallId } from "../extensions/renderer/mouse/hover.ts";
import { setToolMouseTui } from "../extensions/renderer/mouse/scroll.ts";
import { refreshMountedTranscript } from "../extensions/renderer/transcript-refresh.ts";
import claudeCodeStyleExtension from "../extensions/renderer/index.ts";
import {
	getMessageDisplayTheme,
	setMessageDisplayTheme,
} from "../extensions/renderer/tool/message-display.ts";
import { WriteExecutionMetadataStore } from "../extensions/renderer/tool/diff/write-execution.ts";
import { invalidateIoView, isExpandedToolIoView } from "../extensions/renderer/tool/tool-io.ts";
import { renderToolSummary, toolCallSummary } from "../extensions/renderer/tool/names.ts";

initTheme("dark");

const ui = {
	theme: { fg: (_color: string, text: string) => text, bold: (text: string) => text },
	requestRender() {},
} as any;

/**
 * 内置工具定义按名字构造。pi 0.99 起内置 renderer 由调用方合并（以前 ToolExecutionComponent
 * 自己查表），这里跟 CLI 的 getRegisteredToolDefinition 保持一致；非内置工具只给名字。
 */
const BUILT_IN_TOOL_DEFINITIONS: Record<string, (cwd: string) => any> = {
	bash: createBashToolDefinition,
	edit: createEditToolDefinition,
	grep: createGrepToolDefinition,
	read: createReadToolDefinition,
	write: createWriteToolDefinition,
};

function tool(name: string, id: string, args: any = {}) {
	const cwd = process.cwd();
	const definition = BUILT_IN_TOOL_DEFINITIONS[name]?.(cwd) ?? { name };
	return new ToolExecutionComponent(name, id, args, {}, definition, ui, cwd) as any;
}

const renderText = (component: any, width = 120): string[] =>
	component
		.render(width)
		.map((line: string) =>
			line
				.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
				.replace(/\x1b\][^\x07]*\x07/g, "")
				.trim(),
		)
		.filter((line: string) => line);

/** 扩展运行时样板：pi mock + tui ctx + 事件 emit。 */
function extensionRuntime() {
	const events = new Map<string, Function[]>();
	const pi: any = {
		registerCommand() {},
		registerTool() {},
		appendEntry() {},
		on(name: string, handler: Function) {
			const list = events.get(name) ?? [];
			list.push(handler);
			events.set(name, list);
		},
	};
	const ctx = {
		mode: "tui",
		hasUI: true,
		sessionManager: { getBranch: () => [], getEntries: () => [] },
		ui: {
			theme: {
				fg: (_color: string, text: string) => text,
				italic: (text: string) => text,
				bold: (text: string) => text,
			},
			setStatus() {},
			requestRender() {},
			setWidget() {},
		},
	};
	return {
		pi,
		ctx,
		emit: async (name: string, event: any, context: any = ctx) => {
			for (const handler of events.get(name) ?? []) await handler(event, context);
		},
	};
}

/** 安装 compact 补丁并把全局 mode 设为 compact；restore 恢复原模式并卸载。 */
function installHooks() {
	const previousMode = config.mode;
	config.mode = "compact";
	const hooks = installCompactMode({ writeMetadata: new WriteExecutionMetadataStore() });
	return {
		hooks,
		restore() {
			config.mode = previousMode;
			hooks.shutdown();
		},
	};
}

function toolCallMessage(timestamp: number, name = "bash") {
	return {
		role: "assistant",
		timestamp,
		content: [{ type: "toolCall", name, arguments: { command: "echo" } }],
	} as unknown as AssistantMessage;
}
/** 等过回合收尾的静默期（FOLD_SETTLE_MS = 250ms）。 */
const settleFold = () => new Promise((resolve) => setTimeout(resolve, 350));

test("buildMessageSummary: duration first, read dedup by path, counts, first-seen order, edit/write excluded", () => {
	const query = {
		getMessageThinkingDurationMs: (timestamp: number) => (timestamp === 1 ? 8500 : undefined),
	};
	const message = {
		timestamp: 1,
		content: [
			{ type: "toolCall", id: "r1", name: "read", arguments: { path: "a.ts" } },
			{ type: "toolCall", id: "r2", name: "read", arguments: { path: "a.ts" } },
			{ type: "toolCall", id: "r3", name: "read", arguments: { path: "b.ts" } },
			{ type: "toolCall", id: "b1", name: "bash", arguments: { command: "echo" } },
			{ type: "toolCall", id: "e1", name: "edit", arguments: {} },
			{ type: "toolCall", id: "w1", name: "write", arguments: {} },
			{ type: "toolCall", id: "g1", name: "grep", arguments: { pattern: "x" } },
		],
	};
	assert.equal(buildMessageSummary(message, query), "Ran for 9s, read×2, bash×1, grep×1");
	assert.equal(
		buildMessageSummary(message, {
			getMessageThinkingDurationMs: () => 8500,
			isMessageThinkingActive: () => true,
		}),
		"Running... · 9s, read×2, bash×1, grep×1",
	);
	// 显式挂钟覆盖 thinking query
	assert.equal(buildMessageSummary(message, query, 15_000), "Ran for 15s, read×2, bash×1, grep×1");
	// 新 message 独立：计数不跨消息累积；无时长无工具时为空串。
	assert.equal(buildMessageSummary({ timestamp: 2, content: [] }, query), "");
	assert.equal(
		buildMessageSummary(
			{ timestamp: 3, content: [] },
			{ getMessageThinkingDurationMs: () => undefined },
		),
		"",
	);
	assert.equal(
		buildMessageSummary(
			{ timestamp: 3, content: [{ type: "toolCall", name: "bash", arguments: {} }] },
			query,
		),
		"bash×1",
	);
	// read 空路径不按路径去重（计入计数）。
	assert.equal(
		buildMessageSummary(
			{ timestamp: 4, content: [{ type: "toolCall", name: "read", arguments: {} }] },
			query,
		),
		"read×1",
	);
	assert.doesNotMatch(
		buildMessageSummary(
			{ timestamp: 5, content: [{ type: "toolCall", name: "bad\x1b]8;;https://x\x07tool" }] },
			query,
		),
		/[\x1b\x07]/,
	);
});

test("config normalize keeps compact, defaults to on, command completions order on,compact,off", () => {
	assert.equal(normalizeConfig({ mode: "compact" }).mode, "compact");
	assert.equal(normalizeConfig({}).mode, "on");
	assert.equal(normalizeConfig({ mode: "invalid" }).mode, "on");
	assert.equal(normalizeConfig({}).enableMarkdownEnhance, true);
	assert.equal(normalizeConfig({ enableMarkdownEnhance: false }).enableMarkdownEnhance, false);
	assert.match(formatConfigStatus(normalizeConfig({})), /markdownEnhance=on/);
	assert.equal(normalizeConfig({}).writeDiffCollapsedLines, 0);
	assert.equal(normalizeConfig({ writeDiffCollapsedLines: 0 }).writeDiffCollapsedLines, 0);
	assert.equal(normalizeConfig({}).toolLabelClip, 0);
	assert.equal(normalizeConfig({ toolLabelClip: 40 }).toolLabelClip, 40);
	assert.equal(normalizeConfig({ toolLabelClip: "0" }).toolLabelClip, 0);
	assert.equal(normalizeConfig({ toolLabelClip: 3 }).toolLabelClip, 8);
	assert.equal(normalizeConfig({ toolLabelClip: 9999 }).toolLabelClip, 500);
	// 旧配置键 inputClip 自动迁移
	assert.equal(normalizeConfig({ inputClip: 60 }).toolLabelClip, 60);
	assert.match(formatConfigStatus(normalizeConfig({})), /toolLabelClip=0/);
	assert.equal(normalizeConfig({}).expandedInputMaxLines, 5);
	assert.equal(normalizeConfig({}).expandedOutputMaxLines, 10);
	assert.equal(normalizeConfig({ expandedInputMaxLines: 20 }).expandedInputMaxLines, 20);
	assert.equal(normalizeConfig({ expandedOutputMaxLines: 40 }).expandedOutputMaxLines, 40);
	assert.match(formatConfigStatus(normalizeConfig({})), /expandedInput=5/);
	assert.match(formatConfigStatus(normalizeConfig({})), /expandedOutput=10/);

	let completions: Array<{ value: string }> = [];
	const pi: any = {
		registerCommand(name: string, options: any) {
			if (name === "ccstyle") completions = options.getArgumentCompletions("");
		},
		registerTool() {},
		on() {},
	};
	const previousMode = config.mode;
	try {
		claudeCodeStyleExtension(pi, { mode: "on" });
		assert.deepEqual(
			completions.map((item) => item.value),
			["on", "compact", "off", "status", "panel"],
		);
	} finally {
		config.mode = previousMode;
	}
});

test("tool path summaries relativize cwd paths and preserve filenames when clipped", () => {
	const previous = config.toolLabelClip;
	const args = {
		path: join(
			process.cwd(),
			"extensions",
			"very-long-feature-name",
			"nested-renderer-implementation",
			"target-file.ts",
		),
	};
	const original = { ...args };
	try {
		config.toolLabelClip = 40;
		const plain = (_color: string, text: string) => text;
		for (const variant of ["default", "grouping"] as const) {
			const summary = toolCallSummary("read", args, { variant, cwd: process.cwd() });
			assert.equal(summary.main, "Read", "路径值移出 main，交给渲染层按宽度截断");
			const line = renderToolSummary(summary, 100, plain);
			assert.match(line, /^Read extensions/);
			assert.match(line, /…[\\/]target-file\.ts$/);
			assert.doesNotMatch(line, new RegExp(process.cwd().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
		}
		config.toolLabelClip = 200;
		const outside = join(process.cwd(), "..", "outside-project", "target-file.ts");
		assert.equal(
			toolCallSummary("write", { path: outside }, { cwd: process.cwd() }).path?.value,
			outside,
			"cwd 外绝对路径保持绝对形式",
		);
		assert.deepEqual(args, original, "display formatting does not mutate tool arguments");
	} finally {
		config.toolLabelClip = previous;
	}
});

test("thinking 正文固定走 dim，不改主题", () => {
	const theme = { fg: (color: string, text: string) => `<${color}>${text}` };
	assert.equal(styleCompactThinkingText("hi", theme as any), "<dim>hi");
});

test("摘要行整行走 dim", () => {
	const previousTheme = getMessageDisplayTheme();
	const previousMode = config.mode;
	setMessageDisplayTheme({
		fg: (color: string, text: string) => `<${color}>${text}`,
	} as any);
	config.mode = "compact";
	const hooks = installCompactMode({ writeMetadata: new WriteExecutionMetadataStore() });
	try {
		const msg = toolCallMessage(1);
		const assistant = new AssistantMessageComponent(msg, true) as any;
		assistant.updateContent(msg);
		const rendered = assistant.render(200).join("\n");
		assert.ok(rendered.includes("<dim>, bash×1"), `工具计数走 dim: ${rendered}`);
		assert.ok(!rendered.includes("<muted>"), `整行不该再有 muted: ${rendered}`);
	} finally {
		hooks.shutdown();
		config.mode = previousMode;
		setMessageDisplayTheme(previousTheme);
	}
});

test("摘要行 hover 只高亮展开文字，圆点保持 dim", () => {
	const previousTheme = getMessageDisplayTheme();
	const previousMode = config.mode;
	setMessageDisplayTheme({
		fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
	} as any);
	config.mode = "compact";
	const hooks = installCompactMode({ writeMetadata: new WriteExecutionMetadataStore() });
	try {
		const msg = toolCallMessage(1);
		const assistant = new AssistantMessageComponent(msg, true) as any;
		assistant.updateContent(msg);
		const summaryLine = () => {
			assistant.invalidate?.();
			return assistant.render(200).find((line: string) => line.includes("click to show more"));
		};
		assert.match(summaryLine() ?? "", /<dim> · <\/dim><dim>click to show more<\/dim>/);
		setHoveredCompactAssistant(assistant);
		assert.match(summaryLine() ?? "", /<dim> · <\/dim><text>click to show more<\/text>/);
	} finally {
		setHoveredCompactAssistant(null);
		hooks.shutdown();
		config.mode = previousMode;
		setMessageDisplayTheme(previousTheme);
	}
});

test("compact collapses tool-calling assistant to one line; native render outside compact", () => {
	const { restore } = installHooks();
	try {
		const msg = toolCallMessage(1);
		const assistant = new AssistantMessageComponent(msg, true) as any;
		assistant.updateContent(msg);
		const collapsed = renderText(assistant);
		assert.equal(collapsed.length, 1, "tool-calling assistant collapses to a single line");
		assert.match(collapsed[0], /^Running\.\.\.(?: · \d+ms)?, bash×1/);
		assert.match(collapsed[0], /click to show more/);
		const narrow = assistant.render(30);
		assert.equal(narrow[0], "", "compact summary keeps one leading blank row");
		assert.equal(
			narrow.filter((line: string) => line.trim()).length,
			1,
			"compact summary never wraps",
		);
		assert.ok(narrow.every((line: string) => visibleWidth(line) <= 30));

		// 普通工具折叠时不显示独立行（摘要行已统计）。
		const read = tool("read", "r1", { path: "a.ts" });
		read.updateResult({ content: [{ type: "text", text: "ok" }], isError: false });
		assert.deepEqual(renderText(read), []);

		// 无 toolCall 的 final assistant 走原生渲染。
		const finalMessage = {
			role: "assistant",
			content: [{ type: "text", text: "task done" }],
		} as unknown as AssistantMessage;
		const final = new AssistantMessageComponent(finalMessage, true) as any;
		final.updateContent(finalMessage);
		assert.match(renderText(final).join("\n"), /task done/);

		// 切 on：assistant 与 tool 都走原生。
		config.mode = "on";
		assistant.updateContent(msg);
		assert.ok(!renderText(assistant).some((line) => /Running\.\.\., bash×1/.test(line)));
		assert.ok(renderText(read).length > 0, "tool renders natively in on mode");

		// 切 off：同样原生。
		config.mode = "off";
		assistant.updateContent(msg);
		assert.ok(!renderText(assistant).some((line) => /Running\.\.\., bash×1/.test(line)));
		assert.ok(renderText(read).length > 0, "tool renders natively in off mode");
	} finally {
		restore();
	}
});

test("compact 折叠摘要不挂分组折叠树，普通工具只进计数", () => {
	const { restore } = installHooks();
	try {
		const message = {
			role: "assistant",
			timestamp: 1,
			content: [
				{ type: "toolCall", id: "b1", name: "bash", arguments: { command: "npm test" } },
				{ type: "toolCall", id: "b2", name: "bash", arguments: { command: "ls src" } },
				{ type: "toolCall", id: "e1", name: "edit", arguments: { path: "a.ts" } },
				{ type: "toolCall", id: "r1", name: "read", arguments: { path: "a.ts" } },
				{ type: "toolCall", id: "b3", name: "bash", arguments: { command: "echo done" } },
			],
		} as unknown as AssistantMessage;
		const tools = [
			tool("bash", "b1", { command: "npm test" }),
			tool("bash", "b2", { command: "ls src" }),
			tool("read", "r1", { path: "a.ts" }),
			tool("bash", "b3", { command: "echo done" }),
		];
		for (const item of tools) {
			item.executionStarted = true;
			item.updateDisplay?.();
			item.updateResult({ content: [{ type: "text", text: "ok" }], isError: false });
		}
		const assistant = new AssistantMessageComponent(message, true) as any;
		assistant.updateContent(message);
		const lines = renderText(assistant);
		const summary = lines.find((line) => /bash×3/.test(line));
		assert.ok(summary, `摘要应计数普通工具: ${lines}`);
		assert.doesNotMatch(summary ?? "", /edit/, `edit 不进摘要: ${summary}`);
		assert.ok(
			!lines.some((line) => /[●├└]/.test(line) || /Bash:|Multiple Tools/.test(line)),
			`折叠摘要下不应出现分组树: ${lines}`,
		);
	} finally {
		restore();
	}
});

test("consecutive tool-call messages accumulate into one round until the next visible assistant text", () => {
	const previousMode = config.mode;
	const previousTheme = getMessageDisplayTheme();
	config.mode = "compact";
	const durations = new Map([
		[1, 400],
		[2, 500],
		[3, 600],
		[4, 3000],
	]);
	let activeTimestamp: number | undefined;
	let animationFrame = 0;
	const hooks = installCompactMode({
		query: {
			getMessageThinkingDurationMs: (timestamp) => durations.get(timestamp),
			isMessageThinkingActive: (timestamp) => timestamp === activeTimestamp,
			getThinkingAnimationFrame: () => animationFrame,
		},
		writeMetadata: new WriteExecutionMetadataStore(),
	});
	try {
		const message1 = {
			role: "assistant",
			timestamp: 1,
			content: [
				{ type: "thinking", thinking: "first" },
				{ type: "toolCall", id: "b1", name: "bash", arguments: { command: "one" } },
			],
		};
		const message2 = {
			role: "assistant",
			timestamp: 2,
			content: [
				{ type: "thinking", thinking: "second" },
				{ type: "toolCall", id: "f1", name: "fffind", arguments: { pattern: "x" } },
			],
		};
		const message3 = {
			role: "assistant",
			timestamp: 3,
			content: [
				{ type: "thinking", thinking: "third" },
				{ type: "toolCall", id: "r1", name: "read", arguments: { path: "a.ts" } },
				{ type: "toolCall", id: "r2", name: "read", arguments: { path: "a.ts" } },
				{ type: "toolCall", id: "b2", name: "bash", arguments: { command: "two" } },
			],
		};
		const assistant1 = new AssistantMessageComponent(message1 as any, true) as any;
		assistant1.updateContent(message1);
		activeTimestamp = 2;
		const message2Thinking = {
			role: "assistant",
			timestamp: 2,
			content: [{ type: "thinking", thinking: "second" }],
		};
		const assistant2 = new AssistantMessageComponent(message2Thinking as any, true) as any;
		assistant2.updateContent(message2Thinking as any);
		assert.match(renderText(assistant1).join("\n"), /^Running\.\.\. · 900ms, bash×1/);
		assert.doesNotMatch(renderText(assistant1).join("\n"), /Ran for/);
		animationFrame = 1;
		assert.match(renderText(assistant1).join("\n"), /^Running\.\.\. · 900ms, bash×1/);

		activeTimestamp = undefined;
		assistant2.updateContent(message2);
		const assistant3 = new AssistantMessageComponent(message3 as any, true) as any;
		assistant3.updateContent(message3);

		assert.deepEqual(renderText(assistant2), []);
		assert.deepEqual(renderText(assistant3), []);
		assert.match(
			renderText(assistant1).join("\n"),
			/^Running\.\.\. · 2s, bash×2, fffind×1, read×1/,
		);

		// 消息先到、组件后到：pi 的 message_update 就是这个顺序。
		// 组件一 updateDisplay 就进 live 槽位，槽位接管期间强制折叠，不能再单独展开。
		const bash = tool("bash", "b1", { command: "one" });
		const longOutput = Array.from({ length: 500 }, (_, index) => `tool output ${index}`).join("\n");
		bash.updateResult({ content: [{ type: "text", text: longOutput }], isError: false });
		const afterTool = renderText(assistant1);
		assert.ok(
			afterTool.some((line) => line.includes("↳") && line.includes("$ one")),
			`组件后到应补进槽位: ${afterTool.join(" | ")}`,
		);
		bash.setExpanded(true);
		assert.equal(bash.expanded, false, "live 槽位接管的工具不能单独展开");
		const edit = tool("edit", "e1", { path: "a.ts" });
		edit.updateResult({ content: [], isError: false });
		const backgroundSlots: string[] = [];
		const cardTheme = Object.assign(Object.create(previousTheme ?? null), {
			fg: previousTheme?.fg ?? ((_color: string, text: string) => text),
			bg(slot: string, text: string) {
				backgroundSlots.push(slot);
				return text;
			},
		});
		setMessageDisplayTheme(cardTheme);
		assistant1.setExpanded(true);
		assert.equal(bash.expanded, false, "round children default to collapsed");
		bash.setExpanded(true);
		assert.equal(bash.expanded, false, "global expansion cannot recursively expand round children");
		assert.equal(edit.expanded, false, "edit/write keep independent expansion state");
		const cardLines = assistant1.render(80);
		assert.match(renderText(assistant1).join("\n"), /495 earlier lines/);
		assert.ok(cardLines.length < 30, "collapsed children cap long output inside the round card");
		assert.equal(cardLines[0]?.trim(), "", "expanded round keeps a leading blank row");
		assert.ok(
			cardLines.every((line: string) => line === "" || visibleWidth(line) === 80),
			"expanded round is wrapped by one width-safe tool card",
		);
		// 回合里的工具都已成功：整张展开卡用成功底色（与 default 分组卡同口径）。
		assert.deepEqual([...new Set(backgroundSlots)], ["toolSuccessBg"]);
		setMessageDisplayTheme(previousTheme);
		assert.deepEqual(renderText(bash), [], "round tools render only inside the summary card");
		assistant1.setExpanded(false);
		assert.equal(bash.expanded, false, "collapsing the round keeps its children collapsed");

		const finalMessage = {
			role: "assistant",
			timestamp: 4,
			content: [
				{ type: "thinking", thinking: "final thought" },
				{ type: "text", text: "final answer" },
			],
		};
		activeTimestamp = 4;
		const finalThinking = {
			role: "assistant",
			timestamp: 4,
			content: [{ type: "thinking", thinking: "final thought" }],
		};
		const final = new AssistantMessageComponent(finalThinking as any, true) as any;
		final.updateContent(finalThinking as any);
		assert.match(renderText(assistant1).join("\n"), /^Running\.\.\. · 5s, bash×2/);

		activeTimestamp = undefined;
		final.updateContent(finalMessage);
		assert.match(renderText(assistant1).join("\n"), /^Ran for 5s, bash×2/);
		assert.match(renderText(final).join("\n"), /final answer/);
		assert.doesNotMatch(renderText(final).join("\n"), /Thought|final thought/);

		const nextMessage = {
			role: "assistant",
			timestamp: 5,
			content: [
				{ type: "text", text: "next round" },
				{ type: "toolCall", id: "g1", name: "grep", arguments: { pattern: "x" } },
			],
		};
		const next = new AssistantMessageComponent(nextMessage as any, true) as any;
		next.updateContent(nextMessage);
		const nextLines = renderText(next).join("\n");
		assert.match(nextLines, /next round/);
		assert.match(nextLines, /Running\.\.\.(?: · \d+ms)?, grep×1/);
		assert.doesNotMatch(nextLines, /bash×2/);
		assert.match(renderText(assistant1).join("\n"), /^Ran for 5s, bash×2/);
	} finally {
		setMessageDisplayTheme(previousTheme);
		config.mode = previousMode;
		hooks.shutdown();
	}
});

test("expanded round panel repaints when the card background slot changes", () => {
	const previousMode = config.mode;
	const previousTheme = getMessageDisplayTheme();
	config.mode = "compact";
	// 面板按 patch.toolOriginalRender 取子卡行，且按数组引用判缓存命中。
	// 装补丁前把原生 render 换成固定引用，模拟真实子卡 paint 复用的情形。
	const prototype = ToolExecutionComponent.prototype as any;
	const nativeRender = prototype.render;
	const stablePaints = new WeakMap<object, string[]>();
	prototype.render = function (this: any) {
		let paints = stablePaints.get(this);
		if (!paints) {
			paints = [` ✓ ${this.toolName} done`];
			stablePaints.set(this, paints);
		}
		return paints;
	};
	const hooks = installCompactMode({ writeMetadata: new WriteExecutionMetadataStore() });
	try {
		const message = {
			role: "assistant",
			timestamp: 1,
			content: [
				{ type: "toolCall", id: "b1", name: "bash", arguments: { command: "one" } },
				{ type: "toolCall", id: "b2", name: "bash", arguments: { command: "two" } },
			],
		};
		const output = { content: [{ type: "text", text: "line one\nline two" }], isError: false };
		const first = tool("bash", "b1", { command: "one" });
		const second = tool("bash", "b2", { command: "two" });
		first.updateResult(output);
		second.updateResult(output);
		const anchor = new AssistantMessageComponent(message as any, true) as any;
		anchor.updateContent(message);
		anchor.setExpanded(true);

		const backgroundSlots: string[] = [];
		setMessageDisplayTheme(
			Object.assign(Object.create(previousTheme ?? null), {
				fg: previousTheme?.fg ?? ((_color: string, text: string) => text),
				bg(slot: string, text: string) {
					backgroundSlots.push(slot);
					return text;
				},
			}),
		);
		anchor.render(120);
		assert.ok(
			backgroundSlots.includes("toolSuccessBg"),
			"settled round panel uses the success background",
		);

		backgroundSlots.length = 0;
		anchor.render(120);
		assert.deepEqual(backgroundSlots, [], "identical frame reuses the cached panel rows");

		// 其中一个工具失败：整张回合卡改用失败底色，不能命中旧底色的缓存。
		second.updateResult({ content: [{ type: "text", text: "failed" }], isError: true });
		anchor.render(120);
		assert.deepEqual(
			[...new Set(backgroundSlots)],
			["toolErrorBg"],
			"one failed tool paints the whole round card",
		);
	} finally {
		setMessageDisplayTheme(previousTheme);
		config.mode = previousMode;
		hooks.shutdown();
		prototype.render = nativeRender;
	}
});

test("expanded running round keeps thinking and tools in transcript order", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-compact-order-"));
	const previousDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	const previousMode = config.mode;
	config.mode = "compact";
	const { pi, ctx, emit } = extensionRuntime();
	installCompactThinking(pi, {
		useSummaryTitlesAsThinkingTitle: false,
		previewLines: 3,
		animationIntervalMs: 30,
	});
	emit("session_start", {}, ctx);
	const hooks = installCompactMode({ writeMetadata: new WriteExecutionMetadataStore() });
	try {
		const message1 = {
			role: "assistant",
			timestamp: 1,
			content: [
				{ type: "thinking", thinking: "plan-one" },
				{ type: "toolCall", id: "b1", name: "bash", arguments: { command: "echo-one" } },
			],
		};
		const message2 = {
			role: "assistant",
			timestamp: 2,
			content: [
				{ type: "thinking", thinking: "plan-two" },
				{ type: "toolCall", id: "g1", name: "grep", arguments: { pattern: "needle" } },
			],
		};
		const assistant1 = new AssistantMessageComponent(message1 as any, true) as any;
		assistant1.updateContent(message1);
		const assistant2 = new AssistantMessageComponent(message2 as any, true) as any;
		assistant2.updateContent(message2);
		const bash = tool("bash", "b1", { command: "echo-one" });
		bash.updateResult({ content: [{ type: "text", text: "ok" }], isError: false });
		const grep = tool("grep", "g1", { pattern: "needle" });
		grep.updateResult({ content: [{ type: "text", text: "hit" }], isError: false });
		assistant1.setExpanded(true);
		const text = renderText(assistant1).join("\n");
		const planOne = text.indexOf("plan-one");
		const echoOne = text.indexOf("echo-one");
		const planTwo = text.indexOf("plan-two");
		const needle = text.indexOf("needle");
		assert.ok(planOne >= 0 && echoOne >= 0 && planTwo >= 0 && needle >= 0, text);
		assert.ok(planOne < echoOne, `thinking 1 must precede its tool, got: ${text}`);
		assert.ok(echoOne < planTwo, `tool 1 must precede thinking 2, got: ${text}`);
		assert.ok(planTwo < needle, `thinking 2 must precede its tool, got: ${text}`);
	} finally {
		hooks.shutdown();
		config.mode = previousMode;
		emit("session_shutdown", {}, ctx);
		if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousDir;
		rmSync(dir, { recursive: true, force: true });
	}
});

test("compact 整回合展开卡内工具可单击二次展开", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-compact-round-tool-"));
	const previousDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	const previousMode = config.mode;
	config.mode = "compact";
	const previousTheme = getMessageDisplayTheme();
	setMessageDisplayTheme({
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
		italic: (text: string) => text,
		bg: (_slot: string, text: string) => text,
	} as any);
	const writeMetadata = new WriteExecutionMetadataStore();
	const defaultMode = installDefaultMode(writeMetadata);
	const { pi, ctx, emit } = extensionRuntime();
	installCompactThinking(pi, {
		useSummaryTitlesAsThinkingTitle: false,
		previewLines: 3,
		animationIntervalMs: 30,
	});
	emit("session_start", {}, ctx);
	const hooks = installCompactMode({ writeMetadata });
	try {
		const message = {
			role: "assistant",
			timestamp: 1,
			content: [
				{ type: "toolCall", id: "b1", name: "bash", arguments: { command: "one" } },
				{ type: "toolCall", id: "b2", name: "bash", arguments: { command: "two" } },
			],
		};
		const first = tool("bash", "b1", { command: "one" });
		const second = tool("bash", "b2", { command: "two" });
		for (const item of [first, second]) {
			item.executionStarted = true;
			item.updateDisplay?.();
		}
		const anchor = new AssistantMessageComponent(message as any, true) as any;
		anchor.updateContent(message);
		const output = { content: [{ type: "text", text: "line one\nline two" }], isError: false };
		first.updateResult(output);
		second.updateResult(output);
		anchor.setExpanded(true);

		const plainLines = (): string[] =>
			anchor
				.render(120)
				.map((line: string) =>
					line.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/\x1b\][^\x07]*\x07/g, ""),
				);
		// 渲染样式随 mode/主题变化，按命中结果定位工具行，不按提示文案。
		const rows = plainLines();
		const toolRows = rows
			.map((_line, index) => index)
			.filter((index) => componentAtLocalRow(anchor, index, 120)?.component === first);
		assert.ok(toolRows.length > 0, `展开卡里应能命中工具行: ${rows.join("\n")}`);

		// 未标记时仍被强制折叠压回（保持「回合展开不递归展开工具」的既有行为）。
		first.setExpanded(true);
		assert.equal(first.expanded, false, "未确认用户展开前仍强制折叠");

		// 用户点开：放行，并在卡内渲染出输出。
		markCompactRoundToolExpanded(first);
		first.setExpanded(true);
		assert.equal(first.expanded, true, "用户点开的 round 内工具应保持展开");
		const expandedText = plainLines().join("\n");
		assert.match(expandedText, /line one/, `展开后应看到输出: ${expandedText}`);

		// 单开：展开第二个时第一个收回。
		markCompactRoundToolExpanded(second);
		second.setExpanded(true);
		assert.equal(second.expanded, true);
		assert.equal(first.expanded, false, "单开语义：其他 round 内工具应收起");

		// 回合收起再展开后回到纯折叠态。
		anchor.setExpanded(false);
		anchor.setExpanded(true);
		assert.equal(second.expanded, false, "回合重新展开后工具回到折叠");
	} finally {
		hooks.shutdown();
		defaultMode.shutdown();
		setMessageDisplayTheme(previousTheme);
		config.mode = previousMode;
		emit("session_shutdown", {}, ctx);
		if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousDir;
		rmSync(dir, { recursive: true, force: true });
	}
});

test("compact 面板收起时，卡内被点开的工具一起收回", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-compact-round-retract-"));
	const previousDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	const previousMode = config.mode;
	config.mode = "compact";
	const writeMetadata = new WriteExecutionMetadataStore();
	const defaultMode = installDefaultMode(writeMetadata);
	const { pi, ctx, emit } = extensionRuntime();
	installCompactThinking(pi, {
		useSummaryTitlesAsThinkingTitle: false,
		previewLines: 3,
		animationIntervalMs: 30,
	});
	emit("session_start", {}, ctx);
	const hooks = installCompactMode({ writeMetadata });
	try {
		const message = {
			role: "assistant",
			timestamp: 1,
			content: [
				{ type: "toolCall", id: "b1", name: "bash", arguments: { command: "one" } },
				{ type: "toolCall", id: "b2", name: "bash", arguments: { command: "two" } },
			],
		};
		const first = tool("bash", "b1", { command: "one" });
		const second = tool("bash", "b2", { command: "two" });
		for (const item of [first, second]) {
			item.executionStarted = true;
			item.updateDisplay?.();
		}
		const anchor = new AssistantMessageComponent(message as any, true) as any;
		anchor.updateContent(message);
		const output = { content: [{ type: "text", text: "line one" }], isError: false };
		first.updateResult(output);
		second.updateResult(output);

		// 回合先收尾，模拟用户回看历史：live 态的强制折叠不再兜底。
		const finalMessage = {
			role: "assistant",
			timestamp: 9,
			content: [{ type: "text", text: "done" }],
		};
		const final = new AssistantMessageComponent(finalMessage as any, true) as any;
		final.updateContent(finalMessage);
		await settleFold();

		anchor.setExpanded(true);
		markCompactRoundToolExpanded(first);
		first.setExpanded(true);
		assert.equal(first.expanded, true, "面板展开时用户点开的工具应保持展开");

		// 面板收起（点面板内非提示区）：卡内工具必须一起收回，否则会单独渲染成一张卡。
		anchor.setExpanded(false);
		assert.equal(first.expanded, false, "面板收起时卡内工具应一起收回");
		assert.deepEqual(renderText(first), [], "收回后工具不该单独成卡");
		assert.match(renderText(anchor).join("\n"), /Ran for /, "面板收起后只剩摘要行");
	} finally {
		hooks.shutdown();
		defaultMode.shutdown();
		config.mode = previousMode;
		emit("session_shutdown", {}, ctx);
		if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousDir;
		rmSync(dir, { recursive: true, force: true });
	}
});

test("compact live: one thinking preview, one tool slot, folds after the settle window", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-compact-live-"));
	const previousDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	const previousMode = config.mode;
	config.mode = "compact";
	const { pi, ctx, emit } = extensionRuntime();
	installCompactThinking(pi, {
		useSummaryTitlesAsThinkingTitle: false,
		previewLines: 3,
		animationIntervalMs: 30,
	});
	emit("session_start", {}, ctx);
	const hooks = installCompactMode({ writeMetadata: new WriteExecutionMetadataStore() });
	try {
		// anchor：思考已收尾（末块是 toolCall），工具开始跑。
		const message1 = {
			role: "assistant",
			timestamp: 1,
			content: [
				{ type: "thinking", thinking: "plan-one" },
				{ type: "toolCall", id: "b1", name: "bash", arguments: { command: "echo-one" } },
			],
		};
		const bash = tool("bash", "b1", { command: "echo-one" });
		bash.executionStarted = true;
		bash.updateDisplay?.();
		const assistant1 = new AssistantMessageComponent(message1 as any, true) as any;
		assistant1.updateContent(message1);

		let text = renderText(assistant1).join("\n");
		assert.match(text, /Running\.\.\./);
		assert.ok(text.includes("echo-one"), `槽位应显示运行中的工具: ${text}`);
		assert.doesNotMatch(text, /plan-one/, `已收尾的思考不该占屏幕: ${text}`);
		const slotLine = renderText(assistant1).find((line) => line.startsWith("↳"));
		assert.ok(slotLine, `槽位卡首行应有 ↳ 标记: ${text}`);
		assert.ok(!slotLine.startsWith("↳  "), `↳ 后只留一个空格: ${slotLine}`);
		assert.ok(slotLine.includes("echo-one"), `槽位卡首行应是当前工具: ${slotLine}`);
		assert.deepEqual(renderText(bash), [], "槽位接管的工具外层不再单独成行");

		// 工具完成：槽位保留终态，等下一个工具接手，不出现「完成即消失」的闪动。
		bash.updateResult({ content: [{ type: "text", text: "ok-one" }], isError: false });
		text = renderText(assistant1).join("\n");
		assert.ok(text.includes("echo-one"), `工具完成后槽位仍应保留: ${text}`);
		assert.deepEqual(renderText(bash), [], "完成态仍由槽位接管");

		// 第二个成员：思考已收尾 + 新工具；第三个成员：思考仍在长。
		const message2 = {
			role: "assistant",
			timestamp: 2,
			content: [
				{ type: "thinking", thinking: "plan-two" },
				{ type: "toolCall", id: "g1", name: "grep", arguments: { pattern: "needle" } },
			],
		};
		const grep = tool("grep", "g1", { pattern: "needle" });
		grep.updateDisplay?.();
		const assistant2 = new AssistantMessageComponent(message2 as any, true) as any;
		assistant2.updateContent(message2);
		const message3 = {
			role: "assistant",
			timestamp: 3,
			content: [{ type: "thinking", thinking: "plan-three" }],
		};
		const assistant3 = new AssistantMessageComponent(message3 as any, true) as any;
		assistant3.updateContent(message3);

		text = renderText(assistant1).join("\n");
		assert.match(text, /plan-three/, `活动思考应预览: ${text}`);
		assert.doesNotMatch(text, /plan-one|plan-two/, `只有活动思考预览，中间态不堆积: ${text}`);
		const thinkingSlot = renderText(assistant1).find((line) => line.startsWith("↳"));
		assert.ok(thinkingSlot, `思考应占槽位: ${text}`);
		assert.ok(!thinkingSlot.includes("needle"), `思考占槽位时工具让位: ${thinkingSlot}`);
		assert.deepEqual(renderText(assistant2), [], "成员本体不重复渲染");
		assert.deepEqual(renderText(assistant3), [], "思考预览已移进槽位卡");

		// 最终正文出现：静默期内槽位还在，不立刻抖一下。
		const finalMessage = {
			role: "assistant",
			timestamp: 4,
			content: [{ type: "text", text: "done-live" }],
		};
		const final = new AssistantMessageComponent(finalMessage as any, true) as any;
		final.updateContent(finalMessage);
		assert.match(renderText(assistant1).join("\n"), /plan-three/, "静默期内槽位保留");

		// 静默期结束 → 整块收回收摘要行。
		await settleFold();
		const folded = renderText(assistant1).join("\n");
		assert.match(folded, /Ran for /, `回合结束应收回收摘要行: ${folded}`);
		assert.doesNotMatch(folded, /plan-three/, `回合结束后思考预览应回收: ${folded}`);
		assert.doesNotMatch(folded, /↳/, "回合结束后工具槽位应回收");
		assert.match(folded, /bash×1/);
		assert.match(folded, /grep×1/);
		assert.deepEqual(renderText(assistant3), []);
	} finally {
		hooks.shutdown();
		config.mode = previousMode;
		emit("session_shutdown", {}, ctx);
		if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousDir;
		rmSync(dir, { recursive: true, force: true });
	}
});

test("compact live: 工具组件晚于消息到达时补画槽位，参数更新时刷新", () => {
	const { restore } = installHooks();
	try {
		const message = {
			role: "assistant",
			timestamp: 1,
			content: [
				{ type: "text", text: "looking" },
				{ type: "toolCall", id: "b1", name: "bash", arguments: { command: "echo-early" } },
			],
		};
		const assistant = new AssistantMessageComponent(message as any, true) as any;
		// pi 的 message_update：先 updateContent（计数 +1），工具组件还没构造。
		assistant.updateContent(message);
		const before = renderText(assistant);
		assert.match(before.join("\n"), /bash×1/, `计数应先涨: ${before}`);
		assert.ok(!before.some((line) => line.startsWith("↳")), `组件未到不该有槽位卡: ${before}`);

		const bash = tool("bash", "b1", { command: "echo-early" });
		bash.updateDisplay?.();
		const after = renderText(assistant);
		const slot = after.find((line) => line.startsWith("↳"));
		assert.ok(slot?.includes("echo-early"), `组件到达后要补画槽位: ${after}`);
		assert.deepEqual(renderText(bash), [], "槽位接管后外层不再单独成行");

		bash.args = { command: "echo-late" };
		bash.updateDisplay?.();
		const updated = renderText(assistant);
		assert.ok(
			updated.some((line) => line.startsWith("↳") && line.includes("echo-late")),
			`参数更新后槽位要跟着换: ${updated}`,
		);
	} finally {
		restore();
	}
});

test("compact live: a superseding round folds the previous one immediately", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-compact-live-supersede-"));
	const previousDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	const previousMode = config.mode;
	config.mode = "compact";
	const { pi, ctx, emit } = extensionRuntime();
	installCompactThinking(pi, {
		useSummaryTitlesAsThinkingTitle: false,
		previewLines: 3,
		animationIntervalMs: 30,
	});
	emit("session_start", {}, ctx);
	const hooks = installCompactMode({ writeMetadata: new WriteExecutionMetadataStore() });
	try {
		const messageA = {
			role: "assistant",
			timestamp: 1,
			content: [
				{ type: "text", text: "first-line\nlatest-a" },
				{ type: "toolCall", id: "b1", name: "bash", arguments: { command: "echo-a" } },
			],
		};
		const bashA = tool("bash", "b1", { command: "echo-a" });
		bashA.executionStarted = true;
		bashA.updateDisplay?.();
		const roundA = new AssistantMessageComponent(messageA as any, true) as any;
		roundA.updateContent(messageA);
		const liveA = renderText(roundA);
		// live 与折叠态同形：正文整段照原生渲染，摘要行在其后，槽位卡再挂在摘要行下。
		assert.deepEqual(
			liveA.slice(0, 2),
			["first-line", "latest-a"],
			`live 应显示完整正文: ${liveA}`,
		);
		assert.match(liveA[2] ?? "", /^Running\.\.\./, `摘要行排在正文之后: ${liveA}`);
		assert.match(liveA[3] ?? "", /^↳ \S/, `槽位卡首行紧跟 ↳: ${liveA}`);
		assert.ok(!(liveA[3] ?? "").startsWith("↳  "), `↳ 后只留一个空格: ${liveA[3]}`);

		// 新 anchor 接替：旧回合立即收拢，不残留成第二张卡。
		const messageB = {
			role: "assistant",
			timestamp: 2,
			content: [
				{ type: "text", text: "second-round" },
				{ type: "toolCall", id: "g1", name: "grep", arguments: { pattern: "needle" } },
			],
		};
		const grepB = tool("grep", "g1", { pattern: "needle" });
		grepB.executionStarted = true;
		grepB.updateDisplay?.();
		const roundB = new AssistantMessageComponent(messageB as any, true) as any;
		roundB.updateContent(messageB);

		// roundB 的 text+toolCall 并入 roundA（同一 turn、无用户消息隔断）：
		// roundA 仍 active，摘要行从 Running 里累计出 grep×1；roundB 只渲染自己的正文。
		const mergedA = renderText(roundA);
		assert.match(
			mergedA[2] ?? "",
			/^Running\.\.\..*bash×1.*grep×1/,
			`并入同一回合后摘要累计: ${mergedA}`,
		);
		// roundB 并入 roundA 后不是 anchor：text 仍在自己组件上渲染，
		// thinking/工具计进 roundA 摘要，成员不再被整体清空。
		assert.deepEqual(renderText(roundB), ["second-round"], "并入成员的 text 留在自己组件上");
	} finally {
		hooks.shutdown();
		config.mode = previousMode;
		emit("session_shutdown", {}, ctx);
		if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousDir;
		rmSync(dir, { recursive: true, force: true });
	}
});

test("compact 尾行：展开的活回合不随新工具推到容器末尾，摘要行钉在回合原位", async () => {
	const { restore } = installHooks();
	const chat = new Container() as any;
	setToolMouseTui({ children: [chat] });
	try {
		const message = {
			role: "assistant",
			timestamp: 1,
			content: [
				{ type: "text", text: "hello" },
				{ type: "toolCall", id: "b1", name: "bash", arguments: { command: "one" } },
			],
		};
		const anchor = new AssistantMessageComponent(message as any, true) as any;
		const bash = tool("bash", "b1", { command: "one" });
		chat.addChild(anchor);
		chat.addChild(bash);
		anchor.updateContent(message);
		const tail = chat.children.at(-1) as any;
		assert.ok(isCompactAssistantComponent(tail), "尾行应已挂载");

		// 展开回合：面板仍顶替摘要行那一格，但摘要行的容器坐标不该变。
		anchor.setExpanded(true);
		assert.equal(chat.children.indexOf(tail), 2, "展开不动摘要行位置");

		// 展开的活回合又来一条消息/新工具：pi 把它 append 在容器最末（尾行之后）。
		// 归位只该把尾行留在回合末位，不能把它推到容器末尾、插到后面消息之间。
		const message2 = {
			role: "assistant",
			timestamp: 2,
			content: [
				{ type: "text", text: "more" },
				{ type: "toolCall", id: "g1", name: "grep", arguments: { pattern: "x" } },
			],
		};
		const second = new AssistantMessageComponent(message2 as any, true) as any;
		const grep = tool("grep", "g1", { pattern: "x" });
		chat.addChild(second);
		chat.addChild(grep);
		grep.updateDisplay?.();

		// second 的 toolCall 并入第一回合（同一 turn，未被用户消息隔开），
		// tail 位置钉在回合最后成员之后（grep 之后），展开面板里能看到 grep 卡。
		const tailIdx = chat.children.indexOf(tail);
		const grepIdx = chat.children.indexOf(grep);
		assert.ok(tailIdx >= 0, "尾行仍在容器里");
		assert.ok(tailIdx > grepIdx, `摘要行钉在回合末位 (tail=${tailIdx}, grep=${grepIdx})`);
		assert.match(renderText(tail).join("\n"), /grep \/x\//, "新工具并入同一回合面板");
	} finally {
		setToolMouseTui(null);
		restore();
	}
});

test("compact 尾行：摘要行挂 transcript 容器回合末尾，新工具追加后归位", async () => {
	const { restore } = installHooks();
	// anchor 挂进容器时（等价于 pi chatContainer），摘要行挂到容器里回合末尾的
	// 兄弟组件上——运行中恒在可写视口底缘，收尾的 Ran for 才能落进 scrollback。
	const chat = new Container() as any;
	setToolMouseTui({ children: [chat] });
	try {
		const message = {
			role: "assistant",
			timestamp: 1,
			content: [
				{ type: "text", text: "hello" },
				{ type: "toolCall", id: "b1", name: "bash", arguments: { command: "one" } },
			],
		};
		const anchor = new AssistantMessageComponent(message as any, true) as any;
		const bash = tool("bash", "b1", { command: "one" });
		chat.addChild(anchor);
		chat.addChild(bash);
		anchor.updateContent(message);

		// 摘要行离开 anchor，成为容器里回合末尾的兄弟组件。
		assert.equal(chat.children.length, 3, `尾行应挂进容器: ${chat.children.length}`);
		const tail = chat.children[2] as any;
		assert.ok(tail !== anchor && tail !== bash);
		assert.ok(isCompactAssistantComponent(tail), "尾行要保留展开接线（click/hover）");
		assert.ok(
			!renderText(anchor).some((line) => /Running\.\.\./.test(line)),
			"anchor 自身渲染不再带摘要行",
		);
		assert.match(renderText(tail).join("\n"), /Running\.\.\.(?: · [\d.]+m?s)?, bash×1/);

		// pi 把新工具卡 append 在容器末尾（尾行之后）：updateDisplay 时压回合末位。
		const message2 = {
			...message,
			content: [
				...message.content,
				{ type: "toolCall", id: "g1", name: "grep", arguments: { pattern: "x" } },
			],
		};
		anchor.updateContent(message2);
		const grep = tool("grep", "g1", { pattern: "x" });
		chat.addChild(grep);
		assert.equal(chat.children.at(-1), grep, "工具先落在尾行之后");
		grep.updateDisplay?.();
		assert.equal(chat.children.at(-1), tail, "尾行应归位到新工具之后");

		// 收尾：尾行原地翻成 Ran for，停在收尾回合与下一条消息之间。
		const finalMessage = {
			role: "assistant",
			timestamp: 2,
			content: [{ type: "text", text: "done" }],
		};
		const final = new AssistantMessageComponent(finalMessage as any, true) as any;
		chat.addChild(final);
		final.updateContent(finalMessage);
		await settleFold();
		assert.match(renderText(tail).join("\n"), /Ran for .+bash×1.+grep×1/);
		const order = chat.children.map((c: any) =>
			c === tail ? "tail" : c === anchor ? "anchor" : c === final ? "final" : "tool",
		);
		assert.deepEqual(order, ["anchor", "tool", "tool", "tail", "final"]);
	} finally {
		setToolMouseTui(null);
		restore();
	}
});

test("compact 尾行：只有 edit/write 的回合不挂摘要行", async () => {
	const { restore } = installHooks();
	const chat = new Container() as any;
	setToolMouseTui({ children: [chat] });
	try {
		const message = {
			role: "assistant",
			timestamp: 1,
			content: [
				{ type: "thinking", thinking: "" },
				{ type: "toolCall", id: "e1", name: "edit", arguments: { path: "a.ts" } },
				{ type: "toolCall", id: "e2", name: "edit", arguments: { path: "b.ts" } },
			],
		};
		const anchor = new AssistantMessageComponent(message as any, true) as any;
		const editA = tool("edit", "e1", { path: "a.ts" });
		const editB = tool("edit", "e2", { path: "b.ts" });
		chat.addChild(anchor);
		chat.addChild(editA);
		chat.addChild(editB);
		anchor.updateContent(message);

		// 外层独段不建回合：edit/write 行自己的 pending icon 表示进行中，不另挂摘要行。
		assert.ok(
			!chat.children.some((child: any) => /Running\.\.\./.test(renderText(child).join("\n"))),
			"外层独段不挂摘要行",
		);

		// steering / 下一条消息把回合收尾：没有普通工具也没有思考，摘要行撤掉。
		const next = {
			role: "assistant",
			timestamp: 2,
			content: [{ type: "text", text: "next" }],
		};
		const follow = new AssistantMessageComponent(next as any, true) as any;
		chat.addChild(follow);
		follow.updateContent(next);
		await settleFold();
		const summaries = renderText(chat).filter((line) => /Ran for/.test(line));
		assert.deepEqual(summaries, [], `只剩外层卡的回合不应有摘要行: ${summaries}`);
		assert.equal(chat.children.includes(editA), true);
		assert.equal(chat.children.includes(editB), true);
	} finally {
		setToolMouseTui(null);
		restore();
	}
});

test("compact resume：重放已结束的回合直接落成 Ran for，不停留在 Running", () => {
	const { hooks, restore } = installHooks();
	const chat = new Container() as any;
	setToolMouseTui({ children: [chat] });
	try {
		const message = {
			role: "assistant",
			timestamp: 1,
			stopReason: "toolUse",
			content: [
				{ type: "text", text: "checking" },
				{ type: "toolCall", id: "b1", name: "bash", arguments: { command: "ls" } },
			],
		};
		const anchor = new AssistantMessageComponent(message as any, true) as any;
		const bash = tool("bash", "b1", { command: "ls" });
		chat.addChild(anchor);
		chat.addChild(bash);
		// resume 重放：构造时 updateContent 不带 isStreaming，消息已是终态。
		anchor.updateContent(message);
		// 回放进行中不收尾：还有后续消息要并进同一回合。
		assert.match(renderText(chat).join("\n"), /Running\.\.\..*bash×1/);
		// 回放结束（session_start 延迟一拍）才收尾最后一条。
		hooks.settleReplayedRound();
		const rendered = renderText(chat).join("\n");
		assert.doesNotMatch(rendered, /Running\.\.\./, `重放不该停在进行中: ${rendered}`);
		assert.match(rendered, /Ran for .+bash×1/, `重放应直接落成已结束: ${rendered}`);

		// 流式中的消息（pending）不受影响，仍显示 Running。
		const live = {
			role: "assistant",
			timestamp: 2,
			stopReason: "pending",
			content: [
				{ type: "text", text: "next" },
				{ type: "toolCall", id: "b2", name: "bash", arguments: { command: "pwd" } },
			],
		};
		const liveAnchor = new AssistantMessageComponent(live as any, true) as any;
		chat.addChild(liveAnchor);
		liveAnchor.updateContent(live);
		assert.match(renderText(chat).join("\n"), /Running\.\.\..*bash×1/);
	} finally {
		setToolMouseTui(null);
		restore();
	}
});

test("compact：同一 turn 内 text+toolCall 消息不拆回合，用户消息才切断", () => {
	const { hooks, restore } = installHooks();
	const chat = new Container() as any;
	setToolMouseTui({ children: [chat] });
	try {
		const first = {
			role: "assistant",
			timestamp: 1,
			stopReason: "toolUse",
			content: [
				{ type: "text", text: "one" },
				{ type: "toolCall", id: "b1", name: "bash", arguments: { command: "ls" } },
			],
		};
		const second = {
			role: "assistant",
			timestamp: 2,
			stopReason: "toolUse",
			content: [
				{ type: "text", text: "two" },
				{ type: "toolCall", id: "b2", name: "bash", arguments: { command: "pwd" } },
			],
		};
		const anchor = new AssistantMessageComponent(first as any, true) as any;
		const follow = new AssistantMessageComponent(second as any, true) as any;
		chat.addChild(anchor);
		chat.addChild(tool("bash", "b1", { command: "ls" }));
		anchor.updateContent(first);
		chat.addChild(follow);
		chat.addChild(tool("bash", "b2", { command: "pwd" }));
		follow.updateContent(second);

		hooks.settleReplayedRound();
		const summaries = renderText(chat).filter((line) => /Ran for/.test(line));
		// 同一 agent turn 里不带用户消息隔断的 text+toolCall 仍归同一回合。
		assert.deepEqual(summaries.length, 1, `不应因正文拆回合: ${summaries}`);
		assert.match(summaries[0] ?? "", /bash×2/, `两次调用累计: ${summaries}`);
	} finally {
		setToolMouseTui(null);
		restore();
	}
});

test("compact：同一组件流式切换 text/toolCall 形态不拆回合", () => {
	const { hooks, restore } = installHooks();
	const chat = new Container() as any;
	setToolMouseTui({ children: [chat] });
	try {
		const base = {
			role: "assistant",
			timestamp: 1,
			stopReason: "toolUse",
		};
		const anchor = new AssistantMessageComponent(base as any, true) as any;
		chat.addChild(anchor);
		chat.addChild(tool("bash", "b1", { command: "ls" }));
		chat.addChild(tool("grep", "g1", { pattern: "x" }));

		// pi 的流式 message_update：同一组件反复 updateContent，content 形态会变。
		anchor.updateContent({
			...base,
			content: [{ type: "toolCall", id: "b1", name: "bash", arguments: { command: "ls" } }],
		});
		anchor.updateContent({
			...base,
			content: [
				{ type: "text", text: "leading text" },
				{ type: "toolCall", id: "b1", name: "bash", arguments: { command: "ls" } },
			],
		});
		anchor.updateContent({
			...base,
			content: [
				{ type: "toolCall", id: "b1", name: "bash", arguments: { command: "ls" } },
				{ type: "toolCall", id: "g1", name: "grep", arguments: { pattern: "x" } },
			],
		});

		hooks.settleReplayedRound();
		const summaries = renderText(chat).filter((line) => /Ran for/.test(line));
		assert.equal(summaries.length, 1, `同一组件形态变化不拆回合: ${summaries}`);
		assert.match(summaries[0] ?? "", /bash×1, grep×1/, `两次工具都计入: ${summaries}`);
	} finally {
		setToolMouseTui(null);
		restore();
	}
});

test("compact 尾行：reset 后同 anchor 残留的旧尾行被清扫", async () => {
	const { hooks, restore } = installHooks();
	const chat = new Container() as any;
	setToolMouseTui({ children: [chat] });
	try {
		const message = {
			role: "assistant",
			timestamp: 1,
			content: [
				{ type: "text", text: "hello" },
				{ type: "toolCall", id: "b1", name: "bash", arguments: { command: "one" } },
			],
		};
		const anchor = new AssistantMessageComponent(message as any, true) as any;
		chat.addChild(anchor);
		chat.addChild(tool("bash", "b1", { command: "one" }));
		anchor.updateContent(message);
		assert.equal(
			renderText(chat).filter((line) => /Running\.\.\.|Ran for/.test(line)).length,
			1,
			"前置：单条摘要行",
		);

		// refresh 走 resetRounds + refreshTrackedComponents：重放 updateContent 后
		// 同一 anchor 起新回合，sweepOrphanTails 应把残留旧 tail 摘掉。
		hooks.refresh();
		await settleFold();
		const summaries = renderText(chat).filter((line) => /Running\.\.\.|Ran for/.test(line));
		assert.equal(summaries.length, 1, `只该有一条摘要行: ${summaries}`);
	} finally {
		setToolMouseTui(null);
		restore();
	}
});

test("compact 尾行：运行中外来提示行压在计数行之上，收尾后落到摘要之下", async () => {
	const { restore } = installHooks();
	const chat = new Container() as any;
	setToolMouseTui({ children: [chat] });
	try {
		const message = {
			role: "assistant",
			timestamp: 1,
			content: [
				{ type: "text", text: "hello" },
				{ type: "toolCall", id: "b1", name: "bash", arguments: { command: "one" } },
			],
		};
		const anchor = new AssistantMessageComponent(message as any, true) as any;
		const bash = tool("bash", "b1", { command: "one" });
		chat.addChild(anchor);
		chat.addChild(bash);
		anchor.updateContent(message);
		const tail = chat.children.at(-1) as any;

		// 运行中到达提示行（showStatus 的 Spacer+Text 等价物）：落在尾行之后。
		const tipSpacer = { render: () => [""] };
		const tipText = { render: () => ["Updated x: on"] };
		chat.addChild(tipSpacer);
		chat.addChild(tipText);

		// 新工具 append 在提示行之后，updateDisplay 触发尾行归位。
		const message2 = {
			...message,
			content: [
				...message.content,
				{ type: "toolCall", id: "g1", name: "grep", arguments: { pattern: "x" } },
			],
		};
		anchor.updateContent(message2);
		const grep = tool("grep", "g1", { pattern: "x" });
		chat.addChild(grep);
		grep.updateDisplay?.();

		const order = chat.children.map((c: any) =>
			c === tail
				? "tail"
				: c === anchor
					? "anchor"
					: c === tipSpacer || c === tipText
						? "tip"
						: "tool",
		);
		// 计数行恒在 transcript 最末：提示行不困在成员中间，也不把计数行截成两行。
		assert.deepEqual(order, ["anchor", "tool", "tool", "tip", "tip", "tail"]);

		// 收尾后摘要行回落回合末位，提示行换到它之下、回合边界之外。
		const finalMessage = {
			role: "assistant",
			timestamp: 2,
			content: [{ type: "text", text: "done" }],
		};
		const final = new AssistantMessageComponent(finalMessage as any, true) as any;
		chat.addChild(final);
		final.updateContent(finalMessage);
		await settleFold();
		const settled = chat.children.map((c: any) =>
			c === tail
				? "tail"
				: c === anchor
					? "anchor"
					: c === tipSpacer || c === tipText
						? "tip"
						: c === final
							? "final"
							: "tool",
		);
		assert.deepEqual(settled, ["anchor", "tool", "tool", "tail", "tip", "tip", "final"]);
	} finally {
		setToolMouseTui(null);
		restore();
	}
});

test("compact 回合不跨用户消息：steer 留在原位，前后各一条摘要", () => {
	const { restore } = installHooks();
	const chat = new Container() as any;
	setToolMouseTui({ children: [chat] });
	const first = {
		role: "assistant",
		timestamp: 1,
		content: [
			{ type: "text", text: "好的，我先跑一下 bash。" },
			{ type: "toolCall", id: "b1", name: "bash", arguments: { command: "one" } },
		],
	};
	const second = {
		role: "assistant",
		timestamp: 2,
		content: [{ type: "toolCall", id: "g1", name: "grep", arguments: { pattern: "Y" } }],
	};
	const third = {
		role: "assistant",
		timestamp: 3,
		content: [{ type: "toolCall", id: "r1", name: "read", arguments: { path: "src/z.ts" } }],
	};
	// 直播顺序：pi 先 addChild 再 updateContent（message_start → 挂载 → 流式）。
	try {
		const anchor = new AssistantMessageComponent(undefined, true) as any;
		const bash = tool("bash", "b1", { command: "one" });
		chat.addChild(anchor);
		chat.addChild(bash);
		anchor.updateContent(first);

		// 回合进行中插入 steer 用户消息。
		const steer = new UserMessageComponent("顺便也看看 Y") as any;
		chat.addChild(steer);

		// steer 之后模型接着跑 grep：这条 assistant 消息没有正文。
		const next = new AssistantMessageComponent(undefined, true) as any;
		const grep = tool("grep", "g1", { pattern: "Y" });
		chat.addChild(next);
		chat.addChild(grep);
		next.updateContent(second);
		grep.updateDisplay?.();

		// steer 排在旧回合之后、新回合之前：没被当成外来行挪到回合末尾。
		const order = chat.children as any[];
		assert.ok(order.indexOf(steer) > order.indexOf(bash), "steer 在旧回合之后");
		assert.ok(order.indexOf(steer) < order.indexOf(next), "steer 在新回合之前");

		const summaries = renderText(chat).filter((line) => /Ran for|Running\.\.\./.test(line));
		assert.equal(summaries.length, 2, `两个回合各一条摘要: ${renderText(chat).join(" | ")}`);
		assert.match(summaries[0]!, /Ran for .+bash×1/);
		assert.doesNotMatch(summaries[0]!, /grep/);
		assert.match(summaries[1]!, /Running\.\.\..*grep×1/);
		assert.doesNotMatch(summaries[1]!, /bash/);

		// 回合 2 还在跑时用户又提了新问题：新回合同样不把这条消息卷进来。
		const prompt = new UserMessageComponent("再看看 Z") as any;
		chat.addChild(prompt);
		const later = new AssistantMessageComponent(undefined, true) as any;
		const read = tool("read", "r1", { path: "src/z.ts" });
		chat.addChild(later);
		chat.addChild(read);
		later.updateContent(third);

		const after = chat.children as any[];
		assert.ok(after.indexOf(prompt) > after.indexOf(grep), "新问题排在上一段工具之后");
		assert.ok(after.indexOf(prompt) < after.indexOf(later), "新问题排在下一回合之前");
		assert.ok(after.indexOf(steer) < after.indexOf(later), "steer 没被后一轮挪走");
	} finally {
		setToolMouseTui(null);
		restore();
	}
});

test("compact 回合不跨用户消息：重放后 refresh 重新分组，边界同样成立", () => {
	const { hooks, restore } = installHooks();
	const chat = new Container() as any;
	setToolMouseTui({ children: [chat] });
	try {
		const first = {
			role: "assistant",
			timestamp: 1,
			content: [
				{ type: "text", text: "好的，我先跑一下 bash。" },
				{ type: "toolCall", id: "b1", name: "bash", arguments: { command: "one" } },
			],
		};
		const second = {
			role: "assistant",
			timestamp: 2,
			content: [{ type: "toolCall", id: "g1", name: "grep", arguments: { pattern: "Y" } }],
		};
		// 会话重放顺序：组件构造时就带消息（updateContent 发生在挂载之前），
		// 那一刻看不到容器里的用户消息，边界由 refresh 重新分组时补上。
		const prompt = new UserMessageComponent("把 X 改一下") as any;
		const anchor = new AssistantMessageComponent(first as any, true) as any;
		const bash = tool("bash", "b1", { command: "one" });
		const steer = new UserMessageComponent("顺便也看看 Y") as any;
		const next = new AssistantMessageComponent(second as any, true) as any;
		const grep = tool("grep", "g1", { pattern: "Y" });
		for (const child of [prompt, anchor, bash, steer, next, grep]) chat.addChild(child);

		hooks.refresh();

		const order = chat.children as any[];
		assert.ok(order.indexOf(steer) > order.indexOf(bash), "steer 在旧回合之后");
		assert.ok(order.indexOf(steer) < order.indexOf(next), "steer 在新回合之前");
		const summaries = renderText(chat).filter((line) => /Ran for|Running\.\.\./.test(line));
		assert.equal(summaries.length, 2, `两个回合各一条摘要: ${renderText(chat).join(" | ")}`);
		assert.match(summaries[0]!, /Ran for .+bash×1/);
		assert.match(summaries[1]!, /Running\.\.\..*grep×1/);
	} finally {
		setToolMouseTui(null);
		restore();
	}
});

test("compact 尾行：同一条消息的 timestamp 不前进时，活回合仍用挂钟", async () => {
	const { restore } = installHooks();
	const chat = new Container() as any;
	setToolMouseTui({ children: [chat] });
	const realNow = Date.now;
	const t0 = 1_700_000_000_000;
	let now = t0;
	Date.now = () => now;
	try {
		const message = {
			role: "assistant",
			timestamp: t0,
			content: [{ type: "toolCall", id: "b1", name: "bash", arguments: { command: "one" } }],
		};
		const anchor = new AssistantMessageComponent(message as any, true) as any;
		chat.addChild(anchor);
		chat.addChild(tool("bash", "b1", { command: "one" }));
		anchor.updateContent(message);
		now += 5_000;
		anchor.updateContent({
			role: "assistant",
			timestamp: t0,
			content: [{ type: "text", text: "done" }],
		});
		await settleFold();
		assert.match(renderText(chat).join("\n"), /Ran for 5s/);
	} finally {
		Date.now = realNow;
		setToolMouseTui(null);
		restore();
	}
});

test("compact 尾行：回放同一毫秒收尾，不用现在减历史 timestamp", async () => {
	const { restore } = installHooks();
	const chat = new Container() as any;
	setToolMouseTui({ children: [chat] });
	const realNow = Date.now;
	const t0 = 1_700_000_000_000;
	Date.now = () => t0 + 60_000;
	try {
		const message = {
			role: "assistant",
			timestamp: t0,
			content: [{ type: "toolCall", id: "b1", name: "bash", arguments: { command: "one" } }],
		};
		const anchor = new AssistantMessageComponent(message as any, true) as any;
		chat.addChild(anchor);
		chat.addChild(tool("bash", "b1", { command: "one" }));
		anchor.updateContent(message);
		anchor.updateContent({
			role: "assistant",
			timestamp: t0,
			content: [{ type: "text", text: "done" }],
		});
		await settleFold();
		const text = renderText(chat).join("\n");
		assert.match(text, /Ran for 1ms/);
		assert.doesNotMatch(text, /Ran for 60s|Ran for 1m(?!s)/);
	} finally {
		Date.now = realNow;
		setToolMouseTui(null);
		restore();
	}
});

test("compact 尾行：refresh 重建保留挂钟与收尾态，不回摆 Running", async () => {
	const { hooks, restore } = installHooks();
	const chat = new Container() as any;
	setToolMouseTui({ children: [chat] });
	// 可控时钟：区分「保留时长」与「重建归零」。
	const realNow = Date.now;
	let now = 10_000;
	Date.now = () => now;
	try {
		const message = {
			role: "assistant",
			timestamp: 1,
			content: [
				{ type: "text", text: "doing" },
				{ type: "toolCall", id: "b1", name: "bash", arguments: { command: "one" } },
			],
		};
		const anchor = new AssistantMessageComponent(message as any, true) as any;
		const bash = tool("bash", "b1", { command: "one" });
		chat.addChild(anchor);
		chat.addChild(bash);
		anchor.updateContent(message); // startedAt = 10_000
		now += 5_000;
		const finalMessage = {
			role: "assistant",
			content: [{ type: "text", text: "done" }],
		};
		const final = new AssistantMessageComponent(finalMessage as any, true) as any;
		chat.addChild(final);
		final.updateContent(finalMessage); // endedAt = 15_000
		await settleFold();
		const before = renderText(chat);
		assert.match(before.join("\n"), /Ran for 5s/, `收尾摘要: ${before}`);

		// 切换设置 → refresh 重建：同一消息回放要继承旧回合，不能回摆 Running、
		// 不能丢挂钟（Ran for 5s → 1ms）、不能重演静默期槽位卡。
		now += 60_000;
		hooks.refresh();
		const after = renderText(chat);
		assert.deepEqual(after, before, `refresh 后应与之前一致: ${before} → ${after}`);
	} finally {
		Date.now = realNow;
		setToolMouseTui(null);
		restore();
	}
});

test("compact 尾行：TUI 切换后容器过期，refresh 不另起摘要行", () => {
	const { hooks, restore } = installHooks();
	const chat = new Container() as any;
	setToolMouseTui({ children: [chat] });
	const realNow = Date.now;
	let now = 10_000;
	Date.now = () => now;
	const summaryRows = (root: any) =>
		renderText(root).filter((line: string) => /(Running\.\.\.|Ran for)/.test(line));
	try {
		const message = {
			role: "assistant",
			timestamp: 1,
			content: [
				{ type: "text", text: "doing" },
				{ type: "toolCall", id: "b1", name: "bash", arguments: { command: "one" } },
			],
		};
		const anchor = new AssistantMessageComponent(message as any, true) as any;
		const bash = tool("bash", "b1", { command: "one" });
		chat.addChild(anchor);
		chat.addChild(bash);
		anchor.updateContent(message);
		bash.updateResult({ content: [{ type: "text", text: "out" }], isError: false });
		now += 5_000;
		assert.equal(summaryRows(chat).length, 1, "前置：单条摘要行");

		// 模拟 /settings 切 tuiMode：官方把组件搬到新 tui，旧容器不再持有它们，
		// 尾行缓存的 container 就此过期。
		const moved = new Container() as any;
		for (const child of [...chat.children]) moved.addChild(child);
		chat.children.length = 0;
		setToolMouseTui({ children: [moved] });

		// 面板改设置 / 会话事件都会走 refresh。
		hooks.refresh();
		now += 2_000;
		const rows = [...summaryRows(moved), ...summaryRows(chat)];
		assert.equal(rows.length, 1, `只该有一条摘要行: ${renderText(moved)}`);
		assert.match(rows[0]!, /Running\.\.\. · 7s, bash×1/, "同一回合继续计时");

		// 后续工具仍归这个回合，不另起一行。
		const next = {
			role: "assistant",
			timestamp: 2,
			content: [{ type: "toolCall", id: "b2", name: "grep", arguments: { pattern: "x" } }],
		};
		const nextAnchor = new AssistantMessageComponent(next as any, true) as any;
		const grep = tool("grep", "b2", { pattern: "x" });
		moved.addChild(nextAnchor);
		moved.addChild(grep);
		nextAnchor.updateContent(next);
		grep.updateResult({ content: [{ type: "text", text: "hit" }], isError: false });
		now += 1_000;
		const after = summaryRows(moved);
		assert.equal(after.length, 1, `仍只该有一条摘要行: ${renderText(moved)}`);
		assert.match(after[0]!, /bash×1, grep×1/, "新工具并进同一回合");
	} finally {
		Date.now = realNow;
		setToolMouseTui(null);
		restore();
	}
});

test("compact live: 槽位卡内不重复展开入口，摘要行自己的 hint 保留", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-compact-live-hint-"));
	const previousDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	const previousMode = config.mode;
	config.mode = "compact";
	const { pi, ctx, emit } = extensionRuntime();
	installCompactThinking(pi, {
		useSummaryTitlesAsThinkingTitle: false,
		previewLines: 3,
		animationIntervalMs: 30,
	});
	emit("session_start", {}, ctx);
	const hooks = installCompactMode({ writeMetadata: new WriteExecutionMetadataStore() });
	try {
		const anchorMessage = {
			role: "assistant",
			timestamp: 1,
			content: [
				{ type: "text", text: "看长思考" },
				{ type: "toolCall", id: "b1", name: "bash", arguments: { command: "echo-a" } },
			],
		};
		const bash = tool("bash", "b1", { command: "echo-a" });
		bash.executionStarted = true;
		bash.updateDisplay?.();
		const anchor = new AssistantMessageComponent(anchorMessage as any, true) as any;
		anchor.updateContent(anchorMessage);

		// 长思考成员接手槽位：预览有隐藏行，卡里本来会带 ", click to show more"。
		const memberMessage = {
			role: "assistant",
			timestamp: 2,
			content: [{ type: "thinking", thinking: ["t1", "t2", "t3", "t4", "t5"].join("\n") }],
		};
		const member = new AssistantMessageComponent(memberMessage as any, true) as any;
		member.updateContent(memberMessage);

		const lines = renderText(anchor);
		const slot = lines.find((line) => line.startsWith("↳"));
		assert.ok(slot, `槽位卡应存在: ${lines}`);
		assert.ok(slot.includes("more lines"), `槽位卡保留隐藏行计数: ${lines}`);
		assert.ok(!slot.includes("click to show more"), `槽位卡不重复展开入口: ${slot}`);
		assert.ok(
			lines.some((line) => !line.startsWith("↳") && line.includes("click to show more")),
			`摘要行仍带自己的入口: ${lines}`,
		);
	} finally {
		hooks.shutdown();
		config.mode = previousMode;
		emit("session_shutdown", {}, ctx);
		if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousDir;
		rmSync(dir, { recursive: true, force: true });
	}
});

test("compact live: 展开入口只取行尾窗口，长负载行不进正则", () => {
	const payload = `\x1b[2m${"a".repeat(260 * 1024)}\x1b[22m`;
	const startedAt = performance.now();
	assert.equal(stripSlotHint(payload), payload, "无入口的图片负载行原样返回");
	const elapsed = performance.now() - startedAt;
	// 全行回溯的旧实现在这条输入上要几十秒；这里留足余量，只拦量级回归。
	assert.ok(elapsed < 500, `负载行裁剪应为常数代价，实际 ${elapsed.toFixed(1)} ms`);

	// 长行行尾真挂了入口时照旧剥离，前面的负载不动。
	const body = "a".repeat(260 * 1024);
	assert.equal(stripSlotHint(`${body}· click to show more`), body);

	// 键名长度边界：32 与 33 字符都整段剥离，行首不留残字。
	assert.equal(stripSlotHint(`${"x".repeat(32)} to expand`), "");
	assert.equal(stripSlotHint(`${"x".repeat(33)} to expand`), "");

	// 括注形式只去动作词，隐藏行计数与收尾括号保留。
	assert.equal(stripSlotHint("(195 earlier lines, ctrl+o to expand)"), "(195 earlier lines)");
});

test("compact 展开卡：thinking 二次展开只多 1 行内卡 padding，工具卡不再叠内层底色", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-compact-nested-"));
	const previousDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	const previousMode = config.mode;
	config.mode = "compact";
	const previousTheme = getMessageDisplayTheme();
	setMessageDisplayTheme({
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
		italic: (text: string) => text,
		bg: (_slot: string, text: string) => text,
		getBgAnsi: () => "\x1b[48;2;40;40;60m",
	} as any);
	const writeMetadata = new WriteExecutionMetadataStore();
	const { pi, ctx, emit } = extensionRuntime();
	installCompactThinking(pi, {
		useSummaryTitlesAsThinkingTitle: false,
		previewLines: 3,
		animationIntervalMs: 30,
	});
	emit("session_start", {}, ctx);
	const hooks = installCompactMode({ writeMetadata });
	try {
		const message = {
			role: "assistant",
			timestamp: 1,
			content: [
				{ type: "thinking", thinking: "plan-one\nplan-two" },
				{ type: "toolCall", id: "b1", name: "bash", arguments: { command: "one" } },
			],
		};
		const bash = tool("bash", "b1", { command: "one" });
		bash.executionStarted = true;
		bash.updateDisplay?.();
		const anchor = new AssistantMessageComponent(message as any, true) as any;
		anchor.updateContent(message);
		bash.updateResult({ content: [{ type: "text", text: "line one\nline two" }], isError: false });
		anchor.setExpanded(true);

		const raw = () => anchor.render(120);
		const plain = (lines: string[]) =>
			lines.map((line) =>
				line.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/\x1b\][^\x07]*\x07/g, ""),
			);
		const blanksAbove = (lines: string[], needle: string) => {
			const stripped = plain(lines);
			const index = stripped.findIndex((line) => line.includes(needle));
			assert.ok(index > 0, `缺少 ${needle}: ${stripped.join("\n")}`);
			let count = 0;
			for (let i = index - 1; i >= 0 && !stripped[i]?.trim(); i--) count++;
			return count;
		};

		// 子工具卡不再包一层 card 背景：整卡只应出现外卡一种背景色。
		const collapsed = raw();
		const backgrounds = new Set(
			collapsed.flatMap((line: string) => line.match(/48;2;\d+;\d+;\d+/g) ?? []),
		);
		assert.equal(backgrounds.size, 1, `子工具卡不应有第二层背景色: ${[...backgrounds].join(" ")}`);

		const thinking = anchor.contentContainer.children
			.flatMap((child: any) => (Array.isArray(child?.children) ? child.children : []))
			.find((child: any) => typeof child?.setHintHovered === "function");
		assert.ok(thinking, "展开卡应保留 thinking 块");
		const collapsedBlanks = blanksAbove(collapsed, "Thought");

		thinking.setExpanded(true);
		// thinking 内卡的上 padding 自身占 1 行；不能再多出外卡/内卡叠出来的空行。
		const expanded = raw();
		assert.equal(
			blanksAbove(expanded, "Thought") - collapsedBlanks,
			1,
			"thinking 二次展开只应多出内卡 1 行 padding",
		);
		// 内卡下 padding 之外，还要再留 1 行外卡空行，别贴着工具卡。
		const toolRow = plain(expanded).findIndex((line) => line.includes("$ one"));
		assert.ok(toolRow > 0, `缺少工具卡行: ${plain(expanded).join("\n")}`);
		const bgOf = (line: string) =>
			[...new Set(line.match(/48;2;\d+;\d+;\d+/g) ?? [])].sort().join(",");
		assert.ok(!plain(expanded)[toolRow - 1]?.trim(), "thinking 与工具卡之间要有空行");
		assert.notEqual(
			bgOf(expanded[toolRow - 1] ?? ""),
			bgOf(expanded[toolRow - 2] ?? ""),
			"工具卡前的最后一行应是内卡下 padding，空行在其外",
		);
	} finally {
		hooks.shutdown();
		setMessageDisplayTheme(previousTheme);
		config.mode = previousMode;
		emit("session_shutdown", {}, ctx);
		if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousDir;
		rmSync(dir, { recursive: true, force: true });
	}
});

test("compact 展开卡：助手文本不进面板，工具卡保留底色", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-compact-text-outside-"));
	const previousDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	const previousMode = config.mode;
	config.mode = "compact";
	const previousTheme = getMessageDisplayTheme();
	setMessageDisplayTheme({
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
		italic: (text: string) => text,
		bg: (_slot: string, text: string) => text,
		getBgAnsi: () => "\x1b[48;2;40;40;60m",
	} as any);
	const writeMetadata = new WriteExecutionMetadataStore();
	// default-mode 先装，compact 才能把它的 ccstyle 工具卡当作 toolOriginalRender。
	const defaultMode = installDefaultMode(writeMetadata);
	const { pi, ctx, emit } = extensionRuntime();
	installCompactThinking(pi, {
		useSummaryTitlesAsThinkingTitle: false,
		previewLines: 3,
		animationIntervalMs: 30,
	});
	emit("session_start", {}, ctx);
	const hooks = installCompactMode({ writeMetadata });
	try {
		const message = {
			role: "assistant",
			timestamp: 1,
			content: [
				{ type: "text", text: "let me check the file" },
				{ type: "toolCall", id: "b1", name: "bash", arguments: { command: "one" } },
			],
		};
		const bash = tool("bash", "b1", { command: "one" });
		bash.executionStarted = true;
		bash.updateDisplay?.();
		const anchor = new AssistantMessageComponent(message as any, true) as any;
		anchor.updateContent(message);
		bash.updateResult({ content: [{ type: "text", text: "line one\nline two" }], isError: false });
		anchor.setExpanded(true);

		const raw = anchor.render(120);
		const strip = (line: string) =>
			line.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/\x1b\][^\x07]*\x07/g, "");
		const textRow = raw.findIndex((line: string) => strip(line).includes("let me check the file"));
		const toolRow = raw.findIndex((line: string) => strip(line).includes("Bash one"));
		assert.ok(
			textRow >= 0 && toolRow > textRow,
			`文本应在工具卡之前: ${raw.map(strip).join("\n")}`,
		);
		assert.ok(!raw[textRow]!.includes("48;2;"), "助手文本不进面板，不应带卡片底色");
		assert.ok(raw[toolRow]!.includes("48;2;"), "工具卡仍在面板内，保留卡片底色");
		assert.equal(strip(raw[textRow + 1] ?? "").trim(), "", "助手文本与面板之间要有 1 行空行");
		assert.ok(
			!raw[textRow + 1]!.includes("48;2;"),
			"文本与面板之间的空行是卡外空行，不能带面板底色",
		);
		assert.ok(raw[textRow + 2]!.includes("48;2;"), "面板顶部要保留 1 行内层 padding，和底部对称");
	} finally {
		hooks.shutdown();
		defaultMode.shutdown();
		setMessageDisplayTheme(previousTheme);
		config.mode = previousMode;
		emit("session_shutdown", {}, ctx);
		if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousDir;
		rmSync(dir, { recursive: true, force: true });
	}
});

test("compact 展开面板留在摘要行原位，不跳到 write/edit 上方", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-compact-panel-anchor-"));
	const previousDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	const previousMode = config.mode;
	config.mode = "compact";
	const previousTheme = getMessageDisplayTheme();
	setMessageDisplayTheme({
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
		italic: (text: string) => text,
		bg: (_slot: string, text: string) => text,
	} as any);
	const writeMetadata = new WriteExecutionMetadataStore();
	const { pi, ctx, emit } = extensionRuntime();
	installCompactThinking(pi, {
		useSummaryTitlesAsThinkingTitle: false,
		previewLines: 3,
		animationIntervalMs: 30,
	});
	emit("session_start", {}, ctx);
	const hooks = installCompactMode({ writeMetadata });
	const chat = new Container();
	setToolMouseTui({ children: [chat] });
	try {
		const message = {
			role: "assistant",
			timestamp: 1,
			content: [
				{ type: "text", text: "先改写入路径" },
				{ type: "toolCall", id: "b1", name: "bash", arguments: { command: "one" } },
				{ type: "toolCall", id: "w1", name: "write", arguments: { path: "src/session.ts" } },
			],
		};
		const bash = tool("bash", "b1", { command: "one" });
		const write = tool("write", "w1", { path: "src/session.ts", content: "saved" });
		for (const item of [bash, write]) {
			item.executionStarted = true;
			item.updateDisplay?.();
		}
		const anchor = new AssistantMessageComponent(message as any, true) as any;
		chat.addChild(anchor);
		anchor.updateContent(message);
		chat.addChild(write);
		bash.updateResult({ content: [{ type: "text", text: "line one" }], isError: false });
		write.updateResult({ content: [], details: { diff: "+saved" }, isError: false });

		const plain = (lines: string[]) =>
			lines.map((line) =>
				line.replace(/\x1b\[[0-?]*[ -\/]*[@-~]/g, "").replace(/\x1b\][^\x07]*\x07/g, ""),
			);
		const folded = plain(chat.render(120));
		const summaryAt = folded.findIndex((line) => line.includes("bash×1"));
		const writeAt = folded.findIndex((line) => line.includes("write src/session.ts"));
		assert.ok(writeAt >= 0 && summaryAt > writeAt, `折叠摘要应在 write 之后: ${folded.join("\n")}`);

		anchor.setExpanded(true);
		const expanded = plain(chat.render(120));
		const textAt = expanded.findIndex((line) => line.includes("先改写入路径"));
		const writeExpandedAt = expanded.findIndex((line) => line.includes("write src/session.ts"));
		const bashAt = expanded.findIndex(
			(line) => line.includes("Bash one") || line.includes("$ one"),
		);
		assert.ok(
			textAt >= 0 && writeExpandedAt > textAt,
			`正文应仍在 write 之前: ${expanded.join("\n")}`,
		);
		assert.ok(bashAt > writeExpandedAt, `面板应留在 write 之后: ${expanded.join("\n")}`);
		assert.ok(
			componentAtLocalRow(chat, bashAt, 120)?.component === bash,
			"面板换到摘要行后仍要能点中卡内工具",
		);
	} finally {
		setToolMouseTui(null);
		hooks.shutdown();
		setMessageDisplayTheme(previousTheme);
		config.mode = previousMode;
		emit("session_shutdown", {}, ctx);
		if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousDir;
		rmSync(dir, { recursive: true, force: true });
	}
});

test("compact 展开卡：助手文本排在 thinking 前面，不被思考块盖住", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-compact-text-first-"));
	const previousDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	const previousMode = config.mode;
	config.mode = "compact";
	const previousTheme = getMessageDisplayTheme();
	setMessageDisplayTheme({
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
		italic: (text: string) => text,
		bg: (_slot: string, text: string) => text,
	} as any);
	const writeMetadata = new WriteExecutionMetadataStore();
	const { pi, ctx, emit } = extensionRuntime();
	installCompactThinking(pi, {
		useSummaryTitlesAsThinkingTitle: false,
		previewLines: 3,
		animationIntervalMs: 30,
	});
	emit("session_start", {}, ctx);
	const hooks = installCompactMode({ writeMetadata });
	try {
		// 真实流：thinking 先于 text 到达，折叠态只看得到 text + 摘要行。
		const message = {
			role: "assistant",
			timestamp: 1,
			content: [
				{ type: "thinking", thinking: "plan the round" },
				{ type: "text", text: "let me check the file" },
				{ type: "toolCall", id: "b1", name: "bash", arguments: { command: "one" } },
			],
		};
		const bash = tool("bash", "b1", { command: "one" });
		bash.executionStarted = true;
		bash.updateDisplay?.();
		const anchor = new AssistantMessageComponent(message as any, true) as any;
		anchor.updateContent(message);
		bash.updateResult({ content: [{ type: "text", text: "line one" }], isError: false });
		anchor.setExpanded(true);

		const raw = anchor
			.render(120)
			.map((line: string) =>
				line.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/\x1b\][^\x07]*\x07/g, ""),
			);
		const textRow = raw.findIndex((line: string) => line.includes("let me check the file"));
		const thinkRow = raw.findIndex((line: string) => line.includes("plan the round"));
		assert.ok(textRow >= 0 && thinkRow >= 0, `缺文本或思考: ${raw.join("\n")}`);
		assert.ok(textRow < thinkRow, "助手文本应排在 thinking 前面，展开后不被思考块盖住");
	} finally {
		hooks.shutdown();
		setMessageDisplayTheme(previousTheme);
		config.mode = previousMode;
		emit("session_shutdown", {}, ctx);
		if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousDir;
		rmSync(dir, { recursive: true, force: true });
	}
});

test("compact 面板收起后重钉视口，不跳回展开前的位置", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-compact-viewport-"));
	const previousDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	const previousMode = config.mode;
	config.mode = "compact";
	const previousTheme = getMessageDisplayTheme();
	setMessageDisplayTheme({
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
		italic: (text: string) => text,
		bg: (_slot: string, text: string) => text,
	} as any);
	const writeMetadata = new WriteExecutionMetadataStore();
	const { pi, ctx, emit } = extensionRuntime();
	installCompactThinking(pi, {
		useSummaryTitlesAsThinkingTitle: false,
		previewLines: 3,
		animationIntervalMs: 30,
	});
	emit("session_start", {}, ctx);
	const hooks = installCompactMode({ writeMetadata });
	const viewport = { scrollTop: 10, isFollowingEnd: false };
	const scrollCalls: number[] = [];
	setToolMouseTui({
		getPrimaryScrollView: () => ({
			get scrollTop() {
				return viewport.scrollTop;
			},
			get isFollowingEnd() {
				return viewport.isFollowingEnd;
			},
			scrollTo(next: number) {
				viewport.scrollTop = next;
				scrollCalls.push(next);
			},
		}),
	});
	try {
		const message = {
			role: "assistant",
			timestamp: 1,
			content: [{ type: "toolCall", id: "b1", name: "bash", arguments: { command: "one" } }],
		};
		const bash = tool("bash", "b1", { command: "one" });
		bash.executionStarted = true;
		bash.updateDisplay?.();
		const anchor = new AssistantMessageComponent(message as any, true) as any;
		anchor.updateContent(message);
		bash.updateResult({ content: [{ type: "text", text: "ok" }], isError: false });

		anchor.setExpanded(true);
		// 展开后用户滚到别处：收起保持当前位置，不回跳展开前偏移（面板在摘要行之下，
		// 删除只影响更低处，摘要行原地不动）。
		viewport.scrollTop = 40;
		anchor.setExpanded(false);
		assert.deepEqual(scrollCalls, [40], "收起应保持当前滚动偏移");
		assert.equal(viewport.scrollTop, 40);

		// 再次展开收起：同一入口重钉一次，不残留快照。
		viewport.scrollTop = 120;
		viewport.isFollowingEnd = true;
		anchor.setExpanded(true);
		viewport.scrollTop = 200;
		viewport.isFollowingEnd = false;
		anchor.setExpanded(false);
		assert.deepEqual(scrollCalls, [40, 200], "第二次收起同样保持当前位置");
	} finally {
		setToolMouseTui(null);
		hooks.shutdown();
		setMessageDisplayTheme(previousTheme);
		config.mode = previousMode;
		emit("session_shutdown", {}, ctx);
		if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousDir;
		rmSync(dir, { recursive: true, force: true });
	}
});

test("compact 折叠态工具卡复用 ccstyle 默认样式", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-compact-ccstyle-"));
	const previousDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	const previousMode = config.mode;
	config.mode = "compact";
	const previousExclude = [...config.excludeRenderers];
	const previousTheme = getMessageDisplayTheme();
	setMessageDisplayTheme({
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
		italic: (text: string) => text,
		bg: (_slot: string, text: string) => text,
	} as any);
	const writeMetadata = new WriteExecutionMetadataStore();
	// default-mode 先装，compact 才能把它的 renderPaint 当作 toolOriginalRender。
	const defaultMode = installDefaultMode(writeMetadata);
	const { pi, ctx, emit } = extensionRuntime();
	installCompactThinking(pi, {
		useSummaryTitlesAsThinkingTitle: false,
		previewLines: 3,
		animationIntervalMs: 30,
	});
	emit("session_start", {}, ctx);
	const hooks = installCompactMode({ writeMetadata });
	try {
		const message = {
			role: "assistant",
			timestamp: 1,
			content: [
				{ type: "toolCall", id: "b1", name: "bash", arguments: { command: "rg -n renderRound" } },
			],
		};
		const bash = tool("bash", "b1", { command: "rg -n renderRound" });
		bash.executionStarted = true;
		bash.updateDisplay?.();
		const anchor = new AssistantMessageComponent(message as any, true) as any;
		anchor.updateContent(message);
		bash.updateResult({ content: [{ type: "text", text: "line one\nline two" }], isError: false });
		// compact 展开卡里的工具由 ccstyle call/result 渲染
		anchor.setExpanded(true);

		const text = renderText(anchor).join("\n");
		assert.match(text, /2 lines returned/, `compact 工具卡应复用 ccstyle 摘要: ${text}`);
		assert.doesNotMatch(text, /Took /, `不应回落到原生输出: ${text}`);

		// excludeRenderers 仍然强制原生，不受这次放宽影响。
		config.excludeRenderers = ["bash"];
		bash.invalidate?.();
		const nativeText = renderText(anchor).join("\n");
		assert.doesNotMatch(nativeText, /2 lines returned/, `排除名单内应保留原生: ${nativeText}`);
		config.excludeRenderers = [...previousExclude];
	} finally {
		config.excludeRenderers = previousExclude;
		hooks.shutdown();
		defaultMode.shutdown();
		setMessageDisplayTheme(previousTheme);
		config.mode = previousMode;
		emit("session_shutdown", {}, ctx);
		if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousDir;
		rmSync(dir, { recursive: true, force: true });
	}
});

test("Running duration recomputes on each render via round wall clock", () => {
	const previousMode = config.mode;
	config.mode = "compact";
	const hooks = installCompactMode({
		query: {
			getMessageThinkingDurationMs: () => undefined,
			isMessageThinkingActive: () => false,
			getThinkingAnimationFrame: () => 0,
		},
		writeMetadata: new WriteExecutionMetadataStore(),
	});
	const realNow = Date.now;
	let now = realNow();
	Date.now = () => now;
	try {
		const msg = {
			role: "assistant",
			timestamp: 1,
			content: [{ type: "toolCall", id: "b1", name: "bash", arguments: { command: "ls" } }],
		} as unknown as AssistantMessage;
		const assistant = new AssistantMessageComponent(msg, true) as any;
		assistant.updateContent(msg);
		assert.match(renderText(assistant).join("\n"), /Running\.\.\./);

		now += 1100;
		assert.match(renderText(assistant).join("\n"), /Running\.\.\. · [1-9]\d*s, bash×1/);
	} finally {
		Date.now = realNow;
		config.mode = previousMode;
		hooks.shutdown();
	}
});

test("compact folds Agent/Task tools always; no pending outer flash", () => {
	const previousMode = config.mode;
	config.mode = "compact";
	const hooks = installCompactMode({
		query: {
			getMessageThinkingDurationMs: () => 1000,
			isMessageThinkingActive: () => false,
		},
		writeMetadata: new WriteExecutionMetadataStore(),
	});
	try {
		const msg = {
			role: "assistant",
			timestamp: 1,
			content: [
				{ type: "toolCall", id: "b1", name: "bash", arguments: { command: "ls" } },
				{ type: "toolCall", id: "a1", name: "Agent", arguments: { description: "review" } },
				{ type: "toolCall", id: "t1", name: "TaskCreate", arguments: { subject: "fix" } },
				{ type: "toolCall", id: "e1", name: "TaskExecute", arguments: { task_ids: ["1"] } },
			],
		} as unknown as AssistantMessage;
		const assistant = new AssistantMessageComponent(msg, true) as any;
		assistant.updateContent(msg);
		const bash = tool("bash", "b1", { command: "ls" });
		const agent = tool("Agent", "a1", { description: "review" });
		const task = tool("TaskCreate", "t1", { subject: "fix" });
		const exec = tool("TaskExecute", "e1", { task_ids: ["1"] });

		// pending 即折叠：禁止先外置再收回（会抖）
		assert.deepEqual(renderText(bash), []);
		assert.deepEqual(renderText(agent), [], "pending Agent folds");
		assert.deepEqual(renderText(task), [], "pending TaskCreate folds");
		assert.deepEqual(renderText(exec), [], "pending TaskExecute folds");
		assert.match(renderText(assistant).join("\n"), /Agent×1/);
		assert.match(renderText(assistant).join("\n"), /TaskCreate×1/);
		assert.match(renderText(assistant).join("\n"), /TaskExecute×1/);

		// 完成后仍折叠进摘要
		agent.updateResult({ content: [{ type: "text", text: "done" }], isError: false });
		task.updateResult({
			content: [{ type: "text", text: "Task #1 created successfully: fix" }],
			isError: false,
		});
		exec.updateResult({
			content: [{ type: "text", text: "Launched 1 agent(s)" }],
			isError: false,
		});
		assert.deepEqual(renderText(agent), []);
		assert.deepEqual(renderText(task), []);
		assert.deepEqual(renderText(exec), []);

		// background Agent tool 卡也折叠；live 面板不走此路径
		const bg = tool("Agent", "a2", {
			description: "bg",
			run_in_background: true,
		});
		bg.updateResult({
			content: [
				{
					type: "text",
					text: "Agent started in background.\nAgent ID: abc-123",
				},
			],
			isError: false,
		});
		assert.deepEqual(renderText(bg), [], "background Agent tool card folds");
	} finally {
		config.mode = previousMode;
		hooks.shutdown();
	}
});

test("compact：ask_user_question 留在外层，不进摘要，复用默认问答树", () => {
	const previousMode = config.mode;
	config.mode = "compact";
	const writeMetadata = new WriteExecutionMetadataStore();
	// default 先装，compact 才能把它的 renderPaint 当作 toolOriginalRender。
	const defaultMode = installDefaultMode(writeMetadata);
	const hooks = installCompactMode({ writeMetadata });
	try {
		const msg = {
			role: "assistant",
			timestamp: 1,
			content: [
				{ type: "toolCall", id: "b1", name: "bash", arguments: { command: "ls" } },
				{
					type: "toolCall",
					id: "ask-1",
					name: "ask_user_question",
					arguments: { questions: [{ question: "Which library?", header: "Library" }] },
				},
			],
		} as unknown as AssistantMessage;
		const assistant = new AssistantMessageComponent(msg, true) as any;
		assistant.updateContent(msg);
		const bash = tool("bash", "b1", { command: "ls" });
		const ask = tool("ask_user_question", "ask-1", {
			questions: [{ question: "Which library?", header: "Library" }],
		});
		ask.markExecutionStarted();
		ask.updateResult({
			content: [{ type: "text", text: "User answered" }],
			details: {
				cancelled: false,
				answers: [{ questionIndex: 0, question: "Which library?", kind: "option", answer: "Read" }],
			},
		});

		// 摘要只计 bash，ask_user_question 不进计数。
		const summary = renderText(assistant).join("\n");
		assert.match(summary, /bash×1/);
		assert.doesNotMatch(summary, /ask_user_question/);

		// bash 折叠进摘要，ask_user_question 留在外层，复用默认模式的问答树。
		assert.deepEqual(renderText(bash), []);
		const askLines = renderText(ask);
		assert.match(askLines[0]!, /Ask User Question \(\+1\)/);
		assert.ok(
			askLines.some((line) => / -> Read/.test(line)),
			`外层应渲染问答树: ${askLines.join(" | ")}`,
		);
	} finally {
		hooks.shutdown();
		defaultMode.shutdown();
		config.mode = previousMode;
	}
});

test("compact surfaces abort outside folded tools", () => {
	const previousMode = config.mode;
	config.mode = "compact";
	const hooks = installCompactMode({
		query: {
			getMessageThinkingDurationMs: () => 2000,
			isMessageThinkingActive: () => false,
		},
		writeMetadata: new WriteExecutionMetadataStore(),
	});
	try {
		const msg = {
			role: "assistant",
			timestamp: 1,
			stopReason: "aborted",
			errorMessage: "Operation aborted",
			content: [{ type: "toolCall", id: "b1", name: "bash", arguments: { command: "sleep" } }],
		} as unknown as AssistantMessage;
		const assistant = new AssistantMessageComponent(msg, true) as any;
		const bash = tool("bash", "b1", { command: "sleep" });
		bash.updateResult({
			content: [{ type: "text", text: "Operation aborted" }],
			isError: true,
		});
		assistant.updateContent(msg);

		const lines = renderText(assistant);
		assert.ok(
			lines.some((line) => /Ran for |Running\.\.\./.test(line) && /bash×1/.test(line)),
			`summary present, got: ${JSON.stringify(lines)}`,
		);
		assert.ok(
			lines.some((line) => line === "Operation aborted"),
			`abort must be outermost, got: ${JSON.stringify(lines)}`,
		);
		assert.deepEqual(renderText(bash), [], "aborted tool stays folded");

		// length / error 同样外露
		const lenMsg = {
			...msg,
			stopReason: "length",
			errorMessage: undefined,
		};
		assistant.updateContent(lenMsg as any);
		assert.ok(renderText(assistant).some((line) => /truncated before completion/.test(line)));
	} finally {
		config.mode = previousMode;
		hooks.shutdown();
	}
});

test("compact edit/write：计数只在正文显示一处，0 行预览带颜色", () => {
	const metadata = new WriteExecutionMetadataStore();
	const previousMode = config.mode;
	const previousTheme = getMessageDisplayTheme();
	const previousEditCollapsed = config.editDiffCollapsedLines;
	const previousWriteCollapsed = config.writeDiffCollapsedLines;
	config.mode = "compact";
	const hooks = installCompactMode({ writeMetadata: metadata });
	const strip = (lines: string[]) =>
		lines.map((line) => line.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, ""));
	const EDIT_DIFF =
		"diff --git a/a.ts b/a.ts\nindex 1..2 100644\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\n";
	try {
		// 折叠 edit：标题不带计数，0 行预览的摘要行自带 +1 -1。
		config.editDiffCollapsedLines = 0;
		const edit = tool("edit", "e1", { path: "a.ts" });
		edit.updateResult({ content: [], details: { diff: EDIT_DIFF }, isError: false });
		assert.equal(edit.render(120)[0], "", "compact file rows keep one leading blank row");
		const collapsedRich = edit.resultRendererComponent;
		edit.render(120);
		assert.equal(
			edit.resultRendererComponent,
			collapsedRich,
			"collapsed rich diff is reused across frames",
		);
		const collapsedRaw = strip(edit.render(120));
		const collapsed = collapsedRaw.join("\n");
		assert.match(collapsed, /edit a\.ts/);
		assert.doesNotMatch(collapsed, /edit a\.ts.*\(\+\d+ -\d+\)/, "标题不再重复计数");
		assert.match(collapsed, /↳ diff \+1 -1 · .*to show more/);
		assert.doesNotMatch(collapsed, /Input|Output|Details:/);

		// 计数上色：+ 绿、- 红，其余保持 muted。
		setMessageDisplayTheme({
			fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
		} as any);
		// 主题在组件构造时固化，换主题要重新 updateResult 重建 rich diff。
		edit.updateResult({ content: [], details: { diff: EDIT_DIFF }, isError: false });
		const colored = edit.render(120).join("\n");
		assert.match(colored, /<toolDiffAdded>\+1<\/toolDiffAdded>/);
		assert.match(colored, /<toolDiffRemoved>-1<\/toolDiffRemoved>/);
		setMessageDisplayTheme(previousTheme);

		// 多行预览同样只显示一处计数：标题无括号，diff 头行有。
		config.editDiffCollapsedLines = 24;
		const previewRaw = strip(edit.render(120));
		assert.doesNotMatch(previewRaw.join("\n"), /edit a\.ts.*\(\+\d+ -\d+\)/);
		assert.ok(
			previewRaw.some((line) => line.includes("+1") && line.includes("-1")),
			`多行预览的 diff 头行带计数: ${previewRaw.join(" | ")}`,
		);
		assert.ok(previewRaw.some((line) => line.includes("old")));
		assert.ok(previewRaw.some((line) => line.includes("new")));
		config.editDiffCollapsedLines = 0;

		// expanded：保留标题，复用 mode=on 的 rich diff 和展开卡背景，计数仍只在正文。
		const backgroundSlots: string[] = [];
		const cardTheme = Object.assign(Object.create(previousTheme ?? null), {
			fg: previousTheme?.fg ?? ((_color: string, text: string) => text),
			bg(slot: string, text: string) {
				backgroundSlots.push(slot);
				return text;
			},
		});
		setMessageDisplayTheme(cardTheme);
		edit.expanded = true;
		edit.render(120);
		const expandedRich = edit.resultRendererComponent;
		assert.notEqual(expandedRich, collapsedRich, "expanded bakes a separate rich diff");
		edit.render(120);
		assert.equal(edit.resultRendererComponent, expandedRich, "expanded rich diff is reused");
		const expandedRaw = edit.render(120);
		assert.equal(expandedRaw[0], "", "expanded edit keeps the gap from previous tool");
		const expandedPlain = strip(expandedRaw);
		const titlePlain = expandedPlain.find((line) => line.includes("edit a.ts")) ?? "";
		assert.match(titlePlain, /^ ✓ edit a\.ts/, "expanded title uses Box pad only");
		assert.doesNotMatch(titlePlain, /\(\+\d+ -\d+\)/);
		// ↳ 头行与标题文字列对齐（Box pad 1 + 缩进 2），body 行保持贴左。
		const diffHeader = expandedPlain.find((line) => line.includes("↳ diff")) ?? "";
		assert.match(diffHeader, /^   ↳ diff/, `↳ 与标题文字列同列: ${diffHeader}`);
		const expanded = expandedPlain.join("\n");
		assert.match(expanded, /old/);
		assert.match(expanded, /new/);
		assert.doesNotMatch(expanded, /Input|Output|Details:/);
		assert.ok(backgroundSlots.includes("toolSuccessBg"));
		// 失败的 edit 单独走自己的状态，整张展开卡改用失败底色。
		backgroundSlots.length = 0;
		edit.updateResult({ content: [], details: { diff: EDIT_DIFF }, isError: true });
		edit.render(120);
		assert.deepEqual(
			[...new Set(backgroundSlots)],
			["toolErrorBg"],
			"failed edit card uses the error background",
		);
		setMessageDisplayTheme(previousTheme);

		// edit 缺 diff 时统计未知，不能伪报 (+0 -0)，退回 Input/Output。
		const unknownEdit = tool("edit", "e2", { path: "unknown.ts" });
		unknownEdit.updateResult({
			content: [{ type: "text", text: "fallback output" }],
			isError: false,
		});
		assert.doesNotMatch(renderText(unknownEdit).join("\n"), /\(\+\d+ -\d+\)/);
		unknownEdit.expanded = true;
		const unknownEditExpanded = renderText(unknownEdit).join("\n");
		assert.equal(isExpandedToolIoView(unknownEdit.resultRendererComponent), true);
		assert.match(unknownEditExpanded, /Input/);
		assert.match(unknownEditExpanded, /Output/);
		assert.match(unknownEditExpanded, /fallback output/);
		assert.doesNotThrow(
			() => invalidateIoView(unknownEdit.resultRendererComponent),
			"fallback IO hover keeps ToolExecutionComponent.invalidate bound",
		);

		// write 折叠 0 行预览：计数在摘要行，标题不带括号。
		config.writeDiffCollapsedLines = 0;
		const write = tool("write", "w1", { path: "b.ts", content: "" });
		metadata.set("w1", { fileExistedBeforeWrite: true, previousContent: "" });
		write.updateResult({ content: [], isError: false });
		const writeCollapsed = renderText(write).join("\n");
		assert.match(writeCollapsed, /↳ diff \+0 -0 · overwritten · .*to show more/);
		assert.doesNotMatch(writeCollapsed, /write b\.ts.*\(\+\d+ -\d+\)/);

		// write 折叠预览跟 mode=on 共用 writeDiffCollapsedLines。
		const longWriteContent = Array.from(
			{ length: 40 },
			(_, index) => `const value${index} = ${index}`,
		).join("\n");
		const longWrite = tool("write", "w-limit", { path: "long.ts", content: longWriteContent });
		metadata.set("w-limit", { fileExistedBeforeWrite: false });
		longWrite.updateResult({ content: [], isError: false });
		const statsOnly = renderText(longWrite).join("\n");
		assert.match(statsOnly, /↳ diff \+40 -0 · created · .*to show more/);
		assert.doesNotMatch(statsOnly, /write long\.ts.*\(\+\d+ -\d+\)/);
		assert.doesNotMatch(statsOnly, /const value10 = 10/);
		config.writeDiffCollapsedLines = 4;
		const preview = renderText(longWrite).join("\n");
		assert.match(preview, /write long\.ts \(\+40 -0\)/, "多行预览时计数回到标题");
		assert.match(preview, /const value0 = 0/);
		assert.doesNotMatch(preview, /const value10 = 10/);
		config.writeDiffCollapsedLines = previousWriteCollapsed;

		// 元数据缺失时不能把覆盖写入伪装成新文件。
		const unknownWrite = tool("write", "w2", { path: "unknown.ts", content: "line" });
		unknownWrite.updateResult({
			content: [{ type: "text", text: "write fallback" }],
			isError: false,
		});
		assert.doesNotMatch(renderText(unknownWrite).join("\n"), /\(\+\d+ -\d+\)/);
		unknownWrite.expanded = true;
		const unknownWriteExpanded = renderText(unknownWrite).join("\n");
		assert.equal(isExpandedToolIoView(unknownWrite.resultRendererComponent), true);
		assert.match(unknownWriteExpanded, /Input/);
		assert.match(unknownWriteExpanded, /Output/);

		// 大文件超过精确统计预算时省略数字，不显示误导性的全量替换统计。
		const oldLines = Array.from({ length: 500 }, (_, index) => `line ${index}`).join("\n");
		const newLines = oldLines.replace("line 250", "changed");
		const largeWrite = tool("write", "w3", { path: "large.ts", content: newLines });
		metadata.set("w3", { fileExistedBeforeWrite: true, previousContent: oldLines });
		largeWrite.updateResult({ content: [], isError: false });
		assert.doesNotMatch(renderText(largeWrite).join("\n"), /\(\+\d+ -\d+\)/);

		// compact 路径、Input 和 Output 都不能保留终端控制序列。
		const unsafeWrite = tool("write", "w4", {
			path: "safe.ts\x1b]8;;https://evil\x07link\x1b]8;;\x07",
			content: "\x1b[31mcontent",
		});
		metadata.set("w4", { fileExistedBeforeWrite: false });
		unsafeWrite.updateResult({
			content: [{ type: "text", text: "\x1b]0;owned\x07done" }],
			isError: false,
		});
		unsafeWrite.expanded = true;
		assert.doesNotMatch(unsafeWrite.render(120).join("\n"), /\x1b\]|\x1b\[31m|\x07/);

		// write 展开同样走 rich diff；无变更时显示默认结果，不回退 Input/Output。
		write.expanded = true;
		const writeExpanded = renderText(write).join("\n");
		assert.match(writeExpanded, /write b\.ts \(\+0 -0\)/);
		assert.doesNotMatch(writeExpanded, /Input|Output|Details:/);
	} finally {
		setMessageDisplayTheme(previousTheme);
		config.mode = previousMode;
		config.editDiffCollapsedLines = previousEditCollapsed;
		config.writeDiffCollapsedLines = previousWriteCollapsed;
		hooks.shutdown();
	}
});

test("compact edit/write summaries preserve filenames for long cwd paths", () => {
	const { restore } = installHooks();
	try {
		const path = join(
			process.cwd(),
			"extensions",
			"very-long-feature-name",
			"nested-renderer-implementation",
			"target-file.ts",
		);
		for (const [name, id] of [
			["edit", "long-edit"],
			["write", "long-write"],
		] as const) {
			const component = tool(name, id, { path });
			component.updateResult({ content: [], isError: false });
			const title = renderText(component, 50).find((line) => line.includes(name));
			assert.match(title!, new RegExp(`${name} .*target-file\\.ts`));
			assert.doesNotMatch(title!, new RegExp(process.cwd().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
		}
	} finally {
		restore();
	}
});

test("compact 折叠行 hover 只高亮展开提示：edit 失败单行与 rich diff 兼容", () => {
	const previousMode = config.mode;
	const previousTheme = getMessageDisplayTheme();
	config.mode = "compact";
	const hooks = installCompactMode({ writeMetadata: new WriteExecutionMetadataStore() });
	const restore = () => {
		setHoveredToolCallId(null);
		setMessageDisplayTheme(previousTheme);
		hooks.shutdown();
		config.mode = previousMode;
	};
	try {
		setMessageDisplayTheme({
			fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
		} as any);
		// 失败的 edit 没有 rich diff，提示挂在标题行上。
		const failed = tool("edit", "e-fail", { path: "a.ts" });
		failed.updateResult({ content: [{ type: "text", text: "boom" }], isError: true });
		const line = () => failed.render(120).join("\n");
		assert.match(line(), /<dim> · <\/dim><dim>click to show more<\/dim>/);
		setHoveredToolCallId("e-fail");
		assert.match(line(), /<dim> · <\/dim><text>click to show more<\/text>/);
		assert.doesNotMatch(line(), /<text>[^<]*(?:a\.ts|edit)/, "hover 只改提示，不改标题与路径");
		setHoveredToolCallId(null);
		assert.match(line(), /<dim> · <\/dim><dim>click to show more<\/dim>/);
	} finally {
		restore();
	}
});

test("sync collects mounted resume components before applying global expansion", () => {
	const previousMode = config.mode;
	config.mode = "compact";
	const msg = toolCallMessage(7);
	const assistant = new AssistantMessageComponent(msg, true) as any;
	const hooks = installCompactMode({ writeMetadata: new WriteExecutionMetadataStore() });
	try {
		refreshCompactModeComponents({ children: [assistant] });
		hooks.sync({ ui: { getToolsExpanded: () => true } });
		assert.equal(assistant.expanded, true);
		assert.equal(typeof assistant.setExpanded, "function");
	} finally {
		config.mode = previousMode;
		hooks.shutdown();
	}
});

test("shutdown restores prototypes; reload replaces the patch without recursion", () => {
	const assistantPrototype = AssistantMessageComponent.prototype as any;
	const toolPrototype = ToolExecutionComponent.prototype as any;
	const originalUpdateContent = assistantPrototype.updateContent;
	const originalRender = toolPrototype.render;
	const originalUpdateDisplay = toolPrototype.updateDisplay;
	const previousMode = config.mode;
	config.mode = "compact";
	const first = installCompactMode({ writeMetadata: new WriteExecutionMetadataStore() });
	try {
		assert.notEqual(assistantPrototype.updateContent, originalUpdateContent);
		const firstPatch = assistantPrototype.updateContent;
		const msg = toolCallMessage(9);
		const assistant = new AssistantMessageComponent(msg, true) as any;
		assistant.updateContent(msg);
		const firstSetter = assistant.setExpanded;
		assert.equal(typeof firstSetter, "function");

		const second = installCompactMode({ writeMetadata: new WriteExecutionMetadataStore() });
		const secondPatch = assistantPrototype.updateContent;
		assert.notEqual(secondPatch, firstPatch, "reload installs a fresh patch");
		assert.notEqual(secondPatch, originalUpdateContent);
		assert.equal(assistant.setExpanded, undefined, "reload detaches the previous instance patch");

		// 现有 transcript 组件由新补丁重新接管，且不递归到旧 round 闭包。
		assistant.updateContent(msg);
		assert.equal(renderText(assistant).length, 1);
		assert.equal(typeof assistant.setExpanded, "function");
		assert.notEqual(assistant.setExpanded, firstSetter);
		assert.equal(isCompactAssistantComponent(assistant), true);

		first.shutdown();
		assert.equal(
			assistantPrototype.updateContent,
			secondPatch,
			"stale shutdown keeps the new patch",
		);
		second.shutdown();
		assert.equal(assistantPrototype.updateContent, originalUpdateContent);
		assert.equal(toolPrototype.render, originalRender);
		assert.equal(toolPrototype.updateDisplay, originalUpdateDisplay);
	} finally {
		config.mode = previousMode;
		if (assistantPrototype.updateContent !== originalUpdateContent) {
			assistantPrototype.updateContent = originalUpdateContent;
		}
		if (toolPrototype.render !== originalRender) toolPrototype.render = originalRender;
		if (toolPrototype.updateDisplay !== originalUpdateDisplay) {
			toolPrototype.updateDisplay = originalUpdateDisplay;
		}
	}
});

test("isCompactAssistantComponent gates on compact mode; setExpanded no-ops outside", () => {
	const { restore } = installHooks();
	try {
		const msg = toolCallMessage(1);
		const assistant = new AssistantMessageComponent(msg, true) as any;
		assistant.updateContent(msg);
		assert.equal(isCompactAssistantComponent(assistant), true);

		let updates = 0;
		const originalUpdate = assistant.updateContent.bind(assistant);
		assistant.updateContent = (message: any) => {
			updates++;
			return originalUpdate(message);
		};

		// compact 下 setExpanded 更新整轮展开状态。
		assistant.setExpanded(true);
		assert.equal(assistant.expanded, true);

		// 切 on：识别失效，setExpanded 只保持原生字段不触发重绘。
		config.mode = "on";
		assert.equal(isCompactAssistantComponent(assistant), false);
		const before = updates;
		const expandedBefore = assistant.expanded;
		assistant.setExpanded(false);
		assert.equal(updates, before, "setExpanded is a no-op outside compact mode");
		assert.equal(assistant.expanded, expandedBefore);
		assert.equal(typeof assistant.setExpanded, "undefined");

		// on 模式新实例不装 setExpanded（不产生 compact 标记）。
		const fresh = new AssistantMessageComponent(msg, true) as any;
		fresh.updateContent(msg);
		assert.equal(typeof fresh.setExpanded, "undefined");
		assert.equal(isCompactAssistantComponent(fresh), false);
	} finally {
		restore();
	}
});

test("unknown assistant wrappers keep ownership without creating a recursion cycle", () => {
	const prototype = AssistantMessageComponent.prototype as any;
	const original = prototype.updateContent;
	const previousMode = config.mode;
	config.mode = "compact";
	const hooks = installCompactMode({ writeMetadata: new WriteExecutionMetadataStore() });
	const compactPatch = prototype.updateContent;
	const external = function (this: any, message: any) {
		return compactPatch.call(this, message);
	};
	prototype.updateContent = external;
	try {
		hooks.assertOwnership();
		assert.equal(prototype.updateContent, external);
		const msg = toolCallMessage(11);
		const assistant = new AssistantMessageComponent(msg, true) as any;
		assistant.updateContent(msg);
		assert.equal(renderText(assistant).length, 1);
	} finally {
		hooks.shutdown();
		prototype.updateContent = original;
		config.mode = previousMode;
	}
});

test("refreshMountedTranscript asserts compact ownership before redraw (resume without new messages)", async () => {
	// resume 场景：renderer 先装 compact 补丁，compact-thinking 后装（外层）。
	// 无新消息 → message_update 的重新认领不触发 → 链序反。
	// refreshMountedTranscript 必须先断言链序再重绘，round 摘要才含工具统计。
	const dir = mkdtempSync(join(tmpdir(), "pi-compact-resume-"));
	const previousDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	const previousMode = config.mode;
	config.mode = "compact";
	const { pi, ctx, emit } = extensionRuntime();
	try {
		claudeCodeStyleExtension(pi, { mode: "compact" });
		installCompactThinking(pi, {
			useSummaryTitlesAsThinkingTitle: false,
			previewLines: 0,
			animationIntervalMs: 30,
		});
		await emit("session_start", {}, ctx);
		// 不等 renderer 的 setTimeout(syncCompactMode)：模拟无新消息的 resume。
		const msg = toolCallMessage(Date.now());
		const component = new AssistantMessageComponent(msg, true) as any;
		const tui = { getMountedRoots: () => [component] } as any;
		refreshMountedTranscript(tui);
		const lines = renderText(component);
		assert.ok(
			lines.some((line) => /bash×1/.test(line)),
			`round summary must include tool counts, got: ${JSON.stringify(lines)}`,
		);
	} finally {
		config.mode = previousMode;
		await emit("session_shutdown", {}, ctx);
		if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousDir;
		rmSync(dir, { recursive: true, force: true });
	}
});

test("session_start and session_tree keep the compact patch outermost over compact-thinking", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-compact-mode-"));
	const previousDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	const previousMode = config.mode;
	config.mode = "compact";
	const { pi, ctx, emit } = extensionRuntime();
	const assistantPrototype = AssistantMessageComponent.prototype as any;
	const toolPrototype = ToolExecutionComponent.prototype as any;
	const originalUpdateContent = assistantPrototype.updateContent;
	const originalToolUpdateDisplay = toolPrototype.updateDisplay;
	try {
		claudeCodeStyleExtension(pi, { mode: "compact" });
		installCompactThinking(pi, {
			useSummaryTitlesAsThinkingTitle: false,
			previewLines: 0,
			animationIntervalMs: 30,
		});
		await emit("session_start", {}, ctx);
		// renderer 的 session_start 先于 compact-thinking 执行；延迟 sync 重新认领。
		await new Promise<void>((resolve) => setTimeout(resolve, 10));

		const msg = toolCallMessage(Date.now());
		const component = new AssistantMessageComponent(msg, true) as any;
		component.updateContent(msg);
		const lines = renderText(component);
		assert.equal(lines.length, 1, "compact summary stays outermost over the thinking patch");
		assert.match(lines[0], /bash×1/);

		// session_tree 后 resume 历史仍由 compact 补丁外层持有。
		await emit("session_tree", {}, ctx);
		const nextMessage = {
			...toolCallMessage(Date.now() + 1),
			content: [
				{ type: "text", text: "next" },
				{ type: "toolCall", name: "bash", arguments: { command: "echo" } },
			],
		};
		const afterTree = new AssistantMessageComponent(nextMessage as any, true) as any;
		afterTree.updateContent(nextMessage);
		// 未挂进容器的独立组件并入上一个 activeRound；摘要行落在该回合的 anchor 上。
		assert.match(renderText(component).join("\n"), /bash×2/, "同一回合累计两次 bash");

		// shutdown 恢复原生原型。
		await emit("session_shutdown", {}, ctx);
		assert.equal(assistantPrototype.updateContent, originalUpdateContent);
		assert.equal(toolPrototype.updateDisplay, originalToolUpdateDisplay);
	} finally {
		config.mode = previousMode;
		await emit("session_shutdown", {}, ctx);
		if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousDir;
		rmSync(dir, { recursive: true, force: true });
	}
});

test("isStreaming survives the compact + compact-thinking patch chain (mermaid flicker regression)", async () => {
	const previousMode = config.mode;
	const { pi, ctx, emit } = extensionRuntime();
	const assistantPrototype = AssistantMessageComponent.prototype as any;
	const originalUpdateContent = assistantPrototype.updateContent;
	try {
		config.mode = "on";
		claudeCodeStyleExtension(pi, { mode: "on" });
		installCompactThinking(pi, {
			useSummaryTitlesAsThinkingTitle: false,
			previewLines: 0,
			animationIntervalMs: 30,
		});
		// 真实链序：compact-thinking 先装，compact-mode 在其外层再装。
		await emit("session_start", {}, ctx);

		const seen: boolean[] = [];
		const component = new AssistantMessageComponent(undefined, false, undefined, undefined, 1, [
			(markdown: string, tctx: any) => {
				seen.push(tctx.isStreaming);
				return markdown;
			},
		]);
		const message = {
			role: "assistant",
			timestamp: Date.now(),
			content: [{ type: "text", text: "hello" }],
		} as unknown as AssistantMessage;

		component.updateContent(message, true);
		component.render(120);
		component.updateContent(message, false);
		component.render(120);

		assert.deepEqual(
			seen,
			[true, false],
			`transformer must see streaming then final: ${JSON.stringify(seen)}`,
		);
	} finally {
		config.mode = previousMode;
		await emit("session_shutdown", {}, ctx);
		assistantPrototype.updateContent = originalUpdateContent;
	}
});

test("compact：外层工具打断摘要段，前后各一条摘要行", () => {
	const { restore } = installHooks();
	const chat = new Container() as any;
	setToolMouseTui({ children: [chat] });
	try {
		// 段一：inner 工具。
		const m1 = {
			role: "assistant",
			timestamp: 1,
			stopReason: "toolUse",
			content: [{ type: "toolCall", id: "b1", name: "bash", arguments: { command: "one" } }],
		};
		const a1 = new AssistantMessageComponent(m1 as any, true) as any;
		const bash = tool("bash", "b1", { command: "one" });
		chat.addChild(a1);
		chat.addChild(bash);
		a1.updateContent(m1);

		// 段二：edit 外层行（新消息、新回合）。
		const m2 = {
			role: "assistant",
			timestamp: 2,
			stopReason: "toolUse",
			content: [{ type: "toolCall", id: "e1", name: "edit", arguments: { path: "a.ts" } }],
		};
		const a2 = new AssistantMessageComponent(m2 as any, true) as any;
		const edit = tool("edit", "e1", { path: "a.ts" });
		chat.addChild(a2);
		chat.addChild(edit);
		a2.updateContent(m2);

		// 段三：inner 工具再续。
		const m3 = {
			role: "assistant",
			timestamp: 3,
			stopReason: "toolUse",
			content: [{ type: "toolCall", id: "r1", name: "read", arguments: { path: "a.ts" } }],
		};
		const a3 = new AssistantMessageComponent(m3 as any, true) as any;
		const read = tool("read", "r1", { path: "a.ts" });
		chat.addChild(a3);
		chat.addChild(read);
		a3.updateContent(m3);

		const tails = chat.children.filter(
			(c: any) =>
				isCompactAssistantComponent(c) &&
				/(?:Running\.\.\.|Ran for)/.test(renderText(c).join("\n")),
		);
		assert.equal(tails.length, 2, `应有两条摘要行: ${chat.children.length}`);

		// 段一已完结（edit 到来即 seal），段二 edit 独段无摘要，段三仍在跑。
		const text = renderText(chat).join("\n");
		assert.match(text, /Ran for .*bash×1/);
		assert.match(text, /Running\.\.\..*read×1/);

		// 顺序：a1, bash, tail1, a2, edit, a3, read, tail2。
		const labels = chat.children.map((c: any) =>
			c === tails[0]
				? "tail1"
				: c === tails[1]
					? "tail2"
					: c === a1
						? "a1"
						: c === a2
							? "a2"
							: c === a3
								? "a3"
								: "tool",
		);
		assert.deepEqual(labels, ["a1", "tool", "tail1", "a2", "tool", "a3", "tool", "tail2"]);
	} finally {
		setToolMouseTui(null);
		restore();
	}
});

test("compact：custom 通知不打断摘要段，原地留在成员之间", () => {
	const { restore } = installHooks();
	const chat = new Container() as any;
	setToolMouseTui({ children: [chat] });
	try {
		const m1 = {
			role: "assistant",
			timestamp: 1,
			stopReason: "toolUse",
			content: [{ type: "toolCall", id: "b1", name: "bash", arguments: { command: "one" } }],
		};
		const a1 = new AssistantMessageComponent(m1 as any, true) as any;
		const bash = tool("bash", "b1", { command: "one" });
		chat.addChild(a1);
		chat.addChild(bash);
		a1.updateContent(m1);

		// custom 通知插在回合中间：透明成员，不分段、不挪位。
		const notice = new CustomMessageComponent(
			{ role: "custom", customType: "test-notice", content: [], display: true } as any,
			undefined,
		) as any;
		chat.addChild(notice);

		const m2 = {
			role: "assistant",
			timestamp: 2,
			stopReason: "toolUse",
			content: [{ type: "toolCall", id: "b2", name: "bash", arguments: { command: "two" } }],
		};
		const a2 = new AssistantMessageComponent(m2 as any, true) as any;
		const bash2 = tool("bash", "b2", { command: "two" });
		chat.addChild(a2);
		chat.addChild(bash2);
		a2.updateContent(m2);

		// 仍是一条摘要行，bash 计数合并。
		const tails = chat.children.filter(
			(c: any) =>
				isCompactAssistantComponent(c) &&
				/(?:Running\.\.\.|Ran for)/.test(renderText(c).join("\n")),
		);
		assert.equal(tails.length, 1, `通知不应拆段: ${chat.children.length}`);
		assert.match(renderText(tails[0]).join("\n"), /bash×2/);
		// 通知保持在 a1/bash 与 a2/bash2 之间，不被搬到摘要行之下。
		const noticeIdx = chat.children.indexOf(notice);
		const bashIdx = chat.children.indexOf(bash);
		const a2Idx = chat.children.indexOf(a2);
		assert.ok(noticeIdx > bashIdx && noticeIdx < a2Idx, `通知原地保留 (idx=${noticeIdx})`);
	} finally {
		setToolMouseTui(null);
		restore();
	}
});
