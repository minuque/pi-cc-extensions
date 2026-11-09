/**
 * 自定义底栏：chips + zentui 图标/句子
 *
 * 默认第一行：model  thinking · ██████░░░░ 45%/200k · 󰆼 42% · $0.01 · pi-usage · 其余 line1 芯片
 * 默认第二行：cwd in session ·  branch (+16 −1) · 其余 line2 芯片
 * 第三行：仅当 line3 有可见芯片时出现
 * model / context / cache / rate / cost / tokens / cwd / git 与插件芯片同一套排布，可换行、调序、隐藏
 *
 *  - line1 短芯片，· 分隔；缓存用 zentui 󰆼，费用 success
 *  - line2 用 zentui 句式 in / on + 
 *  - 当前模型用量：优先 pi-usage 的 usage 状态；xAI 等不写 statusline 的供应商由本扩展补拉
 *
 * 模型/计费/思考级别变化时自动更新（pi.on 全局事件 + render 实时计算）
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { config, type FooterContextLimit } from "../../config/config.ts";
import { stripAnsi } from "../../utils/ansi-text.ts";
import { formatFooterCost } from "./footer-currency.ts";
import { formatTokenCount } from "../../utils/format.ts";
import {
	FOOTER_CACHE_KEY,
	FOOTER_CONTEXT_KEY,
	FOOTER_COST_KEY,
	FOOTER_CWD_KEY,
	FOOTER_GIT_KEY,
	FOOTER_MODEL_KEY,
	FOOTER_RATE_KEY,
	FOOTER_TOKENS_KEY,
	PI_USAGE_KEY,
	isBuiltinFooterKey,
	isSkippedFooterStatusKey,
	resolveFooterChipLayout,
	visibleFooterPluginTexts,
	type FooterChipLayout,
} from "./footer-layout.ts";
import { createGitStatsRefresher, readGitStats, type GitStats } from "./git-stats.ts";
import { formatSessionTokenTotal, sessionEntryTokens } from "./session-tokens.ts";
import { MCP_STATUS_KEY, buildMcpChip } from "./mcp-chip.ts";
import { inputTextIndent } from "./prompt-editor.ts";
import { currentTtftMs, displayTokenRate, formatTokenRate } from "./token-rate.ts";

export { parseGitStats } from "./git-stats.ts";

// Pi's built-in compaction.reserveTokens default (pi-coding-agent settings defaults).
const PI_DEFAULT_COMPACTION_RESERVE_TOKENS = 16_384;
/** How long a cached compaction limit is reused before settings are read again. */
export const COMPACTION_LIMIT_REFRESH_MS = 30_000;

type CompactionSettingsView = {
	compaction?: {
		enabled?: unknown;
		reserveTokens?: unknown;
		modelOverrides?: Record<string, unknown>;
	};
};

type ModelRef = { provider?: string; id?: string } | undefined;

