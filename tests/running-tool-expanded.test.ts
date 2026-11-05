import assert from "node:assert/strict";
import test from "node:test";
import { ToolExecutionComponent, initTheme } from "@earendil-works/pi-coding-agent";

import { config } from "../extensions/config/config.ts";
import { installDefaultMode } from "../extensions/renderer/default-mode.ts";
import { collapsedHintHitbox } from "../extensions/renderer/mouse/layout.ts";
import { WriteExecutionMetadataStore } from "../extensions/renderer/tool/diff/index.ts";
import { TOOL_LOADING_INTERVAL_MS } from "../extensions/utils/tool-loading-icon.ts";

initTheme("dark");

const theme = { fg: (_color: string, text: string) => text } as any;
const stripAnsi = (value: string) => value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");

function toolUi() {
	return { theme, requestRender() {}, setStatus() {} } as any;
}

function makeTool(name: string, id: string, args: Record<string, unknown> = {}) {
	return new ToolExecutionComponent(name, id, args, {}, undefined, toolUi(), process.cwd()) as any;
}

/** 展开卡整块带底色，空行只有 ANSI 与空格：按剥色后的内容判空。 */
function rawLines(component: any, width = 100): string[] {
	return component.render(width).filter((line: string) => stripAnsi(line).trim().length > 0);
}

function render(component: any, width = 100): string[] {
	return rawLines(component, width).map((line: string) => stripAnsi(line).replace(/\s+$/, ""));
}

function runInMode(body: () => void): void {
	const previousMode = config.mode;
	config.mode = "on";
	const hooks = installDefaultMode(new WriteExecutionMetadataStore());
	try {
		body();
	} finally {
		hooks.shutdown();
		config.mode = previousMode;
	}
}

test("运行中折叠行：耗时后面带展开提示，提示是可点击区域", () => {
	const originalNow = Date.now;
	let now = 1_000;
	Date.now = () => now;
	try {
		runInMode(() => {
			const tool = makeTool("bash", "rc-bash", { command: "sleep 5" });
			tool.markExecutionStarted();
			tool.render(100);
			tool.updateResult({ content: [], isError: false }, true);

			const line = rawLines(tool)[1] as string;
			assert.match(stripAnsi(line), /Pending… · 0ms · .*to show more$/);
			// 鼠标层只认行尾提示：命中区间必须存在，否则这行点不动。
			const hit = collapsedHintHitbox(line);
			assert.ok(hit, `提示应可点击: ${JSON.stringify(stripAnsi(line))}`);
			assert.ok(hit.endCol > hit.startCol);
		});
	} finally {
		Date.now = originalNow;
	}
});

test("运行中展开：Input 是完整命令，没有输出时 Output 报 Pending…", () => {
	runInMode(() => {
		const tool = makeTool("bash", "rc-empty-output", {
			command: "ssh prod docker exec -it api timeout 300 ./scripts/deploy.sh",
		});
		tool.markExecutionStarted();
		tool.render(100);
		tool.setExpanded(true);
		tool.updateResult({ content: [], isError: false }, true);

		const lines = render(tool);
		assert.ok(
			lines.some((line: string) => /^\s*├ Input$/.test(line)),
			`应有 Input 段: ${JSON.stringify(lines)}`,
		);
		assert.ok(
			lines.some((line: string) =>
				line.includes("command: ssh prod docker exec -it api timeout 300 ./scripts/deploy.sh"),
			),
			`命令全文应在: ${JSON.stringify(lines)}`,
		);
		assert.ok(lines.some((line: string) => /^\s*└ Output$/.test(line)));
		assert.ok(
			lines.some((line: string) => /^\s*Pending…$/.test(line)),
			`没输出时用 Pending… 占位: ${JSON.stringify(lines)}`,
		);
		assert.equal(
			lines.some((line: string) => /Done/.test(line)),
			false,
			"运行中不能显示 Done",
		);
	});
});

test("运行中展开：已产生的输出可见，耗时随动画 tick 更新", () => {
	const originalNow = Date.now;
	let now = 1_000;
	Date.now = () => now;
	try {
		runInMode(() => {
			const tool = makeTool("bash", "rc-live-output", { command: "make build" });
			tool.markExecutionStarted();
			tool.render(100);
			tool.setExpanded(true);
			tool.updateResult(
				{ content: [{ type: "text", text: "compiling a.ts" }], isError: false },
				true,
			);

			const first = render(tool);
			assert.ok(first.some((line: string) => line.includes("compiling a.ts")));
			assert.match(first.at(-1)!, /^\s*0ms$/, `耗时应在尾部: ${JSON.stringify(first)}`);

			now = 1_000 + TOOL_LOADING_INTERVAL_MS;
			const second = render(tool);
			assert.match(second.at(-1)!, /^\s*80ms$/, "时间推进后尾部要变");

			now = 1_000 + 3_000;
			tool.updateResult(
				{ content: [{ type: "text", text: "compiling a.ts\ncompiling b.ts" }], isError: false },
				true,
			);
			const third = render(tool);
			assert.ok(third.some((line: string) => line.includes("compiling b.ts")));
			assert.match(third.at(-1)!, /^\s*3\.0s$/);
		});
	} finally {
		Date.now = originalNow;
	}
});

test("运行中展开：耗时挂在输出截断的 show-more 行上", () => {
	runInMode(() => {
		const tool = makeTool("bash", "rc-truncated", { command: "make build" });
		tool.markExecutionStarted();
		tool.render(100);
		tool.setExpanded(true);
		// 默认 expandedOutputMaxLines = 10
		const output = Array.from({ length: 30 }, (_, index) => `line ${index + 1}`).join("\n");
		tool.updateResult({ content: [{ type: "text", text: output }], isError: false }, true);

		const lines = render(tool);
		const footer = lines.find((line: string) => /more lines/.test(line));
		assert.ok(footer, `应有截断提示: ${JSON.stringify(lines)}`);
		assert.match(footer!, /… 20 more lines · \d+(ms|\.[0-9]s|[0-9]+m [0-9]+s) · .*to show more$/);
	});
});

test("非 shell 工具运行中也能展开，Input 带完整入参", () => {
	runInMode(() => {
		const tool = makeTool("read", "rc-read", { path: "src/a.ts", offset: 1, limit: 50 });
		tool.markExecutionStarted();
		tool.render(100);
		tool.updateResult({ content: [], isError: false }, true);

		// 没有耗时，但提示要在：不能只剩 Pending…
		const collapsed = render(tool)[1]!;
		assert.match(collapsed, /^\s*↳ Pending… · .*to show more$/);

		tool.setExpanded(true);
		const lines = render(tool);
		assert.ok(lines.some((line: string) => /^\s*├ Input$/.test(line)));
		assert.ok(lines.some((line: string) => line.includes("path: src/a.ts")));
		assert.ok(lines.some((line: string) => /^\s*Pending…$/.test(line)));
	});
});
