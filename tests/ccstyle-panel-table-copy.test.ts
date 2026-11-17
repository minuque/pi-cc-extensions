import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { stripTerminalSequences } from "@earendil-works/pi-tui";

const previousDir = process.env.PI_CODING_AGENT_DIR;
const dir = mkdtempSync(join(tmpdir(), "ccstyle-panel-table-copy-"));
process.env.PI_CODING_AGENT_DIR = dir;
after(() => {
	if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousDir;
	rmSync(dir, { recursive: true, force: true });
});

const { config, normalizeConfig } = await import("../extensions/config/config.ts");
const { showCcstylePanel } = await import("../extensions/config/panel.ts");
const { initTheme } = await import("@earendil-works/pi-coding-agent");
initTheme("dark");

test("table copy is opt-in and only an explicit true enables it", () => {
	assert.equal(config.enableTableCopy, false);
	assert.equal(normalizeConfig({}).enableTableCopy, false);
	assert.equal(normalizeConfig({ enableTableCopy: true }).enableTableCopy, true);
	assert.equal(normalizeConfig({ enableTableCopy: false }).enableTableCopy, false);
	assert.equal(normalizeConfig({ enableTableCopy: "true" }).enableTableCopy, false);
});

test("Features exposes Copy table and persists both toggle states", async () => {
	const original = { ...config };
	const notifications: string[] = [];
	let panel!: { handleInput(data: string): void; render(width: number): string[] };
	const ctx = {
		mode: "tui",
		hasUI: true,
		ui: {
			notify(message: string) {
				notifications.push(message);
			},
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
	config.enableTableCopy = false;
	const closed = showCcstylePanel(ctx, { applyStyleMode() {}, refreshCurrentTranscript() {} });
	try {
		panel.handleInput("\t");
		for (let index = 0; index < 7; index++) panel.handleInput("\x1b[B");
		const text = () => panel.render(120).map(stripTerminalSequences).join("\n");
		assert.match(text(), /Copy table\s+off/);
		panel.handleInput(" ");
		assert.equal(config.enableTableCopy, true);
		assert.match(text(), /Copy table\s+on/);
		assert.equal(
			JSON.parse(readFileSync(join(dir, "pi-cc-extensions.json"), "utf8")).enableTableCopy,
			true,
		);
		panel.handleInput(" ");
		assert.equal(config.enableTableCopy, false);
		assert.match(text(), /Copy table\s+off/);
		assert.equal(
			JSON.parse(readFileSync(join(dir, "pi-cc-extensions.json"), "utf8")).enableTableCopy,
			false,
		);
		assert.deepEqual(notifications, [
			"Updated enableTableCopy: on (next restart)",
			"Updated enableTableCopy: off (next restart)",
		]);
	} finally {
		panel.handleInput("\x1b");
		await closed;
		Object.assign(config, original);
	}
});