/** A reserve value Pi accepts: a non-negative safe integer; anything else is ignored. */
function validReserveTokens(value: unknown): number | undefined {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/**
 * Token count at which Pi auto-compacts: it compacts once context tokens exceed
 * contextWindow − reserveTokens, resolving reserveTokens as model override, then
 * compaction.reserveTokens, then Pi's default. Undefined when auto-compaction is
 * off or the window is unknown or not larger than the reserve.
 *
 * Mirrors Pi's SettingsManager.getCompactionSettings and shouldCompact, which
 * extensions cannot call; update this copy when those change. Where Pi throws on
 * an invalid reserve value, this skips it and falls through to the next level.
 */
export function compactionLimitTokens(
	contextWindow: number,
	settings: CompactionSettingsView | undefined,
	model: ModelRef,
): number | undefined {
	const compaction = settings?.compaction;
	if (!(compaction?.enabled ?? true) || !(contextWindow > 0)) return undefined;
	const override = model
		? compaction?.modelOverrides?.[`${model.provider}/${model.id}`]
		: undefined;
	const overrideReserve =
		typeof override === "object" && override !== null
			? validReserveTokens((override as { reserveTokens?: unknown }).reserveTokens)
			: undefined;
	const reserve =
		overrideReserve ??
		validReserveTokens(compaction?.reserveTokens) ??
		PI_DEFAULT_COMPACTION_RESERVE_TOKENS;
	const limit = contextWindow - reserve;
	return limit > 0 ? limit : undefined;
}

/**
 * Caches compactionLimitTokens per model (provider/id) and context window, so a footer
 * render does not read settings each frame (Pi's getSettings deep-copies them). The
 * limit is recomputed when the model or window changes, or after
 * COMPACTION_LIMIT_REFRESH_MS, which picks up settings edits.
 */
export function createCompactionLimitCache(
	readSettings: () => CompactionSettingsView | undefined,
	now: () => number = Date.now,
): (contextWindow: number, model: ModelRef) => number | undefined {
	let cached: { key: string; limit: number | undefined; readAt: number } | undefined;
	return (contextWindow, model) => {
		const key = `${model?.provider}/${model?.id}@${contextWindow}`;
		const time = now();
		if (cached?.key !== key || time - cached.readAt >= COMPACTION_LIMIT_REFRESH_MS) {
			cached = {
				key,
				limit: compactionLimitTokens(contextWindow, readSettings(), model),
				readAt: time,
			};
		}
		return cached.limit;
	};
}

/**
 * Percent and denominator label of the context chip. "window" keeps Pi's figures;
 * "compaction" measures against the compaction point; "both" also shows the window in
 * brackets. Without a compaction point every mode falls back to the window.
 */
export function contextChipFigures(
	usage: { tokens: number | null; contextWindow: number; percent: number | null },
	compactionLimit: number | undefined,
	mode: FooterContextLimit,
): { percent: number | null; limitLabel: string } {
	const windowLabel = formatTokenCount(usage.contextWindow);
	if (mode === "window" || compactionLimit === undefined) {
		return { percent: usage.percent, limitLabel: windowLabel };
	}
	const percent = usage.tokens === null ? null : (usage.tokens * 100) / compactionLimit;
	const compactionLabel = formatTokenCount(compactionLimit);
	return {
		percent,
		limitLabel: mode === "both" ? `${compactionLabel} (${windowLabel})` : compactionLabel,
	};
}

const GIT_REFRESH_INTERVAL_MS = 10_000;
const USAGE_REFRESH_INTERVAL_MS = 5 * 60 * 1000;
// 后台连接 MCP 服务器不会触发 footer 重绘，靠这个兜底轮询把芯片刷出来
const MCP_REFRESH_INTERVAL_MS = 5_000;
const USAGE_TIMEOUT_MS = 15_000;
// zentui NERD_DEFAULT_ICONS：git / cacheHit。无 Nerd Font 时留空，只保留文字。
export const FOOTER_NERD_ICON_GIT = "";
export const FOOTER_NERD_ICON_CACHE = "󰆼";

// md power-plug：MCP 服务器连接数
export const FOOTER_NERD_ICON_MCP = "\u{f06a5}";

export function footerGlyphs(nerdIcons: boolean): { git: string; cache: string; mcp: string } {
	return nerdIcons
		? { git: FOOTER_NERD_ICON_GIT, cache: FOOTER_NERD_ICON_CACHE, mcp: FOOTER_NERD_ICON_MCP }
		: { git: "", cache: "", mcp: "" };
}

/**
 * 思考等级的填充圆标：等级越高填得越满。
 * 全部取自同一圆径的几何圆，避开占位虚线圆和偏小的半圆。
 */
const EFFORT_SYMBOL: Record<string, string> = {
	minimal: "\u25cb",
	low: "\u25ce",
	medium: "\u25d4",
	high: "\u25d5",
	xhigh: "\u25c9",
	max: "\u25cf",
};

/** 模型名后直接接圆标和等级，中间不用分隔点。 */
export function modelChip(
	theme: { fg: (color: string, text: string) => string },
	modelLabel: string,
	level: string,
	thinkingColor: (text: string) => string,
): string {
	const symbol = EFFORT_SYMBOL[level];
	if (!symbol) return theme.fg("accent", modelLabel);
	return `${theme.fg("accent", modelLabel)} ${thinkingColor(`${symbol} ${level}`)}`;
}

/** git 状态符号按职能分色：冲突/落后 error，修改 warning，未跟踪 muted，领先 success。 */
export function colorGitStatus(
	theme: { fg: (color: string, text: string) => string },
	status: string,
): string {
	let out = "";
	let color = "dim";
	for (const ch of status) {
		if (ch === "=" || ch === "\u21e3") color = "error";
		else if (ch === "!") color = "warning";
		else if (ch === "?") color = "muted";
		else if (ch === "\u21e1") color = "success";
		else if (!/[0-9]/.test(ch)) color = "dim";
		out += theme.fg(color, ch);
	}
	return out;
}

type XaiFooterReport = {
	buckets?: Array<{
		id?: string;
		unit?: string;
		used?: number;
		limit?: number;
		remaining?: number;
	}>;
	metrics?: Array<{ id?: string; value?: unknown }>;
};

export function formatXaiFooterChip(report: XaiFooterReport): string | undefined {
	const included = report.buckets?.find((b) => b.id === "included-allowance");
	if (included?.unit === "percent" && typeof included.used === "number") {
		return `xAI ${Math.round(included.used)}%`;
	}
	if (included && included.unit !== "percent") {
		if (
			typeof included.used === "number" &&
			typeof included.limit === "number" &&
			included.limit > 0
		) {
			return `xAI ${Math.round((included.used / included.limit) * 100)}%`;
		}
		if (typeof included.remaining === "number") {
			return `xAI $${included.remaining.toFixed(2)}`;
		}
		if (typeof included.used === "number") {
			return `xAI $${included.used.toFixed(2)}`;
		}
	}
	const prepaid = report.metrics?.find((m) => m.id === "prepaid-balance");
	if (typeof prepaid?.value === "number") {
		return `xAI $${prepaid.value.toFixed(2)}`;
	}
	return undefined;
}

const cachedExtensionStatuses = new Map<string, string>();
let cachedLocalUsageText = "";
/** 本包推算的内置 MCP 芯片（含 nerd 图标）；空字符串表示不显示。 */
let cachedMcpChip = "";

/** 别的扩展（pi-mcp-adapter）自己写了 mcp 状态时不画，避免两个芯片。 */
function ownMcpChip(): string {
	return cachedMcpChip && !cachedExtensionStatuses.has(MCP_STATUS_KEY) ? cachedMcpChip : "";
}

/** 面板用：当前 setStatus 文案 + 本包 pi-usage / MCP（无文案时为空字符串）。内置项由配置保证在列表里。 */
export function getFooterStatusSnapshot(): Map<string, string> {
	const out = new Map<string, string>();
	for (const [key, text] of cachedExtensionStatuses) {
		if (isSkippedFooterStatusKey(key) || isBuiltinFooterKey(key)) continue;
		out.set(key, text);
	}
	out.set(PI_USAGE_KEY, cachedLocalUsageText);
	const mcpChip = ownMcpChip();
	if (mcpChip) out.set(MCP_STATUS_KEY, mcpChip);
	return out;
}

function rememberExtensionStatuses(entries: Iterable<[string, string]>): void {
	cachedExtensionStatuses.clear();
	for (const [key, raw] of entries) {
		if (isSkippedFooterStatusKey(key)) continue;
		const text = stripAnsi(raw.replace(/[\r\n\t]+/g, " ").trim());
		if (text) cachedExtensionStatuses.set(key, text);
	}
}

function pluginTextsForRender(localUsageChip: string): Map<string, string> {
	cachedLocalUsageText = stripAnsi(localUsageChip.replace(/[\r\n\t]+/g, " ").trim());
	const texts = new Map<string, string>(cachedExtensionStatuses);
	if (cachedLocalUsageText) texts.set(PI_USAGE_KEY, cachedLocalUsageText);
	else texts.delete(PI_USAGE_KEY);
	return texts;
}

function layoutFromConfig(): FooterChipLayout {
	return {
		footerHiddenKeys: config.footerHiddenKeys,
		footerLine1Keys: config.footerLine1Keys,
		footerLine2Keys: config.footerLine2Keys,
		footerLine3Keys: config.footerLine3Keys,
	};
}

let piUsageMod: any | null | undefined;

function piUsageImportSpecs(): string[] {
	const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
	const dist = join(agentDir, "npm", "node_modules", "@narumitw", "pi-usage", "dist", "index.ts");
	const specs: string[] = [];
	if (existsSync(dist)) specs.push(pathToFileURL(dist).href);
	specs.push("@narumitw/pi-usage");
	return specs;
}

async function getPiUsage(): Promise<any | null> {
	if (piUsageMod !== undefined) return piUsageMod;
	for (const spec of piUsageImportSpecs()) {
		try {
			piUsageMod = await import(spec);
			return piUsageMod;
		} catch {
			// 下一候选：本机 Pi npm 目录，或包名（与本包同 node_modules 时）
		}
	}
	piUsageMod = null;
	return piUsageMod;
}

function colorUsageChip(theme: any, text: string): string {
	return theme.fg("dim", stripAnsi(text));
}

let currentTui: any = undefined;
let refreshCurrentGitStats: ((reset?: boolean) => void) | undefined;

/** Apply a /ccstyle Git mode change immediately, without recreating the footer. */
export function refreshFooterGitStats(): void {
	refreshCurrentGitStats?.(true);
}
let refreshCurrentUsage: (() => void) | undefined;
let refreshCurrentMcpChip: (() => void) | undefined;
/** 工具/命令列表在 pi API 上，而 footer 工厂只拿得到 ctx，加载时记下来。 */
let extensionApi: Pick<ExtensionAPI, "getAllTools" | "getCommands" | "getSettings"> | undefined;
const cachedCompactionLimit = createCompactionLimitCache(() => extensionApi?.getSettings?.());

const createCustomFooterFactory =
	(ctx: ExtensionContext) => (tui: any, theme: any, footerData: any) => {
		currentTui = tui;
		const sep = theme.fg("muted", " · ");
		const joinChips = (parts: string[]) => parts.filter(Boolean).join(sep);
		let gitStats: GitStats | undefined;
		let localUsageChip = "";
		let usageGeneration = 0;
		let usageAbort: AbortController | undefined;
		let disposed = false;

		// 查询在 render 外执行；模式/分支变化清旧值，普通轮询只在统计变化时重绘。
		const gitRefresher = createGitStatsRefresher({
			getMode: () => config.footerGitStatsMode,
			query: (mode, signal) => readGitStats(ctx.cwd, mode, signal),
			onChange: (next) => {
				gitStats = next;
				tui.requestRender();
			},
		});
		refreshCurrentGitStats = gitRefresher.refresh;
		gitRefresher.refresh();
		const gitRefreshTimer = setInterval(() => gitRefresher.refresh(), GIT_REFRESH_INTERVAL_MS);
		gitRefreshTimer.unref?.();

		const refreshUsage = () => {
			if (disposed) return;
			const generation = ++usageGeneration;
			usageAbort?.abort();
			const controller = new AbortController();
			usageAbort = controller;
			const stale = () => disposed || generation !== usageGeneration || controller.signal.aborted;
			void (async () => {
				try {
					const model = ctx.model;
					const api = await getPiUsage();
					if (stale()) return;
					if (!api || !model) {
						if (localUsageChip) {
							localUsageChip = "";
							tui.requestRender();
						}
						return;
					}
					const adapter = api.adapterForProvider?.(model.provider);
					if (!adapter || adapter.publishesStatusline !== false) {
						if (localUsageChip) {
							localUsageChip = "";
							tui.requestRender();
						}
						return;
					}
					const auth = await api.resolveUsageAuth(ctx, adapter);
					if (stale()) return;
					if (!auth) {
						const next = `${adapter.displayName} ✗`;
						if (localUsageChip !== next) {
							localUsageChip = next;
							tui.requestRender();
						}
						return;
					}
					const guard = async () => {
						if (stale()) throw new Error("aborted");
						const again = await api.resolveUsageAuth(ctx, adapter);
						if (again?.fingerprint !== auth.fingerprint) {
							throw new Error("aborted");
						}
					};
					const report = await api.queryProviderUsage(
						adapter,
						auth,
						controller.signal,
						USAGE_TIMEOUT_MS,
						guard,
					);
					if (stale()) return;
					const next =
						(adapter.id === "xai" ? formatXaiFooterChip(report) : undefined) ||
						api.formatUsageStatusline?.(report, model) ||
						`${adapter.displayName} ✗`;
					if (localUsageChip !== next) {
						localUsageChip = next;
						tui.requestRender();
					}
				} catch {
					if (stale()) return;
					const name = ctx.model?.provider === "xai" ? "xAI" : "usage";
					const next = `${name} ✗`;
					if (localUsageChip !== next) {
						localUsageChip = next;
						tui.requestRender();
					}
				} finally {
					if (usageAbort === controller) usageAbort = undefined;
				}
			})();
		};
		refreshCurrentUsage = refreshUsage;
		refreshUsage();
		const usageRefreshTimer = setInterval(refreshUsage, USAGE_REFRESH_INTERVAL_MS);
		usageRefreshTimer.unref?.();

		// 内置 MCP 的状态不经 setStatus 暴露，只能轮询 pi API 与 mcp.json 推算
		const refreshMcp = () => {
			if (disposed) return;
			const chip = buildMcpChip(ctx, extensionApi);
			const glyph = footerGlyphs(config.footerNerdIcons).mcp;
			const next = chip ? `${glyph ? `${glyph} ` : ""}${chip}` : "";
			if (cachedMcpChip === next) return;
			cachedMcpChip = next;
			tui.requestRender();
		};
		refreshCurrentMcpChip = refreshMcp;
		refreshMcp();
		const mcpRefreshTimer = setInterval(refreshMcp, MCP_REFRESH_INTERVAL_MS);
		mcpRefreshTimer.unref?.();

		// 分支变化时重新选择基准，并拒绝旧分支的异步查询结果。
		const unsubBranch = footerData.onBranchChange(() => {
			gitRefresher.refresh(true);
			tui.requestRender();
		});

		// ---- pi-cc-status 风格：上下文条形图 ----
		const BAR_WIDTH = 10;
		const BAR_WARNING = 80; // >= 80% 转 warning 色
		const BAR_ERROR = 95; // >= 95% 转 error 色
		const barGauge = (pct: number): string => {
			const clamped = Math.max(0, Math.min(100, pct));
			const filled = Math.round((clamped / 100) * BAR_WIDTH);
			const color = clamped >= BAR_ERROR ? "error" : clamped >= BAR_WARNING ? "warning" : "accent";
			return theme.fg(color, "█".repeat(filled)) + theme.fg("dim", "░".repeat(BAR_WIDTH - filled));
		};

		// pi-cc-status showCachePercent：最近一条助手消息的 cacheRead 占比
		const getCachePct = (): number => {
			const branch = ctx.sessionManager.getBranch();
			for (let i = branch.length - 1; i >= 0; i--) {
				const e = branch[i];
				if (e.type !== "message" || e.message.role !== "assistant") continue;
				const u = e.message.usage;
				if (!u) return 0;
				const total = u.input + u.cacheWrite + u.cacheRead;
				return total > 0 ? (u.cacheRead * 100) / total : 0;
			}
			return 0;
		};

		// 三个会话统计每帧重算会全量遍历 session，长会话把 pi 钉在 100% CPU（issue #80）。
		// leaf/model/thinking 任一变化立即重算；不变时 1s TTL，流式期间每秒刷新一次。
		const SESSION_STATS_TTL_MS = 1_000;
		let statsMemoKey = "";
		let statsMemoAt = 0;
		let statsMemo:
			| {
					contextUsage: ReturnType<typeof ctx.getContextUsage>;
					cost: number;
					tokens: number;
					cachePct: number;
			  }
			| undefined;
		const sessionStats = () => {
			const model = ctx.model;
			const key = `${ctx.sessionManager.getLeafId() ?? ""}|${model?.provider}/${model?.id}|${ctx.thinkingLevel ?? ""}`;
			if (
				statsMemo &&
				key === statsMemoKey &&
				performance.now() - statsMemoAt < SESSION_STATS_TTL_MS
			) {
				return statsMemo;
			}
			let cost = 0;
			let tokens = 0;
			for (const entry of ctx.sessionManager.getEntries()) {
				if (entry.type === "message") {
					const m = entry.message;
					if (m.role === "assistant") cost += m.usage?.cost?.total || 0;
					else if (m.role === "toolResult" && m.usage) cost += m.usage.cost?.total || 0;
				} else if (
					(entry.type === "branch_summary" ||
						entry.type === "compaction" ||
						entry.type === "usage") &&
					entry.usage
				) {
					cost += entry.usage.cost?.total || 0;
				}
				tokens += sessionEntryTokens(entry);
			}
			statsMemo = {
				contextUsage: ctx.getContextUsage(),
				cost,
				tokens,
				cachePct: getCachePct(),
			};
			statsMemoKey = key;
			statsMemoAt = performance.now();
			return statsMemo;
		};

		const render = (width: number): string[] => {
			const model = ctx.model;
			const { contextUsage, cost, tokens, cachePct } = sessionStats();
			const contextWindow = contextUsage?.contextWindow ?? model?.contextWindow ?? 0;
			const contextFigures = contextChipFigures(
				{
					tokens: contextUsage?.tokens ?? null,
					contextWindow,
					percent: contextUsage?.percent ?? null,
				},
				config.footerContextLimit === "window"
					? undefined
					: cachedCompactionLimit(contextWindow, model),
				config.footerContextLimit,
			);
			const percent = contextFigures.percent;

			// cwd 默认只显示最底层路径（根目录时回退完整路径）
			const cwdLabel = ctx.cwd.split(/[\\/]/).filter(Boolean).pop() || ctx.cwd;

			const usingSubscription =
				!!model &&
				["kimi-coding", "xai", "github-copilot", "openai"].includes(model.provider || "");
			const modelLabel = model
				? model.id.includes("/")
					? model.id
					: `${model.provider}/${model.id}`
				: "no-model";

			const thinkingLevelStr = ctx.thinkingLevel || "off";
			const thinkingColor = theme.getThinkingBorderColor(thinkingLevelStr);

			rememberExtensionStatuses(
				footerData.getExtensionStatuses().entries() as Iterable<[string, string]>,
			);
			const pluginTexts = pluginTextsForRender(localUsageChip);
			const mcpChip = ownMcpChip();
			if (mcpChip) pluginTexts.set(MCP_STATUS_KEY, mcpChip);
			const layout = resolveFooterChipLayout(layoutFromConfig(), [...pluginTexts.keys()]);
			const dimPlugin = (text: string) => colorUsageChip(theme, text);

			const pctLabel = percent === null || percent === undefined ? "?" : `${Math.floor(percent)}%`;
			const glyphs = footerGlyphs(config.footerNerdIcons);
			const cacheLabel =
				cachePct > 0 ? `${glyphs.cache ? `${glyphs.cache} ` : ""}${Math.floor(cachePct)}%` : "";
			const rateLabel = config.footerTokenRate
				? formatTokenRate(
						displayTokenRate(config.footerTokenRateMode),
						currentTtftMs(),
						config.footerTokenRateMode,
						config.footerTokenRateTtft,
					)
				: "";
			const costLabel =
				cost || usingSubscription
					? formatFooterCost(cost, config.footerCurrency, config.footerCurrencyRate)
					: "";
			const costChip = costLabel
				? theme.fg("dim", costLabel) + (usingSubscription ? theme.fg("warning", " sub") : "")
				: "";
			const tokensLabel = config.footerSessionTokens ? formatSessionTokenTotal(tokens) : "";

			const gitColor = theme.getThinkingBorderColor("medium");
			let place = theme.fg("accent", cwdLabel);
			const sessionName = ctx.sessionManager.getSessionName();
			if (sessionName) {
				place += theme.fg("muted", " in ") + theme.fg("success", sessionName);
			}
			const branch = footerData.getGitBranch();
			let gitChip = "";
			if (branch) {
				const s = gitStats;
				let stats = "";
				if (s && s.status)
					stats = theme.fg("dim", " [") + colorGitStatus(theme, s.status) + theme.fg("dim", "]");
				if (s && (s.add || s.del))
					stats +=
						theme.fg("dim", "(") +
						theme.fg("success", `+${s.add}`) +
						" " +
						theme.fg("error", `−${s.del}`) +
						theme.fg("dim", ")");
				const gitLabel = glyphs.git ? `${glyphs.git} ${branch}` : branch;
				gitChip = gitColor(gitLabel) + stats;
			}

			const builtinChips = new Map<string, string>([
				[
					FOOTER_MODEL_KEY,
					modelChip(theme, modelLabel, model?.reasoning ? thinkingLevelStr : "", thinkingColor),
				],
				[
					FOOTER_CONTEXT_KEY,
					barGauge(percent ?? 0) + theme.fg("dim", ` ${pctLabel}/${contextFigures.limitLabel}`),
				],
				[FOOTER_CACHE_KEY, cacheLabel ? theme.fg("dim", cacheLabel) : ""],
				[FOOTER_RATE_KEY, rateLabel ? theme.fg("dim", rateLabel) : ""],
				[FOOTER_COST_KEY, costChip],
				[FOOTER_TOKENS_KEY, tokensLabel ? theme.fg("dim", tokensLabel) : ""],
				[FOOTER_CWD_KEY, place],
				[FOOTER_GIT_KEY, gitChip],
			]);

			const lineOf = (keys: readonly string[]) =>
				joinChips(
					keys
						.filter((key) => !layout.footerHiddenKeys.includes(key))
						.map((key) => {
							if (isBuiltinFooterKey(key)) return builtinChips.get(key) ?? "";
							const text = visibleFooterPluginTexts([key], [], pluginTexts)[0];
							return text ? dimPlugin(text) : "";
						}),
				);
			const line1 = lineOf(layout.footerLine1Keys);
			const line2 = lineOf(layout.footerLine2Keys);
			const line3 = lineOf(layout.footerLine3Keys);

			// 对齐输入文本起始列：editorPaddingX + `❯ ` 的 2 列（随编辑器 render 实时更新）。
			const indent = " ".repeat(inputTextIndent());
			const fit = (line: string) =>
				indent + truncateToWidth(line, Math.max(1, width - indent.length));

			return [fit(line1), ...(line2 ? [fit(line2)] : []), ...(line3 ? [fit(line3)] : [])];
		};

		return {
			render,
			invalidate(): void {
				tui.requestRender();
			},
			dispose(): void {
				disposed = true;
				gitRefresher.dispose();
				usageAbort?.abort();
				usageAbort = undefined;
				clearInterval(gitRefreshTimer);
				clearInterval(usageRefreshTimer);
				clearInterval(mcpRefreshTimer);
				unsubBranch();
				if (currentTui === tui) {
					currentTui = undefined;
					refreshCurrentGitStats = undefined;
					refreshCurrentUsage = undefined;
					refreshCurrentMcpChip = undefined;
				}
			},
		};
	};

/** Apply the configured custom footer without disturbing another extension's footer when disabled. */
export function applyCustomFooter(ctx: ExtensionContext): void {
	if (!ctx?.hasUI || typeof ctx.ui?.setFooter !== "function" || !config.enableCustomFooter) return;
	try {
		ctx.ui.setFooter(createCustomFooterFactory(ctx));
	} catch (err) {
		ctx.ui.notify(`footer error: ${err instanceof Error ? err.message : String(err)}`, "error");
	}
}

/** Restore Pi's native footer when the user explicitly disables this extension's active footer. */
export function clearCustomFooter(ctx: ExtensionContext): void {
	if (!ctx?.hasUI || typeof ctx.ui?.setFooter !== "function") return;
	ctx.ui.setFooter(undefined);
}

export default function (pi: ExtensionAPI) {
	extensionApi = pi;
	// 模型/思考级别变化时强制重渲染（自定义 footer 不会被内置 invalidate() 触达）
	pi.on("model_select", () => {
		currentTui?.requestRender();
		refreshCurrentUsage?.();
	});
	pi.on("thinking_level_select", () => currentTui?.requestRender());
	// 工具执行完成后立即刷新；定时器只负责兜底捕获外部文件变化。
	pi.on("tool_execution_end", () => {
		refreshCurrentGitStats?.();
		// 懒连接的 MCP 服务器可能刚被调用过
		refreshCurrentMcpChip?.();
	});

	// 启动 / /reload / 新建会话 时按配置恢复
	pi.on("session_start", (_event, ctx) => {
		applyCustomFooter(ctx);
	});
}
