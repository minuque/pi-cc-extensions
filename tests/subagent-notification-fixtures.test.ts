import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
	CustomMessageComponent,
	initTheme,
	sessionEntryToContextMessages,
	ToolExecutionComponent,
} from "@earendil-works/pi-coding-agent";
import { Container, visibleWidth } from "@earendil-works/pi-tui";
import { installToolGrouping, ToolGroupComponent } from "../extensions/renderer/tool/grouping.ts";
import { renderSubagentNotification } from "../extensions/renderer/tool/subagent-notification.ts";

initTheme("dark");

type Fixture = { name: string; entry: any };

// 只读仓库里提交的格式样本，不读任何用户会话目录。
const fixtures: Fixture[] = JSON.parse(
	readFileSync(new URL("./fixtures/subagent-notifications/formats.json", import.meta.url), "utf8"),
);

/** 一条通知里的 agent：首个 + others，按通知里的顺序。 */
function agentsOf(details: any): any[] {
	return [details, ...(details.others ?? [])];
}

// ---- 隐私守卫：只许出现这些字段与固定词表，混进真实内容就失败 ----

const ENTRY = {
	type: "custom_message",
	id: "fixture-entry",
	parentId: null,
	timestamp: "2000-01-01T00:00:00.000Z",
	customType: "subagent-notification",
	content: "<task-notification>\nFixture notification.\n</task-notification>",
	display: true,
};
const SECOND_LINE = "\nFixture second line.";
const STATUSES = ["queued", "running", "completed", "steered", "aborted", "stopped", "error"];

const text = (value: string) => (v: unknown) =>
	[null, "", value, value + SECOND_LINE].includes(v as any);
const count = (value: number) => (v: unknown) => [null, 0, value].includes(v as any);

/** 每个允许的字段与它能取的值（严格相等，不做类型转换）。 */
const AGENT_FIELDS: Record<string, (value: unknown, agent: any) => boolean> = {
	id: (v) => typeof v === "string" && /^fixture-agent-\d+$/.test(v),
	description: text("Fixture task."),
	status: (v) => STATUSES.includes(v as any),
	toolUses: count(2),
	turnCount: count(3),
	totalTokens: count(1234),
	totalCost: count(0.125),
	durationMs: count(1200),
	outputFile: (v, agent) =>
		[null, "", `/fixture/transcripts/${agent.id}.output`].includes(v as any),
	resultPreview: text("Fixture preview."),
	error: text("Fixture error."),
	others: (v) => Array.isArray(v),
};

function assertSyntheticAgent(agent: any, where: string): void {
	assert.ok(agent !== null && typeof agent === "object" && !Array.isArray(agent), where);
	for (const key of Object.keys(agent)) {
		assert.ok(Object.hasOwn(AGENT_FIELDS, key), `${where}.${key} is not an allowed field`);
		assert.ok(AGENT_FIELDS[key]!(agent[key], agent), `${where}.${key} is not a fixture value`);
	}
	for (const [index, other] of (agent.others ?? []).entries()) {
		assertSyntheticAgent(other, `${where}.others[${index}]`);
	}
}

/** 名字只由序号与格式维度拼成，不能带任何别的文字。 */
function formatName(details: any, index: number): string {
	const cost = !("totalCost" in details)
		? "no-cost"
		: details.totalCost === 0
			? "zero-cost"
			: "cost";
	const preview = details.resultPreview;
	return [
		`format-${String(index + 1).padStart(2, "0")}`,
		details.status,
		"others" in details ? "batch" : "single",
		"outputFile" in details ? "path" : "no-path",
		cost,
		typeof preview === "string" && preview.includes("\n") ? "multiline" : "single-line",
	].join("-");
}

test("fixtures hold only allowed fields and synthetic values", () => {
	fixtures.forEach((fixture, index) => {
		assert.deepEqual(Object.keys(fixture).sort(), ["entry", "name"]);
		const { details, ...entry } = fixture.entry;
		assert.deepEqual(entry, ENTRY, fixture.name);
		assertSyntheticAgent(details, fixture.name);
		assert.equal(fixture.name, formatName(details, index));
		assert.deepEqual(
			agentsOf(details).map((agent) => agent.id),
			agentsOf(details).map((_, n) => `fixture-agent-${n + 1}`),
			`${fixture.name}: agent ids are numbered in order`,
		);
	});
});

// ---- 渲染：会话条目 → Pi 消息 → 本插件的通知视图 ----

const stripAnsi = (line: string) => line.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");

function plainRows(lines: string[]): string[] {
	const rows = lines.map((line) => stripAnsi(line).trimEnd());
	while (rows.length && !rows[0]) rows.shift();
	while (rows.length && !rows.at(-1)) rows.pop();
	return rows;
}

/** 会话里存的 custom_message 条目 → Pi 交互模式渲染用的消息（回放用的同一个转换）。 */
function savedMessage(fixture: Fixture): any {
	const messages = sessionEntryToContextMessages(fixture.entry);
	assert.equal(messages.length, 1, fixture.name);
	return messages[0];
}

