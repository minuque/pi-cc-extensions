import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AssistantMessageComponent, initTheme } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";

import { config as ccstyleConfig } from "../extensions/config/config.ts";
import {
	clearThinkingPreviewCache,
	installCompactThinking,
	ThinkingPreviewBlock,
} from "../extensions/feature/compact-thinking.ts";
import { animateCompactThinkingText } from "../extensions/renderer/compact-mode.ts";

const config = {
	useSummaryTitlesAsThinkingTitle: false,
	previewLines: 0,
	animationIntervalMs: 30,
};

test("collapsed thinking previews memoize complete output until invalidated", () => {
	const originalConfig = { ...config };
	const { pi } = runtime();
	const controller = installCompactThinking(pi, { ...originalConfig });
	controller.updateConfig({ ...originalConfig, previewLines: 1 });
	clearThinkingPreviewCache();
	try {
		const preview = new ThinkingPreviewBlock(
			"Thought",
			"alpha beta gamma delta epsilon zeta eta theta",
			0,
			1,
			(text) => text,
		);
		const first = preview.render(12);
		assert.ok(
			first.some((line) => line.includes("more")),
			"composed output includes its hint",
		);
		assert.strictEqual(preview.render(12), first, "same state reuses complete output");

		assert.notStrictEqual(preview.render(16), first, "width changes recompute output");
		const beforeConfigChange = preview.render(16);
		controller.updateConfig({ ...originalConfig, previewLines: 2 });
		assert.notStrictEqual(
			preview.render(16),
			beforeConfigChange,
			"preview-line changes recompute output",
		);

		const beforeHover = preview.render(16);
		preview.setHintHovered(true);
		assert.notStrictEqual(preview.render(16), beforeHover, "hover changes recompute output");

		const beforeInvalidation = preview.render(16);
		preview.invalidate();
		assert.notStrictEqual(preview.render(16), beforeInvalidation, "invalidation clears memo");
	} finally {
		controller.updateConfig(originalConfig);
		clearThinkingPreviewCache();
	}
});

test("compact summary reuses compact-thinking's sweep animation", () => {
	const theme = {
		fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
		italic: (text: string) => `<i>${text}</i>`,
		bold: (text: string) => `<b>${text}</b>`,
	} as any;
	const first = animateCompactThinkingText("Thinking...", theme, 0);
	const second = animateCompactThinkingText("Thinking...", theme, 1);
	assert.notEqual(first, second);
	assert.equal(first.replace(/<[^>]+>/g, ""), "Thinking...");
	assert.equal(second.replace(/<[^>]+>/g, ""), "Thinking...");
});

function runtime() {
	const handlers = new Map<string, Function[]>();
	return {
		handlers,
		pi: {
			on(name: string, handler: Function) {
				const list = handlers.get(name) ?? [];
				list.push(handler);
				handlers.set(name, list);
			},
			appendEntry() {},
		} as any,
		emit(name: string, event: any = {}, ctx: any = {}) {
			for (const handler of handlers.get(name) ?? []) handler(event, ctx);
		},
	};
}

const tuiCtx = {
	mode: "tui",
	sessionManager: { getBranch: () => [], getEntries: () => [] },
	ui: { theme: {}, setWidget() {}, requestRender() {} },
};

const headlessCtx = {
	mode: "print",
	hasUI: false,
	sessionManager: { getBranch: () => [], getEntries: () => [] },
	ui: { theme: {}, setWidget() {}, requestRender() {} },
};

