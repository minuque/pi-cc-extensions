import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
	AssistantMessageComponent,
	CustomMessageComponent,
	ToolExecutionComponent,
	UserMessageComponent,
	initTheme,
} from "@earendil-works/pi-coding-agent";
import { Container, Spacer, visibleWidth } from "@earendil-works/pi-tui";
import { config } from "../extensions/config/config.ts";
import { installDefaultMode } from "../extensions/renderer/default-mode.ts";
import { WriteExecutionMetadataStore } from "../extensions/renderer/tool/diff/index.ts";
import { installToolGrouping, ToolGroupComponent } from "../extensions/renderer/tool/grouping.ts";
import {
	renderSubagentNotification,
	subagentNotificationItems,
} from "../extensions/renderer/tool/subagent-notification.ts";

initTheme("dark");

// Pi 的主题模块：ctx.ui.theme 是其中的稳定代理，换主题只换代理背后的实例。
const hostModule = (path: string) =>
	new URL(path, import.meta.resolve("@earendil-works/pi-coding-agent")).href;
const {
	loadThemeFromPath,
	setThemeInstance,
	theme: piTheme,
} = await import(hostModule("./modes/interactive/theme/theme.js"));

const stripAnsi = (line: string) => line.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");

function plain(lines: string[]): string[] {
	return lines.map(stripAnsi).filter((line) => line.trim());
}

function finishedAgent(overrides: Record<string, unknown> = {}) {
	return {
		id: "6dae0e11-9341-43b",
		description: "Locate completion text owner",
		status: "completed",
		toolUses: 35,
		turnCount: 0,
		totalTokens: 57_100,
		totalCost: 0.8207,
		durationMs: 34_800,
		outputFile: "/tmp/pi-subagents-1000/session/tasks/6dae0e11-9341-43b.output",
		resultPreview: "The displayed block is owned by pi-subagents.\nSecond line…",
		...overrides,
	};
}

function notification(details: unknown) {
	return {
		role: "custom" as const,
		customType: "subagent-notification",
		content: "<task-notification>…</task-notification>",
		display: true,
		details,
		timestamp: 1,
	};
}

function standalone(details: unknown, expanded = false) {
	const component = new CustomMessageComponent(
		notification(details) as any,
		renderSubagentNotification as any,
	);
	component.setExpanded(expanded);
	return component;
}

test("a standalone finished-subagent row summarizes the agent id and usage", () => {
	const rows = plain(standalone(finishedAgent()).render(160));
	assert.deepEqual(rows, [
		" ✓ Subagent Finished 6dae0e11-9341-43b · 35 tool uses · 57.1k token · ~$0.8207 · 34.8s · click to show more",
	]);
});

test("unavailable statistics are omitted rather than shown as zero", () => {
	const rows = plain(
		standalone(
			finishedAgent({
				toolUses: 0,
				turnCount: 0,
				totalTokens: 0,
				totalCost: undefined,
				durationMs: 0,
			}),
		).render(160),
	);
	assert.deepEqual(rows, [" ✓ Subagent Finished 6dae0e11-9341-43b · click to show more"]);
	const measuredTurns = plain(standalone(finishedAgent({ turnCount: 3, toolUses: 1 })).render(160));
	assert.match(measuredTurns[0]!, /6dae0e11-9341-43b · 3 turns · 1 tool use · 57\.1k token/);
});

test("missing, null, and malformed details still render one finished-subagent row", () => {
	for (const details of [
		undefined,
		null,
		"oops",
		{ others: null },
		{ id: 42, others: [null, 7] },
	]) {
		const rows = plain(standalone(details).render(160));
		assert.deepEqual(rows, [" ✓ Subagent Finished · click to show more"], JSON.stringify(details));
	}
});

test("each agent in a group notification gets its own row with its own status", () => {
	const details = {
		...finishedAgent({ id: "first", status: "error", error: "upstream stream failed" }),
		others: [
			finishedAgent({ id: "second", status: "steered" }),
			finishedAgent({ id: "third", status: "aborted" }),
			finishedAgent({ id: "fourth", status: undefined, error: "crashed" }),
		],
	};
	const rows = plain(standalone(details).render(200));
	assert.equal(rows.length, 4);
	assert.match(rows[0]!, /^ ✗ Subagent Finished first · error · 35 tool uses/);
	assert.match(rows[1]!, /^ ✓ Subagent Finished second · completed \(steered\) · 35 tool uses/);
	assert.match(rows[2]!, /^ ✗ Subagent Finished third · aborted · 35 tool uses/);
	assert.match(rows[3]!, /^ ✗ Subagent Finished fourth · 35 tool uses/, "no status, no outcome");
	assert.equal(rows.filter((row) => row.includes("click to show more")).length, 1);
	assert.match(rows[3]!, /· click to show more$/);
});

