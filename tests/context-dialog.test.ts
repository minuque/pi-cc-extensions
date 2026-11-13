// 弹框的鼠标点击盒（[esc]、[copy]、行、滚动条）由最终渲染的行位置算出，
// 因此这里的断言都走真实渲染，不再单独测坐标函数。
import assert from "node:assert/strict";
import test from "node:test";
import { formatSkillsForPrompt, initTheme } from "@earendil-works/pi-coding-agent";
import { rgbColor, visibleWidth } from "@earendil-works/pi-tui";
import contextUsageExtension from "../extensions/feature/context.ts";
import {
	capParts,
	collectContextBreakdown,
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
			["System prompt", rgbColor(0x79, 0xc0, 0xff)],
			["Memory", rgbColor(0xff, 0x7b, 0x72)],
			["Skills", rgbColor(0xcb, 0x92, 0x14)],
			["Tools definition", rgbColor(0x37, 0xb3, 0x4a)],
			["Tool results", rgbColor(0xf7, 0x78, 0xba)],
			["Context", rgbColor(0xf0, 0x88, 0x3e)],
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
		{ label: "Other", tokens: 10, color: rgbColor(0x92, 0x9e, 0xab) },
		{ label: "Free space", tokens: 100, color: rgbColor(0x76, 0x84, 0x94) },
	];
	assert.equal(new Set(finalParts.map((part) => part.color)).size, 8);
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
		color: rgbColor(0x76, 0x84, 0x94),
	}));
	const fitted = capParts(parts, 5);
	assert.equal(
		fitted.reduce((sum, part) => sum + part.tokens, 0),
		5,
	);
});

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

test("showTextPreview closes from a regular-mode SGR click without overlay layout", async () => {
	const tui = { terminal: { columns: 80, rows: 24 }, requestRender() {} };
	const ui = textPreviewHarness(undefined, (c) => c.render(64), tui);
	const preview = showTextPreview({ ui } as any, "Output", "hello");
	// margin 2、80x24、宽 64、高 19：起点 col=8 row=2。局部 [esc] (60,1) → 屏幕 69,4。
	ui.component.handleInput("\x1b[<0;69;4M");
	await preview;
	assert.equal(hasActiveTextPreview(), false);
});

test("showTextPreview closes from a regular-mode SGR click on [esc]", async () => {
	const tui = {
		terminal: { columns: 80, rows: 24 },
		requestRender() {},
		renderedOverlayLayouts: [{ col: 0, row: 0, width: 64, height: 20 }],
	};
	const ui = textPreviewHarness(undefined, (c) => c.render(64), tui);
	const preview = showTextPreview({ ui } as any, "Output", "hello");
	// 局部 x=60 是 [esc]；SGR 是 1-based 屏幕坐标，overlay 在 0,0 时 col=61 row=2。
	ui.component.handleInput("\x1b[<0;61;2M");
	await preview;
	assert.equal(hasActiveTextPreview(), false);
});

