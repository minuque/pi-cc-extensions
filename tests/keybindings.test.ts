import assert from "node:assert/strict";
import test from "node:test";

import {
	formatKeyText,
	keyDisplayText,
	keybindings,
	keyText,
	setInjectedKeyText,
	setInjectedKeybindings,
} from "../extensions/utils/keybindings.ts";

const DARWIN = process.platform === "darwin";
const ALT_X = DARWIN ? "option+x" : "alt+x";
const ALT_X_DISPLAY = DARWIN ? "Option+X" : "Alt+X";

test("字面按键串格式化", () => {
	assert.equal(formatKeyText("ctrl+o"), "ctrl+o");
	assert.equal(formatKeyText("ctrl+o/shift+o"), "ctrl+o/shift+o");
});

test("没有注入时按 pi-tui 的默认绑定格式化", () => {
	assert.equal(keyText("tui.select.confirm"), "enter");
	assert.equal(keyDisplayText("tui.select.confirm"), "Enter");
	assert.equal(keyText("app.nothing.bound"), "");
});

test("只注入 KeybindingsManager 时按它取键", () => {
	setInjectedKeybindings({
		getKeys: () => ["alt+x"],
		matches: () => true,
	} as never);
	assert.equal(keyText("app.thinking.toggle"), ALT_X);
	assert.equal(keyDisplayText("app.thinking.toggle"), ALT_X_DISPLAY);
	assert.equal(keybindings().matches("", "app.thinking.toggle"), true);

	// 不匹配的值被忽略
	setInjectedKeybindings({} as never);
	assert.equal(keyText("app.thinking.toggle"), ALT_X);
});

test("注入的 keyText 说了算", () => {
	setInjectedKeyText((id: string) => (id === "tui.select.confirm" ? "ctrl+e" : ""));
	assert.equal(keyText("tui.select.confirm"), "ctrl+e", "注入文本盖过默认绑定");
	assert.equal(keyDisplayText("tui.select.confirm"), "Ctrl+E");
	assert.equal(keyText("app.thinking.toggle"), "", "注入值给空串就显示空串");

	// 不匹配的值被忽略
	setInjectedKeyText(42 as never);
	assert.equal(keyText("tui.select.confirm"), "ctrl+e");
});
