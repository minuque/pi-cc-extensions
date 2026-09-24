import { hasActiveTextPreview, showTextPreview } from "../../feature/context.ts";
import { ThinkingPreviewBlock } from "../../feature/compact-thinking.ts";
import { patchRegistry, TOOL_MOUSE_OWNER_KEY } from "../../utils/patch-keys.ts";
import { ToolGroupComponent } from "../tool/grouping.ts";
import { isCompactAssistantComponent, setHoveredCompactAssistant } from "../compact-mode.ts";
import { isMessageDisplayComponent } from "../tool/message-display.ts";
import { config } from "../../config/config.ts";
import { isLazyProxyTui } from "../../utils/fullscreen-detect.ts";
import { installCursorWriteDedupe } from "../cursor-dedupe.ts";
import { markHeaderVisibility } from "../tool/header-visibility.ts";
import { setToolTuiFullscreen } from "../tool/show-more-hint.ts";
import {
	type ExpandedToolIoView,
	getActiveIoViewFrame,
	isExpandedToolIoView,
	type IoViewFrameState,
	setActiveIoViewFrame,
	type ToolIoSection,
} from "../tool/result.ts";
import {
	collectToolComponents,
	extractToolFramePlacements,
	isSgrIdleMotion,
	isSgrLeftPress,
	isSgrLeftRelease,
	isToolExecutionComponent,
	parseSgrMousePackets,
	stripTerminalSequences,
	stripTerminalSequencesPreservingLayout,
	toolFrameMarker,
	type FrameToolPlacement,
	type SgrMousePacket,
} from "./packets.ts";
import {
	collectFullscreenToolCards,
	componentAtLocalRow,
	collapsedHintHitbox,
	fullscreenContentWidth,
	fullscreenLeafAt,
	isScrollbarColumnAt,
} from "./layout.ts";
import {
	fullscreenLazyTui,
	hideScrollButton,
	restoreOfficialScrollToEnd,
	syncOfficialScrollToEnd,
	isScrollBottomInput,
	renderScrollButton,
	resetScrollButtonState,
	scheduleScrollButtonSync,
	setScrollButtonHovered,
	setScrollButtonVisible,
	setScrollButtonWidget,
	setToolMouseTui,
	getScrollButtonVisible,
	getScrollButtonWidget,
	getToolMouseTui,
	toolMouseInteractionActive,
	updateScrollButtonFromInput,
} from "./scroll.ts";
import {
	applyFullscreenHover,
	cachedFullscreenComponentAtRow,
	sharedToolHoverState,
	setHoveredToolCallId,
	setHoveredToolGroup,
	setHoveredThinking,
	setHoveredMessageDisplay,
	setHoveredToolIo,
	type FullscreenHoverTarget,
} from "./hover.ts";

type FrameToolRender = {
	component: any;
	lines: string[];
	contentBoxLines: number;
};

type InteractionRegion = {
	kind: "collapsed-hint" | "expanded-card" | "show-more" | "scroll-bottom";
	row: number;
	startCol: number;
	endCol: number;
	component?: any;
	view?: ExpandedToolIoView;
	section?: ToolIoSection;
};

type InteractionFrame = { regions: InteractionRegion[] };

const TOOL_MOUSE_WIDGET_KEY = "ccstyle-tool-mouse";
const TOOL_MOUSE_MOTION_ENABLE = "\x1b[?1003h\x1b[?1006h";
const TOOL_MOUSE_MOTION_DISABLE = "\x1b[?1003l";
const FULLSCREEN_MOTION_ENABLED = Symbol("ccstyle.fullscreen-motion-enabled");
const DEFAULT_TOOL_MOUSE_OWNER = {};
export const TOOL_MOUSE_DISABLE = "\x1b[?1006l\x1b[?1003l\x1b[?1000l";

let toolMouseUi: any = null;
let toolMouseInputUnsubscribe: (() => void) | null = null;
let toolMouseRenderPatchTui: any = null;
let toolMouseRenderPatchOriginal: ((...args: any[]) => any) | null = null;
let toolMouseRenderPatchWrapper: ((...args: any[]) => any) | null = null;
let toolMouseRenderPatchState: { active: boolean } | null = null;
let toolMouseRawWrite: ((data: string) => unknown) | null = null;
let toolMouseInstallationOwner: object | null = null;
let fullscreenMotionTerminal: any = null;
let ownsFullscreenMotion = false;
let sessionRenderTimer: ReturnType<typeof setTimeout> | null = null;
let latestInteractionFrame: InteractionFrame = { regions: [] };

/** Summary markers used by Pi and ccstyle; unlike the trailing hint, these survive truncation. */
const COLLAPSED_TOOL_SUMMARY = /^\s*(?:↳|└|⎿|●|✓|✗|…)/;

function interactionRegionAt(packet: SgrMousePacket): InteractionRegion | null {
	const matches = latestInteractionFrame.regions.filter(
		(region) =>
			region.row === packet.row && packet.col >= region.startCol && packet.col <= region.endCol,
	);
	return (
		matches.find((region) => region.kind === "show-more") ??
		matches.find((region) => region.kind === "scroll-bottom") ??
		matches.find((region) => region.kind === "collapsed-hint") ??
		matches.find((region) => region.kind === "expanded-card") ??
		null
	);
}

