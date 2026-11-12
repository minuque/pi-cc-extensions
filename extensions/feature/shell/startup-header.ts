import { InteractiveMode, VERSION, type AppKeybinding } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { config } from "../../config/config.ts";
import { formatKeyText, keyText, setInjectedKeybindings } from "../../utils/keybindings.ts";
import { ansi16ToRgb, ansi256ToRgb } from "../../utils/ansi-color.ts";
import { stripAnsi } from "../../utils/ansi-text.ts";
import {
	EARLY_STARTUP_HEADER_PATCH,
	EARLY_STARTUP_HEADER_SWAP_KEY,
	patchRegistry,
} from "../../utils/patch-keys.ts";
type Rgb = [number, number, number];
type StyledPart = {
	raw: string;
	styled: string;
};

const ANSI_RESET = "\x1b[0m";

// 官方 install.sh 静态 logo（4 行原样，短行补尾随空格统一到 8 列）+ 底部空行补到 5 行，
// 与右侧 tips 行数等高；着色保持现状（accent 渐变）
const LOGO_LINES = ["██████  ", "██  ██  ", "████  ██", "██    ██", "        "];

// hero 文案（单行，替换原生 header 的 "Pi can explain..." 默认位置）
const HERO_PREFIX = "There are many agent harnesses, but this one is ";
const HERO_HIGHLIGHT = "yours";
const HERO_SUFFIX = ".";

// 左右双栏布局：左侧 logo(5 行)，右侧原生提示(5 行)
const TWO_COL_GAP = 2;
// 窄于该宽度回退为垂直堆叠（logo + hero）
const TWO_COL_MIN_WIDTH = 48;

const FALLBACK_ACCENT_RGB: Rgb = [80, 160, 255];
const LOGO_BLOCK_WIDTH = Math.max(...LOGO_LINES.map((line) => [...line].length));
// 左栏宽度 = logo 宽，右侧栏从该宽度后开始
const LEFT_COLUMN_WIDTH = LOGO_BLOCK_WIDTH;

const PALETTE_STEPS = 24;
const PALETTE_MAX_DARKEN = 0.18;
const PALETTE_MAX_LIGHTEN = 0.18;
// 行内渐变波长：1/4 全波长（暗→亮单调，避免小字符数行内来回跳变）
const PALETTE_SPAN = 0.25;
// 行间相位偏移：小步累加 → 整体左上暗→右下亮的对角渐变
const LOGO_ROW_PHASE_STEP = 0.08;

function getVisibleLength(text: string): number {
	return [...stripAnsi(text)].length;
}

function clampByte(value: number): number {
	return Math.max(0, Math.min(255, Math.round(value)));
}

function interpolateChannel(start: number, end: number, factor: number): number {
	return Math.round(start + (end - start) * factor);
}

function interpolateRgb(start: Rgb, end: Rgb, factor: number): Rgb {
	return [
		interpolateChannel(start[0], end[0], factor),
		interpolateChannel(start[1], end[1], factor),
		interpolateChannel(start[2], end[2], factor),
	];
}

function darkenRgb(rgb: Rgb, amount: number): Rgb {
	return [
		clampByte(rgb[0] * (1 - amount)),
		clampByte(rgb[1] * (1 - amount)),
		clampByte(rgb[2] * (1 - amount)),
	];
}

function lightenRgb(rgb: Rgb, amount: number): Rgb {
	return [
		clampByte(rgb[0] + (255 - rgb[0]) * amount),
		clampByte(rgb[1] + (255 - rgb[1]) * amount),
		clampByte(rgb[2] + (255 - rgb[2]) * amount),
	];
}

function applyTruecolor(rgb: Rgb, text: string): string {
	const [red, green, blue] = rgb;
	return `\x1b[38;2;${red};${green};${blue}m${text}${ANSI_RESET}`;
}

