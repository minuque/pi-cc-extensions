import { ThinkingPreviewBlock } from "../../feature/compact-thinking.ts";
import { setHoveredCompactAssistant } from "../compact-mode.ts";
import { patchRegistry, TOOL_HOVER_STATE_KEY } from "../../utils/patch-keys.ts";
import {
	isExpandedToolIoView,
	invalidateIoView,
	type ExpandedToolIoView,
	type ToolIoSection,
} from "../tool/tool-io.ts";
import type { ToolGroupComponent } from "../tool/grouping.ts";
import { componentAtLocalRow, type ComponentRowHit } from "./layout.ts";
import { setScrollButtonHovered } from "./scroll.ts";

type SharedToolHoverState = { toolCallId: string | null };

/**
 * hover 状态宿主（Symbol.for + globalThis）：模块 reload 后新旧实例共享，
 * 测试依赖该跨实例语义。
 */
export function sharedToolHoverState(): SharedToolHoverState {
	return patchRegistry.ensure(TOOL_HOVER_STATE_KEY, () => ({ toolCallId: null }));
}

export function setHoveredToolCallId(toolCallId: string | null): void {
	sharedToolHoverState().toolCallId = toolCallId;
}

export function isToolCallHovered(toolCallId: string | null | undefined): boolean {
	return Boolean(toolCallId && sharedToolHoverState().toolCallId === toolCallId);
}

let hoveredToolGroup: ToolGroupComponent | null = null;

export function setHoveredToolGroup(group: ToolGroupComponent | null): boolean {
	if (group === hoveredToolGroup) return false;
	hoveredToolGroup?.setHintHovered(false);
	hoveredToolGroup = group;
	group?.setHintHovered(true);
	return true;
}

let hoveredThinking: ThinkingPreviewBlock | null = null;

export function setHoveredThinking(block: ThinkingPreviewBlock | null): boolean {
	if (block === hoveredThinking) return false;
	hoveredThinking?.setHintHovered(false);
	hoveredThinking = block;
	block?.setHintHovered(true);
	return true;
}

let hoveredMessageDisplay: any = null;

export function setHoveredMessageDisplay(component: any): boolean {
	if (component === hoveredMessageDisplay) return false;
	hoveredMessageDisplay?.setHintHovered?.(false);
	hoveredMessageDisplay = component;
	component?.setHintHovered?.(true);
	return true;
}

let hoveredToolIoView: ExpandedToolIoView | null = null;
let hoveredToolIoSection: ToolIoSection | null = null;

export function setHoveredToolIo(
	view: ExpandedToolIoView | null,
	section: ToolIoSection | null,
): boolean {
	// resultRendererComponent 可能是 Text/第三方 renderer；reload 后也可能残留旧实例。
	const nextView = isExpandedToolIoView(view) ? view : null;
	const nextSection = nextView ? section : null;
	if (nextView === hoveredToolIoView && nextSection === hoveredToolIoSection) return false;
	if (isExpandedToolIoView(hoveredToolIoView)) {
		hoveredToolIoView.setHoveredSection(null);
		invalidateIoView(hoveredToolIoView);
	}
	hoveredToolIoView = nextView;
	hoveredToolIoSection = nextSection;
	if (nextView) {
		nextView.setHoveredSection(nextSection);
		invalidateIoView(nextView);
	}
	return true;
}

/** hover 与点击共用组件定位；同一布局下按容器/宽度/行缓存，避免 motion 重复渲染。 */
let fullscreenHoverCacheLayout: unknown = null;
let fullscreenHoverComponentCache = new WeakMap<object, Map<string, ComponentRowHit | null>>();

export function cachedFullscreenComponentAtRow(
	layout: any,
	container: any,
	row: number,
	width: number,
): ComponentRowHit | null {
	if (!container || typeof container !== "object") return null;
	if (fullscreenHoverCacheLayout !== layout) {
		fullscreenHoverCacheLayout = layout;
		fullscreenHoverComponentCache = new WeakMap();
	}
	let rows = fullscreenHoverComponentCache.get(container);
	if (!rows) {
		rows = new Map();
		fullscreenHoverComponentCache.set(container, rows);
	}
	const key = `${width}:${row}`;
	if (rows.has(key)) return rows.get(key) ?? null;
	const hit = componentAtLocalRow(container, row, width);
	rows.set(key, hit);
	return hit;
}

/** fullscreen 鼠标悬停目标。 */
export type FullscreenHoverTarget =
	| { kind: "button" }
	| { kind: "group"; component: ToolGroupComponent }
	| { kind: "thinking"; component: ThinkingPreviewBlock }
	| { kind: "message"; component: any }
	| { kind: "assistant"; component: any }
	| {
			kind: "tool";
			component: any;
			view: ExpandedToolIoView | null;
			section: ToolIoSection | null;
	  };

/** 悬停状态变化才触发渲染（motion 事件密集，状态不变跳过）。 */
export function applyFullscreenHover(tui: any, target: FullscreenHoverTarget | null): void {
	let changed = false;
	const nextCallId =
		target?.kind === "tool" && !target.component.expanded
			? (target.component.toolCallId ?? null)
			: null;
	if (nextCallId !== sharedToolHoverState().toolCallId) {
		setHoveredToolCallId(nextCallId);
		changed = true;
	}
	const nextGroup = target?.kind === "group" ? target.component : null;
	if (setHoveredToolGroup(nextGroup)) changed = true;
	const nextThinking = target?.kind === "thinking" ? target.component : null;
	if (setHoveredThinking(nextThinking)) changed = true;
	const nextMessage = target?.kind === "message" ? target.component : null;
	if (setHoveredMessageDisplay(nextMessage)) changed = true;
	const nextAssistant = target?.kind === "assistant" ? target.component : null;
	if (setHoveredCompactAssistant(nextAssistant)) changed = true;
	const nextView = target?.kind === "tool" ? target.view : null;
	const nextSection = target?.kind === "tool" ? target.section : null;
	if (setHoveredToolIo(nextView, nextSection)) changed = true;
	const nextButton = target?.kind === "button";
	if (setScrollButtonHovered(nextButton)) changed = true;
	if (changed) tui.requestRender?.();
}
