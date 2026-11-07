import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FOOTER_NERD_ICON_MCP, footerGlyphs } from "../extensions/feature/shell/footer.ts";
import {
	BUILTIN_MCP_SOURCE,
	buildMcpChip,
	builtinMcpOwnsCommand,
	configuredMcpServers,
	connectedMcpServers,
	formatMcpChip,
	mcpNamespaceServer,
	normalizeMcpServerName,
} from "../extensions/feature/shell/mcp-chip.ts";

const mcpTool = (server: string, extra: Record<string, unknown> = {}) => ({
	name: `mcp__${server}__tool`,
	exposure: "codemode",
	namespace: { name: `mcp__${server}` },
	sourceInfo: { path: BUILTIN_MCP_SOURCE },
	...extra,
});

test("footerGlyphs：MCP 图标跟 nerd 开关一起给/一起收", () => {
	assert.equal(footerGlyphs(true).mcp, FOOTER_NERD_ICON_MCP);
	assert.equal(footerGlyphs(false).mcp, "");
	assert.deepEqual(Object.keys(footerGlyphs(true)).sort(), ["cache", "git", "mcp", "tokens"]);
});

test("名字规范化：`-` 与 `_` 是同一个服务器", () => {
	assert.equal(normalizeMcpServerName("chrome-devtools"), "chrome_devtools");
	assert.equal(normalizeMcpServerName(" chrome_devtools "), "chrome_devtools");
	assert.equal(mcpNamespaceServer("mcp__chrome_devtools"), "chrome_devtools");
	assert.equal(mcpNamespaceServer("mcp__"), undefined);
	assert.equal(mcpNamespaceServer("notes__x"), undefined);
});

test("已连接：来源是 builtin:mcp 且曝光非 hidden，按 namespace 去重", () => {
	assert.deepEqual(
		connectedMcpServers([
			mcpTool("chrome-devtools"),
			mcpTool("chrome-devtools", { name: "mcp__chrome_devtools__other" }),
			mcpTool("github", { exposure: "deferred" }),
			// hidden 的工具不算连接
			mcpTool("hidden-server", { exposure: "hidden" }),
			// 没有 namespace 的资源工具不算
			{ name: "read_mcp_resource", exposure: "direct", sourceInfo: { path: BUILTIN_MCP_SOURCE } },
			// 非 MCP 工具不算
			{ name: "read", exposure: "direct", sourceInfo: { path: "builtin:read" } },
		]),
		["chrome_devtools", "github"],
	);
});

test("已连接：来源路径对不上时按 namespace 兜底", () => {
	assert.deepEqual(
		connectedMcpServers([
			{
				name: "mcp__jira__search",
				exposure: "codemode",
				namespace: { name: "mcp__jira" },
				sourceInfo: { path: "/tmp/other-extension/index.ts" },
			},
		]),
		["jira"],
	);
});

test("芯片文案：已连接/并集，两边都空时不显示", () => {
	assert.equal(formatMcpChip([], []), undefined);
	// `-` 与 `_` 去重后只算一台
	assert.equal(formatMcpChip(["chrome_devtools"], ["chrome-devtools"]), "MCP 1/1");
	assert.equal(formatMcpChip(["a", "b"], ["a", "c"]), "MCP 2/3");
	// 没连上的已配置服务器进分母
	assert.equal(formatMcpChip([], ["a", "b"]), "MCP 0/2");
});

test("已配置：读 mcp.json，跳过 enabled:false，项目级只在已信任时读", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-mcp-chip-"));
	try {
		const agentDir = join(root, "agent");
		const cwd = join(root, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeFileSync(
			join(agentDir, "mcp.json"),
			JSON.stringify({
				mcpServers: {
					filesystem: { command: "npx" },
					legacy: { command: "uvx", enabled: false },
				},
			}),
		);
		writeFileSync(
			join(cwd, ".pi", "mcp.json"),
			JSON.stringify({ mcpServers: { docs: { url: "https://example.com/mcp" } } }),
		);
		assert.deepEqual(configuredMcpServers({ agentDir, cwd, projectTrusted: false }), [
			"filesystem",
		]);
		assert.deepEqual(configuredMcpServers({ agentDir, cwd, projectTrusted: true }), [
			"filesystem",
			"docs",
		]);

		// 损坏的配置不抛错，只当没有
		writeFileSync(join(agentDir, "mcp.json"), "{not json");
		utimesSync(join(agentDir, "mcp.json"), new Date(), new Date());
		assert.deepEqual(configuredMcpServers({ agentDir, cwd, projectTrusted: false }), []);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("组装：工具与命令读 pi API，ctx 只提供 cwd / trust", () => {
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const agentDir = mkdtempSync(join(tmpdir(), "pi-mcp-chip-api-"));
	try {
		// 空 agent 目录：已配置数完全由 mcp.json 决定，测试不受本机配置影响
		process.env.PI_CODING_AGENT_DIR = agentDir;
		const api = {
			getCommands: () => [{ name: "mcp", sourceInfo: { path: BUILTIN_MCP_SOURCE } }],
			getAllTools: () => [mcpTool("chrome-devtools"), mcpTool("jira")],
		};
		const ctx = { cwd: agentDir, isProjectTrusted: () => false };
		assert.equal(buildMcpChip(ctx, api), "MCP 2/2");
		// ctx 上没有这些 API，不能拿来当工具源
		assert.equal(buildMcpChip(ctx, undefined), undefined);
		// 过期 ctx / 未绑定运行时时抛错不冒泡
		assert.equal(
			buildMcpChip(ctx, {
				getCommands: () => {
					throw new Error("stale ctx");
				},
			}),
			undefined,
		);
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(agentDir, { recursive: true, force: true });
	}
});

test("接管判定：/mcp 归内置时才显示本芯片", () => {
	assert.equal(
		builtinMcpOwnsCommand([{ name: "mcp", sourceInfo: { path: BUILTIN_MCP_SOURCE } }]),
		true,
	);
	assert.equal(
		builtinMcpOwnsCommand([
			{ name: "mcp", sourceInfo: { path: "/tmp/pi-mcp-adapter/dist/index.ts" } },
		]),
		false,
	);
	// 都注册了 /mcp：内置被覆盖，交给对方
	assert.equal(
		builtinMcpOwnsCommand([
			{ name: "mcp", sourceInfo: { path: BUILTIN_MCP_SOURCE } },
			{ name: "mcp", sourceInfo: { path: "/tmp/pi-mcp-adapter/dist/index.ts" } },
		]),
		false,
	);
	assert.equal(builtinMcpOwnsCommand([{ name: "reload" }]), false);
});
