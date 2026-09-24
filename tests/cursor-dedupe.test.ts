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
