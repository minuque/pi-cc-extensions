import assert from "node:assert/strict";
import test from "node:test";
import {
	config,
	formatConfigStatus,
	normalizeConfig,
	setConfig,
} from "../extensions/config/config.ts";
import {
	FOOTER_NERD_ICON_CACHE,
	FOOTER_NERD_ICON_GIT,
	FOOTER_NERD_ICON_MCP,
	applyCustomFooter,
	clearCustomFooter,
	footerGlyphs,
	formatXaiFooterChip,
	parseGitStats,
} from "../extensions/feature/shell/footer.ts";
import {
	DEFAULT_FOOTER_CHIP_LAYOUT,
	PI_USAGE_KEY,
	PI_USAGE_SOURCE,
	defaultFooterLine,
	footerChipDescription,
	isSkippedFooterStatusKey,
	moveFooterKeyToLine,
	normalizeFooterChipLayout,
	reorderFooterKey,
	resolveFooterChipLayout,
	shiftFooterKeyLine,
	toggleFooterKeyHidden,
	visibleFooterPluginTexts,
} from "../extensions/feature/shell/footer-layout.ts";

test("normalizeConfig defaults enableCustomFooter on and honors explicit off", () => {
	assert.equal(normalizeConfig({}).enableCustomFooter, true);
	assert.equal(normalizeConfig({ enableCustomFooter: false }).enableCustomFooter, false);
	assert.match(formatConfigStatus(normalizeConfig({})), /footer=on/);
	assert.match(formatConfigStatus(normalizeConfig({ enableCustomFooter: false })), /footer=off/);
	assert.equal(normalizeConfig({}).footerNerdIcons, true);
	assert.equal(normalizeConfig({ footerNerdIcons: false }).footerNerdIcons, false);
	assert.match(formatConfigStatus(normalizeConfig({})), /footerIcons=nerd/);
	assert.match(
		formatConfigStatus(normalizeConfig({ footerNerdIcons: false })),
		/footerIcons=plain/,
	);
});

test("footerGitStatsMode defaults to working and accepts only known modes", () => {
	assert.equal(normalizeConfig({}).footerGitStatsMode, "working");
	assert.equal(normalizeConfig({ footerGitStatsMode: "working" }).footerGitStatsMode, "working");
	assert.equal(normalizeConfig({ footerGitStatsMode: "branch" }).footerGitStatsMode, "branch");
	for (const value of ["invalid", "", true, 42, null]) {
		assert.equal(normalizeConfig({ footerGitStatsMode: value }).footerGitStatsMode, "working");
	}
	assert.match(formatConfigStatus(normalizeConfig({})), /footerGitStats=working/);
	assert.match(
		formatConfigStatus(normalizeConfig({ footerGitStatsMode: "branch" })),
		/footerGitStats=branch/,
	);
});

test("footerGlyphs drops Nerd Font icons when disabled", () => {
	assert.deepEqual(footerGlyphs(true), {
		git: FOOTER_NERD_ICON_GIT,
		cache: FOOTER_NERD_ICON_CACHE,
		mcp: FOOTER_NERD_ICON_MCP,
	});
	assert.deepEqual(footerGlyphs(false), { git: "", cache: "", mcp: "" });
});

test("normalizeConfig defaults pi-usage visible on line1 for old configs", () => {
	const next = normalizeConfig({});
	assert.deepEqual(next.footerHiddenKeys, []);
	assert.deepEqual(next.footerLine1Keys, [PI_USAGE_KEY]);
	assert.deepEqual(next.footerLine2Keys, []);
	assert.deepEqual(next.footerLine3Keys, []);
	assert.match(formatConfigStatus(next), /hidden=0/);
});

test("normalizeConfig keeps explicit empty hiddenKeys so pi-usage can show", () => {
	const next = normalizeConfig({
		footerHiddenKeys: [],
		footerLine1Keys: [PI_USAGE_KEY],
	});
	assert.deepEqual(next.footerHiddenKeys, []);
	assert.deepEqual(next.footerLine1Keys, [PI_USAGE_KEY]);
});

