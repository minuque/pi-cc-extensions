import assert from "node:assert/strict";
import test from "node:test";
import { ToolExecutionComponent, initTheme } from "@earendil-works/pi-coding-agent";

import { config } from "../extensions/config/config.ts";
import { installDefaultMode } from "../extensions/renderer/default-mode.ts";
import { formatToolDuration } from "../extensions/renderer/tool/result.ts";
import { WriteExecutionMetadataStore } from "../extensions/renderer/tool/diff/index.ts";
import { TOOL_LOADING_INTERVAL_MS } from "../extensions/utils/tool-loading-icon.ts";

initTheme("dark");

const theme = { fg: (_color: string, text: string) => text } as any;
const stripAnsi = (value: string) => value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");

function toolUi() {
	return { theme, requestRender() {}, setStatus() {} } as any;
}

function shellTool(name: string, id: string, args: Record<string, unknown> = {}) {
	return new ToolExecutionComponent(name, id, args, {}, undefined, toolUi(), process.cwd()) as any;
}

function render(component: any, width = 100): string[] {
	return component.render(width).map(stripAnsi).filter(Boolean);
}

test("耗时格式：毫秒、秒、分、时", () => {
	assert.equal(formatToolDuration(0), "0ms");
	assert.equal(formatToolDuration(31), "31ms");
	assert.equal(formatToolDuration(999), "999ms");
	assert.equal(formatToolDuration(1234.5), "1.2s");
	assert.equal(formatToolDuration(59_400), "59.4s");
	// 分钟级不能再显示成 "300.0s"
	assert.equal(formatToolDuration(300_000), "5m 0s");
	assert.equal(formatToolDuration(3_723_000), "1h 2m 3s");
});

test("完成态：优先用 Pi 记录的 durationMs", () => {
	const previousMode = config.mode;
	const originalNow = Date.now;
	let now = 1_000;
	Date.now = () => now;
	config.mode = "on";
	const hooks = installDefaultMode(new WriteExecutionMetadataStore());
	try {
		const tool = shellTool("bash", "sh-recorded", { command: "npm test" });
		tool.markExecutionStarted();
		tool.render(100); // 时钟会算出 250ms
		now = 1_250;
		// Pi 1.1.0 起把 durationMs 附在结果上（interactive-mode 的 tool_execution_end）
		tool.updateResult({
			content: [{ type: "text", text: "a\nb\nc" }],
			isError: false,
			durationMs: 1234,
		});
		const lines = render(tool);
		assert.match(lines[0]!, /Bash npm test/);
		// 用记录值 1.2s，而不是时钟的 250ms
		assert.match(lines[1]!, /3 lines returned · 1\.2s · .*to show more$/);
	} finally {
		Date.now = originalNow;
		hooks.shutdown();
		config.mode = previousMode;
	}
});

test("完成态：没有 durationMs 时用渲染器自己的时钟", () => {
	const previousMode = config.mode;
	const originalNow = Date.now;
	let now = 5_000;
	Date.now = () => now;
	config.mode = "on";
	const hooks = installDefaultMode(new WriteExecutionMetadataStore());
	try {
		const tool = shellTool("bash", "sh-clock", { command: "npm test" });
		tool.markExecutionStarted();
		tool.render(100); // renderCall 记下开始时间
		now = 6_234;
		tool.updateResult({ content: [{ type: "text", text: "a\nb\nc" }], isError: false });
		assert.match(render(tool)[1]!, /3 lines returned · 1\.2s · .*to show more$/);
	} finally {
		Date.now = originalNow;
		hooks.shutdown();
		config.mode = previousMode;
	}
});

