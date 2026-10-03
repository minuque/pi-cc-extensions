/**
 * 顶层共享的 ANSI/终端控制序列处理。
 *
 * 收敛原先散落在 renderer/grouping.ts / renderer/mouse/packets.ts /
 * renderer/compact-mode.ts 的重复剥离逻辑，供 renderer 与 feature 共用。
 */

/** 单个 CSI 序列（颜色、光标等 SGR/CUP/ED 等）。 */
const CSI_SEQUENCE_RE = /\x1b\[[0-?]*[ -/]*[@-~]/g;
/** OSC 序列（如 \x1b]8;;url\x07 或 ST 结尾）。 */
const OSC_SEQUENCE_RE = /\x1b\][^\x07]*(?:\x07|\x1b\\)/g;
/** compact-mode 原有 hasVisibleText 用的更严格 OSC（内容不允许内嵌 ESC）。 */
const OSC_SEQUENCE_STRICT_RE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

/** 剥离一行内所有 CSI 序列。 */
export function stripAnsi(line: string): string {
	return line.replace(CSI_SEQUENCE_RE, "");
}

/** 仅剥离终端序列、保留原布局（换行/空白不动），用于命中区间计算。 */
export function stripTerminalSequencesPreservingLayout(value: string): string {
	return value.replace(OSC_SEQUENCE_RE, "").replace(CSI_SEQUENCE_RE, "");
}

/** 剥离终端序列并折叠空白（用于纯文本比较）。 */
export function stripTerminalSequences(value: string): string {
	return stripTerminalSequencesPreservingLayout(value).replace(/\s+/g, " ").trim();
}

/** 去掉行内所有 CSI/OSC 序列后是否仍有可见文本（判断工具卡首尾内容行）。 */
export function hasVisibleText(line: string): boolean {
	// OSC 用更严格的变体：内容内嵌 ESC 时不吞并后续文本，保持 compact-mode 原有语义。
	return line.replace(CSI_SEQUENCE_RE, "").replace(OSC_SEQUENCE_STRICT_RE, "").trim().length > 0;
}

/** 剥离背景色 ANSI（用于重新铺背景行）。 */
export function stripBackgroundAnsi(line: string): string {
	return line.replace(/\x1b\[(?:4[0-9]|10[0-7]|48(?:(?:;|:)[0-9]+)+|49)m/g, "");
}

/** 剥离行首状态图标（展开组内工具首行复用）。 */
export function stripLeadingStatusIcon(line: string): string {
	return line.replace(
		// 行首图标：ccstyle 用 `·`，pi 原生输出里还有 `•`，两种都要剥
		/^((?:\x1b\[[0-9;]*m|[ \t]|[├└│─])*)(?:\x1b\[[0-9;]*m)*(?:[✓✗●○■⬤•·])(?:\x1b\[[0-9;]*m)*\s+/,
		"$1",
	);
}

/** 终端序列零宽（不计入 plain 下标），与 stripAnsi/stripTerminalSequencesPreservingLayout 一致。 */
const ANY_SEQUENCE_RE = new RegExp(`${CSI_SEQUENCE_RE.source}|${OSC_SEQUENCE_RE.source}`, "g");

/** 只保留 [start, end) 之外的字符（base 为 text 首字符在 plain 串中的下标）。 */
function keepOutsideRange(text: string, base: number, start: number, end: number): string {
	if (base + text.length <= start || base >= end) return text;
	return text.slice(0, Math.max(0, start - base)) + text.slice(Math.max(0, end - base));
}

/**
 * 删除 plain 区间 [start, end) 的字符，保留其余字符的 ANSI 样式。
 * 区间内的终端序列原样保留，因此区间后的字符（如收尾括号）沿用前文颜色，
 * 不会像截断后拼纯文本那样掉回终端默认前景色。
 */
export function removeStyledRange(styled: string, start: number, end: number): string {
	if (end <= start) return styled;
	let plain = 0;
	let cursor = 0;
	let out = "";
	for (const match of styled.matchAll(ANY_SEQUENCE_RE)) {
		const text = styled.slice(cursor, match.index);
		out += keepOutsideRange(text, plain, start, end);
		plain += text.length;
		out += match[0];
		cursor = match.index + match[0].length;
	}
	return out + keepOutsideRange(styled.slice(cursor), plain, start, end);
}
