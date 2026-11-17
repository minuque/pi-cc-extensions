import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { config, normalizeConfig, setConfig } from "../extensions/config/config.ts";
import { applyCustomFooter, getFooterStatusSnapshot } from "../extensions/feature/shell/footer.ts";
import { stripAnsi } from "../extensions/utils/ansi-text.ts";

// What pi's own examples publish: theme.fg() output, i.e. SGR around the text.
const GREEN = "\x1b[32m";
const FG_OFF = "\x1b[39m";
const PLAN_BADGE = `${GREEN}⏸ plan${FG_OFF}`;

function mountFooter(t: test.TestContext, statuses: Map<string, string>) {
	const previous = { ...config };
	setConfig(normalizeConfig({ footerNerdIcons: false }));
	t.after(() => setConfig(previous));
	let footer!: { render: (width: number) => string[]; dispose: () => void };
	const ctx = {
		cwd: process.cwd(),
		hasUI: true,
		getContextUsage: () => undefined,
		sessionManager: {
			getBranch: () => [],
			getEntries: () => [],
			getLeafId: () => null,
			getSessionName: () => undefined,
		},
		ui: {
			setFooter: (factory: (tui: unknown, theme: unknown, data: unknown) => typeof footer) => {
				footer = factory(
					{ requestRender: () => {} },
					{
						// Marks every dim chip so a test can tell "dimmed by the footer" from "kept as sent".
						fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
						getThinkingBorderColor: () => (text: string) => text,
					},
					{
						getGitBranch: () => undefined,
						getExtensionStatuses: () => statuses,
						onBranchChange: () => () => {},
					},
				);
			},
		},
	};
	applyCustomFooter(ctx as never);
	t.after(() => footer.dispose());
	return (width = 200) => footer.render(width).join("\n");
}

test("off (default): custom chips render dim and lose the colors they sent", (t) => {
	const render = mountFooter(t, new Map([["plan-mode", PLAN_BADGE]]));
	const out = render();
	assert.match(out, /<dim>⏸ plan<\/dim>/);
	assert.equal(out.includes(GREEN), false);
});

test("on: custom chips keep their own colors, closed with a reset", (t) => {
	const render = mountFooter(t, new Map([["plan-mode", PLAN_BADGE]]));
	setConfig(normalizeConfig({ ...config, footerCustomStatusColors: true }));
	const out = render();
	assert.ok(out.includes(`${PLAN_BADGE}\x1b[0m`), `colored chip rendered as sent: ${out}`);
	assert.equal(out.includes("<dim>⏸ plan</dim>"), false);
});

test("the option takes effect on the next render without recreating the footer", (t) => {
	const render = mountFooter(t, new Map([["plan-mode", PLAN_BADGE]]));
	assert.equal(render().includes(GREEN), false);
	setConfig(normalizeConfig({ ...config, footerCustomStatusColors: true }));
	assert.equal(render().includes(GREEN), true);
	setConfig(normalizeConfig({ ...config, footerCustomStatusColors: false }));
	assert.equal(render().includes(GREEN), false);
});

test("on: a chip without colors stays dim, like before", (t) => {
	const render = mountFooter(t, new Map([["lsp", "ts ok"]]));
	setConfig(normalizeConfig({ ...config, footerCustomStatusColors: true }));
	assert.match(render(), /<dim>ts ok<\/dim>/);
});

test("on: cursor, screen and OSC sequences from a chip are dropped, its colors stay", (t) => {
	const hostile = `${GREEN}ok${FG_OFF}\x1b[2J\x1b[3;4H\x1b]8;;https://example.com\x07!`;
	const render = mountFooter(t, new Map([["evil", hostile]]));
	setConfig(normalizeConfig({ ...config, footerCustomStatusColors: true }));
	const out = render();
	assert.ok(out.includes(`${GREEN}ok${FG_OFF}!`), out);
	assert.equal(out.includes("\x1b[2J"), false);
	assert.equal(out.includes("\x1b[3;4H"), false);
	assert.equal(out.includes("\x1b]8"), false);
});

test("a chip made only of control sequences is not shown, on or off", (t) => {
	const render = mountFooter(t, new Map([["blank", "\x1b[2J\x1b[H"]]));
	for (const on of [false, true]) {
		setConfig(normalizeConfig({ ...config, footerCustomStatusColors: on }));
		const out = render();
		assert.equal(out.includes("\x1b[2J"), false);
		assert.equal(out.includes("<dim></dim>"), false);
	}
});

test("on: a colored chip never makes a footer line wider than the terminal", (t) => {
	const long = `${GREEN}${"x".repeat(80)}${FG_OFF}`;
	const render = mountFooter(t, new Map([["long", long]]));
	setConfig(normalizeConfig({ ...config, footerCustomStatusColors: true }));
	for (const width of [20, 40, 80]) {
		for (const line of render(width).split("\n")) {
			assert.ok(visibleWidth(line) <= width, `width ${width}: ${visibleWidth(line)}`);
		}
	}
});

test("the config panel snapshot stays plain text, on or off", (t) => {
	const render = mountFooter(t, new Map([["plan-mode", PLAN_BADGE]]));
	for (const on of [false, true]) {
		setConfig(normalizeConfig({ ...config, footerCustomStatusColors: on }));
		render();
		assert.equal(getFooterStatusSnapshot().get("plan-mode"), stripAnsi(PLAN_BADGE));
	}
});
