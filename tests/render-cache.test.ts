import assert from "node:assert/strict";
import test from "node:test";
import { ExpandedToolResultText } from "../extensions/claude-code-style.ts";
import { createWrappedTextCache } from "../extensions/context.ts";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

function expectedExpandedLines(text: string, prefix: string, width: number): string[] {
	const normalized = text.replace(/\t/g, "   ").replace(/\n+$/, "");
	const contentWidth = Math.max(1, width - visibleWidth(prefix));
	return wrapTextWithAnsi(normalized, contentWidth)
		.map((line) => truncateToWidth(prefix + line, width, ""));
}

test("ExpandedToolResultText preserves lines while caching one width", () => {
	const text = "\x1b[31mfirst\tline with enough content to wrap\nsecond\n\n";
	const prefix = "\x1b[31m  │ \x1b[0m";
	const component = new ExpandedToolResultText(text, prefix);

	const wide = component.render(24);
	assert.deepEqual(wide, expectedExpandedLines(text, prefix, 24));
	assert.strictEqual(component.render(24), wide);

	const narrow = component.render(12);
	assert.deepEqual(narrow, expectedExpandedLines(text, prefix, 12));
	assert.notStrictEqual(narrow, wide);

	const wideAgain = component.render(24);
	assert.deepEqual(wideAgain, expectedExpandedLines(text, prefix, 24));
	assert.notStrictEqual(wideAgain, wide, "only the most recent width is cached");

	component.invalidate();
	const afterInvalidate = component.render(24);
	assert.deepEqual(afterInvalidate, expectedExpandedLines(text, prefix, 24));
	assert.notStrictEqual(afterInvalidate, wideAgain);

	const changedText = "updated\tcontent\n";
	component.setText(changedText);
	assert.deepEqual(component.render(24), expectedExpandedLines(changedText, prefix, 24));
});

test("text preview cache returns equivalent lines and recomputes after width/invalidate", () => {
	const content = "\x1b[36mfirst line with enough content to wrap\nsecond line";
	const cache = createWrappedTextCache(content);

	const wide = cache.get(24);
	assert.deepEqual(wide, wrapTextWithAnsi(content, 24));
	assert.strictEqual(cache.get(24), wide);

	const narrow = cache.get(12);
	assert.deepEqual(narrow, wrapTextWithAnsi(content, 12));
	assert.notStrictEqual(narrow, wide);

	const wideAgain = cache.get(24);
	assert.deepEqual(wideAgain, wrapTextWithAnsi(content, 24));
	assert.notStrictEqual(wideAgain, wide, "only the most recent width is cached");

	cache.invalidate();
	const afterInvalidate = cache.get(24);
	assert.deepEqual(afterInvalidate, wrapTextWithAnsi(content, 24));
	assert.notStrictEqual(afterInvalidate, wideAgain);
});
