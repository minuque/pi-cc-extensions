import assert from "node:assert/strict";
import { test } from "node:test";
import { isFullscreenTui, isLazyProxyTui } from "../extensions/utils/fullscreen-detect.ts";

test("fullscreen detection uses screen mode rather than lazy-proxy identity", () => {
	for (const mode of ["regular", "fullscreen"]) {
		const tui = {
			mode,
			get requestRender() {
				return () => {};
			},
		};
		assert.equal(isLazyProxyTui(tui), true);
		assert.equal(isFullscreenTui(tui), mode === "fullscreen");
	}
	assert.equal(isFullscreenTui({ mode: "fullscreen", requestRender() {} }), true);
});

test("a stable reference follows renderer changes", () => {
	let screen = { mode: "regular" };
	const reference = new Proxy({}, { get: (_target, key) => Reflect.get(screen, key) });
	assert.equal(isFullscreenTui(reference), false);
	screen = { mode: "fullscreen" };
	assert.equal(isFullscreenTui(reference), true);
});

test("missing and unavailable host references fail closed", () => {
	for (const tui of [undefined, null, false, "fullscreen", {}, { mode: "regular" }]) {
		assert.equal(isFullscreenTui(tui), false);
	}
	assert.equal(
		isFullscreenTui({
			get mode() {
				throw new Error("disposed");
			},
		}),
		false,
	);
});