test("compact thinking patches the runtime component with ccstyle config", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-compact-thinking-"));
	const previousDir = process.env.PI_CODING_AGENT_DIR;
	const { emit, pi } = runtime();
	process.env.PI_CODING_AGENT_DIR = dir;
	const original = AssistantMessageComponent.prototype.updateContent;
	try {
		installCompactThinking(pi, config);
		// Lazy: prototype stays original until a TUI session starts.
		assert.equal(AssistantMessageComponent.prototype.updateContent, original);
		emit("session_start", {}, tuiCtx);
		assert.notEqual(AssistantMessageComponent.prototype.updateContent, original);
		assert.equal(
			existsSync(join(dir, "compact-thinking.json")),
			false,
			"activate must not leave compact-thinking.json behind",
		);
	} finally {
		emit("session_shutdown", {}, tuiCtx);
		if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousDir;
		rmSync(dir, { recursive: true, force: true });
	}
});

test("reload keeps the replacement compact-thinking prototype patch", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-compact-thinking-reload-"));
	const previousDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	const original = AssistantMessageComponent.prototype.updateContent;
	const first = runtime();
	const second = runtime();
	try {
		installCompactThinking(first.pi, config);
		first.emit("session_start", {}, tuiCtx);
		const firstPatch = AssistantMessageComponent.prototype.updateContent;

		installCompactThinking(second.pi, config);
		second.emit("session_start", {}, tuiCtx);
		const replacementPatch = AssistantMessageComponent.prototype.updateContent;
		assert.notEqual(replacementPatch, firstPatch);
		first.emit("session_shutdown", {}, tuiCtx);
		assert.equal(AssistantMessageComponent.prototype.updateContent, replacementPatch);

		second.emit("session_shutdown", {}, tuiCtx);
		assert.equal(AssistantMessageComponent.prototype.updateContent, original);
	} finally {
		if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousDir;
		rmSync(dir, { recursive: true, force: true });
	}
});

test("headless subagent runtime does not steal the parent thinking patch", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-compact-thinking-isolate-"));
	const previousDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	const original = AssistantMessageComponent.prototype.updateContent;
	const parent = runtime();
	const nested = runtime();
	try {
		installCompactThinking(parent.pi, config);
		parent.emit("session_start", {}, tuiCtx);
		const parentPatch = AssistantMessageComponent.prototype.updateContent;
		assert.notEqual(parentPatch, original);

		installCompactThinking(nested.pi, config);
		nested.emit("session_start", {}, headlessCtx);
		assert.equal(
			AssistantMessageComponent.prototype.updateContent,
			parentPatch,
			"headless install must not replace the parent prototype patch",
		);

		nested.emit("session_shutdown", {}, headlessCtx);
		assert.equal(
			AssistantMessageComponent.prototype.updateContent,
			parentPatch,
			"headless shutdown must not tear down the parent patch",
		);
	} finally {
		parent.emit("session_shutdown", {}, tuiCtx);
		if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousDir;
		rmSync(dir, { recursive: true, force: true });
	}
});

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

function thinkingMessage(timestamp: number, withAgent = true) {
	return {
		role: "assistant",
		timestamp,
		content: [
			{
				type: "thinking",
				thinking: "plan",
				thinkingSignature: { kind: "agent_summary", title: "Plan", body: "..." },
			},
			...(withAgent ? [{ type: "toolCall", name: "Agent", arguments: {} }] : []),
		],
	} as unknown as AssistantMessage;
}

function themeCtx(sessionManager: any = { getBranch: () => [], getEntries: () => [] }) {
	return {
		mode: "tui",
		sessionManager,
		ui: {
			theme: { fg: (_c: string, t: string) => t, italic: (t: string) => t, bold: (t: string) => t },
			setWidget() {},
			requestRender() {},
		},
	};
}

