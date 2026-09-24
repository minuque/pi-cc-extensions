import assert from "node:assert/strict";
import test from "node:test";

import {
	CURSOR_DEDUPE_KEY,
	installCursorWriteDedupe,
} from "../extensions/renderer/cursor-dedupe.ts";

function fakeTerminal() {
	const writes: string[] = [];
	return {
		writes,
		terminal: {
			showCursor() {
				writes.push("show");
			},
			hideCursor() {
				writes.push("hide");
			},
		} as any,
	};
}

test("光标写去重：状态未变时不重复写转义", () => {
	const { writes, terminal } = fakeTerminal();
	installCursorWriteDedupe({ terminal });

	terminal.showCursor();
	terminal.showCursor();
	terminal.hideCursor();
	terminal.hideCursor();
	terminal.hideCursor();
	terminal.showCursor();

	assert.deepEqual(writes, ["show", "hide", "show"]);
});

test("alt-screen 直写的 ?25h/l 会同步回去重状态", () => {
	const writes: string[] = [];
	const terminal = {
		showCursor() {
			writes.push("show");
		},
		hideCursor() {
			writes.push("hide");
		},
		write(data: string) {
			writes.push(`write:${data}`);
		},
	} as any;
	installCursorWriteDedupe({ terminal });

	// 先隐藏，切到 fullscreen 后 alt-screen 直写 ?25h（绕过两个方法）
	terminal.hideCursor();
	terminal.write("\x1b[?2026h\x1b[?25h\x1b[?2026l");
	// 状态已同步，切回 regular 后该写的 hide 不能被吞掉
	terminal.hideCursor();
	assert.deepEqual(writes, ["hide", "write:\x1b[?2026h\x1b[?25h\x1b[?2026l", "hide"]);

	// 同一条写出内容里以最后一次出现的序列为准
	terminal.write("\x1b[?25h\x1b[?25l");
	terminal.hideCursor();
	assert.equal(writes.filter((item) => item === "hide").length, 2);
});

test("重复安装不再包裹，缺少光标方法时跳过", () => {
	const { terminal } = fakeTerminal();
	installCursorWriteDedupe({ terminal });
	const wrappedShow = terminal.showCursor;
	const wrappedHide = terminal.hideCursor;
	installCursorWriteDedupe({ terminal });
	assert.equal(terminal.showCursor, wrappedShow);
	assert.equal(terminal.hideCursor, wrappedHide);
	assert.ok((terminal as Record<PropertyKey, unknown>)[CURSOR_DEDUPE_KEY]);

	const bare = {} as any;
	installCursorWriteDedupe({ terminal: bare });
	assert.equal((bare as Record<PropertyKey, unknown>)[CURSOR_DEDUPE_KEY], undefined);
});