test("运行中：shell 报已用时间，并且随动画 tick 更新", async () => {
	const previousMode = config.mode;
	const originalNow = Date.now;
	let now = 1_000;
	Date.now = () => now;
	config.mode = "on";
	const hooks = installDefaultMode(new WriteExecutionMetadataStore());
	try {
		const tool = shellTool("bash", "sh-run", { command: "sleep 5" });
		tool.markExecutionStarted();
		tool.render(100); // renderCall 记下开始时间
		tool.updateResult({ content: [], isError: false }, true);

		assert.match(render(tool)[1]!, /Pending… · 0ms · .*to show more$/, "刚开跑报 0ms");

		now = 1_000 + TOOL_LOADING_INTERVAL_MS;
		assert.match(render(tool)[1]!, /Pending… · 80ms · .*to show more$/, "时间推进后数字要跟着变");

		now = 1_000 + 4_000;
		assert.match(render(tool)[1]!, /Pending… · 4\.0s · .*to show more$/);
	} finally {
		Date.now = originalNow;
		hooks.shutdown();
		config.mode = previousMode;
	}
});

test("时钟回拨不输出负数", () => {
	const previousMode = config.mode;
	const originalNow = Date.now;
	Date.now = () => 5_000;
	config.mode = "on";
	const hooks = installDefaultMode(new WriteExecutionMetadataStore());
	try {
		const tool = shellTool("bash", "sh-clock-back", { command: "ls" });
		tool.markExecutionStarted();
		tool.render(100); // 开始时间 = 5000
		tool.updateResult({ content: [], isError: false }, true);
		Date.now = () => 0; // 回拨
		assert.match(render(tool)[1]!, /Pending… · 0ms · .*to show more$/);
	} finally {
		Date.now = originalNow;
		hooks.shutdown();
		config.mode = previousMode;
	}
});

test("非 shell 工具不报耗时", () => {
	const previousMode = config.mode;
	config.mode = "on";
	const hooks = installDefaultMode(new WriteExecutionMetadataStore());
	try {
		const tool = shellTool("read", "rd-1", { path: "a.ts" });
		tool.markExecutionStarted();
		tool.render(100);
		tool.updateResult({
			content: [{ type: "text", text: "a\nb" }],
			isError: false,
			durationMs: 1234,
		});
		assert.doesNotMatch(render(tool)[1]!, /\d+(\.\d+)?(ms|s)\b/);
	} finally {
		hooks.shutdown();
		config.mode = previousMode;
	}
});

test("restore 出来的行没跑过，不报耗时", () => {
	const previousMode = config.mode;
	config.mode = "on";
	const hooks = installDefaultMode(new WriteExecutionMetadataStore());
	try {
		const tool = shellTool("bash", "sh-restored", { command: "ls" });
		// 不调 markExecutionStarted：模拟从会话恢复
		tool.updateResult({ content: [{ type: "text", text: "a" }], isError: false });
		assert.doesNotMatch(render(tool)[1]!, /\d+(\.\d+)?(ms|s)\b/);
	} finally {
		hooks.shutdown();
		config.mode = previousMode;
	}
});

test("restore 的行若带 durationMs，照旧报耗时", () => {
	const previousMode = config.mode;
	config.mode = "on";
	const hooks = installDefaultMode(new WriteExecutionMetadataStore());
	try {
		const tool = shellTool("bash", "sh-restored-2", { command: "ls" });
		// 不调 markExecutionStarted：模拟从会话恢复，但结果里带了 Pi 记录的耗时
		tool.updateResult({
			content: [{ type: "text", text: "a" }],
			isError: false,
			durationMs: 2_500,
		});
		assert.match(render(tool)[1]!, /2\.5s/);
	} finally {
		hooks.shutdown();
		config.mode = previousMode;
	}
});

