import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import {
	AssistantMessageComponent,
	ToolExecutionComponent,
	initTheme,
} from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
	Container,
	resetCapabilitiesCache,
	Spacer,
	setCapabilities,
	setCellDimensions,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { installToolGrouping, ToolGroupComponent } from "../extensions/renderer/tool/grouping.ts";
import { solidPngBase64 } from "./helpers/png.ts";
import {
	humanizeToolLabel,
	renderToolSummary,
	toolCallSummary,
} from "../extensions/renderer/tool/names.ts";

initTheme("dark");
const ui = { theme: { fg: (_color: string, text: string) => text }, requestRender() {} } as any;
function tool(name: string, id: string, args: any = {}) {
	return new ToolExecutionComponent(name, id, args, {}, undefined, ui, process.cwd()) as any;
}

function started(name: string, id: string, args: any = {}) {
	const component = tool(name, id, args);
	component.markExecutionStarted();
	return component;
}

test("restored tools still render as running with the braille loader", () => {
	const hooks = installToolGrouping(() => true);
	try {
		const parent = new Container() as any;
		parent.addChild(tool("read", "read-stale"));
		parent.addChild(tool("bash", "bash-stale"));
		const group = parent.children[0] as ToolGroupComponent;
		const rendered = group
			.render(100)
			.map((line: string) => line.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, ""))
			.filter((line: string) => line.trim());
		assert.match(rendered[0], /2 running/);
		assert.ok(rendered.some((line: string) => /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/.test(line)));
		assert.doesNotMatch(rendered.join("\n"), /queued/);
	} finally {
		hooks.shutdown();
	}
});

test("mixed tools group across three empty separators while edit/write and content break groups", () => {
	let enabled = true;
	const hooks = installToolGrouping(() => enabled);
	try {
		const parent = new Container() as any;
		const read = started("read", "read");
		const bash = started("bash", "bash");
		const grep = started("grep", "grep");
		parent.addChild(read);
		parent.addChild(new Spacer(1));
		parent.addChild(new Spacer(1));
		parent.addChild(new Spacer(1));
		parent.addChild(bash);
		parent.addChild(grep);
		assert.ok(parent.children[0] instanceof ToolGroupComponent);
		const renderedGroup = parent.children[0].render(100);
		assert.notEqual(renderedGroup.at(-1)?.trim(), "", "group does not add a trailing blank row");
		const collapsed = renderedGroup
			.map((line: string) => line.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, ""))
			.filter((line: string) => line.trim());
		assert.match(
			collapsed[0],
			/^ ● Multiple Tools: 3 running · Read×1, Bash×1, Grep×1 · click to show more$/,
		);
		assert.equal(collapsed.filter((line: string) => line.trim()).length, 4);
		assert.match(collapsed[1], /^ ├ [⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] Read /);
		assert.match(collapsed[2], /^ ├ [⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] Bash /);
		assert.match(collapsed[3], /^ └ [⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] Grep /);
		bash.updateResult({ content: [], isError: false });
		grep.updateResult({ content: [], isError: true });
		assert.match(
			parent.children[0].render(100).find((line: string) => line.trim())!,
			/1 running.*1 done.*1 failed/,
		);
		const group = parent.children[0] as ToolGroupComponent;
		group.setExpanded(true);
		const expanded = group
			.render(100)
			.map((line: string) => line.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, ""))
			.join("\n");
		assert.doesNotMatch(expanded, /[├└] ● {2}/, "expanded tool titles have one separator");
		group.setExpanded(false);

		parent.addChild(tool("edit", "edit"));
		parent.addChild(tool("read", "after-edit"));
		assert.equal(
			parent.children.filter((child: any) => child instanceof ToolGroupComponent).length,
			1,
		);
		parent.addChild(tool("write", "write"));
		const assistant = new AssistantMessageComponent(
			{
				role: "assistant",
				content: [{ type: "text", text: "boundary" }],
			} as unknown as AssistantMessage,
			true,
		);
		parent.addChild(assistant);
		parent.addChild(tool("bash", "after-content"));
		assert.equal(parent.children.at(-1).toolCallId, "after-content");
	} finally {
		hooks.shutdown();
	}
});

