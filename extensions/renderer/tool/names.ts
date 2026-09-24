import { posix, win32 } from "node:path";
import type { ThemeColor } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { config } from "../../config/config.ts";
import { oneLine } from "../../utils/format.ts";
import { headTruncateToWidth } from "./result.ts";

function clip(value: unknown): string {
	return oneLine(value, config.inputClip);
}

/** 载荷（入参 JSON / 脚本代码）至少留出这么多宽度才显示，否则整段省略（避免只剩一个孤零零的 " {…"）。 */
const MIN_PAYLOAD_WIDTH = 10;

/** 品牌大小写固定写法；humanize 推导不出来的工具名写在这里。 */
const TOOL_LABEL_OVERRIDES: Readonly<Record<string, string>> = {
	powershell: "PowerShell",
	// MCP 入口两个没有具体工具名，跟普通工具一样人性化；缩写固定大写
	mcp: "MCP",
	mcpscript: "MCP Script",
};

/**
 * 工具名/标签人性化：与 default-mode 的 humanizeToolLabel、grouping 的 humanizeToolName
 * 逐字相同，收敛为一个共享实现。
 */
export function humanizeToolLabel(label: string): string {
	const brand = TOOL_LABEL_OVERRIDES[label.toLowerCase()];
	if (brand) return brand;
	return label
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.replace(/[_-]+/g, " ")
		.replace(/\b\w/g, (char) => char.toUpperCase());
}

const AGENT_FAMILY_TOOL_NAMES = new Set([
	"Agent",
	"Agents",
	"get_subagent_result",
	"steer_subagent",
]);

/** default-mode（单工具卡）与 grouping（分组卡）在 agent/bash/grep/find/read/fallback 文案上不同。 */
export type ToolCallSummaryVariant = "default" | "grouping";

export type ToolCallSummaryOptions = {
	/** 已解析标题；缺省为 humanizeToolLabel(toolName)。 */
	title?: string;
	/** 文案变体；缺省 "default"。 */
	variant?: ToolCallSummaryVariant;
	/** 工具执行目录；仅用于生成展示路径，不修改调用参数。 */
	cwd?: string;
};

export type ToolCallSummary = {
	main: string;
	detail: string;
	/** 路径摘要保留结构，供最终渲染按实际宽度优先保留文件名。 */
	path?: { prefix: string; value: string };
	/** 标题之外的原始载荷（完整入参 JSON、脚本代码…），已压成单行，渲染时用 dim 接在标题后。 */
	payload?: string;
};

function pathApi(value: string) {
	if (win32.isAbsolute(value)) return win32;
	if (posix.isAbsolute(value)) return posix;
	return undefined;
}

/** cwd 内绝对路径转相对路径；cwd 外路径保持不变。 */
export function displayPath(value: unknown, cwd?: string): string {
	const text = oneLine(value, 4096);
	const base = cwd ? oneLine(cwd, 4096) : "";
	const api = pathApi(text);
	if (!api || !base || !api.isAbsolute(base)) return text;
	const relative = api.relative(base, text);
	if (!relative) return api.basename(text) || ".";
	if (relative === ".." || relative.startsWith(`..${api.sep}`) || api.isAbsolute(relative)) {
		return text;
	}
	return relative;
}

function headToWidth(text: string, width: number, ellipsis = ""): string {
	if (visibleWidth(text) <= width) return text;
	if (width <= 0) return "";
	const suffix = visibleWidth(ellipsis) <= width ? ellipsis : "";
	const contentWidth = width - visibleWidth(suffix);
	let head = "";
	for (const char of Array.from(text)) {
		if (visibleWidth(head + char) > contentWidth) break;
		head += char;
	}
	return head + suffix;
}

function tailToWidth(text: string, width: number): string {
	if (width <= 0) return "";
	let tail = "";
	for (const char of Array.from(text).reverse()) {
		if (visibleWidth(char + tail) > width) break;
		tail = char + tail;
	}
	return tail;
}