function standalone(fixture: Fixture, expanded = false): CustomMessageComponent {
	const component = new CustomMessageComponent(savedMessage(fixture), renderSubagentNotification);
	component.setExpanded(expanded);
	return component;
}

const FAILED = ["error", "aborted"];
const icon = (agent: any) => (FAILED.includes(agent.status) ? "✗" : "✓");
const title = (agent: any) => `${icon(agent)} Subagent Finished ${agent.id}`;
/** 测得（非 0）才显示的统计，以及它在行里的字样。 */
const STAT_WORDS: [string, string][] = [
	["turnCount", " turn"],
	["toolUses", " tool use"],
	["totalTokens", " token"],
	["totalCost", "$"],
	["durationMs", "1.2s"],
];

test("saved entries become display custom messages with their details untouched", () => {
	for (const fixture of fixtures) {
		const before = structuredClone(fixture.entry);
		const message = savedMessage(fixture);
		assert.equal(message.role, "custom", fixture.name);
		assert.equal(message.customType, "subagent-notification", fixture.name);
		assert.equal(message.display, true, fixture.name);
		assert.equal(message.content, fixture.entry.content, fixture.name);
		assert.equal(message.timestamp, Date.UTC(2000, 0, 1), fixture.name);
		assert.deepEqual(message.details, fixture.entry.details, fixture.name);
		standalone(fixture).render(120);
		standalone(fixture, true).render(120);
		assert.deepEqual(fixture.entry, before, `${fixture.name}: rendering does not mutate the entry`);
	}
});

test("every format collapses to one row per agent with its outcome and measured stats", () => {
	for (const fixture of fixtures) {
		const agents = agentsOf(fixture.entry.details);
		const rows = plainRows(standalone(fixture).render(200));
		assert.equal(rows.length, agents.length, fixture.name);
		rows.forEach((row, index) => {
			const agent = agents[index];
			const at = `${fixture.name} #${index + 1}: ${row}`;
			assert.ok(row.startsWith(` ${title(agent)}`), at);
			assert.equal(row.endsWith(" · click to show more"), index === agents.length - 1, at);
			assert.equal(row.includes("completed (steered)"), agent.status === "steered", at);
			if (FAILED.includes(agent.status)) assert.ok(row.includes(` · ${agent.status}`), at);
			for (const [key, word] of STAT_WORDS)
				assert.equal(row.includes(word), Boolean(agent[key]), at);
			assert.doesNotMatch(row, /undefined|null|NaN/, at);
		});
	}
});

/** 段落小标题行：`├ Status` / `└ Transcript`（角标 + accent 标题，与工具展开卡同一套）。 */
const headingRows = (rows: string[], heading: string) =>
	rows.filter((row) => new RegExp(`^ [├└] ${heading}$`).test(row)).length;
/** 正文行去掉边框：`│ text` / `  text` 都还原成 `text`。 */
const bodyText = (row: string) => row.replace(/^[ │├└]+/, "");

test("every format expands to exactly the details its payload supplies", () => {
	for (const fixture of fixtures) {
		const agents = agentsOf(fixture.entry.details);
		const rows = plainRows(standalone(fixture, true).render(120));
		assert.deepEqual(
			rows.filter((row) => /^ [✓✗] Subagent Finished /.test(row)),
			agents.map((agent) => ` ${title(agent)}`),
			fixture.name,
		);
		const supplied = (key: string) => agents.filter((agent) => agent[key]).length;
		assert.equal(headingRows(rows, "Saved result preview"), supplied("resultPreview"));
		assert.equal(headingRows(rows, "Error"), supplied("error"), fixture.name);
		assert.equal(headingRows(rows, "Transcript"), supplied("outputFile"), fixture.name);
		assert.equal(headingRows(rows, "Status"), supplied("status"), fixture.name);
		const texts = rows.map(bodyText);
		for (const agent of agents) {
			for (const key of ["description", "resultPreview", "error", "outputFile"]) {
				for (const line of agent[key] ? agent[key].split("\n") : []) {
					assert.ok(texts.includes(line), `${fixture.name}: ${key} line "${line}"`);
				}
			}
		}
		assert.ok(!rows.some((row) => /undefined|null|NaN/.test(row)), fixture.name);
	}
});

test("narrow expanded cards wrap within the width without losing text", () => {
	// 边框字符随折行重复，比较文字时连边框一起去掉。
	const squash = (rows: string[]) => rows.join("").replace(/[\s│├└]/g, "");
	for (const fixture of fixtures) {
		const wide = squash(plainRows(standalone(fixture, true).render(120)));
		for (const width of [20, 30, 40]) {
			for (const expanded of [false, true]) {
				for (const line of standalone(fixture, expanded).render(width)) {
					assert.ok(visibleWidth(line) <= width, `${fixture.name} @${width}: ${stripAnsi(line)}`);
				}
			}
			assert.equal(squash(plainRows(standalone(fixture, true).render(width))), wide);
		}
	}
});

