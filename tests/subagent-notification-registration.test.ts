import assert from "node:assert/strict";
import test from "node:test";
import {
	CustomMessageComponent,
	ExtensionRunner,
	initTheme,
} from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import { config, setConfig } from "../extensions/config/config.ts";
import extension from "../extensions/index.ts";
import claudeCodeStyleExtension from "../extensions/renderer/index.ts";
import { getToolMouseTui, setToolMouseTui } from "../extensions/renderer/mouse/scroll.ts";
import { setStickyPromptTheme } from "../extensions/renderer/mouse/sticky-prompt.ts";
import {
	getMessageDisplayTheme,
	setMessageDisplayTheme,
} from "../extensions/renderer/tool/message-display.ts";
import { isToolTuiFullscreen, setToolTuiFullscreen } from "../extensions/renderer/tool/names.ts";
import {
	installSubagentNotificationRenderer,
	refreshSubagentNotifications,
} from "../extensions/renderer/tool/subagent-notification.ts";
import {
	patchRegistry,
	PROTOTYPE_ORIGINAL_KEY,
	STICKY_PROMPT_STATE_SLOT,
} from "../extensions/utils/patch-keys.ts";
import { createLazyProxy } from "./fixtures/lazy-tui.ts";

initTheme("dark");

// 单独成文件：入口会装各模块的全局补丁，不能污染其他渲染测试。
const TYPE = "subagent-notification";
const PATCH_KEY = Symbol.for("pi.ccstyle.subagent-notification-renderer-patch");
const runnerPrototype = ExtensionRunner.prototype as any;
const nativeLookup = runnerPrototype.getMessageRenderer;

/** 本插件入口在扩展加载期注册的消息渲染器（不进 TUI 会话）。 */
function entryRenderers(): Map<string, unknown> {
	const renderers = new Map<string, unknown>();
	const pi: any = new Proxy(
		{},
		{
			get(_target, prop) {
				if (prop === "events") return { on: () => () => {}, emit() {} };
				if (prop === "registerMessageRenderer") {
					return (customType: string, renderer: unknown) => renderers.set(customType, renderer);
				}
				return () => {};
			},
		},
	);
	extension(pi);
	return renderers;
}

const ours = entryRenderers();
const lookupAfterLoad = runnerPrototype.getMessageRenderer;

const stripAnsi = (line: string) => line.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");

function rows(component: { render(width: number): string[] }): string[] {
	return component
		.render(120)
		.map((line) => stripAnsi(line).trimEnd())
		.filter(Boolean);
}

const DETAILS = { id: "6dae0e11-9341-43b", status: "completed", toolUses: 2 };

function notification(details: unknown) {
	return {
		role: "custom",
		customType: TYPE,
		content: "<task-notification>…</task-notification>",
		display: true,
		details,
		timestamp: 1,
	} as any;
}

/** pi-subagents 渲染器的替身：记下收到的消息，画一行可辨认的视图。 */
function upstreamRenderer() {
	const seen: unknown[] = [];
	const renderer = (message: unknown) => {
		seen.push(message);
		return new Text("upstream view", 0, 0);
	};
	return Object.assign(renderer, { seen });
}

/** 按加载顺序排列各扩展的 messageRenderers，走真实的 ExtensionRunner 查找方法。 */
function lookup(extensions: Map<string, unknown>[], customType = TYPE): any {
	return runnerPrototype.getMessageRenderer.call(
		{ extensions: extensions.map((messageRenderers) => ({ messageRenderers })) },
		customType,
	);
}

function card(renderer: unknown, message = notification(DETAILS)) {
	return new CustomMessageComponent(message, renderer as any);
}

function withMode(mode: typeof config.mode, run: () => void): void {
	const previous = config.mode;
	config.mode = mode;
	try {
		run();
	} finally {
		config.mode = previous;
	}
}

function withPatch(run: () => void): void {
	const dispose = installSubagentNotificationRenderer();
	try {
		run();
	} finally {
		dispose();
	}
}

const FINISHED_ROW = /^ ✓ Subagent Finished 6dae0e11-9341-43b · 2 tool uses/;

