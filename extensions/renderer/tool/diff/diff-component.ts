import {
	DEFAULT_TOOL_DISPLAY_CONFIG,
	type DiffIndicatorMode,
	type ToolDisplayConfig,
} from "../../../config/config.ts";
import { stripTerminalSequencesPreservingLayout } from "../../../utils/ansi-text.ts";
import { RICH_DIFF_COMPONENT } from "../../../utils/patch-keys.ts";
import type { DiffPresentationMode } from "./diff-presentation.ts";
export { RICH_DIFF_COMPONENT };

/** Snapshot or live getter — panel changes must apply on the next paint. */
export type DisplayConfigInput = ToolDisplayConfig | (() => ToolDisplayConfig);

export interface DiffRenderOptions {
	expanded: boolean;
	filePath?: string;
	previousContent?: string;
	fileExistedBeforeWrite?: boolean;
	headerLabel?: string;
	/** Live hover state for the collapsed hint row (muted → text on hover). */
	isHovered?: () => boolean;
	invalidate?: () => void;
}

export function isRichDiffComponent(value: unknown): boolean {
	return Boolean(
		value &&
			typeof value === "object" &&
			(value as Record<symbol, unknown>)[RICH_DIFF_COMPONENT] === true,
	);
}

export function resolveLiveDisplayConfig(input: DisplayConfigInput): ToolDisplayConfig {
	return typeof input === "function" ? input() : input;
}

/**
 * 比对用归一化：ANSI、缩进前缀和右侧填充不影响判断。
 * 折叠态 remainder 行里有任意正文，入口必须先由组件声明再比对文本。
 */
export function normalizeCollapsedHintLine(line: string | undefined): string | undefined {
	if (line === undefined) return undefined;
	return stripTerminalSequencesPreservingLayout(line).replace(/\s+/g, " ").trim();
}

/** Cache key fragment so indicator/wrap/limits invalidate without host recreate. */
export function displayConfigCacheKey(config: ToolDisplayConfig): string {
	return [
		config.diffViewMode,
		config.diffIndicatorMode,
		String(config.diffSplitMinWidth),
		String(config.editDiffCollapsedLines),
		String(config.writeDiffCollapsedLines),
		config.diffWordWrap ? "1" : "0",
	].join(":");
}

export function resolveDiffIndicatorMode(
	config: Partial<Pick<ToolDisplayConfig, "diffIndicatorMode">>,
): DiffIndicatorMode {
	return config.diffIndicatorMode ?? DEFAULT_TOOL_DISPLAY_CONFIG.diffIndicatorMode;
}

export function createDiffRenderCache() {
	let cachedWidth: number | undefined;
	let cachedExpanded: boolean | undefined;
	let cachedMode: DiffPresentationMode | undefined;
	let cachedConfigKey: string | undefined;
	let cachedHovered: boolean | undefined;
	let cachedLines: string[] | undefined;
	/** 与 cachedLines 同一次渲染的折叠态 remainder 行文本。 */
	let cachedHintLine: string | undefined;

	return {
		get(
			width: number,
			expanded: boolean,
			mode: DiffPresentationMode,
			configKey: string,
			hovered: boolean,
		): string[] | undefined {
			if (
				cachedLines &&
				cachedWidth === width &&
				cachedExpanded === expanded &&
				cachedMode === mode &&
				cachedConfigKey === configKey &&
				cachedHovered === hovered
			) {
				return cachedLines;
			}
			return undefined;
		},
		getHintLine(): string | undefined {
			return cachedHintLine;
		},
		set(
			width: number,
			expanded: boolean,
			mode: DiffPresentationMode,
			configKey: string,
			hovered: boolean,
			lines: string[],
			hintLine?: string,
		): string[] {
			cachedWidth = width;
			cachedExpanded = expanded;
			cachedMode = mode;
			cachedConfigKey = configKey;
			cachedHovered = hovered;
			cachedLines = lines;
			cachedHintLine = hintLine;
			return lines;
		},
		invalidate(): void {
			cachedWidth = undefined;
			cachedExpanded = undefined;
			cachedMode = undefined;
			cachedConfigKey = undefined;
			cachedHovered = undefined;
			cachedLines = undefined;
			cachedHintLine = undefined;
		},
	};
}
