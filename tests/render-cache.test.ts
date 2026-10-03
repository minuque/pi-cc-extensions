import assert from "node:assert/strict";
import test from "node:test";
import {
	ExpandedToolIoView,
	ExpandedToolResultText,
	formatToolInputArgs,
	SHOW_MORE_LABEL,
} from "../extensions/renderer/index.ts";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { formatToolInputBody, toolViewportWidth } from "../extensions/renderer/tool/result.ts";

// cli-highlight 打底要读全局主题；正式运行由 pi 初始化
initTheme("dark");

function expectedExpandedLines(text: string, prefix: string, width: number): string[] {
	const normalized = text.replace(/\t/g, "   ").replace(/\n+$/, "");
	const contentWidth = Math.max(1, width - visibleWidth(prefix));
	return wrapTextWithAnsi(normalized, contentWidth).map((line) =>
		truncateToWidth(prefix + line, width, ""),
	);
}

test("ExpandedToolResultText preserves lines while caching one width", () => {
	const text = "\x1b[31mfirst\tline with enough content to wrap\nsecond\n\n";
	const prefix = "\x1b[31m  │ \x1b[0m";
	const component = new ExpandedToolResultText(text, prefix);

	const wide = component.render(24);
	assert.deepEqual(wide, expectedExpandedLines(text, prefix, 24));
	assert.strictEqual(component.render(24), wide);

	const narrow = component.render(12);
	assert.deepEqual(narrow, expectedExpandedLines(text, prefix, 12));
	assert.notStrictEqual(narrow, wide);

	const wideAgain = component.render(24);
	assert.deepEqual(wideAgain, expectedExpandedLines(text, prefix, 24));
	assert.notStrictEqual(wideAgain, wide, "only the most recent width is cached");

	component.invalidate();
	const afterInvalidate = component.render(24);
	assert.deepEqual(afterInvalidate, expectedExpandedLines(text, prefix, 24));
	assert.notStrictEqual(afterInvalidate, wideAgain);

	const changedText = "updated\tcontent\n";
	component.setText(changedText);
	assert.deepEqual(component.render(24), expectedExpandedLines(changedText, prefix, 24));
});

test("formatToolInputArgs pretty-prints object fields and multiline values", () => {
	assert.equal(formatToolInputArgs(null), "");
	assert.equal(formatToolInputArgs({ path: "a.ts", limit: 10 }), "path: a.ts\nlimit: 10");
	assert.equal(
		formatToolInputArgs({ command: "echo hi\necho bye" }),
		"command:\n  echo hi\n  echo bye",
	);
	assert.match(formatToolInputArgs({ nested: { a: 1 } }), /nested:/);
});

test("formatToolInputBody：单独的 code 省略标签并标记代码块，截断时不标记", () => {
	const { text, codeBlock } = formatToolInputBody({
		code: 'const a = 1\n  if (a) return "x"',
	});
	// 只有一个 code 字段：整块 Input 就是脚本，不带 `code:` 标签
	assert.equal(text, '  const a = 1\n    if (a) return "x"');
	assert.deepEqual(codeBlock, {
		startLine: 0,
		language: "javascript",
		// 行首缩进交给排版，着色只喂剥掉缩进的正文
		code: 'const a = 1\nif (a) return "x"',
		standalone: true,
	});
	// 有别的字段时保留标签，也不再算整段代码
	const withPath = formatToolInputBody({ path: "a.ts", code: "const a = 1\nreturn a" });
	assert.match(withPath.text, /^path: a\.ts\ncode:\n/);
	assert.equal(withPath.codeBlock?.startLine, 2);
	assert.equal(withPath.codeBlock?.standalone, false);
	// 其他字段不登记
	assert.equal(formatToolInputBody({ command: "echo hi\necho bye" }).codeBlock, undefined);
	// 正文截断后行号对不上，只给纯文本
	const huge = formatToolInputBody({ code: `${"x".repeat(9000)}\nmore` });
	assert.ok(huge.text.endsWith("…"));
	assert.equal(huge.codeBlock, undefined);
});

