/**
 * 自定义 footer 插件芯片布局：行、顺序、隐藏。
 * 纯函数，供 config 规范化、footer 渲染、配置面板共用。
 */

export const PI_USAGE_KEY = "pi-usage";
export const PI_USAGE_SOURCE = "@narumitw/pi-usage";
const LEGACY_PI_USAGE_KEYS = new Set(["localUsage", "piUsage"]);

/** 内置芯片。不是 setStatus key，由本扩展自己画。 */
export const FOOTER_MODEL_KEY = "model";
export const FOOTER_CONTEXT_KEY = "context";
export const FOOTER_CACHE_KEY = "cache";
export const FOOTER_RATE_KEY = "rate";
export const FOOTER_COST_KEY = "cost";
export const FOOTER_CWD_KEY = "cwd";
export const FOOTER_GIT_KEY = "git";

/** 默认第一行，顺序与改成可排布之前的硬编码一致。 */
export const DEFAULT_FOOTER_LINE1_KEYS = [
	FOOTER_MODEL_KEY,
	FOOTER_CONTEXT_KEY,
	FOOTER_CACHE_KEY,
	FOOTER_RATE_KEY,
	FOOTER_COST_KEY,
	PI_USAGE_KEY,
] as const;

/** 默认第二行。cwd 在前，git 在后。 */
export const DEFAULT_FOOTER_LINE2_KEYS = [FOOTER_CWD_KEY, FOOTER_GIT_KEY] as const;

/** 改成可排布之前就写死的项。pi-usage 不算：旧配置里本来就有它。 */
const LEGACY_FIXED_FOOTER_KEYS = [
	FOOTER_MODEL_KEY,
	FOOTER_CONTEXT_KEY,
	FOOTER_CACHE_KEY,
	FOOTER_RATE_KEY,
	FOOTER_COST_KEY,
	FOOTER_CWD_KEY,
	FOOTER_GIT_KEY,
] as const;

const BUILTIN_FOOTER_KEYS = new Set<string>(LEGACY_FIXED_FOOTER_KEYS);

export function isBuiltinFooterKey(key: string): boolean {
	return BUILTIN_FOOTER_KEYS.has(key);
}

export type FooterLineId = 1 | 2 | 3;

export type FooterChipLayout = {
	footerHiddenKeys: string[];
	footerLine1Keys: string[];
	footerLine2Keys: string[];
	footerLine3Keys: string[];
};

export const DEFAULT_FOOTER_CHIP_LAYOUT: FooterChipLayout = {
	footerHiddenKeys: [],
	footerLine1Keys: [...DEFAULT_FOOTER_LINE1_KEYS],
	footerLine2Keys: [...DEFAULT_FOOTER_LINE2_KEYS],
	footerLine3Keys: [],
};

/** 别的扩展写的 model 状态与本扩展的模型芯片重名，不当插件芯片接纳。配置里的 model 不受影响。 */
export function isSkippedFooterStatusKey(key: string): boolean {
	return key === FOOTER_MODEL_KEY;
}

/** 未单独配置时的默认行：内置项按原来的行，usage 类在 line1，其余 line2。不会默认进 line3。 */
export function defaultFooterLine(key: string): FooterLineId {
	if ((DEFAULT_FOOTER_LINE1_KEYS as readonly string[]).includes(key)) return 1;
	if ((DEFAULT_FOOTER_LINE2_KEYS as readonly string[]).includes(key)) return 2;
	if (/usage|quota|balance/i.test(key)) return 1;
	return 2;
}

export function normalizeFooterKeyList(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	const out: string[] = [];
	const seen = new Set<string>();
	for (const item of value) {
		if (typeof item !== "string") continue;
		let key = item.trim();
		if (LEGACY_PI_USAGE_KEYS.has(key)) key = PI_USAGE_KEY;
		if (!key || seen.has(key)) continue;
		seen.add(key);
		out.push(key);
	}
	return out;
}

function takeUnique(keys: string[], seen: Set<string>): string[] {
	const out: string[] = [];
	for (const key of keys) {
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(key);
	}
	return out;
}

/**
 * 旧配置只排插件芯片，内置项是硬编码的。
 * 三条行都没出现过内置 key 时，按原位置补上，已有插件顺序不动。
 */