test("session tree restores durations from all entries so old messages keep Thought for", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-compact-thinking-restore-"));
	const previousDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	const { emit, pi } = runtime();
	let durationEntry: any = {
		type: "custom",
		customType: "compact-thinking-duration",
		data: { messageTimestamp: 0, contentIndex: 0, durationMs: 1234 },
	};
	const sessionManager = {
		// getBranch mirrors the leaf path after compaction: it no longer contains
		// the finished message's duration entry. getEntries still has it.
		getBranch: () => [] as any[],
		getEntries: () => [durationEntry],
	};
	const uiCtx = themeCtx(sessionManager);
	try {
		installCompactThinking(pi, config);
		emit("session_start", {}, uiCtx);

		const oldTs = Date.now() - 60_000;
		durationEntry.data.messageTimestamp = oldTs;
		const msg = thinkingMessage(oldTs, false);
		emit("message_update", {
			message: msg,
			assistantMessageEvent: { type: "thinking_start", contentIndex: 0 },
		});
		emit("message_update", {
			message: msg,
			assistantMessageEvent: { type: "thinking_delta", contentIndex: 0 },
		});
		await new Promise((resolve) => setTimeout(resolve, 60));
		emit("message_update", {
			message: msg,
			assistantMessageEvent: { type: "toolcall_start", contentIndex: 1 },
		});

		// compaction: session_tree with a leaf path that no longer includes the message
		emit("session_tree", {}, uiCtx);

		// scrolling back re-renders the old message in a fresh component
		const old = new AssistantMessageComponent(msg, true);
		old.updateContent(msg);
		const lines = renderText(old);
		assert.ok(
			lines.some((line) => line.startsWith("Thought for")),
			`old message keeps its duration after compaction, got: ${lines[0]}`,
		);
		assert.ok(!lines.some((line) => line.includes("Thinking...")), "no bare Thinking... fallback");
	} finally {
		emit("session_shutdown", {}, uiCtx);
		if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousDir;
		rmSync(dir, { recursive: true, force: true });
	}
});

test("compact summary keeps the shared animation alive until the next assistant message", async () => {
	const { emit, pi } = runtime();
	const uiCtx = themeCtx();
	const controller = installCompactThinking(pi, config);
	try {
		emit("session_start", {}, uiCtx);
		const message = {
			...thinkingMessage(Date.now(), false),
			content: [
				{ type: "thinking", thinking: "plan" },
				{ type: "toolCall", name: "bash", args: {} },
			],
		};
		emit("message_update", {
			message,
			assistantMessageEvent: { type: "thinking_start", contentIndex: 0 },
		});
		controller.setCompactSummaryActive?.(true);
		emit("message_update", {
			message,
			assistantMessageEvent: { type: "toolcall_start", contentIndex: 1 },
		});
		assert.equal(controller.isMessageThinkingActive?.(message.timestamp), false);
		const runningFrame = controller.getThinkingAnimationFrame?.() ?? 0;
		await new Promise((resolve) => setTimeout(resolve, 70));
		assert.ok((controller.getThinkingAnimationFrame?.() ?? 0) > runningFrame);

		controller.setCompactSummaryActive?.(false);
		const stoppedFrame = controller.getThinkingAnimationFrame?.() ?? 0;
		await new Promise((resolve) => setTimeout(resolve, 70));
		assert.equal(controller.getThinkingAnimationFrame?.(), stoppedFrame);
	} finally {
		emit("session_shutdown", {}, uiCtx);
	}
});

