/**
 * 按 mode 生成工具 render 示例：
 *   docs/tool-render-examples-default.md  （mode=on）
 *   docs/tool-render-examples-compact.md  （mode=compact）
 * 入口：npm run docs:tool-render
 */
import { readFileSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	AssistantMessageComponent,
	ToolExecutionComponent,
	initTheme,
} from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { Container } from "@earendil-works/pi-tui";
import claudeCodeStyle from "../extensions/renderer/index.ts";
import {
	buildMessageSummary,
	installCompactMode,
} from "../extensions/renderer/compact-mode.ts";
import {
	installToolGrouping,
	ToolGroupComponent,
} from "../extensions/renderer/tool/grouping.ts";
import {
	getMessageDisplayTheme,
	setMessageDisplayTheme,
} from "../extensions/renderer/tool/message-display.ts";
import { setToolTuiFullscreen } from "../extensions/renderer/tool/show-more-hint.ts";
import {
	DEFAULT_TOOL_DISPLAY_CONFIG,
	renderRichToolResult,
	WriteExecutionMetadataStore,
} from "../extensions/renderer/tool/diff/index.ts";
import { config } from "../extensions/config/config.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const docsDir = join(root, "docs");
const WIDTH = 72;

initTheme("dark");
setToolTuiFullscreen(true);

const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version as string;

const stripAnsi = (text: string) =>
	text
		.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "") // CSI
		.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, ""); // OSC

const plainTheme = {
	fg: (_c: string, t: string) => t,
	bg: (_c: string, t: string) => t,
	bold: (t: string) => t,
	italic: (t: string) => t,
	getFgAnsi: () => "",
	getBgAnsi: () => "",
};

const ui = {
	theme: plainTheme,
	setStatus() {},
	requestRender() {},
	getToolsExpanded: () => false,
};

function fence(lines: string[] | string): string {
	const body = (Array.isArray(lines) ? lines : String(lines).split("\n"))
		.map((line) => stripAnsi(String(line)).replace(/\s+$/g, ""))
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.replace(/^\n+/, "")
		.trimEnd();
	return `\`\`\`text\n${body}\n\`\`\``;
}

function renderLines(component: any, width = WIDTH): string[] {
	return component
		.render(width)
		.map((line: string) => stripAnsi(String(line)).replace(/\s+$/g, ""));
}

function renderBlock(component: any, width = WIDTH): string {
	return fence(renderLines(component, width));
}

function section(title: string, body: string): string {
	return `## ${title}\n\n${body.trim()}\n`;
}

function header(modeLabel: string, modeKey: string): string {
	return `# 工具 Render 示例（ccstyle · ${modeLabel}）

> 由真实 renderer 驱动生成的示例快照，已剥离 ANSI。
> 实际 TUI 中包含状态色、背景色和 hover 高亮；Braille loading 帧会随时间变化。
> 当前版本：ccstyle ${version} · mode=\`${modeKey}\`。
> renderer 变更后请运行 \`npm run docs:tool-render\` 同步本文件。
`;
}

async function bootCcstyle(mode: "on" | "compact") {
	const events = new Map<string, Function[]>();
	const pi = {
		registerCommand() {},
		registerShortcut() {},
		registerTool() {},
		on(name: string, handler: Function) {
			const list = events.get(name) ?? [];
			list.push(handler);
			events.set(name, list);
		},
	};
	const previousMode = config.mode;
	claudeCodeStyle(pi as any, { mode });
	const ctx = { mode: "tui", hasUI: true, ui };
	for (const handler of events.get("session_start") ?? []) await handler({}, ctx);
	setMessageDisplayTheme(plainTheme);
	return {
		async shutdown() {
			for (const handler of events.get("session_shutdown") ?? []) await handler({}, ctx);
			config.mode = previousMode;
		},
	};
}

function tool(name: string, id: string, args: Record<string, unknown> = {}, definition?: any) {
	return new ToolExecutionComponent(
		name,
		id,
		args,
		{},
		definition ?? { name },
		ui as any,
		process.cwd(),
	) as any;
}

function succeed(component: any, text?: string, details?: unknown) {
	component.updateResult({
		content: text == null ? [] : [{ type: "text", text }],
		details,
		isError: false,
	});
	return component;
}

