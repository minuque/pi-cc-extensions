import assert from "node:assert/strict";
import test from "node:test";

import claudeCodeStyleExtension, { preservesOriginalRenderer } from "../extensions/claude-code-style.ts";

test("claude-code-style initialization does not register built-in tool overrides", () => {
	const registeredTools: unknown[] = [];
	const pi = {
		registerTool(tool: unknown) {
			registeredTools.push(tool);
		},
		registerCommand() {},
		registerShortcut() {},
		on() {},
	};

	claudeCodeStyleExtension(pi as any);

	assert.deepEqual(registeredTools, []);
});

test("ccstyle is the default renderer and exclusions preserve dedicated renderers", () => {
	const builtIn = {
		name: "edit",
		renderShell: "self",
		renderCall() {},
		renderResult() {},
	};

	assert.equal(
		preservesOriginalRenderer({ name: "edit", renderCall() {} }, "edit", builtIn),
		false,
	);
	assert.equal(
		preservesOriginalRenderer({ name: "edit", renderCall() {} }, "edit", builtIn, ["edit"]),
		true,
	);
	assert.equal(
		preservesOriginalRenderer(undefined, "edit", builtIn, ["edit"]),
		true,
	);
	assert.equal(
		preservesOriginalRenderer({ name: "custom" }, "custom", undefined, ["custom"]),
		false,
	);
	assert.equal(preservesOriginalRenderer(undefined, "Agent"), true);
});
