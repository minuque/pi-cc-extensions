import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";
import { getKeybindings } from "@earendil-works/pi-tui";
import { config, formatConfigStatus, normalizeConfig } from "../extensions/config/config.ts";
import {
	concreteToolMouseTui,
	installNativeScrollIndicator,
	noteNewTranscriptItem,
	resetNativeScrollIndicatorCount,
	setToolMouseTui,
} from "../extensions/renderer/mouse/scroll.ts";
import { createLazyProxy } from "./fixtures/lazy-tui.ts";
import { patchRegistry, TOOL_MOUSE_OWNER_KEY } from "../extensions/utils/patch-keys.ts";

const theme = {
	fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
	bg: (color: string, text: string) => `<${color}>${text}</${color}>`,
};

function rendererFixture() {
	return {
		mode: "fullscreen",
		isFollowingOutput: false,
		renders: 0,
		requestRender() {
			this.renders++;
		},
		scrollToEndIndicator() {
			return `original:${this.mode}`;
		},
	};
}

function setup(t: TestContext, renderer: any = rendererFixture()) {
	const previous = { ...config };
	const bindings = getKeybindings().getUserBindings();
	config.mode = "on";
	config.customScrollToEndIndicatorText = true;
	getKeybindings().setUserBindings({});
	let activeRenderer = renderer;
	const tui = createLazyProxy(() => activeRenderer);
	setToolMouseTui(tui);
	const adapter = installNativeScrollIndicator({}, () => theme);
	t.after(() => {
		adapter.dispose();
		setToolMouseTui(null);
		Object.assign(config, previous);
		getKeybindings().setUserBindings(bindings);
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

test("native indicator: defaults, legacy migration, explicit boolean precedence and status", () => {
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
				new RegExp(`customScrollToEndIndicatorText=${value ? "on" : "off"}`),
			);
			assert.doesNotMatch(formatConfigStatus(normalized), /scrollButton=/);
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

test("native indicator: raw descriptor ownership, native styling and 0/1/N item counts", (t) => {
	const { adapter, tui, renderer } = setup(t);
	const original = Object.getOwnPropertyDescriptor(renderer, "scrollToEndIndicator");
	assert.equal(Object.getOwnPropertyDescriptor(tui, "scrollToEndIndicator"), undefined);
	assert.notEqual(
		tui.scrollToEndIndicator,
		tui.scrollToEndIndicator,
		"proxy functions have no stable identity",
	);
	adapter.reconcile(tui);
	const wrapper = renderer.scrollToEndIndicator;
	assert.equal(
		wrapper.call(renderer),
		"<selectedBg><text> ↓ Back to bottom · Ctrl+End </text></selectedBg>",
	);
	noteNewTranscriptItem();
	assert.match(wrapper.call(renderer), / ↓ 1 new message · Ctrl\+End /);
	noteNewTranscriptItem();
	noteNewTranscriptItem();
	assert.match(wrapper.call(renderer), / ↓ 3 new messages · Ctrl\+End /);
	assert.equal(renderer.renders, 3);
	adapter.reconcile(tui);
	assert.equal(renderer.scrollToEndIndicator, wrapper, "reconciliation is idempotent");
	adapter.dispose();
	assert.deepEqual(Object.getOwnPropertyDescriptor(renderer, "scrollToEndIndicator"), original);
	assert.equal(
		wrapper.call(renderer),
		"original:fullscreen",
		"captured stale callback delegates with this",
	);
});

test("native indicator: nonconfigurable writable data descriptors restore exactly", (t) => {
	const renderer = rendererFixture();
	const original = function (this: any, suffix: string) {
		return `${this.mode}:${suffix}`;
	};
	Object.defineProperty(renderer, "scrollToEndIndicator", {
		value: original,
		writable: true,
		configurable: false,
		enumerable: false,
	});
	const descriptor = Object.getOwnPropertyDescriptor(renderer, "scrollToEndIndicator");
	const { adapter, tui } = setup(t, renderer);
	adapter.reconcile(tui);
	const installed = renderer.scrollToEndIndicator;
	assert.match(installed.call(renderer), /Back to bottom/);
	adapter.dispose();
	assert.deepEqual(Object.getOwnPropertyDescriptor(renderer, "scrollToEndIndicator"), descriptor);
	assert.equal(Reflect.apply(installed, renderer, ["raw-args"]), "fullscreen:raw-args");
});

test("native indicator: configured empty, remapped and multiple shortcuts, live themes", (t) => {
	const { adapter, tui, renderer } = setup(t);
	adapter.dispose();
	let activeTheme = theme;
	const live = installNativeScrollIndicator({}, () => activeTheme);
	t.after(() => live.dispose());
	live.reconcile(tui);
	for (const [keys, label] of [
		[[], ""],
		[["alt+z"], process.platform === "darwin" ? " · Option+Z" : " · Alt+Z"],
		[["ctrl+end", "shift+g", "pageDown"], " · Ctrl+End/Shift+G/PageDown"],
	] as const) {
		getKeybindings().setUserBindings({ "tui.altScreen.bottom": [...keys] });
		assert.equal(
			renderer.scrollToEndIndicator(),
			`<selectedBg><text> ↓ Back to bottom${label} </text></selectedBg>`,
		);
	}
	activeTheme = { fg: (_c, s) => `new-fg:${s}`, bg: (_c, s) => `new-bg:${s}` };
	assert.match(renderer.scrollToEndIndicator(), /^new-bg:new-fg:/);
});

test("native indicator: respects dynamically empty and zero-width native callback results", (t) => {
	const renderer = rendererFixture();
	let nativeText = "";
	let calls = 0;
	renderer.scrollToEndIndicator = function () {
		assert.equal(this, renderer, "native callback keeps its receiver");
		calls++;
		return nativeText;
	};
	const { adapter, tui } = setup(t, renderer);
	adapter.reconcile(tui);
	for (const text of ["", "\x1b[37m\x1b[39m", "visible native label", ""]) {
		nativeText = text;
		const before = calls;
		const rendered = renderer.scrollToEndIndicator();
		assert.equal(calls, before + 1, "evaluate native visibility once per callback");
		if (text === "visible native label") assert.match(rendered, /Back to bottom/);
		else assert.equal(rendered, text, "native suppression is preserved exactly");
	}
});

test("native indicator: missing, disabled, inherited, accessor and frozen callbacks stay untouched", (t) => {
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
	for (const renderer of [
		absent,
		{ ...rendererFixture(), scrollToEndIndicator: undefined },
		{ ...rendererFixture(), scrollToEndIndicator: false },
		inherited,
		accessor,
		readonly,
		Object.freeze(rendererFixture()),
	]) {
		const before = Object.getOwnPropertyDescriptors(renderer);
		switchTo(renderer);
		adapter.reconcile(renderer);
		assert.deepEqual(Object.getOwnPropertyDescriptors(renderer), before);
	}
	assert.equal(writes, 0);
});

test("native indicator: regular/off/false preserve native labels; true/false/true resets count", (t) => {
	const { adapter, tui, renderer } = setup(t);
	const original = renderer.scrollToEndIndicator;
	for (const option of [false, true, false, true]) {
		config.customScrollToEndIndicatorText = option;
		adapter.reconcile(tui);
		assert.equal(renderer.scrollToEndIndicator === original, !option);
		if (option) {
			assert.match(renderer.scrollToEndIndicator(), /Back to bottom/);
			noteNewTranscriptItem();
			assert.match(renderer.scrollToEndIndicator(), /1 new message/);
		}
	}
	config.mode = "off";
	adapter.reconcile(tui);
	assert.equal(renderer.scrollToEndIndicator, original);
	config.mode = "on";
	renderer.mode = "regular";
	adapter.reconcile(tui);
	assert.equal(renderer.scrollToEndIndicator, original);
});

test("native indicator: renderer switching restores raw originals without proxy retarget recursion", (t) => {
	const { adapter, tui, renderer, switchTo } = setup(t);
	const original = renderer.scrollToEndIndicator;
	adapter.reconcile(tui);
	const captured = renderer.scrollToEndIndicator;
	noteNewTranscriptItem();
	const next = rendererFixture();
	const nextOriginal = next.scrollToEndIndicator;
	switchTo({ ...rendererFixture(), mode: "regular" });
	assert.equal(renderer.scrollToEndIndicator, original);
	switchTo(next);
	assert.match(tui.scrollToEndIndicator(), /Back to bottom/);
	assert.equal(captured.call(renderer), "original:fullscreen");
	switchTo(renderer);
	assert.equal(next.scrollToEndIndicator, nextOriginal);
	assert.match(tui.scrollToEndIndicator(), /Back to bottom/);
});

test("native indicator: foreign replacement wins, including captured old wrapper and toggles", (t) => {
	const { adapter, tui, renderer } = setup(t);
	adapter.reconcile(tui);
	const captured = renderer.scrollToEndIndicator;
	const foreign = function (this: any) {
		return `foreign:${captured.call(this)}`;
	};
	renderer.scrollToEndIndicator = foreign;
	assert.equal(
		foreign.call(renderer),
		"foreign:original:fullscreen",
		"stale customization deactivates even before reconciliation",
	);
	for (const option of [true, false, true]) {
		config.customScrollToEndIndicatorText = option;
		adapter.reconcile(tui);
		noteNewTranscriptItem();
		assert.equal(renderer.scrollToEndIndicator, foreign);
	}
	adapter.dispose();
	assert.equal(renderer.scrollToEndIndicator, foreign);
});

test("native indicator: deleted/redefined properties are not recreated by cleanup", (t) => {
	const { adapter, tui, renderer } = setup(t);
	adapter.reconcile(tui);
	const captured = renderer.scrollToEndIndicator;
	delete renderer.scrollToEndIndicator;
	adapter.reconcile(tui);
	adapter.dispose();
	assert.ok(!("scrollToEndIndicator" in renderer));
	assert.equal(captured.call(renderer), "original:fullscreen");
});

test("native indicator: freeze after installation leaves an inactive delegating wrapper", (t) => {
	const { adapter, tui, renderer } = setup(t);
	adapter.reconcile(tui);
	const wrapper = renderer.scrollToEndIndicator;
	Object.freeze(renderer);
	assert.doesNotThrow(() => adapter.reconcile(tui));
	adapter.dispose();
	assert.equal(renderer.scrollToEndIndicator, wrapper);
	assert.equal(wrapper.call(renderer), "original:fullscreen");
});

test("native indicator: guarded valueOf failure stands down; known raw input this can still reconcile", (t) => {
	const renderer = {
		...rendererFixture(),
		valueOf() {
			throw new Error("unavailable");
		},
	};
	const { adapter, tui } = setup(t, renderer);
	const original = renderer.scrollToEndIndicator;
	assert.equal(concreteToolMouseTui(tui), null);
	adapter.reconcile(tui);
	assert.equal(renderer.scrollToEndIndicator, original);
	adapter.reconcile(tui, renderer);
	assert.match(renderer.scrollToEndIndicator(), /Back to bottom/);
});

test("native indicator: follow reconciliation resets counts without invoking the hidden callback", (t) => {
	const { adapter, tui, renderer } = setup(t);
	adapter.reconcile(tui);
	for (const reset of [
		() => adapter.reconcile(tui),
		noteNewTranscriptItem,
		resetNativeScrollIndicatorCount,
	]) {
		renderer.isFollowingOutput = false;
		noteNewTranscriptItem();
		assert.match(renderer.scrollToEndIndicator(), /1 new message/);
		renderer.isFollowingOutput = true;
		reset();
		renderer.isFollowingOutput = false;
		assert.match(renderer.scrollToEndIndicator(), /Back to bottom/);
	}
});

test("native indicator: a stale mouse owner delegates before its replacement widget mounts", (t) => {
	const { adapter, tui, renderer } = setup(t);
	patchRegistry.install(TOOL_MOUSE_OWNER_KEY, adapter.owner);
	const nextOwner = {};
	t.after(() => {
		patchRegistry.dispose(TOOL_MOUSE_OWNER_KEY, nextOwner);
	});
	adapter.reconcile(tui);
	const installed = renderer.scrollToEndIndicator;
	noteNewTranscriptItem();
	assert.match(installed.call(renderer), /1 new message/);
	patchRegistry.install(TOOL_MOUSE_OWNER_KEY, nextOwner);
	assert.equal(installed.call(renderer), "original:fullscreen");
	adapter.reconcile(tui);
	assert.equal(
		renderer.scrollToEndIndicator,
		installed,
		"stale reconcile cannot install another patch",
	);
});

test("native indicator: relinquished renderers remain native across reinstall and reload", async (t) => {
	const { adapter, tui, renderer } = setup(t);
	adapter.reconcile(tui);
	const foreign = () => "foreign label";
	renderer.scrollToEndIndicator = foreign;
	adapter.reconcile(tui);
	const jiti = createJiti(import.meta.url, { moduleCache: false });
	const reloaded = (await jiti.import(
		new URL("../extensions/renderer/mouse/scroll.ts", import.meta.url).pathname,
	)) as typeof import("../extensions/renderer/mouse/scroll.ts");
	for (const install of [installNativeScrollIndicator, reloaded.installNativeScrollIndicator]) {
		const next = install({}, () => theme);
		t.after(() => next.dispose());
		next.reconcile(tui);
		noteNewTranscriptItem();
		assert.equal(renderer.scrollToEndIndicator, foreign);
		next.dispose();
		assert.equal(renderer.scrollToEndIndicator, foreign);
	}
});

test("native indicator: reload takeover and late disposal cannot clobber the new runtime", async (t) => {
	const { adapter, tui, renderer } = setup(t);
	const original = renderer.scrollToEndIndicator;
	adapter.reconcile(tui);
	const old = renderer.scrollToEndIndicator;
	noteNewTranscriptItem();
	const jiti = createJiti(import.meta.url, { moduleCache: false });
	const reloaded = (await jiti.import(
		new URL("../extensions/renderer/mouse/scroll.ts", import.meta.url).pathname,
	)) as any;
	const next = reloaded.installNativeScrollIndicator({}, () => theme);
	t.after(() => next.dispose());
	next.reconcile(tui);
	const installed = renderer.scrollToEndIndicator;
	assert.notEqual(installed, old);
	assert.match(installed.call(renderer), /Back to bottom/);
	adapter.dispose();
	adapter.reconcile(tui);
	assert.equal(renderer.scrollToEndIndicator, installed);
	assert.equal(old.call(renderer), "original:fullscreen");
	next.dispose();
	next.dispose();
	assert.equal(renderer.scrollToEndIndicator, original);
});