test("collapsed groups preserve filenames for long cwd paths", () => {
	const hooks = installToolGrouping(() => true);
	try {
		const parent = new Container() as any;
		const path = join(
			process.cwd(),
			"extensions",
			"very-long-feature-name",
			"nested-renderer-implementation",
			"target-file.ts",
		);
		parent.addChild(started("read", "long-read", { path }));
		parent.addChild(started("bash", "separator", { command: "echo ok" }));
		const rendered = parent.children[0]
			.render(48)
			.map((line: string) => line.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, ""));
		const readLine = rendered.find((line: string) => line.includes("Read"));
		assert.match(readLine!, /Read extensions.*…[\\/]target-file\.ts$/);
		assert.doesNotMatch(
			readLine!,
			new RegExp(process.cwd().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
		);
	} finally {
		hooks.shutdown();
	}
});

test("expanded native cards align nested trees through interleaved ANSI padding", () => {
	const hooks = installToolGrouping(() => true);
	try {
		const parent = new Container() as any;
		const read = started("read", "read");
		const bash = started("bash", "bash");
		parent.addChild(read);
		parent.addChild(bash);
		const group = parent.children[0] as ToolGroupComponent;
		hooks.setTheme({
			fg: (_color: string, text: string) => text,
			bg: (_color: string, text: string) => `\x1b[48;2;10;20;30m${text}\x1b[49m`,
			getBgAnsi: () => "\x1b[48;2;10;20;30m",
		});
		group.setExpanded(true);
		read.render = (width: number) => {
			assert.equal(width, 98, "native card uses the full padded panel width");
			return [
				"\x1b[48;2;20;20;20m ✓ Read sample.ts\x1b[0m",
				"\x1b[48;2;20;20;20m \x1b[39m├ Input\x1b[0m",
				"\x1b[48;2;20;20;20m \x1b[39m│ path: sample.ts\x1b[0m",
				"\x1b[48;2;20;20;20m \x1b[39m└ Output\x1b[0m",
				"\x1b[48;2;20;20;20m \x1b[39m  ok\x1b[0m",
			];
		};
		const rendered = group.render(100);
		const stripAnsi = (line: string) => line.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
		const inputLine = rendered.find((line: string) => stripAnsi(line).includes("Input")) ?? "";
		const backgroundIndex = inputLine.indexOf("\x1b[48;");
		assert.equal(backgroundIndex, 0, "expanded panel background covers the full row");
		assert.match(
			stripAnsi(rendered[2]),
			/^ ├ [⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] Read/,
			"panel starts directly with the loading tool",
		);
		assert.equal(
			stripAnsi(rendered.at(-1) ?? "").length,
			100,
			"bottom padding covers the full width",
		);
		const expanded = rendered.map(stripAnsi).join("\n");
		assert.match(
			expanded,
			/^ ├ [⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] Read sample\.ts\s*$/m,
			"expanded branch matches collapsed position",
		);
		assert.match(expanded, /^ │ ├ Input\s*$/m, "nested tree aligns with the status dot");
		assert.match(expanded, /^ │ │ path: sample\.ts\s*$/m);
		assert.match(expanded, /^ │   ok\s*$/m, "output content retains its relative indent");
	} finally {
		hooks.shutdown();
	}
});