test("loading the extension registers no notification renderer and leaves the lookup alone", () => {
	assert.equal(ours.has(TYPE), false, "registering would hide pi-subagents' renderer in off mode");
	assert.equal(lookupAfterLoad, nativeLookup, "outside a TUI session the lookup is not patched");
	assert.equal((globalThis as any)[PATCH_KEY], undefined);
});

test("our view wins whether pi-subagents loads before or after us", () => {
	withPatch(() =>
		withMode("on", () => {
			const upstream = upstreamRenderer();
			const subagents = new Map<string, unknown>([[TYPE, upstream]]);
			for (const order of [
				[subagents, ours],
				[ours, subagents],
			]) {
				assert.match(rows(card(lookup(order)))[0]!, FINISHED_ROW);
			}
			assert.equal(upstream.seen.length, 0);

			const other = () => new Text("other", 0, 0);
			const others = new Map<string, unknown>([["other-notification", other]]);
			assert.equal(lookup([subagents, others, ours], "other-notification"), other);
			assert.equal(lookup([subagents, ours], "unknown-notification"), undefined);
		}),
	);
});

test("without pi-subagents a saved notification still renders; off falls back to Pi's generic card", () => {
	withPatch(() => {
		const renderer = lookup([ours]);
		assert.equal(typeof renderer, "function");
		withMode("compact", () => {
			assert.match(rows(card(renderer))[0]!, FINISHED_ROW);
			for (const details of [undefined, null]) {
				assert.deepEqual(rows(card(renderer, notification(details))), [
					" ✓ Subagent Finished · click to show more",
				]);
			}
		});
		withMode("off", () => {
			const generic = rows(card(renderer));
			assert.equal(generic[0]!.trim(), "[subagent-notification]");
			assert.deepEqual(generic, rows(card(undefined)), "same as Pi with no renderer at all");
		});
	});
});

test("off hands the message to pi-subagents untouched and mounted cards follow later toggles", () => {
	withPatch(() => {
		const upstream = upstreamRenderer();
		const renderer = lookup([new Map<string, unknown>([[TYPE, upstream]]), ours]);
		const message = notification({
			id: "6dae0e11-9341-43b",
			status: "completed",
			toolUses: 2,
			others: [{ id: "second", status: "error", error: "boom" }],
		});
		const snapshot = structuredClone(message);
		const root = new Container();
		const mounted = card(renderer, message);
		root.addChild(mounted);

		withMode("off", () => {
			refreshSubagentNotifications(root);
			assert.deepEqual(rows(mounted), ["upstream view"]);
			assert.equal(upstream.seen.at(-1), message, "upstream gets the original message object");
		});
		withMode("on", () => {
			refreshSubagentNotifications(root);
			assert.match(rows(mounted)[0]!, FINISHED_ROW);
		});
		withMode("off", () => {
			refreshSubagentNotifications(root);
			assert.deepEqual(rows(mounted), ["upstream view"]);
		});
		assert.deepEqual(message, snapshot, "content and details are not mutated");
	});
});

test("reinstalling hands existing cards to the new patch and a stale disposer keeps it", () => {
	withMode("on", () => {
		const upstream = upstreamRenderer();
		const runner = [new Map<string, unknown>([[TYPE, upstream]]), ours];
		const disposeFirst = installSubagentNotificationRenderer();
		const fromFirst = lookup(runner);
		const disposeSecond = installSubagentNotificationRenderer();
		try {
			assert.equal(
				runnerPrototype.getMessageRenderer[PROTOTYPE_ORIGINAL_KEY],
				nativeLookup,
				"the new patch wraps the native lookup, not the replaced one",
			);
			disposeFirst();
			assert.notEqual(runnerPrototype.getMessageRenderer, nativeLookup);
			assert.equal((globalThis as any)[PATCH_KEY]?.active, true);
			assert.match(rows(card(fromFirst))[0]!, FINISHED_ROW, "old callbacks use the new patch");
			assert.match(rows(card(lookup(runner)))[0]!, FINISHED_ROW);
		} finally {
			disposeSecond();
		}
		assert.equal(runnerPrototype.getMessageRenderer, nativeLookup);
		assert.equal((globalThis as any)[PATCH_KEY], undefined);
		assert.deepEqual(rows(card(fromFirst)), ["upstream view"], "after dispose cards go native");
		assert.equal(lookup(runner), upstream);
	});
});