function tryOpenToolIoShowMore(region: InteractionRegion): boolean {
	const ioView = region.view;
	const section = region.section;
	if (!ioView || !section) return false;
	const ui = toolMouseUi;
	if (!ui || typeof ui.custom !== "function") {
		ui?.notify?.("Full preview requires TUI custom UI", "warning");
		return true;
	}
	const title = section === "input" ? "Tool Input" : "Tool Output";
	const content = section === "input" ? ioView.getInputBody() : ioView.getOutputBody();
	void showTextPreview({ ui }, title, content || "(empty)");
	return true;
}

function updateToolSummaryHover(tui: any, packet: SgrMousePacket): void {
	if (!isSgrIdleMotion(packet)) return;
	const region = interactionRegionAt(packet);
	const nextScrollButtonHovered = region?.kind === "scroll-bottom";
	const scrollButtonChanged = setScrollButtonHovered(nextScrollButtonHovered);
	const component = region?.component;
	const nextToolCallId = region?.kind === "collapsed-hint" ? (component?.toolCallId ?? null) : null;
	const nextGroup = component instanceof ToolGroupComponent ? component : null;
	const nextIoView = region?.kind === "show-more" ? (region.view ?? null) : null;
	const nextIoSection = region?.kind === "show-more" ? (region.section ?? null) : null;
	const changed = nextToolCallId !== sharedToolHoverState().toolCallId;
	setHoveredToolCallId(nextToolCallId);
	if (
		scrollButtonChanged ||
		setHoveredToolIo(nextIoView, nextIoSection) ||
		setHoveredToolGroup(nextGroup) ||
		changed
	)
		tui.requestRender?.();
}

const EXPAND_PANEL_DOUBLE_CLICK_MS = 400;
/** 松开后短时间内的重复按下视为同一次单击（终端会在 mouseup 后再打一次 press）。 */
const EXPAND_PANEL_CLICK_ARM_MS = 50;
let pendingExpandPress: { id: unknown } | null = null;
let lastExpandClick: { id: unknown; at: number } | null = null;
let armExpandClickTimer: ReturnType<typeof setTimeout> | null = null;

function expandPanelIdentity(card: any): unknown {
	return card instanceof ThinkingPreviewBlock
		? `${card.messageTimestamp}:${card.runStartIndex}`
		: card;
}

function isExpandPanelDoubleClick(card: any): boolean {
	const now = Date.now();
	const id = expandPanelIdentity(card);
	const prev = lastExpandClick;
	pendingExpandPress = { id };
	if (prev && prev.id === id && now - prev.at <= EXPAND_PANEL_DOUBLE_CLICK_MS) {
		pendingExpandPress = null;
		lastExpandClick = null;
		return true;
	}
	return false;
}

function completeExpandPanelClick(): void {
	if (!pendingExpandPress) return;
	const click = { id: pendingExpandPress.id, at: Date.now() };
	pendingExpandPress = null;
	if (armExpandClickTimer) clearTimeout(armExpandClickTimer);
	armExpandClickTimer = setTimeout(() => {
		armExpandClickTimer = null;
		// 50ms 内又按下：仍是同一次单击，不能武装成双击。
		if (pendingExpandPress) return;
		lastExpandClick = click;
	}, EXPAND_PANEL_CLICK_ARM_MS);
	if (
		typeof armExpandClickTimer === "object" &&
		armExpandClickTimer &&
		"unref" in armExpandClickTimer
	) {
		armExpandClickTimer.unref();
	}
}

function clearExpandPanelDoubleClick(): void {
	pendingExpandPress = null;
	lastExpandClick = null;
	if (armExpandClickTimer) {
		clearTimeout(armExpandClickTimer);
		armExpandClickTimer = null;
	}
}

function collapseExpandedCard(tui: any, card: any): boolean {
	// 单击也 consume，避免官方链再合成一次 press 把单击当成双击。
	if (!isExpandPanelDoubleClick(card)) return true;
	card.setExpanded(false);
	setHoveredToolCallId(null);
	setHoveredToolGroup(null);
	setHoveredThinking(null);
	setHoveredMessageDisplay(null);
	setHoveredToolIo(null, null);
	setHoveredCompactAssistant(null);
	card.invalidate?.();
	tui.requestRender?.();
	clearExpandPanelDoubleClick();
	return true;
}

function toggleToolAtMouseClick(tui: any, packet: SgrMousePacket): boolean {
	const region = interactionRegionAt(packet);
	if (!region) return false;
	if (region.kind === "scroll-bottom") return false;
	if (region.kind === "show-more") return tryOpenToolIoShowMore(region);
	const component = region.component;
	if (!component) return false;
	if (region.kind === "expanded-card") return collapseExpandedCard(tui, component);
	component.setExpanded(true);
	clearExpandPanelDoubleClick();
	setHoveredToolCallId(null);
	setHoveredToolGroup(null);
	setHoveredToolIo(null, null);
	component.invalidate?.();
	tui.requestRender?.();
	return true;
}

function officialFullscreenHasAllMotion(): boolean {
	const term = process.env.TERM?.toLowerCase() ?? "";
	return !(
		process.env.TMUX !== undefined ||
		process.env.ZELLIJ !== undefined ||
		process.env.STY !== undefined ||
		term.startsWith("tmux") ||
		term.startsWith("screen")
	);
}

