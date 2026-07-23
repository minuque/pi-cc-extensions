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

test("external dedicated renderers take priority over the ccstyle fallback", () => {
	const builtIn = {
		name: "edit",
		renderShell: "self",
		renderCall() {},
		renderResult() {},
	};

	assert.equal(
		preservesOriginalRenderer({ name: "edit", renderCall() {} }, "edit", builtIn),
		true,
	);
	assert.equal(
		preservesOriginalRenderer({ name: "edit", renderShell: "self" }, "edit", builtIn),
		true,
	);

	// Native definitions are eligible for ccstyle's fallback even when Pi gives
	// them their own renderer methods; extension definitions without a renderer
	// are ordinary fallback candidates as well.
	assert.equal(preservesOriginalRenderer(builtIn, "edit", builtIn), false);
	assert.equal(preservesOriginalRenderer({ name: "custom" }, "custom"), false);
	assert.equal(preservesOriginalRenderer(undefined, "read", builtIn), false);
	assert.equal(preservesOriginalRenderer(undefined, "Agent"), true);
});
