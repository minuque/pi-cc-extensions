import assert from "node:assert/strict";
import test from "node:test";
import type { AutocompleteProvider } from "@earendil-works/pi-tui";
import {
	createAgentAutocompleteProvider,
	extractSubagentReferenceNames,
	subagentReferenceValue,
} from "../extensions/feature/reference/subagent.ts";
import { createAutocompleteProvider as createSessionAutocompleteProvider } from "../extensions/feature/reference/index.ts";

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

const references = [
	{
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
	},
];

const agents = [
	{
		name: "coder",
		displayName: "Coder",
		description: "Implement focused changes",
		filePath: "/agents/coder.md",
	},
];

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
	assert.deepEqual(
		result?.items.map((item) => item.label),
		["[SubAgent] Coder", "index.ts", "[Session] Previous work"],
	);
});

test("agent autocomplete shows model and thinking in the description only", async () => {
	const provider = createAgentAutocompleteProvider(fffProvider, () => [
		{
			name: "coder",
			displayName: "coder",
			description: "This text must not appear",
			model: "deepseek/deepseek-v4-flash",
			thinking: "max",
			filePath: "/agents/coder.md",
		},
	]);
	const result = await provider.getSuggestions(["@"], 0, 1, {
		signal: new AbortController().signal,
	});

	assert.equal(result?.items[0]?.label, "[SubAgent] coder");
	assert.equal(result?.items[0]?.description, "deepseek/deepseek-v4-flash · max");
});

test("session autocomplete fuzzy-matches explicit session names only", async () => {
	const noFiles: AutocompleteProvider = {
		...fffProvider,
		async getSuggestions() {
			return null;
		},
	};
	const provider = createSessionAutocompleteProvider(
		noFiles,
		async () =>
			[
				{
					kind: "session",
					referenceIds: ["named-session"],
					info: {
						id: "named-session",
						name: "Release plan",
						cwd: "/repo",
						firstMessage: "alpha",
						messageCount: 1,
						modified: new Date("2025-01-02T03:04:05.000Z"),
					},
				},
				{
					kind: "session",
					referenceIds: ["unnamed-session"],
					info: {
						id: "unnamed-session",
						cwd: "/repo",
						firstMessage: "unrelated chatter",
						messageCount: 1,
						modified: new Date("2025-01-03T03:04:05.000Z"),
					},
				},
			] as any,
		"/repo",
	);
	const result = await provider.getSuggestions(["@release"], 0, 7, {
		signal: new AbortController().signal,
	});

	assert.deepEqual(
		result?.items.map((item) => item.label),
		["[Session] Release plan"],
	);
});

test("session candidate value uses the bracketed session name", async () => {
	const provider = createSessionAutocompleteProvider(
		fffProvider,
		async () => references as any,
		"/repo",
	);
	const result = await provider.getSuggestions(["@"], 0, 1, {
		signal: new AbortController().signal,
	});

	assert.deepEqual(
		result?.items.filter((item) => item.value.startsWith("@session:")).map((item) => item.value),
		["@session:[Previous work]"],
	);
});

test("unnamed unique session candidate uses the title not the id", async () => {
	const unnamed = [
		{
			kind: "session",
			referenceIds: ["019f78f7-526e-78ac-afa5-ff6d5e06beb8"],
			info: {
				id: "019f78f7-526e-78ac-afa5-ff6d5e06beb8",
				cwd: "/repo",
				firstMessage: "  Refactor\n\tthe auth module  ",
				messageCount: 2,
				modified: new Date("2025-01-02T03:04:05.000Z"),
			},
		},
	];
	const provider = createSessionAutocompleteProvider(
		fffProvider,
		async () => unnamed as any,
		"/repo",
	);
	const result = await provider.getSuggestions(["@"], 0, 1, {
		signal: new AbortController().signal,
	});

	assert.deepEqual(
		result?.items.filter((item) => item.value.startsWith("@session:")).map((item) => item.value),
		["@session:[Refactor the auth module]"],
	);
});

