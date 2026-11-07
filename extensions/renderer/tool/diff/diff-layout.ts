import { visibleWidth } from "@earendil-works/pi-tui";
import { fitToWidth, normalizeCodeWhitespace, wrapToWidth } from "./diff-text.ts";
import {
	ANSI_BG_RESET,
	applyLineBackgroundToWrappedRows,
	colorizeSegment,
	readThemeAnsi,
	stabilizeBackgroundResets,
	type DiffPalette,
	type DiffTheme,
} from "./diff-palette.ts";
import { highlightDiffLine, type CodeLineHighlighter } from "./diff-highlight.ts";
import {
	formatLineNumberLabel,
	getCompactLineRenderContent,
	type DiffLineEntry,
	type DiffLineKind,
	type DiffMetaEntry,
	type DiffOmissionEntry,
	type ParsedDiffEntry,
} from "./diff-parse.ts";
import { getCellLineNumber, type DiffSpan, type SplitDiffRow } from "./diff-inline.ts";
import { formatMetaEntryRows } from "./diff-header.ts";
import type { DiffIndicatorMode } from "../../../config/config.ts";

export interface RenderedRow {
	text: string;
	hunkIndex: number | null;
}

type MaterializedDiffEntry = DiffLineEntry | DiffMetaEntry;

interface LineCellRenderParams {
	kind: DiffLineKind;
	code: string;
	width: number;
	rowBg: string | undefined;
	restoreBgAnsi: string | undefined;
	theme: DiffTheme;
	wordWrap: boolean;
	indicatorMode: DiffIndicatorMode;
}

export interface DiffRenderContext {
	width: number;
	theme: DiffTheme;
	inlineHighlights: WeakMap<DiffLineEntry, DiffSpan[]>;
	palette: DiffPalette;
	highlightLine: CodeLineHighlighter;
	containerBgAnsi: string | undefined;
	wordWrap: boolean;
	indicatorMode: DiffIndicatorMode;
	showHashlineAnchors: boolean;
}

const SPLIT_SEPARATOR = " │ ";
const OMISSION_GLYPH = "⋮";
const MIN_SPLIT_COLUMN_WIDTH = 24;

function resolveIndicatorGlyph(
	kind: DiffLineKind,
	indicatorMode: DiffIndicatorMode,
	continuation: boolean,
): string {
	if (kind === "context") {
		return " ";
	}

	switch (indicatorMode) {
		case "bars":
			return "▌";
		case "classic":
			if (continuation) {
				return " ";
			}
			return kind === "add" ? "+" : "-";
		case "none":
		default:
			return " ";
	}
}

function renderChangeMarker(
	kind: DiffLineKind,
	theme: DiffTheme,
	rowBg: string | undefined,
	indicatorMode: DiffIndicatorMode,
	continuation = false,
): string {
	const glyph = resolveIndicatorGlyph(kind, indicatorMode, continuation);
	if (glyph === " ") {
		return rowBg ? `${rowBg} ${rowBg}` : " ";
	}
	if (kind === "add") {
		return colorizeSegment(theme, "success", glyph, rowBg);
	}
	if (kind === "remove") {
		return colorizeSegment(theme, "error", glyph, rowBg);
	}
	return colorizeSegment(theme, "dim", glyph, rowBg);
}

function usesHashlineGutter(showHashlineAnchors: boolean): boolean {
	return showHashlineAnchors;
}

function getHashlineGutterMarkerWidth(_indicatorMode: DiffIndicatorMode): number {
	return 0;
}

function getLineDividerPlainWidth(
	indicatorMode: DiffIndicatorMode,
	hashlineGutter = false,
): number {
	if (hashlineGutter) {
		return 2;
	}
	return indicatorMode === "classic" ? 1 : 2;
}

function renderCodeDivider(
	theme: DiffTheme,
	rowBg: string | undefined,
	indicatorMode: DiffIndicatorMode,
	hashlineGutter = false,
): string {
	return colorizeSegment(
		theme,
		"dim",
		hashlineGutter || indicatorMode !== "classic" ? "│ " : "│",
		rowBg,
	);
}

function getLineNumberColor(kind: DiffLineKind): "dim" | "success" | "error" {
	if (kind === "add") {
		return "success";
	}
	if (kind === "remove") {
		return "error";
	}
	return "dim";
}