test("展开卡 Input：代码块语法着色，折行续行跟着源码缩进", () => {
	const theme = { fg: (_color: string, text: string) => text };
	const code =
		'const a = await tools.bash({ command: "npx biome check extensions/ tests/ 2>&1 | tail -2" })\n  if (a) return "x"';
	const { text, codeBlock } = formatToolInputBody({ code });
	const view = new ExpandedToolIoView(theme, text, "", false, 5, 5);
	view.setInputCode(codeBlock);
	const rows = view.render(60).map((line) => line.trimEnd());

	// Input 里没有 code: 标签，代码从第一行开始；折行续行与块内缩进对齐
	const plain = rows.map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));
	assert.equal(plain[0], " ├ Input");
	assert.equal(plain[1], ' │   const a = await tools.bash({ command: "npx');
	assert.equal(plain[2], " │   biome check extensions/ tests/ 2>&1 | tail");
	assert.equal(plain[3], ' │   -2" })');
	// 行自身缩进叠在块缩进之上
	assert.equal(plain[4], ' │     if (a) return "x"');
	assert.ok(!plain.some((line) => line.includes("code:")), "不再显示 code: 标签");

	// 代码行按语法上色（打底用 cli-highlight 的语法色），不再整行单色
	const spans = new Set(rows[1]!.match(/\x1b\[38;2;\d+;\d+;\d+m/g) ?? []);
	assert.ok(spans.size > 1, `代码行应有多种语法色: ${[...spans].join(" ")}`);

	// 全量预览用：整段就是代码时给出围栏信息
	assert.deepEqual(view.getInputCodeFence(), {
		language: "javascript",
		code: 'const a = await tools.bash({ command: "npx biome check extensions/ tests/ 2>&1 | tail -2" })\nif (a) return "x"',
	});
	// 混了别的字段（`code:` 标签还在）时不给围栏，免得把非代码内容一起塞进代码块
	const mixed = formatToolInputBody({ path: "a.ts", code: "const a = 1\nreturn a" });
	const mixedView = new ExpandedToolIoView(theme, mixed.text, "", false, 5, 5);
	mixedView.setInputCode(mixed.codeBlock);
	assert.equal(mixedView.getInputCodeFence(), undefined);
});

test("其他工具的 Input 折行与改动前逐行一致（新排版只给 codemode 代码块）", () => {
	const theme = { fg: (_color: string, text: string) => text };
	const width = 80;
	const rail = " │ ";
	const contentWidth = toolViewportWidth(width) - visibleWidth(rail);
	// 改动前的规则：整行套色后按内容宽折行，续行不额外缩进
	const legacyRows = (body: string) => {
		const rows: string[] = [];
		for (const source of body.replace(/\t/g, "   ").replace(/\n+$/, "").split("\n")) {
			const parts = wrapTextWithAnsi(source, contentWidth);
			rows.push(...(parts.length ? parts : [source]));
		}
		return rows;
	};
	const cases: Array<[string, string]> = [
		["write 缩进正文", `path: a.ts\ncontent:\n  ${"const x = 1; // ".repeat(8)}`],
		["edit 两个字符串", `path: a.ts\nnew_string:\n      ${"return foo(bar); ".repeat(6)}`],
		["bash 多行命令", "command:\n  npm test\n  echo done"],
		["read 长值无缩进", `path:\n${"x".repeat(200)}`],
		["混合缩进", `content:\n        deep = ${"y".repeat(80)}\n  shallow`],
	];
	for (const [label, body] of cases) {
		const view = new ExpandedToolIoView(theme, body, "", false, 40, 40);
		const rendered = view
			.render(width)
			.map((line) => line.replace(/\x1b\[[0-9;]*m/g, "").trimEnd());
		// 第 0 行是 " ├ Input"，Input 正文到空 rail 行为止
		const inputRows = rendered
			.slice(1, rendered.indexOf(" │", 1))
			.map((line) => line.slice(rail.length));
		assert.deepEqual(inputRows, legacyRows(body), `${label} 的 Input 折行应与改动前一致`);
	}
});

test("ExpandedToolIoView labels Input and Output sections", () => {
	const styled: Array<[string, string]> = [];
	const theme = {
		fg(color: string, text: string) {
			styled.push([color, text]);
			return text;
		},
		bold(text: string) {
			return text;
		},
	};
	const view = new ExpandedToolIoView(theme, "path: src/a.ts", "line one\nline two", false, 4000);
	const lines = view.render(60).map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));
	assert.ok(lines.some((line) => /^ ├ Input/.test(line)));
	assert.ok(lines.some((line) => /^ └ Output/.test(line)));
	assert.ok(lines.some((line) => line.includes("path: src/a.ts")));
	assert.ok(styled.some(([color, text]) => color === "muted" && text === "src/a.ts"));
	assert.ok(!styled.some(([color, text]) => color === "text" && text === "src/a.ts"));
	assert.ok(lines.some((line) => line.includes("line one")));
	assert.ok(lines.some((line) => line.includes("line two")));
	assert.ok(
		lines
			.filter((line) => line.includes("line one") || line.includes("line two"))
			.every((line) => !line.includes("│")),
		"output body stops the inner tree rail",
	);
	// Tree rail between sections.
	assert.ok(lines.some((line) => line.trim() === "│"));
	// Short bodies stay fully visible — no show-more affordance.
	assert.ok(!lines.some((line) => line.includes(SHOW_MORE_LABEL)));

	// Reuse path updates content without changing identity.
	view.setContent("path: b.ts", "only", false, 4000);
	const updated = view.render(60).map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));
	assert.ok(updated.some((line) => line.includes("path: b.ts")));
	assert.ok(updated.some((line) => line.includes("only")));
	assert.ok(!updated.some((line) => line.includes("line one")));
});

