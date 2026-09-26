import { ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { hasActiveTextPreview, showTextPreview } from "../../feature/context.ts";
import { ThinkingPreviewBlock } from "../../feature/compact-thinking.ts";
import {
	patchRegistry,
	TOOL_GROUPING_PARENT_KEY,
	TOOL_MOUSE_OWNER_KEY,
} from "../../utils/patch-keys.ts";
import { ToolGroupComponent } from "../tool/grouping.ts";
import { isCompactAssistantComponent, setHoveredCompactAssistant } from "../compact-mode.ts";
import { isMessageDisplayComponent } from "../tool/message-display.ts";
import { config } from "../../config/config.ts";
import { isLazyProxyTui } from "../../utils/fullscreen-detect.ts";
import { setToolTuiFullscreen, isCollapseHintLine } from "../tool/show-more-hint.ts";
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
	kind: "collapsed-hint" | "collapse-hint" | "expanded-card" | "show-more" | "scroll-bottom";
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
		matches.find((region) => region.kind === "collapse-hint") ??
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
	// group 只在提示文字上高亮（展开卡整行都是 expanded-card，不能算 hint）。
	const nextGroup =
		(region?.kind === "collapsed-hint" || region?.kind === "collapse-hint") &&
		component instanceof ToolGroupComponent
			? component
			: null;
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

/** 单击判定：按下与松开落在同一格（renderer 合成 click 的条件），位移与时限各留容差。 */
const COLLAPSE_CLICK_MOVE_TOLERANCE = 1;
const COLLAPSE_CLICK_MAX_MS = 600;
/** 扩展收起自有卡后，官方 click 可能对同一次点击再 toggle 内部工具卡，短暂吞掉。 */
const SUPPRESS_OFFICIAL_CARD_CLICK_MS = 300;

let pendingCollapsePress: {
	card: any;
	/** 命中的最内层组件：官方工具卡由 MouseRegion 的 click 收起。 */
	component: any;
	col: number;
	row: number;
	at: number;
} | null = null;
let suppressOfficialCardClickUntil = 0;

function clearPendingCollapsePress(): void {
	pendingCollapsePress = null;
}

/** 带键拖动或滚轮：位置真的变了（超出抖动容差）就不再是单击。 */
function clearPendingCollapsePressOnMove(packet: SgrMousePacket): void {
	const press = pendingCollapsePress;
	if (!press) return;
	if ((packet.code & 64) !== 0) {
		pendingCollapsePress = null;
		return;
	}
	if (Math.abs(packet.col - press.col) <= COLLAPSE_CLICK_MOVE_TOLERANCE) {
		if (Math.abs(packet.row - press.row) <= COLLAPSE_CLICK_MOVE_TOLERANCE) return;
	}
	pendingCollapsePress = null;
}

function clearHoverState(): void {
	setHoveredToolCallId(null);
	setHoveredToolGroup(null);
	setHoveredThinking(null);
	setHoveredMessageDisplay(null);
	setHoveredToolIo(null, null);
	setHoveredCompactAssistant(null);
}

/** 收起一张展开卡（group 的 setExpanded 会传播到内部工具）。 */
function collapseExpandedCard(tui: any, card: any): void {
	card.setExpanded(false);
	clearHoverState();
	card.invalidate?.();
	tui?.requestRender?.();
}

function rememberCollapsePress(card: any, component: any, packet: SgrMousePacket): void {
	pendingCollapsePress = { card, component, col: packet.col, row: packet.row, at: Date.now() };
}

/**
 * 松手结算：只有"按下与松开在同一格"的完整单击才收起，拖动选择文本时保持展开。
 * 官方工具卡（result 区的 MouseRegion）由 guard 在官方 click 里收起，这里必须跳过，
 * 否则先收起会被官方 click 的 setExpanded(!expanded) 翻回来。
 */
function resolveCollapsePress(
	tui: any,
	packet: SgrMousePacket,
	options: { skipOfficialCards: boolean },
): void {
	const press = pendingCollapsePress;
	pendingCollapsePress = null;
	if (!press || packet.final !== "m") return;
	if (Math.abs(packet.col - press.col) > COLLAPSE_CLICK_MOVE_TOLERANCE) return;
	if (Math.abs(packet.row - press.row) > COLLAPSE_CLICK_MOVE_TOLERANCE) return;
	if (Date.now() - press.at > COLLAPSE_CLICK_MAX_MS) return;
	if (options.skipOfficialCards && press.component instanceof ToolExecutionComponent) return;
	const card = press.card;
	if (
		(card instanceof ToolGroupComponent || isCompactAssistantComponent(card)) &&
		press.component !== card
	) {
		// 点击落在卡内工具行：官方 click 会对同一次点击再次 toggle，吞掉它。
		suppressOfficialCardClickUntil = Date.now() + SUPPRESS_OFFICIAL_CARD_CLICK_MS;
	}
	collapseExpandedCard(tui, card);
}

function toggleToolAtMouseClick(tui: any, packet: SgrMousePacket): boolean {
	const region = interactionRegionAt(packet);
	if (!region) return false;
	if (region.kind === "scroll-bottom") return false;
	if (region.kind === "show-more") return tryOpenToolIoShowMore(region);
	const component = region.component;
	if (!component) return false;
	if (region.kind === "expanded-card" || region.kind === "collapse-hint") {
		// regular 模式没有官方 click 合成，按下先记账，松手结算是否收起。
		rememberCollapsePress(component, component, packet);
		return true;
	}
	component.setExpanded(true);
	clearPendingCollapsePress();
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
 * diff 结果组件自带 remainder 行：声明存在时只有那一行是展开入口（正文里的同名字样不算）；
 * 未声明的组件继续用文本规则。
 */
function isCollapsedHintRow(component: any, finalLine: string): boolean {
	const result = component?.resultRendererComponent;
	return typeof result?.isCollapsedHintLine === "function"
		? result.isCollapsedHintLine(finalLine)
		: true;
}

/**
 * pi 0.87 给工具结果区套了 MouseRegion：整卡左键 click 都会 setExpanded。
 * 命中该区域时官方会跳过文本选区，所以可以安全吞掉；单行摘要卡没有声明
 * remainder 行，继续走官方整行行为。
 */
function blocksOfficialCardToggle(component: any, event: any): boolean {
	if (event?.type !== "click" || event.button !== "left" || component?.expanded) return false;
	const result = component?.resultRendererComponent;
	if (typeof result?.isCollapsedHintLine !== "function") return false;
	const lines = component.render?.(Math.max(1, Math.floor(Number(event.width) || 0)));
	const line = Array.isArray(lines) ? lines[event.y] : undefined;
	return typeof line === "string" && !result.isCollapsedHintLine(line);
}

/**
 * 官方 fullscreen 工具卡点击：collapsed hint 单击展开
 * （有且仅保持一个展开：展开前收起其他工具卡），expanded 卡放行官方 press，
 * 位置不变的松手才收起（官方卡经 guard，思考/group/compact 自有卡由扩展结算），
 * 拖动选择文本时不收起；截断头 show-more 单击打开全量预览；回到底部按钮 scrollToBottom。
 * 滚动条列、含 OSC8 链接行、非工具区域、折叠卡正文放行官方。
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
		if (!isCollapsedHintRow(component, line)) return false;
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
		clearPendingCollapsePress();
	} else {
		// 普通工具截断头 show-more：打开全量预览（不收起）。
		const view = isTool ? component.resultRendererComponent : null;
		if (isExpandedToolIoView(view)) {
			const plain = stripTerminalSequencesPreservingLayout(line);
			const section = view.matchShowMoreLine(plain);
			if (section) {
				clearPendingCollapsePress();
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
		// 其余放行官方：选区、OSC8 链接与 click 合成都交给 renderer。
		// 完整单击的收起：官方卡由 guard 处理，自有卡在松手时结算。
		rememberCollapsePress(card, component, packet);
		return false;
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
					if (isSgrLeftRelease(packet))
						resolveCollapsePress(tui, packet, { skipOfficialCards: true });
					else if (!isSgrLeftPress(packet) && !isSgrIdleMotion(packet))
						clearPendingCollapsePressOnMove(packet);
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
				if (
					box &&
					COLLAPSED_TOOL_SUMMARY.test(stripTerminalSequences(line)) &&
					isCollapsedHintRow(component, line)
				) {
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
				// 展开态的 ↑ Collapse 提示单独成区：hover 高亮 hint，点击仍收起整卡。
				const hintBox = collapsedHintHitbox(placement.finalLine);
				if (hintBox && isCollapseHintLine(stripTerminalSequences(placement.finalLine))) {
					regions.push({ kind: "collapse-hint", row: finalRow, ...hintBox, component });
				}
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
		if (isSgrLeftRelease(packet)) {
			resolveCollapsePress(getToolMouseTui(), packet, { skipOfficialCards: false });
			continue;
		}
		if (!isSgrLeftPress(packet)) {
			// 带键拖动或滚轮：位置变了就不再是单击。
			if (!isSgrIdleMotion(packet)) clearPendingCollapsePressOnMove(packet);
			continue;
		}
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
	releaseToolCardMouseGuard();
	clearPendingCollapsePress();
	suppressOfficialCardClickUntil = 0;
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

/**
 * pi 0.87 起工具卡结果区自带 MouseRegion，整卡左键 click 都会 setExpanded。
 * ccstyle 的多行折叠卡（rich diff）只允许声明的 remainder 行展开，
 * 其余位置直接吞掉 click，避免官方把 diff 正文当展开入口。
 * 0.84 及更早没有 handleMouse，安装时跳过。
 */
const TOOL_CARD_MOUSE_GUARD_KEY = Symbol.for("pi.ccstyle.tool-card-mouse-guard");

type ToolCardMouseGuard = {
	prototype: any;
	original: (event: any) => any;
	wrapper: (event: any) => any;
};

/** 官方 click 落在展开卡上：同一 group 的任意内部工具行都收起整个 group。 */
function collapseExpandedCardFromOfficialClick(component: any): void {
	if (typeof component?.setExpanded !== "function") return;
	const group = component?.[TOOL_GROUPING_PARENT_KEY];
	collapseExpandedCard(getToolMouseTui(), group instanceof ToolGroupComponent ? group : component);
}

function installToolCardMouseGuard(): void {
	const prototype = (ToolExecutionComponent as any)?.prototype;
	if (typeof prototype?.handleMouse !== "function") return;
	const previous = (globalThis as any)[TOOL_CARD_MOUSE_GUARD_KEY] as ToolCardMouseGuard | undefined;
	if (previous && previous.prototype === prototype && prototype.handleMouse === previous.wrapper)
		return;
	// 每次取当前值作为下游，可能是别的扩展的包装。
	const original = prototype.handleMouse;
	const wrapper = function (this: any, event: any) {
		if (event?.type === "click" && event.button === "left") {
			// 扩展刚收起过自有卡：这次 click 属于同一次单击，吞掉避免内部工具被翻回展开。
			if (suppressOfficialCardClickUntil && Date.now() <= suppressOfficialCardClickUntil) {
				suppressOfficialCardClickUntil = 0;
				if (this?.expanded) collapseExpandedCardFromOfficialClick(this);
				return { handled: true };
			}
			// 展开卡整卡 click：接管官方 toggle，改为收起（group 内部工具行收起整个 group）。
			if (this?.expanded && typeof this.setExpanded === "function") {
				collapseExpandedCardFromOfficialClick(this);
				return { handled: true };
			}
		}
		if (blocksOfficialCardToggle(this, event)) return { handled: true };
		return original.call(this, event);
	};
	prototype.handleMouse = wrapper;
	(globalThis as any)[TOOL_CARD_MOUSE_GUARD_KEY] = { prototype, original, wrapper };
}

function releaseToolCardMouseGuard(): void {
	const guard = (globalThis as any)[TOOL_CARD_MOUSE_GUARD_KEY] as ToolCardMouseGuard | undefined;
	if (!guard) return;
	if (guard.prototype?.handleMouse === guard.wrapper) guard.prototype.handleMouse = guard.original;
	(globalThis as any)[TOOL_CARD_MOUSE_GUARD_KEY] = undefined;
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
	installToolCardMouseGuard();
	setHoveredToolCallId(null);
	toolMouseUi = ctx.ui;
	// 0.84+ 的 tui 是惰性 Proxy：regular 保留原生 scrollback；fullscreen
	// 由官方 LayoutFrame 命中，并由扩展补齐 hover 所需的 all-motion 上报。
	ctx.ui.setWidget(TOOL_MOUSE_WIDGET_KEY, (tui: any, theme: any) => {
		setToolMouseTui(tui);
		setToolTuiFullscreen(fullscreenLazyTui(tui));
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
