import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";
import { config, formatConfigStatus, normalizeConfig } from "../extensions/config/config.ts";
import {
	concreteToolMouseTui,
	installScrollIndicatorController,
	setToolMouseTui,
} from "../extensions/renderer/mouse/scroll.ts";
import { createLazyProxy } from "./fixtures/lazy-tui.ts";

test("scroll options stay independent and default to dock with native text customization enabled", () => {
	assert.equal(normalizeConfig({}).scrollButtonMode, "dock");
	for (const scrollButtonMode of ["dock", "native"] as const) {
		assert.equal(normalizeConfig({ scrollButtonMode }).customNativeScrollToEndIndicatorText, true);
		const options = normalizeConfig({
			scrollButtonMode,
			customNativeScrollToEndIndicatorText: false,
		});
		assert.equal(options.scrollButtonMode, scrollButtonMode);
		assert.equal(options.customNativeScrollToEndIndicatorText, false);
		assert.match(formatConfigStatus(options), new RegExp(`scrollButton=${scrollButtonMode}`));
		assert.match(formatConfigStatus(options), /nativeScrollIndicatorText=off/);
	}
});

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
	config.scrollButtonMode = "native";
	config.customNativeScrollToEndIndicatorText = true;
	let activeRenderer = renderer;
	const tui = createLazyProxy(() => activeRenderer);
	setToolMouseTui(tui);
	const adapter = installScrollIndicatorController();
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

for (const custom of [true, false]) {
	test(`scroll indicators: dock text is independent of native customization=${custom}`, (t) => {
		const { adapter, tui, renderer } = setup(t);
		config.scrollButtonMode = "dock";
		config.customNativeScrollToEndIndicatorText = custom;
		adapter.reconcile(tui);
		const theme = { fg: (_color: string, text: string) => text };
		assert.match(adapter.renderDock(80, theme)[0], /\[ ↓ Back to bottom · Ctrl\+End \]/);
		assert.equal(renderer.scrollToEndIndicator(), "", "dock suppresses the native overlay");
		for (const label of ["1 new message", "2 new messages"]) {
			adapter.noteItem();
			assert.ok(adapter.renderDock(80, theme)[0].includes(`[ ↓ ${label} · Ctrl+End ]`));
		}
		config.scrollButtonMode = "native";
		adapter.reconcile(tui);
		assert.deepEqual(adapter.renderDock(80, theme), []);
		assert.match(
			renderer.scrollToEndIndicator(),
			custom ? /Back to bottom/ : /Jump to latest message/,
		);
		for (const label of ["1 new message", "2 new messages"]) {
			adapter.noteItem();
			assert.ok(
				renderer.scrollToEndIndicator().includes(custom ? label : "Jump to latest message"),
			);
		}
		config.scrollButtonMode = "dock";
		adapter.reconcile(tui);
		assert.match(adapter.renderDock(80, theme)[0], /Back to bottom/);
		renderer.isFollowingOutput = true;
		adapter.reconcile(tui);
		assert.deepEqual(adapter.renderDock(80, theme), []);
	});
}

test("dock suppression does not invoke the hidden native text callback", (t) => {
	let calls = 0;
	const renderer = rendererFixture();
	renderer.scrollToEndIndicator = () => {
		calls++;
		return "Jump to latest message";
	};
	const { adapter, tui } = setup(t, renderer);
	config.scrollButtonMode = "dock";
	adapter.reconcile(tui);
	assert.equal(renderer.scrollToEndIndicator(), "");
	assert.equal(calls, 0);
	config.scrollButtonMode = "native";
	adapter.reconcile(tui);
	assert.equal(renderer.scrollToEndIndicator(), "Back to bottom");
	assert.equal(calls, 1);
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
	// A reloaded config module reads persisted settings, not this module's in-memory setup.
	const dir = mkdtempSync(join(tmpdir(), "cc-scroll-reload-"));
	const previousDir = process.env.PI_CODING_AGENT_DIR;
	let reloaded: typeof import("../extensions/renderer/mouse/scroll.ts");
	try {
		writeFileSync(join(dir, "pi-cc-extensions.json"), JSON.stringify(config));
		process.env.PI_CODING_AGENT_DIR = dir;
		reloaded = (await jiti.import(
			new URL("../extensions/renderer/mouse/scroll.ts", import.meta.url).pathname,
		)) as typeof import("../extensions/renderer/mouse/scroll.ts");
	} finally {
		if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousDir;
		rmSync(dir, { recursive: true, force: true });
	}
	const next = reloaded.installScrollIndicatorController();
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
	const again = reloaded.installScrollIndicatorController();
	t.after(() => again.dispose());
	again.reconcile(tui);
	assert.equal(renderer.scrollToEndIndicator, foreign);
	again.dispose();
	assert.equal(renderer.scrollToEndIndicator, foreign);
});
