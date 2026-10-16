/**
 * footer 输出速率的共享状态：working-message 负责采集，footer 负责显示。
 *
 * average：一次用户指令的墙钟平均（工具等待计入分母），显示 `avg`。
 * live：最近 1 秒的瞬时速率，生成期暂停时钟，显示 `live`；指令结束定格为整段平均。
 * token 与 working-message 同源：变大的 provider `usage.output` 覆盖估算，否则按 delta 累加
 * （CJK 1 token，其余 chars/4）。没有变大的 usage 不当作累计值：Anthropic 的 message_start
 * 会给出一个很小的 output_tokens，并在每个 partial 上重复，直到最后的 message_delta。
 * 消息结束时用 message_end 上的 usage 定格本段总量。
 * Pi 的 turn 是单次 assistant 消息，工具调用结束会开新 turn。token 跨 turn 累加，
 * 计时与 TTFT 直到下一条用户指令才重置。
 * TTFT：用户指令开始到第一个内容块（text/thinking/toolcall）开始的毫秒数，
 * 同一指令内只记第一次，定格后保留到下一条指令覆盖。
 */

export type TokenRateMode = "average" | "live";

const LIVE_WINDOW_MS = 1_000;
const MIN_SPAN_MS = 250;
const CJK_CHARS =
	/[\u3000-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef]/g;

interface TokenSample {
	t: number;
	cum: number;
}

let runStartTime = 0;
let carriedTokens = 0;
let currentTokens = 0;
let pauseStartedAt = 0;
/** 并行工具调用数；>0 时瞬时采样暂停。 */
let activeTools = 0;
let lastRate = 0;
let lastLiveRate = 0;
let firstTokenAt = 0;
let samples: TokenSample[] = [];
let usageAnchorTime = 0;
let usageAnchorTokens = 0;
let countedUsage = 0;

/** 新的用户指令：重置计时、累计 token、定格值与 TTFT。 */
export function resetTokenRate(startAt = 0): void {
	runStartTime = startAt;
	carriedTokens = 0;
	currentTokens = 0;
	pauseStartedAt = 0;
	activeTools = 0;
	lastRate = 0;
	lastLiveRate = 0;
	firstTokenAt = 0;
	samples = [];
	usageAnchorTime = 0;
	usageAnchorTokens = 0;
	countedUsage = 0;
}

/**
 * 一段 assistant 回复结束：保留计时与 TTFT，把本段已计 token 结算进累计。
 * 下一段的 token 从 0 重计，采样时加回来。
 */
export function carryTokenRate(): void {
	if (currentTokens > 0) carriedTokens += currentTokens;
	currentTokens = 0;
	countedUsage = 0;
}

/** 工具开始执行：计数 +1，第一个工具才真正暂停瞬时采样。 */
export function pauseTokenRate(now = Date.now()): void {
	if (!runStartTime) return;
	activeTools += 1;
	if (activeTools === 1 && !pauseStartedAt) pauseStartedAt = now;
}

/** 工具执行结束：计数 -1，最后一个工具结束才恢复采样。 */
export function resumeTokenRate(): void {
	activeTools = Math.max(0, activeTools - 1);
	if (activeTools === 0 && pauseStartedAt) {
		pauseStartedAt = 0;
	}
}

/** 本指令第一个内容块开始时调用；同一指令后续消息不覆盖。 */
export function markFirstToken(now = Date.now()): void {
	if (runStartTime && !firstTokenAt) firstTokenAt = now;
}

function estimateTokens(text: string): number {
	if (!text) return 0;
	const cjk = text.match(CJK_CHARS)?.length ?? 0;
	return Math.ceil(cjk + (text.length - cjk) / 4);
}

function pushSample(time: number, cum: number): void {
	samples.push({ t: time, cum });
	const cutoff = time - LIVE_WINDOW_MS;
	while (samples.length > 1 && samples[0]!.t < cutoff) samples.shift();
}

function updateRates(now: number): void {
	const total = carriedTokens + currentTokens;
	const elapsed = (now - runStartTime) / 1000;
	if (elapsed > 0) lastRate = total / elapsed;
	if (samples.length < 2) return;
	const first = samples[0]!;
	const last = samples[samples.length - 1]!;
	const span = last.t - first.t;
	if (span >= MIN_SPAN_MS) {
		lastLiveRate = ((last.cum - first.cum) * 1000) / span;
	}
}