test("ExpandedToolIoView wraps Input/Output at 80% of the viewport", () => {
	const theme = {
		fg(_color: string, text: string) {
			return text;
		},
		bold(text: string) {
			return text;
		},
	};
	const body = "x".repeat(79);
	const view = new ExpandedToolIoView(theme, `command: ${body}`, body, false, 1, 1);
	const lines = view.render(100);
	assert.ok(lines.every((line) => visibleWidth(line) <= 80));
	assert.ok(
		lines.some((line) => line.includes("more lines") && line.includes(SHOW_MORE_LABEL)),
		"truncation footer carries show more",
	);
	assert.ok(!lines.find((line) => line.includes("Input"))?.includes(SHOW_MORE_LABEL));
	assert.ok(!lines.find((line) => line.includes("Output"))?.includes(SHOW_MORE_LABEL));
});

test("ExpandedToolIoView shows click to show more when Input/Output exceed the line cap", () => {
	const theme = {
		fg(color: string, text: string) {
			if (color === "text") return `\x1b[37m${text}\x1b[39m`;
			if (color === "dim") return `\x1b[90m${text}\x1b[39m`;
			return text;
		},
		bold(text: string) {
			return text;
		},
	};
	const longOutput = Array.from({ length: 20 }, (_, i) => `out line ${i}`).join("\n");
	const longInput = Array.from({ length: 20 }, (_, i) => `field${i}: value${i}`).join("\n");
	const view = new ExpandedToolIoView(theme, longInput, longOutput, false, 5, 5);
	const rawLines = view.render(80);
	const lines = rawLines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));
	const inputFooter = lines.find((line) => line.includes("│") && line.includes("more lines"));
	const outputFooter = lines.find(
		(line) => !line.includes("│") && line.includes("more lines") && line.includes(SHOW_MORE_LABEL),
	);
	assert.ok(inputFooter?.includes(SHOW_MORE_LABEL), "Input truncation footer shows show more");
	assert.ok(outputFooter?.includes(SHOW_MORE_LABEL), "Output truncation footer shows show more");
	assert.equal(view.matchShowMoreLine(inputFooter!), "input");
	assert.equal(view.matchShowMoreLine(outputFooter!), "output");
	assert.ok(!lines.find((line) => line.includes("Input"))?.includes(SHOW_MORE_LABEL));
	view.setHoveredSection("input");
	const hoveredInput = view
		.render(80)
		.find((line) => line.includes("│") && line.includes("more lines"));
	const hoveredOutput = view
		.render(80)
		.find((line) => !line.includes("│") && line.includes("more lines"));
	assert.ok(
		hoveredInput?.includes(`\x1b[90m ·\x1b[39m\x1b[37m click to show more\x1b[39m`),
		"hover keeps the bullet dim and highlights only the text",
	);
	assert.ok(hoveredOutput?.includes(`\x1b[90m ·\x1b[39m\x1b[90m click to show more\x1b[39m`));
});

test("ExpandedToolIoView records exact show-more header rows, not body text", () => {
	const theme = {
		fg(_color: string, text: string) {
			return text;
		},
		bold(text: string) {
			return text;
		},
	};
	// Body text that would false-positive a whole-buffer Input/show-more scan.
	const decoy = `note Input ${SHOW_MORE_LABEL}\n${Array.from({ length: 12 }, (_, i) => `out ${i}`).join("\n")}`;
	const view = new ExpandedToolIoView(theme, "", decoy, false, 3, 3);
	const lines = view.render(80);
	const headers = view.showMoreHeaderLineIndexes();
	assert.equal(headers.length, 1);
	assert.equal(headers[0]?.section, "output");
	assert.ok(
		(headers[0]?.line ?? -1) > 0,
		"show-more sits on the truncation footer, not the header",
	);
	const decoyRow = lines.findIndex(
		(line, index) => index > 0 && line.includes("Input") && line.includes(SHOW_MORE_LABEL),
	);
	assert.ok(decoyRow > 0, "body still paints the decoy text");
	assert.ok(!headers.some((h) => h.line === decoyRow));
});