function ensureBuiltinKeys(
	line1: string[],
	line2: string[],
	line3: string[],
): { footerLine1Keys: string[]; footerLine2Keys: string[]; footerLine3Keys: string[] } {
	const seen = new Set([...line1, ...line2, ...line3]);
	if (LEGACY_FIXED_FOOTER_KEYS.some((key) => seen.has(key))) {
		return { footerLine1Keys: line1, footerLine2Keys: line2, footerLine3Keys: line3 };
	}
	const line1Builtins = DEFAULT_FOOTER_LINE1_KEYS.filter((key) => key !== PI_USAGE_KEY);
	const usageAt = line1.indexOf(PI_USAGE_KEY);
	const footerLine1Keys =
		usageAt >= 0
			? [...line1.slice(0, usageAt), ...line1Builtins, ...line1.slice(usageAt)]
			: [...line1Builtins, ...line1];
	return {
		footerLine1Keys,
		footerLine2Keys: [...DEFAULT_FOOTER_LINE2_KEYS, ...line2],
		footerLine3Keys: line3,
	};
}

/** 跨行去重（line1 → line2 → line3）；旧配置补上内置芯片。 */
export function normalizeFooterChipLayout(source: Record<string, unknown>): FooterChipLayout {
	const hasHidden = Array.isArray(source.footerHiddenKeys);
	const hasAnyLine = [source.footerLine1Keys, source.footerLine2Keys, source.footerLine3Keys].some(
		Array.isArray,
	);
	if (!hasHidden && !hasAnyLine) {
		return {
			footerHiddenKeys: [],
			footerLine1Keys: [...DEFAULT_FOOTER_LINE1_KEYS],
			footerLine2Keys: [...DEFAULT_FOOTER_LINE2_KEYS],
			footerLine3Keys: [],
		};
	}
	const seen = new Set<string>();
	const line1 = takeUnique(normalizeFooterKeyList(source.footerLine1Keys), seen);
	const line2 = takeUnique(normalizeFooterKeyList(source.footerLine2Keys), seen);
	const line3 = takeUnique(normalizeFooterKeyList(source.footerLine3Keys), seen);
	return {
		footerHiddenKeys: normalizeFooterKeyList(source.footerHiddenKeys),
		...ensureBuiltinKeys(line1, line2, line3),
	};
}

const BUILTIN_FOOTER_LABEL: Record<string, string> = {
	[FOOTER_MODEL_KEY]: "Model and thinking level",
	[FOOTER_CONTEXT_KEY]: "Context window bar",
	[FOOTER_CACHE_KEY]: "Cache hit rate",
	[FOOTER_RATE_KEY]: "Output rate",
	[FOOTER_COST_KEY]: "Session cost",
	[FOOTER_CWD_KEY]: "Working directory and session name",
	[FOOTER_GIT_KEY]: "Branch and change stats",
};

/** 面板描述用：内置项写明内容，pi-usage 注明来源，其它芯片用来源 setStatus key。 */
export function footerChipSource(key: string): string {
	return key === PI_USAGE_KEY ? PI_USAGE_SOURCE : key;
}

export function footerChipDescription(key: string, liveText: string): string {
	const builtin = BUILTIN_FOOTER_LABEL[key];
	if (builtin) {
		const live = liveText.trim();
		return live ? `${builtin} · ${live}` : builtin;
	}
	const source = footerChipSource(key);
	const live = liveText.trim();
	if (live) return `${live} · from ${source}`;
	if (key === PI_USAGE_KEY) return `From ${PI_USAGE_SOURCE}. No text right now.`;
	return `inactive · from ${source}`;
}

export function footerLineOfKey(layout: FooterChipLayout, key: string): FooterLineId | undefined {
	if (layout.footerLine1Keys.includes(key)) return 1;
	if (layout.footerLine2Keys.includes(key)) return 2;
	if (layout.footerLine3Keys.includes(key)) return 3;
	return undefined;
}

function keysOnLine(layout: FooterChipLayout, line: FooterLineId): string[] {
	if (line === 1) return layout.footerLine1Keys;
	if (line === 2) return layout.footerLine2Keys;
	return layout.footerLine3Keys;
}

function withLineKeys(
	layout: FooterChipLayout,
	line: FooterLineId,
	keys: string[],
): FooterChipLayout {
	if (line === 1) return { ...layout, footerLine1Keys: keys };
	if (line === 2) return { ...layout, footerLine2Keys: keys };
	return { ...layout, footerLine3Keys: keys };
}

