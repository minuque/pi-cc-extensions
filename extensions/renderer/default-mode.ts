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
import { fitToolCallSummary, humanizeToolLabel, toolCallSummary } from "./tool/names.ts";
import { mcpToolTitle } from "./tool/mcp-title.ts";

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

type ToolPaintHit = {
	width: number;
	expanded: boolean;
	isPartial: boolean;
	result: unknown;
	args: unknown;
	callHover: boolean;
	ioHover: string | null;
	lines: string[];
};

type GlobalToolRenderPatch = {
	version: 2;
	prototype: any;
	active: boolean;
	mode: () => CompactStyleMode;
	wrap: (tool: any) => any;
	byDefinition: WeakMap<object, any>;
	byName: Map<string, any>;
	downstream: ToolRenderMethods;
	installed: ToolRenderMethods;
	originalRender?: (width: number) => string[];
	originalInvalidate?: () => void;
	renderPaint?: (width: number) => string[];
	invalidatePaint?: () => void;
	paintCache?: WeakMap<object, ToolPaintHit>;
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
	const label = originalTool.label || toolName;
	const defaultTitle = label === toolName ? humanizeToolLabel(label) : label;

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
				(!visualState && (context?.isPartial || context?.executionStarted));
			const animating = isPending && Boolean(context?.executionStarted);
			if (animating) scheduleAnimation(context, { light: true });
			const settledRawIcon = isPending ? "" : settledIcon(toolName, visualState);
			const settledIconStyled =
				visualState === "success"
					? `${BRIGHT_GREEN}${settledRawIcon}${ANSI_FG_RESET}`
					: theme.fg(toolIconColor(context), settledRawIcon);
			// 逐帧 spinner：帧在 render() 内取，动画定时器只需 requestRender，
			// 不再每次 tick 走 updateDisplay 把整张卡重建一遍。
			const pendingIconStyled = () => theme.fg(toolIconColor(context), pendingIcon(toolName));
			const summary = toolCallSummary(toolName, args, {
				// MCP titles depend on the call (the MCP server comes from the result), so compute per call
				title:
					mcpToolTitle({ toolName, definition: originalTool, args, result: context?.result }) ??
					defaultTitle,
				variant: "default",
				cwd: context?.cwd,
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
			let cachedIcon: string | undefined;
			const expanded = Boolean(context?.expanded);
			return {
				render(width: number) {
					// 轻量 tick 只会 requestRender，靠这里续期，动画才能自维持。
					if (animating) scheduleAnimation(context, { light: true });
					const icon = isPending ? pendingIconStyled() : settledIconStyled;
					if (cachedLine !== undefined && cachedWidth === width && cachedIcon === icon) {
						return [cachedLine];
					}
					const viewportWidth = toolViewportWidth(width);
					// 展开态贴左（外层 Box 已 pad 1）；折叠 self-shell 保留 1 格前导空格
					const lead = expanded ? "" : " ";
					const callWidth = Math.max(
						0,
						viewportWidth - visibleWidth(icon) - 1 - (expanded ? 0 : 1),
					);
					const mainWidth = Math.max(0, callWidth - visibleWidth(extraText));
					cachedWidth = width;
					cachedIcon = icon;
					// 路径按最终可用宽度中间截断，避免整行二次截断隐藏文件名。
					cachedLine = `${lead}${icon} ${theme.fg("toolTitle", fitToolCallSummary(summary, mainWidth))}${extraStyled}`;
					return [truncateToWidth(cachedLine, viewportWidth, "")];
				},
				invalidate() {
					cachedLine = undefined;
					cachedIcon = undefined;
				},
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

function downstreamForGlobalToolInstall(
	prototype: any,
	previous: GlobalToolRenderPatch | undefined,
): ToolRenderMethods {
	const current = prototypeToolRenderMethods(prototype);
	if (!previous || previous.prototype !== prototype || !isOwnershipAwarePatch(previous)) {
		return current;
	}
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

function disconnectGlobalToolRenderPatch(patch: GlobalToolRenderPatch | undefined): void {
	if (!patch) return;
	patch.active = false;
	patch.byDefinition = new WeakMap();
	patch.byName.clear();
}

function ioHoverOf(tool: any): string | null {
	const view = tool?.resultRendererComponent;
	if (!view || typeof view.getHoveredSection !== "function") return null;
	return view.getHoveredSection();
}

function toolPaintMatches(hit: ToolPaintHit, tool: any, width: number): boolean {
	return (
		hit.width === width &&
		hit.expanded === Boolean(tool.expanded) &&
		hit.isPartial === Boolean(tool.isPartial) &&
		hit.result === tool.result &&
		hit.args === tool.args &&
		hit.callHover === isToolCallHovered(tool.toolCallId) &&
		hit.ioHover === ioHoverOf(tool)
	);
}

function installGlobalToolRendering(
	writeExecutionMetadata: WriteExecutionMetadataStore,
): GlobalToolRenderPatch {
	const prototype = (ToolExecutionComponent as any).prototype;
	const previous = patchRegistry.get<GlobalToolRenderPatch>(GLOBAL_TOOL_RENDER_PATCH);
	const downstream = downstreamForGlobalToolInstall(prototype, previous);
	const originalRender =
		previous?.originalRender && prototype.render === previous.renderPaint
			? previous.originalRender
			: prototype.render;
	const originalInvalidate =
		previous?.originalInvalidate && prototype.invalidate === previous.invalidatePaint
			? previous.originalInvalidate
			: prototype.invalidate;
	if (isOwnershipAwarePatch(previous)) disconnectGlobalToolRenderPatch(previous);

	const patch: GlobalToolRenderPatch = {
		version: 2,
		prototype,
		active: true,
		mode: () => config.mode,
		wrap: (tool: any) => createCcstyleTool(tool, writeExecutionMetadata),
		byDefinition: new WeakMap(),
		byName: new Map(),
		downstream,
		installed: undefined as any,
		originalRender,
		originalInvalidate,
		paintCache: new WeakMap(),
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
				const renderCall = getGloballyStyledTool(this, patch).renderCall;
				const component = this;
				// Pi's call render context has no result; pass it through for result-driven titles
				return (callArgs: any, theme: any, context: any) =>
					renderCall(callArgs, theme, { ...context, result: component.result });
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
	// fullscreen 滚动/选区每帧整树 render；内容未变时复用上一帧行，避免重做 diff/Box。
	patch.renderPaint = function (this: any, width: number): string[] {
		if (!patch.active || patch.mode() === "off") {
			return originalRender.call(this, width);
		}
		const cache = patch.paintCache;
		const hit = cache?.get(this);
		if (hit && toolPaintMatches(hit, this, width)) return hit.lines;
		const lines = originalRender.call(this, width);
		cache?.set(this, {
			width,
			expanded: Boolean(this.expanded),
			isPartial: Boolean(this.isPartial),
			result: this.result,
			args: this.args,
			callHover: isToolCallHovered(this.toolCallId),
			ioHover: ioHoverOf(this),
			lines,
		});
		return lines;
	};
	patch.invalidatePaint = function (this: any): void {
		patch.paintCache?.delete(this);
		originalInvalidate.call(this);
	};
	prototype.render = patch.renderPaint;
	prototype.invalidate = patch.invalidatePaint;
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
	if (patch.renderPaint && prototype.render === patch.renderPaint && patch.originalRender) {
		prototype.render = patch.originalRender;
	}
	if (
		patch.invalidatePaint &&
		prototype.invalidate === patch.invalidatePaint &&
		patch.originalInvalidate
	) {
		prototype.invalidate = patch.originalInvalidate;
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
