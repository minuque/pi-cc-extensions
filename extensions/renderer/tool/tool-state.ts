import { getToolMouseTui } from "../mouse/scroll.ts";
import { TOOL_LOADING_INTERVAL_MS, toolLoadingIcon } from "../../utils/tool-loading-icon.ts";

const activeAnimationContexts = new Set<any>();
let sharedAnimationTimer: ReturnType<typeof setTimeout> | null = null;

function clearAnimation(context: any) {
	if (context?.state) context.state.ccstyleAnimationLight = false;
	if (!context?.state?.ccstyleAnimationScheduled) return;
	context.state.ccstyleAnimationScheduled = false;
	activeAnimationContexts.delete(context);
	if (activeAnimationContexts.size === 0 && sharedAnimationTimer) {
		clearTimeout(sharedAnimationTimer);
		sharedAnimationTimer = null;
	}
}

export function clearAllAnimations() {
	for (const ctx of activeAnimationContexts) {
		ctx.state.ccstyleAnimationScheduled = false;
		ctx.state.ccstyleAnimationLight = false;
	}
	activeAnimationContexts.clear();
	if (sharedAnimationTimer) {
		clearTimeout(sharedAnimationTimer);
		sharedAnimationTimer = null;
	}
}

export function scheduleAnimation(
	context: any,
	options: { light?: boolean; intervalMs?: number } = {},
) {
	const state = (context.state ??= {});
	// light：调用方自己在 render() 内重取 loading 帧，定时器只需请求重绘；
	// 否则定时器走 context.invalidate()（compact 摘要等靠它重建）。
	// 每次调用都按本次 options 写入，避免上次 light 残留后非 light 调用仍跳过 invalidate。
	state.ccstyleAnimationLight = Boolean(options.light);
	if (state.ccstyleAnimationScheduled) return;
	state.ccstyleAnimationScheduled = true;
	activeAnimationContexts.add(context);
	if (!sharedAnimationTimer) {
		sharedAnimationTimer = setTimeout(() => {
			sharedAnimationTimer = null;
			const contexts = Array.from(activeAnimationContexts);
			activeAnimationContexts.clear();
			const tui = getToolMouseTui();
			const canRequestRender = typeof tui?.requestRender === "function";
			let lightFrames = false;
			for (const ctx of contexts) {
				ctx.state.ccstyleAnimationScheduled = false;
				if (ctx.state.ccstyleAnimationLight && canRequestRender) lightFrames = true;
				else ctx.invalidate?.();
			}
			if (lightFrames) tui.requestRender();
		}, options.intervalMs ?? TOOL_LOADING_INTERVAL_MS);
	}
}

/**
 * 本回合流式消息里出现过的工具调用。Pi 要等整条 assistant 消息结束才派发执行，
 * 这段窗口工具行已经在等启动，spinner 该逐帧转。
 * 恢复或翻历史重建的旧行不在这个集合里，保持静止。
 */
const liveToolCalls = new Set<string>();

/** 收下当前流式 assistant 消息里的工具调用 id。 */
export function noteStreamingToolCalls(message: any): void {
	const content = Array.isArray(message?.content) ? message.content : [];
	for (const block of content) {
		const id = block?.type === "toolCall" ? block.id : undefined;
		if (typeof id === "string" && id) liveToolCalls.add(id);
	}
}

/** 工具收尾后移出等待窗口。 */
export function retireLiveToolCall(toolCallId: unknown): void {
	if (typeof toolCallId === "string") liveToolCalls.delete(toolCallId);
}

export function clearLiveToolCalls(): void {
	liveToolCalls.clear();
}

/** 工具行是否处于等待窗口（流式声明中或等待派发）。 */
export function isLiveToolCall(toolCallId: unknown): boolean {
	return typeof toolCallId === "string" && liveToolCalls.has(toolCallId);
}

export function pendingIcon(_name: string): string {
	return toolLoadingIcon();
}

type ToolVisualState = "pending" | "success" | "error";

export function settledIcon(name: string, state: ToolVisualState | undefined): string {
	if (state === "success") return "✓";
	if (state === "error") return "✗";
	// toolIcon(name) 曾恒返回 "●"，已内联；name 保留以稳定导出签名。
	return "●";
}

export function setToolVisualState(context: any, visualState: ToolVisualState) {
	const state = (context.state ??= {});
	if (visualState !== "pending") clearAnimation(context);
	if (state.ccstyleToolVisualState === visualState) return;
	state.ccstyleToolVisualState = visualState;
	// Do not invalidate synchronously from renderResult. Pi is already rendering
	// this tool row; recursively scheduling another render here can retain both
	// the finalized result component and its previous secondary/partial component,
	// which displays the result summary twice. The current render pass also
	// refreshes renderCall, so the settled icon still updates immediately.
}

function getToolVisualState(context: any): ToolVisualState | undefined {
	return context?.state?.ccstyleToolVisualState as ToolVisualState | undefined;
}

export function resolveToolVisualState(context: any): ToolVisualState | undefined {
	const visualState = getToolVisualState(context);
	if (visualState || context?.isPartial !== false) return visualState;
	const settledState: ToolVisualState = context?.isError ? "error" : "success";
	setToolVisualState(context, settledState);
	return settledState;
}

export function toolIconColor(context: any): "accent" | "error" | "success" | "muted" {
	const visualState = getToolVisualState(context);
	if (context?.isError || visualState === "error") return "error";
	if (visualState === "success") return "success";
	if (context?.isPartial || context?.executionStarted || visualState === "pending") return "accent";
	return "muted";
}

export function isToolExpanded(options: any, context: any): boolean {
	const local = context?.state?.ccstyleToolExpanded;
	return typeof local === "boolean" ? local : Boolean(options?.expanded ?? context?.expanded);
}