test("the row names the outcome unless the agent simply completed", () => {
	const outcome = (status: string) => plain(standalone(finishedAgent({ status })).render(200))[0]!;
	assert.match(outcome("completed"), /^ ✓ Subagent Finished 6dae0e11-9341-43b · 35 tool uses/);
	assert.match(
		outcome("steered"),
		/^ ✓ Subagent Finished 6dae0e11-9341-43b · completed \(steered\) · 35 tool uses/,
	);
	assert.match(
		outcome("stopped"),
		/^ ⚠ Subagent Finished 6dae0e11-9341-43b · stopped · 35 tool uses/,
	);
	assert.match(
		outcome("queued"),
		/^ ✓ Subagent Finished 6dae0e11-9341-43b · queued · 35 tool uses/,
	);
	const expanded = card(standalone(finishedAgent({ status: "steered" }), true).render(120));
	assert.equal(expanded[0], " ✓ Subagent Finished 6dae0e11-9341-43b");
	assert.equal(expanded[1], " ├ Description");
	assert.equal(expanded[2], " │ Locate completion text owner");
	assert.equal(expanded[4], " ├ Status");
	assert.equal(expanded[5], " │ completed (steered)");
});

function card(lines: string[]): string[] {
	const rows = lines.map((line) => stripAnsi(line).trimEnd());
	while (rows.length && !rows[0]) rows.shift();
	while (rows.length && !rows.at(-1)) rows.pop();
	return rows;
}

test("the expanded view shows description, status, stats, saved preview, and transcript", () => {
	const rows = card(standalone(finishedAgent(), true).render(120));
	assert.deepEqual(rows, [
		" ✓ Subagent Finished 6dae0e11-9341-43b",
		" ├ Description",
		" │ Locate completion text owner",
		" │",
		" ├ Status",
		" │ completed",
		" │ 35 tool uses · 57.1k token · ~$0.8207 · 34.8s",
		" │",
		" ├ Saved result preview",
		" │ The displayed block is owned by pi-subagents.",
		" │ Second line…",
		" │",
		" └ Transcript",
		"   /tmp/pi-subagents-1000/session/tasks/6dae0e11-9341-43b.output",
	]);
});

test("the expanded view adds the error and omits whatever the payload lacks", () => {
	const failed = card(
		standalone(
			finishedAgent({
				status: "error",
				error: "Error Code null: upstream stream failed",
				resultPreview: "No output.",
				outputFile: undefined,
				totalCost: undefined,
			}),
			true,
		).render(120),
	);
	assert.deepEqual(failed, [
		" ✗ Subagent Finished 6dae0e11-9341-43b",
		" ├ Description",
		" │ Locate completion text owner",
		" │",
		" ├ Status",
		" │ error",
		" │ 35 tool uses · 57.1k token · 34.8s",
		" │",
		" ├ Saved result preview",
		" │ No output.",
		" │",
		" └ Error",
		"   Error Code null: upstream stream failed",
	]);
	assert.deepEqual(card(standalone(null, true).render(120)), [" ✓ Subagent Finished"]);
});

test("expanded preview wraps to the card width and agents are separated", () => {
	const long = "word ".repeat(30).trim();
	const details = {
		...finishedAgent({ id: "first", resultPreview: long, outputFile: undefined }),
		others: [finishedAgent({ id: "second", description: undefined, outputFile: undefined })],
	};
	const rows = card(standalone(details, true).render(60));
	for (const row of rows) assert.ok(row.length <= 60, row);
	// 预览是最后一段时用 `└` + 两格缩进，否则用 `│`；比较文字时先去掉边框。
	const heading = rows.findIndex((row) => /^ [├└] Saved result preview$/.test(row));
	const preview = rows.slice(heading + 1).map((row) => row.replace(/^[ │]+/, ""));
	assert.ok(preview[0]!.startsWith("word word"), preview[0]);
	assert.ok(preview[1]!.startsWith("word word"), "long preview wraps instead of truncating");
	const second = rows.indexOf(" ✓ Subagent Finished second");
	assert.ok(second > 0);
	assert.equal(rows[second - 1], "", "agents are separated by a blank row");
	assert.equal(rows[second + 1], " ├ Status");
});