test("expanded group rows follow the worst tool status", () => {
	const hooks = installToolGrouping(() => true);
	const ANSI_BY_SLOT: Record<string, string> = {
		toolPendingBg: "\x1b[48;2;40;40;40m",
		toolSuccessBg: "\x1b[48;2;15;42;36m",
		toolErrorBg: "\x1b[48;2;38;20;24m",
	};
	const bgAnsiOf = (slot: string) => ANSI_BY_SLOT[slot] ?? "\x1b[48;2;90;90;90m";
	hooks.setTheme({
		fg: (_color: string, text: string) => text,
		bg: (slot: string, text: string) => `${bgAnsiOf(slot)}${text}\x1b[49m`,
		getBgAnsi: bgAnsiOf,
	});
	try {
		const parent = new Container() as any;
		const read = started("read", "bg-read");
		const bash = started("bash", "bg-bash");
		parent.addChild(read);
		parent.addChild(bash);
		const group = parent.children[0] as ToolGroupComponent;
		// 固定引用：子工具 paint 命中缓存时，分组展开缓存才会复用整卡行。
		let readPaints: string[] | undefined;
		let bashPaints: string[] | undefined;
		read.render = () => (readPaints ??= [" ✓ Read a.ts", " ok"]);
		bash.render = () => (bashPaints ??= [" ✓ Bash ls", " done"]);
		group.setExpanded(true);

		const running = group.render(80);
		assert.ok(
			running.some((line: string) => line.includes(bgAnsiOf("toolPendingBg"))),
			"a running tool paints the pending background",
		);

		read.updateResult({ content: [{ type: "text", text: "ok" }], isError: false });
		bash.updateResult({ content: [{ type: "text", text: "done" }], isError: false });
		const settled = group.render(80);
		assert.notStrictEqual(settled, running, "status change drops the stale expanded rows");
		assert.ok(
			settled.some((line: string) => line.includes(bgAnsiOf("toolSuccessBg"))),
			"all settled tools paint the success background",
		);
		assert.strictEqual(
			group.render(80),
			settled,
			"identical frame reuses the cached expanded rows",
		);

		bash.updateResult({ content: [{ type: "text", text: "failed" }], isError: true });
		const failed = group.render(80);
		assert.ok(
			failed.some((line: string) => line.includes(bgAnsiOf("toolErrorBg"))),
			"one failed tool paints the error background",
		);
		assert.ok(
			failed.every((line: string) => !line.includes(bgAnsiOf("toolSuccessBg"))),
			"the success background leaves no row behind",
		);
	} finally {
		hooks.shutdown();
	}
});

test("external task, skill, and plan tools keep reference summaries in groups", () => {
	const hooks = installToolGrouping(() => true);
	try {
		const parent = new Container() as any;
		parent.addChild(tool("TaskCreate", "task", { subject: "Fix tests" }));
		parent.addChild(tool("Skill", "skill", { name: "deploy" }));
		parent.addChild(tool("EnterPlanMode", "plan"));
		const rendered = parent.children[0].render(160).join("\n");
		assert.match(rendered, /Task Create Fix tests/);
		assert.match(rendered, /Skill deploy/);
		assert.match(rendered, /Enter Plan Mode enable read-only planning/);

		const agentParent = new Container() as any;
		const agent = tool("Agent", "agent", { description: "再次测试 tool 调用" });
		const result = tool("get_subagent_result", "result", {
			agent_id: "6a559462-95d0-40b",
		});
		agent.updateResult({ content: [], isError: false });
		result.updateResult({ content: [], isError: false });
		agentParent.addChild(agent);
		agentParent.addChild(result);
		const agentLines = agentParent.children[0]
			.render(160)
			.map((line: string) => line.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, ""))
			.filter((line: string) => line.trim());
		assert.match(
			agentLines[0],
			/^ ● Multiple Tools: 2 done · Subagent×1, Get Subagent Result×1 · click to show more$/,
		);
		assert.equal(agentLines[1], " ├ ✓ Subagent 再次测试 tool 调用");
		assert.equal(agentLines[2], " └ ✓ Get Subagent Result 6a559462-95d0-40b");
	} finally {
		hooks.shutdown();
	}
});

test("group status and tool labels use the injected active theme", () => {
	const hooks = installToolGrouping(() => true);
	hooks.setTheme({ fg: (color: string, text: string) => `<${color}>${text}</${color}>` });
	try {
		const parent = new Container() as any;
		const read = tool("read", "themed-read");
		const bash = tool("bash", "themed-bash");
		read.updateResult({ content: [], isError: false });
		bash.updateResult({ content: [], isError: false });
		parent.addChild(read);
		parent.addChild(bash);
		const rendered = parent.children[0].render(200).join("\n");
		assert.match(rendered, /<success>●<\/success>/, "group header stays a status dot");
		assert.match(rendered, /<dim>[├└]<\/dim> <success>✓<\/success>/, "children use checks");
		assert.match(rendered, /<success>2<\/success> done/);
		assert.match(rendered, /<toolTitle>Read<\/toolTitle>/);
		assert.match(rendered, /<toolTitle>Bash<\/toolTitle>/);

		const group = parent.children[0] as ToolGroupComponent;
		group.setHintHovered(true);
		const hovered = group.render(200).join("\n");
		assert.match(
			hovered,
			/<dim>·<\/dim> <text>click to show more<\/text>/,
			"hover highlights text without highlighting the dot",
		);
		assert.doesNotMatch(hovered, /<text>·/);
		group.setExpanded(true);
		const expanded = group.render(200).join("\n");
		assert.equal(expanded.match(/✓/g)?.length, 2, "expanded children keep one check each");
	} finally {
		hooks.shutdown();
	}
});

