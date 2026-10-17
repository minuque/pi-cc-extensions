import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";
import { config, formatConfigStatus, normalizeConfig } from "../extensions/config/config.ts";
import {
	concreteToolMouseTui,
	installNativeScrollIndicator,
	setToolMouseTui,
} from "../extensions/renderer/mouse/scroll.ts";
import { createLazyProxy } from "./fixtures/lazy-tui.ts";

function rendererFixture() {
	return {
		mode: "fullscreen",
		isFollowingOutput: false,
		requestRender() {},
		scrollToEndIndicator() {
			return `Jump to latest message:${this.mode}`;
		},
	};
}

function setup(t: TestContext, renderer: any = rendererFixture()) {
	const previous = { ...config };
	config.mode = "on";
	config.customScrollToEndIndicatorText = true;
	let activeRenderer = renderer;
	const tui = createLazyProxy(() => activeRenderer);
	setToolMouseTui(tui);
	const adapter = installNativeScrollIndicator();
	t.after(() => {
		adapter.dispose();
		setToolMouseTui(null);
		Object.assign(config, previous);
	});
	return {
		adapter,
		tui,
		renderer,
		switchTo(next: any) {
			activeRenderer = next;
			adapter.reconcile(tui);
		},
	};
}

test("native indicator: defaults, legacy migration, explicit boolean precedence and short status", () => {
	assert.equal(normalizeConfig({}).customScrollToEndIndicatorText, true);
	for (const [legacy, expected] of [
		["dock", true],
		["native", false],
		["invalid", true],
	] as const) {
		assert.equal(
			normalizeConfig({ scrollButtonMode: legacy }).customScrollToEndIndicatorText,
			expected,
		);
		assert.equal(
			normalizeConfig({ scrollButtonMode: legacy, customScrollToEndIndicatorText: "false" })
				.customScrollToEndIndicatorText,
			expected,
		);
		for (const value of [true, false]) {
			const normalized = normalizeConfig({
				scrollButtonMode: legacy,
				customScrollToEndIndicatorText: value,
			});
			assert.equal(normalized.customScrollToEndIndicatorText, value);
			assert.ok(!("scrollButtonMode" in normalized));
			assert.match(
				formatConfigStatus(normalized),
				new RegExp(`scrollIndicatorText=${value ? "on" : "off"}`),
			);
			assert.doesNotMatch(
				formatConfigStatus(normalized),
				/scrollButton=|customScrollToEndIndicatorText=/,
			);
		}
	}
});

