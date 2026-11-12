import { test } from "node:test";
import assert from "node:assert";
import { default as enhance } from "../extensions/renderer/markdown-enhance.ts";

const transformers: Array<(md: string, ctx?: object) => string> = [];
const transformerOptions: Array<{ messageTypes?: readonly string[] } | undefined> = [];
enhance({
	registerMarkdownTransformer: (
		fn: (md: string, ctx?: object) => string,
		options?: { messageTypes?: readonly string[] },
	) => {
		transformers.push(fn);
		transformerOptions.push(options);
	},
} as never);
const run = (
	md: string,
	ctx = { messageType: "assistant", isStreaming: false, availableWidth: 100 },
) => transformers.reduce((acc, fn) => fn(acc, ctx), md);

test("mermaid 方言渲染", () => {
	assert.ok(run("```sequenceDiagram\nA->>B: hi\n```").includes("┌"));
	assert.ok(run("```stateDiagram-v2\n[*] --> S\n```").includes("╭"));
	assert.ok(run("```classDiagram\nclass A\n```").includes("┌"));
});

test("标准 mermaid 原样交给 pi 内置渲染器", () => {
	const md = "```mermaid\ngraph LR\nA --> B\n```";
	assert.strictEqual(run(md), md);
});

test("正文自带类型头不再补 fence 名", () => {
	for (const md of [
		"```sequencediagram\nsequenceDiagram\nA->>B: hi\n```",
		"```classdiagram\nclassDiagram\nclass A\n```",
		"```statediagram\nstateDiagram-v2\n[*] --> S\n```",
	]) {
		const out = run(md);
		assert.ok(!out.includes("```"), `退成源码框：${md}`);
		// 类型头被画成节点时，图里会出现它的字面量
		assert.ok(!out.includes("sequenceDiagram") && !out.includes("classDiagram"), out);
	}
});

test("四反引号围栏", () => {
	assert.ok(run("````sequenceDiagram\nA->>B: hi\n````").includes("┌"));
});

test("未闭合 fence 保留原文", () => {
	const out = run("```sequenceDiagram\nA->>B: hi");
	assert.ok(out.includes("```sequenceDiagram") && out.includes("A->>B: hi"));
});

test("图行硬换行", () => {
	const out = run("```sequenceDiagram\nA->>B: hi\n```");
	const lines = out.split("\n").filter((l) => l.startsWith("`┌") || l.includes("┌────"));
	assert.ok(lines.length >= 1, JSON.stringify(out.slice(0, 80)));
});

test("宽度不足框装", () => {
	const out = run("```erdiagram\nCUSTOMER ||--o{ ORDER : places\n```", {
		messageType: "assistant",
		isStreaming: false,
		availableWidth: 10,
	});
	assert.ok(out.includes("╭"));
});

test("流式跳过", () => {
	const md = "```sequenceDiagram\nA->>B: hi\n```";
	assert.strictEqual(
		run(md, { messageType: "assistant", isStreaming: true, availableWidth: 100 }),
		md,
	);
});

test("thinking 块不转换（与官方推荐一致）", () => {
	const md = "```sequenceDiagram\nA->>B: hi\n```\n\n圈数字 ①\n\n看 https://example.com";
	assert.strictEqual(
		run(md, { messageType: "assistant-thinking", isStreaming: false, availableWidth: 100 }),
		md,
	);
});

test("裸 URL 与提示框不接管，交给 pi 原生渲染", () => {
	assert.strictEqual(
		run("访问 https://example.com/docs. 结束"),
		"访问 https://example.com/docs. 结束",
	);
	assert.strictEqual(run("> [!NOTE] 提示\n> 续行"), "> [!NOTE] 提示\n> 续行");
});

test("Pi 带颜色的 Mermaid 输出不被后面的链接吞掉（#84）", () => {
	const ESC = "\x1b[38;5;240m";
	const RST = "\x1b[0m";
	const md = [
		"Intro.",
		"",
		`\`${ESC}┌────┐${RST}\`  `,
		`\`${ESC}│ A  │${RST}\`  `,
		"",
		"Some paragraph.",
		"",
		"Another paragraph, then a [link](https://example.com).",
	].join("\n");
	const out = run(md);
	assert.deepStrictEqual(out.split("\n"), md.split("\n"), JSON.stringify(out));
});

test("流式跨行链接不产生空白 OSC 8 点击区", () => {
	const md = "前缀 [\n](https://example.com)\n```md\n[代码\n链接](https://code.example)\n```";
	const out = run(md, {
		messageType: "assistant",
		isStreaming: true,
		availableWidth: 100,
	});
	assert.ok(out.includes("前缀 [](https://example.com)"), JSON.stringify(out));
	assert.ok(out.includes("[代码\n链接](https://code.example)"), JSON.stringify(out));
});

test("自定义消息与 summary 也转换", () => {
	const ctx = { isStreaming: false, availableWidth: 100 };
	assert.strictEqual(run("方案②", { ...ctx, messageType: "custom" }), "方案(2)");
	assert.strictEqual(run("方案②", { ...ctx, messageType: "summary" }), "方案(2)");
});

test("注册时声明的作用面", () => {
	assert.deepStrictEqual(transformerOptions.at(-1)?.messageTypes, [
		"user",
		"assistant",
		"assistant-thinking",
		"custom",
		"summary",
	]);
});

test("圈数字转半角括号（Nerd Font 字形缺陷规避）", () => {
	assert.strictEqual(run("方案②引入，共⑩项"), "方案(2)引入，共(10)项");
	assert.ok(run("① ② ⑳").includes("(1) (2) (20)"));
});

test("引用块和长围栏里的代码不被改写", () => {
	const quoted = run("> ```ts\n> const n = ①\n> ```\nplain ①");
	assert.match(quoted, /> const n = ①/);
	assert.match(quoted, /plain \(1\)/);

	const longer = run("````\n```\nstill code ①\n````\nafter ①");
	assert.match(longer, /still code ①/);
	assert.match(longer, /after \(1\)/);

	const tilde = run("~~~\ncode ①\n~~~\nafter ①");
	assert.match(tilde, /code ①/);
	assert.match(tilde, /after \(1\)/);

	const indented = run("   ```\n  code ①\n   ```\nafter ①");
	assert.match(indented, /code ①/);
	assert.match(indented, /after \(1\)/);
});