function renderLineNumberSegment(
	kind: DiffLineKind,
	lineNumber: string,
	theme: DiffTheme,
	rowBg: string | undefined,
): string {
	return colorizeSegment(theme, getLineNumberColor(kind), lineNumber, rowBg);
}

function getLinePrefixPlainWidth(
	lineNumberWidth: number,
	indicatorMode: DiffIndicatorMode,
	hashlineGutter = false,
): number {
	if (hashlineGutter) {
		return getHashlineGutterMarkerWidth(indicatorMode) + lineNumberWidth;
	}
	return indicatorMode === "bars"
		? visibleWidth(`▌ ${" ".repeat(lineNumberWidth)} `)
		: visibleWidth(`${" ".repeat(lineNumberWidth)} `);
}

function getLineContentIndicatorPrefixPlainWidth(indicatorMode: DiffIndicatorMode): number {
	return indicatorMode === "classic" ? 2 : 0;
}

function renderClassicContentPrefix(
	kind: DiffLineKind,
	theme: DiffTheme,
	rowBg: string | undefined,
	continuation = false,
): string {
	if (kind === "context" || continuation) {
		return rowBg ? `${rowBg}  ${rowBg}` : "  ";
	}

	const glyph = kind === "add" ? "+" : "-";
	const glyphColor = kind === "add" ? "success" : "error";
	const spacer = rowBg ? `${rowBg} ` : " ";
	return `${colorizeSegment(theme, glyphColor, glyph, rowBg)}${spacer}`;
}

function renderLinePrefix(
	kind: DiffLineKind,
	lineNumber: string,
	theme: DiffTheme,
	rowBg: string | undefined,
	indicatorMode: DiffIndicatorMode,
	continuation = false,
	hashlineGutter = false,
): string {
	const number = renderLineNumberSegment(kind, lineNumber, theme, rowBg);
	if (hashlineGutter) {
		return number;
	}
	const spacer = rowBg ? `${rowBg} ` : " ";
	if (indicatorMode !== "bars") {
		return `${number}${spacer}`;
	}
	const marker = renderChangeMarker(kind, theme, rowBg, indicatorMode, continuation);
	return `${marker}${spacer}${number}${spacer}`;
}

function renderLineContinuationPrefix(
	kind: DiffLineKind,
	lineNumberWidth: number,
	rowBg: string | undefined,
	theme: DiffTheme,
	indicatorMode: DiffIndicatorMode,
	hashlineGutter = false,
): string {
	const blankLineNumber = " ".repeat(lineNumberWidth);
	return renderLinePrefix(kind, blankLineNumber, theme, rowBg, indicatorMode, true, hashlineGutter);
}

function renderLineContentIndicatorPrefix(
	kind: DiffLineKind,
	theme: DiffTheme,
	rowBg: string | undefined,
	indicatorMode: DiffIndicatorMode,
	continuation = false,
): string {
	return indicatorMode === "classic"
		? renderClassicContentPrefix(kind, theme, rowBg, continuation)
		: "";
}

function renderCompactLinePrefix(
	kind: DiffLineKind,
	theme: DiffTheme,
	rowBg: string | undefined,
	indicatorMode: DiffIndicatorMode,
	continuation = false,
): string {
	const marker = renderChangeMarker(kind, theme, rowBg, indicatorMode, continuation);
	const spacer = rowBg ? `${rowBg} ` : " ";
	return `${marker}${spacer}`;
}

function renderWrappedRowsWithOptionalBackground(
	wrappedCodeLines: string[],
	buildRow: (index: number, wrappedCodeLine: string) => string,
	width: number,
	rowBg: string | undefined,
	restoreBgAnsi: string | undefined,
): string[] {
	if (!rowBg) {
		return wrappedCodeLines.map((wrappedCodeLine, index) =>
			stabilizeBackgroundResets(buildRow(index, wrappedCodeLine)),
		);
	}
	const safeRestoreBgAnsi = restoreBgAnsi ?? rowBg ?? ANSI_BG_RESET;
	const visualRows = wrappedCodeLines.map((wrappedCodeLine, index) =>
		buildRow(index, wrappedCodeLine),
	);
	return applyLineBackgroundToWrappedRows(visualRows, width, rowBg, safeRestoreBgAnsi);
}