test("cards rebuilt before the patch is back (/reload, /resume) are adopted on refresh", () => {
	const upstream = upstreamRenderer();
	const withManager = [new Map<string, unknown>([[TYPE, upstream]]), ours];
	const withoutManager = [ours];
	// 上一个会话装上补丁，session_shutdown 卸下。
	installSubagentNotificationRenderer()();
	assert.equal(runnerPrototype.getMessageRenderer, nativeLookup);
	// /reload 与 /resume 先按原生查找重建 transcript，之后才发 session_start。
	const managedMessage = notification(DETAILS);
	const managed = card(lookup(withManager), managedMessage);
	const bare = card(lookup(withoutManager));
	assert.equal((managed as any).customRenderer, upstream);
	assert.equal((bare as any).customRenderer, undefined);
	const otherRenderer = () => new Text("other view", 0, 0);
	const other = card(
		lookup(
			[new Map<string, unknown>([["other-notification", otherRenderer]])],
			"other-notification",
		),
		{ ...notification(DETAILS), customType: "other-notification" },
	);
	const root = new Container();
	root.addChild(managed);
	root.addChild(bare);
	root.addChild(other);
	const generic = rows(card(undefined));

	withPatch(() => {
		const live = card(lookup(withManager));
		root.addChild(live);
		const liveRenderer = (live as any).customRenderer;
		for (const mode of ["on", "compact"] as const) {
			withMode(mode, () => {
				refreshSubagentNotifications(root);
				assert.match(rows(managed)[0]!, FINISHED_ROW, `${mode}: with pi-subagents`);
				assert.match(rows(bare)[0]!, FINISHED_ROW, `${mode}: without pi-subagents`);
			});
		}
		const adopted = (managed as any).customRenderer;
		refreshSubagentNotifications(root);
		assert.equal((managed as any).customRenderer, adopted, "a second refresh does not rewrap");
		assert.equal((live as any).customRenderer, liveRenderer, "cards built under the patch keep it");
		assert.equal((other as any).customRenderer, otherRenderer, "other custom types are untouched");
		assert.deepEqual(rows(other), ["other view"]);
		withMode("off", () => {
			upstream.seen.length = 0;
			refreshSubagentNotifications(root);
			assert.deepEqual(rows(managed), ["upstream view"]);
			assert.ok(upstream.seen.includes(managedMessage), "upstream gets the original message");
			assert.deepEqual(rows(bare), generic);
		});
	});

	// 补丁卸下后回到原生：有 pi-subagents 用它的视图，没有就是 Pi 的通用卡片。
	withMode("on", () => {
		managed.invalidate();
		bare.invalidate();
		assert.deepEqual(rows(managed), ["upstream view"]);
		assert.deepEqual(rows(bare), generic);
	});
});

function runtime() {
	const events = new Map<string, Function>();
	return {
		events,
		pi: {
			registerCommand() {},
			registerShortcut() {},
			registerTool() {},
			on(name: string, handler: Function) {
				events.set(name, handler);
			},
		},
	};
}

