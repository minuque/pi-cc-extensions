import assert from "node:assert/strict";
import test from "node:test";

import {
	ToolExecutionComponent,
	initTheme,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Text, visibleWidth } from "@earendil-works/pi-tui";
type AnyToolDefinition = ToolDefinition<any, any, any>;
import claudeCodeStyleExtension, {
	ExpandedToolIoView,
	humanizeMcpToolName,
	isMcpToolDefinition,
	preservesOriginalRenderer,
} from "../extensions/renderer/index.ts";

initTheme("dark");

test("claude-code-style registers the write override at session_start", async () => {
	const registeredTools: unknown[] = [];
	const events = new Map<string, Function[]>();
	const pi = {
		registerTool(tool: unknown) {
			registeredTools.push(tool);
		},
		registerCommand() {},
		registerShortcut() {},
		on(name: string, handler: Function) {
			const list = events.get(name) ?? [];
			list.push(handler);
			events.set(name, list);
		},
	};
	const emit = async (name: string, event: unknown, ctx: unknown) => {
		for (const handler of events.get(name) ?? []) await handler(event, ctx);
	};

	claudeCodeStyleExtension(pi as any);

	// 加载阶段不注册 write override：此时其他扩展（如 pi-spark）尚未加载，
	// 直接注册会与对方撞名。延迟到 session_start 后所有扩展已就绪再注册。
	assert.deepEqual(
		registeredTools.map((tool: any) => tool.name),
		[],
	);
	await emit("session_start", {}, { mode: "print", hasUI: false });
	assert.deepEqual(
		registeredTools.map((tool: any) => tool.name),
		["write"],
	);
	await emit("session_shutdown", {}, { ui: { setStatus() {} } });
});

