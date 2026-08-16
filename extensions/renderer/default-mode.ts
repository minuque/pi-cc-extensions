/**
 * default mode（config.mode === "on"）：Claude Code 风格工具卡渲染。
 *
 * 经 ToolExecutionComponent 原型补丁接管 call/result；edit/write 走 rich diff。
 * 生命周期对齐 compact-mode：installDefaultMode → hooks.shutdown。
 */
import { ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { config, getToolDisplayConfig, type CompactStyleMode } from "../config/config.ts";
import {
	COMPONENT_TOOL_RENDER_MODE,
	GLOBAL_TOOL_RENDER_PATCH,
	patchRegistry,
	TOOL_EXPANDED_BACKGROUND_PATCH,
} from "../utils/patch-keys.ts";
import { isToolCallHovered } from "./mouse/hover.ts";
import {
	countLines,
	hasExpandableDetail,
	headTruncateToWidth,
	insetComponent,
	isToolExpanded,
	outputLineCount,
	pendingIcon,
	renderCollapsedToolResultToWidth,
	renderExpandedToolResult,
	resolveToolVisualState,
	scheduleAnimation,
	settledIcon,
	setToolVisualState,
	textFromResult,
	toolIconColor,
	toolViewportWidth,
} from "./tool/result.ts";
import { oneLine } from "../utils/format.ts";
import { showMoreHintText } from "./tool/show-more-hint.ts";
import { countWriteDiffStats } from "./tool/diff/diff-renderer.ts";
import { renderRichToolResult, type WriteExecutionMetadataStore } from "./tool/diff/index.ts";
import { getMessageDisplayTheme } from "./tool/message-display.ts";
import { humanizeToolLabel, toolCallSummary } from "./tool/names.ts";

// 成功勾：亮绿 truecolor（与 message-display 一致）
const BRIGHT_GREEN = "\x1b[38;2;80;220;100m";
const ANSI_FG_RESET = "\x1b[39m";

// pi-subagents 等扩展为 Agent 提供专用渲染器，ccstyle 必须保留。
const DEDICATED_RENDERER_TOOLS = new Set(["Agent"]);

export type DefaultModeHooks = {
	/** 本安装是否仍持有全局工具渲染补丁。 */
	isOwner(): boolean;
	shutdown(): void;
};

type ToolRenderMethods = {
	hasRendererDefinition: (...args: any[]) => boolean;
	getRenderShell: (...args: any[]) => "default" | "self";
	getCallRenderer: (...args: any[]) => any;
	getResultRenderer: (...args: any[]) => any;
};

type GlobalToolRenderPatch = {
	version: 2;
	prototype: any;
	owner: object;
	active: boolean;
	enabled: () => boolean;
	mode: () => CompactStyleMode;
	wrap: (tool: any) => any;
	byDefinition: WeakMap<object, any>;
	byName: Map<string, any>;
	downstream: ToolRenderMethods;
	installed: ToolRenderMethods;
	// 兼容旧扩展读取 Symbol 上的 legacy 字段。
	originalHasRendererDefinition: ToolRenderMethods["hasRendererDefinition"];
	originalGetRenderShell: ToolRenderMethods["getRenderShell"];
	originalGetCallRenderer: ToolRenderMethods["getCallRenderer"];
	originalGetResultRenderer: ToolRenderMethods["getResultRenderer"];
};

type ToolExpandedBackgroundPatch = {
	active: boolean;
	prototype: any;
	installed: (...args: any[]) => void;
	original: (...args: any[]) => void;
	dispose: () => void;
};

export function shouldRenderRichDiff(
	mode: CompactStyleMode,
	toolName: string,
	isError: boolean,
): boolean {
	return mode === "on" && !isError && (toolName === "edit" || toolName === "write");
}

export function isMcpToolDefinition(definition: any, toolName: string): boolean {
	const label = typeof definition?.label === "string" ? definition.label.trim() : "";
	if (/^MCP(?::|$)/i.test(label)) return true;
	if (toolName === "mcp" || /^mcp[_:-]|[_:-]mcp[_:-]/i.test(toolName)) return true;
	if (label) return false;
	const description = typeof definition?.description === "string" ? definition.description : "";
	return /\bModel Context Protocol\b/i.test(description);
}

export function humanizeMcpToolName(toolName: string): string {
	const words = toolName
		.replace(/^mcp(?:[_:-]+)+/i, "")
		.split(/[_:-]+/)
		.filter(Boolean);
	return words.length
		? words.map((word) => word[0]!.toUpperCase() + word.slice(1)).join(" ")
		: "MCP";
}

/** 排除名单内且自带 renderer 的工具保留原渲染。 */
export function preservesOriginalRenderer(
	extensionDefinition: any,
	toolName: string,
	builtInToolDefinition?: any,
	excludeRenderers: readonly string[] = config.excludeRenderers,
): boolean {
	if (!excludeRenderers.includes(toolName)) return false;
	return [extensionDefinition, builtInToolDefinition].some(
		(definition) =>
			definition?.renderShell === "self" ||
			typeof definition?.renderCall === "function" ||
			typeof definition?.renderResult === "function",
	);
}

function renderDefault(tool: any, slot: "renderCall" | "renderResult", args: any[], fallback = "") {
	try {
		if (typeof tool?.[slot] === "function") return tool[slot](...args);
	} catch {
		// Fall through to raw fallback.
	}
	return new Text(fallback, 0, 0);
}

type ParsedTask = { id: string; status: string; subject: string };

function parseTaskList(text: string): ParsedTask[] {
	return text
		.split("\n")
		.map((line) => line.match(/^#(\d+) \[([^\]]+)] (.+)$/))
		.filter((match): match is RegExpMatchArray => Boolean(match))
		.map((match) => ({ id: match[1]!, status: match[2]!, subject: match[3]! }));
}

function taskListSummary(tasks: ParsedTask[]): string {
	const counts = { pending: 0, in_progress: 0, completed: 0 };
	for (const task of tasks) {
		if (task.status in counts) counts[task.status as keyof typeof counts]++;
	}
	return [
		`${tasks.length} tasks`,
		counts.in_progress ? `${counts.in_progress} in progress` : "",
		counts.pending ? `${counts.pending} pending` : "",
		counts.completed ? `${counts.completed} completed` : "",
	]
		.filter(Boolean)
		.join(" • ");
}

function renderExpandedTaskResult(
	toolName: string,
	text: string,
	theme: any,
	isError: boolean,
): any | undefined {
	if (isError) return undefined;
	if (toolName === "TaskList") {
		const tasks = parseTaskList(text);
		if (!tasks.length) return undefined;
		const limit = Math.max(1, config.expandedPreviewMaxLines);
		const rows = tasks.slice(0, limit).map((task) => {
			const color =
				task.status === "completed"
					? "success"
					: task.status === "in_progress"
						? "warning"
						: "muted";
			return `${theme.fg("accent", `#${task.id}`)} ${theme.fg(color, task.status)} ${theme.fg("dim", task.subject)}`;
		});
		if (tasks.length > rows.length)
			rows.push(theme.fg("muted", `… ${tasks.length - rows.length} more tasks`));
		// 贴左：外层展开卡片 Box(1,1) 提供 1 格 padding
		return new Text(
			`↳ ${theme.fg("muted", taskListSummary(tasks))}\n${rows.map((r) => `  ${r}`).join("\n")}`,
			0,
			0,
		);
	}
	const line = text.trim();
	if (!line || line.includes("\n")) return undefined;
	let formatted: string | undefined;
	let match: RegExpMatchArray | null;
	if (
		toolName === "TaskCreate" &&
		(match = line.match(/^Task #(\d+) created successfully: (.+)$/))
	) {
		formatted = `${theme.fg("success", "Created task")} ${theme.fg("accent", `#${match[1]}`)} ${theme.fg("muted", match[2])}`;
	} else if (toolName === "TaskUpdate" && (match = line.match(/^Updated task #(\d+) (.+)$/))) {
		formatted = `${theme.fg("success", "Updated task")} ${theme.fg("accent", `#${match[1]}`)} ${theme.fg("muted", match[2])}`;
	} else if (toolName === "TaskExecute") {
		formatted = `${theme.fg("success", "Started")} ${theme.fg("muted", line)}`;
	} else if (toolName === "TaskStop") {
		formatted = `${theme.fg("success", "Stopped")} ${theme.fg("muted", line)}`;
	}
	return formatted ? new Text(`↳ ${formatted}`, 0, 0) : undefined;
}

/** 用 ccstyle call/result 包装任意工具定义。 */
function createCcstyleTool(
	originalTool: any,
	writeExecutionMetadata: WriteExecutionMetadataStore,
): any {
	const toolName = originalTool.name;
	const label = isMcpToolDefinition(originalTool, toolName)
		? humanizeMcpToolName(toolName)
		: originalTool.label || toolName;

	return {
		...originalTool,
		renderShell: "self",
		renderCall(args: any, theme: any, context: any) {
			if (config.mode !== "on") {
				return renderDefault(originalTool, "renderCall", [args, theme, context], String(toolName));
			}

			const visualState = resolveToolVisualState(context);
			const isPending =
				visualState === "pending" ||
				(!visualState &&
					context?.executionStarted &&
					(context?.isPartial || context?.result === undefined));
			if (isPending) scheduleAnimation(context);
			const rawIcon = isPending ? pendingIcon(toolName) : settledIcon(toolName, visualState);
			const icon =
				visualState === "success"
					? `${BRIGHT_GREEN}${rawIcon}${ANSI_FG_RESET}`
					: theme.fg(toolIconColor(context), rawIcon);
			const summary = toolCallSummary(toolName, args, {
				title: label === toolName ? humanizeToolLabel(label) : label,
				variant: "default",
			});
			let writeStatsText = "";
			let writeStatsStyled = "";
			if (toolName === "write" && visualState === "success") {
				const meta = writeExecutionMetadata.get(context?.toolCallId);
				const stats = countWriteDiffStats(
					typeof args?.content === "string" ? args.content : undefined,
					meta?.previousContent,
					meta?.fileExistedBeforeWrite,
				);
				if (stats) {
					writeStatsText = ` (+${stats.added} -${stats.removed})`;
					writeStatsStyled = ` ${theme.fg("dim", "(")}${theme.fg("success", `+${stats.added}`)} ${theme.fg("error", `-${stats.removed}`)}${theme.fg("dim", ")")}`;
				}
			}
			const extraText = writeStatsText || summary.detail;
			const extraStyled = writeStatsStyled || theme.fg("dim", summary.detail);
			let cachedWidth: number | undefined;
			let cachedLine: string | undefined;
			const expanded = Boolean(context?.expanded);
			return {
				render(width: number) {
					if (cachedLine !== undefined && cachedWidth === width) return [cachedLine];
					const viewportWidth = toolViewportWidth(width);
					// 展开态贴左（外层 Box 已 pad 1）；折叠 self-shell 保留 1 格前导空格
					const lead = expanded ? "" : " ";
					const callWidth = Math.max(
						0,
						viewportWidth - visibleWidth(icon) - 1 - (expanded ? 0 : 1),
					);
					const mainWidth = Math.max(0, callWidth - visibleWidth(extraText));
					cachedWidth = width;
					// 纯文本先截断再着色（省略号不带 ANSI）；从头截断，与多 tool 一致
					cachedLine = `${lead}${icon} ${theme.fg("toolTitle", headTruncateToWidth(summary.main, mainWidth))}${extraStyled}`;
					return [truncateToWidth(cachedLine, viewportWidth, "")];
				},
				invalidate() {},
			};
		},
		renderResult(result: any, options: any, theme: any, context: any) {
			if (config.mode !== "on") {
				return renderDefault(
					originalTool,
					"renderResult",
					[result, options, theme, context],
					textFromResult(result),
				);
			}

			const expanded = isToolExpanded(options, context);
			if (options?.isPartial) {
				// 展开态贴左（Box 提供 1 格 pad）；折叠态保持 3 格对齐标题
				const pending = expanded ? "↳ Pending…" : "   ↳ Pending…";
				return new Text(theme.fg("muted", pending), 0, 0);
			}

			const isError = options?.isError || context?.isError;
			setToolVisualState(context, isError ? "error" : "success");
			const toolCallId = context?.toolCallId;
			if (shouldRenderRichDiff(config.mode, toolName, Boolean(isError))) {
				// getter 保证 Diff indicator / wrap / limits 下次绘制即更新
				const richResult = renderRichToolResult(
					toolName,
					result,
					{
						...options,
						expanded,
						// 全局共享状态避免 /reload 后旧 result renderer 闭包失联
						isHovered: () => isToolCallHovered(toolCallId),
					},
					theme,
					context,
					writeExecutionMetadata,
					getToolDisplayConfig,
				);
				// 展开态由 Box(1,1) 提供内边距；折叠态 inset 一级缩进
				if (richResult) return expanded ? richResult : insetComponent(richResult);
			}

			const text = textFromResult(result, expanded);
			const args = context?.args;
			if (expanded) {
				const taskResult = renderExpandedTaskResult(toolName, text, theme, Boolean(isError));
				if (taskResult) return taskResult;
			}
			const tasks = !isError && toolName === "TaskList" ? parseTaskList(text) : [];
			const outputLines = outputLineCount(result) || countLines(text);
			const lineWord = outputLines === 1 ? "line" : "lines";
			const action = toolName === "read" ? "loaded" : "returned";
			const rendered = tasks.length
				? taskListSummary(tasks)
				: isError
					? text
						? // 72 与原 result.ts 默认一致，保持错误摘要截断宽度。
							oneLine(text, 72)
						: "Failed"
					: outputLines
						? `${outputLines} ${lineWord} ${action}`
						: "Done";
			const expandable = !expanded && (tasks.length > 0 || hasExpandableDetail(text, args));
			const hintText = showMoreHintText();
			const hintPrefix = expandable ? theme.fg("dim", " • ") : "";
			const hint = expandable ? hintPrefix + theme.fg("dim", hintText) : "";
			const hoveredHint = expandable ? hintPrefix + theme.fg("text", hintText) : "";
			if (expanded) {
				return renderExpandedToolResult(
					text || "",
					theme,
					Boolean(isError),
					context?.lastComponent,
					args,
					context,
					true, // mode=on：贴左，由外层 Box(1,1) 提供 1 格 padding
				);
			}
			if (context?.state) context.state.ccstyleIoView = undefined;
			let cachedWidth: number | undefined;
			let cachedLine: string | undefined;
			let cachedHoveredLine: string | undefined;
			return {
				render(width: number) {
					if (cachedLine === undefined || cachedWidth !== width) {
						cachedWidth = width;
						cachedLine = theme.fg(
							isError ? "error" : "muted",
							renderCollapsedToolResultToWidth(rendered, hint, width),
						);
						cachedHoveredLine = theme.fg(
							isError ? "error" : "muted",
							renderCollapsedToolResultToWidth(rendered, hoveredHint, width),
						);
					}
					return [isToolCallHovered(toolCallId) ? cachedHoveredLine! : cachedLine];
				},
				invalidate() {},
			};
		},
	};
}

function syncToolShell(component: any, shell: "default" | "self"): void {
	const target = shell === "self" ? component.selfRenderContainer : component.contentBox;
	if (!target || !Array.isArray(component.children)) return;
	const candidates = new Set(
		[component.contentText, component.contentBox, component.selfRenderContainer].filter(Boolean),
	);
	const indexes = component.children
		.map((child: any, index: number) => (candidates.has(child) ? index : -1))
		.filter((index: number) => index >= 0);
	const targetIndex = indexes[0];
	// 构造期 getRenderShell 先于 Pi 挂载 shell；此处勿挂载，否则构造器会二次添加。
	if (targetIndex === undefined) return;
	component.children[targetIndex] = target;
	for (const index of indexes.sort((left: number, right: number) => right - left)) {
		if (index !== targetIndex) component.children.splice(index, 1);
	}
}

function shouldGloballyStyleTool(component: any, patch: GlobalToolRenderPatch): boolean {
	const extensionDefinition = component.toolDefinition;
	const builtInDefinition = component.builtInToolDefinition;
	const definition = extensionDefinition ?? builtInDefinition;
	const toolName = String(component.toolName || definition?.name || "");
	const useCcstyle =
		patch.mode() === "on" &&
		!DEDICATED_RENDERER_TOOLS.has(toolName) &&
		!preservesOriginalRenderer(extensionDefinition, toolName, builtInDefinition);
	component[COMPONENT_TOOL_RENDER_MODE] = useCcstyle;
	return useCcstyle;
}

function getGloballyStyledTool(component: any, patch: GlobalToolRenderPatch): any {
	const definition = component.toolDefinition ?? component.builtInToolDefinition;
	if (definition && typeof definition === "object") {
		let wrapped = patch.byDefinition.get(definition);
		if (!wrapped) {
			wrapped = patch.wrap(definition);
			patch.byDefinition.set(definition, wrapped);
		}
		return wrapped;
	}

	const name = String(component.toolName || "tool");
	let wrapped = patch.byName.get(name);
	if (!wrapped) {
		wrapped = patch.wrap({ name, label: name });
		patch.byName.set(name, wrapped);
	}
	return wrapped;
}

function prototypeToolRenderMethods(prototype: any): ToolRenderMethods {
	return {
		hasRendererDefinition: prototype.hasRendererDefinition,
		getRenderShell: prototype.getRenderShell,
		getCallRenderer: prototype.getCallRenderer,
		getResultRenderer: prototype.getResultRenderer,
	};
}

function isOwnershipAwarePatch(value: any): value is GlobalToolRenderPatch {
	if (!value || value.version !== 2 || !value.installed || !value.downstream) return false;
	return ["hasRendererDefinition", "getRenderShell", "getCallRenderer", "getResultRenderer"].every(
		(name) =>
			typeof value.installed[name] === "function" && typeof value.downstream[name] === "function",
	);
}

function downstreamForGlobalToolInstall(prototype: any, previous: any): ToolRenderMethods {
	const current = prototypeToolRenderMethods(prototype);
	if (!previous || previous.prototype !== prototype) return current;
	if (isOwnershipAwarePatch(previous)) {
		return {
			hasRendererDefinition:
				current.hasRendererDefinition === previous.installed.hasRendererDefinition
					? previous.downstream.hasRendererDefinition
					: current.hasRendererDefinition,
			getRenderShell:
				current.getRenderShell === previous.installed.getRenderShell
					? previous.downstream.getRenderShell
					: current.getRenderShell,
			getCallRenderer:
				current.getCallRenderer === previous.installed.getCallRenderer
					? previous.downstream.getCallRenderer
					: current.getCallRenderer,
			getResultRenderer:
				current.getResultRenderer === previous.installed.getResultRenderer
					? previous.downstream.getResultRenderer
					: current.getResultRenderer,
		};
	}

	// pre-v2 Symbol：originalX 显式记录真实下游（native 原型方法），无需源码嗅探。
	// 缺失字段回退到当前原型方法（视作 external）。
	const originalOrCurrent = (field: string, method: Function): Function =>
		typeof previous[field] === "function" ? previous[field] : method;
	return {
		hasRendererDefinition: originalOrCurrent(
			"originalHasRendererDefinition",
			current.hasRendererDefinition,
		) as ToolRenderMethods["hasRendererDefinition"],
		getRenderShell: originalOrCurrent(
			"originalGetRenderShell",
			current.getRenderShell,
		) as ToolRenderMethods["getRenderShell"],
		getCallRenderer: originalOrCurrent(
			"originalGetCallRenderer",
			current.getCallRenderer,
		) as ToolRenderMethods["getCallRenderer"],
		getResultRenderer: originalOrCurrent(
			"originalGetResultRenderer",
			current.getResultRenderer,
		) as ToolRenderMethods["getResultRenderer"],
	};
}

function disconnectGlobalToolRenderPatch(patch: any): void {
	if (!patch || typeof patch !== "object") return;
	patch.active = false;
	patch.enabled = () => false;
	patch.mode = () => "off";
	patch.wrap = (tool: any) => tool;
	patch.byDefinition = new WeakMap();
	if (patch.byName && typeof patch.byName.clear === "function") patch.byName.clear();
	else patch.byName = new Map();
}

function installGlobalToolRendering(
	writeExecutionMetadata: WriteExecutionMetadataStore,
): GlobalToolRenderPatch {
	const prototype = (ToolExecutionComponent as any).prototype;
	const previous = patchRegistry.get<GlobalToolRenderPatch>(GLOBAL_TOOL_RENDER_PATCH);
	const downstream = downstreamForGlobalToolInstall(prototype, previous);
	// 外部仍持有的旧 wrapper 先变为无回调 pass-through，再挂新安装。
	disconnectGlobalToolRenderPatch(previous);

	const patch: GlobalToolRenderPatch = {
		version: 2,
		prototype,
		owner: {},
		active: true,
		enabled: () => config.mode === "on",
		mode: () => config.mode,
		wrap: (tool: any) => createCcstyleTool(tool, writeExecutionMetadata),
		byDefinition: new WeakMap(),
		byName: new Map(),
		downstream,
		installed: undefined as any,
		originalHasRendererDefinition: downstream.hasRendererDefinition,
		originalGetRenderShell: downstream.getRenderShell,
		originalGetCallRenderer: downstream.getCallRenderer,
		originalGetResultRenderer: downstream.getResultRenderer,
	};

	patch.installed = {
		hasRendererDefinition: function (this: any, ...args: any[]) {
			if (patch.active && shouldGloballyStyleTool(this, patch)) return true;
			return patch.downstream.hasRendererDefinition.apply(this, args);
		},
		getRenderShell: function (this: any, ...args: any[]) {
			if (!patch.active) return patch.downstream.getRenderShell.apply(this, args);
			const useCcstyle = shouldGloballyStyleTool(this, patch);
			const shell = useCcstyle
				? this.expanded
					? "default"
					: "self"
				: patch.downstream.getRenderShell.apply(this, args);
			syncToolShell(this, shell);
			return shell;
		},
		getCallRenderer: function (this: any, ...args: any[]) {
			if (patch.active && shouldGloballyStyleTool(this, patch)) {
				return getGloballyStyledTool(this, patch).renderCall;
			}
			return patch.downstream.getCallRenderer.apply(this, args);
		},
		getResultRenderer: function (this: any, ...args: any[]) {
			if (patch.active && shouldGloballyStyleTool(this, patch)) {
				return getGloballyStyledTool(this, patch).renderResult;
			}
			return patch.downstream.getResultRenderer.apply(this, args);
		},
	};

	prototype.hasRendererDefinition = patch.installed.hasRendererDefinition;
	prototype.getRenderShell = patch.installed.getRenderShell;
	prototype.getCallRenderer = patch.installed.getCallRenderer;
	prototype.getResultRenderer = patch.installed.getResultRenderer;
	patchRegistry.install(GLOBAL_TOOL_RENDER_PATCH, patch);
	return patch;
}

function deactivateGlobalToolRendering(patch: GlobalToolRenderPatch): void {
	if (!patch.active) return;
	disconnectGlobalToolRenderPatch(patch);
	const prototype = patch.prototype;
	if (prototype.hasRendererDefinition === patch.installed.hasRendererDefinition) {
		prototype.hasRendererDefinition = patch.downstream.hasRendererDefinition;
	}
	if (prototype.getRenderShell === patch.installed.getRenderShell) {
		prototype.getRenderShell = patch.downstream.getRenderShell;
	}
	if (prototype.getCallRenderer === patch.installed.getCallRenderer) {
		prototype.getCallRenderer = patch.downstream.getCallRenderer;
	}
	if (prototype.getResultRenderer === patch.installed.getResultRenderer) {
		prototype.getResultRenderer = patch.downstream.getResultRenderer;
	}
}

/** 展开面板背景统一为 user message 背景色；折叠行保持原生状态色。
 *  必须在 compact-mode 之后安装，shutdown 时先于 compact-mode 释放。 */
export function installToolExpandedBackground(): () => void {
	const previous = patchRegistry.get<ToolExpandedBackgroundPatch>(TOOL_EXPANDED_BACKGROUND_PATCH);
	if (previous) previous.dispose();
	const prototype = ToolExecutionComponent.prototype as unknown as { updateDisplay: () => void };
	const original = prototype.updateDisplay;
	const patch: ToolExpandedBackgroundPatch = {
		active: true,
		prototype,
		installed: function (this: any) {
			original.call(this);
			if (!patch.active || config.mode !== "on" || !this.expanded) return;
			const theme = getMessageDisplayTheme();
			if (!theme?.bg) return;
			const box = this.contentBox;
			// 展开最外层卡片：上下左右内间距 1 格
			if (box) {
				box.paddingX = 1;
				box.paddingY = 1;
				if (box.setBgFn) box.setBgFn((text: string) => theme.bg("userMessageBg", text));
			}
		},
		original,
		dispose: () => {
			patch.active = false;
			if (prototype.updateDisplay === patch.installed) {
				prototype.updateDisplay = original;
			}
			patchRegistry.dispose(TOOL_EXPANDED_BACKGROUND_PATCH, patch);
		},
	};
	prototype.updateDisplay = patch.installed;
	patchRegistry.install(TOOL_EXPANDED_BACKGROUND_PATCH, patch);
	return patch.dispose;
}

/** 安装 default mode 全局工具渲染补丁（不含展开背景，见 installToolExpandedBackground）。 */
export function installDefaultMode(
	writeExecutionMetadata: WriteExecutionMetadataStore,
): DefaultModeHooks {
	const globalToolRendering = installGlobalToolRendering(writeExecutionMetadata);
	return {
		isOwner() {
			return (
				patchRegistry.owns(GLOBAL_TOOL_RENDER_PATCH, globalToolRendering) &&
				globalToolRendering.active
			);
		},
		shutdown() {
			deactivateGlobalToolRendering(globalToolRendering);
		},
	};
}
