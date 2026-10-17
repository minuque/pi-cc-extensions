import { getKeybindings, visibleWidth } from "@earendil-works/pi-tui";
import { config } from "../../config/config.ts";
import { isLazyProxyTui } from "../../utils/fullscreen-detect.ts";
import {
	NATIVE_SCROLL_INDICATOR_PATCH,
	NATIVE_SCROLL_INDICATOR_YIELDED_RENDERERS,
	patchRegistry,
	TOOL_MOUSE_OWNER_KEY,
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

/** Pi's stable proxy forwards methods, but not property descriptors. Never save its callbacks. */
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

/** Match Pi's keyDisplayText without importing its private component helpers. */
function bottomShortcut(): string {
	return getKeybindings()
		.getKeys("tui.altScreen.bottom")
		.join("/")
		.split("/")
		.map((key) =>
			key
				.split("+")
				.map((part) => {
					const text =
						process.platform === "darwin" && part.toLowerCase() === "alt" ? "option" : part;
					return text.charAt(0).toUpperCase() + text.slice(1);
				})
				.join("+"),
		)
		.join("/");
}

type IndicatorPatch = {
	renderer: any;
	descriptor: PropertyDescriptor;
	installed: (...args: any[]) => any;
	active: boolean;
	newCount: number;
};

export type NativeScrollIndicatorAdapter = {
	owner: object;
	reconcile(tui: any, renderer?: any): void;
	noteItem(): void;
	resetCount(): void;
	dispose(): void;
};

/**
 * Optional label-only enhancement. Pi still owns layout, clipping, visibility and input.
 * Each patch belongs to a concrete renderer, not the retargetable TUI reference.
 */
export function installNativeScrollIndicator(
	owner: object,
	getTheme: () => any,
): NativeScrollIndicatorAdapter {
	patchRegistry.get<NativeScrollIndicatorAdapter>(NATIVE_SCROLL_INDICATOR_PATCH)?.dispose();
	let patch: IndicatorPatch | null = null;
	// Relinquishment belongs to the renderer, surviving widget rebuilds and /reload.
	const yielded = patchRegistry.ensure(
		NATIVE_SCROLL_INDICATOR_YIELDED_RENDERERS,
		() => new WeakSet<object>(),
	);
	const enabled = () => toolMouseInteractionActive() && config.customScrollToEndIndicatorText;
	const current = () =>
		patchRegistry.owns(NATIVE_SCROLL_INDICATOR_PATCH, adapter) &&
		(!patchRegistry.get(TOOL_MOUSE_OWNER_KEY) || patchRegistry.owns(TOOL_MOUSE_OWNER_KEY, owner));

	function owns(p: IndicatorPatch): boolean {
		try {
			const d = Object.getOwnPropertyDescriptor(p.renderer, "scrollToEndIndicator");
			return Boolean(
				d &&
					d.value === p.installed &&
					d.writable === true &&
					d.configurable === p.descriptor.configurable &&
					d.enumerable === p.descriptor.enumerable,
			);
		} catch {
			return false;
		}
	}

	function release(): void {
		if (!patch) return;
		const previous = patch;
		patch = null;
		previous.active = false;
		previous.newCount = 0;
		if (!owns(previous)) {
			yielded.add(previous.renderer);
			return;
		}
		try {
			Object.defineProperty(previous.renderer, "scrollToEndIndicator", previous.descriptor);
		} catch {
			// Frozen/replaced interfaces must not break rendering or teardown.
			yielded.add(previous.renderer);
		}
	}

	const adapter: NativeScrollIndicatorAdapter = {
		owner,
		reconcile(tui, renderer = concreteToolMouseTui(tui)) {
			if (!current()) return;
			if (patch && (!enabled() || renderer !== patch.renderer || !owns(patch))) release();
			try {
				if (!enabled() || renderer?.mode !== "fullscreen") {
					release();
					return;
				}
				if (!patch) {
					if (yielded.has(renderer) || typeof renderer.scrollToEndIndicator !== "function") return;
					const descriptor = Object.getOwnPropertyDescriptor(renderer, "scrollToEndIndicator");
					if (!descriptor || !descriptor.writable || typeof descriptor.value !== "function") return;
					const original = descriptor.value;
					const next: IndicatorPatch = {
						renderer,
						descriptor,
						active: true,
						newCount: 0,
						installed(this: any, ...args: any[]) {
							const nativeText = Reflect.apply(original, this, args);
							// Foreign wrappers may retain us after replacement/disposal. Always delegate raw.
							if (next.active && !owns(next)) {
								next.active = false;
								yielded.add(renderer);
							}
							if (next.active && current() && enabled() && renderer.mode === "fullscreen") {
								try {
									// An empty (including ANSI-only) native label intentionally suppresses the indicator.
									if (typeof nativeText !== "string" || visibleWidth(nativeText) === 0)
										return nativeText;
									if (isFullscreenAtBottom(renderer)) next.newCount = 0;
									const count = next.newCount;
									const label =
										count > 0 ? `${count} new message${count === 1 ? "" : "s"}` : "Back to bottom";
									const shortcut = bottomShortcut();
									const theme = getTheme();
									return theme.bg(
										"selectedBg",
										theme.fg("text", ` ↓ ${label}${shortcut ? ` · ${shortcut}` : ""} `),
									);
								} catch {
									// Missing theme/keybinding capabilities: keep the host's label.
								}
							}
							return nativeText;
						},
					};
					Object.defineProperty(renderer, "scrollToEndIndicator", {
						...descriptor,
						value: next.installed,
					});
					patch = next;
				}
				// The native callback is NOT called at bottom. Observe follow on every widget render/input too.
				if (isFullscreenAtBottom(renderer)) patch.newCount = 0;
			} catch {
				release();
			}
		},
		noteItem() {
			adapter.reconcile(getToolMouseTui());
			if (!current() || !patch || !patch.active || isFullscreenAtBottom(patch.renderer)) return;
			patch.newCount += 1;
			patch.renderer.requestRender?.();
		},
		resetCount() {
			if (current() && patch) patch.newCount = 0;
		},
		dispose() {
			release();
			patchRegistry.dispose(NATIVE_SCROLL_INDICATOR_PATCH, adapter);
		},
	};
	patchRegistry.install(NATIVE_SCROLL_INDICATOR_PATCH, adapter);
	return adapter;
}

/** Count transcript items (messages and tool cards), not chunks or tool results. */
export function noteNewTranscriptItem(): void {
	patchRegistry.get<NativeScrollIndicatorAdapter>(NATIVE_SCROLL_INDICATOR_PATCH)?.noteItem();
}

export function resetNativeScrollIndicatorCount(): void {
	patchRegistry.get<NativeScrollIndicatorAdapter>(NATIVE_SCROLL_INDICATOR_PATCH)?.resetCount();
}
