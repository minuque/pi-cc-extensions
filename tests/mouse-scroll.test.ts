import assert from "node:assert/strict";
import test from "node:test";

import { config } from "../extensions/config/config.ts";
import {
	disableOfficialScrollToEnd,
	getScrollButtonNewCount,
	hideScrollButton,
	noteNewTranscriptItem,
	renderScrollButton,
	resetScrollButtonState,
	restoreOfficialScrollToEnd,
	scheduleScrollButtonSync,
	setFullscreenSelectionActive,
	setToolMouseTui,
	syncOfficialScrollToEnd,
} from "../extensions/renderer/mouse/scroll.ts";

/** 伪造官方 fullscreen 惰性 Proxy TUI：requestRender 每次 get 返回新函数。 */
function lazyFullscreenTui() {
	let renders = 0;
	const tui: any = {
		mode: "fullscreen",
		isFollowingOutput: false, // 不在 transcript 底部 → 按钮应显示
		activeSelection: false,
		hasActiveSelection() {
			return this.activeSelection;
		},
		previousLines: [],
		get requestRender() {
			return () => {
				renders++;
			};
		},
	};
	return { tui, count: () => renders };
}

function fakeTheme() {
	return { fg: (_c: string, t: string) => t };
}

// SGR 滚轮包（code 65 = 向下滚动），不依赖键绑定表，纯字符串解析即可命中。
const WHEEL_DOWN_INPUT = "\x1b[<65;1;1M";

// 滚动按钮状态机：调度后立即 teardown（/reload 中途）不得残留渲染或状态，
// 重新 install 后调度必须恢复正常。
test("scroll button: schedule → immediate teardown → reinstall stays safe", async () => {
	const { tui, count } = lazyFullscreenTui();

	// 1. 调度后立即 teardown（模拟 reload 中途打断）
	setToolMouseTui(tui);
	scheduleScrollButtonSync(tui, WHEEL_DOWN_INPUT);
	resetScrollButtonState();
	setToolMouseTui(null);
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(count(), 0, "teardown 后待执行回调不得触发渲染");
	assert.deepEqual(renderScrollButton(80, fakeTheme()), [], "teardown 后按钮不得显示");

	// 2. 重新 install 后调度恢复正常
	setToolMouseTui(tui);
	scheduleScrollButtonSync(tui, WHEEL_DOWN_INPUT);
	await new Promise((resolve) => setImmediate(resolve));
	assert.ok(count() >= 1, "reinstall 后滚动导航应触发按钮渲染");
	const lines = renderScrollButton(80, fakeTheme());
	assert.ok(
		lines.some((line) => line.includes("Back to bottom")),
		"不在底部时按钮应可见",
	);

	// 3. 清理
	resetScrollButtonState();
	setToolMouseTui(null);
});

test("scroll button: stays hidden throughout fullscreen text selection", async () => {
	const { tui } = lazyFullscreenTui();
	setToolMouseTui(tui);
	scheduleScrollButtonSync(tui, WHEEL_DOWN_INPUT);
	await new Promise((resolve) => setImmediate(resolve));
	assert.ok(renderScrollButton(80, fakeTheme()).length > 0);

	setFullscreenSelectionActive(true, tui);
	assert.deepEqual(renderScrollButton(80, fakeTheme()), [], "拖选时不显示回底按钮");

	setFullscreenSelectionActive(false, tui);
	tui.activeSelection = true;
	assert.deepEqual(renderScrollButton(80, fakeTheme()), [], "松手后的活动选区仍隐藏按钮");

	tui.activeSelection = false;
	assert.ok(renderScrollButton(80, fakeTheme()).length > 0, "选区清除后恢复按钮");
	resetScrollButtonState();
	setToolMouseTui(null);
});

// 0.85 关掉官方 overlay，本仓库 dock 按钮照常。
test("scroll button: disable official overlay keeps dock button", async () => {
	const { tui, count } = lazyFullscreenTui();
	tui.scrollToEndIndicator = () => "Jump to latest message";
	setToolMouseTui(tui);
	disableOfficialScrollToEnd(tui);
	assert.equal(tui.scrollToEndIndicator, undefined);

	scheduleScrollButtonSync(tui, WHEEL_DOWN_INPUT);
	await new Promise((resolve) => setImmediate(resolve));
	assert.ok(count() >= 1);
	assert.ok(
		renderScrollButton(80, fakeTheme()).some((line) => line.includes("Back to bottom")),
		"关掉官方 overlay 后 dock 按钮仍可见",
	);

	resetScrollButtonState();
	setToolMouseTui(null);
});

