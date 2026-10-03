import { test } from "node:test";
import assert from "node:assert/strict";
import {
	BranchSummaryMessageComponent,
	CompactionSummaryMessageComponent,
	getMarkdownTheme,
	initTheme,
	SkillInvocationMessageComponent,
	type ParsedSkillBlock,
} from "@earendil-works/pi-coding-agent";
import {
	installMessageDisplayRendering,
	refreshMessageDisplays,
	setMessageDisplayTheme,
} from "../extensions/renderer/tool/message-display.ts";
import { config, DEFAULT_CONFIG, setConfig, normalizeConfig } from "../extensions/config/config.ts";

function stripAnsi(text: string): string {
	return text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
}

initTheme("dark");

function fakeTheme() {
	return { fg: (_color: string, text: string) => text };
}

type CompactionSummaryMessageProps = ConstructorParameters<
	typeof CompactionSummaryMessageComponent
>[0];
type BranchSummaryMessageProps = ConstructorParameters<typeof BranchSummaryMessageComponent>[0];

function makeSkillBlock(name = "ponytail", content = "**lazy** content\n\n- rule 1") {
	return new SkillInvocationMessageComponent(
		{ name, content, userMessage: null } as unknown as ParsedSkillBlock,
		getMarkdownTheme(),
	);
}

function makeCompaction(summary = "summarized history", tokensBefore = 12345) {
	return new CompactionSummaryMessageComponent(
		{ summary, tokensBefore } as unknown as CompactionSummaryMessageProps,
		getMarkdownTheme(),
	);
}

function makeBranch(summary = "branch work") {
	return new BranchSummaryMessageComponent(
		{ summary } as unknown as BranchSummaryMessageProps,
		getMarkdownTheme(),
	);
}

test("message-display: ccstyle on 时三个组件渲染为工具调用风格", () => {
	setConfig(normalizeConfig({ ...DEFAULT_CONFIG, mode: "on" }));
	const dispose = installMessageDisplayRendering();
	setMessageDisplayTheme(fakeTheme());

	// skill 块：collapsed ● Skill <name>，无原生 [skill] 标签
	const skill = makeSkillBlock();
	const skillCollapsed = stripAnsi(skill.render(120).join("\n"));
	assert.match(skillCollapsed, /✓ Skill ponytail/);
	assert.match(skillCollapsed, /to show more/);
	assert.doesNotMatch(skillCollapsed, /\[skill\]/);
	// 与单 tool 一致：Box paddingY 置 0，折叠行无上下空行
	assert.equal(skill.render(120).length, 1, "折叠行不应有上下空行");
	// expanded：标题行 + markdown 正文，背景与 tool 展开卡相同
	const backgroundSlots: string[] = [];
	setMessageDisplayTheme({
		fg: (_color: string, text: string) => text,
		bg(slot: string, text: string) {
			backgroundSlots.push(slot);
			return text;
		},
	} as any);
	skill.setExpanded(true);
	const skillExpanded = stripAnsi(skill.render(120).join("\n"));
	assert.match(skillExpanded, /✓ Skill ponytail/);
	assert.match(skillExpanded, /lazy/);
	assert.ok(backgroundSlots.includes("userMessageBg"));
	// issue 46：展开卡背景槽位可切，渲染时现读配置。
	const previousSlot = config.expandedCardBackground;
	try {
		backgroundSlots.length = 0;
		config.expandedCardBackground = "toolPendingBg";
		skill.render(120);
		assert.deepEqual([...new Set(backgroundSlots)], ["toolPendingBg"]);
	} finally {
		config.expandedCardBackground = previousSlot;
	}
	assert.ok(skill.render(120).length > 3, "展开卡应有上下内边距");
	skill.setExpanded(false);
	assert.equal(skill.render(120).length, 1, "收起后恢复单行");
	setMessageDisplayTheme(fakeTheme());

	// 压缩摘要：collapsed ● Compacted from N tokens
	const compaction = makeCompaction();
	const compactionCollapsed = stripAnsi(compaction.render(120).join("\n"));
	assert.match(compactionCollapsed, /✓ Compacted from 12,345 tokens/);
	assert.doesNotMatch(compactionCollapsed, /\[compaction\]/);
	assert.equal(compaction.render(120).length, 1, "折叠行不应有上下空行");
	compaction.setExpanded(true);
	const compactionExpanded = stripAnsi(compaction.render(120).join("\n"));
	assert.match(compactionExpanded, /summarized history/);

	// 分支摘要：collapsed ● Branch summary
	const branch = makeBranch();
	const branchCollapsed = stripAnsi(branch.render(120).join("\n"));
	assert.match(branchCollapsed, /✓ Branch summary/);
	assert.doesNotMatch(branchCollapsed, /\[branch\]/);
	assert.equal(branch.render(120).length, 1, "折叠行不应有上下空行");
	branch.setExpanded(true);
	assert.match(stripAnsi(branch.render(120).join("\n")), /branch work/);

	dispose();
	setConfig(normalizeConfig({ ...DEFAULT_CONFIG, mode: "off" }));
});

test("message-display: mode off 或 dispose 后回退原生渲染", () => {
	setConfig(normalizeConfig({ ...DEFAULT_CONFIG, mode: "on" }));
	const dispose = installMessageDisplayRendering();
	setMessageDisplayTheme(fakeTheme());
	const skill = makeSkillBlock();
	const compaction = makeCompaction();
	assert.doesNotMatch(stripAnsi(skill.render(120).join("\n")), /\[skill\]/);
	assert.doesNotMatch(stripAnsi(compaction.render(120).join("\n")), /\[compaction\]/);

	// mode=off：恢复原生标签
	setConfig(normalizeConfig({ ...DEFAULT_CONFIG, mode: "off" }));
	skill.invalidate();
	compaction.invalidate();
	assert.match(stripAnsi(skill.render(120).join("\n")), /\[skill\]/);
	assert.match(stripAnsi(compaction.render(120).join("\n")), /\[compaction\]/);
	// 原生 Box paddingY=1 恢复：重新出现上下空行
	assert.equal(skill.render(120).length, 3, "原生渲染恢复上下内边距");

	// dispose 后同样回退
	setConfig(normalizeConfig({ ...DEFAULT_CONFIG, mode: "on" }));
	skill.invalidate();
	compaction.invalidate();
	assert.doesNotMatch(stripAnsi(skill.render(120).join("\n")), /\[skill\]/);
	dispose();
	skill.invalidate();
	compaction.invalidate();
	assert.match(stripAnsi(skill.render(120).join("\n")), /\[skill\]/);
	assert.match(stripAnsi(compaction.render(120).join("\n")), /\[compaction\]/);
});

test("message-display: refreshMessageDisplays 遍历并刷新已挂载组件", () => {
	setConfig(normalizeConfig({ ...DEFAULT_CONFIG, mode: "off" }));
	const dispose = installMessageDisplayRendering();
	setMessageDisplayTheme(fakeTheme());
	const components = [makeSkillBlock(), makeCompaction(), makeBranch()];
	let invalidated = 0;
	for (const component of components) {
		component.invalidate = () => {
			invalidated++;
			(component as unknown as { updateDisplay(): void }).updateDisplay();
		};
	}
	const root = {
		children: [{ children: components }],
		getMountedRoots: () => [],
	};
	refreshMessageDisplays(root);
	assert.equal(invalidated, 3);
	dispose();
	setConfig(normalizeConfig({ ...DEFAULT_CONFIG, mode: "on" }));
});
