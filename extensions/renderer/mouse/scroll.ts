import { config } from "../../config/config.ts";
import { isLazyProxyTui } from "../../utils/fullscreen-detect.ts";
import {
	NATIVE_SCROLL_INDICATOR_PATCH,
	NATIVE_SCROLL_INDICATOR_YIELDED_RENDERERS,
	patchRegistry,
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

type IndicatorPatch = {
	renderer: any;
	original: (...args: any[]) => any;
	installed: (...args: any[]) => any;
	active: boolean;
	newCount: number;
};

export type NativeScrollIndicatorAdapter = {
	reconcile(tui: any): void;
	noteItem(): void;
	resetCount(): void;
	dispose(): void;
};

/** 仅替换已知原生文案；样式、快捷键、显隐、布局和点击仍由 Pi 决定。 */
export function installNativeScrollIndicator(): NativeScrollIndicatorAdapter {
	patchRegistry.get<NativeScrollIndicatorAdapter>(NATIVE_SCROLL_INDICATOR_PATCH)?.dispose();
	let active = true;
	let patch: IndicatorPatch | null = null;
	// 让渡记录跟随真实 renderer，避免 widget 重建或 /reload 后抢回其他扩展的回调。
	const yielded = patchRegistry.ensure(
		NATIVE_SCROLL_INDICATOR_YIELDED_RENDERERS,
		() => new WeakSet<object>(),
	);
	const enabled = () => toolMouseInteractionActive() && config.customScrollToEndIndicatorText;

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

	const adapter: NativeScrollIndicatorAdapter = {
		reconcile(tui) {
			if (!active) return;
			const renderer = concreteToolMouseTui(tui);
			if (patch && renderer !== patch.renderer) release();
			try {
				if (renderer?.mode !== "fullscreen") {
					release();
					return;
				}
				if (!enabled()) {
					if (patch && renderer.scrollToEndIndicator !== patch.installed) {
						// 外层包装器保持原位；关闭时透传，重新开启时复用已有调用链。
						yielded.add(renderer);
						adapter.resetCount();
					} else release();
					return;
				}
				if (patch && renderer.scrollToEndIndicator !== patch.installed) {
					// 允许外层扩展继续调用我们的活跃包装器，但不覆盖或重新包装它。
					yielded.add(renderer);
				}
				if (!patch) {
					if (yielded.has(renderer)) return;
					// 只接管可写的实例数据字段；旧版、禁用、只读或 accessor 接口均不修改。
					const descriptor = Object.getOwnPropertyDescriptor(renderer, "scrollToEndIndicator");
					if (!descriptor?.writable || typeof descriptor.value !== "function") return;
					const next: IndicatorPatch = {
						renderer,
						original: descriptor.value,
						active: true,
						newCount: 0,
						installed(this: any, ...args: any[]) {
							const nativeText = Reflect.apply(next.original, this, args);
							if (!next.active || !enabled() || typeof nativeText !== "string") return nativeText;
							const count = next.newCount;
							const label =
								count > 0 ? `${count} new message${count === 1 ? "" : "s"}` : "Back to bottom";
							// 空文案、ANSI-only 和未知文案原样保留，不猜测上游或其他扩展的格式。
							return nativeText.replace("Jump to latest message", label);
						},
					};
					renderer.scrollToEndIndicator = next.installed;
					patch = next;
				}
				// 原生在底部不会调用文案回调；渲染、输入和记账共用这条跟随状态同步路径。
				if (isFullscreenAtBottom(renderer)) adapter.resetCount();
			} catch {
				release();
			}
		},
		noteItem() {
			adapter.reconcile(getToolMouseTui());
			if (!active || !enabled() || !patch || isFullscreenAtBottom(patch.renderer)) return;
			patch.newCount += 1;
			patch.renderer.requestRender?.();
		},
		resetCount() {
			if (active && patch) patch.newCount = 0;
		},
		dispose() {
			active = false;
			release();
			patchRegistry.dispose(NATIVE_SCROLL_INDICATOR_PATCH, adapter);
		},
	};
	patchRegistry.install(NATIVE_SCROLL_INDICATOR_PATCH, adapter);
	return adapter;
}

/** 记账 transcript 项（消息及工具卡），不是流式 chunk 或工具结果。 */
export function noteNewTranscriptItem(): void {
	patchRegistry.get<NativeScrollIndicatorAdapter>(NATIVE_SCROLL_INDICATOR_PATCH)?.noteItem();
}

export function resetNativeScrollIndicatorCount(): void {
	patchRegistry.get<NativeScrollIndicatorAdapter>(NATIVE_SCROLL_INDICATOR_PATCH)?.resetCount();
}