/**
 * 配置里还没有的 live key 接到默认行末尾（按 key 字母序，避免每次渲染乱序）。
 * pi-usage 由 normalize 保证已在某一行。
 */
export function resolveFooterChipLayout(
	layout: FooterChipLayout,
	liveKeys: readonly string[],
): FooterChipLayout {
	const known = new Set([
		...layout.footerLine1Keys,
		...layout.footerLine2Keys,
		...layout.footerLine3Keys,
	]);
	const extras = [
		...new Set(liveKeys.filter((key) => key && !isSkippedFooterStatusKey(key) && !known.has(key))),
	].sort((a, b) => a.localeCompare(b));
	const next: FooterChipLayout = {
		footerHiddenKeys: [...layout.footerHiddenKeys],
		footerLine1Keys: [...layout.footerLine1Keys],
		footerLine2Keys: [...layout.footerLine2Keys],
		footerLine3Keys: [...layout.footerLine3Keys],
	};
	for (const key of extras) {
		if (defaultFooterLine(key) === 1) next.footerLine1Keys.push(key);
		else next.footerLine2Keys.push(key);
	}
	return next;
}

export function moveFooterKeyToLine(
	layout: FooterChipLayout,
	key: string,
	line: FooterLineId,
): FooterChipLayout {
	const current = footerLineOfKey(layout, key);
	if (current === line) return layout;
	const stripped: FooterChipLayout = {
		footerHiddenKeys: [...layout.footerHiddenKeys],
		footerLine1Keys: layout.footerLine1Keys.filter((item) => item !== key),
		footerLine2Keys: layout.footerLine2Keys.filter((item) => item !== key),
		footerLine3Keys: layout.footerLine3Keys.filter((item) => item !== key),
	};
	return withLineKeys(stripped, line, [...keysOnLine(stripped, line), key]);
}

export function shiftFooterKeyLine(
	layout: FooterChipLayout,
	key: string,
	delta: -1 | 1,
): FooterChipLayout {
	const current = footerLineOfKey(layout, key);
	if (!current) return layout;
	const next = (current + delta) as number;
	if (next < 1 || next > 3) return layout;
	return moveFooterKeyToLine(layout, key, next as FooterLineId);
}

export function reorderFooterKey(
	layout: FooterChipLayout,
	key: string,
	delta: -1 | 1,
): FooterChipLayout {
	const line = footerLineOfKey(layout, key);
	if (!line) return layout;
	const keys = [...keysOnLine(layout, line)];
	const index = keys.indexOf(key);
	const nextIndex = index + delta;
	if (index < 0 || nextIndex < 0 || nextIndex >= keys.length) return layout;
	const swap = keys[nextIndex]!;
	keys[nextIndex] = key;
	keys[index] = swap;
	return withLineKeys(layout, line, keys);
}

export function toggleFooterKeyHidden(layout: FooterChipLayout, key: string): FooterChipLayout {
	const hidden = new Set(layout.footerHiddenKeys);
	if (hidden.has(key)) hidden.delete(key);
	else hidden.add(key);
	return { ...layout, footerHiddenKeys: [...hidden] };
}

/** 按行顺序收集可见、且当前有文案的插件芯片文本。 */
export function visibleFooterPluginTexts(
	lineKeys: readonly string[],
	hiddenKeys: readonly string[],
	texts: ReadonlyMap<string, string>,
): string[] {
	const hidden = new Set(hiddenKeys);
	const out: string[] = [];
	for (const key of lineKeys) {
		if (hidden.has(key)) continue;
		const text = texts
			.get(key)
			?.replace(/[\r\n\t]+/g, " ")
			.trim();
		if (text) out.push(text);
	}
	return out;
}

export function formatFooterChipSummary(layout: FooterChipLayout): string {
	const hidden = layout.footerHiddenKeys.length;
	return `hidden=${hidden} · L1=${layout.footerLine1Keys.length} · L2=${layout.footerLine2Keys.length} · L3=${layout.footerLine3Keys.length}`;
}

export function orderedFooterKeys(layout: FooterChipLayout): string[] {
	return [...layout.footerLine1Keys, ...layout.footerLine2Keys, ...layout.footerLine3Keys];
}
