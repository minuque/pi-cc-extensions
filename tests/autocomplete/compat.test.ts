import assert from "node:assert/strict";
import test from "node:test";
import type { AutocompleteProvider } from "@earendil-works/pi-tui";
import { createAgentAutocompleteProvider } from "../../extensions/agent-autocomplete.ts";
import { createAutocompleteProvider as createSessionAutocompleteProvider } from "../../extensions/session-reference/index.ts";

const fffProvider: AutocompleteProvider = {
	async getSuggestions(lines, cursorLine, cursorCol) {
		const beforeCursor = (lines[cursorLine] ?? "").slice(0, cursorCol);
		const match = beforeCursor.match(/(?:^|[\t ])(@[^\s]*)$/);
		if (!match) return null;
		return {
			prefix: match[1]!,
			items: [{ value: "@src/index.ts", label: "index.ts", description: "src/index.ts" }],
		};
	},
	applyCompletion(lines, cursorLine, cursorCol) {
		return { lines, cursorLine, cursorCol };
	},
};

const references = [{
	kind: "session",
	referenceIds: ["session-1"],
	info: {
		id: "session-1",
		name: "Previous work",
		cwd: "/repo",
		firstMessage: "",
		messageCount: 3,
		modified: new Date("2025-01-02T03:04:05.000Z"),
	},
}];

const agents = [{
	name: "coder",
	displayName: "Coder",
	description: "Implement focused changes",
	filePath: "/agents/coder.md",
}];

test("agent and session autocomplete compose with an FFF provider that claims @ prefixes", async () => {
	const sessions = createSessionAutocompleteProvider(
		fffProvider,
		async () => references as any,
		"/repo",
	);
	const provider = createAgentAutocompleteProvider(sessions, () => agents);
	const controller = new AbortController();
	const result = await provider.getSuggestions(["@"], 0, 1, { signal: controller.signal });

	assert.equal(result?.prefix, "@");
	assert.deepEqual(result?.items.map((item) => item.label), [
		"[SubAgent] Coder",
		"[Session] Previous work",
		"index.ts",
	]);
});

test("agent autocomplete does not duplicate delegated agent entries", async () => {
	const delegated: AutocompleteProvider = {
		...fffProvider,
		async getSuggestions() {
			return {
				prefix: "@coder",
				items: [{ value: "@coder", label: "[SubAgent] Coder", description: "duplicate" }],
			};
		},
	};
	const provider = createAgentAutocompleteProvider(delegated, () => agents);
	const result = await provider.getSuggestions(
		["@coder"],
		0,
		6,
		{ signal: new AbortController().signal },
	);

	assert.equal(result?.items.length, 1);
	assert.equal(result?.items[0]?.value, "@coder");
});