test("expanded ccstyle tools use Pi's native background card", async () => {
	const events = new Map<string, Function>();
	const pi = {
		registerCommand() {},
		registerShortcut() {},
		on(name: string, handler: Function) {
			events.set(name, handler);
		},
	};
	claudeCodeStyleExtension(pi as any, { mode: "on" });
	const ui = {
		theme: {
			fg: (_color: string, text: string) => text,
			// userMsgBg #343541 → 48;2;52;53;65；toolSuccessBg #283228 → 48;2;40;50;40
			bg: (_color: string, text: string) => `\x1b[48;2;52;53;65m${text}\x1b[49m`,
		},
		setStatus() {},
		requestRender() {},
	};
	const ctx = { mode: "tui", hasUI: true, ui } as any;
	try {
		await events.get("session_start")?.({}, ctx);
		const command =
			`rg -n "writeMethod|replaceMethod" '${"C:/Users/example/node_modules/".repeat(5)}pi-compat.ts' ` +
			`'C:/Users/example/node_modules/pi-zentui/extensions/zentui/fixed-editor/compositor.ts'`;
		const component = new ToolExecutionComponent(
			"bash",
			"native-card",
			{ command },
			{},
			undefined,
			ui as any,
			process.cwd(),
		) as any;
		const queuedCall = component
			.render(100)
			.join("\n")
			.replace(/\x1b\[[0-9;]*m/g, "");
		assert.match(queuedCall, /● Bash /);
		assert.doesNotMatch(queuedCall, /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏✓]/);

		component.markExecutionStarted();
		assert.match(
			component
				.render(100)
				.join("\n")
				.replace(/\x1b\[[0-9;]*m/g, ""),
			/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] Bash /,
			"single tools use the shared Braille loader",
		);
		component.updateResult({
			content: [{ type: "text", text: "first line\nsecond line\nthird line" }],
			isError: false,
		});
		assert.equal(component.children.includes(component.selfRenderContainer), true);
		const collapsedLines = component
			.render(100)
			.map((line: string) => line.replace(/\x1b\[[0-9;]*m/g, ""));
		const collapsedCall = collapsedLines.find((line: string) => line.includes("✓ Bash "));
		const collapsedOutput = collapsedLines.filter((line: string) => line.includes("↳"));
		assert.ok(collapsedCall);
		assert.ok(collapsedOutput.length === 1);
		assert.ok(visibleWidth(collapsedCall) <= 80, "collapsed input uses 80% of the viewport");
		assert.ok(
			collapsedOutput.every((line: string) => visibleWidth(line) <= 80),
			"collapsed output uses 80% of the viewport",
		);
		component.setExpanded(true);
		assert.equal(component.children.includes(component.contentBox), true);
		assert.equal(component.children.includes(component.selfRenderContainer), false);

		// /reload can leave the previous module's result component attached briefly.
		// A structurally compatible stale view must be replaced, not reused.
		component.resultRendererComponent = {
			getInputBody: () => "legacy input",
			getOutputBody: () => "legacy output",
			setHoveredSection() {},
			setContent() {},
			render: () => ["legacy full-width body"],
			invalidate() {},
		};
		component.invalidate();
		assert.ok(component.resultRendererComponent instanceof ExpandedToolIoView);

		const cardLines = component.render(60);
		// 展开面板背景统一为 user message 背景色（userMsgBg #343541），不再按状态区分。
		assert.ok(cardLines.some((line: string) => line.includes("\x1b[48;2;52;53;65m")));
		assert.ok(
			cardLines.every((line: string) => !line.includes("\x1b[48;2;40;50;40m")),
			"no toolSuccessBg remains in the expanded panel",
		);
		const callLine = cardLines.find((line: string) => line.includes("Bash "));
		assert.ok(callLine);
		assert.equal(
			visibleWidth(callLine),
			60,
			"background card title stays within its full-width row",
		);
		const plainCallLine = callLine.replace(/\x1b\[[0-9;]*m/g, "").trimEnd();
		// input 摘要与多 tool 一致：从头截断（保留开头，省略尾部），上限 96 字符
		assert.match(plainCallLine, /✓ Bash .*…$/);
		assert.doesNotMatch(plainCallLine, /compositor\.ts'$/);
		assert.doesNotMatch(callLine, /\x1b\[0m/, "tool title must not reset the card background");
		component.setExpanded(false);
		assert.equal(component.children.includes(component.selfRenderContainer), true);

		const edit = new ToolExecutionComponent(
			"edit",
			"inset-edit-marker",
			{ path: "sample.ts" },
			{},
			undefined,
			ui as any,
			process.cwd(),
		) as any;
		edit.updateResult({
			content: [],
			details: { diff: "@@ -1 +1 @@\n-old\n+new" },
			isError: false,
		});
		const editMarker = edit
			.render(100)
			.map((line: string) => line.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, ""))
			.find((line: string) => line.includes("↳"));
		assert.match(editMarker!, /^   ↳/, "rich diff marker is nested two columns inside the tool");
	} finally {
		await events.get("session_shutdown")?.({}, ctx);
	}
});

test("MCP detection, titles, details, and custom tools use the global wrapper", async () => {
	assert.equal(isMcpToolDefinition({ label: "MCP: Files" }, "read_file"), true);
	assert.equal(isMcpToolDefinition({}, "mcp__filesystem__read_file"), true);
	assert.equal(isMcpToolDefinition({ description: "Model Context Protocol tool" }, "remote"), true);
	assert.equal(
		isMcpToolDefinition({ label: "Ordinary", description: "mentions MCP" }, "remote"),
		false,
	);
	assert.equal(isMcpToolDefinition({ description: "not an MCP tool" }, "remote"), false);
	assert.equal(humanizeMcpToolName("mcp__filesystem__read_file"), "Filesystem Read File");

	const events = new Map<string, Function>();
	claudeCodeStyleExtension(
		{
			registerCommand() {},
			registerShortcut() {},
			on(name: string, handler: Function) {
				events.set(name, handler);
			},
		} as any,
		{ mode: "on" },
	);
	const ui = {
		theme: { fg: (_color: string, text: string) => text },
		setStatus() {},
		requestRender() {},
	};
	const ctx = { mode: "tui", hasUI: true, ui } as any;
	try {
		await events.get("session_start")?.({}, ctx);
		for (const [name, expected] of [
			["mcp__filesystem__read_file", "Filesystem Read File"],
			["openai_custom_search", "Openai Custom Search"],
			["custom_lookup", "Custom Lookup"],
		] as const) {
			const component = new ToolExecutionComponent(
				name,
				`${name}-id`,
				{},
				{},
				{ name } as unknown as AnyToolDefinition,
				ui as any,
				process.cwd(),
			) as any;
			const shared = { value: 1n };
			const details: any = { first: shared, second: shared };
			details.self = details;
			component.updateResult({
				content: [
					{ type: "text", text: "first block" },
					{ type: "image", data: "ignored" },
					{ type: "text", text: "second block" },
				],
				details,
				isError: false,
			});
			const collapsed = component.render(100).join("\n");
			assert.match(collapsed, new RegExp(expected));
			assert.match(collapsed, /2 lines returned.*click to show more/);
			component.setExpanded(true);
			const expanded = component.render(100).join("\n");
			assert.match(expanded, /first block[\s\S]*second block[\s\S]*Details:/);
			assert.match(expanded, /1n/);
			assert.match(expanded, /Circular/);
		}

		const agentResult = new ToolExecutionComponent(
			"get_subagent_result",
			"agent-result-id",
			{ agent_id: "agent-123" },
			{},
			{ name: "get_subagent_result" } as unknown as AnyToolDefinition,
			ui as any,
			process.cwd(),
		) as any;
		assert.match(agentResult.render(100).join("\n"), /Get Subagent Result agent-123/);

		for (const [name, args, expected] of [
			["Agents", { description: "review changes" }, "Agents review changes"],
			["Skill", { name: "deploy" }, "Skill deploy"],
			["EnterPlanMode", {}, "Enter Plan Mode enable read-only planning"],
			["ExitPlanMode", {}, "Exit Plan Mode present plan"],
			["TaskCreate", { subject: "Fix tests" }, "Task Create Fix tests"],
			["TaskList", {}, "Task List task list"],
			["TaskGet", { taskId: "12" }, "Task Get 12"],
			["TaskUpdate", { task_id: "13" }, "Task Update 13"],
			["TaskOutput", { task_id: "bg-1" }, "Task Output bg-1"],
			["TaskStop", { taskId: "bg-2" }, "Task Stop bg-2"],
			["TaskExecute", { task_ids: ["1", "2"] }, "Task Execute 1 (+1 tasks)"],
		] as const) {
			const external = new ToolExecutionComponent(
				name,
				`${name}-summary`,
				args,
				{},
				{ name } as unknown as AnyToolDefinition,
				ui as any,
				process.cwd(),
			) as any;
			assert.match(
				external.render(160).join("\n"),
				new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
			);
		}

		const taskList = new ToolExecutionComponent(
			"TaskList",
			"task-list-result",
			{},
			{},
			{ name: "TaskList" } as unknown as AnyToolDefinition,
			ui as any,
			process.cwd(),
		) as any;
		taskList.updateResult({
			content: [
				{ type: "text", text: "#1 [completed] Done\n#2 [in_progress] Working\n#3 [pending] Next" },
			],
			isError: false,
		});
		assert.match(
			taskList.render(120).join("\n"),
			/3 tasks • 1 in progress • 1 pending • 1 completed/,
		);
		taskList.setExpanded(true);
		assert.match(
			taskList
				.render(120)
				.join("\n")
				.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, ""),
			/#1 completed Done[\s\S]*#2 in_progress Working/,
		);

		const taskCreate = new ToolExecutionComponent(
			"TaskCreate",
			"task-create-result",
			{ subject: "Fix tests" },
			{},
			{ name: "TaskCreate" } as unknown as AnyToolDefinition,
			ui as any,
			process.cwd(),
		) as any;
		taskCreate.updateResult({
			content: [{ type: "text", text: "Task #7 created successfully: Fix tests" }],
			isError: false,
		});
		taskCreate.setExpanded(true);
		assert.match(
			taskCreate
				.render(120)
				.join("\n")
				.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, ""),
			/Created task #7 Fix tests/,
		);

		const duplicate = new ToolExecutionComponent(
			"custom",
			"duplicate",
			{},
			{},
			{ name: "custom" } as unknown as AnyToolDefinition,
			ui as any,
			process.cwd(),
		) as any;
		duplicate.updateResult({
			content: [{ type: "text", text: "same" }],
			details: "same",
			isError: false,
		});
		duplicate.setExpanded(true);
		assert.doesNotMatch(duplicate.render(100).join("\n"), /Details:/);
	} finally {
		await events.get("session_shutdown")?.({}, ctx);
	}
});

test("ccstyle is the default renderer and exclusions preserve dedicated renderers", () => {
	const builtIn = {
		name: "edit",
		renderShell: "self",
		renderCall() {},
		renderResult() {},
	};

	assert.equal(
		preservesOriginalRenderer({ name: "edit", renderCall() {} }, "edit", builtIn, []),
		false,
	);
	assert.equal(
		preservesOriginalRenderer({ name: "edit", renderCall() {} }, "edit", builtIn, ["edit"]),
		true,
	);
	assert.equal(preservesOriginalRenderer(undefined, "edit", builtIn, ["edit"]), true);
	assert.equal(
		preservesOriginalRenderer({ name: "custom" }, "custom", undefined, ["custom"]),
		false,
	);
	assert.equal(preservesOriginalRenderer(undefined, "Agent"), false);
});

test("Agent keeps its dedicated renderer under ccstyle", async () => {
	const events = new Map<string, Function>();
	const pi = {
		registerCommand() {},
		registerShortcut() {},
		on(name: string, handler: Function) {
			events.set(name, handler);
		},
	};
	claudeCodeStyleExtension(pi as any);
	const extensionTheme = { fg: (_color: string, text: string) => text };
	const ui = {
		theme: extensionTheme,
		setStatus() {},
		requestRender() {},
	};
	const ctx = { mode: "tui", hasUI: true, ui };
	await events.get("session_start")?.({}, ctx);
	const definition = {
		name: "Agent",
		renderShell: "default",
		renderCall: () => new Text("agent dedicated call", 0, 0),
		renderResult: () => new Text("agent dedicated result", 0, 0),
	} as unknown as AnyToolDefinition;
	const component = new ToolExecutionComponent(
		"Agent",
		"agent-renderer",
		{ description: "review changes" },
		{},
		definition,
		ui as any,
		process.cwd(),
	) as any;
	component.updateResult({ content: [{ type: "text", text: "raw" }], isError: false });
	assert.equal(component.children.includes(component.contentBox), true);
	assert.equal(component.children.includes(component.selfRenderContainer), false);
	const output = component.render(100).join("\n");
	assert.match(output, /agent dedicated/);
	assert.doesNotMatch(output, /Agent review changes/);
	await events.get("session_shutdown")?.({}, ctx);
});

test("global renderer reload chains external wrappers and shutdown restores them", async () => {
	const prototype = ToolExecutionComponent.prototype as any;
	const methodNames = [
		"hasRendererDefinition",
		"getRenderShell",
		"getCallRenderer",
		"getResultRenderer",
	] as const;
	const originals = Object.fromEntries(
		methodNames.map((name) => [name, prototype[name]]),
	) as Record<string, Function>;
	const firstEvents = new Map<string, Function>();
	const secondEvents = new Map<string, Function>();
	const makePi = (events: Map<string, Function>) => ({
		registerCommand() {},
		registerShortcut() {},
		on(name: string, handler: Function) {
			events.set(name, handler);
		},
	});
	const ctx = {
		mode: "tui",
		hasUI: true,
		ui: { theme: {}, setStatus() {}, requestRender() {} },
	} as any;

	try {
		claudeCodeStyleExtension(makePi(firstEvents) as any);
		await firstEvents.get("session_start")?.({}, ctx);
		const firstPatch = (globalThis as any)[Symbol.for("pi.ccstyle.global-tool-render-patch")];
		const externalCalls = Object.fromEntries(methodNames.map((name) => [name, 0])) as Record<
			string,
			number
		>;
		const external = {} as Record<string, Function>;
		for (const name of methodNames) {
			const downstream = prototype[name];
			external[name] = function (this: any, ...args: any[]) {
				externalCalls[name]++;
				return downstream.apply(this, args);
			};
			prototype[name] = external[name];
		}

		claudeCodeStyleExtension(makePi(secondEvents) as any, { excludeRenderers: ["custom"] });
		await secondEvents.get("session_start")?.({}, ctx);
		assert.equal(firstPatch.active, false);
		assert.equal(firstPatch.mode(), "off", "reload disconnects the old config callback");
		for (const name of methodNames) assert.notEqual(prototype[name], external[name]);

		const renderCall = () => new Text("call", 0, 0);
		const renderResult = () => new Text("result", 0, 0);
		const receiver = {
			toolName: "custom",
			toolDefinition: { name: "custom", renderShell: "default", renderCall, renderResult },
			builtInToolDefinition: undefined,
			children: [],
		};
		assert.equal(prototype.hasRendererDefinition.call(receiver), true);
		assert.equal(prototype.getRenderShell.call(receiver), "default");
		assert.equal(prototype.getCallRenderer.call(receiver), renderCall);
		assert.equal(prototype.getResultRenderer.call(receiver), renderResult);
		for (const name of methodNames)
			assert.equal(externalCalls[name], 1, `${name} chains the external wrapper`);

		const secondOwned = Object.fromEntries(methodNames.map((name) => [name, prototype[name]]));
		await firstEvents.get("session_shutdown")?.({}, ctx);
		for (const name of methodNames) {
			assert.equal(prototype[name], secondOwned[name], `stale shutdown keeps ${name}`);
		}

		await secondEvents.get("session_shutdown")?.({}, ctx);
		for (const name of methodNames) {
			assert.equal(prototype[name], external[name], `shutdown restores ${name}'s downstream`);
		}
	} finally {
		await firstEvents.get("session_shutdown")?.({}, ctx);
		await secondEvents.get("session_shutdown")?.({}, ctx);
		for (const name of methodNames) prototype[name] = originals[name];
		delete (globalThis as any)[Symbol.for("pi.ccstyle.global-tool-render-patch")];
	}
});

test("global renderer migrates legacy Symbol state without retaining old wrappers", async () => {
	const prototype = ToolExecutionComponent.prototype as any;
	const methodNames = [
		"hasRendererDefinition",
		"getRenderShell",
		"getCallRenderer",
		"getResultRenderer",
	] as const;
	const originals = Object.fromEntries(
		methodNames.map((name) => [name, prototype[name]]),
	) as Record<string, Function>;
	const events = new Map<string, Function>();
	const legacy: any = {
		prototype,
		owner: {},
		enabled: () => true,
		wrap: (tool: any) => tool,
		byDefinition: new WeakMap(),
		byName: new Map(),
		originalHasRendererDefinition: originals.hasRendererDefinition,
		originalGetRenderShell: originals.getRenderShell,
		originalGetCallRenderer: originals.getCallRenderer,
		originalGetResultRenderer: originals.getResultRenderer,
	};
	const shouldGloballyStyleTool = () => false;
	const shouldUseSelfShell = () => false;
	prototype.hasRendererDefinition = function (this: any, ...args: any[]) {
		if (shouldGloballyStyleTool()) return true;
		return legacy.originalHasRendererDefinition.apply(this, args);
	};
	prototype.getRenderShell = function (this: any, ...args: any[]) {
		if (shouldUseSelfShell() || shouldGloballyStyleTool()) return "self";
		return legacy.originalGetRenderShell.apply(this, args);
	};
	prototype.getCallRenderer = function (this: any, ...args: any[]) {
		if (shouldGloballyStyleTool()) return undefined;
		return legacy.originalGetCallRenderer.apply(this, args);
	};
	prototype.getResultRenderer = function (this: any, ...args: any[]) {
		if (shouldGloballyStyleTool()) return undefined;
		return legacy.originalGetResultRenderer.apply(this, args);
	};
	(globalThis as any)[Symbol.for("pi.ccstyle.global-tool-render-patch")] = legacy;
	const ctx = {
		mode: "tui",
		hasUI: true,
		ui: { theme: {}, setStatus() {}, requestRender() {} },
	} as any;

	try {
		claudeCodeStyleExtension({
			registerCommand() {},
			registerShortcut() {},
			on(name: string, handler: Function) {
				events.set(name, handler);
			},
		} as any);
		await events.get("session_start")?.({}, ctx);
		const migrated = (globalThis as any)[Symbol.for("pi.ccstyle.global-tool-render-patch")];
		for (const name of methodNames) assert.equal(migrated.downstream[name], originals[name]);
		assert.equal(legacy.enabled(), false, "legacy callbacks are disconnected");
		await events.get("session_shutdown")?.({}, ctx);
		for (const name of methodNames) assert.equal(prototype[name], originals[name]);
	} finally {
		await events.get("session_shutdown")?.({}, ctx);
		for (const name of methodNames) prototype[name] = originals[name];
		delete (globalThis as any)[Symbol.for("pi.ccstyle.global-tool-render-patch")];
	}
});

test("global renderer shutdown does not overwrite wrappers installed later", async () => {
	const prototype = ToolExecutionComponent.prototype as any;
	const methodNames = [
		"hasRendererDefinition",
		"getRenderShell",
		"getCallRenderer",
		"getResultRenderer",
	] as const;
	const originals = Object.fromEntries(
		methodNames.map((name) => [name, prototype[name]]),
	) as Record<string, Function>;
	const events = new Map<string, Function>();
	const ctx = {
		mode: "tui",
		hasUI: true,
		ui: { theme: {}, setStatus() {}, requestRender() {} },
	} as any;
	try {
		claudeCodeStyleExtension({
			registerCommand() {},
			registerShortcut() {},
			on(name: string, handler: Function) {
				events.set(name, handler);
			},
		} as any);
		await events.get("session_start")?.({}, ctx);
		const later = {} as Record<string, Function>;
		for (const name of methodNames) {
			const downstream = prototype[name];
			later[name] = function (this: any, ...args: any[]) {
				return downstream.apply(this, args);
			};
			prototype[name] = later[name];
		}

		await events.get("session_shutdown")?.({}, ctx);
		for (const name of methodNames) {
			assert.equal(prototype[name], later[name], `shutdown preserves later ${name}`);
		}
	} finally {
		await events.get("session_shutdown")?.({}, ctx);
		for (const name of methodNames) prototype[name] = originals[name];
		delete (globalThis as any)[Symbol.for("pi.ccstyle.global-tool-render-patch")];
	}
});