function computeLineCellCodeWidth(
	width: number,
	lineNumberWidth: number,
	indicatorMode: DiffIndicatorMode,
	hashlineGutter: boolean,
): number {
	const prefixPlainWidth = getLinePrefixPlainWidth(lineNumberWidth, indicatorMode, hashlineGutter);
	const dividerPlainWidth = getLineDividerPlainWidth(indicatorMode, hashlineGutter);
	const contentIndicatorWidth = hashlineGutter
		? 0
		: getLineContentIndicatorPrefixPlainWidth(indicatorMode);
	return Math.max(0, width - prefixPlainWidth - dividerPlainWidth - contentIndicatorWidth);
}

function buildLineCellParams(
	kind: DiffLineKind,
	code: string,
	width: number,
	rowBg: string | undefined,
	restoreBgAnsi: string | undefined,
	theme: DiffTheme,
	wordWrap: boolean,
	indicatorMode: DiffIndicatorMode,
): LineCellRenderParams {
	return { kind, code, width, rowBg, restoreBgAnsi, theme, wordWrap, indicatorMode };
}

function renderCompactLineCell({
	kind,
	code,
	width,
	rowBg,
	restoreBgAnsi,
	theme,
	wordWrap,
	indicatorMode,
}: LineCellRenderParams): string[] {
	if (width <= 0) {
		return [""];
	}

	const prefix = renderCompactLinePrefix(kind, theme, undefined, indicatorMode);
	const continuationPrefix = renderCompactLinePrefix(kind, theme, undefined, indicatorMode, true);
	const prefixPlainWidth = 2;
	const codeWidth = Math.max(0, width - prefixPlainWidth);
	const wrappedCodeLines = wrapToWidth(code, codeWidth, wordWrap);
	return renderWrappedRowsWithOptionalBackground(
		wrappedCodeLines,
		(index, line) => `${index === 0 ? prefix : continuationPrefix}${line}`,
		width,
		rowBg,
		restoreBgAnsi,
	);
}

function renderLineCell(
	{ kind, code, width, rowBg, restoreBgAnsi, theme, wordWrap, indicatorMode }: LineCellRenderParams,
	lineNumber: string,
	hashlineGutter = false,
): string[] {
	if (width <= 0) {
		return [""];
	}

	const codeWidth = computeLineCellCodeWidth(
		width,
		lineNumber.length,
		indicatorMode,
		hashlineGutter,
	);
	const prefix = renderLinePrefix(
		kind,
		lineNumber,
		theme,
		undefined,
		indicatorMode,
		false,
		hashlineGutter,
	);
	const continuationPrefix = renderLineContinuationPrefix(
		kind,
		lineNumber.length,
		undefined,
		theme,
		indicatorMode,
		hashlineGutter,
	);
	const divider = renderCodeDivider(theme, undefined, indicatorMode, hashlineGutter);
	const firstContentPrefix = hashlineGutter
		? ""
		: renderLineContentIndicatorPrefix(kind, theme, undefined, indicatorMode);
	const continuationContentPrefix = hashlineGutter
		? ""
		: renderLineContentIndicatorPrefix(kind, theme, undefined, indicatorMode, true);
	const wrappedCodeLines = wrapToWidth(code, codeWidth, wordWrap);
	return renderWrappedRowsWithOptionalBackground(
		wrappedCodeLines,
		(index, line) => {
			const linePrefix = index === 0 ? prefix : continuationPrefix;
			const contentPrefix = index === 0 ? firstContentPrefix : continuationContentPrefix;
			return `${linePrefix}${divider}${contentPrefix}${line}`;
		},
		width,
		rowBg,
		restoreBgAnsi,
	);
}

// Reuse line-cell layout without treating omissions as parsed source lines.
function createOmissionRenderLine(entry: DiffOmissionEntry, compact = false): DiffLineEntry {
	return {
		kind: "line",
		lineKind: "context",
		oldLineNumber: null,
		newLineNumber: null,
		fallbackLineNumber: compact ? "" : OMISSION_GLYPH,
		content: compact ? OMISSION_GLYPH : "",
		raw: entry.raw,
		hunkIndex: entry.hunkIndex,
	};
}

