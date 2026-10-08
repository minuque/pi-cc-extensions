import assert from "node:assert/strict";
import test from "node:test";
import { config } from "../extensions/config/config.ts";
import {
	displayPath,
	formatDisplayPath,
	renderToolSummary,
	toolCallSummary,
} from "../extensions/renderer/tool/names.ts";
import { toolViewportWidth } from "../extensions/renderer/tool/result.ts";
import { formatDuration, oneLine } from "../extensions/utils/format.ts";

test("formatDuration formats elapsed seconds", () => {
	assert.equal(formatDuration(999), "");
	assert.equal(formatDuration(1_000), "1s");
	assert.equal(formatDuration(62_000), "1m 2s");
	assert.equal(formatDuration(3_721_000), "1h 2m 1s");
});

test("oneLine: 默认 max=96，超长截断加省略号", () => {
	const long = "x".repeat(120);
	const out = oneLine(long);
	assert.equal(out.length, 96);
	assert.equal(out.endsWith("…"), true);
	assert.equal(out, `${"x".repeat(95)}…`);
});

test("oneLine: 显式 max 覆盖默认；空白折叠为单行", () => {
	assert.equal(oneLine("a\n\tb  c", 10), "a b c");
	assert.equal(oneLine("hello world", 8), "hello w…");
	assert.equal(oneLine(null), "");
	assert.equal(oneLine(undefined), "");
});

test("oneLine: sanitize 上限 4096，避免扫超大输入", () => {
	// 超过 4096 的前缀被截断后再折叠；结果长度仍受 max 约束
	const huge = `${"y".repeat(5000)}\nmore`;
	const out = oneLine(huge, 20);
	assert.equal(out.length, 20);
	assert.equal(out.startsWith("y"), true);
});

test("displayPath / formatDisplayPath 保留 POSIX 与 Windows 原生分隔符", () => {
	assert.equal(displayPath("/home/user/project/src/file.ts", "/home/user/project"), "src/file.ts");
	assert.equal(
		displayPath("C:\\Users\\user\\project\\src\\file.ts", "C:\\Users\\user\\project"),
		"src\\file.ts",
	);

	// 工具卡摘要入口：截断走 lastIndexOf("/") / lastIndexOf("\\") 定位文件名，各保留原生分隔符
	const previous = config.toolLabelClip;
	try {
		config.toolLabelClip = 100;
		assert.equal(
			formatDisplayPath("/home/user/project/src/deep/file.ts", "/home/user/project", 12),
			"src…/file.ts",
		);
		assert.equal(
			formatDisplayPath(
				"C:\\Users\\user\\project\\src\\deep\\file.ts",
				"C:\\Users\\user\\project",
				12,
			),
			"src…\\file.ts",
		);
	} finally {
		config.toolLabelClip = previous;
	}
});

test("toolLabelClip=0 按可用宽度截断；正数仍是字符上限", () => {
	const previous = config.toolLabelClip;
	const command = `echo ${"x".repeat(300)}`;
	const plain = (_color: string, text: string) => text;
	try {
		config.toolLabelClip = 0;
		const summary = toolCallSummary("bash", { command }, { variant: "grouping" });
		assert.equal(summary.main, `Bash ${command}`, "摘要不预截断");
		const line = renderToolSummary(summary, 180, plain);
		assert.equal(line.length, 180, "宽屏铺满可用宽度");
		assert.equal(line.endsWith("…"), true);
		assert.equal(renderToolSummary(summary, 400, plain), `Bash ${command}`);
		const path = `/repo/${"deep/".repeat(60)}file.ts`;
		assert.equal(formatDisplayPath(path, undefined, 1000), path);

		config.toolLabelClip = 40;
		const clipped = renderToolSummary(
			toolCallSummary("bash", { command }, { variant: "grouping" }),
			180,
			plain,
		);
		assert.equal(clipped.length, "Bash ".length + 40);
	} finally {
		config.toolLabelClip = previous;
	}
});

test("toolViewportWidth: 窄屏按 80%，宽屏右侧留白封顶 24 列", () => {
	assert.equal(toolViewportWidth(1), 1);
	assert.equal(toolViewportWidth(80), 64);
	assert.equal(toolViewportWidth(120), 96, "临界点：比例与固定留白相等");
	assert.equal(toolViewportWidth(200), 176);
	assert.equal(toolViewportWidth(300), 276);
});
