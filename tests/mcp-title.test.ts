import assert from "node:assert/strict";
import test from "node:test";
import { ToolExecutionComponent, initTheme } from "@earendil-works/pi-coding-agent";
import { Container } from "@earendil-works/pi-tui";
import claudeCodeStyleExtension from "../extensions/renderer/index.ts";
import { installToolGrouping, ToolGroupComponent } from "../extensions/renderer/tool/grouping.ts";
import { renderToolSummary } from "../extensions/renderer/tool/names.ts";
import { isMcpToolDefinition, mcpToolTitle } from "../extensions/renderer/tool/mcp-title.ts";

initTheme("dark");

// pi-mcp-adapter 的真实注册名（含自带 renderCall）。同一工具在不同 toolPrefix 下名字不同：
// server 前缀 github_search_code / mcp 前缀 mcp__github_search_code / none 前缀 search_code，
// 只有带 mcp 片段的名字能靠名字判定，其余靠 adapter 给的 label。
const GATEWAY = { name: "mcp", label: "MCP", renderCall() {}, renderResult() {} };
const SCRIPT = { name: "mcpScript", label: "MCP Script", renderCall() {}, renderResult() {} };
const NAMESPACE = { name: "mcp__github_search_code", label: "MCP: search_code", renderCall() {} };
const DIRECT = { name: "github_search_code", label: "MCP: search_code", renderCall() {} };