/** 中间截断路径：目录保留开头，末尾优先完整保留文件名。 */
export function truncatePathToWidth(path: string, width: number): string {
	if (visibleWidth(path) <= width) return path;
	if (width <= 1) return width === 1 ? "…" : "";
	const separatorIndex = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
	const filename = separatorIndex >= 0 ? path.slice(separatorIndex + 1) : path;
	const filenameWidth = visibleWidth(filename);
	if (separatorIndex >= 0 && filenameWidth + 1 <= width) {
		const separator = path[separatorIndex]!;
		const suffix = `${separator}${filename}`;
		const prefixWidth = width - visibleWidth(suffix) - 1;
		const prefix = headToWidth(path.slice(0, separatorIndex), Math.max(0, prefixWidth));
		return `${prefix}…${prefix ? suffix : filename}`;
	}
	const leftWidth = Math.max(1, Math.floor((width - 1) * 0.45));
	const rightWidth = Math.max(0, width - leftWidth - 1);
	return `${headToWidth(filename, leftWidth)}…${tailToWidth(filename, rightWidth)}`;
}

/** 路径展示的统一入口：相对化后按配置和当前可用宽度截断。 */
export function formatDisplayPath(value: unknown, cwd: string | undefined, width: number): string {
	return truncatePathToWidth(displayPath(value, cwd), Math.min(width, config.inputClip));
}

/** 按最终终端宽度渲染摘要；路径摘要不会再被整行头部截断。 */
export function fitToolCallSummary(summary: ToolCallSummary, width: number): string {
	if (!summary.path) return headToWidth(summary.main, width, "…");
	const prefix = summary.path.prefix;
	const pathWidth = Math.max(0, width - visibleWidth(prefix) - 1);
	if (pathWidth <= 0) return headToWidth(prefix, width, "…");
	return `${prefix} ${truncatePathToWidth(summary.path.value, Math.min(pathWidth, config.inputClip))}`;
}

function pathSummary(
	prefix: string,
	value: unknown,
	cwd: string | undefined,
	detail = "",
): ToolCallSummary {
	const path = displayPath(value, cwd);
	return {
		main: `${prefix} ${truncatePathToWidth(path, config.inputClip)}`,
		detail,
		path: { prefix, value: path },
	};
}

/** 入参是 shell 命令的工具。 */
const SHELL_TOOL_NAMES = new Set(["bash", "powershell", "pwsh", "sh", "zsh", "cmd"]);

/** 内置检索工具：pattern 缺失（无效调用）时保留 "…" 占位。 */
const SEARCH_TOOL_NAMES = new Set(["grep", "find"]);

/**
 * 通用摘要字段优先级：default 与 grouping 共用同一份取值链。
 * 两处曾各自维护，grouping 因此漏掉 command（powershell）和数组型入参；
 * 路径不在链上，由 pathSummary 兜底，以便按 cwd 相对化并中间截断。
 */
const GENERIC_SUMMARY_FIELDS = [
	"agent_id",
	"command",
	"query",
	"queries",
	"claim",
	"question",
	"questions",
	"url",
	"urls",
	"responseId",
	"findText",
	"name",
	"tool_use_id",
	"toolCallId",
	"id",
	"subject",
	"taskId",
	"task_id",
	"message",
	"description",
	"prompt",
] as const;

/** 通用字段链取值：字符串直接用；数组取首个可展示项并标注剩余条数。 */
type SummaryValue = { text: string; more: number };

function arrayItemText(item: unknown): string | undefined {
	if (typeof item === "string" && item) return item;
	if (!item || typeof item !== "object") return undefined;
	for (const key of ["query", "url", "question", "header", "name"] as const) {
		const text = (item as Record<string, unknown>)[key];
		if (typeof text === "string" && text) return text;
	}
	return undefined;
}

function summaryFieldValue(value: unknown): SummaryValue | undefined {
	if (typeof value === "string" && value) return { text: value, more: 0 };
	if (!Array.isArray(value)) return undefined;
	let first: string | undefined;
	let count = 0;
	for (const item of value) {
		const text = arrayItemText(item);
		if (!text) continue;
		count += 1;
		first ??= text;
	}
	return first === undefined ? undefined : { text: first, more: count - 1 };
}

/** 通用字段链取值；无可用字段时返回 undefined，交给调用方继续降级。 */
function genericSummary(title: string, args: any): ToolCallSummary | undefined {
	for (const key of GENERIC_SUMMARY_FIELDS) {
		const found = summaryFieldValue(args[key]);
		if (!found) continue;
		// (+N) 追加在截断之后，避免首个元素过长时把条数挤没
		const more = found.more > 0 ? ` (+${found.more})` : "";
		return { main: `${title} ${clip(found.text)}${more}`, detail: "" };
	}
	return undefined;
}