test("native indicator: saving migrated config writes only the new boolean", () => {
	const dir = mkdtempSync(join(tmpdir(), "cc-scroll-config-"));
	try {
		const path = join(dir, "pi-cc-extensions.json");
		writeFileSync(path, JSON.stringify({ scrollButtonMode: "native" }));
		const env: NodeJS.ProcessEnv = { ...process.env, PI_CODING_AGENT_DIR: dir };
		delete env.PI_PACKAGE_DIR;
		execFileSync(
			process.execPath,
			[
				"--input-type=module",
				"-e",
				`import { saveConfig } from ${JSON.stringify(new URL("../extensions/config/config.ts", import.meta.url).href)}; saveConfig();`,
			],
			{ env },
		);
		const saved = JSON.parse(readFileSync(path, "utf8"));
		assert.equal(saved.customScrollToEndIndicatorText, false);
		assert.ok(!("scrollButtonMode" in saved));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("native indicator: replaces only the known phrase and preserves the raw callback contract", (t) => {
	let text: unknown = "";
	let calls = 0;
	const renderer: any = rendererFixture();
	renderer.scrollToEndIndicator = function (this: any, arg: string) {
		assert.equal(this, renderer);
		assert.equal(arg, "native argument");
		calls++;
		return text;
	};
	const { adapter, tui } = setup(t, renderer);
	adapter.reconcile(tui);
	for (const label of [
		"",
		"\x1b[37m\x1b[39m",
		"another extension's label",
		undefined,
		"\x1b[44m ↓ Jump to latest message · native shortcut \x1b[49m",
	]) {
		text = label;
		const before = calls;
		assert.equal(
			renderer.scrollToEndIndicator("native argument"),
			typeof label === "string" ? label.replace("Jump to latest message", "Back to bottom") : label,
		);
		assert.equal(calls, before + 1);
	}
});

test("native indicator: unsupported fields, failed unwrapping and frozen cleanup stay native", (t) => {
	const { adapter, switchTo } = setup(t);
	const inherited = Object.assign(Object.create({ scrollToEndIndicator: () => "inherited" }), {
		mode: "fullscreen",
		requestRender() {},
	});
	const accessor = rendererFixture();
	let writes = 0;
	Object.defineProperty(accessor, "scrollToEndIndicator", {
		get: () => () => "accessor",
		set: () => {
			writes++;
		},
		configurable: true,
	});
	const readonly = rendererFixture();
	Object.defineProperty(readonly, "scrollToEndIndicator", { writable: false });
	const absent: any = rendererFixture();
	delete absent.scrollToEndIndicator;
	const unavailable = {
		...rendererFixture(),
		valueOf() {
			throw new Error("unavailable");
		},
	};
	for (const renderer of [
		absent,
		{ ...rendererFixture(), scrollToEndIndicator: undefined },
		{ ...rendererFixture(), scrollToEndIndicator: false },
		inherited,
		accessor,
		readonly,
		Object.freeze(rendererFixture()),
		unavailable,
	]) {
		const before = Object.getOwnPropertyDescriptors(renderer);
		switchTo(renderer);
		assert.deepEqual(Object.getOwnPropertyDescriptors(renderer), before);
	}
	assert.equal(writes, 0);
	assert.equal(concreteToolMouseTui(createLazyProxy(() => unavailable)), null);
	const frozen = rendererFixture();
	const original = frozen.scrollToEndIndicator;
	switchTo(frozen);
	Object.freeze(frozen);
	assert.doesNotThrow(() => adapter.dispose());
	assert.equal(frozen.scrollToEndIndicator(), original.call(frozen));
});

test("native indicator: proxy renderer switches restore raw callbacks without retarget recursion", (t) => {
	const { adapter, tui, renderer, switchTo } = setup(t);
	const original = renderer.scrollToEndIndicator;
	assert.equal(Object.getOwnPropertyDescriptor(tui, "scrollToEndIndicator"), undefined);
	assert.notEqual(tui.scrollToEndIndicator, tui.scrollToEndIndicator);
	adapter.reconcile(tui);
	const captured = renderer.scrollToEndIndicator;
	adapter.reconcile(tui);
	assert.equal(renderer.scrollToEndIndicator, captured);
	switchTo({ ...rendererFixture(), mode: "regular" });
	assert.equal(renderer.scrollToEndIndicator, original);
	const next = rendererFixture();
	const nextOriginal = next.scrollToEndIndicator;
	switchTo(next);
	assert.match(tui.scrollToEndIndicator(), /Back to bottom/);
	assert.equal(captured.call(renderer), original.call(renderer));
	switchTo(renderer);
	assert.equal(next.scrollToEndIndicator, nextOriginal);
	assert.match(tui.scrollToEndIndicator(), /Back to bottom/);
});

test("native indicator: module reload preserves takeover ownership and relinquished renderers", async (t) => {
	const { adapter, tui, renderer } = setup(t);
	const original = renderer.scrollToEndIndicator;
	adapter.reconcile(tui);
	const old = renderer.scrollToEndIndicator;
	const jiti = createJiti(import.meta.url, { moduleCache: false });
	const reloaded = (await jiti.import(
		new URL("../extensions/renderer/mouse/scroll.ts", import.meta.url).pathname,
	)) as typeof import("../extensions/renderer/mouse/scroll.ts");
	const next = reloaded.installNativeScrollIndicator();
	t.after(() => next.dispose());
	next.reconcile(tui);
	const installed = renderer.scrollToEndIndicator;
	assert.notEqual(installed, old);
	adapter.dispose();
	adapter.reconcile(tui);
	assert.equal(renderer.scrollToEndIndicator, installed);
	assert.equal(old.call(renderer), original.call(renderer));
	const foreign = () => "foreign label";
	renderer.scrollToEndIndicator = foreign;
	next.dispose(); // 未经下一帧 reconcile 也必须记住让渡
	const again = reloaded.installNativeScrollIndicator();
	t.after(() => again.dispose());
	again.reconcile(tui);
	assert.equal(renderer.scrollToEndIndicator, foreign);
	again.dispose();
	assert.equal(renderer.scrollToEndIndicator, foreign);
});
