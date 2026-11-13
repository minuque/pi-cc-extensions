import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { config } from "../extensions/config/config.ts";
import { applyPromptEditor, clearPromptEditor } from "../extensions/feature/shell/prompt-editor.ts";

type EditorFactory = (tui: unknown, theme: unknown, keybindings: unknown) => unknown;

/** Minimal UI stub: one editor slot plus a notification sink. */
function fakeEditorSlot() {
	let factory: EditorFactory | undefined;
	let installs = 0;
	return {
		ui: {
			getEditorComponent: () => factory,
			setEditorComponent: (next: EditorFactory | undefined) => {
				factory = next;
				installs++;
			},
			notify: () => {},
		},
		get factory() {
			return factory;
		},
		set factory(next: EditorFactory | undefined) {
			factory = next;
		},
		get installs() {
			return installs;
		},
	};
}

function useEditorPrefix(t: { after: (fn: () => void) => void }, enabled: boolean): void {
	const previous = config.enableEditorPrefix;
	t.after(() => {
		config.enableEditorPrefix = previous;
	});
	config.enableEditorPrefix = enabled;
}

test("restores the editor it replaced", (t) => {
	useEditorPrefix(t, true);
	const other: EditorFactory = () => ({});
	const slot = fakeEditorSlot();
	slot.factory = other;
	const ctx = { hasUI: true, ui: slot.ui } as unknown as ExtensionContext;

	applyPromptEditor(ctx);
	assert.notEqual(slot.factory, other);

	clearPromptEditor(ctx);
	assert.equal(slot.factory, other);
});

test("disabled prefix leaves another extension's editor alone", (t) => {
	useEditorPrefix(t, false);
	const other: EditorFactory = () => ({});
	const slot = fakeEditorSlot();
	slot.factory = other;
	const ctx = { hasUI: true, ui: slot.ui } as unknown as ExtensionContext;

	applyPromptEditor(ctx);
	assert.equal(slot.factory, other);

	// Never occupied the slot: clearing must not touch it either.
	clearPromptEditor(ctx);
	assert.equal(slot.factory, other);
});

test("applying twice does not rebuild the editor", (t) => {
	useEditorPrefix(t, true);
	const slot = fakeEditorSlot();
	const ctx = { hasUI: true, ui: slot.ui } as unknown as ExtensionContext;

	applyPromptEditor(ctx);
	const installed = slot.factory;
	assert.equal(slot.installs, 1);

	applyPromptEditor(ctx);
	assert.equal(slot.factory, installed);
	assert.equal(slot.installs, 1);
});

test("disabling removes our layer even when another extension wrapped it", (t) => {
	useEditorPrefix(t, true);
	const slot = fakeEditorSlot();
	const ctx = { hasUI: true, ui: slot.ui } as unknown as ExtensionContext;
	const before: EditorFactory = () => ({});
	slot.factory = before;

	applyPromptEditor(ctx);
	const ours = slot.factory as EditorFactory;
	// 模拟 pi-inline-skills：把当前工厂包一层再装回去，插槽里不再是我们自己的工厂。
	slot.factory = () => ours({}, {}, {});

	clearPromptEditor(ctx);
	assert.equal(slot.factory, before);
});

test("pi 重置插槽后，clear 不再写回一遍", (t) => {
	useEditorPrefix(t, true);
	const slot = fakeEditorSlot();
	const ctx = { hasUI: true, ui: slot.ui } as unknown as ExtensionContext;
	const before: EditorFactory = () => ({});
	slot.factory = before;

	applyPromptEditor(ctx);
	assert.notEqual(slot.factory, before);
	const installs = slot.installs;

	// /new、/reload 走 pi 的 resetExtensionUI，它把插槽置成 undefined，不经 setEditorComponent。
	slot.factory = undefined;

	clearPromptEditor(ctx);
	assert.equal(slot.factory, undefined);
	assert.equal(slot.installs, installs, "release must not write back over pi's own reset");

	// 下一轮 session_start 还能装回去。
	applyPromptEditor(ctx);
	assert.notEqual(slot.factory, before);
});
