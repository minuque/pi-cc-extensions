import assert from "node:assert/strict";
import test from "node:test";
import { ToolExecutionComponent, initTheme } from "@earendil-works/pi-coding-agent";

import { config } from "../extensions/config/config.ts";
import { installDefaultMode } from "../extensions/renderer/default-mode.ts";
import { installToolGrouping, ToolGroupComponent } from "../extensions/renderer/tool/grouping.ts";
import { WriteExecutionMetadataStore } from "../extensions/renderer/tool/diff/index.ts";
import {
	askUserAnswerText,
	askUserCollapsedLines,
	askUserExpandedBody,
	askUserQuestionCount,
	createAskUserResultComponent,
} from "../extensions/renderer/tool/ask-user-question.ts";
import { Container } from "@earendil-works/pi-tui";

initTheme("dark");

const theme = { fg: (_color: string, text: string) => text } as any;
const stripAnsi = (value: string) => value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");

const questions = [
	{ question: "Which library should we use?", header: "Library" },
	{ question: "Which paths should the change cover?", header: "Scope" },
	{ question: "Which checks should run?", header: "Checks" },
];

const answered = {
	content: [{ type: "text", text: 'User has answered your questions: "Which library..."' }],
	details: {
		cancelled: false,
		answers: [
			{ questionIndex: 0, question: questions[0]!.question, kind: "option", answer: "Read" },
			{
				questionIndex: 1,
				question: questions[1]!.question,
				kind: "custom",
				answer: "src and tests",
				notes: "renderer only",
			},
			{
				questionIndex: 2,
				question: questions[2]!.question,
				kind: "multi",
				answer: null,
				selected: ["typecheck", "unit tests", "lint"],
			},
		],
		globalNote: "keep the diff small",
	},
};

test("问题数优先取作答，没有结果时从参数里数", () => {
	assert.equal(askUserQuestionCount(answered), 3);
	assert.equal(askUserQuestionCount(undefined, { questions }), 3);
	assert.equal(askUserQuestionCount({ details: { answers: [] } }), undefined);
});

test("作答文本：单选、多选、自定义、空值", () => {
	assert.equal(askUserAnswerText({ kind: "option", answer: "Read" }), "Read");
	assert.equal(
		askUserAnswerText({ kind: "multi", selected: ["typecheck", "lint"] }),
		"typecheck, lint",
	);
	assert.equal(askUserAnswerText({ kind: "multi", selected: [] }), "(no answer)");
	assert.equal(askUserAnswerText({ kind: "custom", answer: "" }), "(no answer)");
	assert.equal(askUserAnswerText({ kind: "option", answer: null }), "(no answer)");
});

test("折叠树：问题行用 ├，展开提示挂在单独的 └ 汇总行", () => {
	const lines = askUserCollapsedLines({
		result: answered,
		theme,
		isError: false,
		width: 120,
		hovered: false,
	}).map(stripAnsi);
	assert.equal(lines.length, 4);
	assert.match(lines[0]!, /├ Which library should we use\? -> Read$/);
	assert.match(lines[1]!, /├ Which paths should the change cover\? -> src and tests$/);
	assert.match(lines[2]!, /├ Which checks should run\? -> typecheck, unit tests, lint$/);
	assert.match(lines[3]!, /└ 3 answered · .*to show more$/);
	// 展开提示不在任何问题行上
	assert.doesNotMatch(lines[0]!, /to show more/);
	assert.doesNotMatch(lines[2]!, /to show more/);
});

test("折叠树按问题下标排序，与 answers 数组顺序无关", () => {
	const reversed = {
		details: { answers: [...answered.details.answers].reverse() },
	};
	const lines = askUserCollapsedLines({
		result: reversed,
		theme,
		isError: false,
		width: 160,
	}).map(stripAnsi);
	assert.match(lines[0]!, /Which library/);
	assert.match(lines[2]!, /Which checks/);
});

test("窄宽度下问题和回答各自截断，不互相挤掉", () => {
	const [line] = askUserCollapsedLines({
		result: answered,
		theme,
		isError: false,
		width: 40,
	}).map(stripAnsi);
	assert.match(line!, /Which libra… -> Read/);
});

test("没有作答时退回一行摘要", () => {
	const declined = askUserCollapsedLines({
		result: { details: { answers: [], cancelled: true } },
		theme,
		isError: false,
		width: 80,
	}).map(stripAnsi);
	assert.deepEqual(declined, [" Declined"]);
	const empty = askUserCollapsedLines({
		result: { details: { answers: [] } },
		theme,
		isError: false,
		width: 80,
	}).map(stripAnsi);
	assert.deepEqual(empty, [" Done"]);
});

test("展开正文逐条列出问题、选择、备注", () => {
	const body = askUserExpandedBody(answered);
	assert.match(
		body,
		/^Which library should we use\?\n {2}Read\n\nWhich paths should the change cover\?\n {2}src and tests\n {2}notes: renderer only/,
	);
	assert.match(body, /Which checks should run\?\n {2}typecheck, unit tests, lint/);
	assert.match(body, /Note: keep the diff small$/);
	assert.equal(askUserExpandedBody({ details: { answers: [], cancelled: true } }), "Declined");
});