test("Agent tool execution keeps the thinking animation until the next boundary", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-compact-thinking-agent-"));
	const previousDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	const { emit, pi } = runtime();
	const uiCtx = themeCtx();
	try {
		const controller = installCompactThinking(pi, config);
		emit("session_start", {}, uiCtx);

		const ts = Date.now();
		const msg = thinkingMessage(ts, true); // thinking + Agent toolCall
		emit("message_update", {
			message: msg,
			assistantMessageEvent: { type: "thinking_start", contentIndex: 0 },
		});
		emit("message_update", {
			message: msg,
			assistantMessageEvent: { type: "thinking_delta", contentIndex: 0 },
		});
		await new Promise((resolve) => setTimeout(resolve, 60));
		assert.equal(controller.isMessageThinkingActive?.(ts), true);
		assert.ok(
			(controller.getThinkingAnimationFrame?.() ?? 0) > 0,
			"animation frame follows compact-thinking's configured timer",
		);
		assert.ok(
			(controller.getMessageThinkingDurationMs?.(ts) ?? 0) > 0,
			"active thinking exposes compact-thinking's live elapsed duration",
		);
		// toolcall_start carries the Agent toolCall: animation must survive
		emit("message_update", {
			message: msg,
			assistantMessageEvent: { type: "toolcall_start", contentIndex: 1 },
		});

		// Real agent-loop order: message_end, then tool_execution_start(Agent).
		emit("message_end", { message: msg }, uiCtx);
		emit("tool_execution_start", { toolName: "Agent", toolCallId: "c1", args: {} }, uiCtx);

		// Nested headless runtime must not kill the ticker mid-run.
		const nested = runtime();
		installCompactThinking(nested.pi, config);
		nested.emit("session_start", {}, headlessCtx);

		const midAgent = new AssistantMessageComponent(msg, true);
		midAgent.updateContent(msg);
		const midLines = renderText(midAgent);
		assert.ok(
			midLines.some((line) => line.includes("Thinking")),
			`during Agent execution the thinking ticker stays active, got: ${midLines[0]}`,
		);
		assert.ok(
			!midLines.some((line) => line.includes("Thought for")),
			"not finalized while the subagent runs",
		);

		// tool_execution_end(Agent): finalize once the subagent returns
		emit(
			"tool_execution_end",
			{ toolName: "Agent", toolCallId: "c1", result: {}, isError: false },
			uiCtx,
		);
		assert.equal(controller.isMessageThinkingActive?.(ts), false);
		assert.ok(
			(controller.getMessageThinkingDurationMs?.(ts) ?? 0) > 0,
			"completed thinking exposes its final duration",
		);
		const after = new AssistantMessageComponent(msg, true);
		after.updateContent(msg);
		const afterLines = renderText(after);
		assert.ok(
			afterLines.some((line) => line.startsWith("Thought for")),
			`finalized once the subagent ends, got: ${afterLines[0]}`,
		);

		nested.emit("session_shutdown", {}, headlessCtx);
	} finally {
		emit("session_shutdown", {}, uiCtx);
		if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousDir;
		rmSync(dir, { recursive: true, force: true });
	}
});

test("reload/resume rebuild: mounted-tree scan re-renders rebuilt components", async () => {
	initTheme("dark");
	const dir = mkdtempSync(join(tmpdir(), "pi-compact-thinking-rescan-"));
	const previousDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	const { Container } = await import("@earendil-works/pi-tui");
	const parent = new Container() as any;
	const tui = {
		mode: "regular",
		getMountedRoots: () => [parent],
		requestRender() {},
	};
	const entries: any[] = [];
	const sessionManager = { getBranch: () => entries, getEntries: () => entries };
	const ctx = {
		mode: "tui",
		sessionManager,
		ui: {
			theme: { fg: (_c: string, t: string) => t, italic: (t: string) => t },
			setWidget(_key: string, factory: any) {
				if (typeof factory === "function") factory(tui);
			},
			requestRender() {},
		},
	} as any;
	const first = runtime();
	first.pi.appendEntry = (_type: string, data: unknown) =>
		entries.push({ type: "custom", customType: "compact-thinking-duration", data });
	try {
		installCompactThinking(first.pi, config);
		first.emit("session_start", {}, ctx);

		// live run: thinking then toolcall records the duration entry
		const ts = Date.now();
		const msg = thinkingMessage(ts, false);
		first.emit(
			"message_update",
			{ message: msg, assistantMessageEvent: { type: "thinking_start", contentIndex: 0 } },
			ctx,
		);
		await new Promise((resolve) => setTimeout(resolve, 30));
		first.emit(
			"message_update",
			{ message: msg, assistantMessageEvent: { type: "toolcall_start", contentIndex: 1 } },
			ctx,
		);

		first.emit("session_shutdown", { reason: "reload" }, ctx);

		// pi rebuildChatFromMessages: fresh components with the restored ORIGINAL prototype
		parent.clear();
		const rebuilt = new AssistantMessageComponent(msg, true) as any;
		parent.addChild(rebuilt);
		assert.ok(
			renderText(rebuilt).some((line) => line.startsWith("Thinking...")),
			"native rebuild shows the bare Thinking... label",
		);

		// new extension instance: session_start scans the mounted tree and re-renders
		const second = runtime();
		installCompactThinking(second.pi, config);
		second.emit("session_start", { reason: "reload" }, ctx);
		const lines = renderText(rebuilt);
		assert.ok(
			lines.some((line) => line.startsWith("Thought for")),
			`rebuilt component recovers its duration, got: ${JSON.stringify(lines)}`,
		);
		assert.ok(
			!lines.some((line) => line.includes("Thinking...")),
			`no bare Thinking... fallback after reload, got: ${JSON.stringify(lines)}`,
		);

		second.emit("session_shutdown", {}, ctx);
	} finally {
		first.emit("session_shutdown", {}, ctx);
		if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousDir;
		rmSync(dir, { recursive: true, force: true });
	}
});