test("展开态：Output 截断时，耗时接在 show-more 行上、提示前", () => {
	const previousMode = config.mode;
	config.mode = "on";
	const hooks = installDefaultMode(new WriteExecutionMetadataStore());
	try {
		const tool = shellTool("bash", "sh-expanded-trunc", { command: "npm test" });
		tool.markExecutionStarted();
		tool.render(100);
		tool.setExpanded(true);
		// 默认 expandedOutputMaxLines = 10，给 40 行必然截断
		const output = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join("\n");
		tool.updateResult({
			content: [{ type: "text", text: output }],
			isError: false,
			durationMs: 29_500,
		});
		const lines = render(tool)
			.map((l) => l.replace(/\s+$/g, ""))
			.filter(Boolean);
		const footer = lines.find((l: string) => /more lines/.test(l))!;
		assert.match(
			footer,
			/^\s*… 30 more lines · 29\.5s · .*to show more$/,
			`耗时应在按钮前、计数不带 +: ${JSON.stringify(footer)}`,
		);
		// 不再单独占一行
		assert.equal(
			lines.some((l: string) => /^\s*(Took )?\d+(\.\d+)?(ms|s)$/.test(l)),
			false,
			`耗时不另起一行: ${JSON.stringify(lines.slice(-3))}`,
		);
	} finally {
		hooks.shutdown();
		config.mode = previousMode;
	}
});

test("展开态：Output 未截断时，耗时单独成行", () => {
	const previousMode = config.mode;
	config.mode = "on";
	const hooks = installDefaultMode(new WriteExecutionMetadataStore());
	try {
		const tool = shellTool("bash", "sh-expanded-short", { command: "npm test" });
		tool.markExecutionStarted();
		tool.render(100);
		tool.setExpanded(true);
		tool.updateResult({
			content: [{ type: "text", text: "pass 367" }],
			isError: false,
			durationMs: 1234,
		});
		// 展开卡会右补到整宽，去掉行尾空格再断言。
		const lines = render(tool)
			.map((l) => l.replace(/\s+$/g, ""))
			.filter(Boolean);
		assert.ok(
			lines.some((l: string) => /^\s*└ Output$/.test(l)),
			`应有 Output 段: ${JSON.stringify(lines)}`,
		);
		assert.ok(
			lines.some((l: string) => /pass 367/.test(l)),
			"Output 正文应在",
		);
		// 与折叠态同一写法：裸值
		assert.match(lines.at(-1)!, /^\s*1\.2s$/, `耗时应是最后一行: ${JSON.stringify(lines.at(-3))}`);
	} finally {
		hooks.shutdown();
		config.mode = previousMode;
	}
});

test("展开态：非 shell 不加尾部行", () => {
	const previousMode = config.mode;
	config.mode = "on";
	const hooks = installDefaultMode(new WriteExecutionMetadataStore());
	try {
		const tool = shellTool("read", "rd-expanded", { path: "a.ts" });
		tool.markExecutionStarted();
		tool.render(100);
		tool.setExpanded(true);
		tool.updateResult({
			content: [{ type: "text", text: "contents" }],
			isError: false,
			durationMs: 1234,
		});
		const lines = render(tool).map((l) => l.replace(/\s+$/g, ""));
		assert.equal(
			lines.some((l: string) => /1\.2s/.test(l)),
			false,
			`不该有耗时行: ${JSON.stringify(lines)}`,
		);
	} finally {
		hooks.shutdown();
		config.mode = previousMode;
	}
});

test("powershell 与 pwsh 同样报耗时", () => {
	const previousMode = config.mode;
	const originalNow = Date.now;
	let now = 1_000;
	Date.now = () => now;
	config.mode = "on";
	const hooks = installDefaultMode(new WriteExecutionMetadataStore());
	try {
		for (const name of ["powershell", "pwsh"]) {
			const tool = shellTool(name, `sh-${name}`, { command: "Get-Date" });
			tool.markExecutionStarted();
			tool.render(100);
			now += 250;
			tool.updateResult({ content: [{ type: "text", text: "now" }], isError: false });
			assert.match(render(tool)[1]!, /250ms/, `${name} 应报耗时`);
		}
	} finally {
		Date.now = originalNow;
		hooks.shutdown();
		config.mode = previousMode;
	}
});