test("normalizeFooterChipLayout drops model, dedupes across lines, prepends pi-usage", () => {
	const next = normalizeFooterChipLayout({
		footerHiddenKeys: ["ponytail", "model", "ponytail"],
		footerLine1Keys: ["usage", "ponytail"],
		footerLine2Keys: ["ponytail", "lsp"],
		footerLine3Keys: ["model"],
	});
	assert.deepEqual(next.footerLine1Keys, [PI_USAGE_KEY, "usage", "ponytail"]);
	assert.deepEqual(next.footerLine2Keys, ["lsp"]);
	assert.deepEqual(next.footerLine3Keys, []);
	assert.deepEqual(next.footerHiddenKeys, ["ponytail"]);
});

test("normalizeFooterChipLayout rewrites legacy localUsage and piUsage keys to pi-usage", () => {
	const fromLocal = normalizeFooterChipLayout({
		footerHiddenKeys: ["localUsage"],
		footerLine1Keys: ["localUsage", "usage"],
		footerLine2Keys: ["localUsage"],
	});
	assert.deepEqual(fromLocal.footerLine1Keys, [PI_USAGE_KEY, "usage"]);
	assert.deepEqual(fromLocal.footerLine2Keys, []);
	assert.deepEqual(fromLocal.footerHiddenKeys, [PI_USAGE_KEY]);
	const fromCamel = normalizeFooterChipLayout({
		footerLine1Keys: ["piUsage"],
	});
	assert.deepEqual(fromCamel.footerLine1Keys, [PI_USAGE_KEY]);
});

test("disabled custom footer leaves another extension's footer untouched", () => {
	const previous = { ...config };
	const calls: unknown[] = [];
	const ctx = {
		hasUI: true,
		ui: {
			setFooter: (factory: unknown) => calls.push(factory),
		},
	};

	try {
		setConfig(normalizeConfig({ enableCustomFooter: false }));
		applyCustomFooter(ctx as never);
		assert.deepEqual(calls, []);

		clearCustomFooter(ctx as never);
		assert.deepEqual(calls, [undefined]);
	} finally {
		setConfig(previous);
	}
});

test("defaultFooterLine sends usage-like keys to line1 and others to line2", () => {
	assert.equal(isSkippedFooterStatusKey("model"), true);
	assert.equal(defaultFooterLine("usage"), 1);
	assert.equal(defaultFooterLine("pi-grok-usage"), 1);
	assert.equal(defaultFooterLine("cloud-quota"), 1);
	assert.equal(defaultFooterLine(PI_USAGE_KEY), 1);
	assert.equal(defaultFooterLine("ponytail"), 2);
	assert.equal(defaultFooterLine("lsp"), 2);
});

test("resolveFooterChipLayout appends unknown live keys to default lines in alpha order", () => {
	const resolved = resolveFooterChipLayout(DEFAULT_FOOTER_CHIP_LAYOUT, [
		"ponytail",
		"usage",
		"model",
		"lsp",
		"cloud-quota",
	]);
	assert.deepEqual(resolved.footerLine1Keys, [PI_USAGE_KEY, "cloud-quota", "usage"]);
	assert.deepEqual(resolved.footerLine2Keys, ["lsp", "ponytail"]);
	assert.deepEqual(resolved.footerLine3Keys, []);
	assert.deepEqual(resolved.footerHiddenKeys, []);
});

test("hidden keys stay on their line and unhide restores the slot", () => {
	let layout = resolveFooterChipLayout(DEFAULT_FOOTER_CHIP_LAYOUT, ["ponytail", "lsp"]);
	layout = toggleFooterKeyHidden(layout, "ponytail");
	assert.ok(layout.footerHiddenKeys.includes("ponytail"));
	assert.deepEqual(layout.footerLine2Keys, ["lsp", "ponytail"]);
	layout = toggleFooterKeyHidden(layout, "ponytail");
	assert.equal(layout.footerHiddenKeys.includes("ponytail"), false);
	assert.deepEqual(layout.footerLine2Keys, ["lsp", "ponytail"]);
});

test("moveFooterKeyToLine appends to the target line and clamps shift at the ends", () => {
	let layout = resolveFooterChipLayout(DEFAULT_FOOTER_CHIP_LAYOUT, ["ponytail", "lsp"]);
	layout = moveFooterKeyToLine(layout, "ponytail", 3);
	assert.deepEqual(layout.footerLine3Keys, ["ponytail"]);
	assert.deepEqual(layout.footerLine2Keys, ["lsp"]);
	layout = shiftFooterKeyLine(layout, "ponytail", 1);
	assert.deepEqual(layout.footerLine3Keys, ["ponytail"]);
	layout = shiftFooterKeyLine(layout, PI_USAGE_KEY, -1);
	assert.deepEqual(layout.footerLine1Keys, [PI_USAGE_KEY]);
});