// /ccstyle off：还回官方 overlay，不画本仓库 dock 按钮。
test("scroll button: off mode restores official overlay", () => {
	const previousMode = config.mode;
	const { tui } = lazyFullscreenTui();
	const indicator = () => "Jump to latest message";
	tui.scrollToEndIndicator = indicator;
	try {
		config.mode = "on";
		disableOfficialScrollToEnd(tui);
		assert.equal(tui.scrollToEndIndicator, undefined);

		config.mode = "off";
		syncOfficialScrollToEnd(tui);
		assert.equal(tui.scrollToEndIndicator, indicator);
		assert.deepEqual(renderScrollButton(80, fakeTheme()), []);

		config.mode = "on";
		syncOfficialScrollToEnd(tui);
		assert.equal(tui.scrollToEndIndicator, undefined);

		restoreOfficialScrollToEnd(tui);
		assert.equal(tui.scrollToEndIndicator, indicator);
	} finally {
		config.mode = previousMode;
		resetScrollButtonState();
		setToolMouseTui(null);
	}
});

// 计数：仅在离开底部期间累加，文案从 Back to bottom 切成 N new message(s)，回底清零。
test("scroll button: accumulates new content count while scrolled up", async () => {
	const { tui } = lazyFullscreenTui();
	setToolMouseTui(tui);

	// 跟随输出时新内容不计数。
	noteNewTranscriptItem();
	assert.equal(getScrollButtonNewCount(), 0, "在底部时不得计数");

	// 滚动离开底部 → 按钮可见，开始记账。
	scheduleScrollButtonSync(tui, WHEEL_DOWN_INPUT);
	await new Promise((resolve) => setImmediate(resolve));
	assert.ok(
		renderScrollButton(80, fakeTheme()).some((line) => line.includes("Back to bottom")),
		"无新内容时保持 Back to bottom 文案",
	);

	noteNewTranscriptItem();
	let text = renderScrollButton(80, fakeTheme()).join("\n");
	assert.ok(text.includes("[ ↓ 1 new message · Ctrl+End ]"), `单条用单数：${text}`);

	noteNewTranscriptItem();
	noteNewTranscriptItem();
	text = renderScrollButton(80, fakeTheme()).join("\n");
	assert.ok(text.includes("[ ↓ 3 new messages · Ctrl+End ]"), `多条用复数：${text}`);
	assert.ok(!text.includes("Back to bottom"), "有计数时不再显示原正文");

	// 滚回底部：按钮隐藏且计数清零；再离开底部时从 0 重新计数。
	tui.isFollowingOutput = true;
	scheduleScrollButtonSync(tui, WHEEL_DOWN_INPUT);
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(getScrollButtonNewCount(), 0, "回到底部即清零");
	assert.deepEqual(renderScrollButton(80, fakeTheme()), []);

	tui.isFollowingOutput = false;
	scheduleScrollButtonSync(tui, WHEEL_DOWN_INPUT);
	await new Promise((resolve) => setImmediate(resolve));
	assert.ok(
		renderScrollButton(80, fakeTheme()).some((line) => line.includes("Back to bottom")),
		"重新离开底部后回到原文案",
	);

	// 点击/快捷键回到底部（hideScrollButton）同样清零。
	noteNewTranscriptItem();
	hideScrollButton(tui);
	assert.equal(getScrollButtonNewCount(), 0, "回到底部按钮触发后清零");

	// 官方直接跳回底部（提交新消息）时，下一次记账先校正状态，不把跟随期间的内容计入。
	tui.isFollowingOutput = false;
	scheduleScrollButtonSync(tui, WHEEL_DOWN_INPUT);
	await new Promise((resolve) => setImmediate(resolve));
	assert.ok(renderScrollButton(80, fakeTheme()).length > 0, "离开底部时按钮可见");
	tui.isFollowingOutput = true;
	noteNewTranscriptItem();
	assert.equal(getScrollButtonNewCount(), 0, "已跟随底部时不计入新内容");
	assert.deepEqual(renderScrollButton(80, fakeTheme()), [], "校正后按钮隐藏");

	resetScrollButtonState();
	setToolMouseTui(null);
});
