import { config } from "../../config/config.ts";

/**
 * Unified MCP tool title entry, shared by standalone cards (default-mode) and groups (grouping).
 *
 * - `mcpScript`: always "MCP Script"
 * - Every other MCP tool (`mcp` gateway, `mcp__<server>`, direct tools): the server reported in
 *   the call result, rendered by mcpServerDisplayName; "MCP" while the call is pending, when the
 *   result names no server, or when the mcpServerTitles flag is off
 */

/** Full context of a single MCP tool call. */
export type McpToolCallContext = {
	toolName: string;
	/** Tool definition (label/description/parameters, ...); may be missing on session replay. */
	definition?: any;
	/** Arguments of this call. */
	args?: unknown;
	/** Tool result once the call has finished; undefined while pending. */
	result?: unknown;
};

const GATEWAY_TOOL_NAME = "mcp";
const SCRIPT_TOOL_NAME = "mcpScript";
const MCP_TITLE = "MCP";
const SCRIPT_TITLE = "MCP Script";

/**
 * Static server id -> display name mapping, keyed by normalizeMcpServerId.
 * Only lists ids that title-casing gets wrong.
 */
export const MCP_SERVER_DISPLAY_NAMES: Readonly<Record<string, string>> = Object.freeze({
	github: "GitHub",
	nixos: "NixOS",
});

export function isMcpToolDefinition(definition: any, toolName: string): boolean {
	const label = typeof definition?.label === "string" ? definition.label.trim() : "";
	if (/^MCP(?::|$)/i.test(label)) return true;
	if (toolName === GATEWAY_TOOL_NAME || toolName === SCRIPT_TOOL_NAME) return true;
	if (/^mcp[_:-]|[_:-]mcp[_:-]/i.test(toolName)) return true;
	if (label) return false;
	const description = typeof definition?.description === "string" ? definition.description : "";
	return /\bModel Context Protocol\b/i.test(description);
}

function titleCaseWords(value: string): string {
	return value
		.split(/[_:\-\s]+/)
		.filter(Boolean)
		.map((word) => word[0]!.toUpperCase() + word.slice(1))
		.join(" ");
}

/** Mapping lookup key: case-insensitive, `-` equals `_` (the adapter normalizes `-` in server names to `_`). */
export function normalizeMcpServerId(id: string): string {
	return id.trim().toLowerCase().replace(/-/g, "_");
}

/** Server id -> display name: static mapping first, otherwise split on separators and title-case. */
export function mcpServerDisplayName(id: string): string {
	const key = normalizeMcpServerId(id);
	if (Object.hasOwn(MCP_SERVER_DISPLAY_NAMES, key)) return MCP_SERVER_DISPLAY_NAMES[key]!;
	return titleCaseWords(id.trim()) || MCP_TITLE;
}

/**
 * Server id extraction for MCP tool calls; undefined means extraction failure.
 * Reads the server pi-mcp-adapter resolved and reported in `result.details.server` (gateway,
 * namespace proxy, and direct tool results alike), so it is only known once the call has finished.
 * Tool names and arguments are ignored: names are ambiguous across toolPrefix modes, and
 * arguments stream in as partial JSON.
 */
export function extractMcpServerId(context: McpToolCallContext): string | undefined {
	const details = (context.result as { details?: unknown } | null | undefined)?.details;
	if (!details || typeof details !== "object") return undefined;
	const server = (details as Record<string, unknown>).server;
	return typeof server === "string" && server.trim() ? server.trim() : undefined;
}

/** Unified entry: returns the MCP tool call title, or undefined for non-MCP tools (caller uses its regular title). */
export function mcpToolTitle(context: McpToolCallContext): string | undefined {
	const { toolName, definition } = context;
	if (!isMcpToolDefinition(definition, toolName)) return undefined;
	if (toolName === SCRIPT_TOOL_NAME) return SCRIPT_TITLE;
	if (!config.mcpServerTitles) return MCP_TITLE;
	const id = extractMcpServerId(context);
	return id ? mcpServerDisplayName(id) : MCP_TITLE;
}
