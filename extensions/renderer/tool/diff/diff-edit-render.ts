import { Text, type Component } from "@earendil-works/pi-tui";
import type { EditToolDetails } from "@earendil-works/pi-coding-agent";
import { sanitizeToolResultText } from "../../../utils/tool-result-sanitize.ts";
import {
	getLineNumberWidth,
	parseDiff,
	type ParsedDiff,
	type ParsedDiffEntry,
} from "./diff-parse.ts";
import { buildInlineHighlightMap, buildSplitRows } from "./diff-inline.ts";
import { resolveDiffPalette, type DiffTheme } from "./diff-palette.ts";
import { createCodeLineHighlighter, resolveLanguageFromPath } from "./diff-highlight.ts";
import {
	canRenderSplitLayout,
	renderCompact,
	renderSplit,
	renderUnified,
	type DiffRenderContext,
} from "./diff-layout.ts";
import { renderDiffFrameLine, renderHeaderRows, renderSingleDiffRow } from "./diff-header.ts";
import {
	applyLineLimit,
	clampDiffLinesToWidth,
	resolveDiffDisplayLimit,
	resolveDiffProcessBudget,
	takeEntriesForLineBudget,
	takeSplitRowsForBudget,
} from "./diff-limits.ts";
import {
	RICH_DIFF_COMPONENT,
	createDiffRenderCache,
	displayConfigCacheKey,
	resolveDiffIndicatorMode,
	resolveLiveDisplayConfig,
	normalizeCollapsedHintLine,
	type DiffRenderOptions,
	type DisplayConfigInput,
} from "./diff-component.ts";
import {
	buildDiffSummaryText,
	normalizeDiffRenderWidth,
	resolveDiffPresentationMode,
} from "./diff-presentation.ts";

function safeGetDiff(details: unknown): string {
	if (!details || typeof details !== "object") {
		return "";
	}
	const typed = details as Partial<EditToolDetails>;
	return typeof typed.diff === "string" ? typed.diff : "";
}

// Pi appends an omission marker after final context to say the file continues.
// It does not separate visible diff regions, so keep only omissions before a rendered line.
function omitTerminalOmissions(entries: ParsedDiffEntry[]): ParsedDiffEntry[] {
	let lastLineIndex = -1;
	for (let index = entries.length - 1; index >= 0; index--) {
		if (entries[index]?.kind === "line") {
			lastLineIndex = index;
			break;
		}
	}

	return entries.filter((entry, index) => entry.kind !== "omission" || index < lastLineIndex);
}

/**
 * edit 变更行统计（compact 单行 `(+A -D)` 用）：复用现有 parser，diff 文件头不计入。
 * 无 diff 或解析失败时返回 undefined，不把未知状态误报为零变更。
 */
export function countEditDiffStats(
	details: unknown,
): { added: number; removed: number } | undefined {
	const diffText = sanitizeToolResultText(safeGetDiff(details));
	if (!diffText.trim()) return undefined;
	try {
		const parsed = parseDiff(diffText);
		return { added: parsed.stats.added, removed: parsed.stats.removed };
	} catch {
		return undefined;
	}
}