/**
 * hover 依赖 DECSET 1003。官方 fullscreen 在 multiplexer 下只开 1002，
 * 因此扩展需在每个实际 renderer 上补开（Symbol 经惰性 Proxy 落到当前实例）。
 */
function ensureFullscreenToolMouseMotion(tui: any): void {
	setToolTuiFullscreen(fullscreenLazyTui(tui));
	if (!fullscreenLazyTui(tui)) {
		releaseFullscreenToolMouseMotion(tui);
		return;
	}
	// 面板改 scrollStepLines 后，下一帧渲染即同步（restore 仍按 original 恢复）。
	if (typeof tui.wheelScrollLines === "number" && tui.wheelScrollLines !== config.scrollStepLines) {
		tui.wheelScrollLines = config.scrollStepLines;
	}
	if (
		!toolMouseInteractionActive() ||
		tui.mouseEnabled === false ||
		tui.altScreenActive === false ||
		tui[FULLSCREEN_MOTION_ENABLED]
	) {
		return;
	}
	try {
		tui.terminal?.write?.(TOOL_MOUSE_MOTION_ENABLE);
		tui[FULLSCREEN_MOTION_ENABLED] = true;
		fullscreenMotionTerminal = tui.terminal;
		ownsFullscreenMotion = !officialFullscreenHasAllMotion();
	} catch {
		// renderer 可能正在切换或终端已经关闭。
	}
}

function releaseFullscreenToolMouseMotion(tui?: any): void {
	try {
		if (tui?.[FULLSCREEN_MOTION_ENABLED]) tui[FULLSCREEN_MOTION_ENABLED] = false;
	} catch {
		// 惰性 Proxy 可能已经切到另一个 renderer。
	}
	const terminal = fullscreenMotionTerminal;
	const shouldDisable = ownsFullscreenMotion;
	fullscreenMotionTerminal = null;
	ownsFullscreenMotion = false;
	try {
		if (shouldDisable) terminal?.write?.(TOOL_MOUSE_MOTION_DISABLE);
	} catch {
		// renderer 可能正在切换或终端已经关闭。
	}
}

const FULLSCREEN_VIEWPORT_PATCH = Symbol("ccstyle.fullscreen-viewport-patch");
const FULLSCREEN_WHEEL_SCROLL_ORIGINAL = Symbol("ccstyle.fullscreen-wheel-scroll-original");

/**
 * 官方 fullscreen 工具卡点击：collapsed hint 单击展开
 * （有且仅保持一个展开：展开前收起其他工具卡），expanded 整卡双击收起，
 * 截断头 show-more 单击打开全量预览；回到底部按钮 scrollToBottom。
 * 滚动条列、含 OSC8 链接行、非工具区域、展开卡单击放行官方。
 */
function handleFullscreenToolClick(tui: any, packet: SgrMousePacket): boolean {
	const layout = tui.currentLayout;
	if (!layout?.root) return false;
	// 官方事件坐标 0-based；SGR packet 1-based。
	const x = packet.col - 1;
	const y = packet.row - 1;
	if (isScrollbarColumnAt(layout, x)) return false;
	const hit = fullscreenLeafAt(layout, x, y);
	if (!hit) return false;
	const width = Math.max(1, Number(tui.terminal?.columns) || 80);
	// 布局树用 scroll 的 contentWidth 渲染内容（滚动条占用时 = width-1）；
	// 行号定位必须用同一宽度，否则换行差异导致组件行错位。
	const contentWidth = fullscreenContentWidth(hit.box, width);
	const target = componentAtLocalRow(hit.box.component, hit.localRow, contentWidth);
	if (!target) return false;
	const component = target.component;
	const card = target.group ?? component;
	// 回到底部按钮：按组件引用命中，不依赖渲染行缓存。
	if (getScrollButtonVisible() && component === getScrollButtonWidget()) {
		tui.scrollToBottom?.();
		hideScrollButton(tui);
		return true;
	}
	const line = hit.box.lines?.[hit.localRow];
	if (typeof line !== "string" || /\x1b]8;[^;]*;/.test(line)) return false;
	const isTool = isToolExecutionComponent(component);
	const isGroup = component instanceof ToolGroupComponent;
	const isAssistant = isCompactAssistantComponent(component);
	const isThinking = component instanceof ThinkingPreviewBlock;
	const isMessage = isMessageDisplayComponent(component);
	if (!isTool && !isGroup && !isAssistant && !isThinking && !isMessage) return false;
	if (!component.expanded) {
		// collapsed 仅按钮文本可展开，不能把同一行正文/留白变成点击区。
		const hint = collapsedHintHitbox(line);
		if (!hint || packet.col < hint.startCol || packet.col > hint.endCol) return false;
		// single-expand：展开前收起其他已展开工具卡/group。
		const others: any[] = [];
		collectFullscreenToolCards(hit.box.component, others);
		for (const other of others) {
			if (other !== component && other.expanded) {
				// 展开 round 内 thinking 时不要把外层 compact 卡收起。
				if (isThinking && isCompactAssistantComponent(other)) continue;
				other.setExpanded(false);
				other.invalidate?.();
			}
		}
		component.setExpanded(true);
		clearExpandPanelDoubleClick();
	} else {
		// 普通工具截断头 show-more：打开全量预览（不收起）。
		const view = isTool ? component.resultRendererComponent : null;
		if (isExpandedToolIoView(view)) {
			const plain = stripTerminalSequencesPreservingLayout(line);
			const section = view.matchShowMoreLine(plain);
			if (section) {
				clearExpandPanelDoubleClick();
				const box = view.showMoreHitbox(plain);
				return tryOpenToolIoShowMore({
					kind: "show-more",
					row: 0,
					startCol: box?.startCol ?? 1,
					endCol: box?.endCol ?? 1,
					component,
					view,
					section,
				});
			}
		}
		// 双击收起：内部工具仍归所属 group。单击放行官方（选择/链接）。
		return collapseExpandedCard(tui, card);
	}
	// 点击后清 hover 高亮。
	setHoveredToolCallId(null);
	setHoveredToolGroup(null);
	setHoveredThinking(null);
	setHoveredMessageDisplay(null);
	setHoveredToolIo(null, null);
	setHoveredCompactAssistant(null);
	card.invalidate?.();
	tui.requestRender?.();
	return true;
}

