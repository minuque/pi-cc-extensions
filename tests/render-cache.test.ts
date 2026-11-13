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
import { formatToolInputBody } from "../extensions/renderer/tool/tool-io.ts";
import { toolViewportWidth } from "../extensions/renderer/tool/result.ts";

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
		// 第 0 行是 " ├ Input"，Input 正文到 " └ Output" 为止
		const inputRows = rendered
			.slice(1, rendered.indexOf(" └ Output", 1))
			.map((line) => line.slice(rail.length));
		assert.deepEqual(inputRows, legacyRows(body), `${label} 的 Input 折行应与改动前一致`);
	}
});