function materializeOmissionEntries(
	entries: ParsedDiffEntry[],
	compact = false,
): MaterializedDiffEntry[] {
	return entries.map((entry) =>
		entry.kind === "omission" ? createOmissionRenderLine(entry, compact) : entry,
	);
}

function pushDiffLineRows(rows: RenderedRow[], lines: string[], entry: DiffLineEntry): void {
	rows.push(
		...lines.map((text) => ({
			text,
			hunkIndex: entry.hunkIndex || null,
		})),
	);
}

function processDiffEntries(
	entries: MaterializedDiffEntry[],
	ctx: DiffRenderContext,
	processLine: (entry: DiffLineEntry) => string[],
): RenderedRow[] {
	const { width, theme, wordWrap } = ctx;
	const rows: RenderedRow[] = [];
	for (const entry of entries) {
		if (entry.kind !== "line") {
			rows.push(...formatMetaEntryRows(entry, width, theme, wordWrap));
			continue;
		}
		pushDiffLineRows(rows, processLine(entry), entry);
	}
	return rows;
}

export function renderUnified(
	entries: ParsedDiffEntry[],
	ctx: DiffRenderContext,
	lineNumberWidth: number,
): RenderedRow[] {
	return processDiffEntries(materializeOmissionEntries(entries), ctx, (entry) => {
		const lineNumber =
			entry.lineKind === "add"
				? formatLineNumberLabel(
						entry,
						entry.newLineNumber,
						entry.fallbackLineNumber,
						lineNumberWidth,
						ctx.showHashlineAnchors,
					)
				: formatLineNumberLabel(
						entry,
						entry.oldLineNumber,
						entry.fallbackLineNumber,
						lineNumberWidth,
						ctx.showHashlineAnchors,
					);
		const codeText = normalizeCodeWhitespace(entry.content);
		const { highlighted, rowBg } = highlightDiffLine(
			codeText,
			entry,
			ctx.inlineHighlights,
			ctx.palette,
			ctx.highlightLine,
			ctx.containerBgAnsi,
		);
		return renderLineCell(
			buildLineCellParams(
				entry.lineKind,
				highlighted,
				ctx.width,
				rowBg,
				ctx.containerBgAnsi,
				ctx.theme,
				ctx.wordWrap,
				ctx.indicatorMode,
			),
			lineNumber,
			usesHashlineGutter(ctx.showHashlineAnchors),
		);
	});
}

function toUnifiedFallbackRows(
	rows: SplitDiffRow[],
	ctx: DiffRenderContext,
	lineNumberWidth: number,
): RenderedRow[] {
	const flattened: ParsedDiffEntry[] = [];
	for (const row of rows) {
		if (row.omission) {
			flattened.push(row.omission);
			continue;
		}
		if (row.meta) {
			flattened.push(row.meta);
			continue;
		}
		if (row.left) {
			flattened.push(row.left);
		}
		if (row.right && row.right !== row.left) {
			flattened.push(row.right);
		}
	}
	return renderUnified(flattened, ctx, lineNumberWidth);
}

export function renderCompact(entries: ParsedDiffEntry[], ctx: DiffRenderContext): RenderedRow[] {
	return processDiffEntries(materializeOmissionEntries(entries, true), ctx, (entry) => {
		const codeText = normalizeCodeWhitespace(
			getCompactLineRenderContent(entry, ctx.showHashlineAnchors),
		);
		const { highlighted, rowBg } = highlightDiffLine(
			codeText,
			entry,
			ctx.inlineHighlights,
			ctx.palette,
			ctx.highlightLine,
			ctx.containerBgAnsi,
		);
		return renderCompactLineCell(
			buildLineCellParams(
				entry.lineKind,
				highlighted,
				ctx.width,
				rowBg,
				ctx.containerBgAnsi,
				ctx.theme,
				ctx.wordWrap,
				ctx.indicatorMode,
			),
		);
	});
}

