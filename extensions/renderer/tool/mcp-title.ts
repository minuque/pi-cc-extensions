import { humanizeToolLabel } from "./names.ts";

/**
 * MCP 工具的识别与标题，单卡（default-mode）与分组行/分组头（grouping）共用。
 *
 * - 判定：工具名带 mcp 片段（`mcp` 网关、`mcpScript`、`mcp__<server>`），或 adapter 注册时
 *   给的 label 以 `MCP:` 开头。默认/none/short 前缀模式下直连工具的名字里没有 mcp 片段
 *   （`github_search_code`、`search_code`），只能靠 label 判定。
 * - 标题：具体工具用 adapter 暴露的真实工具名，不做二次格式化；只有 `mcp` / `mcpScript`
 *   这两个入口没有具体工具名，跟普通工具一样人性化（MCP / MCP Script）。
 * - 参数摘要与其它工具共用 toolCallSummary 的字段链，网关额外把 `args.tool` 提到标题后。
 */

/** 单次 MCP 调用的识别信息。 */
export type McpToolCall = {
	toolName: string;
	/** 工具定义；默认/none/short 前缀模式要靠 label 判定，会话重放时可能缺失。 */
	definition?: any;
};

const GATEWAY_TOOL_NAME = "mcp";
const SCRIPT_TOOL_NAME = "mcpScript";

export function isMcpToolDefinition(definition: any, toolName: string): boolean {
	const label = typeof definition?.label === "string" ? definition.label.trim() : "";
	if (/^MCP(?::|$)/i.test(label)) return true;
	if (toolName === GATEWAY_TOOL_NAME || toolName === SCRIPT_TOOL_NAME) return true;
	return /^mcp[_:-]|[_:-]mcp[_:-]/i.test(toolName);
}

/** 标题：MCP 工具返回标题（入口走人性化，其余用真实工具名）；非 MCP 返回 undefined。 */
export function mcpToolTitle(call: McpToolCall): string | undefined {
	const { toolName } = call;
	if (!isMcpToolDefinition(call.definition, toolName)) return undefined;
	if (toolName === GATEWAY_TOOL_NAME || toolName === SCRIPT_TOOL_NAME) {
		return humanizeToolLabel(toolName);
	}
	return toolName;
}