test("outer removeChild removes grouped tools, dissolves singletons, and clear forgets groups", () => {
	const hooks = installToolGrouping(() => true);
	try {
		const parent = new Container() as any;
		const read = tool("read", "read");
		const bash = tool("bash", "bash");
		const grep = tool("grep", "grep");
		parent.addChild(read);
		parent.addChild(bash);
		parent.addChild(grep);
		const group = parent.children[0] as ToolGroupComponent;
		assert.ok(group instanceof ToolGroupComponent);
		assert.match(group.render(100).find((line: string) => line.trim())!, /click to show more/);

		parent.removeChild(bash);
		assert.deepEqual(group.children, [read, grep]);
		parent.removeChild(read);
		assert.deepEqual(parent.children, [grep], "one remaining tool is automatically ungrouped");
		parent.removeChild(grep);
		assert.deepEqual(parent.children, []);

		parent.addChild(tool("read", "new-read"));
		parent.addChild(tool("bash", "new-bash"));
		assert.ok(parent.children[0] instanceof ToolGroupComponent);
		parent.clear();
		assert.deepEqual(parent.children, []);
		hooks.refresh();
	} finally {
		hooks.shutdown();
	}
});

test("off refresh ungroups, reload rescans existing tools, and stale shutdown preserves ownership", () => {
	const prototype = Container.prototype as any;
	const originalAdd = prototype.addChild;
	let mode: "on" | "off" = "on";
	const first = installToolGrouping(() => mode === "on");
	const parent = new Container() as any;
	parent.addChild(tool("read", "one"));
	parent.addChild(tool("bash", "two"));
	assert.ok(parent.children[0] instanceof ToolGroupComponent);
	mode = "off";
	first.refresh();
	assert.equal(
		parent.children.some((child: any) => child instanceof ToolGroupComponent),
		false,
	);

	mode = "on";
	first.refresh();
	parent.addChild(tool("grep", "three"));
	assert.equal(
		parent.children.some((child: any) => child instanceof ToolGroupComponent),
		false,
	);
	parent.addChild(tool("read", "four"));
	assert.ok(parent.children.at(-1) instanceof ToolGroupComponent);

	const firstWrapper = prototype.addChild;
	const second = installToolGrouping(() => true);
	assert.notEqual(prototype.addChild, firstWrapper);
	assert.equal(
		parent.children.some((child: any) => child instanceof ToolGroupComponent),
		false,
		"replacement install first releases old-module groups",
	);
	second.refresh({ getMountedRoots: () => [parent] });
	assert.ok(parent.children[0] instanceof ToolGroupComponent, "reload regroups mounted transcript");
	assert.equal(parent.children[0].children.length, 4);
	first.shutdown();
	const secondWrapper = prototype.addChild;
	assert.equal(prototype.addChild, secondWrapper, "stale shutdown preserves the new owner");
	second.shutdown();
	assert.equal(prototype.addChild, originalAdd);
});

test("pending and expanded groups bypass settled render caching", () => {
	const hooks = installToolGrouping(() => true);
	try {
		const parent = new Container() as any;
		const read = started("read", "live-read");
		const bash = started("bash", "live-bash");
		parent.addChild(read);
		parent.addChild(bash);
		const group = parent.children[0] as ToolGroupComponent;

		const pending = group.render(120);
		assert.notStrictEqual(group.render(120), pending, "pending spinner output is not memoized");

		read.updateResult({ content: [], isError: false });
		bash.updateResult({ content: [], isError: false });
		group.setExpanded(true);
		const expanded = group.render(120);
		assert.notStrictEqual(group.render(120), expanded, "expanded child output is not memoized");
	} finally {
		hooks.shutdown();
	}
});

