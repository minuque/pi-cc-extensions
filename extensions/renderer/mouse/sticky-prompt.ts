/**
 * fullscreen 粘性用户消息头。
 *
 * userMessage 的正文首行滚出视口上沿后，把该行钉在视口上沿（单行省略），一直保留到
 * 下一条用户消息自己滚出上沿；单击粘性行跳回该消息正文开头。触发只看位置，不看消息长短。
 * regular 由终端回滚拥有，没有应用自有视口，不参与。
 *
 * 两个补丁：
 * - UserMessageComponent.render 注入零宽标记（\x1b_cc:p / \x1b_cc:P），给出消息行范围
 *   的精确边界；只在 fullscreen 注入，regular 没有消费方、也不该把标记写进终端。
 * - TuiAltScreen.compositeScrollToEndIndicator 包装：剥离标记，并在视口首行合成粘性行。
 */
import {
	compositeTuiLine,
	stripTerminalSequences,
	truncateToWidth,
	TuiAltScreen,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { UserMessageComponent } from "@earendil-works/pi-coding-agent";
import { config } from "../../config/config.ts";
import {
	patchRegistry,
	STICKY_PROMPT_FRAME_PATCH,
	STICKY_PROMPT_MARKER_PATCH,
	STICKY_PROMPT_STATE_SLOT,
} from "../../utils/patch-keys.ts";
import { isToolTuiFullscreen } from "../tool/names.ts";
import type { SgrMousePacket } from "./packets.ts";
import { setScrollButtonVisible } from "./scroll.ts";

/** 消息正文首行/末行的零宽 APC 标记；终端忽略，合成前剥离。 */
const MESSAGE_START = "\x1b_cc:p\x07";
const MESSAGE_END = "\x1b_cc:P\x07";
const MESSAGE_MARKER_RE = /\x1b_cc:[pP]\x07/g;
/** kitty/iTerm2 图片行：合成会破坏图片数据，整行放行。 */
const KITTY_IMAGE = "\x1b_G";
const ITERM2_IMAGE = "\x1b]1337;File=";

const STICKY_LEAD = " ";
const STICKY_HINT_TEXT = " [click to jump]";
/** 视口宽度低于该值时不画点击提示，先保证正文省得下。 */
const STICKY_HINT_MIN_WIDTH = 24;

type StickyPromptState = {
	/** 最近一帧的布局对象：交互前与 tui.currentLayout 恒等比较，避免拿上一帧的行号动手。 */
	layout: any;
	visible: boolean;
	hovered: boolean;
	/** 粘性行所在屏幕行，与 bar 的起始列/可用宽度，来自最近一帧。 */
	row: number;
	x: number;
	width: number;
	/** 正文首行的内容行号。 */
	jumpRow: number;
	text: string;
	theme: any;
};

function stickyState(): StickyPromptState {
	return patchRegistry.ensure(STICKY_PROMPT_STATE_SLOT, () => ({
		layout: null,
		visible: false,
		hovered: false,
		row: -1,
		x: 0,
		width: 0,
		jumpRow: 0,
		text: "",
		theme: null,
	}));
}

export function setStickyPromptTheme(theme: any): void {
	stickyState().theme = theme;
}

export function resetStickyPromptState(): void {
	const state = stickyState();
	state.layout = null;
	state.visible = false;
	state.hovered = false;
}

/** 功能开关：仅 fullscreen 生效，off 模式还原原生渲染。 */
function stickyPromptActive(): boolean {
	return config.stickyUserMessage && config.mode !== "off";
}

function setStickyHovered(hovered: boolean): boolean {
	const state = stickyState();
	if (state.hovered === hovered) return false;
	state.hovered = hovered;
	return true;
}

function lineText(line: string): string {
	return stripTerminalSequences(line).trim();
}

function isImageLine(line: string): boolean {
	return line.includes(KITTY_IMAGE) || line.includes(ITERM2_IMAGE);
}

/** 当前指令：start 是消息首行（跳转目标），textRow 是正文首行（粘性行文本）。 */
type PromptCursor = {
	start: number;
	textRow: number;
};

/** 消息内找正文首行的行数上限；超过说明这条消息没有正文。 */
const PROMPT_TEXT_SCAN_LIMIT = 64;

/**
 * 视口上沿上方最近一条 userMessage 就是当前指令。不看 END 标记：
 * 指令滚出上沿后一直钉，直到下一条指令自己滚出上沿接手。
 */
function scanPrompt(lines: readonly string[], row: number): PromptCursor | null {
	let start = -1;
	for (let i = Math.min(row, lines.length - 1); i >= 0; i--) {
		if ((lines[i] ?? "").includes(MESSAGE_START)) {
			start = i;
			break;
		}
	}
	if (start < 0) return null;
	const textRow = findPromptTextRow(lines, start);
	return textRow < 0 ? null : { start, textRow };
}

/** 正文首行：跳过消息内的空行；以 END 标记为界，避免读到助手正文。 */
function findPromptTextRow(lines: readonly string[], start: number): number {
	const end = findMessageEnd(lines, start);
	if (end < 0) return -1;
	for (let i = start; i <= end; i++) {
		if (lineText(lines[i] ?? "") !== "") return i;
	}
	return -1;
}

function findMessageEnd(lines: readonly string[], start: number): number {
	const limit = Math.min(lines.length - 1, start + PROMPT_TEXT_SCAN_LIMIT);
	for (let i = start; i <= limit; i++) {
		if ((lines[i] ?? "").includes(MESSAGE_END)) return i;
	}
	return -1;
}

/** 主滚动视图的布局盒：优先按 scrollView 引用，退化到第一个有内容行的 scroll 盒。 */
function findScrollBox(box: any, scrollView: any): any {
	let fallback: any = null;
	const visit = (node: any): any => {
		if (!node) return null;
		if (scrollView && node.scrollView === scrollView) return node;
		if (!fallback && Array.isArray(node.scrollContentLines) && node.scrollContentLines.length > 0) {
			fallback = node;
		}
		for (const child of node.children ?? []) {
			const hit = visit(child);
			if (hit) return hit;
		}
		return null;
	};
	return visit(box) ?? fallback;
}

export type StickyPromptInfo = {
	row: number;
	x: number;
	width: number;
	jumpRow: number;
	text: string;
};

/**
 * 滚动条轨道顶端那格所在的屏幕行和列；那一格是滑块、轨道在最顶端不可点、或
 * 没有滚动条时返回 null。点在轨道顶端会被 Pi 当成「跳到会话开头」。
 * 与 pi-tui getScrollbarGeometry 同一公式（它不在包入口导出）：滑块至少 2 行，
 * 位置按 scrollTop 占可滚范围的比例映射到轨道。
 */
export function scrollbarTopTrackCell(box: any): { row: number; col: number } | null {
	const view = box?.scrollView;
	const rect = box?.rect;
	const clip = box?.clip;
	if (!view?.isScrollbarVisible || !rect || !clip || rect.width <= 0 || rect.height <= 0)
		return null;
	const column = rect.x + rect.width - 1;
	if (column < clip.x || column >= clip.x + clip.width) return null;
	const contentHeight = box.children?.[0]?.rect?.height ?? box.scrollContentLines?.length ?? 0;
	const trackHeight = rect.height;
	if (contentHeight <= 0) return null;
	const thumbHeight = Math.max(
		Math.min(2, trackHeight),
		Math.min(trackHeight, Math.round((trackHeight * trackHeight) / contentHeight)),
	);
	const maxScrollTop = Math.max(0, contentHeight - trackHeight);
	const maxThumbTop = trackHeight - thumbHeight;
	const scrollTop = Number(view.scrollTop ?? 0);
	const thumbTop =
		rect.y + (maxScrollTop === 0 ? 0 : Math.round((scrollTop / maxScrollTop) * maxThumbTop));
	// 顶端这一格是轨道而非滑块时才返回它：滑块一上来，整格就归拖动。
	return thumbTop > clip.y ? { row: clip.y, col: column } : null;
}

/** 视口上沿落在 userMessage 之下时，返回粘性行的位置与文本。 */
export function computeStickyPrompt(tui: any, layout: any): StickyPromptInfo | null {
	if (!layout?.root) return null;
	const scrollView = layout.primaryScrollView ?? tui?.getPrimaryScrollView?.();
	const box = findScrollBox(layout.root, scrollView);
	const lines = box?.scrollContentLines as readonly string[] | undefined;
	const clip = box?.clip;
	if (!box || !Array.isArray(lines) || !clip || clip.width <= 0 || clip.height <= 0) return null;
	const scrollTop = Math.max(0, Math.floor(Number(box.scrollView?.scrollTop ?? 0)));
	if (scrollTop <= 0) return null;
	const cursor = scanPrompt(lines, scrollTop);
	if (!cursor) return null;
	// 正文首行还在视口内时消息本就在场，不需要钉。
	if (cursor.textRow >= scrollTop) return null;
	const scrollbar = box.scrollView?.isScrollbarVisible === true && clip.width > 1;
	return {
		row: clip.y,
		x: clip.x,
		width: scrollbar ? clip.width - 1 : clip.width,
		// 跳消息首行而不是正文首行：原生消息块自带上下村白，跳正文会把顶边切掉。
		jumpRow: cursor.start,
		text: lineText(lines[cursor.textRow] ?? ""),
	};
}

/**
 * 整行铺满可用宽度的用户消息底色条：正文 + 点击提示（首列留一个空格与消息正文对齐）。
 * truncateToWidth 会在截断处插入样式重置，必须在包底色前剥掉，否则省略号与提示会
 * 脱出底色，按终端默认色显示。
 */
export function stickyPromptBar(text: string, width: number, hovered: boolean, theme: any): string {
	const hint = width >= STICKY_HINT_MIN_WIDTH ? STICKY_HINT_TEXT : "";
	const room = Math.max(0, width - visibleWidth(STICKY_LEAD) - visibleWidth(hint));
	const body = stripTerminalSequences(truncateToWidth(text, room, "…"));
	const pad = " ".repeat(
		Math.max(0, width - visibleWidth(STICKY_LEAD) - visibleWidth(body) - visibleWidth(hint)),
	);
	const plain = STICKY_LEAD + body + pad + hint;
	try {
		if (typeof theme?.fg !== "function" || typeof theme?.bg !== "function") return plain;
		return theme.bg("userMessageBg", theme.fg(hovered ? "text" : "dim", plain));
	} catch {
		// 主题槽位缺失时退回无样式，不打断整帧渲染。
		return plain;
	}
}

/** 屏幕行里的消息标记必须在写往终端前剥离。 */
function stripMessageMarkers(lines: string[]): string[] {
	const dirty = lines.some(
		(line) =>
			typeof line === "string" && (line.includes(MESSAGE_START) || line.includes(MESSAGE_END)),
	);
	return dirty ? lines.map((line) => line.replace(MESSAGE_MARKER_RE, "")) : lines;
}

/**
 * TuiAltScreen 帧合成钩子：先剥离标记，再在视口首行覆盖粘性行。
 * 位于 diff 比较之前，因此内容滚动、hover 高亮、跳转都会正常进差分。
 */
export function renderStickyPromptScreen(
	tui: any,
	screen: string[],
	layout: any,
	terminalWidth: number,
): string[] {
	const stripped = stripMessageMarkers(screen);
	const state = stickyState();
	const info = stickyPromptActive() ? computeStickyPrompt(tui, layout) : null;
	const sameTarget = Boolean(
		info && state.visible && state.row === info.row && state.jumpRow === info.jumpRow,
	);
	state.layout = layout;
	state.visible = Boolean(info);
	if (!info) {
		state.hovered = false;
		return stripped;
	}
	state.row = info.row;
	state.x = info.x;
	state.width = info.width;
	state.jumpRow = info.jumpRow;
	state.text = info.text;
	if (!sameTarget) state.hovered = false;
	if (info.row < 0 || info.row >= stripped.length) return stripped;
	const base = stripped[info.row] ?? "";
	if (isImageLine(base)) return stripped;
	const bar = stickyPromptBar(info.text, info.width, state.hovered, state.theme);
	const next = [...stripped];
	next[info.row] = compositeTuiLine(base, bar, info.x, info.width, terminalWidth);
	return next;
}

/** 行与列都落在本帧画出的粘性条内。滚动条那一列在条外。 */
function stickyBarHit(tui: any, packet: SgrMousePacket): boolean {
	const state = stickyState();
	if (!stickyPromptActive() || !state.visible || state.layout !== tui?.currentLayout) return false;
	if (packet.row - 1 !== state.row) return false;
	const col = packet.col - 1;
	return col >= state.x && col < state.x + state.width;
}

/**
 * 指针是否落在粘性条上。返回 true 时调用方不再做工具 hover，避免同一行双重高亮；
 * hover 状态变化自行请求重绘（它不在 hover.ts 的状态里）。
 */
export function updateStickyPromptHover(tui: any, packet: SgrMousePacket): boolean {
	const onBar = stickyBarHit(tui, packet);
	if (setStickyHovered(onBar)) tui.requestRender?.();
	return onBar;
}

/**
 * 滚动条轨道顶端那一格的按下：吞掉不处理。
 * 放行的话 Pi 会把滑块跳到轨道顶端，阅读位置回到会话开头。粘性条在时整行最容易误点。
 * 那格是滑块时不拦，照常拖动；没有滚动条、滚动条不可见时也不拦。
 */
export function scrollbarTopTrackHit(tui: any, packet: SgrMousePacket): boolean {
	if (!stickyPromptActive()) return false;
	const state = stickyState();
	if (!state.visible || state.layout !== tui?.currentLayout) return false;
	const box = findScrollBox(tui?.currentLayout?.root, tui?.getPrimaryScrollView?.());
	const cell = scrollbarTopTrackCell(box);
	if (!cell) return false;
	// 只在粘性条那一行拦：那一行被遮住，不知道点的是轨道还是滑块。
	return state.row === cell.row && packet.row - 1 === cell.row && packet.col - 1 === cell.col;
}

/** 单击粘性行：视口滚到该消息首行（整块可见），并亮出回到底部按钮。 */
export function handleStickyPromptClick(tui: any, packet: SgrMousePacket): boolean {
	const state = stickyState();
	if (scrollbarTopTrackHit(tui, packet)) return true;
	if (!stickyBarHit(tui, packet)) return false;
	const view = tui.getPrimaryScrollView?.();
	if (typeof view?.scrollTo === "function") {
		view.scrollTo(state.jumpRow, { disableFollow: true });
		if (view.isFollowingEnd === false) setScrollButtonVisible(true);
	}
	// 落点已到消息头，这一帧的粘性行立即失效；等下一帧按新位置重算。
	state.visible = false;
	state.hovered = false;
	tui.requestRender?.();
	return true;
}

type StickyPatch = {
	active: boolean;
	original: (...args: any[]) => any;
	installed: (...args: any[]) => any;
};

/**
 * 本模块实例安装的两个补丁。dispose 只能碰自己装的那一个：
 * /reload 时新实例可能已经接手（旧 shutdown 后到），按注册表取会把新补丁停掉。
 */
let markerPatch: StickyPatch | null = null;
let framePatch: StickyPatch | null = null;

/** UserMessageComponent.render 注入零宽标记（仅 fullscreen）。 */
export function installStickyPromptMarkerPatch(): void {
	const prototype = (UserMessageComponent as any)?.prototype;
	if (typeof prototype?.render !== "function") return;
	const previous = patchRegistry.get<StickyPatch>(STICKY_PROMPT_MARKER_PATCH);
	if (previous) previous.active = false;
	const original =
		previous && prototype.render === previous.installed ? previous.original : prototype.render;
	const patch: StickyPatch = {
		active: true,
		original,
		installed(this: any, width: number) {
			const lines = original.call(this, width);
			if (!patch.active || !isToolTuiFullscreen()) return lines;
			if (!Array.isArray(lines) || lines.length === 0) return lines;
			// 接在行尾：行首的 OSC133 前缀保持在下游的可剥离位置。
			lines[0] += MESSAGE_START;
			lines[lines.length - 1] += MESSAGE_END;
			return lines;
		},
	};
	prototype.render = patch.installed;
	patchRegistry.install(STICKY_PROMPT_MARKER_PATCH, patch);
	markerPatch = patch;
}

/** TuiAltScreen.compositeScrollToEndIndicator 包装：合成粘性行。返回是否安装成功。 */
export function installStickyPromptFramePatch(): boolean {
	const prototype = (TuiAltScreen as any)?.prototype;
	if (typeof prototype?.compositeScrollToEndIndicator !== "function") return false;
	const previous = patchRegistry.get<StickyPatch>(STICKY_PROMPT_FRAME_PATCH);
	if (previous) previous.active = false;
	const original =
		previous && prototype.compositeScrollToEndIndicator === previous.installed
			? previous.original
			: prototype.compositeScrollToEndIndicator;
	const patch: StickyPatch = {
		active: true,
		original,
		installed(this: any, screen: string[], layout: any, width: number) {
			const result = original.call(this, screen, layout, width);
			if (!patch.active) return result;
			return renderStickyPromptScreen(this, result, layout, width);
		},
	};
	prototype.compositeScrollToEndIndicator = patch.installed;
	patchRegistry.install(STICKY_PROMPT_FRAME_PATCH, patch);
	framePatch = patch;
	return true;
}

export function installStickyPromptPatches(): void {
	// 标记必须有消费方：帧合成补丁装不上（上游改名）时不注入，
	// 否则零宽标记会随帧写进终端。
	if (installStickyPromptFramePatch()) installStickyPromptMarkerPatch();
}

export function disposeStickyPromptPatches(): void {
	disposeStickyPatch(
		STICKY_PROMPT_MARKER_PATCH,
		markerPatch,
		(UserMessageComponent as any)?.prototype,
		"render",
	);
	disposeStickyPatch(
		STICKY_PROMPT_FRAME_PATCH,
		framePatch,
		(TuiAltScreen as any)?.prototype,
		"compositeScrollToEndIndicator",
	);
	markerPatch = null;
	framePatch = null;
	resetStickyPromptState();
}

/** 只停自己装的补丁；已被新实例接手时停掉包装器就够，不动原型也不动槽位。 */
function disposeStickyPatch(
	key: symbol,
	patch: StickyPatch | null,
	prototype: any,
	method: string,
): void {
	if (!patch) return;
	patch.active = false;
	if (!patchRegistry.owns(key, patch)) return;
	if (prototype && prototype[method] === patch.installed) prototype[method] = patch.original;
	patchRegistry.dispose(key, patch);
}
