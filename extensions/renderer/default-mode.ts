/**
 * default mode（config.mode === "on"）：Claude Code 风格工具卡渲染。
 *
 * 经 ToolExecutionComponent 原型补丁接管 call/result。
 * 卡片怎么画在 tool/ccstyle-tool.ts，本文件只负责安装与所有权。
 * 生命周期对齐 compact-mode：installDefaultMode → hooks.shutdown。
 */
import { ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { config, type CompactStyleMode } from "../config/config.ts";
import {
	COMPONENT_TOOL_RENDER_MODE,
	GLOBAL_TOOL_RENDER_PATCH,
	patchRegistry,
	TOOL_EXPANDED_BACKGROUND_PATCH,
} from "../utils/patch-keys.ts";
import { isToolCallHovered } from "./mouse/hover.ts";
import { isLiveToolCall } from "./tool/tool-state.ts";
import { getMessageDisplayTheme } from "./tool/message-display.ts";
import { createCcstyleTool } from "./tool/ccstyle-tool.ts";
import type { WriteExecutionMetadataStore } from "./tool/diff/index.ts";
export { shouldRenderRichDiff } from "./tool/ccstyle-tool.ts";

// pi-subagents 等扩展为 Agent 提供专用渲染器，ccstyle 必须保留。
const DEDICATED_RENDERER_TOOLS = new Set(["Agent"]);

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
	wrap: (tool: any, toolName: string) => any;
	byDefinition: WeakMap<object, Map<string, any>>;
	byName: Map<string, any>;
	downstream: ToolRenderMethods;
	installed: ToolRenderMethods;
	originalRender?: (width: number) => string[];
	originalInvalidate?: () => void;
	renderPaint?: (width: number) => string[];
	invalidatePaint?: () => void;
	paintCache?: WeakMap<object, ToolPaintHit>;
	/** 给渲染上下文补 result；卸下时还原。 */
	originalGetRenderContext?: (...args: any[]) => any;
	getRenderContext?: (this: any, ...args: any[]) => any;
};

type ToolExpandedBackgroundPatch = {
	active: boolean;
	prototype: any;
	installed: (...args: any[]) => void;
	original: (...args: any[]) => void;
	dispose: () => void;
};

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
	// compact 也复用同一套 ccstyle call/result，避免折叠态工具卡回落到 Pi 原生样式。
	const useCcstyle =
		patch.mode() !== "off" &&
		!DEDICATED_RENDERER_TOOLS.has(toolName) &&
		!preservesOriginalRenderer(extensionDefinition, toolName, builtInDefinition);
	component[COMPONENT_TOOL_RENDER_MODE] = useCcstyle;
	return useCcstyle;
}

function getGloballyStyledTool(component: any, patch: GlobalToolRenderPatch): any {
	const definition = component.toolDefinition ?? component.builtInToolDefinition;
	const name = String(component.toolName || definition?.name || "tool");
	if (definition && typeof definition === "object") {
		let byName = patch.byDefinition.get(definition);
		if (!byName) {
			byName = new Map();
			patch.byDefinition.set(definition, byName);
		}
		let wrapped = byName.get(name);
		if (!wrapped) {
			wrapped = patch.wrap(definition, name);
			byName.set(name, wrapped);
		}
		return wrapped;
	}

	let wrapped = patch.byName.get(name);
	if (!wrapped) {
		wrapped = patch.wrap({ name, label: name }, name);
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
	const originalGetRenderContext =
		previous?.originalGetRenderContext && prototype.getRenderContext === previous.getRenderContext
			? previous.originalGetRenderContext
			: prototype.getRenderContext;
	if (isOwnershipAwarePatch(previous)) disconnectGlobalToolRenderPatch(previous);

	const patch: GlobalToolRenderPatch = {
		version: 2,
		prototype,
		active: true,
		mode: () => config.mode,
		wrap: (tool: any, toolName: string) =>
			createCcstyleTool(tool, writeExecutionMetadata, toolName),
		byDefinition: new WeakMap(),
		byName: new Map(),
		downstream,
		installed: undefined as any,
		originalRender,
		originalInvalidate,
		originalGetRenderContext,
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
	// 渲染上下文没有 result。ask_user_question 的标题要报问题数，只能从这里补。
	patch.getRenderContext = function (this: any, ...args: any[]) {
		const context = originalGetRenderContext.apply(this, args);
		if (context && typeof context === "object") context.result = this.result;
		return context;
	};
	prototype.getRenderContext = patch.getRenderContext;
	// fullscreen 滚动/选区每帧整树 render；内容未变时复用上一帧行，避免重做 diff/Box。
	patch.renderPaint = function (this: any, width: number): string[] {
		if (!patch.active || patch.mode() === "off") {
			return originalRender.call(this, width);
		}
		const cache = patch.paintCache;
		// A running partial tool owns a time-varying spinner. Light animation ticks
		// request a repaint without invalidating the component, so settled-content
		// caching must not intercept those paints. The waiting window before the
		// tool is dispatched animates too, so it must bypass the cache as well.
		const animatingRow =
			this.isPartial && (this.executionStarted || isLiveToolCall(this.toolCallId));
		const cacheable = !animatingRow;
		const hit = cacheable ? cache?.get(this) : undefined;
		if (hit && toolPaintMatches(hit, this, width)) return hit.lines;
		const lines = originalRender.call(this, width);
		if (cacheable) {
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
		} else {
			cache?.delete(this);
		}
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
	if (
		patch.getRenderContext &&
		prototype.getRenderContext === patch.getRenderContext &&
		patch.originalGetRenderContext
	) {
		prototype.getRenderContext = patch.originalGetRenderContext;
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
				if (box.setBgFn) {
					box.setBgFn((text: string) => theme.bg(config.expandedCardBackground, text));
				}
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
