import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	DEFAULT_CONFIG,
	formatConfigStatus,
	normalizeConfig,
	SCROLL_BUTTON_MODES,
	type Config,
} from "../extensions/config/config.ts";

test("scroll settings default to dock with native indicator text enabled independently", () => {
	assert.deepEqual(SCROLL_BUTTON_MODES, ["dock", "native"]);
	assert.equal(DEFAULT_CONFIG.scrollButtonMode, "dock");
	assert.equal(DEFAULT_CONFIG.customNativeScrollToEndIndicatorText, true);
	for (const input of [{}, undefined, null, false, 0, "native", []]) {
		const actual = normalizeConfig(input);
		assert.equal(actual.scrollButtonMode, "dock");
		assert.equal(actual.customNativeScrollToEndIndicatorText, true);
	}
});

for (const scrollButtonMode of SCROLL_BUTTON_MODES) {
	for (const customNativeScrollToEndIndicatorText of [true, false]) {
		test(`normalization and status preserve ${scrollButtonMode} with native text ${customNativeScrollToEndIndicatorText}`, () => {
			const actual = normalizeConfig({ scrollButtonMode, customNativeScrollToEndIndicatorText });
			assert.equal(actual.scrollButtonMode, scrollButtonMode);
			assert.equal(
				actual.customNativeScrollToEndIndicatorText,
				customNativeScrollToEndIndicatorText,
			);
			const status = formatConfigStatus(actual).split(" · ");
			assert.ok(status.includes(`scrollButton=${scrollButtonMode}`));
			assert.ok(
				status.includes(
					`nativeScrollIndicatorText=${customNativeScrollToEndIndicatorText ? "on" : "off"}`,
				),
			);
		});
	}

	test(`${scrollButtonMode} alone keeps the native text default enabled`, () => {
		const actual = normalizeConfig({ scrollButtonMode });
		assert.equal(actual.scrollButtonMode, scrollButtonMode);
		assert.equal(actual.customNativeScrollToEndIndicatorText, true);
	});

	test(`invalid native text values fall back to true without changing ${scrollButtonMode}`, () => {
		for (const value of [undefined, null, 0, 1, "", "false", "true", "off", [], {}]) {
			const actual = normalizeConfig({
				scrollButtonMode,
				customNativeScrollToEndIndicatorText: value,
			});
			assert.equal(actual.scrollButtonMode, scrollButtonMode);
			assert.equal(actual.customNativeScrollToEndIndicatorText, true);
		}
	});
}

test("invalid scroll modes fall back to dock without changing the native text boolean", () => {
	for (const value of [
		undefined,
		null,
		true,
		false,
		0,
		1,
		"",
		"auto",
		"Native",
		" dock ",
		[],
		{},
	]) {
		for (const customNativeScrollToEndIndicatorText of [true, false]) {
			const actual = normalizeConfig({
				scrollButtonMode: value,
				customNativeScrollToEndIndicatorText,
			});
			assert.equal(actual.scrollButtonMode, "dock");
			assert.equal(
				actual.customNativeScrollToEndIndicatorText,
				customNativeScrollToEndIndicatorText,
			);
		}
	}
});

/** Isolate module-load config and every save from the user's real agent directory. */
function loadSaveAndUpdate(input: Partial<Config>): {
	loaded: Config;
	saved: Config;
	updated: Config;
	changedMode: Config;
	changedText: Config;
	status: string;
} {
	const dir = mkdtempSync(join(tmpdir(), "pi-cc-scroll-config-"));
	try {
		writeFileSync(join(dir, "pi-cc-extensions.json"), JSON.stringify(input));
		const configUrl = new URL("../extensions/config/config.ts", import.meta.url).href;
		const output = execFileSync(
			process.execPath,
			[
				"--input-type=module",
				"-e",
				`
				import { readFileSync } from "node:fs";
				import { CONFIG_PATH, config, formatConfigStatus, saveConfig, updateConfig } from ${JSON.stringify(configUrl)};
				const loaded = { ...config };
				const status = formatConfigStatus();
				const readSaved = () => JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
				saveConfig();
				const saved = readSaved();
				updateConfig({ showStartupHeader: false });
				const updated = readSaved();
				updateConfig({ scrollButtonMode: config.scrollButtonMode === "dock" ? "native" : "dock" });
				const changedMode = readSaved();
				updateConfig({ customNativeScrollToEndIndicatorText: !config.customNativeScrollToEndIndicatorText });
				const changedText = readSaved();
				process.stdout.write(JSON.stringify({ loaded, saved, updated, changedMode, changedText, status }));
				`,
			],
			{ encoding: "utf8", env: { ...process.env, PI_CODING_AGENT_DIR: dir } },
		);
		return JSON.parse(output);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

for (const scrollButtonMode of SCROLL_BUTTON_MODES) {
	for (const customNativeScrollToEndIndicatorText of [undefined, true, false]) {
		test(`load, save and update retain both settings for ${scrollButtonMode} with native text ${customNativeScrollToEndIndicatorText ?? "default"}`, () => {
			const expectedText = customNativeScrollToEndIndicatorText ?? true;
			const result = loadSaveAndUpdate({
				scrollButtonMode,
				customNativeScrollToEndIndicatorText,
				stickyUserMessage: false,
			});
			for (const snapshot of [result.loaded, result.saved, result.updated]) {
				assert.equal(snapshot.scrollButtonMode, scrollButtonMode);
				assert.equal(snapshot.customNativeScrollToEndIndicatorText, expectedText);
				assert.equal(snapshot.stickyUserMessage, false);
			}
			assert.equal(result.updated.showStartupHeader, false);
			const changedMode = scrollButtonMode === "dock" ? "native" : "dock";
			assert.equal(result.changedMode.scrollButtonMode, changedMode);
			assert.equal(result.changedMode.customNativeScrollToEndIndicatorText, expectedText);
			assert.equal(result.changedText.scrollButtonMode, changedMode);
			assert.equal(result.changedText.customNativeScrollToEndIndicatorText, !expectedText);
			assert.ok(result.status.split(" · ").includes(`scrollButton=${scrollButtonMode}`));
			assert.ok(
				result.status
					.split(" · ")
					.includes(`nativeScrollIndicatorText=${expectedText ? "on" : "off"}`),
			);
		});
	}
}