function renderSplitBlankCell(
	columnWidth: number,
	lineNumberWidth: number,
	theme: DiffTheme,
	indicatorMode: DiffIndicatorMode,
	hashlineGutter = false,
): string {
	const codeWidth = computeLineCellCodeWidth(
		columnWidth,
		lineNumberWidth,
		indicatorMode,
		hashlineGutter,
	);
	const prefix = renderLinePrefix(
		"context",
		" ".repeat(lineNumberWidth),
		theme,
		undefined,
		indicatorMode,
		true,
		hashlineGutter,
	);
	const divider = renderCodeDivider(theme, undefined, indicatorMode, hashlineGutter);
	const contentPrefix = hashlineGutter
		? ""
		: renderLineContentIndicatorPrefix("context", theme, undefined, indicatorMode, true);
	return stabilizeBackgroundResets(`${prefix}${divider}${contentPrefix}${" ".repeat(codeWidth)}`);
}

function renderSplitCell(
	line: DiffLineEntry | undefined,
	side: "left" | "right",
	columnWidth: number,
	lineNumberWidth: number,
	theme: DiffTheme,
	inlineHighlights: WeakMap<DiffLineEntry, DiffSpan[]>,
	palette: DiffPalette,
	highlightLine: CodeLineHighlighter,
	containerBgAnsi: string | undefined,
	wordWrap: boolean,
	indicatorMode: DiffIndicatorMode,
	showHashlineAnchors: boolean,
): string[] {
	const hashlineGutter = usesHashlineGutter(showHashlineAnchors);
	if (!line) {
		return [
			renderSplitBlankCell(columnWidth, lineNumberWidth, theme, indicatorMode, hashlineGutter),
		];
	}

	const lineNumber = formatLineNumberLabel(
		line,
		getCellLineNumber(line, side),
		line.fallbackLineNumber,
		lineNumberWidth,
		showHashlineAnchors,
	);
	const codeText = normalizeCodeWhitespace(line.content);
	const { highlighted, rowBg } = highlightDiffLine(
		codeText,
		line,
		inlineHighlights,
		palette,
		highlightLine,
		containerBgAnsi,
	);
	return renderLineCell(
		buildLineCellParams(
			line.lineKind,
			highlighted,
			columnWidth,
			rowBg,
			containerBgAnsi,
			theme,
			wordWrap,
			indicatorMode,
		),
		lineNumber,
		hashlineGutter,
	);
}

function renderSplitDivider(
	theme: DiffTheme,
	containerBgAnsi: string | undefined,
	separatorText: string = SPLIT_SEPARATOR,
): string {
	const dimAnsi = readThemeAnsi(theme, "fg", "dim");
	if (!containerBgAnsi) {
		return stabilizeBackgroundResets(theme.fg("dim", separatorText));
	}
	if (!dimAnsi) {
		return stabilizeBackgroundResets(
			`${containerBgAnsi}${theme.fg("dim", separatorText)}${containerBgAnsi}`,
		);
	}
	return stabilizeBackgroundResets(
		`${containerBgAnsi}${dimAnsi}${separatorText}\x1b[39m${containerBgAnsi}`,
	);
}

function renderSplitTopBorderCell(
	columnWidth: number,
	lineNumberWidth: number,
	theme: DiffTheme,
	indicatorMode: DiffIndicatorMode,
	hashlineGutter = false,
): string {
	const safeColumnWidth = Math.max(1, columnWidth);
	const chars = "─".repeat(safeColumnWidth).split("");
	const dividerIndex = getLinePrefixPlainWidth(lineNumberWidth, indicatorMode, hashlineGutter);
	if (dividerIndex >= 0 && dividerIndex < chars.length) {
		chars[dividerIndex] = "┬";
	}
	return stabilizeBackgroundResets(theme.fg("dim", chars.join("")));
}

function renderSplitHeaderCell(
	label: string,
	columnWidth: number,
	lineNumberWidth: number,
	theme: DiffTheme,
	indicatorMode: DiffIndicatorMode,
	hashlineGutter = false,
): string {
	const markerPad = hashlineGutter
		? " ".repeat(getHashlineGutterMarkerWidth(indicatorMode))
		: indicatorMode === "bars"
			? "  "
			: "";
	const lineNumberLabel = fitToWidth(label, lineNumberWidth);
	const lineNumberSpacer = hashlineGutter ? "" : " ";
	const divider = hashlineGutter || indicatorMode !== "classic" ? "│ " : "│";
	const prefix = `${theme.fg("dim", markerPad)}${theme.fg("muted", lineNumberLabel)}${theme.fg("dim", lineNumberSpacer)}${theme.fg("dim", divider)}`;
	const prefixWidth = visibleWidth(`${markerPad}${lineNumberLabel}${lineNumberSpacer}${divider}`);
	const contentIndicatorWidth = hashlineGutter
		? 0
		: getLineContentIndicatorPrefixPlainWidth(indicatorMode);
	const codeWidth = Math.max(0, columnWidth - prefixWidth - contentIndicatorWidth);
	const contentPad = !hashlineGutter && indicatorMode === "classic" ? "  " : "";
	return stabilizeBackgroundResets(`${prefix}${contentPad}${" ".repeat(codeWidth)}`);
}