test("showTextPreview uses the overlay under the pointer when several are stacked", async () => {
	const tui: any = {
		terminal: { columns: 80, rows: 24 },
		requestRender() {},
	};
	const ui = textPreviewHarness(
		undefined,
		(c) => {
			// 最上层是另一个弹框；预览在下层，起点 col=10。取最上层会把点击算偏。
			tui.focusedComponent = c;
			tui.renderedOverlayLayouts = [
				{ col: 10, row: 0, width: 64, height: 20, entry: { component: c } },
				{ col: 0, row: 0, width: 80, height: 24, entry: { component: {} } },
			];
			c.render(64);
		},
		tui,
	);
	const preview = showTextPreview({ ui } as any, "Output", "hello");
	// 局部 x=60 是 [esc]；下层起点 col=10，屏幕 col=71。
	ui.component.handleInput("\x1b[<0;71;2M");
	await preview;
	assert.equal(hasActiveTextPreview(), false);
});

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
	// handleMouse 用弹框局部 0-based 坐标：title 第 1 行，[esc] 在行尾 col=58..62。
	ui.component.handleMouse({ type: "move", x: 60, y: 1, button: "none" });
	ui.component.render(64);
	assert.equal(escColor, "text", "[esc] hover switches to text color");
	ui.component.handleMouse({ type: "press", x: 60, y: 1, button: "left" });
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
		// [copy] 命中 title 行 col=51..56（esc 左侧）。
		ui.component.handleMouse({ type: "move", x: 53, y: 1, button: "none" });
		ui.component.render(64);
		assert.equal(copyColor, "text", "[copy] hover switches to text color");
		ui.component.handleMouse({ type: "press", x: 53, y: 1, button: "left" });
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
	// 滚动条局部坐标：col=62（右 border 内侧），body track row=3..；从顶部 thumb 拖到底部。
	ui.component.handleMouse({ type: "press", x: 62, y: 5, button: "left" });
	ui.component.handleMouse({ type: "drag", x: 62, y: 15, button: "left" });
	ui.component.handleMouse({ type: "release", x: 62, y: 15, button: "left" });
	const dragged = ui.component.render(64).join("\n");
	assert.match(dragged, /88-100 \/ 100 lines/);
	ui.component.handleInput("\x1b");
	await preview;
});

type ContextOverlayEntry = { component: any; done: (action?: unknown) => void };