function parseTruecolorAnsi(ansi: string): Rgb | undefined {
	const match = ansi.match(/38;2;(\d+);(\d+);(\d+)/);
	if (!match) return undefined;

	return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function parseAnsi256Foreground(ansi: string): Rgb | undefined {
	const match = ansi.match(/38;5;(\d+)/);
	if (!match) return undefined;

	return ansi256ToRgb(Number(match[1]));
}

function parseAnsi16Foreground(ansi: string): Rgb | undefined {
	const normalMatch = ansi.match(/(?:\[|;)(3[0-7])(?:;|m)/);
	if (normalMatch) {
		return ansi16ToRgb(Number(normalMatch[1]) - 30);
	}

	const brightMatch = ansi.match(/(?:\[|;)(9[0-7])(?:;|m)/);
	if (brightMatch) {
		return ansi16ToRgb(Number(brightMatch[1]) - 90 + 8);
	}

	return undefined;
}

function parseForegroundRgbFromAnsi(ansi: string): Rgb | undefined {
	return parseTruecolorAnsi(ansi) ?? parseAnsi256Foreground(ansi) ?? parseAnsi16Foreground(ansi);
}

function resolveAccentRgb(theme: { getFgAnsi(name: string): string }): Rgb {
	return parseForegroundRgbFromAnsi(theme.getFgAnsi("accent")) ?? FALLBACK_ACCENT_RGB;
}

function buildAccentPalette(accent: Rgb): Rgb[] {
	return Array.from({ length: PALETTE_STEPS }, (_, index) => {
		const progress = index / PALETTE_STEPS;
		const wave = -Math.cos(progress * Math.PI * 2);

		if (wave < 0) {
			return darkenRgb(accent, PALETTE_MAX_DARKEN * -wave);
		}

		return lightenRgb(accent, PALETTE_MAX_LIGHTEN * wave);
	});
}

function sampleGradientColor(palette: Rgb[], position: number): Rgb {
	const wrappedPosition = ((position % 1) + 1) % 1;
	const scaledPosition = wrappedPosition * palette.length;
	const baseIndex = Math.floor(scaledPosition) % palette.length;
	const nextIndex = (baseIndex + 1) % palette.length;
	const factor = scaledPosition - Math.floor(scaledPosition);

	return interpolateRgb(palette[baseIndex]!, palette[nextIndex]!, factor);
}

function renderGradientText(text: string, palette: Rgb[], phase: number): string {
	const characters = [...text];
	const span = Math.max(characters.length - 1, 1);

	return characters
		.map((character, index) => {
			if (character === " ") return character;
			// 行内单调暗→亮（1/4 波长），行间相位偏移 → 对角渐变
			const color = sampleGradientColor(palette, (index / span) * PALETTE_SPAN + phase);
			return applyTruecolor(color, character);
		})
		.join("");
}

function createCenteredBlockLine(text: string, width: number, blockWidth: number): string {
	const leftPadding = Math.max(0, Math.floor((width - blockWidth) / 2));
	return `${" ".repeat(leftPadding)}${text}`;
}

function createCenteredStyledLine(parts: StyledPart[], width: number): string {
	const rawText = parts.map((part) => part.raw).join("");
	const leftPadding = Math.max(0, Math.floor((width - [...rawText].length) / 2));
	const styledText = parts.map((part) => part.styled).join("");
	return `${" ".repeat(leftPadding)}${styledText}`;
}

function fitLineToWidth(line: string, width: number): string {
	if (getVisibleLength(line) <= width) {
		return line;
	}

	return stripAnsi(line).slice(0, width);
}

function renderLogoLines(width: number, palette: Rgb[]): string[] {
	return LOGO_LINES.map((line, rowIndex) => {
		const phasedLine = renderGradientText(line, palette, rowIndex * LOGO_ROW_PHASE_STEP);
		return createCenteredBlockLine(phasedLine, width, LOGO_BLOCK_WIDTH);
	});
}

// ---- 右侧：原生默认 header 文本（对齐 pi 内置 startup header，按键文本随用户 keybindings 动态渲染） ----

function renderNativeLines(theme: {
	fg(name: string, text: string): string;
	bold(text: string): string;
}): string[] {
	// 颜色方案照抄 pi 内置 header：按键 dim、描述 muted、分隔符 muted、版本 dim
	const hint = (keybinding: AppKeybinding, description: string) =>
		theme.fg("dim", keyText(keybinding)) + theme.fg("muted", ` ${description}`);
	const rawHint = (key: string, description: string) =>
		theme.fg("dim", formatKeyText(key)) + theme.fg("muted", ` ${description}`);

	const logo = theme.bold(theme.fg("accent", "pi")) + theme.fg("dim", ` v${VERSION}`);
	const compact = [
		hint("app.interrupt", "interrupt"),
		rawHint(`${keyText("app.clear")}/${keyText("app.exit")}`, "clear/exit"),
		rawHint("/", "commands"),
		rawHint("!", "bash"),
		hint("app.tools.expand", "more"),
	].join(theme.fg("muted", " · "));

	return [
		logo,
		compact,
		theme.fg(
			"dim",
			`Press ${keyText("app.tools.expand")} to show full startup help and loaded resources.`,
		),
		"",
		// hero 文案替换原生 "Pi can explain..." 行位置
		renderHeroParts(theme)
			.map((part) => part.styled)
			.join(""),
	];
}

function renderHeroParts(theme: {
	fg(name: string, text: string): string;
	bold(text: string): string;
}): StyledPart[] {
	return [
		{ raw: HERO_PREFIX, styled: theme.fg("accent", HERO_PREFIX) },
		{ raw: HERO_HIGHLIGHT, styled: theme.bold(theme.fg("mdLink", HERO_HIGHLIGHT)) },
		{ raw: HERO_SUFFIX, styled: theme.fg("accent", HERO_SUFFIX) },
	];
}

export function renderHeaderLines(
	width: number,
	theme: {
		getFgAnsi(name: string): string;
		fg(name: string, text: string): string;
		bold(text: string): string;
	},
): string[] {
	const accentRgb = resolveAccentRgb(theme);
	const palette = buildAccentPalette(accentRgb);

	if (width < TWO_COL_MIN_WIDTH) {
		// 窄屏回退：logo + hero 单行垂直堆叠居中
		const logoLines = renderLogoLines(width, palette);
		const heroLine = createCenteredStyledLine(renderHeroParts(theme), width);
		return ["", ...logoLines, "", heroLine, ""].map((line) => fitLineToWidth(line, width));
	}

	// 双栏：左官方 logo(5 行) 右原生提示(5 行)，同高并排，gap 分隔不交叉
	const leftLines = renderLogoLines(LEFT_COLUMN_WIDTH, palette);
	const rightLines = renderNativeLines(theme);
	const rightWidth = width - LEFT_COLUMN_WIDTH - TWO_COL_GAP;
	const padTop = Math.floor((rightLines.length - leftLines.length) / 2);
	const paddedLeft = [
		...Array.from({ length: padTop }, () => ""),
		...leftLines,
		...Array.from({ length: rightLines.length - leftLines.length - padTop }, () => ""),
	];

	return paddedLeft.map(
		(line, index) =>
			`${line}${" ".repeat(TWO_COL_GAP)}${fitLineToWidth(rightLines[index] ?? "", rightWidth)}`,
	);
}

/** 官方 setHeader 的组件工厂：theme 由宿主注入。 */
function headerFactory(): (
	tui: unknown,
	theme: any,
) => {
	render(width: number): string[];
	invalidate(): void;
} {
	return (_tui: unknown, theme: any) => ({
		render(width: number): string[] {
			return renderHeaderLines(width, theme);
		},
		invalidate() {},
	});
}

/** 按配置安装启动头。禁用时不碰槽位，避免清掉其他扩展的 header。 */
export function applyStartupHeader(ctx: any): void {
	if (!ctx?.hasUI || typeof ctx.ui?.setHeader !== "function" || !config.showStartupHeader) {
		return;
	}
	ctx.ui.setHeader(headerFactory());
}

type EarlyHeaderPatch = {
	active: boolean;
	original: (...args: any[]) => unknown;
	installed: (...args: any[]) => unknown;
};

type HeaderContainerSwap = {
	original: (child: any) => unknown;
	installed: (child: any) => unknown;
};

/**
 * Pi 在 session_start 之前就把原生启动头画上去了：init() 先建 header 再 requestRender，
 * 之后才 await 工具检查、加载扩展，所以扩展最早只能到 session_start 换头，启动时会闪一下原生头。
 * 这里补 init，在原生 header 刚进容器的瞬间换成 ccstyle 的，首次绘制就已经是我们的。
 * 判定用 child === mode.builtInHeader，不依赖类名；配置关掉时不碰槽位，保留原生头。
 */
export function installEarlyStartupHeader(): void {
	const prototype = (InteractiveMode as any)?.prototype;
	if (!prototype || typeof prototype.init !== "function") return;
	const previous = patchRegistry.get<EarlyHeaderPatch>(EARLY_STARTUP_HEADER_PATCH);
	if (previous) previous.active = false;
	const original =
		previous && prototype.init === previous.installed ? previous.original : prototype.init;
	const patch: EarlyHeaderPatch = {
		active: true,
		original,
		installed: async function (this: any, ...args: any[]) {
			// 从这里拿到 pi 注入的按键管理器，启动头与工具卡的按键提示都按它显示。
			setInjectedKeybindings(this?.keybindings);
			installHeaderContainerSwap(this, patch);
			return original.apply(this, args);
		},
	};
	prototype.init = patch.installed;
	patchRegistry.install(EARLY_STARTUP_HEADER_PATCH, patch);
}

/** 只包一次 headerContainer.addChild；/reload 后按所有权接管旧包装。 */
function installHeaderContainerSwap(mode: any, patch: EarlyHeaderPatch): void {
	const container = mode?.headerContainer;
	if (!container || typeof container.addChild !== "function") return;
	const previous = container[EARLY_STARTUP_HEADER_SWAP_KEY] as HeaderContainerSwap | undefined;
	const original =
		previous && container.addChild === previous.installed
			? previous.original
			: container.addChild.bind(container);
	const installed = function (child: any) {
		const result = original(child);
		if (!patch.active || !config.showStartupHeader || child !== mode.builtInHeader) return result;
		if (typeof mode.setExtensionHeader !== "function") return result;
		try {
			mode.setExtensionHeader(headerFactory());
		} catch {
			// 换头失败就退回原生 header，不影响启动
		}
		return result;
	};
	container.addChild = installed;
	container[EARLY_STARTUP_HEADER_SWAP_KEY] = { original, installed };
}

/** 用户从 /ccstyle 关掉本扩展启动头时，恢复官方 header。 */
export function clearStartupHeader(ctx: any): void {
	if (!ctx?.hasUI || typeof ctx.ui?.setHeader !== "function") return;
	ctx.ui.setHeader(undefined);
}

export default function piStartupHeader(pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		applyStartupHeader(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (!ctx.hasUI) return;

		ctx.ui.setHeader(undefined);
	});
}
