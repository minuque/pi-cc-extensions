import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { config } from "../../config/config.ts";
import { isLazyProxyTui } from "../../utils/fullscreen-detect.ts";
import {
	NATIVE_SCROLL_INDICATOR_PATCH,
	NATIVE_SCROLL_INDICATOR_YIELDED_RENDERERS,
	patchRegistry,
	SCROLL_BUTTON_STATE_SLOT,
	TOOL_MOUSE_TUI_SLOT,
} from "../../utils/patch-keys.ts";

patchRegistry.ensure(TOOL_MOUSE_TUI_SLOT, () => null);
export function getToolMouseTui(): any {
	return patchRegistry.get(TOOL_MOUSE_TUI_SLOT);
}
export function setToolMouseTui(tui: any): void {
	patchRegistry.install(TOOL_MOUSE_TUI_SLOT, tui);
}

export function toolMouseInteractionActive(): boolean {
	return config.mode !== "off";
}

export function dockScrollButtonActive(): boolean {
	return toolMouseInteractionActive() && config.scrollButtonMode === "dock";
}

export function fullscreenLazyTui(tui: any): boolean {
	return isLazyProxyTui(tui) && tui.mode === "fullscreen";
}

/** 惰性 Proxy 不转发属性描述符，且捕获的方法会跨 renderer 重绑；补丁只持有真实实例。 */
export function concreteToolMouseTui(tui: any): any {
	try {
		if (!isLazyProxyTui(tui)) return tui;
		const renderer = tui.valueOf?.();
		return renderer && renderer !== tui && !isLazyProxyTui(renderer) ? renderer : null;
	} catch {
		return null;
	}
}

export function isFullscreenAtBottom(tui: any): boolean {
	return Boolean(tui.isFollowingOutput ?? tui.getPrimaryScrollView?.()?.isFollowingEnd ?? true);
}

function dockState(): { widget: any; hovered: boolean } {
	return patchRegistry.ensure(SCROLL_BUTTON_STATE_SLOT, () => ({ widget: null, hovered: false }));
}

export function getScrollButtonWidget(): any {
	return dockState().widget;
}
export function setScrollButtonWidget(widget: any): void {
	dockState().widget = widget;
}
export function setScrollButtonHovered(hovered: boolean): boolean {
	if (dockState().hovered === hovered) return false;
	dockState().hovered = hovered;
	return true;
}
export function getScrollButtonVisible(): boolean {
	return (
		patchRegistry.get<ScrollIndicatorController>(NATIVE_SCROLL_INDICATOR_PATCH)?.isDockVisible() ??
		false
	);
}
export function isScrollBottomInput(data: string): boolean {
	return matchesKey(data, "ctrl+end");
}

/** dock 与 native 共用的唯一文案生成器；样式、箭头和快捷键由各自 renderer 包装。 */
function scrollButtonText(newCount: number): string {
	return newCount > 0 ? `${newCount} new message${newCount === 1 ? "" : "s"}` : "Back to bottom";
}

type IndicatorPatch = {
	mode: "dock" | "custom";
	renderer: any;
	original: (...args: any[]) => any;
	installed: (...args: any[]) => any;
	active: boolean;
};

export type ScrollIndicatorController = {
	reconcile(tui: any): void;
	noteItem(): void;
	resetCount(): void;
	isDockVisible(): boolean;
	renderDock(width: number, theme: any): string[];
	dispose(): void;
};

