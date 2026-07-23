import assert from "node:assert/strict";
import test from "node:test";
import type { AutocompleteProvider } from "@earendil-works/pi-tui";
import { createAgentAutocompleteProvider } from "../extensions/agent-autocomplete.ts";
import { createAutocompleteProvider as createSessionAutocompleteProvider } from "../extensions/session-reference.ts";

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
		"index.ts",
		"[Session] Previous work",
	]);
});

test("session autocomplete caps sessions at three and interleaves files two-to-one", async () => {
	const manyReferences = Array.from({ length: 5 }, (_, index) => ({
		kind: "session",
		referenceIds: [`session-${index}`],
		info: {
			id: `session-${index}`,
			name: `Session ${index}`,
			cwd: "/repo",
			firstMessage: "",
			messageCount: index,
			modified: new Date(2025, 0, index + 1),
		},
	}));
	const files: AutocompleteProvider = {
		...fffProvider,
		async getSuggestions() {
			return {
				prefix: "@",
				items: Array.from({ length: 9 }, (_, index) => ({
					value: `@src/file-${index}.ts`,
					label: `file-${index}.ts`,
				})),
			};
		},
	};
	const provider = createSessionAutocompleteProvider(files, async () => manyReferences as any, "/repo");
	const result = await provider.getSuggestions(["@"], 0, 1, { signal: new AbortController().signal });
	const labels = result?.items.map((item) => item.label) ?? [];

	assert.equal(labels.length, 10);
	assert.equal(labels.filter((label) => label.startsWith("[Session]")).length, 3);
	assert.deepEqual(labels.slice(0, 6), [
		"file-0.ts",
		"file-1.ts",
		"[Session] Session 4",
		"file-2.ts",
		"file-3.ts",
		"[Session] Session 3",
	]);
});

test("path-like queries put file candidates before sessions", async () => {
	const pathReference = [{
		...references[0],
		info: { ...references[0]!.info, name: "foo.ts migration" },
	}];
	const files: AutocompleteProvider = {
		...fffProvider,
		async getSuggestions() {
			return {
				prefix: "@foo.ts",
				items: Array.from({ length: 2 }, (_, index) => ({
					value: `@foo.ts-${index}`,
					label: `foo.ts-${index}`,
				})),
			};
		},
	};
	const provider = createSessionAutocompleteProvider(files, async () => pathReference as any, "/repo");
	const result = await provider.getSuggestions(
		["@foo.ts"],
		0,
		7,
		{ signal: new AbortController().signal },
	);

	assert.deepEqual(result?.items.map((item) => item.label), [
		"foo.ts-0",
		"foo.ts-1",
		"[Session] foo.ts migration",
	]);
});

test("agent autocomplete shows at most two agent candidates", async () => {
	const provider = createAgentAutocompleteProvider(fffProvider, () =>
		Array.from({ length: 4 }, (_, index) => ({
			name: `agent-${index}`,
			displayName: `Agent ${index}`,
			description: "",
			filePath: `/agents/agent-${index}.md`,
		})),
	);
	const result = await provider.getSuggestions(["@"], 0, 1, { signal: new AbortController().signal });

	assert.equal(result?.items.filter((item) => item.label.startsWith("[SubAgent]")).length, 2);
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