test("narrow standalone rows stay within the width and expanded text survives wrapping", () => {
	const details = {
		...finishedAgent({ id: "first", status: "error", error: "upstream stream failed" }),
		others: [
			finishedAgent({ id: "second", status: "steered" }),
			finishedAgent({ id: "third", status: "aborted" }),
			finishedAgent({ id: "fourth" }),
		],
	};
	// 边框字符随折行重复，比较文字时连边框一起去掉。
	const squash = (rows: string[]) => rows.join("").replace(/[\s│├└]/g, "");
	const wide = squash(card(standalone(details, true).render(200)));
	for (const width of [20, 30, 40, 120]) {
		for (const expanded of [false, true]) {
			for (const line of standalone(details, expanded).render(width)) {
				assert.ok(
					visibleWidth(line) <= width,
					`width ${width}, expanded ${expanded}: ${stripAnsi(line)}`,
				);
			}
		}
		assert.equal(squash(card(standalone(details, true).render(width))), wide, `width ${width}`);
	}
});

test("the expanded card background follows the worst agent status", () => {
	const tagTheme = {
		fg: (_color: string, text: string) => text,
		bg: (slot: string, text: string) => `<${slot}>${text}</${slot}>`,
	};
	const paint = (details: unknown) =>
		(renderSubagentNotification as any)(
			notification(details),
			{ expanded: true, outputPad: 1 },
			tagTheme,
		)
			.render(80)
			.join("\n");
	assert.match(paint(finishedAgent()), /<toolSuccessBg>/);
	assert.doesNotMatch(paint(finishedAgent()), /<toolErrorBg>/);
	const mixed = paint({ ...finishedAgent(), others: [finishedAgent({ status: "aborted" })] });
	assert.match(mixed, /<toolErrorBg>/);
	assert.doesNotMatch(mixed, /<toolSuccessBg>/);
});

const ui = { theme: { fg: (_color: string, text: string) => text }, requestRender() {} } as any;

function settledTool(name: string, id: string, args: any = {}, isError = false) {
	const component = new ToolExecutionComponent(
		name,
		id,
		args,
		{},
		undefined,
		ui,
		process.cwd(),
	) as any;
	component.markExecutionStarted();
	component.updateResult({ content: [{ type: "text", text: "ok" }], isError });
	return component;
}

function withGrouping(run: (hooks: ReturnType<typeof installToolGrouping>) => void) {
	const hooks = installToolGrouping(() => true);
	try {
		run(hooks);
	} finally {
		hooks.shutdown();
	}
}

test("a finished subagent joins the adjacent tools as one more grouped item", () => {
	withGrouping(() => {
		const parent = new Container() as any;
		const note = standalone(finishedAgent());
		parent.addChild(note);
		parent.addChild(
			settledTool("get_subagent_result", "result", { agent_id: "6dae0e11-9341-43b" }),
		);
		parent.addChild(
			settledTool("read", "read", {
				path: "/home/ning/github/pi-subagents/src/index.ts",
				offset: 280,
				limit: 92,
			}),
		);
		assert.equal(parent.children.length, 1);
		const group = parent.children[0] as ToolGroupComponent;
		assert.ok(group instanceof ToolGroupComponent);
		assert.equal(group.children[0], note, "the notification keeps its place in the order");
		assert.deepEqual(plain(group.render(240)), [
			" ● Multiple Tools: 3 done · Subagent Finished×1, Get Subagent Result×1, Read×1 · click to show more",
			" ├ ✓ Subagent Finished 6dae0e11-9341-43b · 35 tool uses · 57.1k token · ~$0.8207 · 34.8s",
			" ├ ✓ Get Subagent Result 6dae0e11-9341-43b",
			" └ ✓ Read /home/ning/github/pi-subagents/src/index.ts (offset=280, limit=92)",
		]);
	});
});

function groupOf(...members: any[]): ToolGroupComponent {
	const parent = new Container() as any;
	for (const member of members) parent.addChild(member);
	assert.equal(parent.children.length, 1, "members collapse into one group");
	return parent.children[0] as ToolGroupComponent;
}