test("same-named sessions keep a readable dated token", async () => {
	const duplicates = [
		{
			...references[0],
			referenceIds: ["session-a"],
			info: { ...references[0]!.info, id: "session-a" },
		},
		{
			...references[0],
			referenceIds: ["session-b"],
			info: {
				...references[0]!.info,
				id: "session-b",
				modified: new Date("2025-01-03T03:04:05.000Z"),
			},
		},
	];
	const provider = createSessionAutocompleteProvider(
		fffProvider,
		async () => duplicates as any,
		"/repo",
	);
	const result = await provider.getSuggestions(["@"], 0, 1, {
		signal: new AbortController().signal,
	});

	assert.deepEqual(
		result?.items.filter((item) => item.value.startsWith("@session:")).map((item) => item.value),
		["@session:[Previous work 01-03]", "@session:[Previous work 01-02]"],
	);
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
	const provider = createSessionAutocompleteProvider(
		files,
		async () => manyReferences as any,
		"/repo",
	);
	const result = await provider.getSuggestions(["@"], 0, 1, {
		signal: new AbortController().signal,
	});
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
	const pathReference = [
		{
			...references[0],
			info: { ...references[0]!.info, name: "foo.ts migration" },
		},
	];
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
	const provider = createSessionAutocompleteProvider(
		files,
		async () => pathReference as any,
		"/repo",
	);
	const result = await provider.getSuggestions(["@foo.ts"], 0, 7, {
		signal: new AbortController().signal,
	});

	assert.deepEqual(
		result?.items.map((item) => item.label),
		["foo.ts-0", "foo.ts-1", "[Session] foo.ts migration"],
	);
});

test("agent autocomplete matches @subagent: prefix queries", async () => {
	const provider = createAgentAutocompleteProvider(fffProvider, () => agents);
	const result = await provider.getSuggestions(["@subagent:[cod"], 0, 14, {
		signal: new AbortController().signal,
	});

	assert.equal(result?.prefix, "@subagent:[cod");
	assert.equal(result?.items[0]?.value, "@subagent:[coder]");
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
	const result = await provider.getSuggestions(["@"], 0, 1, {
		signal: new AbortController().signal,
	});

	assert.equal(result?.items.filter((item) => item.label.startsWith("[SubAgent]")).length, 2);
});

test("agent autocomplete discards downstream agent matches outside agent names", async () => {
	const staleProvider: AutocompleteProvider = {
		...fffProvider,
		async getSuggestions() {
			return {
				prefix: "@Implement",
				items: [
					{ value: "@coder", label: "[SubAgent] Coder" },
					{ value: "@src/index.ts", label: "index.ts" },
					{ value: "@session:run-1", label: "[SubAgent] Previous run" },
				],
			};
		},
	};
	const provider = createAgentAutocompleteProvider(staleProvider, () => agents);
	const result = await provider.getSuggestions(["@Implement"], 0, 10, {
		signal: new AbortController().signal,
	});

	assert.deepEqual(
		result?.items.map((item) => item.value),
		["@src/index.ts", "@session:run-1"],
	);
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
	const result = await provider.getSuggestions(["@coder"], 0, 6, {
		signal: new AbortController().signal,
	});

	assert.equal(result?.items.length, 1);
	assert.equal(result?.items[0]?.value, "@subagent:[coder]");
});

test("agent candidate value uses the bracketed @subagent style", async () => {
	const provider = createAgentAutocompleteProvider(fffProvider, () => agents);
	const result = await provider.getSuggestions(["@"], 0, 1, {
		signal: new AbortController().signal,
	});

	assert.equal(result?.items[0]?.value, "@subagent:[coder]");
});

test("extractSubagentReferenceNames finds bracketed mentions and deduplicates them", () => {
	assert.deepEqual(
		extractSubagentReferenceNames(
			"Review @subagent:[coder] and @subagent:[explore], then @subagent:[coder]",
		),
		["coder", "explore"],
	);
	assert.deepEqual(extractSubagentReferenceNames("plain @coder and @session:[x]"), []);
	assert.equal(subagentReferenceValue("coder"), "@subagent:[coder]");
});
