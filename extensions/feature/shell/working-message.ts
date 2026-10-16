import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { formatDuration, formatTokenCount } from "../../utils/format.ts";
import {
	resetTokenRate,
	carryTokenRate,
	pauseTokenRate,
	resumeTokenRate,
	markFirstToken,
	sampleTokenDelta,
	recordProviderUsage,
	startMessageSegment,
	totalTokens,
} from "./token-rate.ts";

const REFRESH_INTERVAL_MS = 1_000;
/** Elapsed time is only shown once the turn has run this long. */
const SHOW_TIMER_AFTER_MS = 3_000;

type StreamMessage = {
	content?: unknown;
	usage?: { output?: unknown };
};

function outputUsage(message: StreamMessage): number {
	const value = Number(message?.usage?.output);
	return Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

type WorkingUi = {
	setWorkingMessage(message?: string): void;
};

/**
 * Extend Pi's footer working row while preserving its spinner and "Working...":
 * `⠋ Working... (↓ 1,234 tokens · 12s)`
 *
 * token 数直接读 token-rate 的累计（估算 → provider usage 同源），不再本地重数。 */
export default function (pi: ExtensionAPI): void {
	let turnActive = false;
	let agentStartTime = 0;
	let turnStartTime = 0;
	/** 当前用户指令的起点；工具调用后的 turn 复用它，直到下一条指令。 */
	let rateRunStartTime = 0;
	let refreshTimer: ReturnType<typeof setTimeout> | null = null;
	let lastMessage: string | null = null;
	let activeCtx: { ui: WorkingUi | undefined; hasUI: boolean } | null = null;

	function tokenCount(): number {
		return totalTokens();
	}

	function updateProviderUsage(message: StreamMessage, final = false): void {
		const output = outputUsage(message);
		if (output > 0) recordProviderUsage(output, Date.now(), final);
	}

	function buildWorkingMessage(): string {
		const parts: string[] = [];
		const tokens = tokenCount();
		if (tokens > 0) parts.push(`↓ ${formatTokenCount(tokens)} tokens`);
		const elapsed = Date.now() - (agentStartTime || turnStartTime);
		if (elapsed >= SHOW_TIMER_AFTER_MS || tokens > 0) {
			// formatDuration 低于 1 秒返回 ""，此处回退 "0s" 保持计时器连续跳动。
			parts.push(formatDuration(elapsed) || "0s");
		}
		return parts.length ? `Working... (${parts.join(" · ")})` : "";
	}

	function workingUiAvailable(): boolean {
		try {
			return activeCtx?.hasUI === true;
		} catch {
			// 会话替换/reload 后捕获的 ctx 失效，getter 抛错；停止驱动 footer。
			turnActive = false;
			activeCtx = null;
			stopRefreshLoop();
			return false;
		}
	}

	function restoreDefaultWorkingMessage(): void {
		lastMessage = null;
		if (!workingUiAvailable()) return;
		try {
			activeCtx?.ui?.setWorkingMessage();
		} catch {
			// Noop when the TUI is unavailable.
		}
	}

	function syncWorkingMessage(force = false): void {
		if (!workingUiAvailable()) return;
		const next = buildWorkingMessage();
		if (!next) {
			if (force) restoreDefaultWorkingMessage();
			return;
		}
		if (!force && next === lastMessage) return;
		lastMessage = next;
		try {
			activeCtx?.ui?.setWorkingMessage(next);
		} catch {
			// Noop when the TUI is unavailable.
		}
	}

	function scheduleRefreshTick(): void {
		if (!turnActive || refreshTimer) return;
		refreshTimer = setTimeout(() => {
			refreshTimer = null;
			try {
				syncWorkingMessage();
			} catch {
				// 定时器内的异常会成为 uncaughtException 终止 Pi；装饰性刷新直接停止。
				turnActive = false;
				return;
			}
			scheduleRefreshTick();
		}, REFRESH_INTERVAL_MS);
		refreshTimer.unref?.();
	}

	function stopRefreshLoop(): void {
		if (!refreshTimer) return;
		clearTimeout(refreshTimer);
		refreshTimer = null;
	}

	function clearDisplay(): void {
		stopRefreshLoop();
		agentStartTime = 0;
		turnStartTime = 0;
		// 不重置 token-rate：footer 定格显示上一回合速率
		restoreDefaultWorkingMessage();
	}

	pi.on("before_agent_start", async () => {
		if (!agentStartTime) agentStartTime = Date.now();
	});

	pi.on("turn_start", async (event, ctx) => {
		turnActive = true;
		activeCtx = ctx;
		// 事件时间戳在 handler 之前产生；用 Date.now() 会和紧随的采样落在同一毫秒，分母变成 0。
		turnStartTime = event?.timestamp || Date.now();
		if (!agentStartTime) agentStartTime = turnStartTime;
		// 工具调用后的 turn 属于同一条用户指令：计时、TTFT 与累计 token 保持到下一条指令。
		// 速率起点用本指令第一个 turn 的时间戳；before_agent_start 只当指令 id。
		if (rateRunStartTime !== agentStartTime) {
			rateRunStartTime = agentStartTime;
			resetTokenRate(turnStartTime);
		}
		startMessageSegment(turnStartTime);
		syncWorkingMessage(true);
		scheduleRefreshTick();
	});

	pi.on("message_update", async (event, ctx) => {
		activeCtx = ctx;
		const evt = event?.assistantMessageEvent;
		if (!evt) return;

		if (evt.type === "start") {
			// 新 assistant 消息起点：速率分段已在 turn_start 处理。
		} else if (
			evt.type === "thinking_start" ||
			evt.type === "text_start" ||
			evt.type === "toolcall_start"
		) {
			// TTFT 的首块含 toolcall_start：模型直接发起 tool call（thinking/text 省略）时也算首 token。
			// 分段锚点只在 turn_start 重置。这里再重置会把累计 usage.output 当成新的首报。
			markFirstToken();
			updateProviderUsage(evt.partial);
		} else if (
			evt.type === "thinking_delta" ||
			evt.type === "text_delta" ||
			evt.type === "toolcall_delta"
		) {
			// 工具参数走 toolcall_delta；不计入的话，写长文件这类调用期间 token 一直不涨。
			if (typeof evt.delta === "string") sampleTokenDelta(evt.delta);
			updateProviderUsage(evt.partial);
		} else if (evt.type === "text_end" || evt.type === "thinking_end") {
			updateProviderUsage(evt.partial);
		} else if (evt.type === "done") {
			// Pi 目前不会把 done/error 转成 message_update，定格在下面的 message_end 里做。
			// 这两个分支只在宿主直接转发 done/error 时生效；同一个值重复定格不改变结果。
			updateProviderUsage(evt.message, true);
		} else if (evt.type === "error") {
			updateProviderUsage(evt.error);
		} else {
			updateProviderUsage(evt.partial);
		}

		syncWorkingMessage();
		scheduleRefreshTick();
	});

	// message_delta 的累计 usage 只出现在 message_end 上，含未逐字流出的思考 token。
	// message_end 在工具执行和 turn_end 之前，先于 carryTokenRate 结转。
	pi.on("message_end", async (event, ctx) => {
		const message = event?.message;
		if (message?.role !== "assistant") return;
		activeCtx = ctx;
		// 出错/中断时 usage 可能还是 message_start 的占位值，只接受变大的值。
		const failed = message.stopReason === "error" || message.stopReason === "aborted";
		updateProviderUsage(message, !failed);
		syncWorkingMessage();
	});

	pi.on("tool_execution_start", async () => {
		pauseTokenRate();
	});

	pi.on("tool_execution_end", async () => {
		resumeTokenRate();
	});

	pi.on("turn_end", async (_event, ctx) => {
		turnActive = false;
		activeCtx = ctx;
		stopRefreshLoop();
		// 本段 token 结转进累计，下一段 turn 继续累加；此处不清速率。
		carryTokenRate();
		// No completion message: return immediately to Pi's default idle state.
		restoreDefaultWorkingMessage();
	});

	pi.on("agent_end", async () => {
		turnActive = false;
		clearDisplay();
	});

	pi.on("session_shutdown", async () => {
		turnActive = false;
		clearDisplay();
		activeCtx = null;
	});
}