function fail(component: any, text: string) {
	component.updateResult({
		content: [{ type: "text", text }],
		isError: true,
	});
	return component;
}

function writeDoc(name: string, chunks: string[]) {
	const path = join(docsDir, name);
	writeFileSync(path, `${chunks.join("\n").trimEnd()}\n`, "utf8");
	console.log(`wrote ${path}`);
}

// ─── default (mode=on) ───────────────────────────────────────────────

async function generateDefault() {
	const runtime = await bootCcstyle("on");
	const store = new WriteExecutionMetadataStore();
	const chunks: string[] = [header("default", "on")];

	// 1. 运行/完成/失败
	{
		const pending = tool("bash", "s1", { command: "rg -n 'renderCall' extensions/ --type ts" });
		const done = succeed(
			tool("bash", "s2", { command: "rg -n 'renderCall' extensions/ --type ts" }),
			"first\nsecond",
		);
		const errored = fail(
			tool("read", "s3", { path: "missing.ts" }),
			"ENOENT: no such file or directory, open 'missing.ts'",
		);
		chunks.push(
			section(
				"1. 运行态 / 完成态 / 失败态",
				[
					fence([...renderLines(pending), ...renderLines(done), ...renderLines(errored)]),
					[
						"- 运行中：call 行使用 Braille 转轮。",
						"- 完成/失败：`✓` / `✗`；结果行缩进 3 格（`   ↳`）。",
						"- 可展开结果附带 `click to show more`（fullscreen 文案）。",
					].join("\n"),
				].join("\n\n"),
			),
		);
	}

	// 2. read detail
	{
		const c = succeed(
			tool("read", "r1", { path: "extensions/index.ts", offset: 10, limit: 50 }),
			Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join("\n"),
		);
		chunks.push(section("2. read 参数详情", renderBlock(c)));
	}

	// 3. expanded IO
	{
		const c = succeed(
			tool("bash", "e1", { command: "rg -n 'renderCall' extensions/" }),
			"extensions/renderer/default-mode.ts:300: renderCall(args, theme,\ncontext) {",
		);
		c.setExpanded(true);
		chunks.push(
			section(
				"3. 单工具展开（Input/Output 树）",
				`${renderBlock(c)}\n\nInput/Output 之间有一个空白 rail 行（\`│\`）。展开最外层卡片上下左右内间距各 1 格（内容贴左，由 Box padding 提供）。`,
			),
		);
	}

	// 4. edit/write rich diff
	{
		const editDiff = [
			"@@ -1,3 +1,4 @@",
			' 1|import { run } from "./runner";',
			"-2|const threshold = 41;",
			"+2|const threshold = 42;",
			" 3|export default run;",
			'+4|export const version = "0.8.30";',
		].join("\n");
		const editCall = succeed(tool("edit", "ed1", { path: "sample.ts" }), undefined, {
			diff: editDiff,
		});

		const longDiff = ["@@ -1,40 +1,40 @@"];
		for (let i = 1; i <= 40; i++) longDiff.push(`-${i}|old value ${i}`, `+${i}|new value ${i}`);
		const longCollapsed = renderRichToolResult(
			"edit",
			{ details: { diff: longDiff.join("\n") }, content: [] },
			{ expanded: false },
			plainTheme,
			{ args: { path: "sample.ts" } },
			store,
			() => ({ ...DEFAULT_TOOL_DISPLAY_CONFIG, editDiffCollapsedLines: 2 }),
		);
		const longHint =
			renderLines(longCollapsed).find((l) => l.includes("more")) ??
			"… (more diff lines • click to show more)";

		store.set("w-create", { fileExistedBeforeWrite: false });
		const writeCreate = renderRichToolResult(
			"write",
			{ content: [{ type: "text", text: "wrote new.ts" }], details: {} },
			{ expanded: true },
			plainTheme,
			{ toolCallId: "w-create", args: { path: "new.ts", content: "const x = 1\n" } },
			store,
		);
		store.set("w-over", {
			fileExistedBeforeWrite: true,
			previousContent: "const y = 2\n",
		});
		const writeOver = renderRichToolResult(
			"write",
			{ content: [{ type: "text", text: "wrote old.ts" }], details: {} },
			{ expanded: true },
			plainTheme,
			{ toolCallId: "w-over", args: { path: "old.ts", content: "const x = 1\n" } },
			store,
		);

		chunks.push(
			section(
				"4. edit/write rich diff",
				[
					fence(renderLines(editCall, 46)),
					"长 diff 提示：",
					fence([longHint]),
					[
						"- hover `click to show more` 时由 muted 切换为白色 text。",
						"- 点击提示可展开工具；展开后仍受 `expandedPreviewMaxLines` 限制。",
						"- 展开态下 diff 行数提示为 warning 色。",
					].join("\n"),
					"write 新建 / 覆盖：",
					fence([...renderLines(writeCreate), "", ...renderLines(writeOver)]),
				].join("\n\n"),
			),
		);
	}

	// 5. Task series
	{
		const blocks: string[] = [];
		const taskList = succeed(
			tool("TaskList", "tl", {}),
			"#1 [in_progress] 重构 renderer\n#2 [pending] 补充测试\n#3 [completed] 发布 0.8.29",
		);
		blocks.push(...renderLines(taskList, 64));
		taskList.setExpanded(true);
		blocks.push(
			...renderLines(taskList, 64).filter((l) => /#\d|in_progress|pending|completed/.test(l)),
		);

		const cases: Array<[string, Record<string, unknown>, string, boolean]> = [
			[
				"TaskCreate",
				{ subject: "重构 renderer" },
				"Task #1 created successfully: 重构 renderer",
				true,
			],
			["TaskExecute", { task_ids: ["1", "2", "3"] }, "Tasks #1, #2, #3", true],
			["TaskUpdate", { task_id: "3" }, "Updated task #3 发布 0.8.29", true],
			["TaskStop", { taskId: "1" }, "Task #1", true],
			["TaskGet", { taskId: "3" }, "id: 3\nstatus: completed", false],
			["TaskOutput", { task_id: "1" }, "line1\nline2", false],
		];
		for (const [name, args, text, expand] of cases) {
			const c = succeed(tool(name, name, args), text);
			if (expand) c.setExpanded(true);
			blocks.push(...renderLines(c));
		}
		chunks.push(section("5. Task 系列", fence(blocks)));
	}

	// 6. Agent family
	{
		const blocks: string[] = [
			" Agent                                            ← Agent 有专用 renderer：无状态图标",
			" {",
			'   "description": "探活 subagent",',
			'   "prompt": "…",',
			'   "subagent_type": "explore",',
			'   "run_in_background": true',
			" }",
			" Agent started in background.",
			" Agent ID: 7d535698-4ad6-47a",
		];
		for (const [name, args, text] of [
			["get_subagent_result", { agent_id: "7d535698-4ad6-47a" }, "a\nb\nc\nd"],
			["steer_subagent", { agent_id: "7d535698-4ad6-47a" }, "ok"],
			["Agents", { description: "并行调研" }, "launched"],
		] as const) {
			blocks.push(...renderLines(succeed(tool(name, name, args), text)));
		}
		chunks.push(section("6. Agent 家族", fence(blocks)));
	}

	// 7. external tools
	{
		const blocks: string[] = [];
		for (const [name, args, text] of [
			["Skill", { name: "ponytail" }, "loaded"],
			["EnterPlanMode", {}, "plan mode on"],
			["ExitPlanMode", {}, "plan:\n- step 1\n- step 2"],
			["WebSearch", { query: "pi coding agent extension" }, "r1\nr2\nr3"],
			["FetchContent", { url: "https://example.com" }, "ok"],
		] as const) {
			blocks.push(...renderLines(succeed(tool(name, name, args), text)));
		}
		chunks.push(
			section(
				"7. 外部工具",
				`${fence(blocks)}\n\n- Enter Plan Mode 短结果可能无 \`click to show more\`。`,
			),
		);
	}

	// 8. MCP / custom
	{
		const blocks: string[] = [];
		blocks.push(
			...renderLines(
				succeed(
					tool(
						"github_search_code",
						"mcp1",
						{ query: "pi" },
						{ name: "github_search_code", label: "MCP: search_code" },
					),
					"1 hit",
					{ server: "github", tool: "search_code" },
				),
			),
		);
		blocks.push(...renderLines(succeed(tool("customTranslate", "c1", { text: "hi" }), "你好")));
		chunks.push(section("8. MCP / 自定义工具", fence(blocks)));
	}

	// 9. tool grouping
	{
		const hooks = installToolGrouping(() => true);
		try {
			hooks.setTheme(plainTheme);
			const parent = new Container() as any;
			const read = tool("read", "g-read", { path: "extensions/index.ts" });
			const bash = tool("bash", "g-bash", { command: "npm test" });
			const grep = tool("ffgrep", "g-ffgrep", {
				path: "extensions/",
				pattern: "renderCall",
			});
			parent.addChild(read);
			parent.addChild(bash);
			parent.addChild(grep);
			const group = parent.children[0];
			if (!(group instanceof ToolGroupComponent)) {
				throw new Error(
					`expected tool group, got ${group?.constructor?.name ?? typeof group}`,
				);
			}

			const running = renderLines(group);
			bash.updateResult({ content: [{ type: "text", text: "pass 79/79" }], isError: false });
			read.updateResult({
				content: [
					{
						type: "text",
						text: Array.from({ length: 40 }, (_, i) => `L${i}`).join("\n"),
					},
				],
				isError: false,
			});
			grep.updateResult({ content: [{ type: "text", text: "no match" }], isError: true });
			const settled = renderLines(group);
			group.setExpanded(true);
			const expanded = renderLines(group);

			chunks.push(
				section(
					"9. 工具组（tool-grouping）",
					[
						"### 收起：运行中",
						fence(running),
						"### 收起：完成/失败",
						fence(settled),
						"### 展开：完整背景卡片",
						fence(expanded),
						[
							"ANSI 剥离后无法展示背景，实际 TUI 行为如下：",
							"",
							"- 组头始终使用状态色圆点 `●`。",
							"- 内部工具使用 `✓`、`✗` 或 Braille loading spinner。",
							"- 展开区统一绘制完整状态背景，左右和底部各 1 格 padding，无顶部 padding。",
							"- 外层树在收起/展开时位置不变；Input/Output 树线与上方状态图标对齐。",
							"- Input/Output 之间各有一个空白 rail 行。",
							"- 点击展开区任意行、任意列（含底部 padding）均可收起。",
							"- 组末尾不再额外追加空白行。",
						].join("\n"),
					].join("\n\n"),
				),
			);
		} finally {
			hooks.shutdown();
		}
	}

	// 10. working footer
	chunks.push(
		section(
			"10. Working footer",
			[
				"保留 Pi 原生 spinner，仅扩展文本：",
				fence(["⠋ Working...", "⠋ Working... (↓ 1,234 tokens · 12s)"]),
				[
					"- 流式阶段按文本字符数 `/ 4` 估算 token。",
					"- provider 提供 `usage.output` 时优先使用真实值。",
					"- 支持多文本块、`text_end`/`done`/`error` 校准和跨 turn 重置。",
					"- turn 结束后立即恢复默认状态，不显示 `✻ Turn took ...`。",
				].join("\n"),
			].join("\n\n"),
		),
	);

	await runtime.shutdown();
	writeDoc("tool-render-examples-default.md", chunks);
}

// ─── compact ─────────────────────────────────────────────────────────

async function generateCompact() {
	const runtime = await bootCcstyle("compact");
	const store = new WriteExecutionMetadataStore();
	// boot 已装 compact-mode；再保证 theme 与 write store 可用
	const previousTheme = getMessageDisplayTheme();
	setMessageDisplayTheme(plainTheme);

	const query = {
		getMessageThinkingDurationMs: (timestamp: number) => {
			if (timestamp === 1) return 8500;
			if (timestamp === 2) return 1200;
			if (timestamp === 3) return 8500;
			return 0;
		},
		isMessageThinkingActive: (timestamp: number) => timestamp === 1 && thinkingActive,
		getThinkingAnimationFrame: () => 0,
	};
	let thinkingActive = true;

	// 独立 hooks 用于 buildMessageSummary 场景（与 boot 补丁并存安全）
	const localHooks = installCompactMode({ query, writeMetadata: store });
	const chunks: string[] = [header("compact", "compact")];

	try {
		// 1. 摘要行
		{
			const msg = {
				role: "assistant",
				timestamp: 1,
				content: [
					{ type: "thinking", thinking: "plan" },
					{ type: "toolCall", id: "b1", name: "bash", arguments: { command: "npm test" } },
					{ type: "toolCall", id: "r1", name: "read", arguments: { path: "a.ts" } },
					{ type: "toolCall", id: "r2", name: "read", arguments: { path: "a.ts" } },
					{ type: "toolCall", id: "r3", name: "read", arguments: { path: "b.ts" } },
					{ type: "toolCall", id: "g1", name: "grep", arguments: { pattern: "x" } },
				],
			} as unknown as AssistantMessage;

			thinkingActive = true;
			const active = new AssistantMessageComponent(msg, true) as any;
			active.updateContent(msg);
			const activeLines = renderLines(active);

			thinkingActive = false;
			const doneMsg = {
				...msg,
				timestamp: 2,
				content: [
					{ type: "toolCall", id: "b2", name: "bash", arguments: { command: "ls" } },
					{ type: "toolCall", id: "f1", name: "fffind", arguments: { pattern: "x" } },
				],
			} as unknown as AssistantMessage;
			const done = new AssistantMessageComponent(doneMsg, true) as any;
			done.updateContent(doneMsg);
			const doneLines = renderLines(done);

			// 结束 active 回合，避免污染下方展开预览的独立回合。
			active.updateContent({
				role: "assistant",
				content: [{ type: "text", text: "done" }],
			} as unknown as AssistantMessage);

			// 展开预览：setExpanded(true) 后恢复原生渲染（摘要行 + Thinking + 工具卡）。
			const expandMsg = {
				role: "assistant",
				timestamp: 3,
				content: [
					{ type: "thinking", thinking: "check" },
					{ type: "toolCall", id: "x1", name: "bash", arguments: { command: "npm test" } },
					{ type: "toolCall", id: "x2", name: "read", arguments: { path: "a.ts" } },
				],
			} as unknown as AssistantMessage;
			const expand = new AssistantMessageComponent(expandMsg, true) as any;
			expand.updateContent(expandMsg);
			succeed(tool("bash", "x1", { command: "npm test" }), "pass 79/79");
			succeed(tool("read", "x2", { path: "a.ts" }), "line1\nline2");
			// 发送最终文本结束回合，展开时摘要显示 Ran for（而非 Running...）。
			new AssistantMessageComponent(
				{ role: "assistant", content: [{ type: "text", text: "done" }] } as unknown as AssistantMessage,
				true,
			).updateContent({
				role: "assistant",
				content: [{ type: "text", text: "done" }],
			} as unknown as AssistantMessage);
			expand.setExpanded(true);
			const expandedLines = renderLines(expand);

			chunks.push(
				section(
					"1. 消息折叠摘要行",
					[
						"含 toolCall 的 assistant 折叠为单行摘要（运行时长 + 工具计数）：",
						fence([...activeLines, ...doneLines]),
						"展开（Ctrl+O / 点击摘要行）后恢复原生渲染：",
						fence(expandedLines),
						[
							"- 进行中：`Running... · <时长>`；结束后：`Ran for <时长>`。",
							"- 时长 = max(thinking, 回合挂钟)；thinking 冻结后挂钟继续抬高。",
							"- 工具按消息内首次出现顺序；`read` 按非空路径去重。",
							"- `edit` / `write` **不进**摘要计数（各自独立单行）。",
							"- Agent/Task 调用只进摘要；tool 卡始终折叠。底部面板走独立 widget。",
							"- abort/error/length 状态行挂在摘要外层，不被折叠吞掉。",
							"- 行末 `click to show more`；摘要永不换行。",
							"- 展开后：摘要行隐藏，thinking 与工具卡恢复原生渲染，子卡片背景更深且带内部 padding。",
						].join("\n"),
						"纯函数口径（`buildMessageSummary`）：",
						fence([
							buildMessageSummary(
								{
									timestamp: 1,
									content: [
										{ type: "toolCall", name: "read", arguments: { path: "a.ts" } },
										{ type: "toolCall", name: "read", arguments: { path: "a.ts" } },
										{ type: "toolCall", name: "read", arguments: { path: "b.ts" } },
										{ type: "toolCall", name: "bash", arguments: { command: "echo" } },
										{ type: "toolCall", name: "edit", arguments: {} },
										{ type: "toolCall", name: "write", arguments: {} },
										{ type: "toolCall", name: "grep", arguments: { pattern: "x" } },
									],
								},
								query,
							),
							buildMessageSummary(
								{
									timestamp: 1,
									content: [
										{ type: "toolCall", name: "bash", arguments: {} },
										{ type: "toolCall", name: "read", arguments: { path: "a.ts" } },
									],
								},
								{
									getMessageThinkingDurationMs: () => 8500,
									isMessageThinkingActive: () => true,
								},
							),
						]),
					].join("\n\n"),
				),
			);
		}

		// 2. 普通工具隐藏
		{
			const read = succeed(tool("read", "cr1", { path: "a.ts" }), "ok");
			const bash = succeed(tool("bash", "cb1", { command: "echo hi" }), "hi");
			chunks.push(
				section(
					"2. 普通工具行隐藏",
					[
						"折叠时普通工具 **不渲染独立行**（摘要已统计）：",
						fence([
							`read 折叠行数: ${renderLines(read).filter((l) => l.trim()).length}`,
							`bash 折叠行数: ${renderLines(bash).filter((l) => l.trim()).length}`,
						]),
						"展开（Ctrl+O / 点击）后恢复 default 风格工具卡或原生 renderer。",
					].join("\n\n"),
				),
			);
		}

		// 3. edit/write 独立行
		{
			const editDiff = [
				"@@ -1 +1 @@",
				"-const x = 1",
				"+const x = 2",
			].join("\n");
			const edit = succeed(tool("edit", "ce1", { path: "sample.ts" }), undefined, {
				diff: editDiff,
			});
			const write = succeed(tool("write", "cw1", { path: "out.ts", content: "hi\n" }), "ok");
			// write metadata for collapsed stats if needed
			store.set("cw1", { fileExistedBeforeWrite: false });

			chunks.push(
				section(
					"3. edit / write 独立行",
					[
						"edit/write 标题行带统计；折叠预览与展开正文复用 mode=on 的 Diff 配置：",
						fence([...renderLines(edit), ...renderLines(write)]),
						"展开 edit：",
					].join("\n\n"),
				),
			);
			edit.setExpanded(true);
			chunks[chunks.length - 1] = section(
				"3. edit / write 独立行",
				[
					"edit/write 标题行带统计；折叠预览与展开正文复用 mode=on 的 Diff 配置：",
					fence([
						...renderLines(succeed(tool("edit", "ce2", { path: "sample.ts" }), undefined, {
							diff: editDiff,
						})),
						...renderLines(write),
					]),
					"展开 edit：",
					fence(renderLines(edit, 46)),
				].join("\n\n"),
			);
		}

		// 4. 无 toolCall 的 final 文本
		{
			const finalMessage = {
				role: "assistant",
				content: [{ type: "text", text: "task done" }],
			} as unknown as AssistantMessage;
			const final = new AssistantMessageComponent(finalMessage, true) as any;
			final.updateContent(finalMessage);
			chunks.push(
				section(
					"4. 无 toolCall 的最终回复",
					[
						"不含 toolCall 的 assistant 走原生渲染：",
						fence(renderLines(final)),
					].join("\n\n"),
				),
			);
		}

		// 5. 回合聚合说明
		chunks.push(
			section(
				"5. 回合聚合规则",
				[
					[
						"- 连续含 toolCall 的 assistant 消息累加进同一回合摘要，直到出现可见最终文本。",
						"- 运行时长跨消息累加（thinking query + 回合挂钟 floor）。",
						"- 最终 agent 回合摘要仍由 `feature/agent-summary` 独占（bash/read/edit/write/other）。",
						"- mode 切回 `on`/`off` 后，assistant 与 tool 均恢复对应原生/default 渲染。",
					].join("\n"),
				].join("\n\n"),
			),
		);

		// 6. working footer（共用）
		chunks.push(
			section(
				"6. Working footer",
				[
					"与 default 相同，保留 Pi 原生 spinner，仅扩展文本：",
					fence(["⠋ Working...", "⠋ Working... (↓ 1,234 tokens · 12s)"]),
				].join("\n\n"),
			),
		);
	} finally {
		localHooks.shutdown();
		setMessageDisplayTheme(previousTheme);
		await runtime.shutdown();
	}

	writeDoc("tool-render-examples-compact.md", chunks);
}

async function main() {
	await generateDefault();
	await generateCompact();

	// 旧单文件废弃
	const legacy = join(docsDir, "tool-render-examples.md");
	if (existsSync(legacy)) {
		unlinkSync(legacy);
		console.log(`removed ${legacy}`);
	}
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
