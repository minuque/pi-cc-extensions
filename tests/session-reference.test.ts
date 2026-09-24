import assert from "node:assert/strict";
import test from "node:test";
import { Buffer } from "node:buffer";
import {
	SESSION_REFERENCE_CUSTOM_TYPE,
	assignReferenceTokens,
	buildReferenceContentFromSections,
	formatReferenceSession,
	extractSessionReferenceIds,
	sessionReferenceLabel,
	sessionTitle,
	truncateUtf8,
} from "../extensions/feature/reference/session.ts";

const info = {
	id: "019f78f7-526e-78ac-afa5-ff6d5e06beb8",
	cwd: "/repo",
	firstMessage: "  Refactor\n\tthe auth module  ",
	messageCount: 2,
	modified: new Date("2025-01-02T03:04:05.000Z"),
};

test("extractSessionReferenceIds finds bracketed references and deduplicates them", () => {
	assert.deepEqual(
		extractSessionReferenceIds(
			"Review @session:[Release plan] and @session:[T-42], then @session:[Release plan]",
		),
		["Release plan", "T-42"],
	);
});

test("sessionTitle normalizes and truncates display text", () => {
	assert.equal(sessionTitle(info), "Refactor the auth module");
	assert.equal(sessionTitle({ ...info, name: "Named session" }), "Named session");
	assert.equal(sessionTitle({ ...info, name: "123456789" }, 6), "12345…");
});

test("sessionReferenceLabel uses the title and strips brackets", () => {
	assert.equal(sessionReferenceLabel(info), "Refactor the auth module");
	assert.equal(sessionReferenceLabel({ ...info, firstMessage: "" }), "");
	assert.equal(
		sessionReferenceLabel({ ...info, firstMessage: "Fix [auth] flow" }),
		"Fix auth flow",
	);
});

test("assignReferenceTokens keeps readable tokens for same-named sessions", () => {
	const named = (id: string, modified: string, name?: string) => ({
		referenceIds: [id],
		info: { ...info, id, name, modified: new Date(modified) },
	});

	assert.deepEqual(
		[...assignReferenceTokens([named("a", "2025-02-01T00:00:00.000Z", "Solo")]).values()],
		["Solo"],
	);
	assert.deepEqual(
		[
			...assignReferenceTokens([
				named("a", "2025-02-01T00:00:00.000Z", "Pair"),
				named("b", "2025-02-02T00:00:00.000Z", "Pair"),
			]).values(),
		],
		["Pair 02-01", "Pair 02-02"],
	);
	// 同名同日靠时间区分；同名同日同分才退到稳定 ID，避免指错会话。
	assert.deepEqual(
		[
			...assignReferenceTokens([
				named("a", "2025-02-01T01:00:00.000Z", "Twin"),
				named("b", "2025-02-01T02:00:00.000Z", "Twin"),
			]).values(),
		],
		["Twin 02-01 01:00", "Twin 02-01 02:00"],
	);
	assert.deepEqual(
		[
			...assignReferenceTokens([
				named("a", "2025-02-01T01:00:00.000Z", "Twin"),
				named("b", "2025-02-01T01:00:30.000Z", "Twin"),
			]).values(),
		],
		["a", "b"],
	);
	assert.deepEqual(
		[
			...assignReferenceTokens([
				{ referenceIds: ["c"], info: { ...info, id: "c", name: undefined, firstMessage: "" } },
			]).values(),
		],
		["c"],
	);
});

test("truncateUtf8 enforces byte limits for multibyte content", () => {
	const result = truncateUtf8("你".repeat(1_000), 100);
	assert.ok(Buffer.byteLength(result, "utf8") <= 100);
	assert.match(result, /truncated/);
});

test("buildReferenceContent formats active context and drops nested references", () => {
	const section = formatReferenceSession({
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
	});
	const content = buildReferenceContentFromSections([section]);

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
	const limits = {
		maxMessageBytes: 400,
		maxSessionBytes: 2_000,
		maxTotalBytes: 1_000,
	};
	const content = buildReferenceContentFromSections(
		[formatReferenceSession({ info, messages }, limits)],
		limits.maxTotalBytes,
	);
	assert.ok(Buffer.byteLength(content, "utf8") <= 1_000);
	assert.match(content, /truncated/);
});
