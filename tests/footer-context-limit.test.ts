import assert from "node:assert/strict";
import test from "node:test";
import { formatConfigStatus, normalizeConfig } from "../extensions/config/config.ts";
import { compactionLimitTokens, contextChipFigures } from "../extensions/feature/shell/footer.ts";

const model = { provider: "anthropic", id: "claude-x" };

test("footerContextLimit defaults to window and accepts only known modes", () => {
	assert.equal(normalizeConfig({}).footerContextLimit, "window");
	for (const mode of ["window", "compaction", "both"]) {
		assert.equal(normalizeConfig({ footerContextLimit: mode }).footerContextLimit, mode);
	}
	for (const value of ["invalid", "", true, 42, null]) {
		assert.equal(normalizeConfig({ footerContextLimit: value }).footerContextLimit, "window");
	}
	assert.match(formatConfigStatus(normalizeConfig({})), /footerContextLimit=window/);
});

test("compactionLimitTokens mirrors pi: window minus reserveTokens, model override first", () => {
	assert.equal(compactionLimitTokens(200_000, {}, model), 200_000 - 16_384);
	assert.equal(
		compactionLimitTokens(200_000, { compaction: { reserveTokens: 50_000 } }, model),
		150_000,
	);
	assert.equal(
		compactionLimitTokens(
			200_000,
			{
				compaction: {
					reserveTokens: 50_000,
					modelOverrides: { "anthropic/claude-x": { reserveTokens: 20_000 } },
				},
			},
			model,
		),
		180_000,
	);
	assert.equal(
		compactionLimitTokens(200_000, { compaction: { enabled: false } }, model),
		undefined,
	);
	assert.equal(compactionLimitTokens(0, {}, model), undefined);
	assert.equal(
		compactionLimitTokens(10_000, { compaction: { reserveTokens: 20_000 } }, model),
		undefined,
	);
	assert.equal(compactionLimitTokens(200_000, undefined, model), 200_000 - 16_384);
});

test("contextChipFigures: window mode keeps the current chip", () => {
	const usage = { tokens: 100_000, contextWindow: 200_000, percent: 50 };
	assert.deepEqual(contextChipFigures(usage, 150_000, "window"), {
		percent: 50,
		limitLabel: "200k",
	});
});

test("contextChipFigures: compaction mode measures against the compaction point", () => {
	const usage = { tokens: 75_000, contextWindow: 200_000, percent: 37.5 };
	assert.deepEqual(contextChipFigures(usage, 150_000, "compaction"), {
		percent: 50,
		limitLabel: "150k",
	});
	assert.deepEqual(contextChipFigures(usage, 150_000, "both"), {
		percent: 50,
		limitLabel: "150k (200k)",
	});
});

test("contextChipFigures: unknown tokens or no compaction point fall back gracefully", () => {
	const unknown = { tokens: null, contextWindow: 200_000, percent: null };
	assert.deepEqual(contextChipFigures(unknown, 150_000, "both"), {
		percent: null,
		limitLabel: "150k (200k)",
	});
	const usage = { tokens: 100_000, contextWindow: 200_000, percent: 50 };
	assert.deepEqual(contextChipFigures(usage, undefined, "compaction"), {
		percent: 50,
		limitLabel: "200k",
	});
	assert.deepEqual(contextChipFigures(usage, undefined, "both"), {
		percent: 50,
		limitLabel: "200k",
	});
});
