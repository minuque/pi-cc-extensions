import { TuiMainScreen } from "@earendil-works/pi-tui";
import { MAIN_SCREEN_DO_RENDER_PATCH, patchRegistry } from "./patch-keys.ts";

/**
 * 官方 0.84+ 的 tui 引用是惰性 Proxy（createInteractiveTuiReference）：
 * 函数属性每次 get 都返回新包装，执行时才解析到当前实现。
 * 通过它捕获 doRender/render/handleInput 会解析到自身形成无限递归，
 * 因此检测到惰性 Proxy 时必须跳过所有"捕获后包装"类 patch。
 */
export function isLazyProxyTui(tui: any): boolean {
	if (!tui || typeof tui !== "object") return false;
	const probe = tui.requestRender;
	return typeof probe === "function" && probe !== tui.requestRender;
}

/** The actual screen mode, independent of whether the host exposes a lazy Proxy. */
export function isFullscreenTui(tui: unknown): boolean {
	if (tui === null || typeof tui !== "object") return false;
	try {
		return (tui as { mode?: unknown }).mode === "fullscreen";
	} catch {
		// A renderer-switching or disposed host reference is not an active screen.
		return false;
	}
}

type MainScreenDoRenderPatch = {
	active: boolean;
	original: (lines: string[]) => string[];
	installed: (lines: string[]) => string[];
};

/**
 * regular（TuiMainScreen）模式的 doRender 走差分绘制：一旦第一个变化行落在
 * previousViewportTop 之上（终端写不进 scrollback 的区域），只能
 * fullRender(true)——\x1b[2J\x1b[H\x1b[3J 清屏并清掉整段 scrollback。
 * compact 直播式回合的摘要行动画与流式正文渲染在回合工具卡/diff 面板上方；
 * diff 面板一落地把下方内容撑过屏高，之后每帧重绘都命中该分支：scrollback
 * 被反复清空，滚动条回弹、视口钉住，直到输出结束才恢复。
 *
 * 视口上方的行本就无法重写，只剩「清回滚重打」与「scrollback 保留旧文本」
 * 两条路。这里选后者：applyLineResets 是差分比较前最后一个拿到整帧的环节，
 * 把 previousLines 的视口上方前缀直接对齐新帧，差分只看到可写区域，照常增量
 * 绘制。代价仅是 scrollback 里那几行停留在最后一次实际写入的内容。
 */
export function installMainScreenDoRenderPatch(): void {
	const prototype = TuiMainScreen.prototype as any;
	if (typeof prototype?.applyLineResets !== "function") return;
	const previous = patchRegistry.get<MainScreenDoRenderPatch>(MAIN_SCREEN_DO_RENDER_PATCH);
	if (previous) previous.active = false;
	const original =
		previous && prototype.applyLineResets === previous.installed
			? previous.original
			: prototype.applyLineResets;
	const patch: MainScreenDoRenderPatch = {
		active: true,
		original,
		installed(this: any, lines: string[]) {
			const result = original.call(this, lines);
			if (!patch.active) return result;
			const prev = this.previousLines;
			if (!Array.isArray(prev)) return result;
			const top = Math.min(
				Math.max(0, Math.floor(Number(this.previousViewportTop) || 0)),
				result.length,
			);
			for (let i = 0; i < top; i++) prev[i] = result[i];
			return result;
		},
	};
	prototype.applyLineResets = patch.installed;
	patchRegistry.install(MAIN_SCREEN_DO_RENDER_PATCH, patch);
}