test("an expanded group nests agent details in the tree and keeps tool views", () => {
	withGrouping(() => {
		const tools = () => [
			settledTool("get_subagent_result", "result", { agent_id: "6dae0e11-9341-43b" }),
			settledTool("read", "read", { path: "src/index.ts" }),
		];
		const baseline = groupOf(...tools());
		baseline.setExpanded(true);
		const toolRows = card(baseline.render(120)).slice(1);

		const note = standalone(finishedAgent());
		const group = groupOf(note, ...tools());
		group.setExpanded(true);
		const rows = card(group.render(120));
		assert.match(rows[0]!, /^ ● Multiple Tools: 3 done · .* · ↑ Collapse$/);
		assert.deepEqual(rows.slice(1, 16), [
			" ├ ✓ Subagent Finished 6dae0e11-9341-43b",
			" │ ├ Description",
			" │ │ Locate completion text owner",
			" │ │",
			" │ ├ Status",
			" │ │ completed",
			" │ │ 35 tool uses · 57.1k token · ~$0.8207 · 34.8s",
			" │ │",
			" │ ├ Saved result preview",
			" │ │ The displayed block is owned by pi-subagents.",
			" │ │ Second line…",
			" │ │",
			" │ └ Transcript",
			" │   /tmp/pi-subagents-1000/session/tasks/6dae0e11-9341-43b.output",
			" │",
		]);
		assert.deepEqual(rows.slice(16), toolRows, "tool rows are unchanged by the notification");

		// 展开状态转发给通知本身：拆组后它仍是展开卡。
		assert.match(card(note.render(120)).join("\n"), /Saved result preview/);
		group.setExpanded(false);
		assert.doesNotMatch(card(note.render(120)).join("\n"), /Saved result preview/);
	});
});

