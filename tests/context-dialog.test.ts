// escCloseHitbox 的契约：
// [esc] 按钮位于弹框标题行（box 第 2 行）右端，5 列宽；
// bounds 为 0-based 的弹框起点（left/top）+ 宽度。
import assert from "node:assert/strict";
import test from "node:test";
import { formatSkillsForPrompt, initTheme } from "@earendil-works/pi-coding-agent";
import {
	capParts,
	collectContextBreakdown,
	copyButtonHitbox,
	escCloseHitbox,
	hasActiveTextPreview,
	resolveUsedTokens,
	setPreviewCopyImpl,
	showTextPreview,
} from "../extensions/feature/context.ts";

initTheme("dark");

test("context breakdown separates tools, results, and conversation without inflating estimates", () => {
	const ctx = {
		getSystemPromptOptions: () => ({
			cwd: "/repo",
			selectedTools: ["read"],
			toolSnippets: { read: "Read files" },
			contextFiles: [{ path: "AGENTS.md", content: "cccc" }],
			skills: [
				{ name: "ok", description: "desc", filePath: "/v" },
				{
					name: "hidden",
					description: "x".repeat(100),
					filePath: "/hidden",
					disableModelInvocation: true,
				},
			],
		}),
		getSystemPrompt: () => "s".repeat(200),
		sessionManager: {
			buildSessionProjection: () => ({
				entries: [
					{
						sourceEntry: { type: "message" },
						messages: [
							{
								role: "system",
								content: "",
								sections: { preamble: "s".repeat(200) },
							},
							{ role: "user", content: "uuuuuuuu", timestamp: 0 },
							{
								role: "assistant",
								content: [
									{ type: "text", text: "aaaa" },
									{ type: "toolCall", id: "1", name: "read", arguments: { path: "a" } },
								],
							},
							{
								role: "toolResult",
								toolCallId: "1",
								toolName: "read",
								content: "rrrrrrrr",
								timestamp: 0,
							},
						],
					},
					{
						sourceEntry: { type: "compaction" },
						messages: [{ role: "compactionSummary", summary: "ssss", timestamp: 0 }],
					},
				],
			}),
		},
	} as any;
	const tools = [
		{
			name: "read",
			description: "Read a file",
			parameters: { type: "object" },
			promptGuidelines: [],
			sourceInfo: {},
		},
	] as any;

	const breakdown = collectContextBreakdown(ctx, tools);
	const parts = breakdown.parts;
	assert.deepEqual(
		parts.map(({ label, color }) => [label, color]),
		[
			["System prompt", "accent"],
			["Memory", "error"],
			["Skills", "warning"],
			["Tools definition", "success"],
			["Tool results", "customMessageLabel"],
			["Context", "warning"],
		],
	);
	assert.equal(parts.find((part) => part.label === "System prompt")?.tokens, 50);
	assert.equal(parts.find((part) => part.label === "Memory")?.tokens, 0);
	assert.equal(parts.find((part) => part.label === "Skills")?.tokens, 0);
	assert.match(breakdown.previews.memoryFiles, /## AGENTS\.md/);
	assert.match(breakdown.previews.memoryFiles, /cccc/);
	assert.match(breakdown.previews.skills, /<name>ok<\/name>/);
	assert.doesNotMatch(breakdown.previews.skills, /hidden/);
	assert.equal(parts.find((part) => part.label === "Tool results")?.tokens, 2);
	assert.equal(parts.find((part) => part.label === "Context")?.tokens, 8);
	assert.match(breakdown.previews.systemPrompt, /"preamble": "s{200}"/);
	assert.match(breakdown.previews.tools, /Definition: read/);
	assert.match(breakdown.previews.tools, /"parameters"/);
	assert.doesNotMatch(breakdown.previews.tools, /Call: read/);
	assert.match(breakdown.previews.toolResults, /Result: read/);
	assert.match(breakdown.previews.toolResults, /rrrrrrrr/);
	assert.match(breakdown.previews.contextFiles, /uuuuuuuu/);
	assert.match(breakdown.previews.contextFiles, /aaaa/);
	assert.match(breakdown.previews.contextFiles, /Assistant tool call: read/);
	assert.match(breakdown.previews.contextFiles, /"path": "a"/);
	assert.match(breakdown.previews.contextFiles, /compactionSummary/);

	const fitted = capParts(parts, parts.reduce((sum, part) => sum + part.tokens, 0) + 10);
	assert.deepEqual(fitted, parts, "estimates are not inflated to fill provider usage");
	const fixedTokens = parts.slice(0, 4).reduce((sum, part) => sum + part.tokens, 0);
	const capped = capParts(parts, fixedTokens + 5, 4);
	assert.deepEqual(
		capped.slice(0, 4),
		parts.slice(0, 4),
		"system prompt, memory, skills and tools definition stay stable",
	);
	assert.equal(
		capped.reduce((sum, part) => sum + part.tokens, 0),
		fixedTokens + 5,
	);
	const finalParts = [
		...fitted,
		{ label: "Other", tokens: 10, color: "muted" },
		{ label: "Free space", tokens: 100, color: "dim" },
	];
	assert.equal(new Set(finalParts.map((part) => part.color)).size, 7);
});

test("context breakdown attributes embedded memory and skills once", () => {
	const memory = "cccc";
	const skills = [{ name: "ok", description: "desc", filePath: "/v" }];
	const skillsText = formatSkillsForPrompt(skills as any).trim();
	const chunk = `<project_instructions path="AGENTS.md">\n${memory}\n</project_instructions>`;
	const ctx = {
		getSystemPromptOptions: () => ({
			cwd: "/repo",
			selectedTools: [],
			contextFiles: [{ path: "AGENTS.md", content: memory }],
			skills,
		}),
		sessionManager: {
			buildSessionProjection: () => ({
				entries: [
					{
						sourceEntry: { type: "message" },
						messages: [
							{
								role: "system",
								content: "",
								sections: {
									preamble: "base",
									project_context: `<project_context>\n${chunk}\n</project_context>`,
									skills: `<skills>\n${skillsText}\n</skills>`,
								},
							},
						],
					},
				],
			}),
		},
	} as any;

	const breakdown = collectContextBreakdown(ctx, []);
	const systemTokens = breakdown.parts.find((part) => part.label === "System prompt")?.tokens ?? -1;
	const memoryTokens = breakdown.parts.find((part) => part.label === "Memory")?.tokens ?? -1;
	const skillsTokens = breakdown.parts.find((part) => part.label === "Skills")?.tokens ?? -1;
	assert.equal(memoryTokens, Math.ceil(chunk.length / 4));
	assert.equal(skillsTokens, Math.ceil(skillsText.length / 4));
	const sectionsText = [
		"base",
		`<project_context>\n${chunk}\n</project_context>`,
		`<skills>\n${skillsText}\n</skills>`,
	].join("");
	assert.equal(systemTokens + memoryTokens + skillsTokens, Math.ceil(sectionsText.length / 4));
	assert.ok(systemTokens < Math.ceil(sectionsText.length / 4));
});

test("context breakdown counts tool schemas once", () => {
	const definition = {
		name: "read",
		description: "Read a file",
		parameters: { type: "object" },
	};
	const removed = {
		name: "bash",
		description: "x".repeat(400),
		parameters: { type: "object" },
	};
	const ctx = {
		getSystemPromptOptions: () => ({
			cwd: "/repo",
			selectedTools: ["read"],
		}),
		sessionManager: {
			buildSessionProjection: () => ({
				entries: [
					{
						sourceEntry: { type: "message" },
						messages: [
							{
								role: "system",
								content: "base",
								toolsAdded: [definition],
								toolsRemoved: [removed],
							},
						],
					},
				],
			}),
		},
	} as any;
	const tools = [{ ...definition, promptGuidelines: [], sourceInfo: {} }] as any;

	const breakdown = collectContextBreakdown(ctx, tools);
	const systemTokens = breakdown.parts.find((part) => part.label === "System prompt")?.tokens;
	const toolTokens = breakdown.parts.find((part) => part.label === "Tools definition")?.tokens;
	assert.equal(systemTokens, Math.ceil("base".length / 4));
	assert.equal(toolTokens, Math.ceil(JSON.stringify(definition).length / 4));
	assert.equal(
		(systemTokens ?? 0) + (toolTokens ?? 0),
		Math.ceil("base".length / 4) + Math.ceil(JSON.stringify(definition).length / 4),
	);
});

test("resolveUsedTokens rejects inconsistent or implausibly small provider usage", () => {
	assert.equal(resolveUsedTokens({ tokens: 1, percent: 7 }, 20_000, 272_000), 19_040);
	assert.equal(resolveUsedTokens({ tokens: 19_000, percent: 7 }, 20_000, 272_000), 19_000);
	assert.equal(resolveUsedTokens({ tokens: 1, percent: 1 / 2_720 }, 20_000, 272_000), 20_000);
	assert.equal(resolveUsedTokens({ tokens: null, percent: null }, 20_000, 272_000), 20_000);
});

test("capParts never produces negative tokens when estimates exceed usage", () => {
	const parts = Array.from({ length: 8 }, (_, index) => ({
		label: String(index),
		tokens: 1,
		color: "dim" as const,
	}));
	const fitted = capParts(parts, 5);
	assert.equal(
		fitted.reduce((sum, part) => sum + part.tokens, 0),
		5,
	);
	assert.ok(fitted.every((part) => part.tokens >= 0));
});

test("copyButtonHitbox sits one space left of [esc] on the title row", () => {
	assert.deepEqual(copyButtonHitbox({ left: 8, top: 1, width: 64 }), {
		row: 3,
		startCol: 60,
		endCol: 65,
	});
	const esc = escCloseHitbox({ left: 8, top: 1, width: 64 });
	const copy = copyButtonHitbox({ left: 8, top: 1, width: 64 });
	assert.equal(copy.row, esc.row);
	assert.ok(copy.endCol < esc.startCol);
});

test("escCloseHitbox sits 5 columns wide at the title row's right edge", () => {
	assert.deepEqual(escCloseHitbox({ left: 8, top: 1, width: 64 }), {
		row: 3,
		startCol: 67,
		endCol: 71,
	});
	assert.deepEqual(escCloseHitbox({ left: 1, top: 1, width: 38 }), {
		row: 3,
		startCol: 34,
		endCol: 38,
	});
	assert.deepEqual(escCloseHitbox({ left: 20, top: 6, width: 50 }), {
		row: 8,
		startCol: 65,
		endCol: 69,
	});
});

/** showTextPreview 自定义 UI 的最小 harness：捕获 component，theme 可注入，可选挂载回调。 */
/** showTextPreview 自定义 UI 的最小 harness：捕获 component（挂载后实时可读），theme 可注入，可选挂载回调。 */
function textPreviewHarness(
	theme: any = { fg: (_color: string, text: string) => text, bold: (text: string) => text },
	onMount?: (component: any) => void,
	tui: any = { terminal: { columns: 80, rows: 24 }, requestRender() {} },
): any {
	let component: any;
	return {
		custom: async (factory: any) =>
			await new Promise<void>((resolve) => {
				component = factory(tui, theme, null, resolve);
				onMount?.(component);
			}),
		get component() {
			return component;
		},
	};
}

test("showTextPreview highlights and closes from the [esc] mouse hitbox", async () => {
	let escColor = "";
	const ui = textPreviewHarness(
		{
			fg: (color: string, text: string) => {
				if (text === "[esc]") escColor = color;
				return text;
			},
			bold: (text: string) => text,
		},
		(c) => c.render(64),
	);
	const preview = showTextPreview({ ui } as any, "Output", "hello");
	assert.equal(hasActiveTextPreview(), true);
	assert.equal(escColor, "muted");
	// 80×24、64 列居中、margin 2 → [esc] 命中 row=4, col=67..71。
	ui.component.handleInput(`\x1b[<35;67;4M`);
	ui.component.render(64);
	assert.equal(escColor, "text", "[esc] hover switches to text color");
	ui.component.handleInput(`\x1b[<0;67;4M`);
	await preview;
	assert.equal(hasActiveTextPreview(), false);
});

test("showTextPreview copies content from the [copy] hitbox and flashes confirmation", async () => {
	const flashes: string[] = [];
	const copied: string[] = [];
	setPreviewCopyImpl(async (text) => {
		copied.push(text);
	});
	let copyColor = "";
	const theme = {
		fg: (color: string, text: string) => {
			if (text === "[copy]") copyColor = color;
			return text;
		},
		bold: (text: string) => text,
	};
	const ui = textPreviewHarness(theme, (c) => c.render(64), {
		terminal: { columns: 80, rows: 24 },
		requestRender() {},
		flash: (message: string) => flashes.push(message),
	});
	try {
		const preview = showTextPreview({ ui } as any, "Output", "hello preview");
		assert.equal(copyColor, "muted");
		// [copy] 命中 row=4, col=60..65。
		ui.component.handleInput(`\x1b[<35;60;4M`);
		ui.component.render(64);
		assert.equal(copyColor, "text", "[copy] hover switches to text color");
		ui.component.handleInput(`\x1b[<0;60;4M`);
		await new Promise((resolve) => setTimeout(resolve, 0));
		assert.deepEqual(copied, ["hello preview"]);
		assert.deepEqual(flashes, ["Copied!"]);
		assert.equal(hasActiveTextPreview(), true, "复制不关闭预览");
		ui.component.handleInput("\x1b");
		await preview;
	} finally {
		setPreviewCopyImpl(null);
	}
});

test("showTextPreview scrollbar supports press and drag", async () => {
	const ui = textPreviewHarness();
	const content = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join("\n");
	const preview = showTextPreview({ ui } as any, "Output", content);
	const initial = ui.component.render(64).join("\n");
	assert.match(initial, /1-13 \/ 100 lines/);
	// scrollbar col=71，body track row=6..18；从顶部 thumb 拖到底部。
	ui.component.handleInput(`\x1b[<0;71;6M`);
	ui.component.handleInput(`\x1b[<32;71;18M`);
	ui.component.handleInput(`\x1b[<0;71;18m`);
	const dragged = ui.component.render(64).join("\n");
	assert.match(dragged, /88-100 \/ 100 lines/);
	ui.component.handleInput("\x1b");
	await preview;
});