/** 每个文本增量采样一次。工具暂停期的增量只累计 token，不进窗口。 */
export function sampleTokenDelta(delta: string, now = Date.now()): void {
	if (!runStartTime) return;
	const added = estimateTokens(delta);
	if (added <= 0) return;
	currentTokens += added;
	if (pauseStartedAt) return;
	pushSample(now, carriedTokens + currentTokens);
	updateRates(now);
}

/**
 * 记录本段 provider `usage.output`。变大的 usage 按锚点摊回窗口：
 * 首次报告从消息起点铺到现在，之后每次把增量摊在上次报告之后。
 * 没有变大的报告直接忽略，避免 message_start 的占位值反复覆盖 delta 累计。
 * `final` 用于消息结束：以本次 output 为本段总量，估算偏高偏低都按它修正。
 * 结束值含未逐字流出的思考 token，它们不属于最近一秒，所以窗口只整体平移，不回填。
 */
export function recordProviderUsage(output: number, now = Date.now(), final = false): void {
	if (!runStartTime || output <= 0) return;
	if (final) {
		const shift = output - currentTokens;
		for (const sample of samples) sample.cum += shift;
		countedUsage = output;
		currentTokens = output;
		usageAnchorTime = now;
		usageAnchorTokens = output;
		updateRates(now);
		return;
	}
	if (output <= countedUsage) return;
	const firstReport = countedUsage === 0;
	const jump = output - countedUsage;
	countedUsage = output;
	// 变大的 provider 计数是权威值，覆盖本段估算。
	currentTokens = output;
	if (firstReport) {
		samples = samples.filter((sample) => sample.t < usageAnchorTime);
		pushSample(usageAnchorTime, carriedTokens + usageAnchorTokens);
	}
	const span = Math.max(now - usageAnchorTime, 1);
	const count = Math.min(Math.max(Math.ceil(jump / 16), 1), 32);
	const base = firstReport
		? carriedTokens + usageAnchorTokens
		: carriedTokens + currentTokens - jump;
	for (let i = 1; i <= count; i++) {
		pushSample(usageAnchorTime + (span * i) / count, base + (jump * i) / count);
	}
	usageAnchorTime = now;
	usageAnchorTokens = currentTokens;
	updateRates(now);
}

/** 本段消息开始：重置 provider 锚点。 */
export function startMessageSegment(now = Date.now()): void {
	if (!runStartTime) return;
	usageAnchorTime = now;
	usageAnchorTokens = currentTokens;
	countedUsage = 0;
}

/** 整段指令的累计 token 数：已结转段 + 当前段。 */
export function totalTokens(): number {
	return carriedTokens + currentTokens;
}

/** average 的当前值：指令中为实时平均，指令外为上一段定格值。 */
export function currentTokenRate(): number {
	return lastRate;
}

/**
 * 按显示模式取值。live 在生成中取窗口速率，窗口数据不足或指令结束后回到整段平均。
 * 工具暂停期间时钟不动，显示上一条窗口值。
 */
export function displayTokenRate(mode: TokenRateMode): number {
	if (mode === "live" && samples.length >= 2 && lastLiveRate > 0) {
		return lastLiveRate;
	}
	return lastRate;
}

/** 本指令 TTFT（毫秒）；未出首 token 或无活动指令返回 0。定格后保留。 */
export function currentTtftMs(): number {
	if (!runStartTime || !firstTokenAt) return 0;
	return Math.max(0, firstTokenAt - runStartTime);
}

/** 不足 1 秒用毫秒，否则用一位小数的秒。 */
export function formatTtft(ttftMs: number): string {
	if (ttftMs < 1000) return `${Math.round(ttftMs)}ms`;
	return `${(ttftMs / 1000).toFixed(1)}s`;
}

/** `avg 1.2k tok/s (TTFT: 812ms)`；无数据显示空串，未出首 token 或 showTtft 为 false 时无括号段。 */
export function formatTokenRate(
	rate: number,
	ttftMs = 0,
	mode: TokenRateMode = "average",
	showTtft = true,
): string {
	if (!Number.isFinite(rate) || rate <= 0) return "";
	const value = rate >= 1000 ? `${(rate / 1000).toFixed(1)}k` : `${Math.round(rate)}`;
	const ttft =
		showTtft && Number.isFinite(ttftMs) && ttftMs > 0 ? ` (TTFT: ${formatTtft(ttftMs)})` : "";
	const label = mode === "live" ? "live" : "avg";
	return `${label} ${value} tok/s${ttft}`;
}