export function renderEditDiffResult(
	details: unknown,
	options: DiffRenderOptions,
	config: DisplayConfigInput,
	theme: DiffTheme,
	fallbackText: string,
): Component {
	const diffText = sanitizeToolResultText(safeGetDiff(details));
	const safeFallbackText = sanitizeToolResultText(fallbackText);
	if (!diffText.trim()) {
		if (!safeFallbackText.trim()) {
			return new Text(theme.fg("muted", "↳ edit completed (no diff payload)"), 0, 0);
		}
		return new Text(theme.fg("toolOutput", safeFallbackText), 0, 0);
	}

	let parsed: ParsedDiff;
	try {
		parsed = parseDiff(diffText);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return new Text(theme.fg("warning", `↳ unable to render diff: ${message}`), 0, 0);
	}

	const renderEntries = omitTerminalOmissions(parsed.entries);
	if (renderEntries.length === 0) {
		return new Text(theme.fg("muted", "↳ no diff data"), 0, 0);
	}

	const splitRows = buildSplitRows(renderEntries);
	const showHashlineAnchors =
		options.expanded === true &&
		renderEntries.some((entry) => entry.kind === "line" && !!entry.hashlineAnchorContent);
	const lineNumberWidth = getLineNumberWidth(renderEntries, showHashlineAnchors);
	const palette = resolveDiffPalette(theme);
	// Rich diffs use ccstyle's self shell. Keep the panel transparent so the
	// separator cannot leak toolSuccessBg across the entire new column.
	const containerBgAnsi = undefined;
	const language = resolveLanguageFromPath(options.filePath);
	const cache = createDiffRenderCache();
	const highlightLine = createCodeLineHighlighter(language, theme, renderEntries, () => {
		cache.invalidate();
		options.invalidate?.();
	});

	return {
		[RICH_DIFF_COMPONENT]: true,
		/** 鼠标层只在真正的 remainder 行上提供展开入口。 */
		isCollapsedHintLine(plainLine: string): boolean {
			const hint = cache.getHintLine();
			return hint !== undefined && normalizeCollapsedHintLine(plainLine) === hint;
		},
		render(width: number): string[] {
			// Live config: panel can change indicator/wrap/limits after this component is created.
			const live = resolveLiveDisplayConfig(config);
			const wordWrap = live.diffWordWrap;
			const indicatorMode = resolveDiffIndicatorMode(live);
			const configKey = displayConfigCacheKey(live);
			const safeWidth = normalizeDiffRenderWidth(width);
			const mode = resolveDiffPresentationMode(live, safeWidth, canRenderSplitLayout(safeWidth));
			const hovered = options.isHovered?.() ?? false;
			const cached = cache.get(safeWidth, options.expanded, mode, configKey, hovered);
			if (cached) {
				return cached;
			}

			if (mode === "summary") {
				return cache.set(
					safeWidth,
					options.expanded,
					mode,
					configKey,
					hovered,
					clampDiffLinesToWidth(
						renderSingleDiffRow(
							buildDiffSummaryText(parsed.stats, safeWidth),
							"toolOutput",
							safeWidth,
							theme,
						),
						safeWidth,
					),
				);
			}

			const headerRows = renderHeaderRows(parsed.stats, mode, safeWidth, theme);
			const displayLimit = resolveDiffDisplayLimit(options.expanded, live.editDiffCollapsedLines);
			const processBudget = resolveDiffProcessBudget(displayLimit, wordWrap);
			// Only highlight/render a prefix that can fill the display limit; full-diff
			// LCS + syntax highlight on thousands of hidden lines is pure waste when collapsed.
			const entryBudget = takeEntriesForLineBudget(renderEntries, processBudget);
			const splitBudget = takeSplitRowsForBudget(splitRows, processBudget);
			const inlineHighlights = buildInlineHighlightMap(splitBudget.rows);
			const renderCtx: DiffRenderContext = {
				width: safeWidth,
				theme,
				inlineHighlights,
				palette,
				highlightLine,
				containerBgAnsi,
				wordWrap,
				indicatorMode,
				showHashlineAnchors,
			};
			const bodyRows =
				mode === "split"
					? renderSplit(splitBudget.rows, renderCtx, lineNumberWidth)
					: mode === "compact"
						? renderCompact(entryBudget.entries, renderCtx)
						: renderUnified(entryBudget.entries, renderCtx, lineNumberWidth);
			const unprocessedLogicalRows =
				mode === "split"
					? Math.max(0, splitBudget.totalRows - splitBudget.processedRows)
					: Math.max(0, entryBudget.totalLineEntries - entryBudget.processedLineEntries);
			const bodyWithLimit = applyLineLimit(
				bodyRows,
				safeWidth,
				options.expanded,
				live.editDiffCollapsedLines,
				parsed.stats.hunks,
				theme,
				unprocessedLogicalRows,
				hovered,
			);
			const frame = renderDiffFrameLine(safeWidth, theme);
			const renderedLines =
				mode === "unified"
					? [...headerRows.map((row) => row.text), frame, ...bodyWithLimit.lines, frame]
					: [...headerRows.map((row) => row.text), ...bodyWithLimit.lines];

			const clampedLines = clampDiffLinesToWidth(renderedLines, safeWidth);
			return cache.set(
				safeWidth,
				options.expanded,
				mode,
				configKey,
				hovered,
				clampedLines,
				normalizeCollapsedHintLine(bodyWithLimit.hintLine),
			);
		},
		invalidate: cache.invalidate,
	} as Component;
}