/**
 * 单工具调用摘要（{ main, detail }）。
 *
 * 两个变体共用同一份取值链，只有 read/agent/skill/task 等具名分支存在必要差异。
 */
export function toolCallSummary(
	toolName: string,
	args: any,
	opts: ToolCallSummaryOptions = {},
): ToolCallSummary {
	const title = opts.title ?? humanizeToolLabel(toolName);
	const variant = opts.variant ?? "default";
	if (!args || typeof args !== "object") return { main: title, detail: "" };
	const name = toolName.toLowerCase();

	// MCP 入口沿用 mcp-adapter 自己的标题风格（adapter 的 formatMcpProxyToolCallLines）：
	// `MCP <动作> <目标>` / `MCP Script <代码>`，比把整包参数摊成 JSON 好读
	if (name === "mcp") {
		const gateway = mcpGatewaySummary(title, args);
		if (gateway) return gateway;
	}
	if (name === "mcpscript") {
		const code = typeof args.code === "string" && args.code ? clip(args.code) : "";
		return code ? { main: title, detail: "", payload: code } : { main: title, detail: "" };
	}

	const value = (fallback: string, ...keys: string[]) => {
		const found = keys.map((key) => args[key]).find((item) => typeof item === "string" && item);
		return `${title} ${clip(found || fallback)}`;
	};

	if (variant === "default" && AGENT_FAMILY_TOOL_NAMES.has(toolName) && args.agent_id) {
		return { main: `${title} ${clip(args.agent_id)}`, detail: "" };
	}
	if (variant === "grouping" && (name === "agent" || name === "agents")) {
		const displayName = args.subagent_type ?? args.agent_type ?? args.agent;
		if (typeof displayName === "string" && displayName) {
			return { main: `${title} ${displayName}`, detail: "" };
		}
		return {
			main: value(name === "agent" ? "launch agent" : "launch agents", "description", "prompt"),
			detail: "",
		};
	}
	if (variant === "grouping" && (name === "get_subagent_result" || name === "steer_subagent")) {
		return {
			main: value(name === "get_subagent_result" ? "agent result" : "steer agent", "agent_id"),
			detail: "",
		};
	}
	if (variant === "default" && name === "agents") {
		return { main: value("launch agents", "description", "prompt"), detail: "" };
	}
	if (name === "skill") return { main: value("run skill", "name"), detail: "" };
	if (name === "enterplanmode" || name === "enter_plan_mode") {
		return { main: `${title} enable read-only planning`, detail: "" };
	}
	if (name === "exitplanmode" || name === "exit_plan_mode") {
		return { main: `${title} present plan`, detail: "" };
	}
	if (name === "taskcreate") return { main: value("create task", "subject"), detail: "" };
	if (name === "tasklist") return { main: `${title} task list`, detail: "" };
	if (name === "taskget" || name === "taskupdate") {
		return { main: value("task", "taskId", "task_id"), detail: "" };
	}
	if (name === "taskoutput" || name === "taskstop") {
		return { main: value("background task", "task_id", "taskId"), detail: "" };
	}
	if (name === "taskexecute") {
		const ids = Array.isArray(args.task_ids)
			? args.task_ids
			: Array.isArray(args.taskIds)
				? args.taskIds
				: [];
		const summary = ids.length
			? `${ids[0]}${ids.length > 1 ? ` (+${ids.length - 1} tasks)` : ""}`
			: "start tasks";
		return { main: `${title} ${summary}`, detail: "" };
	}
	if (toolName === "read") {
		const details = [
			args.offset !== undefined ? `offset=${args.offset}` : "",
			args.limit !== undefined ? `limit=${args.limit}` : "",
		].filter(Boolean);
		const detail = details.length ? ` (${details.join(", ")})` : "";
		if (typeof args.path === "string" && args.path) {
			return pathSummary(variant === "grouping" ? "Read" : title, args.path, opts.cwd, detail);
		}
		return {
			main: variant === "grouping" ? "Read ..." : title,
			detail,
		};
	}
	if (variant === "grouping" && SHELL_TOOL_NAMES.has(name)) {
		// 分组行缺 command 时保留占位，避免与单工具卡一样只剩标题
		return { main: value("...", "command"), detail: "" };
	}

	// 检索类：pattern 是正文，path 只是范围；两个变体同格式
	if (typeof args.pattern === "string" || SEARCH_TOOL_NAMES.has(name)) {
		const pattern = clip(args.pattern || "...");
		const scope = typeof args.path === "string" && args.path ? ` in ${clip(args.path)}` : "";
		return { main: `${title} ${JSON.stringify(pattern)}${scope}`, detail: "" };
	}

	const generic = genericSummary(title, args);
	if (generic) return generic;

	const preferredPath = args.path ?? args.file_path;
	if (typeof preferredPath === "string" && preferredPath) {
		return pathSummary(title, preferredPath, opts.cwd);
	}

	// 字段链认不出的参数（命名空间代理的 tool+args、第三方工具的自定义键…）展开完整入参 JSON，
	// 而不是只剩一个标题；网关与脚本的专属形状在上面处理
	const payload = jsonArgs(args);
	return payload ? { main: title, detail: "", payload } : { main: title, detail: "" };
}

