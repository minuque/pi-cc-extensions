/**
 * 自定义底栏：chips + zentui 图标/句子
 *
 * 第一行：model  thinking · ██████░░░░ 45%/200k · 󰆼 42% · $0.01 · 用户排到 line1 的插件芯片
 * 第二行：cwd in session on  branch (+16 −1) · 用户排到 line2 的插件芯片
 * 第三行：仅当 line3 有可见插件芯片时出现
 *
 *  - line1 短芯片，· 分隔；缓存用 zentui 󰆼，费用 success
 *  - line2 用 zentui 句式 in / on + 
 *  - 当前模型用量：优先 pi-usage 的 usage 状态；xAI 等不写 statusline 的供应商由本扩展补拉
 *
 * 模型/计费/思考级别变化时自动更新（pi.on 全局事件 + render 实时计算）
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { config } from "../../config/config.ts";
import { stripAnsi } from "../../utils/ansi-text.ts";
import { FooterCurrencyConverter } from "./footer-currency.ts";
import {
	PI_USAGE_KEY,
	isSkippedFooterStatusKey,
	resolveFooterChipLayout,
	visibleFooterPluginTexts,
	type FooterChipLayout,
} from "./footer-layout.ts";

const GIT_REFRESH_INTERVAL_MS = 10_000;
const USAGE_REFRESH_INTERVAL_MS = 5 * 60 * 1000;
const USAGE_TIMEOUT_MS = 15_000;
// zentui NERD_DEFAULT_ICONS：git / cacheHit。无 Nerd Font 时留空，只保留文字。
export const FOOTER_NERD_ICON_GIT = "";
export const FOOTER_NERD_ICON_CACHE = "󰆼";

export function footerGlyphs(nerdIcons: boolean): { git: string; cache: string } {
	return nerdIcons
		? { git: FOOTER_NERD_ICON_GIT, cache: FOOTER_NERD_ICON_CACHE }
		: { git: "", cache: "" };
}

type GitStats = { add: number; del: number };

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

export function parseGitStats(stdout: string): GitStats {
	let add = 0;
	let del = 0;
	for (const line of stdout.split("\n")) {
		const match = line.match(/^(\d+)\s+(\d+)/);
		if (match) {
			add += Number(match[1]);
			del += Number(match[2]);
		}
	}
	return { add, del };
}

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

/** 面板用：当前 setStatus 文案 + 本包 pi-usage（无文案时为空字符串）。 */
export function getFooterStatusSnapshot(): Map<string, string> {
	const out = new Map<string, string>();
	for (const [key, text] of cachedExtensionStatuses) {
		if (isSkippedFooterStatusKey(key)) continue;
		out.set(key, text);
	}
	out.set(PI_USAGE_KEY, cachedLocalUsageText);
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

const currencyConverter = new FooterCurrencyConverter();
let currentTui: any = undefined;
let refreshCurrentGitStats: (() => void) | undefined;
let refreshCurrentUsage: (() => void) | undefined;

const createCustomFooterFactory =
	(ctx: ExtensionContext) => (tui: any, theme: any, footerData: any) => {
		currentTui = tui;
		const sep = theme.fg("muted", " · ");
		const joinChips = (parts: string[]) => parts.filter(Boolean).join(sep);
		let gitStats: GitStats | undefined;
		let gitRefreshRunning = false;
		let localUsageChip = "";
		let usageGeneration = 0;
		let usageAbort: AbortController | undefined;
		let disposed = false;

		// 查询在 render 外执行，保留旧值；仅统计结果真正变化时重绘，避免周期性清零抖动。
		const refreshGitStats = () => {
			if (gitRefreshRunning || disposed) return;
			gitRefreshRunning = true;
			execFile(
				"git",
				["diff", "--numstat", "HEAD"],
				{ cwd: ctx.cwd, timeout: 2000 },
				(err, stdout) => {
					gitRefreshRunning = false;
					if (err || disposed) return;
					const next = parseGitStats(stdout);
					if (gitStats?.add === next.add && gitStats.del === next.del) return;
					gitStats = next;
					tui.requestRender();
				},
			);
		};
		refreshCurrentGitStats = refreshGitStats;
		refreshGitStats();
		const gitRefreshTimer = setInterval(refreshGitStats, GIT_REFRESH_INTERVAL_MS);
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

		// 分支变化时同步更新分支名和相对 HEAD 的统计。
		const unsubBranch = footerData.onBranchChange(() => {
			refreshGitStats();
			tui.requestRender();
		});

		const fmt = (n: number): string => {
			if (n < 1000) return `${n}`;
			if (n < 10000) return `${(n / 1000).toFixed(1)}k`;
			if (n < 1000000) return `${Math.round(n / 1000)}k`;
			if (n < 10000000) return `${(n / 1000000).toFixed(1)}M`;
			return `${Math.round(n / 1000000)}M`;
		};

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

		const render = (width: number): string[] => {
			const model = ctx.model;
			const contextUsage = ctx.getContextUsage();
			const contextWindow = contextUsage?.contextWindow ?? model?.contextWindow ?? 0;
			const percent = contextUsage?.percent;

			let cost = 0;
			for (const entry of ctx.sessionManager.getEntries()) {
				if (entry.type === "message") {
					const m = entry.message;
					if (m.role === "assistant") cost += m.usage?.cost?.total || 0;
					else if (m.role === "toolResult" && m.usage) cost += m.usage.cost?.total || 0;
				} else if (
					(entry.type === "branch_summary" || entry.type === "compaction") &&
					entry.usage
				) {
					cost += entry.usage.cost?.total || 0;
				}
			}

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
			const layout = resolveFooterChipLayout(layoutFromConfig(), [...pluginTexts.keys()]);
			const dimPlugin = (text: string) => colorUsageChip(theme, text);
			const line1Plugins = visibleFooterPluginTexts(
				layout.footerLine1Keys,
				layout.footerHiddenKeys,
				pluginTexts,
			).map(dimPlugin);
			const line2Plugins = visibleFooterPluginTexts(
				layout.footerLine2Keys,
				layout.footerHiddenKeys,
				pluginTexts,
			).map(dimPlugin);
			const line3Plugins = visibleFooterPluginTexts(
				layout.footerLine3Keys,
				layout.footerHiddenKeys,
				pluginTexts,
			).map(dimPlugin);

			const pctLabel = percent === null || percent === undefined ? "?" : `${Math.floor(percent)}%`;
			const cachePct = getCachePct();
			const glyphs = footerGlyphs(config.footerNerdIcons);
			const cacheLabel =
				cachePct > 0 ? `${glyphs.cache ? `${glyphs.cache} ` : ""}${Math.floor(cachePct)}%` : "";
			const costChip =
				cost || usingSubscription
					? theme.fg("dim", currencyConverter.format(cost, config.customCurrency)) +
						(usingSubscription ? theme.fg("warning", " sub") : "")
					: "";
			const line1 = joinChips([
				theme.fg("accent", modelLabel),
				model?.reasoning ? thinkingColor(thinkingLevelStr) : "",
				barGauge(percent ?? 0) + theme.fg("dim", ` ${pctLabel}/${fmt(contextWindow)}`),
				cacheLabel ? theme.fg("dim", cacheLabel) : "",
				costChip,
				...line1Plugins,
			]);

			const gitColor = theme.getThinkingBorderColor("medium");
			let place = theme.fg("accent", cwdLabel);
			const sessionName = ctx.sessionManager.getSessionName();
			if (sessionName) {
				place += theme.fg("muted", " in ") + theme.fg("success", sessionName);
			}
			const branch = footerData.getGitBranch();
			if (branch) {
				const stats =
					gitStats && (gitStats.add || gitStats.del)
						? theme.fg("dim", " (") +
							theme.fg("success", `+${gitStats.add}`) +
							" " +
							theme.fg("error", `−${gitStats.del}`) +
							theme.fg("dim", ")")
						: "";
				const gitLabel = glyphs.git ? `${glyphs.git} ${branch}` : branch;
				place += theme.fg("muted", " on ") + gitColor(gitLabel) + stats;
			}
			const line2 = joinChips([place, ...line2Plugins]);
			const line3 = joinChips(line3Plugins);

			return [
				truncateToWidth(line1, width),
				...(line2 ? [truncateToWidth(line2, width)] : []),
				...(line3 ? [truncateToWidth(line3, width)] : []),
			];
		};

		return {
			render,
			invalidate(): void {
				tui.requestRender();
			},
			dispose(): void {
				disposed = true;
				usageAbort?.abort();
				usageAbort = undefined;
				clearInterval(gitRefreshTimer);
				clearInterval(usageRefreshTimer);
				unsubBranch();
				if (currentTui === tui) {
					currentTui = undefined;
					refreshCurrentGitStats = undefined;
					refreshCurrentUsage = undefined;
				}
			},
		};
	};

/** Apply the configured custom footer without disturbing another extension's footer when disabled. */
export function applyCustomFooter(ctx: ExtensionContext): void {
	if (!ctx?.hasUI || typeof ctx.ui?.setFooter !== "function" || !config.enableCustomFooter) return;
	try {
		ctx.ui.setFooter(createCustomFooterFactory(ctx));
		// Fetch once when enabled; rerender after the rate arrives without blocking startup.
		void currencyConverter.load(config.customCurrency).then(() => currentTui?.requestRender());
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
	// 模型/思考级别变化时强制重渲染（自定义 footer 不会被内置 invalidate() 触达）
	pi.on("model_select", () => {
		currentTui?.requestRender();
		refreshCurrentUsage?.();
	});
	pi.on("thinking_level_select", () => currentTui?.requestRender());
	// 工具执行完成后立即刷新；定时器只负责兜底捕获外部文件变化。
	pi.on("tool_execution_end", () => refreshCurrentGitStats?.());

	// 启动 / /reload / 新建会话 时按配置恢复
	pi.on("session_start", (_event, ctx) => {
		applyCustomFooter(ctx);
	});
}
