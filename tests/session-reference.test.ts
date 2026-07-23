import assert from "node:assert/strict";
import test from "node:test";
import { Buffer } from "node:buffer";
import {
	SESSION_REFERENCE_CUSTOM_TYPE,
	buildReferenceContent,
	extractSessionReferenceIds,
	sessionTitle,
	truncateUtf8,
} from "../extensions/session-reference-core.ts";

const info = {
	id: "019f78f7-526e-78ac-afa5-ff6d5e06beb8",
	cwd: "/repo",
	firstMessage: "  Refactor\n\tthe auth module  ",
	messageCount: 2,
	modified: new Date("2025-01-02T03:04:05.000Z"),
};

test("extractSessionReferenceIds finds boundary-delimited references and deduplicates them", () => {
	assert.deepEqual(
		extractSessionReferenceIds(
			"Use @session:abc-123 and\n@session:def_456.v2, then @session:abc-123. Ignore x@session:nope.",
		),
		["abc-123", "def_456.v2"],
	);
});

test("sessionTitle normalizes and truncates display text", () => {
	assert.equal(sessionTitle(info), "Refactor the auth module");
	assert.equal(sessionTitle({ ...info, name: "Named session" }), "Named session");
	assert.equal(sessionTitle({ ...info, name: "123456789" }, 6), "12345…");
});

test("truncateUtf8 enforces byte limits for multibyte content", () => {
	const result = truncateUtf8("你".repeat(1_000), 100);
	assert.ok(Buffer.byteLength(result, "utf8") <= 100);
	assert.match(result, /truncated/);
});

test("buildReferenceContent formats active context and drops nested references", () => {
	const content = buildReferenceContent([
		{
			info,
			messages: [
				{ role: "user", content: "Implement it" },
				{ role: "assistant", content: [{ type: "text", text: "Done" }] },
				{
					role: "custom",
					customType: SESSION_REFERENCE_CUSTOM_TYPE,
					content: "nested prior reference",
				},
			],
		},
	]);

	assert.match(content, /Referenced Pi sessions/);
	assert.match(content, /User: Implement it/);
	assert.match(content, /Assistant: Done/);
	assert.doesNotMatch(content, /nested prior reference/);
});

test("buildReferenceContent enforces incremental session and total byte limits", () => {
	const messages = Array.from({ length: 1_000 }, (_, index) => ({
		role: "user",
		content: `${index}: ${"x".repeat(1_000)}`,
	}));
	const content = buildReferenceContent(
		[{ info, messages }],
		{ maxMessageBytes: 400, maxSessionBytes: 2_000, maxTotalBytes: 1_000 },
	);
	assert.ok(Buffer.byteLength(content, "utf8") <= 1_000);
	assert.match(content, /truncated/);
});
