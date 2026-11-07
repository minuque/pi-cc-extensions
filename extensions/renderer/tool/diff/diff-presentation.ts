import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { pluralize } from "./diff-text.ts";
import type { DiffTheme } from "./diff-palette.ts";
import type { ToolDisplayConfig } from "../../../config/config.ts";

export interface DiffSummaryStats {
	added: number;
	removed: number;
	hunks: number;
	files: number;
}

export type DiffPresentationMode = "split" | "unified" | "compact" | "summary";

const MIN_COMPACT_DIFF_WIDTH = 8;
const MIN_UNIFIED_DIFF_WIDTH = 18;

export function normalizeDiffRenderWidth(width: number): number {
	if (!Number.isFinite(width)) {
		return 0;
	}
	return Math.max(0, Math.floor(width));
}

export function resolveDiffPresentationMode(
	config: Pick<ToolDisplayConfig, "diffViewMode" | "diffSplitMinWidth">,
	width: number,
	canRenderSplitLayout: boolean,
): DiffPresentationMode {
	const safeWidth = normalizeDiffRenderWidth(width);
	if (safeWidth < MIN_COMPACT_DIFF_WIDTH) {
		return "summary";
	}
	if (safeWidth < MIN_UNIFIED_DIFF_WIDTH) {
		return "compact";
	}

	switch (config.diffViewMode) {
		case "split":
			return canRenderSplitLayout ? "split" : "unified";
		case "unified":
			return "unified";
		case "auto":
		default:
			return safeWidth >= config.diffSplitMinWidth && canRenderSplitLayout ? "split" : "unified";
	}
}

export function buildDiffSummaryText(stats: DiffSummaryStats, width: number): string {
	const safeWidth = normalizeDiffRenderWidth(width);
	if (safeWidth === 0) {
		return "";
	}

	const summaryCandidates = [
		`↳ diff +${stats.added} -${stats.removed} · ${stats.hunks} ${pluralize(stats.hunks, "hunk")} · ${stats.files} ${pluralize(stats.files, "file")}`,
		`↳ diff +${stats.added} -${stats.removed} · ${stats.hunks}h · ${stats.files}f`,
		`↳ diff +${stats.added} -${stats.removed}`,
		`+${stats.added} -${stats.removed}`,
		"diff",
		"…",
	];

	for (const candidate of summaryCandidates) {
		if (visibleWidth(candidate) <= safeWidth) {
			return candidate;
		}
	}

	return truncateToWidth(summaryCandidates[summaryCandidates.length - 1] ?? "", safeWidth, "");
}

/**
 * 折叠摘要行样式：整行 muted，`+A -D` 用 diff 头行同一套绿/红，`click to show more` 与其余折叠卡一致用 dim，hover 提到 text。
 * 0 行预览与多行预览共用这一套颜色：改折叠行数时同一处信息不变色。
 */
export function styleDiffSummaryLine(
	text: string,
	stats: Pick<DiffSummaryStats, "added" | "removed"> | undefined,
	hint: string,
	theme: DiffTheme,
	hovered: boolean,
): string {
	const counts = stats ? `+${stats.added} -${stats.removed}` : "";
	const countsIndex = counts ? text.indexOf(counts) : -1;
	const hintIndex = hint ? text.lastIndexOf(hint) : -1;
	if (countsIndex < 0 && hintIndex < 0) {
		return theme.fg("muted", text);
	}

	const pieces: string[] = [];
	let cursor = 0;
	const pushMuted = (end: number) => {
		const gap = text.slice(cursor, end);
		if (gap) pieces.push(theme.fg("muted", gap));
	};
	if (countsIndex >= 0 && stats) {
		pushMuted(countsIndex);
		pieces.push(theme.fg("success", `+${stats.added}`));
		pieces.push(theme.fg("muted", " "));
		pieces.push(theme.fg("error", `-${stats.removed}`));
		cursor = countsIndex + counts.length;
	}
	if (hintIndex >= cursor) {
		pushMuted(hintIndex);
		pieces.push(theme.fg(hovered ? "text" : "dim", hint));
		cursor = hintIndex + hint.length;
	}
	pushMuted(text.length);
	return pieces.join("");
}
