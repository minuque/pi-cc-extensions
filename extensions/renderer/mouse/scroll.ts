import {
	getKeybindings,
	matchesKey,
	truncateToWidth,
	visibleWidth,
	type Keybinding,
} from "@earendil-works/pi-tui";
import { config } from "../../config/config.ts";
import { isLazyProxyTui } from "../../utils/fullscreen-detect.ts";
import { parseSgrMousePackets } from "./packets.ts";
import {
	OFFICIAL_SCROLL_TO_END_KEY,
	patchRegistry,
	SCROLL_BUTTON_STATE_SLOT,
	TOOL_MOUSE_TUI_SLOT,
} from "../../utils/patch-keys.ts";

const ZENTUI_PAGE_UP_INPUT = /^\x1b\[5;9(?::[12])?~$|^\x1b\[57421;9(?::[12])?u$|^\x1b\[1;6A$/;
const ZENTUI_PAGE_DOWN_INPUT = /^\x1b\[6;9(?::[12])?~$|^\x1b\[57422;9(?::[12])?u$|^\x1b\[1;6B$/;
const SCROLL_BOTTOM_KEYBINDING = "tui.altScreen.bottom";

patchRegistry.ensure(TOOL_MOUSE_TUI_SLOT, () => null);
export function getToolMouseTui(): any {
	return patchRegistry.get(TOOL_MOUSE_TUI_SLOT);
}
export function setToolMouseTui(tui: any): void {
	patchRegistry.install(TOOL_MOUSE_TUI_SLOT, tui);
}

type ScrollButtonState = {
	visible: boolean;
	hovered: boolean;
	widget: any;
	/** 按钮可见期间新落的 transcript 块数（消息 + 工具卡）。 */
	newCount: number;
};
function scrollButtonState(): ScrollButtonState {
	return patchRegistry.ensure(SCROLL_BUTTON_STATE_SLOT, () => ({
		visible: false,
		hovered: false,
		widget: null,
		newCount: 0,
	}));
}
export function getScrollButtonVisible(): boolean {
	return scrollButtonState().visible;
}
export function getScrollButtonHovered(): boolean {
	return scrollButtonState().hovered;
}
export function getScrollButtonWidget(): any {
	return scrollButtonState().widget;
}
export function getScrollButtonNewCount(): number {
	return scrollButtonState().newCount;
}
export function setScrollButtonVisible(visible: boolean): void {
	const state = scrollButtonState();
	state.visible = visible;
	// 计数只在离开底部期间有效：跟随输出即清零，文案回到 Back to bottom。
	if (!visible) state.newCount = 0;
}

/**
 * 记账一块新落进 transcript 的内容（用户/助手消息、工具卡）。
 * 仅在按钮可见（已滚动离开底部）时累加，并请求重绘让按钮文案立即更新。
 */
export function noteNewTranscriptItem(): void {
	const state = scrollButtonState();
	const tui = getToolMouseTui();
	if (nativeScrollTextEnabled(tui)) {
		syncOfficialScrollToEnd(tui);
		if (nativeScrollTextPatch && !isFullscreenAtBottom(tui)) {
			state.newCount += 1;
			tui.requestRender?.();
		}
		return;
	}
	if (!dockScrollButtonActive() || !state.visible || !tui) return;
	// 提交新消息时官方可能直接跳回底部（不经过滚动输入）：先按实时跟随状态校正，
	// 否则跟随期间的内容会被当成“离开底部时的新消息”计入。
	if (isAtTranscriptBottom(tui)) {
		hideScrollButton(tui);
		return;
	}
	state.newCount += 1;
	tui.requestRender?.();
}

/** 返回是否发生变化（调用方据此决定是否需要重渲染）。 */
export function setScrollButtonHovered(hovered: boolean): boolean {
	if (hovered === scrollButtonState().hovered) return false;
	scrollButtonState().hovered = hovered;
	return true;
}

export function setScrollButtonWidget(widget: any): void {
	scrollButtonState().widget = widget;
}

/** teardown 全量清零（visible/hovered/widget/sync 调度）。 */
export function resetScrollButtonState(): void {
	scrollButtonState().visible = false;
	scrollButtonState().hovered = false;
	scrollButtonState().widget = null;
	scrollButtonState().newCount = 0;
	scrollButtonSyncScheduled = false;
}

let scrollButtonSyncScheduled = false;

// 交互开关只取决于配置模式：原实现按 isLazyProxyTui(toolMouseTui) 分两分支，
// 两分支恒真（0.84+ 惰性 Proxy 下判定不再影响开关），折叠为单条件。
export function toolMouseInteractionActive(): boolean {
	return config.mode !== "off";
}

/** dock 模式才用扩展的独占行；native 或 ccstyle off 时交还 Pi 原生浮层。 */
export function dockScrollButtonActive(): boolean {
	return toolMouseInteractionActive() && config.scrollButtonMode === "dock";
}

/** 惰性 Proxy 官方 fullscreen（TuiAltScreen）判定。 */
export function fullscreenLazyTui(tui: any): boolean {
	return isLazyProxyTui(tui) && tui.mode === "fullscreen";
}

/** 关掉 pi 0.85 Jump to latest overlay，避免和本仓库 dock 按钮叠两层。 */
export function disableOfficialScrollToEnd(tui: any): void {
	if (!tui) return;
	const current = tui.scrollToEndIndicator;
	if (typeof current !== "function") return;
	// 原函数放 object 里，避免惰性 Proxy 对 function 属性再包一层。
	if (!tui[OFFICIAL_SCROLL_TO_END_KEY]) {
		tui[OFFICIAL_SCROLL_TO_END_KEY] = { original: current };
	}
	tui.scrollToEndIndicator = undefined;
}

/** /ccstyle off 或 teardown 时还回官方 overlay。 */
export function restoreOfficialScrollToEnd(tui: any): void {
	if (!tui) return;
	const original = tui[OFFICIAL_SCROLL_TO_END_KEY]?.original;
	if (typeof original === "function") tui.scrollToEndIndicator = original;
	tui[OFFICIAL_SCROLL_TO_END_KEY] = undefined;
}

/** dock 模式替换官方浮层；native 保留 Pi 原生浮层并换上 dock 文案；ccstyle off 还原 Pi 原样。 */
export function syncOfficialScrollToEnd(tui: any): void {
	if (!nativeScrollTextEnabled(tui)) restoreNativeScrollIndicatorText();
	if (dockScrollButtonActive()) {
		disableOfficialScrollToEnd(tui);
		return;
	}
	restoreOfficialScrollToEnd(tui);
	if (nativeScrollTextEnabled(tui)) {
		// 离开 dock 时清零一次；native 的后续渲染保留共享计数。
		if (getScrollButtonVisible()) setScrollButtonVisible(false);
		setScrollButtonHovered(false);
		syncNativeScrollIndicatorText(tui);
		return;
	}
	setScrollButtonVisible(false);
	setScrollButtonHovered(false);
}

/** 只记录文案补丁；dock 的显隐、快捷键和原生浮层开关仍走原路径。 */
let nativeScrollTextPatch: { renderer: any; original: () => string } | undefined;

function nativeScrollTextEnabled(tui: any): boolean {
	return (
		toolMouseInteractionActive() && config.scrollButtonMode === "native" && fullscreenLazyTui(tui)
	);
}

/** widget 销毁或离开 native 模式时还原 Pi 的原始回调。 */
export function restoreNativeScrollIndicatorText(): void {
	if (!nativeScrollTextPatch) return;
	const { renderer, original } = nativeScrollTextPatch;
	renderer.scrollToEndIndicator = original;
	nativeScrollTextPatch = undefined;
	scrollButtonState().newCount = 0;
}

function syncNativeScrollIndicatorText(tui: any): void {
	// Pi 的稳定 Proxy 会重绑捕获的方法；文案回调必须从真实 renderer 上取得。
	const renderer = tui.valueOf();
	if (nativeScrollTextPatch?.renderer !== renderer) restoreNativeScrollIndicatorText();
	if (!nativeScrollTextPatch) {
		const original = renderer.scrollToEndIndicator;
		if (typeof original !== "function") return;
		nativeScrollTextPatch = { renderer, original };
		renderer.scrollToEndIndicator = () =>
			original.call(renderer).replace("Jump to latest message", scrollButtonText());
	}
	if (isFullscreenAtBottom(renderer)) scrollButtonState().newCount = 0;
}

/** 官方 fullscreen：是否已跟随 transcript 底部（按钮隐藏条件）。 */
export function isFullscreenAtBottom(tui: any): boolean {
	const following = tui.isFollowingOutput ?? tui.getPrimaryScrollView?.()?.isFollowingEnd ?? true;
	return Boolean(following);
}

/** 与 Pi 原生浮层同源（keyDisplayText）：用户实际绑定，首字母大写，macOS 上 alt 显示为 option。 */
function scrollBottomShortcutText(): string {
	return getKeybindings()
		.getKeys(SCROLL_BOTTOM_KEYBINDING)
		.map((key) =>
			key
				.split("+")
				.map((part) => {
					const display =
						process.platform === "darwin" && part.toLowerCase() === "alt" ? "option" : part;
					return display.charAt(0).toUpperCase() + display.slice(1);
				})
				.join("+"),
		)
		.join("/");
}

function isScrollNavigationInput(data: string): boolean {
	if (
		matchesKey(data, "pageUp") ||
		matchesKey(data, "pageDown") ||
		ZENTUI_PAGE_UP_INPUT.test(data) ||
		ZENTUI_PAGE_DOWN_INPUT.test(data) ||
		// 官方 fullscreen viewport 的可滚动键（half-page/prompt/top/bottom）。
		[
			"tui.altScreen.pageUp",
			"tui.altScreen.pageDown",
			"tui.altScreen.halfPageUp",
			"tui.altScreen.halfPageDown",
			"tui.altScreen.previousPrompt",
			"tui.altScreen.nextPrompt",
			"tui.altScreen.top",
			"tui.altScreen.bottom",
		].some((key) => getKeybindings().matches(data, key as Keybinding))
	) {
		return true;
	}
	const packets = parseSgrMousePackets(data);
	return Boolean(
		packets?.some((packet) => {
			const baseButton = packet.code & ~(4 | 8 | 16 | 32);
			return packet.final === "M" && (baseButton === 64 || baseButton === 65);
		}),
	);
}

function isAtTranscriptBottom(tui: any): boolean {
	// 惰性 Proxy fullscreen：官方 viewport 以 isFollowingOutput 判定是否在底部。
	if (fullscreenLazyTui(tui)) return isFullscreenAtBottom(tui);
	return true;
}

export function hideScrollButton(tui: any): void {
	const changed = getScrollButtonVisible() || getScrollButtonHovered();
	setScrollButtonVisible(false);
	setScrollButtonHovered(false);
	if (changed) tui.requestRender?.();
}

export function scheduleScrollButtonSync(tui: any, data: string): void {
	if (
		!fullscreenLazyTui(tui) ||
		!dockScrollButtonActive() ||
		!isScrollNavigationInput(data) ||
		scrollButtonSyncScheduled
	)
		return;
	scrollButtonSyncScheduled = true;
	const previousLines = tui.previousLines;
	const check = (attempt: number) => {
		scrollButtonSyncScheduled = false;
		if (getToolMouseTui() !== tui || !dockScrollButtonActive()) return;
		// Pi renders on its own frame timer. Inspect the resulting viewport before
		// showing the button so empty or non-scrollable transcripts never flash it.
		const rendered = tui.previousLines !== previousLines;
		// fullscreen 下 isFollowingOutput 是即时状态，无需等待官方帧渲染。
		if (!rendered && attempt < 4 && !fullscreenLazyTui(tui)) {
			scrollButtonSyncScheduled = true;
			const timer = setTimeout(() => check(attempt + 1), 16);
			if (typeof timer === "object" && timer !== null && "unref" in timer) {
				(timer as { unref: () => void }).unref();
			}
			return;
		}
		const nextVisible = !isAtTranscriptBottom(tui);
		if (nextVisible !== getScrollButtonVisible()) {
			setScrollButtonVisible(nextVisible);
			tui.requestRender?.();
		}
	};
	process.nextTick(() => check(0));
}

export function updateScrollButtonFromInput(tui: any, data: string): void {
	if (!fullscreenLazyTui(tui) || !dockScrollButtonActive()) return;
	if (matchesKey(data, "enter") || matchesKey(data, "return")) hideScrollButton(tui);
}

/** 无新内容时提示原文案；有新内容时换成累计条数。 */
function scrollButtonText(): string {
	const count = getScrollButtonNewCount();
	if (count <= 0) return "Back to bottom";
	return `${count} new message${count === 1 ? "" : "s"}`;
}

export function renderScrollButton(width: number, theme: any): string[] {
	if (
		!dockScrollButtonActive() ||
		!getScrollButtonVisible() ||
		!fullscreenLazyTui(getToolMouseTui())
	)
		return [];
	// 未绑定时与 Pi 原生一样省略快捷键段。
	const shortcut = scrollBottomShortcutText();
	const label = theme.fg(
		getScrollButtonHovered() ? "text" : "accent",
		`[ ↓ ${scrollButtonText()}${shortcut ? ` · ${shortcut}` : ""} ]`,
	);
	const leftPad = Math.max(0, Math.floor((width - visibleWidth(label)) / 2));
	return [`${" ".repeat(leftPad)}${truncateToWidth(label, width, "…")}`];
}
