/**
 * 工具卡/分组卡首行是否在可视区内的共享标记。
 *
 * 帧捕获（mouse/interaction）在 regular 主屏每帧写入，动画层据此停掉看不见的
 * spinner：主屏上「可视区上方任意一行」的变化会让 pi-tui 升级为 fullRender(true)
 * （清屏 + 清 scrollback + 从第 0 行重画整个 transcript），在 Windows Terminal 上
 * 表现为历史丢失、视口/滚动条突然回到顶部。头部已在视口上方时 spinner 本就看不见。
 *
 * 标记挂在组件的 rendererState 上：pi 把同一个对象作为 render context 的 state
 * 传给 renderCall/renderResult，而动画层只拿得到 context。
 *
 * fullscreen 不看标记（alt-screen 不做帧捕获，也不会因为可视区上方的变化清
 * scrollback），否则运行时从 regular 切过去会沿用上一次的 stale 标记把 spinner 冻住。
 */
import { isLazyProxyTui } from "../../utils/fullscreen-detect.ts";
import { getToolMouseTui } from "../mouse/scroll.ts";
import { isToolTuiFullscreen } from "./show-more-hint.ts";

const HEADER_VISIBLE_KEY = "ccstyleHeaderVisible";

type VisibilityTarget = { rendererState?: Record<string, unknown> };
type VisibilityContext = { state?: Record<string, unknown> };

export function markHeaderVisibility(component: any, visible: boolean): void {
	const target = component as VisibilityTarget;
	const state = (target.rendererState ??= {});
	state[HEADER_VISIBLE_KEY] = visible;
}

/** 当前是否处于装了帧捕获的 regular 主屏。 */
function frameCaptureActive(): boolean {
	if (isToolTuiFullscreen()) return false;
	return !isLazyProxyTui(getToolMouseTui());
}

/** 未标注或不在帧捕获环境时按可见处理，行为与加标记前一致。 */
export function isHeaderVisible(component: any): boolean {
	if (!frameCaptureActive()) return true;
	return (component as VisibilityTarget)?.rendererState?.[HEADER_VISIBLE_KEY] !== false;
}

/** 动画上下文版本：context.state 与组件 rendererState 是同一个对象。 */
export function isAnimationContextVisible(context: any): boolean {
	if (!frameCaptureActive()) return true;
	return (context as VisibilityContext)?.state?.[HEADER_VISIBLE_KEY] !== false;
}
