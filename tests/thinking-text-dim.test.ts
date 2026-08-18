import assert from "node:assert/strict";
import test from "node:test";
import { config } from "../extensions/config/config.ts";
import installThinkingTextDim, {
	applyThinkingTextDim,
	clearThinkingTextDim,
} from "../extensions/feature/thinking-text-dim.ts";

function theme() {
	const colors = new Map<string, string>([
		["thinkingText", "\x1b[95m"],
		["dim", "\x1b[2m"],
	]);
	return {
		colors,
		theme: {
			fgColors: colors,
			getFgAnsi(color: string) {
				const ansi = colors.get(color);
				if (ansi === undefined) throw new Error(`Unknown theme color: ${color}`);
				return ansi;
			},
			fg(color: string, text: string) {
				return `${this.getFgAnsi(color)}${text}\x1b[0m`;
			},
		},
	};
}

test("restores the original thinkingText ANSI", () => {
	const original = "\x1b[95m";
	const state = theme();

	applyThinkingTextDim(state.theme as any);
	applyThinkingTextDim(state.theme as any);
	assert.equal(state.colors.get("thinkingText"), "\x1b[2m");

	clearThinkingTextDim(state.theme as any);
	assert.equal(state.colors.get("thinkingText"), original);
	assert.equal(state.theme.fg("thinkingText", "text"), `${original}text\x1b[0m`);
});

test("syncs only on session start", async () => {
	const handlers = new Map<string, (...args: any[]) => unknown>();
	installThinkingTextDim({
		on(event: string, handler: (...args: any[]) => unknown) {
			handlers.set(event, handler);
		},
	} as any);
	assert.deepEqual([...handlers.keys()], ["session_start"]);

	const state = theme();
	const ctx = { mode: "tui", hasUI: true, ui: { theme: state.theme } };
	const originalSetting = config.dimThinkingText;
	try {
		config.dimThinkingText = true;
		await handlers.get("session_start")?.({}, ctx);
		await handlers.get("session_start")?.({}, ctx);
		assert.equal(state.colors.get("thinkingText"), "\x1b[2m");

		config.dimThinkingText = false;
		await handlers.get("session_start")?.({}, ctx);
		assert.equal(state.colors.get("thinkingText"), "\x1b[95m");
	} finally {
		config.dimThinkingText = originalSetting;
	}
});