test("completed run without duration never falls back to the loading label", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-compact-thinking-fallback-"));
	const previousDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	const { emit, pi } = runtime();
	const ctx = {
		mode: "tui",
		sessionManager: { getBranch: () => [], getEntries: () => [] },
		ui: {
			theme: { fg: (_c: string, t: string) => t, italic: (t: string) => t },
			setWidget(_key: string, factory: any) {
				if (typeof factory === "function") factory({ requestRender() {} });
			},
			requestRender() {},
		},
	} as any;
	try {
		installCompactThinking(pi, { ...config, useSummaryTitlesAsThinkingTitle: true });
		emit("session_start", {}, ctx);
		// completed run with no duration entry: summary title preferred, then "Thought"
		const withSummary = {
			...thinkingMessage(Date.now(), false),
			api: "openai-responses",
			content: [
				{
					type: "thinking",
					thinking: "**Plan**\n\nFirst do A",
					thinkingSignature: {
						type: "reasoning",
						summary: [{ type: "summary_text", text: "**Plan**\n\nFirst do A" }],
					},
				},
				{ type: "toolCall", name: "bash", args: {}, id: "c1" },
			],
		} as any;
		const component = new AssistantMessageComponent(withSummary, true) as any;
		component.updateContent(withSummary);
		const withSummaryLines = renderText(component);
		assert.ok(
			withSummaryLines.some((line) => line.includes("Plan")),
			`summary title shown for completed run, got: ${JSON.stringify(withSummaryLines)}`,
		);
		assert.ok(
			!withSummaryLines.some((line) => line.includes("Thinking...")),
			"no loading label for a completed run",
		);

		const plain = thinkingMessage(Date.now(), false);
		const plainComponent = new AssistantMessageComponent(plain, true) as any;
		plainComponent.updateContent(plain);
		const plainLines = renderText(plainComponent);
		assert.ok(
			plainLines.some((line) => line.includes("Thought")),
			`neutral fallback for run without title or duration, got: ${JSON.stringify(plainLines)}`,
		);
		assert.ok(
			!plainLines.some((line) => line.includes("Thinking...")),
			"no loading label fallback",
		);
	} finally {
		emit("session_shutdown", {}, ctx);
		if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousDir;
		rmSync(dir, { recursive: true, force: true });
	}
});

function previewMessage(thinking: string) {
	return {
		role: "assistant",
		timestamp: Date.now(),
		content: [{ type: "thinking", thinking }],
	} as unknown as AssistantMessage;
}

