import assert from "node:assert/strict";
import test from "node:test";
import { formatConfigStatus, normalizeConfig } from "../extensions/config/config.ts";
import {
	COMPACTION_LIMIT_REFRESH_MS,
	compactionLimitTokens,
	contextChipFigures,
	createCompactionLimitCache,
} from "../extensions/feature/shell/footer.ts";

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
	for (const enabled of [false, 0, ""]) {
		assert.equal(
			compactionLimitTokens(200_000, { compaction: { enabled } }, model),
			undefined,
			`enabled=${JSON.stringify(enabled)} disables compaction, as in pi`,
		);
	}
	assert.equal(
		compactionLimitTokens(200_000, { compaction: { enabled: "no" } }, model),
		200_000 - 16_384,
	);
	assert.equal(compactionLimitTokens(0, {}, model), undefined);
	assert.equal(
		compactionLimitTokens(10_000, { compaction: { reserveTokens: 20_000 } }, model),
		undefined,
	);
	assert.equal(compactionLimitTokens(200_000, undefined, model), 200_000 - 16_384);
});

test("compactionLimitTokens ignores invalid reserve values and falls through like pi", () => {
	const window = 200_000;
	const invalid = ["50000", -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53, null, true];
	for (const value of invalid) {
		assert.equal(
			compactionLimitTokens(window, { compaction: { reserveTokens: value } }, model),
			window - 16_384,
			`global reserveTokens=${String(value)} should fall back to pi's default`,
		);
		assert.equal(
			compactionLimitTokens(
				window,
				{
					compaction: {
						reserveTokens: 50_000,
						modelOverrides: { "anthropic/claude-x": { reserveTokens: value } },
					},
				},
				model,
			),
			150_000,
			`override reserveTokens=${String(value)} should fall back to the global setting`,
		);
	}
	assert.equal(
		compactionLimitTokens(
			window,
			{
				compaction: {
					reserveTokens: "50000",
					modelOverrides: { "anthropic/claude-x": { reserveTokens: -5 } },
				},
			},
			model,
		),
		window - 16_384,
	);
	assert.equal(
		compactionLimitTokens(
			window,
			{ compaction: { reserveTokens: 50_000, modelOverrides: { "anthropic/claude-x": "bad" } } },
			model,
		),
		150_000,
	);
	assert.equal(compactionLimitTokens(window, { compaction: { reserveTokens: 0 } }, model), window);
});

test("createCompactionLimitCache reads settings once per model and window, then after the interval", () => {
	let reads = 0;
	let reserveTokens = 50_000;
	let clock = 1_000;
	const limitFor = createCompactionLimitCache(
		() => {
			reads++;
			return { compaction: { reserveTokens } };
		},
		() => clock,
	);
	assert.equal(limitFor(200_000, model), 150_000);
	assert.equal(limitFor(200_000, model), 150_000);
	assert.equal(reads, 1, "repeated renders reuse the cached limit");

	reserveTokens = 20_000;
	clock += COMPACTION_LIMIT_REFRESH_MS - 1;
	assert.equal(limitFor(200_000, model), 150_000, "a settings change waits for the interval");
	assert.equal(reads, 1);
	clock += 1;
	assert.equal(limitFor(200_000, model), 180_000, "the interval refreshes the limit");
	assert.equal(reads, 2);

	assert.equal(limitFor(200_000, { provider: "openai", id: "gpt-x" }), 180_000);
	assert.equal(reads, 3, "a model change refreshes at once");
	assert.equal(limitFor(100_000, { provider: "openai", id: "gpt-x" }), 80_000);
	assert.equal(reads, 4, "a context-window change refreshes at once");
	assert.equal(limitFor(100_000, { provider: "openai", id: "gpt-x" }), 80_000);
	assert.equal(reads, 4);
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
