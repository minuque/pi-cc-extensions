import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// 必须在导入 config 之前隔离 agent 目录：updateConfig 会把配置写回磁盘。
process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "ccstyle-panel-"));

const { config } = await import("../extensions/config/config.ts");
const { initTheme } = await import("@earendil-works/pi-coding-agent");
const { showCcstylePanel } = await import("../extensions/config/panel.ts");
const { applyPromptEditor, clearPromptEditor } = await import(
	"../extensions/feature/shell/prompt-editor.ts"
);

// 面板构造 SettingsList 时要取主题；测试不渲染，只要求主题已初始化。
initTheme("dark");

type EditorFactory = (tui: unknown, theme: unknown, keybindings: unknown) => unknown;

type Panel = { handleInput(data: string): void };

/**
 * `ui` 复刻 pi 1.5 的关键副作用：对话框开着时 `setEditorComponent` 只排队，
 * 等对话框关闭后才落到插槽里（issue #11431），期间 `getEditorComponent()` 仍是旧工厂。
 */
function fakePanelUi() {
	let factory: EditorFactory | undefined;
	let queued: { next: EditorFactory | undefined } | undefined;
	let dialogOpen = false;
	let panel: Panel | undefined;
	const swaps: (EditorFactory | undefined)[] = [];
	const notices: string[] = [];

	const flushQueued = () => {
		if (!queued) return;
		factory = queued.next;
		queued = undefined;
	};

	const custom = (
		build: (tui: unknown, theme: unknown, keybindings: unknown, done: () => void) => Panel,
	) =>
		new Promise<void>((resolve) => {
			const done = () => {
				dialogOpen = false;
				flushQueued();
				resolve();
			};
			dialogOpen = true;
			panel = build({ requestRender: () => {} }, {}, {}, done);
		});

	const ui = {
		getEditorComponent: () => factory,
		setEditorComponent: (next: EditorFactory | undefined) => {
			swaps.push(next);
			if (dialogOpen) queued = { next };
			else factory = next;
		},
		notify: (message: string) => notices.push(message),
		custom,
	};

	return {
		ctx: { mode: "tui", hasUI: true, ui },
		notices,
		swaps,
		get panel(): Panel {
			assert.ok(panel, "panel was never built");
			return panel;
		},
	};
}

const hooks = { applyStyleMode: () => {}, refreshCurrentTranscript: () => {} };

/** 从 Style 页签走到 UI 页签的 Editor prefix 行。 */
function selectEditorPrefixRow(panel: Panel): void {
	panel.handleInput("\t");
	panel.handleInput("\t");
	for (let i = 0; i < 7; i++) panel.handleInput("\x1b[B");
}

test("toggling Editor prefix applies right away and the swap lands after close", async () => {
	const slot = fakePanelUi();
	const { ctx, notices, swaps } = slot;
	config.enableEditorPrefix = false;

	const closePanel = showCcstylePanel(ctx, hooks);
	const panel = slot.panel;
	selectEditorPrefixRow(panel);
	panel.handleInput("\r");

	assert.equal(config.enableEditorPrefix, true);
	assert.ok(notices.includes("Updated enableEditorPrefix: on"));
	assert.equal(swaps.length, 1, "切换后立刻请求替换编辑器");
	assert.equal(typeof swaps[0], "function");
	assert.equal(ctx.ui.getEditorComponent(), undefined, "pi 把替换排到对话框关闭后");
	assert.ok(panel, "面板还在");

	panel.handleInput("\x1b");
	await closePanel;

	assert.equal(ctx.ui.getEditorComponent(), swaps[0]);

	// 再应用一次不许重建编辑器实例。
	applyPromptEditor(ctx as never);
	assert.equal(swaps.length, 1);
	assert.equal(ctx.ui.getEditorComponent(), swaps[0]);
});

test("toggling Editor prefix off restores the editor captured on enable", async () => {
	const otherFactory: EditorFactory = () => ({});
	const slot = fakePanelUi();
	const { ctx, swaps } = slot;

	// 上一段的占用先撤干净。
	config.enableEditorPrefix = false;
	clearPromptEditor(ctx as never);
	assert.equal(ctx.ui.getEditorComponent(), undefined);

	// 别的扩展占着插槽，本扩展开启后再关闭，必须把它原样还回去。
	ctx.ui.setEditorComponent(otherFactory);
	config.enableEditorPrefix = true;
	applyPromptEditor(ctx as never);
	assert.notEqual(ctx.ui.getEditorComponent(), otherFactory);
	swaps.length = 0;

	const closePanel = showCcstylePanel(ctx, hooks);
	const panel = slot.panel;
	selectEditorPrefixRow(panel);
	panel.handleInput("\r");

	assert.equal(config.enableEditorPrefix, false);
	assert.equal(swaps.length, 1, "关闭时立刻请求还回原工厂");

	panel.handleInput("\x1b");
	await closePanel;

	assert.equal(ctx.ui.getEditorComponent(), otherFactory);
});

test("面板里连续开关：以最后一次选择为准", async () => {
	const otherFactory: EditorFactory = () => ({});
	const slot = fakePanelUi();
	const { ctx } = slot;

	ctx.ui.setEditorComponent(otherFactory);
	config.enableEditorPrefix = false;
	clearPromptEditor(ctx as never);
	assert.equal(ctx.ui.getEditorComponent(), otherFactory);

	const closePanel = showCcstylePanel(ctx, hooks);
	const panel = slot.panel;
	selectEditorPrefixRow(panel);
	panel.handleInput("\r");
	assert.equal(config.enableEditorPrefix, true);
	// 再切一次关掉：pi 还没把 ❯ 编辑器落进插槽，也要能把原工厂还回去。
	panel.handleInput("\r");
	assert.equal(config.enableEditorPrefix, false);

	panel.handleInput("\x1b");
	await closePanel;

	assert.equal(ctx.ui.getEditorComponent(), otherFactory);
});