/**
 * fullscreen 鼠标悬停：collapsed 卡 [click to show more] hint、
 * expanded 卡截断头 show-more、回到底部按钮。motion 不 consume，官方链照常。
 */
function handleFullscreenToolHover(tui: any, packet: SgrMousePacket): void {
	if (!isSgrIdleMotion(packet)) return;
	const layout = tui.currentLayout;
	if (!layout?.root) return;
	const x = packet.col - 1;
	const y = packet.row - 1;
	let target: FullscreenHoverTarget | null = null;
	const hit = fullscreenLeafAt(layout, x, y);
	if (hit) {
		const line = hit.box.lines?.[hit.localRow];
		// 回到底部按钮：渲染行文本 + 列区间识别（零组件树开销）。
		if (typeof line === "string" && getScrollButtonVisible() && line.includes("[ ↓")) {
			const plain = stripTerminalSequencesPreservingLayout(line);
			const idx = plain.indexOf("[ ↓");
			if (idx >= 0 && x >= idx && x <= idx + plain.length - 1) {
				target = { kind: "button" };
			}
		} else if (typeof line === "string" && !/\x1b]8;/.test(line)) {
			const width = Math.max(1, Number(tui.terminal?.columns) || 80);
			const contentWidth = fullscreenContentWidth(hit.box, width);
			// 与点击共用同一定位算法，避免 hover 自建行段与真实组件树错位。
			const componentHit = cachedFullscreenComponentAtRow(
				layout,
				hit.box.component,
				hit.localRow,
				contentWidth,
			);
			const component = componentHit?.component;
			const hintBox = collapsedHintHitbox(line);
			const overHint = Boolean(
				hintBox && packet.col >= hintBox.startCol && packet.col <= hintBox.endCol,
			);
			if (component instanceof ToolGroupComponent) {
				if (overHint) target = { kind: "group", component };
			} else if (component instanceof ThinkingPreviewBlock) {
				if (component.expanded || overHint) target = { kind: "thinking", component };
			} else if (isToolExecutionComponent(component)) {
				let view: ExpandedToolIoView | null = null;
				let section: ToolIoSection | null = null;
				if (component.expanded) {
					const resultView = component.resultRendererComponent;
					if (isExpandedToolIoView(resultView)) {
						view = resultView;
						const plain = stripTerminalSequencesPreservingLayout(line);
						const candidate = view.matchShowMoreLine(plain);
						if (candidate) {
							const box = view.showMoreHitbox(plain);
							if (box && x + 1 >= box.startCol && x + 1 <= box.endCol) {
								section = candidate;
							}
						}
					}
					target = { kind: "tool", component, view, section };
				} else if (overHint) {
					target = { kind: "tool", component, view, section };
				}
			} else if (isCompactAssistantComponent(component)) {
				// compact 摘要行：折叠时仅提示文字高亮，展开卡整体高亮。
				if (component.expanded || overHint) target = { kind: "assistant", component };
			} else if (isMessageDisplayComponent(component)) {
				if (overHint) target = { kind: "message", component };
			}
		}
	}
	applyFullscreenHover(tui, target);
}

/**
 * 实例级包装 TuiAltScreen.handleViewportInput（惰性 Proxy 安全）：
 * 原型方法取 original（绕开 proxy 函数包装），实例 own property 装 wrapper
 * （constructor arrow 动态查找命中）。仅在 fullscreen 且无 overlay 时先消费
 * 工具卡左键点击，其余全部放行官方 selection/scrollbar/URL/键盘链。
 */