/** dock 时让原生浮层让位；native 时仅替换文案，样式、快捷键、布局和点击仍由 Pi 决定。 */
export function installScrollIndicatorController(): ScrollIndicatorController {
	patchRegistry.get<ScrollIndicatorController>(NATIVE_SCROLL_INDICATOR_PATCH)?.dispose();
	let active = true;
	let patch: IndicatorPatch | null = null;
	let renderer: any = null;
	let newCount = 0;
	let dockVisible = false;
	let previousMode: "dock" | "custom" | undefined;
	// 让渡记录跟随真实 renderer，避免 widget 重建或 /reload 后抢回其他扩展的回调。
	const yielded = patchRegistry.ensure(
		NATIVE_SCROLL_INDICATOR_YIELDED_RENDERERS,
		() => new WeakSet<object>(),
	);
	const indicatorMode = (): "dock" | "custom" | undefined => {
		if (dockScrollButtonActive()) return "dock";
		if (
			toolMouseInteractionActive() &&
			config.scrollButtonMode === "native" &&
			config.customNativeScrollToEndIndicatorText
		)
			return "custom";
		return undefined;
	};

	function release(): void {
		if (!patch) return;
		const previous = patch;
		patch = null;
		previous.active = false;
		try {
			if (previous.renderer.scrollToEndIndicator === previous.installed) {
				previous.renderer.scrollToEndIndicator = previous.original;
			} else yielded.add(previous.renderer);
		} catch {
			// 后来被冻结的实例无法还原；留下的包装器已停用，只透传原生文案。
		}
	}

	const adapter: ScrollIndicatorController = {
		reconcile(tui) {
			if (!active) return;
			const nextRenderer = concreteToolMouseTui(tui);
			const mode = indicatorMode();
			if (nextRenderer !== renderer || mode !== previousMode) {
				adapter.resetCount();
				setScrollButtonHovered(false);
			}
			renderer = nextRenderer;
			previousMode = mode;
			// dock 的临时抑制必须先还原，native 再按让渡记录决定是否定制文案。
			if (patch && (renderer !== patch.renderer || (patch.mode === "dock" && mode !== "dock")))
				release();
			try {
				dockVisible =
					mode === "dock" && renderer?.mode === "fullscreen" && !isFullscreenAtBottom(renderer);
				if (!dockVisible) setScrollButtonHovered(false);
				if (renderer?.mode !== "fullscreen") {
					release();
					return;
				}
				// 渲染、输入和记账共用跟随状态同步；不依赖浮层回调（底部不会调用它）。
				if (isFullscreenAtBottom(renderer)) adapter.resetCount();
				if (!mode) {
					if (patch && renderer.scrollToEndIndicator !== patch.installed) {
						// 外层包装器保持原位；关闭时透传，重新开启时复用已有调用链。
						yielded.add(renderer);
					} else release();
					return;
				}
				if (patch && renderer.scrollToEndIndicator !== patch.installed) {
					// native 文案让渡外层包装器；dock 必须抑制当前整层浮层（外层可能不透传）。
					yielded.add(renderer);
					if (mode === "dock") release();
				}
				if (!patch) {
					// native 文案不抢回其他扩展的回调；dock 则需临时抑制整层原生浮层，
					// 保存当前回调并在离开 dock / dispose 时原样还回，不能同时画两个按钮。
					if (mode === "custom" && yielded.has(renderer)) return;
					// 只接管可写的实例数据字段；旧版、禁用、只读或 accessor 接口均不修改。
					const descriptor = Object.getOwnPropertyDescriptor(renderer, "scrollToEndIndicator");
					if (!descriptor?.writable || typeof descriptor.value !== "function") return;
					const next: IndicatorPatch = {
						mode,
						renderer,
						original: descriptor.value,
						active: true,
						installed(this: any, ...args: any[]) {
							const currentMode = next.active ? indicatorMode() : undefined;
							if (currentMode === "dock") return "";
							const nativeText = Reflect.apply(next.original, this, args);
							if (!next.active || currentMode !== "custom" || typeof nativeText !== "string")
								return nativeText;
							// 空文案、ANSI-only 和未知文案原样保留，不猜测上游或其他扩展的格式。
							return nativeText.replace("Jump to latest message", scrollButtonText(newCount));
						},
					};
					renderer.scrollToEndIndicator = next.installed;
					patch = next;
				}
			} catch {
				dockVisible = false;
				release();
			}
		},
		noteItem() {
			adapter.reconcile(getToolMouseTui());
			if (
				!active ||
				!indicatorMode() ||
				renderer?.mode !== "fullscreen" ||
				isFullscreenAtBottom(renderer)
			)
				return;
			if (!dockVisible && !patch) return;
			newCount += 1;
			renderer.requestRender?.();
		},
		resetCount() {
			if (active) newCount = 0;
		},
		isDockVisible() {
			return active && dockScrollButtonActive() && dockVisible;
		},
		renderDock(width, theme) {
			if (!adapter.isDockVisible()) return [];
			const label = theme.fg(
				dockState().hovered ? "text" : "accent",
				`[ ↓ ${scrollButtonText(newCount)} · Ctrl+End ]`,
			);
			const leftPad = Math.max(0, Math.floor((width - visibleWidth(label)) / 2));
			return [`${" ".repeat(leftPad)}${truncateToWidth(label, width, "…")}`];
		},
		dispose() {
			active = false;
			dockVisible = false;
			release();
			patchRegistry.dispose(NATIVE_SCROLL_INDICATOR_PATCH, adapter);
		},
	};
	patchRegistry.install(NATIVE_SCROLL_INDICATOR_PATCH, adapter);
	return adapter;
}

/** 记账 transcript 项（消息及工具卡），不是流式 chunk 或工具结果。 */
export function noteNewTranscriptItem(): void {
	patchRegistry.get<ScrollIndicatorController>(NATIVE_SCROLL_INDICATOR_PATCH)?.noteItem();
}

export function resetScrollIndicatorCount(): void {
	patchRegistry.get<ScrollIndicatorController>(NATIVE_SCROLL_INDICATOR_PATCH)?.resetCount();
}
