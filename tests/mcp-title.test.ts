import assert from "node:assert/strict";
import test from "node:test";
import { ToolExecutionComponent, initTheme } from "@earendil-works/pi-coding-agent";
import { Container } from "@earendil-works/pi-tui";
import { config, formatConfigStatus, normalizeConfig } from "../extensions/config/config.ts";
import claudeCodeStyleExtension from "../extensions/renderer/index.ts";
import { installToolGrouping, ToolGroupComponent } from "../extensions/renderer/tool/grouping.ts";
import {
	extractMcpGatewayServerId,
	isMcpToolDefinition,
	mcpServerDisplayName,
	mcpToolTitle,
} from "../extensions/renderer/tool/mcp-title.ts";

initTheme("dark");

// Real name/label registered by pi-mcp-adapter (with renderCall, matching the adapter)
const ADAPTER_TOOLS = [
	{ name: "mcp", label: "MCP", renderCall() {} },
	{ name: "mcpScript", label: "MCP Script", renderCall() {} },
	{ name: "mcp__github", label: "MCP: github", renderCall() {} },
	{ name: "mcp__exa", label: "MCP: exa", renderCall() {} },
	{ name: "mcp__brave_search", label: "MCP: brave-search", renderCall() {} },
];
const EXPECTED_TITLES: Record<string, string> = {
	mcp: "MCP",
	mcpScript: "MCP Script",
	mcp__github: "GitHub",
	mcp__exa: "Exa",
	mcp__brave_search: "Brave Search",
};

function withGatewayFlag<T>(enabled: boolean, run: () => T): T {
	const previous = config.mcpGatewayServerIdExtraction;
	config.mcpGatewayServerIdExtraction = enabled;
	try {
		return run();
	} finally {
		config.mcpGatewayServerIdExtraction = previous;
	}
}

const plain = (lines: string[]) =>
	lines.map((line) => line.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")).filter((line) => line.trim());

test("mcpScript is identified as an MCP tool", () => {
	assert.equal(isMcpToolDefinition({ label: "MCP Script" }, "mcpScript"), true);
	assert.equal(isMcpToolDefinition(undefined, "mcpScript"), true);
});

test("unified MCP title covers namespace, script, and gateway tools", () => {
	for (const flag of [false, true]) {
		withGatewayFlag(flag, () => {
			for (const tool of ADAPTER_TOOLS) {
				assert.equal(
					mcpToolTitle({ toolName: tool.name, definition: tool, args: { tool: "x" } }),
					EXPECTED_TITLES[tool.name],
					`${tool.name} (flag=${flag})`,
				);
			}
		});
	}
	// Non-MCP tools are handed back to the caller
	assert.equal(mcpToolTitle({ toolName: "read", definition: { label: "read" } }), undefined);
	// Other MCP forms (e.g. direct tools) keep humanizeMcpToolName
	assert.equal(
		mcpToolTitle({ toolName: "github_search_code", definition: { label: "MCP: search_code" } }),
		"Github Search Code",
	);
	assert.equal(
		mcpToolTitle({ toolName: "mcp__filesystem__read_file", definition: {} }),
		"Filesystem Read File",
	);
});

test("gateway server id extraction is gated by the feature flag", () => {
	const context = { toolName: "mcp", definition: { label: "MCP" }, args: { server: "github" } };
	assert.equal(extractMcpGatewayServerId(context), undefined, "placeholder yields no id yet");
	const extractor = () => "brave-search";
	withGatewayFlag(false, () => assert.equal(mcpToolTitle(context, extractor), "MCP"));
	withGatewayFlag(true, () => {
		assert.equal(mcpToolTitle(context, extractor), "Brave Search");
		assert.equal(
			mcpToolTitle(context, () => "github"),
			"GitHub",
		);
		assert.equal(
			mcpToolTitle(context, () => undefined),
			"MCP",
		);
		assert.equal(
			mcpToolTitle(context, () => "  "),
			"MCP",
		);
	});
	assert.equal(normalizeConfig({}).mcpGatewayServerIdExtraction, false);
	assert.equal(
		normalizeConfig({ mcpGatewayServerIdExtraction: true }).mcpGatewayServerIdExtraction,
		true,
	);
	assert.match(formatConfigStatus(normalizeConfig({})), /mcpGatewayId=off/);
});

test("server display names use the static mapping before title-casing", () => {
	assert.equal(mcpServerDisplayName("github"), "GitHub");
	assert.equal(mcpServerDisplayName("GitHub"), "GitHub");
	assert.equal(mcpServerDisplayName("brave-search"), "Brave Search");
	assert.equal(mcpServerDisplayName("brave_search"), "Brave Search");
	assert.equal(mcpServerDisplayName("context7"), "Context7");
	assert.equal(mcpServerDisplayName("constructor"), "Constructor");
	assert.equal(mcpServerDisplayName("__"), "MCP");
});

test("standalone and grouped MCP rows render the same unified title", async () => {
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
	const make = (definition: any, id: string) =>
		new ToolExecutionComponent(
			definition.name,
			id,
			{ tool: "search" },
			{},
			definition,
			ui as any,
			process.cwd(),
		) as any;
	try {
		await events.get("session_start")?.({}, ctx);
		for (const definition of ADAPTER_TOOLS) {
			const expected = EXPECTED_TITLES[definition.name]!;
			const standalone = plain(make(definition, `${definition.name}-solo`).render(100));
			assert.match(standalone[0]!, new RegExp(`^ \\S+ ${expected}$`), definition.name);

			const hooks = installToolGrouping(() => true);
			try {
				const parent = new Container() as any;
				parent.addChild(make(definition, `${definition.name}-a`));
				parent.addChild(make(definition, `${definition.name}-b`));
				const group = parent.children[0] as ToolGroupComponent;
				assert.ok(group instanceof ToolGroupComponent);
				const rows = plain(group.render(100));
				assert.match(rows[0]!, new RegExp(`^ ● ${expected}: 2 running`), definition.name);
				assert.match(rows[1]!, new RegExp(`^ ├ \\S+ ${expected}$`), definition.name);
				assert.match(rows[2]!, new RegExp(`^ └ \\S+ ${expected}$`), definition.name);
			} finally {
				hooks.shutdown();
			}
		}

		// Mixed group: the name list keeps raw tool names
		const hooks = installToolGrouping(() => true);
		try {
			const parent = new Container() as any;
			parent.addChild(make(ADAPTER_TOOLS[2], "mixed-github"));
			parent.addChild(make(ADAPTER_TOOLS[3], "mixed-exa"));
			const rows = plain((parent.children[0] as ToolGroupComponent).render(100));
			assert.match(rows[0]!, /^ ● Multiple Tools: 2 running .*mcp__github, mcp__exa/);
			assert.match(rows[1]!, /^ ├ \S+ GitHub$/);
			assert.match(rows[2]!, /^ └ \S+ Exa$/);
		} finally {
			hooks.shutdown();
		}
	} finally {
		await events.get("session_shutdown")?.({}, ctx);
	}
});