function patchFullscreenViewportInput(tui: any): void {
	if (tui[FULLSCREEN_VIEWPORT_PATCH] || !isLazyProxyTui(tui)) return;
	const proto = Object.getPrototypeOf(tui);
	const original = proto?.handleViewportInput;
	if (typeof original !== "function") return;
	// 官方原生 routeWheel 已完整处理嵌套 ScrollView；只调整默认步进（config.scrollStepLines）。
	if (typeof tui.wheelScrollLines === "number") {
		tui[FULLSCREEN_WHEEL_SCROLL_ORIGINAL] = tui.wheelScrollLines;
		tui.wheelScrollLines = config.scrollStepLines;
	}
	tui[FULLSCREEN_VIEWPORT_PATCH] = true;
	tui.handleViewportInput = function (this: any, data: string) {
		if (toolMouseInteractionActive() && tui.mode === "fullscreen") {
			// 滚动输入（wheel/pageUp/end 等）后同步回到底部按钮显隐；
			// 官方 viewport 会消费键盘，扩展监听器无法补偿，必须在这里调度。
			scheduleScrollButtonSync(tui, data);
			const packets = parseSgrMousePackets(data);
			// 官方 fullscreen 会消费全部鼠标；文本预览 overlay 活动时放行给 focused
			// custom component，使 [esc] 点击和滚轮可用。
			if (packets && tui.hasOverlay?.() && hasActiveTextPreview()) return undefined;
			if (packets && !tui.hasOverlay?.()) {
				for (const packet of packets) {
					if (isSgrLeftRelease(packet)) completeExpandPanelClick();
					if (isSgrLeftPress(packet) && handleFullscreenToolClick(tui, packet)) {
						return { consume: true };
					}
					// 仅无按键移动走 hover；左键拖动（文本多选）放行官方选区，避免每像素命中+重绘。
					if (isSgrIdleMotion(packet)) {
						handleFullscreenToolHover(tui, packet);
					}
				}
			}
		}
		return Reflect.apply(original, this, [data]);
	};
}

function restoreFullscreenViewportInput(tui: any): void {
	if (!tui || !tui[FULLSCREEN_VIEWPORT_PATCH]) return;
	const proto = Object.getPrototypeOf(tui);
	if (typeof proto?.handleViewportInput === "function") {
		tui.handleViewportInput = proto.handleViewportInput;
	}
	const originalWheelScrollLines = tui[FULLSCREEN_WHEEL_SCROLL_ORIGINAL];
	if (typeof originalWheelScrollLines === "number") {
		tui.wheelScrollLines = originalWheelScrollLines;
		tui[FULLSCREEN_WHEEL_SCROLL_ORIGINAL] = undefined;
	}
	tui[FULLSCREEN_VIEWPORT_PATCH] = false;
}

function restoreToolMouseRenderPatch(): void {
	if (toolMouseRenderPatchState) toolMouseRenderPatchState.active = false;
	if (
		toolMouseRenderPatchTui &&
		toolMouseRenderPatchOriginal &&
		toolMouseRenderPatchTui.doRender === toolMouseRenderPatchWrapper
	) {
		toolMouseRenderPatchTui.doRender = toolMouseRenderPatchOriginal;
	}
	toolMouseRenderPatchTui = null;
	toolMouseRenderPatchOriginal = null;
	toolMouseRenderPatchWrapper = null;
	toolMouseRenderPatchState = null;
	toolMouseRawWrite = null;
	latestInteractionFrame = { regions: [] };
}

function buildInteractionFrame(
	tui: any,
	renderedTools: FrameToolRender[],
	placements: FrameToolPlacement[],
): InteractionFrame {
	const width = Math.max(1, Number(tui?.terminal?.columns) || 80);
	// native: full buffer; map with the post-doRender previousViewportTop.
	const lineIndexToScreenRow = (lineIndex: number) =>
		lineIndex - (Number(tui?.previousViewportTop) || 0) + 1;
	const visibleRows = Math.max(1, Number(tui?.terminal?.rows) || Number.POSITIVE_INFINITY);
	const regions: InteractionRegion[] = [];
	const renderedByComponent = new Map<any, FrameToolRender>();
	for (const rendered of renderedTools) renderedByComponent.set(rendered.component, rendered);
	const placementsByComponent = new Map<any, FrameToolPlacement[]>();
	for (const placement of placements) {
		const list = placementsByComponent.get(placement.component) ?? [];
		list.push(placement);
		placementsByComponent.set(placement.component, list);
	}
	// 记录每张工具卡首行是否落在可视区内。动画层据此停掉看不见的 spinner：
	// 可视区上方的一行变化会让 pi-tui 整屏重画并清 scrollback。
	const viewportTopLine = Number(tui?.previousViewportTop) || 0;
	const viewportBottomLine = viewportTopLine + visibleRows - 1;
	for (const [component, componentPlacements] of placementsByComponent) {
		const headerLine = Math.min(...componentPlacements.map((item) => item.lineIndex));
		markHeaderVisibility(
			component,
			headerLine >= viewportTopLine && headerLine <= viewportBottomLine,
		);
	}
	for (const [component, componentPlacements] of placementsByComponent) {
		const rendered = renderedByComponent.get(component);
		if (!rendered) continue;
		for (const placement of componentPlacements) {
			const finalRow = lineIndexToScreenRow(placement.lineIndex);
			if (finalRow < 1 || finalRow > visibleRows) continue;
			// Hit columns come from the final painted line (parent may prefix/transform).
			const line = placement.finalLine;
			if (!component.expanded) {
				const box = collapsedHintHitbox(line);
				if (box && COLLAPSED_TOOL_SUMMARY.test(stripTerminalSequences(line))) {
					regions.push({ kind: "collapsed-hint", row: finalRow, ...box, component });
				}
				continue;
			}
			if (placement.view && placement.section) {
				const plain = stripTerminalSequencesPreservingLayout(line);
				const box = placement.view.showMoreHitbox(plain);
				if (box) {
					regions.push({
						kind: "show-more",
						row: finalRow,
						...box,
						component,
						view: placement.view,
						section: placement.section,
					});
				}
			}
		}
		if (!component.expanded) continue;
		let cardStart = 0;
		if (!(component instanceof ToolGroupComponent)) {
			const box = component.contentBox;
			if (!box || !Array.isArray(component.children) || !component.children.includes(box)) {
				continue;
			}
			if (!rendered.contentBoxLines) continue;
			cardStart = Math.max(0, rendered.lines.length - rendered.contentBoxLines);
		}
		for (const placement of componentPlacements) {
			if (placement.componentRow < cardStart) continue;
			const finalRow = lineIndexToScreenRow(placement.lineIndex);
			if (finalRow >= 1 && finalRow <= visibleRows) {
				regions.push({
					kind: "expanded-card",
					row: finalRow,
					startCol: 1,
					endCol: width,
					component,
				});
			}
		}
	}
	return { regions };
}