test("settled collapsed groups reuse the last render until inputs change", () => {
	const hooks = installToolGrouping(() => true);
	hooks.setTheme({ fg: (_color: string, text: string) => text });
	try {
		const parent = new Container() as any;
		const read = tool("read", "cached-read", { path: "a.ts" });
		const bash = tool("bash", "cached-bash", { command: "ls" });
		read.updateResult({ content: [], isError: false });
		bash.updateResult({ content: [], isError: false });
		parent.addChild(read);
		parent.addChild(bash);
		const group = parent.children[0] as ToolGroupComponent;

		const first = group.render(120);
		assert.strictEqual(group.render(120), first, "identical settled frame reuses the cached lines");
		group.invalidate();
		const invalidated = group.render(120);
		assert.notStrictEqual(invalidated, first, "invalidation clears settled output");
		assert.strictEqual(group.render(120), invalidated, "new output is memoized");

		const wider = group.render(160);
		assert.notStrictEqual(wider, first);
		assert.match(wider.find((line: string) => line.trim())!, /2 done/);

		group.setHintHovered(true);
		const hovered = group.render(160);
		assert.notStrictEqual(hovered, wider);
		assert.strictEqual(group.render(160), hovered);

		hooks.setTheme({ fg: (color: string, text: string) => `<${color}>${text}</${color}>` });
		const themed = group.render(160);
		assert.notStrictEqual(themed, hovered);
		assert.match(themed.join("\n"), /<success>2<\/success> done/);

		bash.updateResult({ content: [], isError: true });
		const failed = group.render(160);
		assert.notStrictEqual(failed, themed);
		assert.match(failed.join("\n"), /<success>1<\/success> done/);
		assert.match(failed.join("\n"), /<error>1<\/error> failed/);

		group.setExpanded(true);
		const expanded = group.render(160);
		assert.notStrictEqual(expanded, failed);
		group.setExpanded(false);
		const collapsed = group.render(160);
		assert.notStrictEqual(collapsed, failed, "expansion changes clear settled output");
		assert.strictEqual(group.render(160), collapsed, "collapsed output is memoized again");

		parent.addChild(started("grep", "cached-grep", { pattern: "todo" }));
		const grown = group.render(200);
		assert.notStrictEqual(grown, collapsed);
		assert.match(grown.join("\n"), /running/);
		assert.match(grown.join("\n"), /<success>1<\/success> done/);
		assert.match(grown.join("\n"), /<error>1<\/error> failed/);
	} finally {
		hooks.shutdown();
	}
});

function plain(lines: string[]): string[] {
	return lines
		.map((line) => line.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, ""))
		.filter((line) => line.trim());
}

test("powershell 分组行显示具体命令（issue 26）", () => {
	const hooks = installToolGrouping(() => true);
	try {
		const parent = new Container() as any;
		parent.addChild(started("powershell", "ps-1", { command: "Get-ChildItem -Recurse" }));
		parent.addChild(started("powershell", "ps-2", { command: "$env:FOO = 'bar'" }));
		const group = parent.children[0] as ToolGroupComponent;
		const collapsed = plain(group.render(120));
		assert.match(collapsed[0], /^ ● PowerShell: 2 running/);
		assert.match(collapsed[1], /PowerShell Get-ChildItem -Recurse$/);
		assert.match(collapsed[2], /PowerShell \$env:FOO = 'bar'$/);
	} finally {
		hooks.shutdown();
	}
});

test("default 与 grouping 共用同一份摘要取值链", () => {
	const plain = (_color: string, text: string) => text;
	const cases: Array<[string, any, string]> = [
		["powershell", { command: "npm test" }, "PowerShell npm test"],
		["bash", { command: "npm test" }, "Bash npm test"],
		["grep", { pattern: "foo|bar", path: "extensions/" }, 'Grep "foo|bar" in extensions/'],
		["ffgrep", { pattern: "hero", path: "assets/" }, 'Ffgrep "hero" in assets/'],
		["source_check", { claim: "README 用 webp" }, "Source Check README 用 webp"],
		["web_search", { queries: ["a", "b"] }, "Web Search a (+1)"],
		["web_search", { queries: ["a"] }, "Web Search a"],
		["fetch_content", { urls: ["https://a", "https://b"] }, "Fetch Content https://a (+1)"],
		["get_search_content", { responseId: "rid-1" }, "Get Search Content rid-1"],
		["Agent", { description: "review code" }, "Subagent review code"],
	];
	for (const [name, args, expected] of cases) {
		for (const variant of ["default", "grouping"] as const) {
			const summary = toolCallSummary(name, args, { variant, cwd: process.cwd() });
			assert.equal(renderToolSummary(summary, 400, plain), expected, `${name} / ${variant}`);
		}
	}
});