test("只有收尾的汇总行是展开入口", () => {
	const component = createAskUserResultComponent({ result: answered, theme, isError: false });
	const lines = component.render(120).map(stripAnsi);
	assert.equal(component.isCollapsedHintLine(lines[0]), false);
	assert.equal(component.isCollapsedHintLine(lines.at(-1)!), true);
});

function toolUi() {
	return { theme, requestRender() {}, setStatus() {} } as any;
}

test("单工具卡：标题带问题数，结果是问答树", () => {
	const previousMode = config.mode;
	config.mode = "on";
	const hooks = installDefaultMode(new WriteExecutionMetadataStore());
	try {
		const tool = new ToolExecutionComponent(
			"ask_user_question",
			"ask-1",
			{ questions },
			{},
			undefined,
			toolUi(),
			process.cwd(),
		) as any;
		tool.markExecutionStarted();
		tool.updateResult(answered);
		const lines = tool.render(120).map(stripAnsi).filter(Boolean);
		assert.match(lines[0]!, /Ask User Question \(\+3\)/);
		assert.doesNotMatch(lines[0]!, /Which library/);
		// 树线与标题行的勾同列：勾在 " ✓" 的第 2 列，├ 也在第 2 列。
		const checkColumn = lines[0]!.indexOf("✓");
		const branchLine = lines.find((line: string) => line.includes("├"));
		assert.equal(branchLine?.indexOf("├"), checkColumn, "树线应与勾对齐");
		assert.ok(lines.some((line: string) => /├ .* -> Read/.test(line)));
		assert.ok(lines.some((line: string) => /├ .* -> typecheck, unit tests, lint$/.test(line)));
		assert.ok(lines.some((line: string) => /└ 3 answered/.test(line)));
		assert.equal(
			lines.some((line: string) => /lines returned/.test(line)),
			false,
		);
	} finally {
		hooks.shutdown();
		config.mode = previousMode;
	}
});

test("等待中的问题折叠时清掉展开视图，回答完成后仍是问答树", () => {
	const previousMode = config.mode;
	config.mode = "on";
	const hooks = installDefaultMode(new WriteExecutionMetadataStore());
	try {
		const tool = new ToolExecutionComponent(
			"ask_user_question",
			"ask-wait",
			{ questions },
			{},
			undefined,
			toolUi(),
			process.cwd(),
		) as any;
		tool.markExecutionStarted();
		tool.render(120);
		tool.setExpanded(true);
		tool.updateResult({ content: [], isError: false }, true);

		const view = tool.rendererState?.ccstyleIoView;
		assert.equal(typeof view?.getOutputBody, "function");
		assert.equal(view.getOutputBody(), "Pending…");
		assert.match(view.getInputBody(), /Which library should we use\?/);

		tool.setExpanded(false);
		const collapsed = tool.render(120).map(stripAnsi);
		assert.equal(tool.rendererState?.ccstyleIoView, undefined);
		assert.ok(
			collapsed.some((line: string) => /Pending…/.test(line)),
			`折叠后仍应是等待中: ${JSON.stringify(collapsed)}`,
		);
		assert.equal(
			collapsed.some((line: string) => /Done/.test(line)),
			false,
			`等待中折叠不能显示 Done: ${JSON.stringify(collapsed)}`,
		);

		tool.setExpanded(true);
		const again = tool.render(120).map(stripAnsi);
		assert.ok(
			again.some((line: string) => line.includes("Which library should we use?")),
			`再次展开应仍是原问题: ${JSON.stringify(again)}`,
		);
		assert.equal(typeof tool.rendererState?.ccstyleIoView?.getInputBody, "function");

		tool.setExpanded(false);
		tool.updateResult(answered);
		const done = tool.render(120).map(stripAnsi).filter(Boolean);
		assert.match(done[0]!, /Ask User Question \(\+3\)/);
		assert.ok(done.some((line: string) => / -> Read/.test(line)));
		assert.equal(tool.rendererState?.ccstyleIoView, undefined);
	} finally {
		hooks.shutdown();
		config.mode = previousMode;
	}
});

test("分组折叠行报问题指向回答", () => {
	const hooks = installToolGrouping(() => true);
	try {
		const parent = new Container() as any;
		for (const id of ["ask-a", "ask-b"]) {
			const tool = new ToolExecutionComponent(
				"ask_user_question",
				id,
				{ questions },
				{},
				undefined,
				toolUi(),
				process.cwd(),
			) as any;
			tool.markExecutionStarted();
			tool.updateResult(answered);
			parent.addChild(tool);
		}
		const group = parent.children[0] as ToolGroupComponent;
		const lines = group.render(160).map(stripAnsi).filter(Boolean);
		assert.ok(
			lines.filter((line: string) => / -> Read \(\+2\)/.test(line)).length === 2,
			`分组行应报选择，got: ${JSON.stringify(lines)}`,
		);
	} finally {
		hooks.shutdown();
	}
});
