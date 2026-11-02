import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

// updateConfig writes to disk; isolate the agent directory before importing config.
const previousDir = process.env.PI_CODING_AGENT_DIR;
const dir = mkdtempSync(join(tmpdir(), "ccstyle-panel-thinking-"));
process.env.PI_CODING_AGENT_DIR = dir;
after(() => {
	if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousDir;
	rmSync(dir, { recursive: true, force: true });
});

const { config } = await import("../extensions/config/config.ts");
const { showCcstylePanel } = await import("../extensions/config/panel.ts");
const { initTheme } = await import("@earendil-works/pi-coding-agent");
initTheme("dark");

test("Completed preview accepts custom numbers and follow while retaining presets", async () => {
	const original = { ...config };
	let panel!: { handleInput(data: string): void; render(width: number): string[] };
	const ctx = {
		mode: "tui",
		hasUI: true,
		ui: {
			notify() {},
			custom(build: Function) {
				return new Promise<void>((resolve) => {
					panel = build(
						{ requestRender() {} },
						{ fg: (_color: string, text: string) => text },
						{},
						resolve,
					);
				});
			},
		},
	};
	config.completedPreviewLines = null;
	const closed = showCcstylePanel(ctx, {
		applyStyleMode() {},
		refreshCurrentTranscript() {},
	});
	try {
		// Style -> Feature -> UI -> Diff -> Thinking, then select Completed preview.
		for (let i = 0; i < 4; i++) panel.handleInput("\t");
		panel.handleInput("\x1b[B");
		panel.handleInput("\x1b[B");
		panel.handleInput("\r");
		assert.match(panel.render(120).join("\n"), /Completed preview — custom value/);
		panel.handleInput("\r");
		assert.equal(config.completedPreviewLines, null, "unchanged follow is accepted");

		panel.handleInput("\r");
		panel.handleInput("\x05");
		panel.handleInput("\x15");
		panel.handleInput("7");
		panel.handleInput("\r");
		assert.equal(config.completedPreviewLines, 7, "custom values are not limited to presets");

		panel.handleInput("\r");
		panel.handleInput("\x05");
		panel.handleInput("\x15");
		panel.handleInput("abc");
		panel.handleInput("\r");
		assert.equal(config.completedPreviewLines, 7, "invalid input preserves the current value");
		assert.match(panel.render(120).join("\n"), /Invalid number/);
		panel.handleInput("\x1b");

		panel.handleInput("\r");
		panel.handleInput("\x05");
		panel.handleInput("\x15");
		panel.handleInput("follow");
		panel.handleInput("\r");
		assert.equal(config.completedPreviewLines, null, "custom input can restore follow");

		panel.handleInput(" ");
		assert.equal(config.completedPreviewLines, 0, "Space still cycles the presets");
		assert.equal(config.previewLines, original.previewLines, "active preview is unchanged");
	} finally {
		panel.handleInput("\x1b");
		panel.handleInput("\x1b");
		await closed;
		Object.assign(config, original);
	}
});