/**
 * 临时包装 outermost 工具/组件的 render 注入零宽 marker，返回待 restore 列表。
 * 调用方必须用 restoreRenderOverride 立即还原（同一次渲染内有效）。
 */
function wrapToolRendersForFrame(
	outermost: any[],
	renderedTools: FrameToolRender[],
	idToComponent: Map<number, any>,
): Array<{ target: any; descriptor?: PropertyDescriptor }> {
	const restores: Array<{ target: any; descriptor?: PropertyDescriptor }> = [];
	let nextId = 0;
	try {
		for (const component of outermost) {
			const originalRender = component.render;
			if (typeof originalRender !== "function") continue;
			const id = nextId++;
			idToComponent.set(id, component);
			const wrappedRender = function (this: any, ...renderArgs: any[]) {
				let contentBoxLines = 0;
				const box = component.contentBox;
				let boxRestore: { target: any; descriptor?: PropertyDescriptor } | undefined;
				if (
					box &&
					Array.isArray(component.children) &&
					component.children.includes(box) &&
					typeof box.render === "function"
				) {
					const boxOriginal = box.render;
					const boxWrapped = function (this: any, ...boxArgs: any[]) {
						const boxLines = Reflect.apply(boxOriginal, this, boxArgs);
						if (Array.isArray(boxLines)) contentBoxLines = boxLines.length;
						return boxLines;
					};
					const boxDescriptor = defineRenderOverride(box, boxWrapped);
					if (boxDescriptor !== undefined || box.render === boxWrapped) {
						boxRestore = { target: box, descriptor: boxDescriptor };
					}
				}
				try {
					const lines = Reflect.apply(originalRender, this, renderArgs);
					if (!Array.isArray(lines)) return lines;
					renderedTools.push({
						component,
						lines: lines.map((line) => String(line)),
						contentBoxLines,
					});
					return lines.map((line, row) => `${line}${toolFrameMarker(id, row)}`);
				} finally {
					if (boxRestore) restoreRenderOverride(boxRestore.target, boxRestore.descriptor);
				}
			};
			const descriptor = defineRenderOverride(component, wrappedRender);
			if (descriptor !== undefined || component.render === wrappedRender) {
				restores.push({ target: component, descriptor });
			}
		}
		return restores;
	} catch (error) {
		for (const { target, descriptor } of restores.reverse()) {
			restoreRenderOverride(target, descriptor);
		}
		throw error;
	}
}

function defineRenderOverride(
	target: any,
	wrapped: (...args: any[]) => any,
): PropertyDescriptor | undefined {
	const descriptor = Object.getOwnPropertyDescriptor(target, "render");
	try {
		Object.defineProperty(
			target,
			"render",
			descriptor && "value" in descriptor
				? { ...descriptor, value: wrapped }
				: {
						configurable: true,
						enumerable: descriptor?.enumerable ?? false,
						writable: true,
						value: wrapped,
					},
		);
		return descriptor;
	} catch {
		return undefined;
	}
}

function restoreRenderOverride(target: any, descriptor: PropertyDescriptor | undefined): void {
	try {
		if (descriptor) Object.defineProperty(target, "render", descriptor);
		else delete target.render;
	} catch {
		// Keep restoring siblings after a hostile descriptor change.
	}
}

