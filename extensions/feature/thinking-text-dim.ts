import type {
	ExtensionAPI,
	ExtensionContext,
	Theme,
	ThemeColor,
} from "@earendil-works/pi-coding-agent";
import { config } from "../config/config.ts";

type MutableTheme = { fgColors?: Map<ThemeColor, string> };

const originalThinkingTextAnsi = new WeakMap<Theme, string>();

function colorMap(theme: Theme): Map<ThemeColor, string> | undefined {
	const colors = (theme as unknown as MutableTheme).fgColors;
	return colors instanceof Map ? colors : undefined;
}

export function applyThinkingTextDim(theme: Theme): void {
	const colors = colorMap(theme);
	if (!colors) return;

	if (!originalThinkingTextAnsi.has(theme)) {
		originalThinkingTextAnsi.set(theme, theme.getFgAnsi("thinkingText"));
	}
	colors.set("thinkingText", theme.getFgAnsi("dim"));
}

export function clearThinkingTextDim(theme: Theme): void {
	const colors = colorMap(theme);
	const original = originalThinkingTextAnsi.get(theme);
	if (!colors || original === undefined) return;

	colors.set("thinkingText", original);
	originalThinkingTextAnsi.delete(theme);
}

function syncThinkingTextDim(ctx: ExtensionContext): void {
	if (config.dimThinkingText) applyThinkingTextDim(ctx.ui.theme);
	else clearThinkingTextDim(ctx.ui.theme);
}

export default function installThinkingTextDim(pi: ExtensionAPI): void {
	pi.on("session_start", async (_event, ctx) => {
		if (ctx.mode !== "tui" || !ctx.hasUI) return;
		syncThinkingTextDim(ctx);
	});
}