test("thinking preview counts wrapped hidden lines and does not restyle from cache", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-compact-thinking-preview-"));
	const previousDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	const { emit, pi } = runtime();
	const theme = {
		fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
		italic: (text: string) => text,
		bold: (text: string) => text,
	};
	const ctx = {
		mode: "tui",
		sessionManager: { getBranch: () => [], getEntries: () => [] },
		ui: {
			theme,
			setWidget() {},
			requestRender() {},
		},
	} as any;
	const width = 80;
	const previewLines = 3;
	const body = "x".repeat(4000);
	try {
		installCompactThinking(pi, {
			useSummaryTitlesAsThinkingTitle: false,
			previewLines,
			animationIntervalMs: 30,
		});
		emit("session_start", {}, ctx);

		const msg = previewMessage(body);
		const first = new AssistantMessageComponent(msg, true) as any;
		first.updateContent(msg);
		const firstLines = first.render(width) as string[];
		const firstPlain = firstLines.map((line: string) => line.trim()).filter(Boolean);
		const hint = firstPlain.find((line: string) => /Thought/.test(line) && /more lines/.test(line));
		assert.ok(hint, `expected hidden-line hint after Thought, got: ${JSON.stringify(firstPlain)}`);
		assert.match(hint, /<dim> • \(\d+ more lines/);
		const bodyToken = ccstyleConfig.dimThinkingText ? "dim" : "thinkingText";
		assert.ok(
			!firstPlain.some(
				(line: string) => new RegExp(`^<${bodyToken}>x+`).test(line) && /more line/.test(line),
			),
			"preview body must not carry the more-line hint",
		);
		const hidden = Number(/\((\d+) more lines/.exec(hint)?.[1]);
		// Raw newline count of the discarded prefix is 0; wrapped count is ~width-based.
		assert.ok(
			hidden > 20,
			`hidden lines should follow wrap width, not raw newlines, got ${hidden}`,
		);
		assert.ok(
			firstPlain.filter((line: string) => new RegExp(`^<${bodyToken}>x+`).test(line)).length <=
				previewLines,
			"preview body stays capped at previewLines",
		);
		assert.ok(
			firstPlain.every((line: string) => !/^x{80,}/.test(line)),
			"full unwrapped paragraph must not leak into the preview",
		);

		theme.fg = (color: string, text: string) => `[${color}]${text}[/${color}]`;
		const second = new AssistantMessageComponent(msg, true) as any;
		second.updateContent(msg);
		const secondPlain = (second.render(width) as string[])
			.map((line: string) => line.trim())
			.filter(Boolean);
		assert.ok(
			secondPlain.some((line: string) => line.includes(`[${bodyToken}]`)),
			"theme change must restyle preview body, not reuse cached ANSI",
		);
		assert.ok(
			secondPlain.some((line: string) => /\[dim\] • \(\d+ more lines/.test(line)),
			"more-line hint uses the dim token after theme change",
		);
		assert.ok(
			secondPlain.every(
				(line: string) => !line.includes("<thinkingText>") && !line.includes("<dim>"),
			),
			"cached wrap must not keep the previous theme's markup",
		);
	} finally {
		emit("session_shutdown", {}, ctx);
		if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousDir;
		rmSync(dir, { recursive: true, force: true });
	}
});

test("previewLines 0 still offers click to show more and expands the body", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-compact-thinking-preview-zero-"));
	const previousDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	const { emit, pi } = runtime();
	const ctx = themeCtx();
	const body = Array.from({ length: 8 }, (_, i) => `line-${i}`).join("\n");
	try {
		installCompactThinking(pi, {
			useSummaryTitlesAsThinkingTitle: false,
			previewLines: 0,
			animationIntervalMs: 30,
		});
		emit("session_start", {}, ctx);
		const msg = previewMessage(body);
		const component = new AssistantMessageComponent(msg, true) as any;
		component.updateContent(msg);
		const collapsed = renderText(component);
		assert.ok(
			collapsed.some((line) => /Thought.*click to show more/.test(line)),
			`expected click hint with no preview body, got: ${JSON.stringify(collapsed)}`,
		);
		assert.ok(
			!collapsed.some((line) => /^line-\d+$/.test(line)),
			"previewLines 0 hides the thinking body",
		);

		thinkingBlockOf(component).setExpanded(true);
		const expanded = renderText(component);
		assert.ok(!expanded.some((line) => line.includes("click to show more")));
		assert.ok(expanded.some((line) => line.includes("line-0")));
		assert.ok(expanded.some((line) => line.includes("line-7")));
	} finally {
		emit("session_shutdown", {}, ctx);
		if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousDir;
		rmSync(dir, { recursive: true, force: true });
	}
});

function thinkingBlockOf(component: any): ThinkingPreviewBlock {
	const block = component.contentContainer?.children?.find(
		(child: unknown) => child instanceof ThinkingPreviewBlock,
	);
	assert.ok(block instanceof ThinkingPreviewBlock, "assistant mounts a thinking preview block");
	return block;
}

test("thinking preview expands the full body and keeps that state across updateContent", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-compact-thinking-preview-expand-"));
	const previousDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	const { emit, pi } = runtime();
	const ctx = themeCtx();
	const bgSlots: string[] = [];
	(ctx.ui.theme as any).bg = (slot: string, text: string) => {
		bgSlots.push(slot);
		return `<bg>${text}</bg>`;
	};
	const previewLines = 3;
	const body = Array.from({ length: 20 }, (_, i) => `line-${i}`).join("\n");
	try {
		installCompactThinking(pi, {
			useSummaryTitlesAsThinkingTitle: false,
			previewLines,
			animationIntervalMs: 30,
		});
		emit("session_start", {}, ctx);
		const msg = previewMessage(body);
		const component = new AssistantMessageComponent(msg, true) as any;
		component.updateContent(msg);
		const collapsed = renderText(component);
		assert.ok(collapsed.some((line) => /more lines.*click to show more/.test(line)));
		assert.ok(
			collapsed.every((line) => !line.includes("<bg>")),
			"collapsed preview is not wrapped in a card",
		);
		assert.equal(
			collapsed.filter((line) => /^line-\d+$/.test(line)).length,
			previewLines,
			"collapsed body stays capped",
		);

		const block = thinkingBlockOf(component);
		block.setExpanded(true);
		const rawExpanded = component.render(120) as string[];
		assert.ok(
			rawExpanded.some((line) => line.includes("<bg>")),
			"expanded thinking is wrapped in the userMessageBg card",
		);
		const expanded = renderText(component);
		assert.ok(!expanded.some((line) => line.includes("more line")));
		assert.ok(expanded.some((line) => line.includes("line-0")));
		assert.ok(expanded.some((line) => line.includes("line-19")));
		assert.ok(
			expanded.filter((line) => /line-\d+/.test(line)).length > previewLines,
			"expanded body shows more than the preview window",
		);
		assert.ok(bgSlots.includes("userMessageBg"), "expanded thinking card uses the default slot");

		// issue 46：展开卡背景槽位可配，渲染时现读配置。
		const previousSlot = ccstyleConfig.expandedCardBackground;
		try {
			bgSlots.length = 0;
			ccstyleConfig.expandedCardBackground = "toolPendingBg";
			component.render(120);
			assert.ok(bgSlots.includes("toolPendingBg"), "thinking card follows the configured slot");
			assert.ok(!bgSlots.includes("userMessageBg"), "the previous slot leaves no card behind");
		} finally {
			ccstyleConfig.expandedCardBackground = previousSlot;
		}

		component.updateContent(msg);
		assert.equal(thinkingBlockOf(component).expanded, true);
		assert.ok(renderText(component).some((line) => line.includes("line-0")));

		thinkingBlockOf(component).setExpanded(false);
		const recollapsed = renderText(component);
		assert.ok(recollapsed.some((line) => /more lines.*click to show more/.test(line)));
		assert.equal(recollapsed.filter((line) => /^line-\d+$/.test(line)).length, previewLines);
	} finally {
		emit("session_shutdown", {}, ctx);
		if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousDir;
		rmSync(dir, { recursive: true, force: true });
	}
});
