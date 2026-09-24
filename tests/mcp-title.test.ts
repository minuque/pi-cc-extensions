import assert from "node:assert/strict";
import test from "node:test";
import { ToolExecutionComponent, initTheme } from "@earendil-works/pi-coding-agent";
import { Container } from "@earendil-works/pi-tui";
import { config, formatConfigStatus, normalizeConfig } from "../extensions/config/config.ts";
import claudeCodeStyleExtension from "../extensions/renderer/index.ts";
import { installToolGrouping, ToolGroupComponent } from "../extensions/renderer/tool/grouping.ts";
import {
	extractMcpServerId,
	isMcpToolDefinition,
	mcpServerDisplayName,
	mcpToolTitle,
} from "../extensions/renderer/tool/mcp-title.ts";

initTheme("dark");

// Real name/label shapes registered by pi-mcp-adapter (with renderCall, matching the adapter),
// plus the server each call's result reports in `details.server`.
const ADAPTER_TOOLS = [
	{ definition: { name: "mcp", label: "MCP", renderCall() {} }, server: "github", title: "GitHub" },
	{
		definition: { name: "mcpScript", label: "MCP Script", renderCall() {} },
		server: "exa",
		title: "MCP Script",
	},
	{
		definition: { name: "mcp__github", label: "MCP: github", renderCall() {} },
		server: "github",
		title: "GitHub",
	},
	{
		definition: { name: "mcp__exa", label: "MCP: exa", renderCall() {} },
		server: "exa",
		title: "Exa",
	},
	{
		definition: { name: "mcp__brave_search", label: "MCP: brave-search", renderCall() {} },
		server: "brave-search",
		title: "Brave Search",
	},
	// Direct tools: default toolPrefix ("server") and toolPrefix "mcp"
	{
		definition: { name: "github_search_code", label: "MCP: search_code", renderCall() {} },
		server: "github",
		title: "GitHub",
	},
	{
		definition: { name: "mcp__github_search_code", label: "MCP: search_code", renderCall() {} },
		server: "github",
		title: "GitHub",
	},
];

const resultFrom = (server: string) => ({
	content: [{ type: "text", text: "ok" }],
	details: { mode: "call", server, tool: "x" },
	isError: false,
});

function withServerTitles<T>(enabled: boolean, run: () => T): T {
	const previous = config.mcpServerTitles;
	config.mcpServerTitles = enabled;
	try {
		return run();
	} finally {
		config.mcpServerTitles = previous;
	}
}

