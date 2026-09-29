import assert from "node:assert/strict";
import test from "node:test";

import { stripTerminalSequencesPreservingLayout } from "../extensions/utils/ansi-text.ts";

test("terminal sequence stripping preserves visible text around OSC 8 links", () => {
	for (const terminator of ["\x07", "\x1b\\"] as const) {
		const open = `\x1b]8;;https://example.test${terminator}`;
		const close = `\x1b]8;;${terminator}`;
		const rendered = `前 ${open}链接🙂${close} sibling`;
		assert.equal(stripTerminalSequencesPreservingLayout(rendered), "前 链接🙂 sibling");
	}
});
