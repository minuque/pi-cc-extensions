import assert from "node:assert/strict";
import test from "node:test";

import { AssistantMessageComponent, ToolExecutionComponent, initTheme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import {
	installCompactStyle,
	formatDuration,
	previewFor,
	rendererRoute,
	resultPreview,
	summaryLine,
	type CompactStyleMode,
} from "../extensions/compact-style.ts";
import claudeCodeStyleExtension, { normalizeConfig, renderCollapsedToolResult } from "../extensions/claude-code-style.ts";

initTheme("dark");

const theme = {
	fg(_color: string, text: string) {
		return text;
	},
	italic(text: string) {
		return text;
	},
} as any;

function createContext(ui: any) {
	return { mode: "tui", hasUI: true, ui } as any;
}

function createUi(renderRequests: unknown[] = []) {
	return {
		theme,
		setStatus() {},
		requestRender(force?: boolean) {
			renderRequests.push(force);
		},
	};
}

function rendered(component: any, width = 120): string {
	return component.render(width).join("\n");
}

function assistantMessage(content: any[], stopReason = "stop", errorMessage?: string) {
	return { role: "assistant", content, stopReason, errorMessage } as any;
}

function textResult(text: string, isError = false) {
	return { content: [{ type: "text", text }], isError };
}

test("normalizeConfig migrates enabled configs and accepts all three modes", () => {
	assert.deepEqual(normalizeConfig({ enabled: false, excludeRenderers: ["edit", "edit", "", 42] }), {
		mode: "off",
		excludeRenderers: ["edit"],
	});
	assert.deepEqual(normalizeConfig({ enabled: true }), { mode: "on", excludeRenderers: [] });
	assert.deepEqual(normalizeConfig({ mode: "compact", enabled: false, excludeRenderers: ["Agent", "Agent"] }), {
		mode: "compact",
		excludeRenderers: ["Agent"],
	});
	assert.deepEqual(normalizeConfig({ mode: "off" }), { mode: "off", excludeRenderers: [] });
	assert.deepEqual(normalizeConfig({ mode: "unknown" }), { mode: "on", excludeRenderers: [] });
});

test("rendererRoute keeps Agent and exclusions native in every mode", () => {
	assert.equal(rendererRoute("on", "read"), "claude");
	assert.equal(rendererRoute("off", "read"), "native");
	assert.equal(rendererRoute("compact", "read"), "compact");
	assert.equal(rendererRoute("compact", "Agent"), "native");
	assert.equal(rendererRoute("compact", "edit", ["edit"]), "native");
	assert.equal(rendererRoute("on", "edit", ["edit"]), "native");
});

test("compact duration, previews, and summaries stay concise", () => {
	assert.equal(renderCollapsedToolResult("Done"), "  ↳ Done");
	assert.equal(formatDuration(999), "");
	assert.equal(formatDuration(1000), "1s");
	assert.equal(formatDuration(61_000), "1m1s");
	assert.equal(previewFor("bash", { command: "printf hello" }), "$ printf hello");
	assert.equal(previewFor("read", { path: "/tmp/a.ts", offset: 4, limit: 2 }), "read /tmp/a.ts:4-5");
	assert.equal(previewFor("write", { path: "/tmp/a.ts", content: "one\ntwo" }), "write /tmp/a.ts (2 lines)");
	assert.equal(summaryLine({ reads: 1, edits: 2, commands: 1, failed: 1, durationMs: 61_000 }),
		"Read 1 file, edited 2 files, ran 1 command, 1 failed · 1m1s");
});

test("compact previews strip terminal controls without changing line counts", () => {
	assert.equal(previewFor("bash", { command: "before\x1b]0;spoofed title\x07after" }), "$ beforeafter");
	assert.equal(previewFor("read", { path: "/tmp/\x1b[31mred\x1b[0m.ts" }), "read /tmp/red.ts");
	assert.equal(resultPreview(textResult("before\x1b]0;spoofed title\x07after")), "beforeafter");
	assert.equal(resultPreview(textResult("\x1b[31mred\x1b[0m")), "red");
	assert.equal(resultPreview(textResult("a\x00b\x08c\x7fd\u0090e")), "abcde");
	assert.equal(resultPreview(textResult("one\r\ntwo\rthree")), "3 lines");
	assert.equal(resultPreview(textResult("one\ntwo\nthree")), "3 lines");
	assert.equal(resultPreview(textResult("one\n  \ntwo")), "2 lines");
});

test("summary renderer is a dynamic component and refresh requests a repaint", () => {
	let mode: CompactStyleMode = "compact";
	let summaryRenderer: any;
	const renderRequests: unknown[] = [];
	const ui = {
		theme,
		setStatus() {},
		requestRender(force?: boolean) {
			renderRequests.push(force);
		},
	};
	const pi = {
		registerEntryRenderer(_type: string, renderer: any) {
			summaryRenderer = renderer;
		},
	};
	const hooks = installCompactStyle(pi as any, {
		getMode: () => mode,
		getExcludeRenderers: () => [],
	});
	hooks.onSessionStart({}, createContext(ui));

	const styledTheme = {
		...theme,
		italic(text: string) {
			return `<italic>${text}</italic>`;
		},
	};
	const component = summaryRenderer({ data: { reads: 2, durationMs: 1000 } }, {}, styledTheme);
	assert.deepEqual(component.render(80).map((line: string) => line.trimEnd()), ["│ <italic>Read 2 files · 1s</italic>"]);
	mode = "off";
	assert.deepEqual(component.render(80), [], "the same mounted component hides immediately");
	mode = "on";
	assert.deepEqual(component.render(80).map((line: string) => line.trimEnd()), ["│ <italic>Read 2 files · 1s</italic>"]);
	mode = "compact";
	assert.deepEqual(component.render(80).map((line: string) => line.trimEnd()), ["│ <italic>Read 2 files · 1s</italic>"]);

	new ToolExecutionComponent("read", "refresh-test", { path: "a.ts" }, {}, undefined, ui, process.cwd());
	hooks.refresh();
	assert.ok(renderRequests.includes(true), "refresh asks the TUI to render immediately");
	hooks.onSessionShutdown({}, createContext(ui));
});

test("reload and resume keep transcript components rebuilt before session_start", () => {
	for (const reason of ["reload", "resume"]) {
		let mode: CompactStyleMode = "compact";
		const oldUi = createUi();
		const oldHooks = installCompactStyle({} as any, {
			getMode: () => mode,
			getExcludeRenderers: () => [],
		});
		oldHooks.onSessionStart({ reason: "startup" }, createContext(oldUi));
		const staleAssistant = new AssistantMessageComponent(
			assistantMessage([{ type: "thinking", thinking: "old thought" }]),
			true,
		);
		let staleInvalidations = 0;
		const staleInvalidate = staleAssistant.invalidate.bind(staleAssistant);
		staleAssistant.invalidate = () => {
			staleInvalidations++;
			staleInvalidate();
		};
		oldHooks.onSessionShutdown({ reason }, createContext(oldUi));
		staleInvalidations = 0;

		const renderRequests: unknown[] = [];
		const ui = createUi(renderRequests);
		const hooks = installCompactStyle({} as any, {
			getMode: () => mode,
			getExcludeRenderers: () => [],
		});
		// Pi rebuilds these rows before session_start for both replacement paths.
		const rebuiltAssistant = new AssistantMessageComponent(
			assistantMessage([{ type: "thinking", thinking: "new thought" }]),
			true,
		);
		const rebuiltTool = new ToolExecutionComponent(
			"unknown-tool",
			`${reason}-tool`,
			{ value: reason },
			{},
			undefined,
			ui as any,
			process.cwd(),
		);
		assert.match(rendered(rebuiltAssistant), /Thinking/);
		assert.doesNotMatch(rendered(rebuiltTool), /[✓✗⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/);

		hooks.onSessionStart({ reason }, createContext(ui));
		assert.doesNotMatch(rendered(rebuiltAssistant), /Thinking/, `${reason} retains the rebuilt assistant row`);
		assert.match(rendered(rebuiltTool), /[✓✗⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/, `${reason} retains the rebuilt tool row`);
		assert.ok(renderRequests.includes(true), `${reason} retains the rebuilt row's TUI`);
		assert.equal(staleInvalidations, 0, `${reason} discarded old-session registries at shutdown`);

		mode = "off";
		hooks.refresh();
		assert.match(rendered(rebuiltAssistant), /Thinking/, `${reason} can restore the rebuilt assistant row`);
		assert.doesNotMatch(rendered(rebuiltTool), /[✓✗⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/, `${reason} can restore the rebuilt tool row`);
		hooks.onSessionShutdown({ reason: "quit" }, createContext(ui));
	}
});

test("shutdown restores compact rows and prototype methods owned by this installation", () => {
	const toolPrototype = ToolExecutionComponent.prototype as any;
	const assistantPrototype = AssistantMessageComponent.prototype as any;
	const originalUpdateDisplay = toolPrototype.updateDisplay;
	const originalRender = toolPrototype.render;
	const originalUpdateContent = assistantPrototype.updateContent;
	let modeCalls = 0;
	const ui = createUi();
	const hooks = installCompactStyle({} as any, {
		getMode: () => {
			modeCalls++;
			return "compact";
		},
		getExcludeRenderers: () => [],
	});
	hooks.onSessionStart({}, createContext(ui));
	const tool = new ToolExecutionComponent("unload-tool", "unload-id", {}, {}, undefined, ui as any, process.cwd()) as any;
	const assistant = new AssistantMessageComponent(
		assistantMessage([{ type: "thinking", thinking: "restore me" }]),
		true,
	);
	assert.match(rendered(tool), /[✓✗⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/);
	assert.doesNotMatch(rendered(assistant), /Thinking/);

	hooks.onSessionShutdown({ reason: "quit" }, createContext(ui));
	assert.equal(toolPrototype.updateDisplay, originalUpdateDisplay);
	assert.equal(toolPrototype.render, originalRender);
	assert.equal(assistantPrototype.updateContent, originalUpdateContent);
	assert.deepEqual(
		[tool.contentText, tool.contentBox, tool.selfRenderContainer].filter((child) => tool.children.includes(child)),
		[tool.contentText],
	);
	assert.doesNotMatch(rendered(tool), /[✓✗⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/);
	assert.match(rendered(assistant), /Thinking/);
	modeCalls = 0;
	tool.invalidate();
	assistant.invalidate();
	assert.equal(modeCalls, 0, "unloaded prototype methods do not retain getMode");
});

test("failed compact installation restores patches and severs host callbacks", () => {
	const toolPrototype = ToolExecutionComponent.prototype as any;
	const assistantPrototype = AssistantMessageComponent.prototype as any;
	const originalUpdateDisplay = toolPrototype.updateDisplay;
	const originalRender = toolPrototype.render;
	const originalUpdateContent = assistantPrototype.updateContent;
	let modeCalls = 0;
	assert.throws(() => installCompactStyle({
		registerEntryRenderer() {
			throw new Error("renderer registration failed");
		},
	} as any, {
		getMode: () => {
			modeCalls++;
			return "compact";
		},
		getExcludeRenderers: () => [],
	}), /renderer registration failed/);
	assert.equal(toolPrototype.updateDisplay, originalUpdateDisplay);
	assert.equal(toolPrototype.render, originalRender);
	assert.equal(assistantPrototype.updateContent, originalUpdateContent);
	modeCalls = 0;
	const ui = createUi();
	new ToolExecutionComponent("failed-install", "failed-install-id", {}, {}, undefined, ui as any, process.cwd());
	assert.equal(modeCalls, 0);
});

test("compact prototype replacement chains external wrappers", () => {
	const toolPrototype = ToolExecutionComponent.prototype as any;
	const assistantPrototype = AssistantMessageComponent.prototype as any;
	const originalUpdateDisplay = toolPrototype.updateDisplay;
	const originalRender = toolPrototype.render;
	const originalUpdateContent = assistantPrototype.updateContent;
	let firstModeCalls = 0;
	let firstMode: CompactStyleMode = "compact";
	const firstHooks = installCompactStyle({} as any, {
		getMode: () => {
			firstModeCalls++;
			return firstMode;
		},
		getExcludeRenderers: () => [],
	});
	const firstOwnedUpdateDisplay = toolPrototype.updateDisplay;
	const firstOwnedUpdateContent = assistantPrototype.updateContent;
	let externalToolCalls = 0;
	let externalAssistantCalls = 0;
	const externalUpdateDisplay = function (this: any, ...args: any[]) {
		externalToolCalls++;
		return firstOwnedUpdateDisplay.apply(this, args);
	};
	const externalUpdateContent = function (this: any, ...args: any[]) {
		externalAssistantCalls++;
		return firstOwnedUpdateContent.apply(this, args);
	};
	toolPrototype.updateDisplay = externalUpdateDisplay;
	assistantPrototype.updateContent = externalUpdateContent;

	let secondMode: CompactStyleMode = "off";
	const secondHooks = installCompactStyle({} as any, {
		getMode: () => secondMode,
		getExcludeRenderers: () => [],
	});
	const secondOwnedUpdateDisplay = toolPrototype.updateDisplay;
	assert.notEqual(secondOwnedUpdateDisplay, externalUpdateDisplay, "replacement installs a fresh owner");
	firstModeCalls = 0;
	const ui = createUi();
	secondHooks.onSessionStart({ reason: "reload" }, createContext(ui));
	new ToolExecutionComponent("replacement-tool", "replacement", {}, {}, undefined, ui as any, process.cwd());
	new AssistantMessageComponent(assistantMessage([{ type: "text", text: "replacement" }]), true);
	assert.ok(externalToolCalls > 0, "the replacement chains the current external tool wrapper");
	assert.ok(externalAssistantCalls > 0, "the replacement chains the current external assistant wrapper");
	assert.equal(firstModeCalls, 0, "the replaced wrapper no longer calls its old host");

	firstHooks.onSessionShutdown({ reason: "late" }, createContext(ui));
	assert.equal(toolPrototype.updateDisplay, secondOwnedUpdateDisplay, "a stale owner cannot tear down its replacement");
	secondHooks.onSessionShutdown({ reason: "quit" }, createContext(ui));
	assert.equal(toolPrototype.updateDisplay, externalUpdateDisplay, "shutdown does not overwrite a later tool wrapper");
	assert.equal(assistantPrototype.updateContent, externalUpdateContent, "shutdown does not overwrite a later assistant wrapper");
	assert.equal(toolPrototype.render, originalRender, "methods still owned by compact are restored");

	firstModeCalls = 0;
	firstMode = "compact";
	secondMode = "compact";
	new ToolExecutionComponent("unloaded-tool", "unloaded", {}, {}, undefined, ui as any, process.cwd());
	assert.equal(firstModeCalls, 0, "an unloaded wrapper remains an inert pass-through");

	// The external wrappers belong to this test, so remove them explicitly.
	toolPrototype.updateDisplay = originalUpdateDisplay;
	assistantPrototype.updateContent = originalUpdateContent;
});

test("compact reclaims assistant rendering after a later thinking extension patch", () => {
	let mode: CompactStyleMode = "compact";
	const ui = createUi();
	const ctx = createContext(ui);
	const prototype = AssistantMessageComponent.prototype as any;
	const originalUpdateContent = prototype.updateContent;
	const hooks = installCompactStyle({} as any, {
		getMode: () => mode,
		getExcludeRenderers: () => [],
	});
	const ccstyleUpdateContent = prototype.updateContent;
	const laterRenderer = function (this: any, message: any) {
		if (this.hideThinkingBlock) {
			this.contentContainer.clear();
			this.contentContainer.addChild(new Text("Thought for 6s", 0, 0));
			this.lastMessage = message;
			return;
		}
		return ccstyleUpdateContent.call(this, message);
	};
	prototype.updateContent = laterRenderer;
	try {
		hooks.onSessionStart({}, ctx);
		assert.equal(prototype.updateContent, ccstyleUpdateContent, "ccstyle reclaims the outer renderer");
		const component = new AssistantMessageComponent(
			assistantMessage([{ type: "thinking", thinking: "hidden" }]),
			true,
		);
		assert.doesNotMatch(rendered(component), /Thought for|hidden/);
	} finally {
		hooks.onSessionShutdown({}, ctx);
		prototype.updateContent = originalUpdateContent;
	}
});

test("compact restores contentText for tools without definitions", () => {
	let mode: CompactStyleMode = "compact";
	const ui = createUi();
	const hooks = installCompactStyle({} as any, {
		getMode: () => mode,
		getExcludeRenderers: () => [],
	});
	hooks.onSessionStart({}, createContext(ui));
	const component = new ToolExecutionComponent(
		"undefined-definition",
		"undefined-definition-id",
		{ value: "one" },
		{},
		undefined,
		ui as any,
		process.cwd(),
	) as any;
	assert.equal(component.children.includes(component.selfRenderContainer), true);
	assert.equal(component.children.includes(component.contentText), false);
	assert.match(rendered(component), /[✓✗⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/);

	mode = "off";
	hooks.refresh();
	const mountedShells = [component.contentText, component.contentBox, component.selfRenderContainer]
		.filter((child) => component.children.includes(child));
	assert.deepEqual(mountedShells, [component.contentText]);
	assert.doesNotMatch(rendered(component), /[✓✗⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/);
	assert.equal(rendered(component).match(/undefined-definition/g)?.length, 1, "no stale self-rendered duplicate row remains");
	hooks.onSessionShutdown({}, createContext(ui));
});

test("Agent and excluded tools retain their dedicated renderers and declared shells", () => {
	let mode: CompactStyleMode = "compact";
	const ui = createUi();
	const hooks = installCompactStyle({} as any, {
		getMode: () => mode,
		getExcludeRenderers: () => ["special"],
	});
	hooks.onSessionStart({}, createContext(ui));
	const definition = (name: string, renderShell: "default" | "self", label: string) => ({
		name,
		renderShell,
		renderCall: () => new Text(`${label} call`, 0, 0),
		renderResult: () => new Text(`${label} result`, 0, 0),
	});
	const agent = new ToolExecutionComponent(
		"Agent",
		"agent-id",
		{},
		{},
		definition("Agent", "default", "agent"),
		ui as any,
		process.cwd(),
	) as any;
	agent.updateResult(textResult("ignored"));
	assert.equal(agent.children.includes(agent.contentBox), true, "Agent's explicit default shell is respected");
	assert.equal(agent.children.includes(agent.selfRenderContainer), false);
	assert.match(rendered(agent), /agent call/);
	assert.match(rendered(agent), /agent result/);
	assert.doesNotMatch(rendered(agent), /[✓✗⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/);

	const excluded = new ToolExecutionComponent(
		"special",
		"special-id",
		{},
		{},
		definition("special", "self", "special"),
		ui as any,
		process.cwd(),
	) as any;
	excluded.updateResult(textResult("ignored"));
	assert.equal(excluded.children.includes(excluded.selfRenderContainer), true, "excluded tool's self shell is respected");
	assert.match(rendered(excluded), /special call/);
	assert.match(rendered(excluded), /special result/);
	assert.doesNotMatch(rendered(excluded), /[✓✗⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/);
	hooks.onSessionShutdown({}, createContext(ui));
});

test("compact tool rows align with and separate a thinking ticker", () => {
	const ui = createUi();
	const ctx = createContext(ui);
	const hooks = installCompactStyle({} as any, {
		getMode: () => "compact",
		getExcludeRenderers: () => [],
	});
	hooks.onSessionStart({}, ctx);
	const tool = new ToolExecutionComponent("read", "thinking-tool", { path: "a.ts" }, {}, undefined, ui as any, process.cwd());
	hooks.onMessageUpdate({
		assistantMessageEvent: { type: "thinking_delta" },
		message: assistantMessage([{ type: "thinking", thinking: "Inspect the implementation" }]),
	}, ctx);
	assert.deepEqual(
		tool.render(120).map((line: string) => line.trimEnd()),
		["", " ✓ read a.ts {running}", " ↳ Inspect the implementation"],
	);
	hooks.onSessionShutdown({}, ctx);
});

test("compact assistant rendering hides thinking regardless of Pi setting and preserves terminal notices", () => {
	let mode: CompactStyleMode = "compact";
	const ui = createUi();
	const hooks = installCompactStyle({} as any, {
		getMode: () => mode,
		getExcludeRenderers: () => [],
	});
	hooks.onSessionStart({}, createContext(ui));
	const cases = [
		{
			message: assistantMessage([{ type: "thinking", thinking: "hidden" }], "error", "network failed"),
			text: /Error: network failed/,
		},
		{
			message: assistantMessage([{ type: "thinking", thinking: "hidden" }, { type: "text", text: "partial answer" }], "length"),
			text: /maximum output token limit/,
		},
		{
			message: assistantMessage([{ type: "text", text: "partial answer" }], "error", "provider failed"),
			text: /Error: provider failed/,
		},
		{
			message: assistantMessage([], "aborted", "Request was aborted"),
			text: /Operation aborted/,
		},
	];
	for (const entry of cases) {
		const component = new AssistantMessageComponent(entry.message, true);
		const output = rendered(component);
		assert.match(output, entry.text);
		assert.doesNotMatch(output, /Thinking/);
		if (entry.message.content.some((content: any) => content.type === "text")) {
			assert.match(output, /partial answer/);
		}
	}

	const nativeThinkingEnabled = new AssistantMessageComponent(
		assistantMessage([{ type: "thinking", thinking: "must stay hidden in compact" }]),
		false,
	);
	assert.doesNotMatch(rendered(nativeThinkingEnabled), /must stay hidden|Thinking|Thought for/);
	mode = "on";
	nativeThinkingEnabled.updateContent(nativeThinkingEnabled.lastMessage);
	assert.match(rendered(nativeThinkingEnabled), /must stay hidden|Thinking/, "switching modes restores Pi's setting");
	hooks.onSessionShutdown({}, createContext(ui));
});

test("reload and resume hydration split failed tools from same-name bursts", () => {
	for (const reason of ["reload", "resume"]) {
		const ui = createUi();
		const ctx = createContext(ui);
		const hooks = installCompactStyle({} as any, {
			getMode: () => "compact",
			getExcludeRenderers: () => [],
		});
		hooks.onSessionStart({ reason }, ctx);
		try {
			const rebuild = (id: string, path: string, result: any) => {
				// Pi rebuilds each persisted tool call before immediately applying its result.
				const component = new ToolExecutionComponent(
					"read",
					id,
					{ path },
					{},
					undefined,
					ui as any,
					process.cwd(),
				);
				component.updateResult(result);
				return component;
			};

			const first = rebuild(`${reason}-success-1`, `${reason}-first.ts`, textResult("ok"));
			const failed = rebuild(`${reason}-failure`, `${reason}-failed.ts`, textResult("permission denied", true));
			assert.match(rendered(first), new RegExp(`read ${reason}-first\\.ts`));
			assert.match(rendered(failed), new RegExp(`read ${reason}-failed\\.ts`));

			const later = rebuild(`${reason}-success-2`, `${reason}-later.ts`, textResult("ok"));
			const outputs = [rendered(first), rendered(failed), rendered(later)];
			assert.match(outputs[0]!, /✓/, `${reason} uses the Claude-style success marker`);
			assert.match(outputs[1]!, /✗/, `${reason} uses the Claude-style error marker`);
			assert.match(outputs[1]!, /permission denied/, `${reason} keeps the failed row visible`);
			assert.match(outputs[2]!, new RegExp(`read ${reason}-later\\.ts`));
			for (const output of outputs) {
				assert.doesNotMatch(output, /\d+×/, `${reason} does not count across the failed row`);
			}
		} finally {
			hooks.onSessionShutdown({ reason: "quit" }, ctx);
		}
	}
});

test("bursts merge, failures regain an independent row, and agent_end persists a summary", () => {
	let mode: CompactStyleMode = "compact";
	const entries: Array<{ type: string; data: any }> = [];
	const pi = {
		appendEntry(type: string, data: any) {
			entries.push({ type, data });
		},
	};
	const ui = createUi();
	const ctx = createContext(ui);
	const hooks = installCompactStyle(pi as any, {
		getMode: () => mode,
		getExcludeRenderers: () => [],
	});
	hooks.onSessionStart({}, ctx);
	hooks.onAgentStart({}, ctx);
	const components = ["a.ts", "b.ts", "c.ts"].map((path, index) => {
		const id = `read-${index + 1}`;
		const component = new ToolExecutionComponent("read", id, { path }, {}, undefined, ui as any, process.cwd());
		hooks.onToolExecutionStart({ toolCallId: id, toolName: "read", args: { path } }, ctx);
		return component;
	});
	assert.deepEqual(components[0]!.render(120), []);
	assert.deepEqual(components[1]!.render(120), []);
	assert.match(rendered(components[2]), /3× read c\.ts/);
	assert.match(rendered(components[2]), /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/, "running tools use Claude's braille loader");

	hooks.onToolExecutionEnd({
		toolCallId: "read-2",
		result: textResult("permission denied", true),
		isError: true,
	}, ctx);
	assert.match(rendered(components[1]), /read b\.ts/);
	assert.doesNotMatch(rendered(components[1]), /3×/, "the failed tool is rendered as its own row");

	hooks.onToolExecutionEnd({ toolCallId: "read-1", result: textResult("ok"), isError: false }, ctx);
	hooks.onToolExecutionEnd({ toolCallId: "read-3", result: textResult("ok"), isError: false }, ctx);
	hooks.onAgentEnd({}, ctx);
	assert.equal(entries.length, 1);
	assert.equal(entries[0]!.type, "compact-transcript-summary");
	assert.deepEqual(
		{
			reads: entries[0]!.data.reads,
			edits: entries[0]!.data.edits,
			commands: entries[0]!.data.commands,
			others: entries[0]!.data.others,
			failed: entries[0]!.data.failed,
		},
		{ reads: 3, edits: 0, commands: 0, others: 0, failed: 1 },
	);
	hooks.onSessionShutdown({}, ctx);
});

test("on mode persists recap entries while off mode does not", () => {
	for (const mode of ["on", "off"] as const) {
		const entries: Array<{ type: string; data: any }> = [];
		const ui = createUi();
		const ctx = createContext(ui);
		const hooks = installCompactStyle({
			appendEntry(type: string, data: any) {
				entries.push({ type, data });
			},
		} as any, {
			getMode: () => mode,
			getExcludeRenderers: () => [],
		});
		hooks.onSessionStart({}, ctx);
		hooks.onAgentStart({}, ctx);
		for (const [index, path] of ["a.ts", "b.ts"].entries()) {
			const id = `${mode}-read-${index}`;
			hooks.onToolExecutionStart({ toolCallId: id, toolName: "read", args: { path } }, ctx);
			hooks.onToolExecutionEnd({ toolCallId: id, result: textResult("ok"), isError: false }, ctx);
		}
		hooks.onAgentEnd({}, ctx);
		assert.equal(entries.length, mode === "on" ? 1 : 0);
		if (mode === "on") assert.equal(entries[0]!.type, "compact-transcript-summary");
		hooks.onSessionShutdown({}, ctx);
	}
});

test("ccstyle registers compact mode and no ctrl+shift+o shortcut", async () => {
	const commands = new Map<string, any>();
	const shortcuts: string[] = [];
	const events = new Map<string, Function>();
	const pi = {
		registerCommand(name: string, options: any) {
			commands.set(name, options);
		},
		registerShortcut(name: string) {
			shortcuts.push(name);
		},
		registerEntryRenderer() {},
		on(name: string, handler: Function) {
			events.set(name, handler);
		},
	};

	claudeCodeStyleExtension(pi as any);
	const command = commands.get("ccstyle");
	assert.deepEqual(command.getArgumentCompletions("").map((item: any) => item.value), ["on", "off", "compact", "status"]);
	assert.deepEqual(shortcuts, []);

	let panel: any;
	const panelTheme = { ...theme, bold: (text: string) => text };
	await command.handler("", {
		mode: "tui",
		hasUI: true,
		ui: {
			custom(factory: Function) {
				panel = factory({ requestRender() {} }, panelTheme, {}, () => {});
				return Promise.resolve();
			},
			notify() {},
			setStatus() {},
		},
	});
	const panelLines = panel.render(80).map((line: string) => line.trimEnd());
	assert.ok(panelLines.some((line: string) => line.includes("on") && line.includes("Claude Code style")));
	assert.ok(panelLines.some((line: string) => line.includes("off") && line.includes("Pi native output")));
	assert.ok(panelLines.some((line: string) => line.includes("compact") && line.includes("Compact transcript")));
	assert.match(panelLines[0]!, /─|━/, "panel has a top divider");
	assert.match(panelLines.at(-1)!, /─|━/, "panel has a bottom divider");

	for (const name of [
		"session_start",
		"agent_start",
		"agent_end",
		"turn_start",
		"message_update",
		"tool_execution_start",
		"tool_execution_update",
		"tool_execution_end",
		"session_shutdown",
	]) {
		assert.equal(typeof events.get(name), "function", `${name} is forwarded`);
	}
	await events.get("session_shutdown")?.({}, createContext(createUi()));
});