const plain = (lines: string[]) =>
	lines.map((line) => line.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")).filter((line) => line.trim());

test("mcpScript is identified as an MCP tool", () => {
	assert.equal(isMcpToolDefinition({ label: "MCP Script" }, "mcpScript"), true);
	assert.equal(isMcpToolDefinition(undefined, "mcpScript"), true);
});

test("MCP titles come from the call result for every MCP tool except mcpScript", () => {
	withServerTitles(true, () => {
		for (const { definition, server, title } of ADAPTER_TOOLS) {
			const context = { toolName: definition.name, definition, args: { tool: "x" } };
			const pending = definition.name === "mcpScript" ? "MCP Script" : "MCP";
			assert.equal(mcpToolTitle(context), pending, `${definition.name} pending`);
			assert.equal(
				mcpToolTitle({ ...context, result: resultFrom(server) }),
				title,
				`${definition.name} settled`,
			);
		}
	});
	withServerTitles(false, () => {
		for (const { definition, server } of ADAPTER_TOOLS) {
			assert.equal(
				mcpToolTitle({ toolName: definition.name, definition, result: resultFrom(server) }),
				definition.name === "mcpScript" ? "MCP Script" : "MCP",
				`${definition.name} flag off`,
			);
		}
	});
	// Non-MCP tools are handed back to the caller, even with a server in the result
	assert.equal(
		mcpToolTitle({ toolName: "read", definition: { label: "read" }, result: resultFrom("github") }),
		undefined,
	);
	// Tool names are never parsed for a server id
	withServerTitles(true, () =>
		assert.equal(mcpToolTitle({ toolName: "mcp__filesystem__read_file", definition: {} }), "MCP"),
	);
	assert.equal(normalizeConfig({}).mcpServerTitles, true);
	assert.equal(normalizeConfig({ mcpServerTitles: false }).mcpServerTitles, false);
	assert.match(formatConfigStatus(normalizeConfig({})), /mcpServerTitles=on/);
});

test("server id comes only from the call result", () => {
	const extract = (args: unknown, result?: unknown) =>
		extractMcpServerId({ toolName: "mcp", definition: { label: "MCP" }, args, result });
	const details = (value: Record<string, unknown>) => ({ content: [], details: value });
	// Result shapes observed in real calls (gateway, namespace proxy, direct tool)
	assert.equal(
		extract({ tool: "github_search_code", args: {} }, details({ mode: "call", server: "github" })),
		"github",
	);
	assert.equal(
		extract({ describe: "exa_web_search_exa" }, details({ mode: "describe", server: "exa" })),
		"exa",
	);
	assert.equal(
		extract({ connect: "brave-search" }, details({ mode: "list", server: "brave-search" })),
		"brave-search",
	);
	assert.equal(
		extract({ query: "pi" }, details({ server: "github", tool: "search_code", mcpResult: {} })),
		"github",
	);
	assert.equal(
		extract(
			{ server: "nixos" },
			details({ mode: "list", error: "not_connected", server: " nixos " }),
		),
		"nixos",
	);
	// Pending calls: arguments (even an explicit server) are ignored
	assert.equal(extract({ server: "github" }), undefined);
	assert.equal(extract({ server: "gi" }), undefined);
	// Results without a usable server
	assert.equal(
		extract({ tool: "x" }, details({ mode: "call", error: "tool_not_found", hintServer: "exa" })),
		undefined,
	);
	assert.equal(
		extract({ search: "x", server: "exa" }, details({ mode: "search", count: 0 })),
		undefined,
	);
	assert.equal(extract({}, details({ mode: "status" })), undefined);
	assert.equal(extract({}, details({ server: "   " })), undefined);
	assert.equal(extract({}, details({ server: 42 })), undefined);
	assert.equal(
		extract({}, { content: [{ type: "text", text: "aborted" }], isError: true }),
		undefined,
	);
	assert.equal(extract({}, null), undefined);
	assert.equal(extract({}, "github"), undefined);
});

test("server display names use the static mapping before title-casing", () => {
	assert.equal(mcpServerDisplayName("github"), "GitHub");
	assert.equal(mcpServerDisplayName("GitHub"), "GitHub");
	assert.equal(mcpServerDisplayName("nixos"), "NixOS");
	assert.equal(mcpServerDisplayName("brave-search"), "Brave Search");
	assert.equal(mcpServerDisplayName("brave_search"), "Brave Search");
	assert.equal(mcpServerDisplayName("context7"), "Context7");
	assert.equal(mcpServerDisplayName("constructor"), "Constructor");
	assert.equal(mcpServerDisplayName("__"), "MCP");
});

test("standalone cards switch from MCP to the server once, when the result lands", async () => {
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
	const title = (component: any) => plain(component.render(100))[0]!.replace(/^ \S+ /, "");
	try {
		await events.get("session_start")?.({}, ctx);
		for (const flag of [true, false]) {
			withServerTitles(flag, () => {
				for (const { definition, server, title: settledTitle } of ADAPTER_TOOLS) {
					const card = new ToolExecutionComponent(
						definition.name,
						`${definition.name}-live-${flag}`,
						{},
						{},
						definition as any,
						ui as any,
						process.cwd(),
					) as any;
					const pending = definition.name === "mcpScript" ? "MCP Script" : "MCP";
					assert.equal(title(card), pending, `${definition.name} created`);
					card.markExecutionStarted();
					assert.equal(title(card), pending, `${definition.name} running`);
					card.updateResult(resultFrom(server));
					const settled = flag ? settledTitle : pending;
					assert.equal(title(card), settled, `${definition.name} settled (flag=${flag})`);
					// Later rebuilds (expand/hover/theme) keep the same title
					card.invalidate();
					assert.equal(title(card), settled, `${definition.name} rebuilt (flag=${flag})`);
				}
			});
		}
	} finally {
		await events.get("session_shutdown")?.({}, ctx);
	}
});

test("settled collapsed MCP groups update titles when server titles are toggled", () => {
	const ui = { requestRender() {} } as any;
	const definition = ADAPTER_TOOLS[0]!.definition;
	const hooks = installToolGrouping(() => true);
	try {
		const parent = new Container();
		for (const id of ["mcp-toggle-a", "mcp-toggle-b"]) {
			const tool = new ToolExecutionComponent(
				definition.name,
				id,
				{},
				{},
				definition as any,
				ui,
				process.cwd(),
			);
			tool.updateResult(resultFrom("github") as any);
			parent.addChild(tool);
		}
		const group = parent.children[0] as ToolGroupComponent;
		for (const [enabled, title] of [
			[true, "GitHub"],
			[false, "MCP"],
			[true, "GitHub"],
		] as const) {
			withServerTitles(enabled, () => {
				// Repaint the same settled group without invalidating, resizing, or expanding it.
				const rows = plain(group.render(100));
				assert.match(rows[0]!, new RegExp(`^ ● ${title}: 2 done`));
				assert.deepEqual(rows.slice(1), [` ├ ✓ ${title}`, ` └ ✓ ${title}`]);
			});
		}
	} finally {
		hooks.shutdown();
	}
});

test("grouped MCP rows use each call's result, header falls back to MCP on mismatch", () => {
	const ui = { theme: { fg: (_color: string, text: string) => text }, requestRender() {} } as any;
	const make = (definition: any, id: string) =>
		new ToolExecutionComponent(definition.name, id, {}, {}, definition, ui, process.cwd()) as any;
	const [gateway, , namespaceGithub, namespaceExa, , directDefault] = ADAPTER_TOOLS.map(
		(tool) => tool.definition,
	);
	withServerTitles(true, () => {
		const hooks = installToolGrouping(() => true);
		try {
			const parent = new Container() as any;
			const first = make(gateway, "mcp-group-a");
			const second = make(gateway, "mcp-group-b");
			parent.addChild(first);
			parent.addChild(second);
			const group = parent.children[0] as ToolGroupComponent;
			const rows = () => plain(group.render(100));
			assert.match(rows()[0]!, /^ ● MCP: 2 running/);
			first.updateResult(resultFrom("github"));
			assert.match(rows()[0]!, /^ ● MCP: 1 running/);
			assert.match(rows()[1]!, /^ ├ \S+ GitHub$/);
			assert.match(rows()[2]!, /^ └ \S+ MCP$/);
			second.updateResult(resultFrom("exa"));
			assert.match(rows()[0]!, /^ ● MCP: 2 done/);
			assert.match(rows()[2]!, /^ └ \S+ Exa$/);
		} finally {
			hooks.shutdown();
		}

		// Same tool resolving to the same server: header uses that server
		const sameServer = installToolGrouping(() => true);
		try {
			const parent = new Container() as any;
			const first = make(directDefault, "direct-same-a");
			const second = make(directDefault, "direct-same-b");
			parent.addChild(first);
			parent.addChild(second);
			first.updateResult(resultFrom("github"));
			second.updateResult(resultFrom("github"));
			assert.match(
				plain((parent.children[0] as ToolGroupComponent).render(100))[0]!,
				/^ ● GitHub: 2 done/,
			);
		} finally {
			sameServer.shutdown();
		}

		// Mixed group: the name list keeps raw tool names
		const mixed = installToolGrouping(() => true);
		try {
			const parent = new Container() as any;
			const github = make(namespaceGithub, "mixed-github");
			const exa = make(namespaceExa, "mixed-exa");
			parent.addChild(github);
			parent.addChild(exa);
			github.updateResult(resultFrom("github"));
			exa.updateResult(resultFrom("exa"));
			const rows = plain((parent.children[0] as ToolGroupComponent).render(100));
			assert.match(rows[0]!, /^ ● Multiple Tools: 2 done .*mcp__github, mcp__exa/);
			assert.match(rows[1]!, /^ ├ \S+ GitHub$/);
			assert.match(rows[2]!, /^ └ \S+ Exa$/);
		} finally {
			mixed.shutdown();
		}
	});
});