const plain = (lines: string[]) =>
	lines.map((line) => line.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")).filter((line) => line.trim());

test("判定：名字带 mcp 片段或 label 以 MCP: 开头", () => {
	assert.equal(isMcpToolDefinition({}, "mcp"), true);
	assert.equal(isMcpToolDefinition({}, "mcpScript"), true);
	assert.equal(isMcpToolDefinition({}, "mcp__github_search_code"), true);
	assert.equal(isMcpToolDefinition({}, "mcp__chrome_devtools"), true);
	assert.equal(isMcpToolDefinition({}, "mcp:github/list"), true);
	// 默认/none/short 前缀的直连工具名字里没有 mcp，靠 label
	assert.equal(isMcpToolDefinition({ label: "MCP: search_code" }, "github_search_code"), true);
	assert.equal(isMcpToolDefinition({ label: "MCP: search_code" }, "search_code"), true);
	// 都不是就不算
	assert.equal(isMcpToolDefinition({ label: "read" }, "read"), false);
	assert.equal(isMcpToolDefinition({ description: "Model Context Protocol" }, "remote"), false);
});

test("标题：具体工具用真实工具名，入口两个走人性化（MCP / MCP Script）", () => {
	assert.equal(mcpToolTitle({ toolName: "mcp" }), "MCP");
	assert.equal(mcpToolTitle({ toolName: "mcp__github_search_code" }), "mcp__github_search_code");
	assert.equal(mcpToolTitle({ toolName: "mcp__chrome_devtools" }), "mcp__chrome_devtools");
	assert.equal(mcpToolTitle({ toolName: "mcpScript" }), "MCP Script");
	assert.equal(
		mcpToolTitle({ toolName: "github_search_code", definition: DIRECT }),
		"github_search_code",
	);
	assert.equal(mcpToolTitle({ toolName: "read", definition: { label: "read" } }), undefined);
});

/** 与 generate-tool-render-examples 一致的最小 ui 桩。 */
function stubUi() {
	return {
		theme: { fg: (_color: string, text: string) => text },
		setStatus() {},
		requestRender() {},
		getToolsExpanded: () => false,
	} as any;
}

async function bootExtension(ui: any) {
	const events = new Map<string, Function>();
	claudeCodeStyleExtension(
		{
			registerCommand() {},
			registerShortcut() {},
			registerTool() {},
			on(name: string, handler: Function) {
				events.set(name, handler);
			},
		} as any,
		{ mode: "on" },
	);
	const ctx = { mode: "tui", hasUI: true, ui } as any;
	await events.get("session_start")?.({}, ctx);
	return async () => {
		await events.get("session_shutdown")?.({}, ctx);
	};
}

function makeTool(definition: any, id: string, args: any, ui: any) {
	return new ToolExecutionComponent(
		definition.name,
		id,
		args,
		{},
		definition as any,
		ui,
		process.cwd(),
	) as any;
}

function succeed(component: any, args: any, text = "ok") {
	component.updateArgs(args);
	component.markExecutionStarted();
	component.updateResult({ content: [{ type: "text", text }], isError: false });
	return component;
}

test("标题行：标题用 toolTitle，载荷用 dim，宽度不够时省掉载荷", () => {
	const fg = (color: string, text: string) => `<${color}>${text}</${color}>`;
	const summary = { main: "MCP call github_search_code", detail: "", payload: '{"query":"pi"}' };
	// 样式分离
	assert.equal(
		renderToolSummary(summary, 100, fg as any),
		'<toolTitle>MCP call github_search_code</toolTitle><dim> {"query":"pi"}</dim>',
	);
	// 放不下载荷：只留标题
	assert.equal(
		renderToolSummary({ ...summary, main: "MCP" }, 6, fg as any),
		"<toolTitle>MCP</toolTitle>",
	);
	// 载荷自身超宽：尾部省略，仍用 dim
	const wide = renderToolSummary(
		{ main: "MCP", detail: "", payload: JSON.stringify({ query: "x".repeat(60) }) },
		40,
		fg as any,
	);
	assert.match(wide, /^<toolTitle>MCP<\/toolTitle><dim> \{"query":"x+…<\/dim>$/);
});

test("单卡：标题是真实工具名；直连走字段链，网关用 adapter 的动作风格", async () => {
	const ui = stubUi();
	const shutdown = await bootExtension(ui);
	const lines = (component: any) => plain(component.render(100));
	const main = (component: any) => lines(component)[0]!.replace(/^ \S+ /, "");
	try {
		const namespace = succeed(makeTool(NAMESPACE, "mcp-ns", {}, ui), { query: "pi" }, "1 hit");
		assert.equal(main(namespace), "mcp__github_search_code pi");

		// 网关：按 adapter 的 `mcp <动作> <目标>` 风格，内层入参用 dim 接在后面
		const gateway = succeed(
			makeTool(GATEWAY, "mcp-gw", {}, ui),
			{ tool: "github_search_code", args: { query: "pi" } },
			"1 hit",
		);
		assert.equal(main(gateway), 'MCP call github_search_code {"query":"pi"}');

		const serverOnly = succeed(
			makeTool(GATEWAY, "mcp-server", {}, ui),
			{ server: "chrome-devtools" },
			"29 tools",
		);
		assert.equal(main(serverOnly), "MCP list chrome-devtools");

		const search = succeed(
			makeTool(GATEWAY, "mcp-search", {}, ui),
			{ search: "screenshot", server: "chrome-devtools", regex: true },
			"2 tools",
		);
		assert.equal(main(search), "MCP search screenshot @ chrome-devtools (regex)");

		const describe = succeed(
			makeTool(GATEWAY, "mcp-describe", {}, ui),
			{ describe: "take_screenshot" },
			"1 tool",
		);
		assert.equal(main(describe), "MCP describe take_screenshot");

		// 空入参：adapter 自己显示 mcp status
		const empty = succeed(makeTool(GATEWAY, "mcp-empty", {}, ui), {}, "1 hit");
		assert.equal(main(empty), "MCP status");

		// 网关认不出的键：回退整包 JSON，不猜成 status
		const unknown = succeed(makeTool(GATEWAY, "mcp-unknown", {}, ui), { foo: 1 }, "1 hit");
		assert.equal(main(unknown), 'MCP {"foo":1}');

		// 直连工具无入参字段：只显示名字
		const noArgs = succeed(makeTool(NAMESPACE, "mcp-noargs", {}, ui), {}, "1 hit");
		assert.equal(main(noArgs), "mcp__github_search_code");

		// mcpScript：标题固定为 MCP Script，代码作为载荷（dim）
		const script = succeed(
			makeTool(SCRIPT, "mcp-script", {}, ui),
			{ code: "emit(1)", timeoutMs: 30000 },
			"1 line",
		);
		const scriptRows = lines(script);
		assert.equal(scriptRows[0]!.replace(/^ \S+ /, ""), "MCP Script emit(1)");
		assert.match(scriptRows[1]!, /^   ↳ 1 line returned/);

		// 命名空间工具的入参是 {tool, args}，字段链认不出，回退完整 JSON
		const namespaceCall = succeed(
			makeTool(NAMESPACE, "mcp-ns2", {}, ui),
			{ tool: "list_pages", args: {} },
			"1 line",
		);
		assert.equal(main(namespaceCall), 'mcp__github_search_code {"tool":"list_pages","args":{}}');

		// 非 MCP 工具同样受益：自定义参数键不再只剩标题
		const custom = succeed(
			makeTool({ name: "customTranslate", label: "Custom Translate" }, "custom-1", {}, ui),
			{ text: "hi" },
			"1 line",
		);
		assert.equal(main(custom), 'Custom Translate {"text":"hi"}');

		// 默认前缀的直连工具：靠 label 判定，标题仍是真实名字
		const direct = succeed(makeTool(DIRECT, "mcp-direct", {}, ui), { query: "pi" }, "1 hit");
		assert.equal(main(direct), "github_search_code pi");

		// 结果行不再有 server 标注
		assert.match(lines(namespace)[1]!, /^   ↳ 1 line returned/);
	} finally {
		await shutdown();
	}
});

test("分组：行标题与头标题都用真实工具名", () => {
	const ui = stubUi();
	const hooks = installToolGrouping(() => true);
	const groupRows = (container: any) =>
		plain((container.children[0] as ToolGroupComponent).render(100));
	try {
		const namespace = new Container() as any;
		const a = makeTool(NAMESPACE, "ns-a", { query: "pi" }, ui);
		const b = makeTool(NAMESPACE, "ns-b", { query: "pi" }, ui);
		namespace.addChild(a);
		namespace.addChild(b);
		succeed(a, { query: "pi" }, "1 hit");
		succeed(b, { query: "pi" }, "1 hit");
		assert.match(groupRows(namespace)[0]!, /^ ● mcp__github_search_code: 2 done/);
		assert.deepEqual(groupRows(namespace).slice(1), [
			" ├ ✓ mcp__github_search_code pi",
			" └ ✓ mcp__github_search_code pi",
		]);

		// 网关：行标题用 adapter 的动作风格（无内层入参时不接载荷）
		const gateway = new Container() as any;
		const c = makeTool(GATEWAY, "gw-a", {}, ui);
		const d = makeTool(GATEWAY, "gw-b", {}, ui);
		gateway.addChild(c);
		gateway.addChild(d);
		succeed(c, { tool: "github_search_code", args: {} }, "1 hit");
		succeed(d, { tool: "github_search_code", args: {} }, "1 hit");
		assert.match(groupRows(gateway)[0]!, /^ ● MCP: 2 done/);
		assert.deepEqual(groupRows(gateway).slice(1), [
			" ├ ✓ MCP call github_search_code",
			" └ ✓ MCP call github_search_code",
		]);

		// 不同工具混编：头标题仍是 Multiple Tools
		const mixed = new Container() as any;
		const e = makeTool(GATEWAY, "mx-a", {}, ui);
		const f = makeTool(NAMESPACE, "mx-b", {}, ui);
		mixed.addChild(e);
		mixed.addChild(f);
		succeed(e, { tool: "github_search_code", args: {} }, "1 hit");
		succeed(f, { query: "pi" }, "1 hit");
		assert.match(groupRows(mixed)[0]!, /^ ● Multiple Tools: 2 done/);
		assert.deepEqual(groupRows(mixed).slice(1), [
			" ├ ✓ MCP call github_search_code",
			" └ ✓ mcp__github_search_code pi",
		]);
	} finally {
		hooks.shutdown();
	}
});