export function canRenderSplitLayout(width: number): boolean {
	const separatorWidth = visibleWidth(SPLIT_SEPARATOR);
	const minimumSplitWidth = MIN_SPLIT_COLUMN_WIDTH * 2 + separatorWidth;
	return width >= minimumSplitWidth;
}

export function renderSplit(
	rows: SplitDiffRow[],
	ctx: DiffRenderContext,
	lineNumberWidth: number,
): RenderedRow[] {
	const {
		width,
		theme,
		inlineHighlights,
		palette,
		highlightLine,
		containerBgAnsi,
		wordWrap,
		indicatorMode,
		showHashlineAnchors,
	} = ctx;
	if (!canRenderSplitLayout(width)) {
		return toUnifiedFallbackRows(rows, ctx, lineNumberWidth);
	}

	const separatorWidth = visibleWidth(SPLIT_SEPARATOR);
	const leftWidth = Math.max(MIN_SPLIT_COLUMN_WIDTH, Math.floor((width - separatorWidth) / 2));
	const rightWidth = Math.max(MIN_SPLIT_COLUMN_WIDTH, width - separatorWidth - leftWidth);
	const splitLineNumberWidth = Math.max(3, lineNumberWidth);
	const hashlineGutter = usesHashlineGutter(showHashlineAnchors);
	const separator = renderSplitDivider(theme, containerBgAnsi);
	const topSeparator = renderSplitDivider(theme, containerBgAnsi, "─┬─");
	const output: RenderedRow[] = [];
	output.push({
		text: `${renderSplitTopBorderCell(leftWidth, splitLineNumberWidth, theme, indicatorMode, hashlineGutter)}${topSeparator}${renderSplitTopBorderCell(rightWidth, splitLineNumberWidth, theme, indicatorMode, hashlineGutter)}`,
		hunkIndex: null,
	});
	output.push({
		text: `${renderSplitHeaderCell("old", leftWidth, splitLineNumberWidth, theme, indicatorMode, hashlineGutter)}${separator}${renderSplitHeaderCell("new", rightWidth, splitLineNumberWidth, theme, indicatorMode, hashlineGutter)}`,
		hunkIndex: null,
	});

	for (const row of rows) {
		if (row.meta) {
			output.push(...formatMetaEntryRows(row.meta, width, theme, wordWrap));
			continue;
		}

		const omissionLine = row.omission ? createOmissionRenderLine(row.omission) : undefined;
		const leftCells = renderSplitCell(
			omissionLine ?? row.left,
			"left",
			leftWidth,
			splitLineNumberWidth,
			theme,
			inlineHighlights,
			palette,
			highlightLine,
			containerBgAnsi,
			wordWrap,
			indicatorMode,
			showHashlineAnchors,
		);
		const rightCells = renderSplitCell(
			omissionLine ?? row.right,
			"right",
			rightWidth,
			splitLineNumberWidth,
			theme,
			inlineHighlights,
			palette,
			highlightLine,
			containerBgAnsi,
			wordWrap,
			indicatorMode,
			showHashlineAnchors,
		);

		const rowCount = Math.max(leftCells.length, rightCells.length);
		for (let index = 0; index < rowCount; index++) {
			const leftCell =
				leftCells[index] ??
				renderSplitBlankCell(leftWidth, splitLineNumberWidth, theme, indicatorMode, hashlineGutter);
			const rightCell =
				rightCells[index] ??
				renderSplitBlankCell(
					rightWidth,
					splitLineNumberWidth,
					theme,
					indicatorMode,
					hashlineGutter,
				);
			output.push({ text: `${leftCell}${separator}${rightCell}`, hunkIndex: row.hunkIndex });
		}
	}

	return output;
}
