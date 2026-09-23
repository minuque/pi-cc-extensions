import { config } from "../../config/config.ts";

/**
 * Unified MCP tool title entry, shared by standalone cards (default-mode) and groups (grouping).
 *
 * - `mcp__<server>`: `<server>` is the server id, rendered by mcpServerDisplayName
 * - `mcpScript`: always "MCP Script"
 * - `mcp` (pi-mcp-adapter gateway): rule-based server id extraction when the flag is on;
 *   "MCP" when the flag is off or extraction fails
 * - Other MCP tools (direct tools, label/description detection): humanizeMcpToolName
 */

/** Full context of a single MCP tool call. */
export type McpToolCallContext = {
	toolName: string;
	/** Tool definition (label/description/parameters, ...); may be missing on session replay. */
	definition?: any;
	/** Arguments of this call. */
	args?: unknown;
};

const GATEWAY_TOOL_NAME = "mcp";
const SCRIPT_TOOL_NAME = "mcpScript";
const GATEWAY_TITLE = "MCP";
const SCRIPT_TITLE = "MCP Script";

/**
 * Static server id -> display name mapping, keyed by normalizeMcpServerId.
 * Only lists ids that title-casing gets wrong.
 */
export const MCP_SERVER_DISPLAY_NAMES: Readonly<Record<string, string>> = Object.freeze({
	github: "GitHub",
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

/** Fallback title for MCP tools outside the gateway/script/namespace forms (e.g. direct tool `github_search_code`). */
export function humanizeMcpToolName(toolName: string): string {
	return titleCaseWords(toolName.replace(/^mcp(?:[_:-]+)+/i, "")) || GATEWAY_TITLE;
}

/** Mapping lookup key: case-insensitive, `-` equals `_` (the adapter normalizes `-` in server names to `_`). */
export function normalizeMcpServerId(id: string): string {
	return id.trim().toLowerCase().replace(/-/g, "_");
}

/** Server id -> display name: static mapping first, otherwise split on separators and title-case. */
export function mcpServerDisplayName(id: string): string {
	const key = normalizeMcpServerId(id);
	if (Object.hasOwn(MCP_SERVER_DISPLAY_NAMES, key)) return MCP_SERVER_DISPLAY_NAMES[key]!;
	return titleCaseWords(id.trim()) || GATEWAY_TITLE;
}

/**
 * Rule-based server id extraction for gateway (`mcp`) calls.
 * Placeholder: rules are TBD, always returns undefined (extraction failure).
 */
export function extractMcpGatewayServerId(_context: McpToolCallContext): string | undefined {
	return undefined;
}

/** Unified entry: returns the MCP tool call title, or undefined for non-MCP tools (caller uses its regular title). */
export function mcpToolTitle(
	context: McpToolCallContext,
	/** Test seam; defaults to extractMcpGatewayServerId. */
	extractGatewayServerId: (
		context: McpToolCallContext,
	) => string | undefined = extractMcpGatewayServerId,
): string | undefined {
	const { toolName, definition } = context;
	if (!isMcpToolDefinition(definition, toolName)) return undefined;
	if (toolName === SCRIPT_TOOL_NAME) return SCRIPT_TITLE;
	if (toolName === GATEWAY_TOOL_NAME) {
		if (!config.mcpGatewayServerIdExtraction) return GATEWAY_TITLE;
		const id = extractGatewayServerId(context)?.trim();
		return id ? mcpServerDisplayName(id) : GATEWAY_TITLE;
	}
	const namespaced = toolName.match(/^mcp__(.+)$/);
	if (namespaced) return mcpServerDisplayName(namespaced[1]!);
	return humanizeMcpToolName(toolName);
}