test("a TUI session installs the lookup patch and shutdown removes it; other sessions do not", async (t) => {
	const previous = { ...config };
	t.after(() => setConfig(previous));
	const headless = runtime();
	claudeCodeStyleExtension(headless.pi as any, { mode: "on" });
	await headless.events.get("session_start")?.({}, { mode: "print", hasUI: false });
	assert.equal(runnerPrototype.getMessageRenderer, nativeLookup);

	const session = runtime();
	const ctx = {
		mode: "tui",
		hasUI: true,
		ui: {
			theme: { fg: (_color: string, text: string) => text },
			setStatus() {},
			requestRender() {},
		},
	} as any;
	claudeCodeStyleExtension(session.pi as any, { mode: "on" });
	try {
		await session.events.get("session_start")?.({}, ctx);
		assert.notEqual(runnerPrototype.getMessageRenderer, nativeLookup);
		assert.equal((globalThis as any)[PATCH_KEY]?.active, true);
		assert.match(rows(card(lookup([ours])))[0]!, FINISHED_ROW);
	} finally {
		await session.events.get("session_shutdown")?.({}, ctx);
	}
	assert.equal(runnerPrototype.getMessageRenderer, nativeLookup);
	assert.equal((globalThis as any)[PATCH_KEY], undefined);
});

test("session_start hands mounted cards rebuilt before it to our renderer", async (t) => {
	// session_start/鼠标层会改这些进程级状态；测完还原成原值。
	const previous = { ...config };
	const previousDisplayTheme = getMessageDisplayTheme();
	const previousStickyTheme = patchRegistry.get<{ theme?: unknown }>(
		STICKY_PROMPT_STATE_SLOT,
	)?.theme;
	const previousTui = getToolMouseTui();
	const previousFullscreen = isToolTuiFullscreen();
	t.after(() => {
		setConfig(previous);
		setMessageDisplayTheme(previousDisplayTheme);
		setStickyPromptTheme(previousStickyTheme);
		setToolMouseTui(previousTui);
		setToolTuiFullscreen(previousFullscreen);
	});

	// /reload 与 /resume 先重建 transcript 再发 session_start：补丁已随 session_shutdown 卸下，
	// 卡上存的是原生查找结果——pi-subagents 的渲染器，没有它时是 undefined。
	assert.equal(runnerPrototype.getMessageRenderer, nativeLookup);
	const managed = card(lookup([new Map<string, unknown>([[TYPE, upstreamRenderer()]]), ours]));
	const bare = card(lookup([ours]));
	const generic = rows(card(undefined));
	assert.deepEqual(rows(managed), ["upstream view"]);
	assert.deepEqual(rows(bare), generic);
	const transcript = new Container();
	transcript.addChild(managed);
	transcript.addChild(bare);

	// 最小的 regular 渲染器，经 Pi 的惰性 Proxy 交给扩展（与 0.84+ 的 ctx.ui 同形）。
	const renderer = {
		mode: "regular",
		children: [transcript],
		previousViewportTop: 0,
		terminal: { columns: 120, rows: 24, write() {} },
		requestRender() {},
		render(width: number) {
			return this.children.flatMap((child: any) => child.render(width));
		},
		doRender() {
			this.render(120);
		},
		handleInput() {},
	};
	const tui = createLazyProxy(() => renderer);
	const theme = { fg: (_color: string, text: string) => text };
	const ctx = {
		mode: "tui",
		hasUI: true,
		ui: {
			theme,
			setStatus() {},
			requestRender() {},
			notify() {},
			setFooter() {},
			setWidget(_key: string, content: any) {
				if (typeof content === "function") content(tui, theme);
			},
			onTerminalInput() {
				return () => {};
			},
		},
	} as any;
	const session = runtime();
	claudeCodeStyleExtension(session.pi as any, { mode: "on" });
	try {
		await session.events.get("session_start")?.({}, ctx);
		assert.equal(getToolMouseTui(), tui, "the mounted transcript is the one the extension sees");
		// session_start 排的会话重绘在下一拍执行，测试不手动刷新。
		await new Promise((resolve) => setTimeout(resolve, 0));
		assert.match(rows(managed)[0]!, FINISHED_ROW, "with pi-subagents");
		assert.match(rows(bare)[0]!, FINISHED_ROW, "without pi-subagents");
	} finally {
		await session.events.get("session_shutdown")?.({}, ctx);
	}
	assert.equal(runnerPrototype.getMessageRenderer, nativeLookup);
	managed.invalidate();
	bare.invalidate();
	assert.deepEqual(rows(managed), ["upstream view"], "after shutdown cards go native");
	assert.deepEqual(rows(bare), generic);
});