test("reorderFooterKey swaps within a line only", () => {
	let layout = resolveFooterChipLayout(DEFAULT_FOOTER_CHIP_LAYOUT, ["ponytail", "lsp"]);
	assert.deepEqual(layout.footerLine2Keys, ["lsp", "ponytail"]);
	layout = reorderFooterKey(layout, "lsp", 1);
	assert.deepEqual(layout.footerLine2Keys, ["ponytail", "lsp"]);
	layout = reorderFooterKey(layout, "lsp", 1);
	assert.deepEqual(layout.footerLine2Keys, ["ponytail", "lsp"]);
});

test("visibleFooterPluginTexts skips hidden and empty, keeps configured order", () => {
	const texts = new Map([
		["usage", "codex 5%"],
		[PI_USAGE_KEY, "xAI 14%"],
		["ponytail", "⚡ FULL"],
		["lsp", ""],
	]);
	assert.deepEqual(
		visibleFooterPluginTexts([PI_USAGE_KEY, "usage", "ghost"], [PI_USAGE_KEY], texts),
		["codex 5%"],
	);
	assert.deepEqual(visibleFooterPluginTexts(["ponytail", "lsp"], [], texts), ["⚡ FULL"]);
	assert.deepEqual(visibleFooterPluginTexts(["usage"], [], texts), ["codex 5%"]);
});

test("footerChipDescription names the source extension", () => {
	assert.equal(footerChipDescription(PI_USAGE_KEY, "xAI 14%"), `xAI 14% · from ${PI_USAGE_SOURCE}`);
	assert.equal(
		footerChipDescription(PI_USAGE_KEY, ""),
		`From ${PI_USAGE_SOURCE}. No text right now.`,
	);
	assert.equal(footerChipDescription("ponytail", "⚡ FULL"), "⚡ FULL · from ponytail");
	assert.equal(footerChipDescription("lsp", ""), "inactive · from lsp");
});

test("pi-usage and plugin usage can both be visible with no fallback judgment", () => {
	const texts = new Map([
		[PI_USAGE_KEY, "xAI 14%"],
		["usage", "codex 5%"],
	]);
	assert.deepEqual(visibleFooterPluginTexts([PI_USAGE_KEY, "usage"], [], texts), [
		"xAI 14%",
		"codex 5%",
	]);
});

test("line3 paints only when a visible plugin text exists", () => {
	const layout = moveFooterKeyToLine(
		resolveFooterChipLayout(DEFAULT_FOOTER_CHIP_LAYOUT, ["ponytail"]),
		"ponytail",
		3,
	);
	const hidden = visibleFooterPluginTexts(
		layout.footerLine3Keys,
		["ponytail"],
		new Map([["ponytail", "⚡ FULL"]]),
	);
	const shown = visibleFooterPluginTexts(
		layout.footerLine3Keys,
		[],
		new Map([["ponytail", "⚡ FULL"]]),
	);
	assert.deepEqual(hidden, []);
	assert.deepEqual(shown, ["⚡ FULL"]);
});

test("formatXaiFooterChip prefers included percent then prepaid dollars", () => {
	assert.equal(
		formatXaiFooterChip({
			buckets: [{ id: "included-allowance", unit: "percent", used: 14.4 }],
		}),
		"xAI 14%",
	);
	assert.equal(
		formatXaiFooterChip({
			metrics: [{ id: "prepaid-balance", value: 1.5 }],
		}),
		"xAI $1.50",
	);
});

test("parseGitStats sums numstat add/delete columns", () => {
	assert.deepEqual(parseGitStats("10\t2\ta.ts\n3\t1\tb.ts\n"), { add: 13, del: 3 });
	assert.deepEqual(parseGitStats(""), { add: 0, del: 0 });
	assert.deepEqual(parseGitStats("-\t-\timage.png\n15\t9\tsource.ts\n60\t0\tnew-test.ts\n"), {
		add: 75,
		del: 9,
	});
});