/**
 * MCP 网关注解 `mcp <动作> <目标>`：动作与目标照搬 mcp-adapter 的 formatMcpProxyToolCallLines，
 * 人眼读起来比参数 JSON 快；`instructions` 是 adapter 自己漏掉的一档（它那里会落到 mcp status）。
 * 认不出的入参返回 undefined，交给通用 JSON 回退，不猜成 status。
 */
function mcpGatewaySummary(title: string, args: any): ToolCallSummary | undefined {
	const text = (value: unknown) => (typeof value === "string" && value ? value : "");
	const tool = text(args.tool);
	const connect = text(args.connect);
	const describe = text(args.describe);
	const instructions = text(args.instructions);
	const search = text(args.search);
	const server = text(args.server);
	const action = text(args.action);
	const scoped = (target: string) => (server ? `${target} @ ${server}` : target);

	if (action === "ui-messages") return { main: `${title} ${action}`, detail: "" };
	if (tool) {
		const main = `${title} call ${scoped(tool)}`;
		const payload = innerArgsPayload(args.args);
		return payload ? { main, detail: "", payload } : { main, detail: "" };
	}
	if (connect) return { main: `${title} connect ${connect}`, detail: "" };
	if (describe) return { main: `${title} describe ${scoped(describe)}`, detail: "" };
	if (instructions) return { main: `${title} instructions ${instructions}`, detail: "" };
	if (search) {
		const flags = [
			args.regex === true ? "regex" : "",
			args.includeSchemas === false ? "schemas hidden" : "",
		].filter(Boolean);
		return {
			main: `${title} search ${scoped(search)}`,
			detail: flags.length ? ` (${flags.join(", ")})` : "",
		};
	}
	if (server) return { main: `${title} list ${server}`, detail: "" };
	if (action) return { main: `${title} ${action}`, detail: "" };
	if (Object.keys(args).length === 0) return { main: `${title} status`, detail: "" };
	return undefined;
}

/** 网关 call 的内层工具入参：对象转单行 JSON；网关允许传 JSON 字符串，就原样取用不再转义。 */
function innerArgsPayload(value: unknown): string {
	if (typeof value === "string") return value ? clip(value) : "";
	if (!value || typeof value !== "object") return "";
	return jsonArgs(value);
}

/** 入参序列化成单行 JSON；空对象或不可序列化时返回 ""。 */
function jsonArgs(args: any): string {
	try {
		const json = JSON.stringify(args);
		return json && json !== "{}" ? clip(json) : "";
	} catch {
		return "";
	}
}

/**
 * 标题行内容：标题用调用方的 toolTitle 色，原始载荷（入参 JSON / 脚本代码）单独用 dim。
 * 标题优先占宽（它是身份），剩下的宽度给载荷；载荷超宽时尾部省略，连
 * MIN_PAYLOAD_WIDTH 都放不下时整段省略。
 */
export function renderToolSummary(
	summary: ToolCallSummary,
	width: number,
	fg: (color: ThemeColor, text: string) => string,
): string {
	const title = fitToolCallSummary(summary, width);
	if (!summary.payload) return fg("toolTitle", title);
	const room = width - visibleWidth(title);
	return room >= MIN_PAYLOAD_WIDTH
		? `${fg("toolTitle", title)}${fg("dim", headTruncateToWidth(` ${summary.payload}`, room))}`
		: fg("toolTitle", title);
}