/** /context 主弹框与预览共用 harness：每次 ui.custom 同步挂载一个 overlay 并记录。 */
function contextDialogHarness(options: { mode?: string } = {}) {
	const fg: Array<[string, string]> = [];
	const bg: Array<[string, string]> = [];
	const notifications: string[] = [];
	const overlays: ContextOverlayEntry[] = [];
	const tui = {
		mode: "default",
		terminal: { columns: 80, rows: 24, write() {} },
		requestRender() {},
	};
	const baseTheme: any = {
		fg: (color: string, text: string) => {
			fg.push([color, text]);
			return text;
		},
		bg: (color: string, text: string) => {
			bg.push([color, text]);
			return text;
		},
		bold: (text: string) => text,
		style: (text: string) => text,
	};
	// 新增的 theme 方法（italic/underline 等）统一退化为「原样返回最后一个字符串参数」。
	const theme: any = new Proxy(baseTheme, {
		get: (target, prop: string) =>
			prop in target
				? target[prop]
				: (...args: any[]) => {
						const strings = args.filter((value) => typeof value === "string");
						return strings.at(-1) ?? "";
					},
	});
	const ctx: any = {
		mode: options.mode ?? "tui",
		model: { contextWindow: 1_000_000 },
		getContextUsage: () => ({ tokens: 35_500, percent: 3.5, contextWindow: 1_000_000 }),
		getSystemPromptOptions: () => ({
			cwd: "/repo",
			selectedTools: ["read"],
			toolSnippets: { read: "Read files" },
			contextFiles: [{ path: "AGENTS.md", content: "cccc" }],
			skills: [{ name: "ok", description: "desc", filePath: "/v" }],
		}),
		getSystemPrompt: () => "s".repeat(200),
		sessionManager: {
			buildSessionProjection: () => ({
				entries: [
					{
						sourceEntry: { type: "message" },
						messages: [
							{ role: "system", content: "", sections: { preamble: "s".repeat(200) } },
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
				],
			}),
		},
		ui: {
			custom: (factory: any) =>
				new Promise<unknown>((resolve) => {
					const entry: ContextOverlayEntry = { component: undefined, done: resolve };
					entry.component = factory(tui, theme, null, resolve);
					overlays.push(entry);
				}),
			notify: (message: string) => notifications.push(message),
		},
	};
	const tools = [
		{
			name: "read",
			description: "Read a file",
			parameters: { type: "object" },
			promptGuidelines: [],
			sourceInfo: {},
		},
	] as any;
	let handler: any;
	contextUsageExtension({
		registerCommand: (_name: string, def: any) => {
			handler = def.handler;
		},
		getAllTools: () => tools,
	} as any);
	return {
		overlays,
		fg,
		bg,
		notifications,
		tui,
		running: handler("", ctx) as Promise<unknown>,
		latest: () => overlays.at(-1)!,
	};
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** 主弹框固定几何：80x24 终端、框宽 64、16 行 → 屏幕起点 col=8 row=4。 */
const DIALOG_SCREEN_COL = 8;
const DIALOG_SCREEN_ROW = 4;

function partRows(lines: string[]): string[] {
	return lines.slice(5, 13);
}

test("context dialog renders every part row with right-aligned figures", async () => {
	const dialog = contextDialogHarness();
	const { component } = dialog.latest();
	const lines = component.render(64);
	assert.equal(lines.length, 16);
	assert.ok(
		lines.every((line: string) => visibleWidth(line) === 64),
		"每行都填满框宽，不溢出也不短缺",
	);
	assert.match(lines[0] ?? "", /^╭─+╮$/);
	assert.match(lines.at(-1) ?? "", /^╰─+╯$/);
	const header = lines[1] ?? "";
	assert.match(header, /Context Usage {2}35\.5k \/ 1000k tokens \(3\.5%\)/);
	assert.match(header, /\[esc\]│$/);

	const rows = partRows(lines);
	for (const label of [
		"System prompt",
		"Memory",
		"Skills",
		"Tools definition",
		"Tool results",
		"Context",
		"Other",
		"Free space",
	]) {
		assert.ok(
			rows.some((row) => row.includes(`■ ${label}`)),
			`缺少 ${label} 行`,
		);
	}

	// 数字列整体贴右：token 右端、百分比右端各占同一列，且以「% + 1 空格 + │」收尾。
	const figures = rows.map((row) => {
		const match = row.match(/([\d.]+k?) +([\d.]+)%/);
		assert.ok(match, `行内没有 token/百分比：${row}`);
		const tokenStart = row.indexOf(match[1] ?? "");
		return {
			tokenEnd: tokenStart + (match[1] ?? "").length,
			percentEnd: row.indexOf(`${match[2]}%`) + (match[2] ?? "").length + 1,
		};
	});
	assert.equal(new Set(figures.map((figure) => figure.tokenEnd)).size, 1, "token 列右对齐");
	assert.equal(new Set(figures.map((figure) => figure.percentEnd)).size, 1, "百分比列右对齐");
	for (const row of rows) assert.match(row, /\d\.\d% │$/);

	dialog.latest().component.handleInput("\x1b");
	await dialog.running;
});

test("context dialog paints usage figures and subtitle in the dim token color", async () => {
	const dialog = contextDialogHarness();
	dialog.latest().component.render(64);
	const dim = dialog.fg.filter(([color]) => color === "dim").map(([, text]) => text);
	assert.ok(dim.includes("35.5k / 1000k tokens (3.5%)"), "标题行用量走次级色");
	assert.ok(
		dim.some((text) => /^\s*\d+k$/.test(text)),
		"token 数字走次级色",
	);
	assert.ok(!dim.some((text) => /^\s*\d+\.\d%$/.test(text)), "百分比保持正文色，不跟着变次级");

	dialog.latest().component.handleInput("\x1b");
	await dialog.running;
});

test("context dialog cycles the selection with arrow keys", async () => {
	const dialog = contextDialogHarness();
	const { component } = dialog.latest();
	const selectedIndex = () =>
		partRows(component.render(64)).findIndex((row) => row.startsWith("│›"));
	assert.equal(selectedIndex(), 0, "默认选中第一行");
	component.handleInput("\x1b[B");
	assert.equal(selectedIndex(), 1);
	component.handleInput("\x1b[A");
	assert.equal(selectedIndex(), 0);
	component.handleInput("\x1b[A");
	// 选择只在有预览的 6 行（不含 Other / Free space）之间循环。
	assert.equal(selectedIndex(), 5, "向上越界回到最后一个有预览的行");
	component.handleInput("\x1b[B");
	assert.equal(selectedIndex(), 0, "向下越界回到首行");

	component.handleInput("\x1b");
	await dialog.running;
});

test("context dialog hovers rows and closes from the [esc] hitbox", async () => {
	const dialog = contextDialogHarness();
	const { component } = dialog.latest();
	component.render(64);

	component.handleMouse({ type: "click", x: 10, y: 6 });
	component.handleMouse({ type: "move", x: 10, y: 6, button: "none" });
	const hovered = component.render(64);
	assert.match(hovered[6] ?? "", /■ Memory/, "hover 命中第 6 行");
	assert.equal(dialog.bg.at(-1)?.[0], "customMessageBg", "hover 行用次级背景");

	component.handleMouse({ type: "move", x: 60, y: 1, button: "none" });
	component.render(64);
	assert.ok(
		dialog.fg.some(([color, text]) => color === "text" && text === "[esc]"),
		"hover [esc] 提亮",
	);

	component.handleMouse({ type: "press", x: 60, y: 1, button: "left" });
	await dialog.running;
});

test("context dialog closes from a raw SGR click on [esc]", async () => {
	const dialog = contextDialogHarness();
	const { component } = dialog.latest();
	component.render(64);
	// 局部 [esc] 在 (58..62, 1)；SGR 用 1-based 屏幕坐标。
	const col = DIALOG_SCREEN_COL + 60 + 1;
	const row = DIALOG_SCREEN_ROW + 1 + 1;
	component.handleInput(`\x1b[<0;${col};${row}M`);
	await dialog.running;
	assert.equal(dialog.overlays.length, 1, "主弹框直接关闭，不打开预览");
});

test("context dialog opens the preview chosen by a row click and returns after closing it", async () => {
	const dialog = contextDialogHarness();
	const main = dialog.latest();
	main.component.render(64);
	main.component.handleInput("\r");
	await tick();
	assert.equal(dialog.overlays.length, 2, "Enter 打开预览");
	const preview = dialog.overlays[1]!;
	const lines = preview.component.render(64);
	assert.ok(
		lines.some((line: string) => line.includes("System Prompt")),
		"预览标题是选中行的原始内容",
	);
	preview.component.handleInput("\x1b");
	await tick();
	assert.equal(dialog.overlays.length, 3, "关掉预览后回到主弹框");
	dialog.latest().component.handleInput("\x1b");
	await dialog.running;
});

test("context dialog keeps every line inside the narrow border", async () => {
	const dialog = contextDialogHarness();
	const lines = dialog.latest().component.render(44);
	assert.ok(
		lines.every((line: string) => visibleWidth(line) === 44),
		"窄宽度下仍不破框",
	);
	for (const row of partRows(lines)) assert.match(row, /\d\.\d% │$/, row);
	assert.ok(
		partRows(lines).some((row) => row.includes("■ Tools definition")),
		"长 label 不被数字列挤掉",
	);

	dialog.latest().component.handleInput("\x1b");
	await dialog.running;
});

test("context reports the breakdown through notify outside the TUI", async () => {
	const dialog = contextDialogHarness({ mode: "rpc" });
	await dialog.running;
	assert.equal(dialog.overlays.length, 0, "非 TUI 模式不挂 overlay");
	assert.equal(dialog.notifications.length, 1);
	assert.match(dialog.notifications[0] ?? "", /Free space: /);
});

test("context dialog opens the preview matched by a row click", async () => {
	const dialog = contextDialogHarness();
	const main = dialog.latest();
	main.component.render(64);
	// 局部 y=6 是 Memory 行。release 与右键都不能触发动作。
	main.component.handleMouse({ type: "release", x: 10, y: 6, button: "left" });
	main.component.handleMouse({ type: "press", x: 10, y: 6, button: "right" });
	await tick();
	assert.equal(dialog.overlays.length, 1, "release 与右键不打开预览");

	main.component.handleMouse({ type: "press", x: 10, y: 6, button: "left" });
	await tick();
	assert.equal(dialog.overlays.length, 2);
	const lines = dialog.overlays[1]!.component.render(64);
	assert.ok(
		lines.some((line: string) => line.includes("Memory Files")),
		"点到哪行就开哪行的预览",
	);

	dialog.overlays[1]!.component.handleInput("\x1b");
	await tick();
	dialog.latest().component.handleInput("\x1b");
	await dialog.running;
});

test("capParts zeroes the variable parts when usage equals the fixed sections", () => {
	const parts = Array.from({ length: 8 }, (_, index) => ({
		label: String(index),
		tokens: 3,
		color: rgbColor(0x76, 0x84, 0x94),
	}));
	const capped = capParts(parts, 4, 4);
	assert.deepEqual(
		capped.map((part) => part.tokens),
		[3, 3, 3, 3, 0, 0, 0, 0],
	);
});

test("context breakdown keeps thinking, bash output and summaries in the preview", () => {
	const ctx = {
		getSystemPromptOptions: () => ({ cwd: "/repo", selectedTools: [] }),
		sessionManager: {
			buildSessionProjection: () => ({
				entries: [
					{
						sourceEntry: { type: "message" },
						messages: [
							{ role: "user", content: "uuuu", timestamp: 0 },
							{
								role: "assistant",
								content: [{ type: "thinking", thinking: "pondering" }],
							},
							{
								role: "bashExecution",
								command: "ls -la",
								output: "total 0",
								timestamp: 0,
							},
							{ role: "branchSummary", summary: "older branch", timestamp: 0 },
						],
					},
				],
			}),
		},
	} as any;

	const breakdown = collectContextBreakdown(ctx, []);
	const preview = breakdown.previews.contextFiles;
	assert.match(preview, /## Assistant thinking\n\npondering/);
	assert.match(preview, /## Bash\n\nCommand:\n\nls -la/);
	assert.match(preview, /## branchSummary\n\nolder branch/);
});

test("showTextPreview scrolls three lines per wheel packet", async () => {
	const tui = { terminal: { columns: 80, rows: 24 }, requestRender() {} };
	const ui = textPreviewHarness(undefined, (c) => c.render(64), tui);
	const content = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join("\n");
	const preview = showTextPreview({ ui } as any, "Output", content);
	assert.match(ui.component.render(64).join("\n"), /1-13 \/ 100 lines/);

	// 预览矩形内的普通左键不关闭也不滚动：命中但未被控件消费。
	ui.component.handleMouse({ type: "press", x: 10, y: 5, button: "left" });
	assert.match(ui.component.render(64).join("\n"), /1-13 \/ 100 lines/);

	// 预览起点 col=8 row=2；局部 (10,5) → 屏幕 (19,8)；code 65 滚轮下、64 滚轮上。
	ui.component.handleInput("\x1b[<65;19;8M");
	assert.match(ui.component.render(64).join("\n"), /4-16 \/ 100 lines/);
	ui.component.handleInput("\x1b[<64;19;8M");
	assert.match(ui.component.render(64).join("\n"), /1-13 \/ 100 lines/);

	ui.component.handleInput("\x1b");
	await preview;
});

test("showTextPreview falls back to notify when the TUI has no flash and reports copy failures", async () => {
	const notifications: Array<[string, string]> = [];
	const ui = textPreviewHarness(undefined, (c) => c.render(64), {
		terminal: { columns: 80, rows: 24 },
		requestRender() {},
	});
	ui.notify = (message: string, level: string) => notifications.push([message, level]);

	try {
		setPreviewCopyImpl(async () => {});
		const preview = showTextPreview({ ui } as any, "Output", "body");
		ui.component.handleMouse({ type: "press", x: 53, y: 1, button: "left" });
		await tick();
		assert.deepEqual(notifications, [["Copied preview to clipboard", "info"]]);

		setPreviewCopyImpl(async () => {
			throw new Error("clipboard offline");
		});
		ui.component.handleMouse({ type: "press", x: 53, y: 1, button: "left" });
		await tick();
		assert.deepEqual(notifications.at(-1), ["clipboard offline", "error"]);

		ui.component.handleInput("\x1b");
		await preview;
	} finally {
		setPreviewCopyImpl(null);
	}
});
