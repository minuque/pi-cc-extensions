import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";

initTheme("dark");

test("turning off Fixed editor also disables Tool mouse and persists both", async () => {
	const configDir = mkdtempSync(join(tmpdir(), "pi-ccstyle-mouse-"));
	const previousConfigDir = process.env.PI_CODING_AGENT_DIR;
	const stdoutWrite = process.stdout.write;
	process.env.PI_CODING_AGENT_DIR = configDir;
	process.stdout.write = (() => true) as typeof process.stdout.write;

	try {
		const extensionPath = "../extensions/claude-code-style.ts?mouse-panel-test";
		const { default: claudeCodeStyleExtension } = await import(extensionPath);
		const commands = new Map<string, any>();
		const events = new Map<string, Function[]>();
		const pi = {
			registerCommand(name: string, options: any) {
				commands.set(name, options);
			},
			registerShortcut() {},
			registerEntryRenderer() {},
			on(name: string, handler: Function) {
				const handlers = events.get(name) ?? [];
				handlers.push(handler);
				events.set(name, handlers);
			},
		};
		claudeCodeStyleExtension(pi as any, {
			mode: "on",
			fixedEditorFeatures: true,
			toolMouseInteraction: true,
		});

		let panel: any;
		const widgetValues = new Map<string, unknown[]>();
		let mouseListenerRegistrations = 0;
		let activeMouseListeners = 0;
		const theme = {
			fg: (_color: string, text: string) => text,
			bold: (text: string) => text,
		};
		const ctx = {
			mode: "tui",
			hasUI: true,
			ui: {
				theme,
				custom(factory: Function) {
					panel = factory({ requestRender() {} }, theme, {}, () => undefined);
					return Promise.resolve();
				},
				notify() {},
				requestRender() {},
				setStatus() {},
				setWidget(key: string, value: unknown) {
					const values = widgetValues.get(key) ?? [];
					values.push(value);
					widgetValues.set(key, values);
				},
				onTerminalInput() {
					mouseListenerRegistrations++;
					activeMouseListeners++;
					return () => {
						activeMouseListeners--;
					};
				},
			},
		};

		for (const handler of events.get("session_start") ?? []) {
			await handler({ reason: "startup" }, ctx);
		}
		assert.equal(mouseListenerRegistrations, 1);
		assert.equal(activeMouseListeners, 1);

		await commands.get("ccstyle").handler("", ctx);
		panel.handleInput("\t");
		panel.handleInput("\r");
		assert.equal(activeMouseListeners, 0);
		assert.equal(widgetValues.get("ccstyle-tool-mouse")?.at(-1), undefined);

		for (const handler of events.get("session_compact") ?? []) {
			await handler({}, ctx);
		}
		assert.equal(mouseListenerRegistrations, 1);
		assert.equal(activeMouseListeners, 0);

		const saved = JSON.parse(
			readFileSync(join(configDir, "claude-code-style.json"), "utf8"),
		) as Record<string, unknown>;
		assert.equal(saved.fixedEditorFeatures, false);
		assert.equal(saved.toolMouseInteraction, false);

		const lines = panel
			.render(80)
			.join("\n")
			.replace(/\x1b\[[0-9;]*m/g, "");
		assert.match(lines, /Fixed editor\s+off/);
		assert.match(lines, /Tool mouse\s+off/);

		for (const handler of events.get("session_shutdown") ?? []) {
			await handler({}, ctx);
		}
	} finally {
		process.stdout.write = stdoutWrite;
		if (previousConfigDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousConfigDir;
		rmSync(configDir, { recursive: true, force: true });
	}
});