test("a theme switch repaints grouped notification details after invalidate", (t) => {
	// 还原成测试前的主题实例本身：Pi 用这个 globalThis 槽在各加载器间共享当前主题。
	const THEME_SLOT = Symbol.for("@earendil-works/pi-coding-agent:theme");
	const previousTheme = (globalThis as any)[THEME_SLOT];
	t.after(() => setThemeInstance(previousTheme));
	const repoTheme = (name: string) =>
		loadThemeFromPath(
			fileURLToPath(new URL(`../themes/${name}.json`, import.meta.url)),
			"truecolor",
		);
	const dark = repoTheme("cc-dark");
	const light = repoTheme("cc-light");
	const errorSgr = (instance: any) => instance.fg("error", "|").split("|")[0];
	assert.match(errorSgr(dark), /^\x1b\[38;2;\d+;\d+;\d+m$/);
	assert.notEqual(errorSgr(dark), errorSgr(light), "the themes color errors differently");
	setThemeInstance(dark);
	// 真实的 default mode：它的 paint 缓存让内容不变的工具每帧交回同一数组，分组复用才看得出来。
	const previousMode = config.mode;
	config.mode = "on";
	const defaultMode = installDefaultMode(new WriteExecutionMetadataStore());
	t.after(() => {
		defaultMode.shutdown();
		config.mode = previousMode;
	});
	withGrouping((hooks) => {
		// session_start 交给分组的就是这个代理，换主题后它还是同一个对象。
		hooks.setTheme(piTheme);
		const note = standalone(finishedAgent({ status: "error", error: "upstream stream failed" }));
		const group = groupOf(note, settledTool("read", "read", { path: "a.ts" }));
		group.setExpanded(true);
		const errorRow = (lines: string[]) =>
			lines.find((line) => line.includes("upstream stream failed")) ?? "";
		assert.ok(errorRow(group.render(80)).includes(`${errorSgr(dark)}upstream stream failed`));

		setThemeInstance(light);
		// 换主题时 TUI 整树 invalidate。
		group.invalidate();
		const repainted = group.render(80);
		assert.ok(
			errorRow(repainted).includes(`${errorSgr(light)}upstream stream failed`),
			"the error text takes the new theme's color",
		);
		assert.ok(!errorRow(repainted).includes(errorSgr(dark)), "no old error color survives");
		// 内容不变的后续帧继续复用同一批行：分组展开缓存按引用比对。
		assert.equal(group.render(80), repainted, "an unchanged frame reuses the group's lines");
		const [item] = subagentNotificationItems(note)!;
		assert.equal(item!.expandedRows(78, piTheme), item!.expandedRows(78, piTheme));
	});
});

test("narrow expanded groups wrap every notification row and keep tool rows clickable", () => {
	const details = {
		...finishedAgent({
			id: "6dae0e11-9341-43b-first",
			status: "error",
			error: "upstream stream failed",
		}),
		others: [
			finishedAgent({ id: "6dae0e11-9341-43b-second", status: "steered" }),
			finishedAgent({ id: "6dae0e11-9341-43b-third", status: "aborted" }),
			finishedAgent({ id: "6dae0e11-9341-43b-fourth" }),
		],
	};
	withGrouping(() => {
		const tool = settledTool("read", "read", { path: "a.ts" });
		const group = groupOf(standalone(details), tool);
		group.setExpanded(true);
		const toolRowOf = (lines: string[]) => lines.findIndex((line) => /^ └ [✓✗] /.test(line));
		// 通知各行去掉树枝与状态图标前缀后的正文，空白不计（折行只换行，不增删字）。
		const notificationText = (width: number) => {
			const lines = group.render(width).map(stripAnsi);
			return lines
				.slice(2, toolRowOf(lines))
				.map((line) => line.replace(/^ (?:[├└] [✓✗] |│ )/, ""))
				.join("")
				.replace(/[\s│├└]/g, "");
		};
		const wide = notificationText(200);
		for (const text of [
			"SubagentFinished6dae0e11-9341-43b-first",
			"SubagentFinished6dae0e11-9341-43b-second",
			"Status",
			"completed(steered)",
			"aborted",
			"Savedresultpreview",
			"Errorupstreamstreamfailed",
			"Transcript",
		]) {
			assert.ok(wide.includes(text), `the wide reference carries ${text}`);
		}
		for (const width of [20, 30, 40, 120]) {
			const lines = group.render(width);
			for (const line of lines) {
				assert.ok(visibleWidth(line) <= width, `width ${width}: ${stripAnsi(line)}`);
			}
			assert.equal(notificationText(width), wide, `width ${width} keeps every notification word`);
			// 点击定位与渲染同一套行数：折行后工具行仍落在工具上，上一行仍归分组。
			const toolRow = toolRowOf(lines.map(stripAnsi));
			assert.ok(toolRow > 2, `width ${width}: the tool row follows the notification`);
			assert.equal(group.childAtRow(toolRow, width)?.component, tool, `width ${width}`);
			assert.equal(group.childAtRow(toolRow, width)?.row, 0);
			assert.equal(group.childAtRow(lines.length - 2, width)?.component, tool);
			assert.equal(group.childAtRow(toolRow - 1, width), null, `width ${width}`);
		}
	});
});

test("adjacent notifications form a named group and join later tools without reordering", () => {
	withGrouping(() => {
		const alone = new Container() as any;
		const first = standalone(finishedAgent({ id: "first" }));
		const second = standalone(finishedAgent({ id: "second" }));
		alone.addChild(first);
		alone.addChild(second);
		assert.equal(alone.children.length, 1);
		const group = alone.children[0];
		assert.ok(group instanceof ToolGroupComponent);
		assert.deepEqual(group.children, [first, second]);
		assert.match(plain(group.render(200))[0]!, /^ ● Subagent Finished: 2 done · /);

		// 后来的真实工具并入同一个组，只把同类组标题变成混合组标题。
		const tool = settledTool("get_subagent_result", "joined", { agent_id: "second" });
		alone.addChild(tool);
		assert.deepEqual(alone.children, [group]);
		assert.deepEqual(group.children, [first, second, tool]);
		assert.match(plain(group.render(200))[0]!, /^ ● Multiple Tools: 3 done · /);

		const text = new Container() as any;
		text.addChild(standalone(finishedAgent()));
		text.addChild(
			new AssistantMessageComponent(
				{ role: "assistant", content: [{ type: "text", text: "visible" }] } as any,
				true,
			),
		);
		text.addChild(settledTool("read", "after-text", { path: "a.ts" }));
		assert.equal(
			text.children.some((child: any) => child instanceof ToolGroupComponent),
			false,
			"visible assistant text is a boundary",
		);

		const other = new Container() as any;
		other.addChild(settledTool("read", "before-other", { path: "a.ts" }));
		other.addChild(
			new CustomMessageComponent(
				{ ...notification(finishedAgent()), customType: "other-notification" } as any,
				undefined,
			),
		);
		other.addChild(settledTool("read", "after-other", { path: "b.ts" }));
		assert.equal(
			other.children.some((child: any) => child instanceof ToolGroupComponent),
			false,
			"other custom message types are not groupable",
		);
	});
});

test("notification-only grouping is identical for separate messages and one batched message", () => {
	const first = finishedAgent({ id: "agent-a" });
	const second = finishedAgent({ id: "agent-b", status: "error", error: "upstream failed" });
	const batchDetails = { ...first, others: [second] };
	const snapshot = structuredClone(batchDetails);
	withGrouping(() => {
		const separate = groupOf(standalone(first), standalone(second));
		const batch = standalone(batchDetails);
		const batched = groupOf(batch);
		assert.ok(batched instanceof ToolGroupComponent);
		assert.deepEqual(batched.children, [batch], "one saved message remains one component");
		const expected = plain(separate.render(200));
		assert.equal(expected[0], " ● Subagent Finished: 1 done · 1 failed · click to show more");
		assert.match(expected[1]!, /^ ├ ✓ Subagent Finished agent-a · /);
		assert.match(expected[2]!, /^ └ ✗ Subagent Finished agent-b · error · /);
		assert.deepEqual(plain(batched.render(200)), expected);
		for (const group of [separate, batched]) {
			group.setExpanded(true);
			const text = (width: number) =>
				group
					.render(width)
					.slice(2)
					.map(stripAnsi)
					.join("")
					.replace(/[\s│├└]/g, "");
			const wide = text(200);
			for (const width of [20, 30, 40, 120]) {
				assert.equal(text(width), wide, `width ${width} preserves every agent's details`);
				for (const [row, line] of group.render(width).entries()) {
					assert.ok(visibleWidth(line) <= width);
					assert.equal(group.childAtRow(row, width), null, "all rows belong to the group");
				}
			}
			const paint = group.render(120);
			assert.equal(group.render(120), paint, "unchanged notification-only groups reuse paint");
			group.setExpanded(false);
		}
		assert.doesNotMatch(card(batch.render(120)).join("\n"), /Saved result preview/);
		assert.deepEqual(batchDetails, snapshot, "grouping never rewrites saved details");
	});
});

test("notification-only groups preserve visible boundaries and separator limits", () => {
	withGrouping(() => {
		const boundaries = [
			new UserMessageComponent("visible user text"),
			new AssistantMessageComponent(
				{ role: "assistant", content: [{ type: "text", text: "visible assistant text" }] } as any,
				true,
			),
			new CustomMessageComponent({ ...notification(null), customType: "other" } as any, undefined),
			...["edit", "write", "apply_patch"].map((name) => settledTool(name, name)),
		];
		for (const boundary of boundaries) {
			const parent = new Container();
			const first = standalone(finishedAgent());
			const second = standalone(finishedAgent());
			parent.addChild(first);
			parent.addChild(boundary);
			parent.addChild(second);
			assert.deepEqual(parent.children, [first, boundary, second]);
		}
		for (const count of [3, 4]) {
			const parent = new Container();
			parent.addChild(standalone(finishedAgent()));
			for (let i = 0; i < count; i++) parent.addChild(new Spacer(1));
			parent.addChild(standalone(finishedAgent()));
			assert.equal(parent.children[0] instanceof ToolGroupComponent, count === 3);
		}
		const parent = new Container();
		const boundary = new UserMessageComponent("between batches");
		parent.addChild(standalone({ ...finishedAgent(), others: [finishedAgent()] }));
		parent.addChild(boundary);
		parent.addChild(standalone({ ...finishedAgent(), others: [finishedAgent()] }));
		assert.equal(parent.children.length, 3);
		assert.ok(parent.children[0] instanceof ToolGroupComponent);
		assert.equal(parent.children[1], boundary);
		assert.ok(parent.children[2] instanceof ToolGroupComponent);
	});
});

test("separators left behind a notification group count like those behind a tool group", () => {
	withGrouping(() => {
		const runs = [
			[standalone(finishedAgent()), standalone(finishedAgent()), settledTool("read", "last")],
			[settledTool("read", "first"), settledTool("grep", "second"), settledTool("read", "last")],
		];
		for (const [first, second, last] of runs) {
			const parent = new Container() as any;
			const spacers = [new Spacer(1), new Spacer(1), new Spacer(1), new Spacer(1)];
			for (const child of [first, spacers[0], spacers[1], second, spacers[2], spacers[3], last]) {
				parent.addChild(child);
			}
			// 组只取代第一个成员的位置：成员间的空行留在组后，与后来的空行一起计入三个的上限。
			const group = parent.children[0];
			assert.ok(group instanceof ToolGroupComponent);
			assert.equal(group.children.length, 2);
			assert.equal(group.children[0], first);
			assert.equal(group.children[1], second);
			assert.equal(parent.children.length, 6);
			spacers.forEach((spacer, index) => assert.equal(parent.children[index + 1], spacer));
			assert.equal(parent.children[5], last, "four trailing separators keep the tool standalone");
		}
	});
});

test("mounted-root rescans fold an ungrouped notification run into the following tool's group", () => {
	for (const batched of [false, true]) {
		let enabled = false;
		const hooks = installToolGrouping(() => enabled);
		try {
			const first = finishedAgent({ id: "first" });
			const second = finishedAgent({ id: "second" });
			const members = [
				...(batched
					? [standalone({ ...first, others: [second] })]
					: [standalone(first), standalone(second)]),
				settledTool("get_subagent_result", "result", { agent_id: "second" }),
			];
			const parent = new Container() as any;
			for (const member of members) parent.addChild(member);
			assert.deepEqual(parent.children, members, "disabled grouping leaves the run ungrouped");
			enabled = true;
			const mounted = { getMountedRoots: () => [parent] };
			hooks.refresh(mounted);
			const group = parent.children[0];
			assert.equal(parent.children.length, 1);
			assert.ok(group instanceof ToolGroupComponent);
			assert.equal(group.children.length, members.length);
			members.forEach((member, index) => assert.equal(group.children[index], member));
			const rows = plain(group.render(240));
			assert.match(rows[0]!, /^ ● Multiple Tools: 3 done · /);
			assert.equal(rows.length, 4, "one row per agent plus the tool");
			hooks.refresh(mounted);
			assert.equal(parent.children.length, 1);
			assert.equal(parent.children[0], group, "refresh does not nest or duplicate groups");
			members.forEach((member, index) => assert.equal(group.children[index], member));
		} finally {
			hooks.shutdown();
		}
	}
});

test("notification-only groups survive mode toggles and reload without splitting messages", () => {
	for (const batched of [false, true]) {
		let mode = "compact";
		const enabled = () => mode === "on";
		const hooks = installToolGrouping(enabled);
		let replacement: ReturnType<typeof installToolGrouping> | undefined;
		try {
			const first = finishedAgent({ id: "first" });
			const second = finishedAgent({ id: "second" });
			const notes = batched
				? [standalone({ ...first, others: [second] })]
				: [standalone(first), standalone(second)];
			const parent = new Container() as any;
			for (const note of notes) parent.addChild(note);
			const mounted = { getMountedRoots: () => [parent] };
			assert.deepEqual(parent.children, notes, "compact keeps standalone notification components");
			for (const next of ["on", "off", "on", "compact", "on"]) {
				mode = next;
				hooks.refresh(mounted);
				if (next !== "on") {
					assert.deepEqual(parent.children, notes, `${next} ungroups the original messages`);
					continue;
				}
				const group = parent.children[0];
				assert.ok(group instanceof ToolGroupComponent);
				assert.deepEqual(group.children, notes);
				hooks.refresh(mounted);
				assert.deepEqual(parent.children, [group], "refresh does not nest or duplicate groups");
			}
			replacement = installToolGrouping(enabled);
			assert.deepEqual(parent.children, notes, "reload releases the original message components");
			replacement.refresh(mounted);
			const group = parent.children[0];
			assert.ok(group instanceof ToolGroupComponent);
			assert.deepEqual(group.children, notes);
			hooks.shutdown();
			assert.deepEqual(parent.children, [group], "stale shutdown leaves the replacement alone");
		} finally {
			replacement?.shutdown();
			hooks.shutdown();
		}
	}
});

test("multi-agent notifications count one item per agent in the group", () => {
	withGrouping(() => {
		const details = {
			...finishedAgent({ id: "a" }),
			others: [finishedAgent({ id: "b", status: "error" }), finishedAgent({ id: "c" })],
		};
		const group = groupOf(standalone(details), settledTool("read", "read", { path: "a.ts" }));
		const rows = plain(group.render(200));
		assert.match(
			rows[0]!,
			/^ ● Multiple Tools: 3 done · 1 failed · Subagent Finished×3, Read×1 · /,
		);
		assert.equal(rows.length, 5);
		assert.match(rows[1]!, /^ ├ ✓ Subagent Finished a · 35 tool uses/);
		assert.match(rows[2]!, /^ ├ ✗ Subagent Finished b · error · 35 tool uses/);
		assert.match(rows[3]!, /^ ├ ✓ Subagent Finished c · 35 tool uses/);
		assert.equal(rows[4], " └ ✓ Read a.ts");
	});
});

test("removal keeps notification-only groups until only one display item remains", () => {
	withGrouping((hooks) => {
		const parent = new Container() as any;
		const first = standalone(finishedAgent({ id: "first" }));
		const second = standalone(finishedAgent({ id: "second" }));
		const tool = settledTool("read", "read", { path: "a.ts" });
		parent.addChild(first);
		parent.addChild(second);
		parent.addChild(tool);
		const group = parent.children[0] as ToolGroupComponent;
		group.setExpanded(true);
		parent.removeChild(tool);
		assert.deepEqual(parent.children, [group]);
		assert.deepEqual(group.children, [first, second]);
		assert.match(plain(group.render(200))[0]!, /^ ● Subagent Finished: 2 done · /);
		parent.removeChild(second);
		assert.deepEqual(parent.children, [first]);
		assert.match(card(first.render(120)).join("\n"), /Saved result preview/);

		const batch = standalone({ ...finishedAgent(), others: [finishedAgent({ id: "other" })] });
		const batchParent = new Container() as any;
		batchParent.addChild(batch);
		batchParent.addChild(tool);
		const batchGroup = batchParent.children[0];
		batchParent.removeChild(tool);
		assert.ok(batchGroup instanceof ToolGroupComponent);
		assert.deepEqual(batchParent.children, [batchGroup], "one message still has two display items");
		assert.deepEqual(batchGroup.children, [batch]);
		batchParent.removeChild(batch);
		assert.deepEqual(batchParent.children, [], "removing the entire batch removes its empty group");

		const reloaded = new Container() as any;
		const note = standalone(finishedAgent());
		const read = settledTool("read", "reload", { path: "a.ts" });
		reloaded.addChild(note);
		reloaded.addChild(read);
		hooks.shutdown();
		assert.deepEqual(reloaded.children, [note, read], "shutdown releases the notification");
		const again = installToolGrouping(() => true);
		try {
			again.refresh({ getMountedRoots: () => [reloaded] });
			assert.deepEqual(reloaded.children[0].children, [note, read], "reload regroups it");
		} finally {
			again.shutdown();
		}
	});
});

test("a steered agent keeps its outcome inside the tool group", () => {
	withGrouping(() => {
		const parent = new Container() as any;
		parent.addChild(settledTool("Agent", "agent-1", { subagent_type: "general-purpose" }));
		parent.addChild(settledTool("Agent", "agent-2", { subagent_type: "general-purpose" }));
		parent.addChild(settledTool("steer_subagent", "steer", { agent_id: "a43b4a9d-fcf9-4b9" }));
		parent.addChild(
			standalone({
				id: "a43b4a9d-fcf9-4b9",
				description: "Complete no-op coordination test",
				status: "steered",
				toolUses: 0,
				turnCount: 0,
				totalTokens: 85,
				totalCost: 0.008,
				durationMs: 3_000,
				resultPreview: "Done.",
			}),
		);
		parent.addChild(
			settledTool("bash", "bash", { command: "printf 'Bash ran after subagent completion.\\n'" }),
		);
		assert.equal(parent.children.length, 1);
		const rows = plain(parent.children[0].render(240));
		assert.match(
			rows[0]!,
			/^ ● Multiple Tools: 5 done · Subagent×2, Steer Subagent×1, Subagent Finished×1, Bash×1 · /,
		);
		assert.equal(
			rows[4],
			" ├ ✓ Subagent Finished a43b4a9d-fcf9-4b9 · completed (steered) · 85 token · ~$0.008 · 3.0s",
		);
	});
});
