import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { sanitizeAnsiForThemedOutput } from "./ansi-utils.ts";
import { normalizeCodeWhitespace, wrapToWidth } from "./diff-text.ts";
import { emphasis, stabilizeBackgroundResets, type DiffTheme } from "./diff-palette.ts";
import { clampDiffLineToWidth } from "./diff-limits.ts";
import type { DiffMetaEntry, DiffStats } from "./diff-parse.ts";
import type { DiffPresentationMode } from "./diff-presentation.ts";
import type { RenderedRow } from "./diff-layout.ts";

export function formatMetaEntryRows(
	entry: DiffMetaEntry,
	width: number,
	theme: DiffTheme,
	wordWrap: boolean,
): RenderedRow[] {
	const normalized = sanitizeAnsiForThemedOutput(normalizeCodeWhitespace(entry.raw));
	const lines = wordWrap
		? wrapToWidth(normalized, width, true)
		: [truncateToWidth(normalized, width)];

	const mapColor = (line: string): string => {
		if (entry.kind === "hunk") {
			return stabilizeBackgroundResets(theme.fg("accent", line));
		}
		if (entry.kind === "file") {
			return stabilizeBackgroundResets(theme.fg("muted", line));
		}
		return stabilizeBackgroundResets(theme.fg("toolDiffContext", line));
	};

	return lines.map((line) => ({
		text: mapColor(line),
		hunkIndex: entry.kind === "file" ? null : entry.hunkIndex || null,
	}));
}

function renderDiffStatBar(stats: DiffStats, width: number, theme: DiffTheme): string | null {
	const totalChanges = stats.added + stats.removed;
	if (totalChanges === 0 || width < 20) {
		return null;
	}

	const barSlots = Math.max(8, Math.min(24, Math.floor(width / 12)));
	let addedSlots = Math.max(
		0,
		Math.min(barSlots, Math.round((stats.added / totalChanges) * barSlots)),
	);
	if (stats.added > 0 && addedSlots === 0) {
		addedSlots = 1;
	}
	if (stats.removed > 0 && addedSlots >= barSlots) {
		addedSlots = barSlots - 1;
	}
	const removedSlots = Math.max(0, barSlots - addedSlots);

	const addedBar = addedSlots > 0 ? theme.fg("toolDiffAdded", "━".repeat(addedSlots)) : "";
	const removedBar = removedSlots > 0 ? theme.fg("toolDiffRemoved", "━".repeat(removedSlots)) : "";
	return stabilizeBackgroundResets(
		`${theme.fg("dim", "[")}${addedBar}${removedBar}${theme.fg("dim", "]")}`,
	);
}

function buildDiffSummaryBasePieces(stats: DiffStats, theme: DiffTheme): string[] {
	return [
		theme.fg("toolOutput", `↳ ${emphasis(theme, "diff")}`),
		theme.fg("toolDiffAdded", `+${stats.added}`),
		theme.fg("toolDiffRemoved", `-${stats.removed}`),
	];
}

export function renderHeaderRows(
	stats: DiffStats,
	mode: Exclude<DiffPresentationMode, "summary">,
	width: number,
	theme: DiffTheme,
): RenderedRow[] {
	if (mode === "compact") {
		const summary = buildDiffSummaryBasePieces(stats, theme).join(" ");
		return [{ text: stabilizeBackgroundResets(truncateToWidth(summary, width)), hunkIndex: null }];
	}

	const summaryPieces = [...buildDiffSummaryBasePieces(stats, theme), theme.fg("muted", mode)];

	const summary = summaryPieces.join(mode === "split" ? " " : theme.fg("muted", " · "));
	const meter = renderDiffStatBar(stats, width, theme);
	if (!meter) {
		return [{ text: stabilizeBackgroundResets(truncateToWidth(summary, width)), hunkIndex: null }];
	}

	const meterSeparator = " ";
	const meterWidth = visibleWidth(meterSeparator) + visibleWidth(meter);
	if (meterWidth >= width) {
		return [{ text: stabilizeBackgroundResets(truncateToWidth(summary, width)), hunkIndex: null }];
	}

	const summaryWidth = Math.max(0, width - meterWidth);
	const fittedSummary = truncateToWidth(summary, summaryWidth);
	return [
		{
			text: stabilizeBackgroundResets(`${fittedSummary}${meterSeparator}${meter}`),
			hunkIndex: null,
		},
	];
}

export function renderDiffFrameLine(width: number, theme: DiffTheme): string {
	const frameWidth = Math.max(0, width);
	if (frameWidth === 0) {
		return "";
	}
	return stabilizeBackgroundResets(theme.fg("dim", "─".repeat(frameWidth)));
}

export function renderSingleDiffRow(
	text: string,
	color: string,
	width: number,
	theme: DiffTheme,
): string[] {
	if (width <= 0) {
		return [""];
	}
	return [clampDiffLineToWidth(stabilizeBackgroundResets(theme.fg(color, text)), width)];
}

export function renderWriteHeader(
	wasOverwrite: boolean,
	width: number,
	theme: DiffTheme,
	headerLabel?: string,
): string {
	const actionLabel = headerLabel?.trim() || (wasOverwrite ? "overwritten" : "created");
	return stabilizeBackgroundResets(
		truncateToWidth(theme.fg("toolOutput", `↳ ${emphasis(theme, actionLabel)}`), width),
	);
}
