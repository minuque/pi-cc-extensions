import { Text, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { sanitizeToolResultText } from "../../../utils/tool-result-sanitize.ts";
import { showMoreHintText } from "../show-more-hint.ts";
import { splitWriteContentLines } from "./diff-text.ts";
import {
	collectDiffStats,
	getLineNumberWidth,
	type DiffLineEntry,
	type DiffStats,
	type ParsedDiffEntry,
} from "./diff-parse.ts";
import {
	buildInlineHighlightMap,
	buildSplitRows,
	type DiffSpan,
	type SplitDiffRow,
} from "./diff-inline.ts";
import { resolveDiffPalette, type DiffTheme } from "./diff-palette.ts";
import {
	createCodeLineHighlighter,
	resolveLanguageFromPath,
	type CodeLineHighlighter,
} from "./diff-highlight.ts";
import {
	canRenderSplitLayout,
	renderCompact,
	renderSplit,
	renderUnified,
	type DiffRenderContext,
	type RenderedRow,
} from "./diff-layout.ts";
import { renderDiffFrameLine, renderSingleDiffRow, renderWriteHeader } from "./diff-header.ts";
import {
	applyLineLimit,
	clampDiffLineToWidth,
	clampDiffLinesToWidth,
	resolveDiffDisplayLimit,
	resolveDiffProcessBudget,
	resolveWriteCollapsedLimit,
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
	type DiffPresentationMode,
} from "./diff-presentation.ts";

type WriteDiffOperationKind = "context" | "remove" | "add";

interface WriteDiffOperation {
	kind: WriteDiffOperationKind;
	content: string;
}

function buildWriteDiffOperations(oldLines: string[], newLines: string[]): WriteDiffOperation[] {
	const oldLength = oldLines.length;
	const newLength = newLines.length;
	const table: number[][] = Array.from({ length: oldLength + 1 }, () =>
		Array<number>(newLength + 1).fill(0),
	);

	for (let oldIndex = 1; oldIndex <= oldLength; oldIndex++) {
		for (let newIndex = 1; newIndex <= newLength; newIndex++) {
			if ((oldLines[oldIndex - 1] ?? "") === (newLines[newIndex - 1] ?? "")) {
				table[oldIndex]![newIndex] = (table[oldIndex - 1]?.[newIndex - 1] ?? 0) + 1;
				continue;
			}
			const top = table[oldIndex - 1]?.[newIndex] ?? 0;
			const left = table[oldIndex]?.[newIndex - 1] ?? 0;
			table[oldIndex]![newIndex] = Math.max(top, left);
		}
	}

	const operations: WriteDiffOperation[] = [];
	let oldCursor = oldLength;
	let newCursor = newLength;

	while (oldCursor > 0 || newCursor > 0) {
		const oldLine = oldCursor > 0 ? (oldLines[oldCursor - 1] ?? "") : undefined;
		const newLine = newCursor > 0 ? (newLines[newCursor - 1] ?? "") : undefined;

		if (oldCursor > 0 && newCursor > 0 && oldLine === newLine) {
			operations.push({ kind: "context", content: oldLine ?? "" });
			oldCursor--;
			newCursor--;
			continue;
		}

		const top = oldCursor > 0 ? (table[oldCursor - 1]?.[newCursor] ?? 0) : -1;
		const left = newCursor > 0 ? (table[oldCursor]?.[newCursor - 1] ?? 0) : -1;

		if (newCursor > 0 && left >= top) {
			operations.push({ kind: "add", content: newLine ?? "" });
			newCursor--;
			continue;
		}

		if (oldCursor > 0) {
			operations.push({ kind: "remove", content: oldLine ?? "" });
			oldCursor--;
		}
	}

	operations.reverse();
	return operations;
}

function buildWriteEntries(lines: string[]): ParsedDiffEntry[] {
	return lines.map((line, index) => ({
		kind: "line",
		lineKind: "add",
		oldLineNumber: null,
		newLineNumber: index + 1,
		fallbackLineNumber: `${index + 1}`,
		content: line,
		raw: `+${line}`,
		hunkIndex: 1,
	}));
}

function buildWriteOverwriteEntries(oldLines: string[], newLines: string[]): ParsedDiffEntry[] {
	const operations = buildWriteDiffOperations(oldLines, newLines);
	const entries: ParsedDiffEntry[] = [];
	let oldLineNumber = 1;
	let newLineNumber = 1;

	for (const operation of operations) {
		if (operation.kind === "context") {
			entries.push({
				kind: "line",
				lineKind: "context",
				oldLineNumber,
				newLineNumber,
				fallbackLineNumber: `${newLineNumber}`,
				content: operation.content,
				raw: ` ${operation.content}`,
				hunkIndex: 1,
			});
			oldLineNumber++;
			newLineNumber++;
			continue;
		}

		if (operation.kind === "remove") {
			entries.push({
				kind: "line",
				lineKind: "remove",
				oldLineNumber,
				newLineNumber: null,
				fallbackLineNumber: `${oldLineNumber}`,
				content: operation.content,
				raw: `-${operation.content}`,
				hunkIndex: 1,
			});
			oldLineNumber++;
			continue;
		}

		entries.push({
			kind: "line",
			lineKind: "add",
			oldLineNumber: null,
			newLineNumber,
			fallbackLineNumber: `${newLineNumber}`,
			content: operation.content,
			raw: `+${operation.content}`,
			hunkIndex: 1,
		});
		newLineNumber++;
	}

	return entries;
}

interface WriteDiffData {
	entries: ParsedDiffEntry[];
	splitRows: SplitDiffRow[];
	inlineHighlights: WeakMap<DiffLineEntry, DiffSpan[]>;
	lineNumberWidth: number;
	stats: DiffStats;
	hunkCount: number;
}

interface WriteOverwriteGuard {
	previousLineCount: number;
	nextLineCount: number;
}

const MAX_WRITE_OVERWRITE_DIFF_LINES = 4000;
const MAX_WRITE_OVERWRITE_DIFF_MATRIX_CELLS = 1_000_000;
/** Collapsed overwrite previews refuse larger LCS matrices to avoid TUI freezes. */
const MAX_COLLAPSED_WRITE_OVERWRITE_DIFF_MATRIX_CELLS = 200_000;

function buildApproximateWriteStats(
	lineCount: number,
	previousLineCount: number,
	hasComparablePrevious: boolean,
): DiffStats {
	const removed = hasComparablePrevious ? previousLineCount : 0;
	const added = lineCount;
	const hasContent = lineCount > 0 || removed > 0;
	return {
		added,
		removed,
		context: 0,
		hunks: hasContent ? 1 : 0,
		files: 1,
		lines: added + removed,
	};
}

function buildWriteDiffData(entries: ParsedDiffEntry[]): WriteDiffData {
	const splitRows = buildSplitRows(entries);
	const inlineHighlights = buildInlineHighlightMap(splitRows);
	const lineNumberWidth = getLineNumberWidth(entries);
	const hunkCount = entries.length > 0 ? 1 : 0;
	const stats = collectDiffStats(entries, hunkCount, 1);
	return {
		entries,
		splitRows,
		inlineHighlights,
		lineNumberWidth,
		stats,
		hunkCount,
	};
}

function resolveWriteOverwriteGuard(
	previousLines: string[],
	nextLines: string[],
	expanded = true,
): WriteOverwriteGuard | undefined {
	const previousLineCount = previousLines.length;
	const nextLineCount = nextLines.length;
	if (
		previousLineCount > MAX_WRITE_OVERWRITE_DIFF_LINES ||
		nextLineCount > MAX_WRITE_OVERWRITE_DIFF_LINES
	) {
		return { previousLineCount, nextLineCount };
	}
	if (previousLineCount === 0 || nextLineCount === 0) {
		return undefined;
	}
	const cellLimit = expanded
		? MAX_WRITE_OVERWRITE_DIFF_MATRIX_CELLS
		: MAX_COLLAPSED_WRITE_OVERWRITE_DIFF_MATRIX_CELLS;
	return previousLineCount * nextLineCount > cellLimit
		? { previousLineCount, nextLineCount }
		: undefined;
}

function buildWriteOverwriteGuardText(guard: WriteOverwriteGuard, width: number): string {
	const safeWidth = normalizeDiffRenderWidth(width);
	if (safeWidth === 0) {
		return "";
	}

	const candidates = [
		`↳ overwrite diff omitted (${guard.previousLineCount} → ${guard.nextLineCount} lines)`,
		`↳ overwrite diff omitted (${guard.previousLineCount}→${guard.nextLineCount})`,
		"↳ overwrite diff omitted",
		"diff omitted",
		"…",
	];
	for (const candidate of candidates) {
		if (visibleWidth(candidate) <= safeWidth) {
			return candidate;
		}
	}
	return truncateToWidth(candidates[candidates.length - 1] ?? "", safeWidth, "");
}

function renderWriteOverwriteGuardRows(
	guard: WriteOverwriteGuard,
	width: number,
	theme: DiffTheme,
): string[] {
	return renderSingleDiffRow(buildWriteOverwriteGuardText(guard, width), "warning", width, theme);
}

/** Folded write with `writeDiffCollapsedLines: 0`: `↳ created • click to show more`. */
function renderWriteCollapsedHintLine(
	wasOverwrite: boolean,
	width: number,
	theme: DiffTheme,
	hovered: boolean,
	headerLabel?: string,
): string[] {
	const safeWidth = normalizeDiffRenderWidth(width);
	if (safeWidth === 0) {
		return [""];
	}
	const actionLabel = headerLabel?.trim() || (wasOverwrite ? "overwritten" : "created");
	const clickLabel = showMoreHintText();
	const candidates = [`↳ ${actionLabel} • ${clickLabel}`, `↳ ${actionLabel}`, actionLabel, "…"];
	let text = candidates[candidates.length - 1] ?? "…";
	for (const candidate of candidates) {
		if (visibleWidth(candidate) <= safeWidth) {
			text = candidate;
			break;
		}
	}
	if (visibleWidth(text) > safeWidth) {
		text = truncateToWidth(text, safeWidth, "");
	}
	const clickIndex = text.lastIndexOf(clickLabel);
	const styled =
		hovered && clickIndex >= 0
			? theme.fg("muted", text.slice(0, clickIndex)) +
				theme.fg("text", clickLabel) +
				theme.fg("muted", text.slice(clickIndex + clickLabel.length))
			: theme.fg("muted", text);
	return [clampDiffLineToWidth(styled, safeWidth)];
}

/**
 * write 变更行统计（compact 单行用）：复用当前 write diff 算法。
 * 新文件 = 全部新内容为 added；覆盖已有文件用 LCS 精确统计。
 * content 非字符串、元数据缺失或超过矩阵预算时返回 undefined（不显示计数）。
 */
export function countWriteDiffStats(
	content: string | undefined,
	previousContent: string | undefined,
	fileExistedBeforeWrite: boolean | undefined,
): { added: number; removed: number } | undefined {
	if (typeof content !== "string" || fileExistedBeforeWrite === undefined) return undefined;
	const lines = splitWriteContentLines(sanitizeToolResultText(content));
	if (fileExistedBeforeWrite === false) return { added: lines.length, removed: 0 };
	if (typeof previousContent !== "string") return undefined;
	const previousLines = splitWriteContentLines(sanitizeToolResultText(previousContent));
	if (previousLines.length === 0 || lines.length === 0) {
		return { added: lines.length, removed: previousLines.length };
	}
	if (previousLines.length * lines.length > MAX_COLLAPSED_WRITE_OVERWRITE_DIFF_MATRIX_CELLS) {
		return undefined;
	}
	let added = 0;
	let removed = 0;
	for (const operation of buildWriteDiffOperations(previousLines, lines)) {
		if (operation.kind === "add") added++;
		else if (operation.kind === "remove") removed++;
	}
	return { added, removed };
}

export function renderWriteDiffResult(
	content: string | undefined,
	options: DiffRenderOptions,
	config: DisplayConfigInput,
	theme: DiffTheme,
	fallbackText: string,
): Component {
	const safeFallbackText = sanitizeToolResultText(fallbackText);
	if (typeof content !== "string") {
		if (!safeFallbackText.trim()) {
			return new Text(theme.fg("muted", "↳ write completed"), 0, 0);
		}
		return new Text(theme.fg("toolOutput", safeFallbackText), 0, 0);
	}

	const filePath = options.filePath?.trim() || "(unknown path)";
	const lines = splitWriteContentLines(sanitizeToolResultText(content));
	const previousLines =
		typeof options.previousContent === "string"
			? splitWriteContentLines(sanitizeToolResultText(options.previousContent))
			: [];
	const hasComparablePrevious =
		options.fileExistedBeforeWrite === true && typeof options.previousContent === "string";
	const approximateStats = buildApproximateWriteStats(
		lines.length,
		previousLines.length,
		hasComparablePrevious,
	);
	const palette = resolveDiffPalette(theme);
	// Keep the panel transparent; changed rows and inline spans retain their own highlights.
	const containerBgAnsi = undefined;
	const language = resolveLanguageFromPath(filePath);
	const cache = createDiffRenderCache();
	let highlightLine: CodeLineHighlighter | undefined;
	let detailedData: WriteDiffData | undefined;

	function getDetailedData(): WriteDiffData {
		if (detailedData) {
			return detailedData;
		}
		const entries = hasComparablePrevious
			? buildWriteOverwriteEntries(previousLines, lines)
			: buildWriteEntries(lines);
		detailedData = buildWriteDiffData(entries);
		highlightLine = createCodeLineHighlighter(language, theme, entries, () => {
			cache.invalidate();
			options.invalidate?.();
		});
		return detailedData;
	}

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
			const resolvedMode = resolveDiffPresentationMode(
				live,
				safeWidth,
				canRenderSplitLayout(safeWidth),
			);
			const mode: DiffPresentationMode = hasComparablePrevious
				? resolvedMode
				: resolvedMode === "split"
					? "unified"
					: resolvedMode;
			const hovered = options.isHovered?.() ?? false;
			const cached = cache.get(safeWidth, options.expanded, mode, configKey, hovered);
			if (cached) {
				return cached;
			}

			const writeCollapsedLimit = resolveWriteCollapsedLimit(live);
			const statsOnlyCollapsed = !options.expanded && writeCollapsedLimit === 0;
			if (statsOnlyCollapsed) {
				const hintLines = renderWriteCollapsedHintLine(
					options.fileExistedBeforeWrite === true,
					safeWidth,
					theme,
					hovered,
					options.headerLabel,
				);
				return cache.set(
					safeWidth,
					options.expanded,
					mode,
					configKey,
					hovered,
					clampDiffLinesToWidth(hintLines, safeWidth),
					normalizeCollapsedHintLine(hintLines[0]),
				);
			}

			const header = renderWriteHeader(
				options.fileExistedBeforeWrite === true,
				safeWidth,
				theme,
				options.headerLabel,
			);
			// Guard depends on expanded: collapsed previews use a stricter LCS cell budget.
			const overwriteGuard = hasComparablePrevious
				? resolveWriteOverwriteGuard(previousLines, lines, options.expanded)
				: undefined;
			if (overwriteGuard) {
				return cache.set(
					safeWidth,
					options.expanded,
					mode,
					configKey,
					hovered,
					clampDiffLinesToWidth(
						[header, ...renderWriteOverwriteGuardRows(overwriteGuard, safeWidth, theme)],
						safeWidth,
					),
				);
			}

			if (mode === "summary") {
				const summaryRows =
					approximateStats.lines === 0
						? [header]
						: [
								header,
								...renderSingleDiffRow(
									buildDiffSummaryText(approximateStats, safeWidth),
									"toolOutput",
									safeWidth,
									theme,
								),
							];
				return cache.set(
					safeWidth,
					options.expanded,
					mode,
					configKey,
					hovered,
					clampDiffLinesToWidth(summaryRows, safeWidth),
				);
			}

			const data = getDetailedData();
			const displayLimit = resolveDiffDisplayLimit(options.expanded, writeCollapsedLimit);
			const processBudget = resolveDiffProcessBudget(displayLimit, wordWrap);
			const entryBudget = takeEntriesForLineBudget(data.entries, processBudget);
			const splitBudget = takeSplitRowsForBudget(data.splitRows, processBudget);
			const inlineHighlights =
				splitBudget.processedRows < splitBudget.totalRows
					? buildInlineHighlightMap(splitBudget.rows)
					: data.inlineHighlights;
			const renderCtx: DiffRenderContext = {
				width: safeWidth,
				theme,
				inlineHighlights,
				palette,
				highlightLine: highlightLine!,
				containerBgAnsi,
				wordWrap,
				indicatorMode,
				showHashlineAnchors: false,
			};
			const bodyRows: RenderedRow[] =
				entryBudget.entries.length === 0
					? [{ text: theme.fg("muted", "(empty file)"), hunkIndex: null }]
					: mode === "split"
						? renderSplit(splitBudget.rows, renderCtx, data.lineNumberWidth)
						: mode === "compact"
							? renderCompact(entryBudget.entries, renderCtx)
							: renderUnified(entryBudget.entries, renderCtx, data.lineNumberWidth);
			const unprocessedLogicalRows =
				mode === "split"
					? Math.max(0, splitBudget.totalRows - splitBudget.processedRows)
					: Math.max(0, entryBudget.totalLineEntries - entryBudget.processedLineEntries);

			const bodyWithLimit = applyLineLimit(
				bodyRows,
				safeWidth,
				options.expanded,
				writeCollapsedLimit,
				data.hunkCount,
				theme,
				unprocessedLogicalRows,
				hovered,
			);
			const frame = renderDiffFrameLine(safeWidth, theme);
			const renderedLines =
				mode === "unified"
					? [header, frame, ...bodyWithLimit.lines, frame]
					: [header, ...bodyWithLimit.lines];
			const finalLines = clampDiffLinesToWidth(renderedLines, safeWidth);
			return cache.set(
				safeWidth,
				options.expanded,
				mode,
				configKey,
				hovered,
				finalLines,
				normalizeCollapsedHintLine(bodyWithLimit.hintLine),
			);
		},
		invalidate: cache.invalidate,
	} as Component;
}
