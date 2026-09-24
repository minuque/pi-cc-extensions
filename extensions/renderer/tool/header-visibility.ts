/**
 * 工具卡/分组卡首行是否在可视区内的共享标记。
 *
 * 帧捕获（mouse/interaction）每帧写入，动画层据此停掉看不见的 spinner：
 * 可视区上方任意一行的变化会让 pi-tui 升级为 fullRender(true)（清屏 + 清
 * scrollback + 从第 0 行重画整个 transcript），在 Windows Terminal 上表现为
 * 历史丢失、视口/滚动条突然回到顶部。头部已在视口上方时 spinner 本就看不见，
 * 停帧纯赚。
 *
 * 标记挂在组件的 rendererState 上：pi 把同一个对象作为 render context 的 state
 * 传给 renderCall/renderResult，而动画层只拿得到 context。
 */

const HEADER_VISIBLE_KEY = "ccstyleHeaderVisible";

type VisibilityTarget = { rendererState?: Record<string, unknown> };
type VisibilityContext = { state?: Record<string, unknown> };

export function markHeaderVisibility(component: any, visible: boolean): void {
	const target = component as VisibilityTarget;
	const state = (target.rendererState ??= {});
	state[HEADER_VISIBLE_KEY] = visible;
}

/** 未标注（无鼠标渲染层，例如 fullscreen）时按可见处理，行为与从前一致。 */
export function isHeaderVisible(component: any): boolean {
	return (component as VisibilityTarget)?.rendererState?.[HEADER_VISIBLE_KEY] !== false;
}

/** 动画上下文版本：context.state 与组件 rendererState 是同一个对象。 */
export function isAnimationContextVisible(context: any): boolean {
	return (context as VisibilityContext)?.state?.[HEADER_VISIBLE_KEY] !== false;
}