test("折叠分组行：codemode 报结果统计，没结果时退回代码预览", () => {
	const hooks = installToolGrouping(() => true);
	try {
		const code = 'const r = await tools.bash({ command: "ls" })';
		const blocks = (output: string) => [
			{ type: "text", text: "Script completed\nWall time 1.02 seconds\nOutput:\n" },
			{ type: "text", text: output },
		];
		const settled = (id: string, calls: unknown[], output: string) => {
			const component = started("codemode", id, { code });
			component.updateResult({ content: blocks(output), details: { calls }, isError: false });
			return component;
		};
		const one = { id: "c/1", name: "bash", args: '{"command":"ls"}', status: "ok", durationMs: 11 };
		const another = {
			id: "c/2",
			name: "read",
			args: '{"path":"a.ts"}',
			status: "ok",
			durationMs: 3,
		};

		const parent = new Container() as any;
		parent.addChild(settled("cd-1", [one], "one"));
		parent.addChild(settled("cd-2", [one, another], "two\nthree"));
		parent.addChild(started("codemode", "cd-3", { code }));
		const rows = parent.children[0]
			.render(120)
			.map((line: string) => line.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").trimEnd());

		assert.match(rows[1]!, /^ ● Codemode: 1 running · 2 done/);
		assert.equal(rows[2], " ├ ✓ Codemode 1 call · 1 line output");
		assert.equal(rows[3], " ├ ✓ Codemode 2 calls · 2 lines output");
		// 还没结果：退回参数摘要，同样不带 code 预览
		assert.match(rows[4]!, /^ └ [⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] Codemode$/);
	} finally {
		hooks.shutdown();
	}
});

test("humanizeToolLabel 保留品牌大小写", () => {
	assert.equal(humanizeToolLabel("powershell"), "PowerShell");
	assert.equal(humanizeToolLabel("bash"), "Bash");
	// MCP 入口两个的缩写固定写法
	assert.equal(humanizeToolLabel("mcp"), "MCP");
	assert.equal(humanizeToolLabel("mcpScript"), "MCP Script");
});

test("collapsed group rows share the single-card viewport width", async () => {
	const { config } = await import("../extensions/config/config.ts");
	const { toolViewportWidth } = await import("../extensions/renderer/tool/result.ts");
	const { visibleWidth } = await import("@earendil-works/pi-tui");
	const previousToolLabelClip = config.toolLabelClip;
	config.toolLabelClip = 0;
	const hooks = installToolGrouping(() => true);
	try {
		const parent = new Container() as any;
		const long = `echo ${"x".repeat(400)}`;
		for (const id of ["a", "b"]) {
			const bash = tool("bash", id, { command: long });
			bash.updateResult({ content: [], isError: false });
			parent.addChild(bash);
		}
		const rows = (parent.children[0] as ToolGroupComponent)
			.render(200)
			.filter((line: string) => /[├└]/.test(line));
		assert.equal(rows.length, 2);
		for (const row of rows) assert.equal(visibleWidth(row), toolViewportWidth(200));
	} finally {
		config.toolLabelClip = previousToolLabelClip;
		hooks.shutdown();
	}
});

test("group headers share the single-card viewport limit without stretching short titles", async () => {
	const { toolViewportWidth } = await import("../extensions/renderer/tool/result.ts");
	const { visibleWidth } = await import("@earendil-works/pi-tui");
	const hooks = installToolGrouping(() => true);
	try {
		const parent = new Container() as any;
		const command = `echo ${"x".repeat(400)}`;
		parent.addChild(started("read", "header-read", { path: "x".repeat(400) }));
		const bash = tool("bash", "header-bash", { command });
		bash.updateResult({ content: [], isError: false });
		parent.addChild(bash);
		const grep = tool("grep", "header-grep", { pattern: "x".repeat(400) });
		grep.updateResult({ content: [], isError: true });
		parent.addChild(grep);
		const group = parent.children[0] as ToolGroupComponent;
		for (const expanded of [false, true]) {
			group.setExpanded(expanded);
			const fullHeader = group.render(400)[1];
			for (const width of [60, 120, 200]) {
				const header = group.render(width)[1];
				assert.equal(
					visibleWidth(header),
					Math.min(visibleWidth(fullHeader), toolViewportWidth(width)),
				);
				if (width === 200) assert.equal(header, fullHeader);
			}
		}
	} finally {
		hooks.shutdown();
	}
});

test("组头列表用人性化名并恒带次数；组内 shell 行只报耗时", () => {
	const hooks = installToolGrouping(() => true);
	const plain = (lines: string[]) =>
		lines.map((line) => line.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")).filter((line) => line.trim());
	try {
		const parent = new Container() as any;
		const bash = started("bash", "sh-bash", { command: "npm test" });
		bash.updateResult({
			content: [{ type: "text", text: "ok" }],
			isError: false,
			durationMs: 12_400,
		});
		const ps = started("powershell", "sh-ps", { command: "Get-ChildItem" });
		ps.updateResult({ content: [], isError: false, durationMs: 300 });
		parent.addChild(bash);
		parent.addChild(ps);
		const rows = plain((parent.children[0] as ToolGroupComponent).render(140));
		// 单组标题用 toolTitle，列表跟子行同一套写法；各跑一次也报 ×1。
		assert.equal(rows[0], " ● Multiple Tools: 2 done · Bash×1, PowerShell×1 · click to show more");
		// 只报耗时：行数在折叠卡里冗余，展开就能看到。
		assert.equal(rows[1], " ├ ✓ Bash npm test · 12.4s");
		assert.equal(rows[2], " └ ✓ PowerShell Get-ChildItem · 300ms");

		// 失败也不带输出：错误正文在展开后看，行上只留 ✗ 和耗时。
		const parent3 = new Container() as any;
		const bad = started("bash", "sh-bad", { command: "false" });
		bad.updateResult({
			content: [{ type: "text", text: "ENOENT: no such file\nsecond line" }],
			isError: true,
			durationMs: 20,
		});
		const ok = started("bash", "sh-ok", { command: "true" });
		ok.updateResult({ content: [{ type: "text", text: "ok" }], isError: false, durationMs: 5 });
		parent3.addChild(bad);
		parent3.addChild(ok);
		const rows3 = plain((parent3.children[0] as ToolGroupComponent).render(140));
		assert.equal(rows3[1], " ├ ✗ Bash false · 20ms");
		assert.equal(rows3[2], " └ ✓ Bash true · 5ms");

		// 非 shell 工具不补尾巴。
		const parent2 = new Container() as any;
		const read = started("read", "sh-read", { path: "a.ts" });
		read.updateResult({ content: [{ type: "text", text: "x" }], isError: false, durationMs: 5 });
		const grep = started("grep", "sh-grep", { pattern: "x" });
		grep.updateResult({ content: [{ type: "text", text: "y" }], isError: false });
		parent2.addChild(read);
		parent2.addChild(grep);
		const rows2 = plain((parent2.children[0] as ToolGroupComponent).render(140));
		assert.equal(rows2[1], " ├ ✓ Read a.ts");
		assert.equal(rows2[2], ' └ ✓ Grep "x"');

		// 窄宽度下先让出工具列表，保住行尾展开提示（鼠标层的命中锚点）。
		const narrow = plain((parent.children[0] as ToolGroupComponent).render(72));
		assert.match(narrow[0]!, /· click to show more$/);
		assert.ok(narrow[0]!.length <= Math.floor(72 * 0.8));
	} finally {
		hooks.shutdown();
	}
});

test("分组展开卡为内联图片留出全部占位行", () => {
	// 图片序列只写在锚点行，其余是空占位行：按空白行丢掉后，终端里图片会盖住后面的内容。
	setCellDimensions({ widthPx: 9, heightPx: 18 });
	setCapabilities({ images: "kitty", trueColor: true, hyperlinks: false });
	const hooks = installToolGrouping(() => true);
	try {
		const parent = new Container() as any;
		const bash = started("bash", "img-bash");
		// 图片工具放末项：分组卡会裁末项的尾随空行，正是图片占位行所在的位置。
		const read = started("read", "img-read");
		parent.addChild(bash);
		parent.addChild(read);
		assert.ok(parent.children[0] instanceof ToolGroupComponent, "两个工具应合成一张分组卡");
		const group = parent.children[0] as ToolGroupComponent;
		group.setExpanded(true);
		bash.updateResult({ content: [{ type: "text", text: "done" }], isError: false });
		read.updateResult({
			content: [
				{ type: "text", text: "shot.png" },
				{ type: "image", data: solidPngBase64(), mimeType: "image/png" },
			],
			isError: false,
		});

		const lines: string[] = group.render(100);
		const plain = (line: string): string =>
			line
				.replace(/\x1b_G[^\x1b]*\x1b\\/g, "")
				.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
				.replace(/^[│├└]\s*/, "");
		const imageRow = lines.findIndex((line) => line.includes("\x1b_G"));
		assert.ok(imageRow >= 0, `展开卡里应保留图片锚点行: ${lines.map(plain).join("\n")}`);
		const rows = Number(
			/(?:^|,)r=(\d+)/.exec(/\x1b_G([^;]*);/.exec(lines[imageRow])?.[1] ?? "")?.[1],
		);
		assert.ok(rows > 1, `测试图片应占多行，实际 r=${rows}`);
		assert.ok(
			imageRow + rows <= lines.length,
			`图片占 ${rows} 行，卡里只剩 ${lines.length - imageRow} 行（后面的内容会被盖住）`,
		);
		for (let index = imageRow + 1; index < imageRow + rows; index++) {
			assert.equal(plain(lines[index]).trim(), "", `图片占位行不该有文本: 第 ${index} 行`);
			// pi-tui 靠「锚点行含图片序列 + 其后连续零宽行」认整块图片。
			// 占位行只要带上底色/空格就认不出来，图片会被当成普通行盖成空白。
			assert.equal(visibleWidth(lines[index]), 0, `图片占位行必须零宽: 第 ${index} 行`);
		}
		// 锚点行行尾不能补底色空格：那些格子就在图片首行上。
		assert.equal(
			visibleWidth(lines[imageRow]),
			visibleWidth(plain(lines[imageRow])),
			"图片锚点行不该补底色",
		);
	} finally {
		hooks.shutdown();
		resetCapabilitiesCache();
	}
});

test("多工具展开：子卡首行只剩图标时不额外占一行（issue: 重复显示 icon）", () => {
	const hooks = installToolGrouping(() => true);
	try {
		const parent = new Container() as any;
		const first = started("bash", "dup-icon-a", { command: "head -c 400 junit.xml" });
		const second = started("bash", "dup-icon-b", { command: "node --version" });
		for (const tool of [first, second]) {
			tool.updateResult({ content: [{ type: "text", text: "out" }], isError: false });
		}
		parent.addChild(first);
		parent.addChild(second);
		parent.render(100);
		const group = parent.children[0] as ToolGroupComponent;
		group.setExpanded(true);
		group.render(100);

		// 复现现场：子卡的首个可见行被剥成一个孤零零的图标，标题落到下一行。
		const paintWithOrphanIcon = () => [
			"",
			" ✓ ",
			" ✓ Bash head -c 400 junit.xml",
			" └ Output",
			"   out",
		];
		first.render = paintWithOrphanIcon as any;

		const rendered = group
			.render(100)
			.map((line: string) => line.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, ""))
			.filter((line: string) => line.trim());
		assert.deepEqual(
			rendered.filter((line: string) => /^\s*[├└│]?\s*✓\s*$/.test(line)),
			[],
			`不该有只有图标的空行: ${rendered.join(" | ")}`,
		);
		assert.equal(rendered[1]!.trimEnd(), " ├ ✓ Bash head -c 400 junit.xml", rendered.join(" | "));
	} finally {
		hooks.shutdown();
	}
});