// ---- 分组：与一张合成的相邻工具卡并组 ----

const ui = { theme: { fg: (_color: string, value: string) => value }, requestRender() {} } as any;

/** 分组需要一张真实工具卡；这张是合成的，不取自任何会话。 */
function syntheticRead(): any {
	const tool = new ToolExecutionComponent(
		"read",
		"fixture-read",
		{ path: "fixture.ts" },
		{},
		undefined,
		ui,
		process.cwd(),
	) as any;
	tool.markExecutionStarted();
	tool.updateResult({ content: [{ type: "text", text: "ok" }], isError: false });
	return tool;
}

function withGrouping(run: () => void): void {
	const hooks = installToolGrouping(() => true);
	try {
		run();
	} finally {
		hooks.shutdown();
	}
}

function assertWithin(group: ToolGroupComponent, name: string): void {
	for (const width of [20, 40]) {
		for (const line of group.render(width)) {
			assert.ok(visibleWidth(line) <= width, `${name} @${width}: ${stripAnsi(line)}`);
		}
	}
}

function groupWithRead(fixture: Fixture): ToolGroupComponent {
	const parent = new Container() as any;
	const note = standalone(fixture);
	parent.addChild(note);
	parent.addChild(syntheticRead());
	assert.equal(parent.children.length, 1, fixture.name);
	const group = parent.children[0];
	assert.ok(group instanceof ToolGroupComponent, fixture.name);
	assert.equal(group.children[0], note, `${fixture.name}: the notification keeps its place`);
	return group;
}

test("saved multi-agent formats form notification-only groups without splitting the message", () => {
	withGrouping(() => {
		for (const fixture of fixtures) {
			const snapshot = structuredClone(fixture.entry);
			const agents = agentsOf(fixture.entry.details);
			const note = standalone(fixture);
			const parent = new Container();
			parent.addChild(note);
			if (agents.length === 1) {
				assert.deepEqual(parent.children, [note], fixture.name);
				continue;
			}
			const group = parent.children[0];
			assert.ok(group instanceof ToolGroupComponent, fixture.name);
			assert.deepEqual(group.children, [note], fixture.name);
			const rows = plainRows(group.render(240));
			const done = agents.filter((a) => !FAILED.includes(a.status)).length;
			const failed = agents.filter((a) => FAILED.includes(a.status)).length;
			const counts = [...(done ? [`${done} done`] : []), ...(failed ? [`${failed} failed`] : [])];
			assert.equal(
				rows[0],
				` ● Subagent Finished: ${counts.join(" · ")} · click to show more`,
				fixture.name,
			);
			assert.equal(rows.length, agents.length + 1, fixture.name);
			assertWithin(group, fixture.name);
			group.setExpanded(true);
			assertWithin(group, fixture.name);
			assert.deepEqual(fixture.entry, snapshot, fixture.name);
		}
	});
});

test("every format joins a synthetic neighbour tool with one grouped row per agent", () => {
	withGrouping(() => {
		for (const fixture of fixtures) {
			const agents = agentsOf(fixture.entry.details);
			const group = groupWithRead(fixture);
			const rows = plainRows(group.render(240));
			const failed = agents.filter((agent) => FAILED.includes(agent.status)).length;
			const counts = [
				`${agents.length - failed + 1} done`,
				...(failed ? [`${failed} failed`] : []),
			];
			assert.equal(
				rows[0],
				` ● Multiple Tools: ${counts.join(" · ")} · Subagent Finished×${agents.length}, Read×1 · click to show more`,
				fixture.name,
			);
			// 组内行与单独行共用同一套摘要，只换了树枝前缀、去掉了提示。
			const alone = plainRows(standalone(fixture).render(240));
			assert.deepEqual(
				rows.slice(1, -1),
				alone.map((row) => ` ├${row.replace(/ · click to show more$/, "")}`),
				fixture.name,
			);
			assert.equal(rows.at(-1), " └ ✓ Read fixture.ts", fixture.name);
			assertWithin(group, fixture.name);

			group.setExpanded(true);
			const expanded = plainRows(group.render(120));
			assert.deepEqual(
				expanded.filter((row) => / Subagent Finished /.test(row)).map((row) => row.slice(3)),
				agents.map(title),
				fixture.name,
			);
			// 详情嵌在树里：单独展开卡的每行正文都以 `│` 续行出现。
			for (const row of plainRows(standalone(fixture, true).render(120))) {
				if (!row || / Subagent Finished /.test(row)) continue;
				assert.ok(expanded.includes(` │${row}`), `${fixture.name}: ${row}`);
			}
			// 工具保持它自己的展开视图，挂在最后一个树枝上。
			const toolRow = expanded.findIndex((row) => row.startsWith(" └ ✓ "));
			const lastAgentRow = expanded.findLastIndex((row) => / Subagent Finished /.test(row));
			assert.ok(toolRow > lastAgentRow, fixture.name);
			assertWithin(group, fixture.name);
		}
	});
});
