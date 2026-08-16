import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { config } from "../config/config.ts";

/**
 * Optional dimming of thinking-block text via the `thinkingText` theme token.
 *
 * Every thinking-text renderer reads the same token — pi's built-in
 * visible-mode renderer and the compact thinking preview — so setting it to
 * the theme's dim color dims thinking text everywhere. The token is
 * re-asserted on render-triggering events because the theme instance can be
 * replaced mid-session (theme reload), which would otherwise reset it.
 */

export function applyThinkingTextDim(theme: any): void {
	try {
		if (!config.dimThinkingText || !theme?.fgColors?.set) return;
		const dim = theme.fgColors.get?.("dim") ?? theme.fgColors.get?.("muted");
		if (typeof dim === "string" && dim.length > 0) {
			theme.fgColors.set("thinkingText", dim);
		}
	} catch {
		/* theme not ready yet */
	}
}

export function clearThinkingTextDim(theme: any): void {
	try {
		theme?.fgColors?.delete?.("thinkingText");
	} catch {
		/* theme not ready yet */
	}
}

function assertOnRenderEvents(_event: unknown, ctx: any): void {
	applyThinkingTextDim(ctx?.ui?.theme);
}

export default function installThinkingTextDim(pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui" || !ctx.hasUI) return;
		applyThinkingTextDim(ctx.ui.theme);
	});
	pi.on("session_tree", assertOnRenderEvents);
	pi.on("message_update", assertOnRenderEvents);
	pi.on("message_end", assertOnRenderEvents);
	pi.on("tool_execution_end", assertOnRenderEvents);
}