function patchToolMouseMotionAfterRender(tui: any): void {
	// Same tui is not enough: footer/compositor rebuild may replace doRender under us.
	if (
		toolMouseRenderPatchTui === tui &&
		toolMouseRenderPatchState?.active &&
		tui.doRender === toolMouseRenderPatchWrapper
	) {
		return;
	}
	// 0.84+ 惰性 Proxy：捕获 doRender 会解析到 wrapper 自身（无限递归），跳过。
	if (isLazyProxyTui(tui)) return;
	restoreToolMouseRenderPatch();
	const original = tui?.doRender;
	const terminal = tui?.terminal;
	const rawWrite = typeof terminal?.write === "function" ? terminal.write : undefined;
	if (typeof original !== "function") return;

	toolMouseRawWrite = rawWrite ? (data) => Reflect.apply(rawWrite, terminal, [data]) : null;
	const patchState = { active: true };
	const wrapper = function (this: any, ...args: any[]) {
		if (!patchState.active) return Reflect.apply(original, this, args);
		const renderedTools: FrameToolRender[] = [];
		const idToComponent = new Map<number, any>();
		const frame: IoViewFrameState = {
			viewIds: new Map(),
			idToView: new Map(),
			nextId: 0,
		};
		const outermost: any[] = [];
		collectToolComponents(this, outermost);
		const restores = wrapToolRendersForFrame(outermost, renderedTools, idToComponent);
		let placements: FrameToolPlacement[] = [];
		const originalTuiRender = typeof this.render === "function" ? this.render : null;
		let tuiRenderDescriptor: PropertyDescriptor | undefined;
		let sawTuiRender = false;
		if (originalTuiRender) {
			const wrappedTuiRender = function (this: any, ...renderArgs: any[]) {
				const lines = Reflect.apply(originalTuiRender, this, renderArgs);
				if (!Array.isArray(lines)) return lines;
				sawTuiRender = true;
				const extracted = extractToolFramePlacements(
					lines.map((line) => String(line)),
					idToComponent,
					frame.idToView,
				);
				placements = extracted.placements;
				return extracted.lines;
			};
			tuiRenderDescriptor = defineRenderOverride(this, wrappedTuiRender);
		}
		let succeeded = false;
		const previousFrame = getActiveIoViewFrame();
		setActiveIoViewFrame(frame);
		try {
			const result = Reflect.apply(original, this, args);
			succeeded = true;
			// Test harnesses may paint via doRender without tui.render; recover markers there.
			if (!sawTuiRender && Array.isArray(this.previousLines)) {
				const extracted = extractToolFramePlacements(
					this.previousLines.map((line: unknown) => String(line)),
					idToComponent,
					frame.idToView,
				);
				this.previousLines = extracted.lines;
				placements = extracted.placements;
			}
			if (toolMouseInteractionActive()) toolMouseRawWrite?.(TOOL_MOUSE_MOTION_ENABLE);
			return result;
		} finally {
			setActiveIoViewFrame(previousFrame);
			if (originalTuiRender) restoreRenderOverride(this, tuiRenderDescriptor);
			for (const { target, descriptor } of restores.reverse()) {
				restoreRenderOverride(target, descriptor);
			}
			if (succeeded) {
				latestInteractionFrame = buildInteractionFrame(this, renderedTools, placements);
			}
		}
	};
	try {
		tui.doRender = wrapper;
	} catch {
		toolMouseRawWrite = null;
		return;
	}
	toolMouseRenderPatchTui = tui;
	toolMouseRenderPatchOriginal = original;
	toolMouseRenderPatchWrapper = wrapper;
	toolMouseRenderPatchState = patchState;
	if (toolMouseInteractionActive()) toolMouseRawWrite?.(TOOL_MOUSE_MOTION_ENABLE);
}

function handleToolMouseInput(data: string): { consume: true } | undefined {
	if (!getToolMouseTui()) return undefined;
	// 惰性 Proxy fullscreen：鼠标由 handleViewportInput 包装消费（官方链之前），
	// 此处只处理键盘（鼠标事件在官方 listener 已被 consume，到不了这里）。
	if (fullscreenLazyTui(getToolMouseTui())) {
		scheduleScrollButtonSync(getToolMouseTui(), data);
		if (isScrollBottomInput(data)) {
			getToolMouseTui().scrollToBottom?.();
			hideScrollButton(getToolMouseTui());
			return { consume: true };
		}
		return undefined;
	}
	updateScrollButtonFromInput(getToolMouseTui(), data);
	// Off mode restores native input: wheel keeps scrolling through Pi's normal
	// dispatcher, while hover/click affordances are entirely inactive.
	if (!toolMouseInteractionActive()) return undefined;
	const packets = parseSgrMousePackets(data);
	if (!packets) {
		scheduleScrollButtonSync(getToolMouseTui(), data);
		return undefined;
	}

	let consumed = false;
	for (const packet of packets) {
		updateToolSummaryHover(getToolMouseTui(), packet);
		if (isSgrLeftRelease(packet)) completeExpandPanelClick();
		if (!isSgrLeftPress(packet)) continue;
		if (toggleToolAtMouseClick(getToolMouseTui(), packet)) {
			consumed = true;
		}
	}

	// Let scrolling, motion, release, and clicks outside tool results reach the
	// normal TUI input chain (including other extensions such as pi-zentui).
	scheduleScrollButtonSync(getToolMouseTui(), data);
	return consumed ? { consume: true } : undefined;
}

export function teardownToolMouseInteraction(
	owner: object = toolMouseInstallationOwner ?? DEFAULT_TOOL_MOUSE_OWNER,
): void {
	const current = patchRegistry.get<object>(TOOL_MOUSE_OWNER_KEY);
	if (current && current !== owner) return;
	if (sessionRenderTimer) {
		clearTimeout(sessionRenderTimer);
		sessionRenderTimer = null;
	}
	toolMouseInputUnsubscribe?.();
	toolMouseInputUnsubscribe = null;
	setHoveredToolCallId(null);
	setHoveredToolGroup(null);
	setHoveredThinking(null);
	setHoveredMessageDisplay(null);
	setHoveredToolIo(null, null);
	setHoveredCompactAssistant(null);
	clearExpandPanelDoubleClick();
	try {
		if (isLazyProxyTui(getToolMouseTui())) releaseFullscreenToolMouseMotion(getToolMouseTui());
		else getToolMouseTui()?.terminal?.write?.(TOOL_MOUSE_DISABLE);
	} catch {
		// The terminal may already be closed during shutdown.
	}
	try {
		toolMouseUi?.setWidget?.(TOOL_MOUSE_WIDGET_KEY, undefined);
	} catch {
		// The UI context may already have been reset during /reload.
	}
	restoreToolMouseRenderPatch();
	restoreFullscreenViewportInput(getToolMouseTui());
	restoreOfficialScrollToEnd(getToolMouseTui());
	resetScrollButtonState();
	setToolMouseTui(null);
	toolMouseUi = null;
	patchRegistry.dispose(TOOL_MOUSE_OWNER_KEY, owner);
	if (toolMouseInstallationOwner === owner) toolMouseInstallationOwner = null;
}

/** off 模式清理：清空 hover 与回到底部按钮状态（跨模块 rebind 统一经由此函数）。 */
export function resetToolHoverState(): void {
	setHoveredToolCallId(null);
	setHoveredThinking(null);
	setHoveredMessageDisplay(null);
	setHoveredCompactAssistant(null);
	setScrollButtonVisible(false);
	setScrollButtonHovered(false);
	restoreOfficialScrollToEnd(getToolMouseTui());
	releaseFullscreenToolMouseMotion(getToolMouseTui());
}

export function installToolMouseInteraction(
	ctx: any,
	owner: object = DEFAULT_TOOL_MOUSE_OWNER,
): void {
	teardownToolMouseInteraction(toolMouseInstallationOwner ?? owner);
	if (ctx?.mode !== "tui" || !ctx?.hasUI) return;
	if (typeof ctx.ui?.onTerminalInput !== "function" || typeof ctx.ui?.setWidget !== "function")
		return;

	toolMouseInstallationOwner = owner;
	patchRegistry.install(TOOL_MOUSE_OWNER_KEY, owner);
	setHoveredToolCallId(null);
	toolMouseUi = ctx.ui;
	// 0.84+ 的 tui 是惰性 Proxy：regular 保留原生 scrollback；fullscreen
	// 由官方 LayoutFrame 命中，并由扩展补齐 hover 所需的 all-motion 上报。
	ctx.ui.setWidget(TOOL_MOUSE_WIDGET_KEY, (tui: any, theme: any) => {
		setToolMouseTui(tui);
		setToolTuiFullscreen(fullscreenLazyTui(tui));
		// 光标去重只依赖 terminal，而 terminal 不随 renderer 切换重建：惰性 Proxy 的
		// 普通属性会解析到当前 renderer，所以 regular / fullscreen 两种形态都能装。
		// （不能放在下面的 !isLazyProxyTui 分支里：0.84+ 工厂永远拿到惰性 Proxy。）
		installCursorWriteDedupe(tui);
		if (isLazyProxyTui(tui)) {
			patchFullscreenViewportInput(tui);
			ensureFullscreenToolMouseMotion(tui);
			syncOfficialScrollToEnd(tui);
			setScrollButtonWidget({
				render: (width: number) => {
					patchFullscreenViewportInput(tui);
					ensureFullscreenToolMouseMotion(tui);
					syncOfficialScrollToEnd(tui);
					return renderScrollButton(width, theme);
				},
				invalidate() {},
			});
			return getScrollButtonWidget();
		}
		// Wrap doRender to capture the live frame for tool click/hover mapping.
		patchToolMouseMotionAfterRender(tui);
		if (toolMouseInteractionActive()) tui?.terminal?.write?.(TOOL_MOUSE_MOTION_ENABLE);
		const widget = {
			render: (width: number) => renderScrollButton(width, theme),
			invalidate() {},
		};
		setScrollButtonWidget(widget);
		return widget;
	});
	toolMouseInputUnsubscribe = ctx.ui.onTerminalInput(handleToolMouseInput);
}

function refreshToolRendererComponents(tui: any): void {
	const tools: any[] = [];
	collectToolComponents(tui, tools);
	for (const tool of tools) tool.invalidate?.();
}

export function scheduleSessionRender(refresh?: () => void): void {
	const tui = getToolMouseTui();
	if (!tui || typeof tui.requestRender !== "function") return;
	if (sessionRenderTimer) clearTimeout(sessionRenderTimer);
	// Restored transcripts are populated at different points for startup, reload,
	// and session replacement. Repaint after session_start and the surrounding UI
	// rebuild finish so messages are not left hidden until the next terminal input.
	sessionRenderTimer = setTimeout(() => {
		sessionRenderTimer = null;
		if (getToolMouseTui() !== tui) return;
		patchToolMouseMotionAfterRender(tui);
		refreshToolRendererComponents(tui);
		refresh?.();
		tui.requestRender(true);
	}, 0);
}
