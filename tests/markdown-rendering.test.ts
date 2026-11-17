import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
	AssistantMessageComponent,
	UserMessageComponent,
	initTheme,
	type ExtensionContext,
	type MarkdownMessageType,
	type MarkdownTransformer,
	type MarkdownTransformerOptions,
} from "@earendil-works/pi-coding-agent";
import { Markdown, stripTerminalSequences } from "@earendil-works/pi-tui";
import { configureMarkdownRendering } from "../extensions/index.ts";
import { withTranscriptScope } from "../extensions/renderer/transcript-scope.ts";

const agentEntry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
const { createMarkdownTransform } = await import(
	pathToFileURL(
		path.join(path.dirname(agentEntry), "modes/interactive/components/markdown-transform.js"),
	).href
);
initTheme("dark");
const identity = (text: string) => text;
const theme = Object.fromEntries(
	[
		"heading",
		"link",
		"linkUrl",
		"code",
		"codeBlock",
		"codeBlockBorder",
		"quote",
		"quoteBorder",
		"hr",
		"listBullet",
		"bold",
		"italic",
		"strikethrough",
		"underline",
	].map((key) => [key, identity]),
) as any;
const TABLE = "| A | B |\n| --- | --- |\n| one | two |\n";
const text = (component: { render(width: number): string[] }) =>
	component.render(80).map(stripTerminalSequences).join("\n");

function runtime(
	features = { enableMarkdownEnhance: false, enableTableCopy: true },
	mode = "fullscreen",
	ctxMode = "tui",
) {
	const handlers = new Map<string, Array<(event: any, ctx: ExtensionContext) => unknown>>();
	let registration:
		| { transformer: MarkdownTransformer; options?: MarkdownTransformerOptions }
		| undefined;
	let registrations = 0;
	let renderRequests = 0;
	const api = {
		on(event: string, handler: (event: any, ctx: ExtensionContext) => unknown) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
			return () => {};
		},
		registerMarkdownTransformer(
			transformer: MarkdownTransformer,
			options?: MarkdownTransformerOptions,
		) {
			registrations++;
			registration = { transformer, options };
		},
	};
	configureMarkdownRendering(api as never, features);
	const tui = {
		mode,
		children: [] as any[],
		requestRender() {
			renderRequests++;
		},
	};
	const widgets = new Map<string, any>();
	const ui = {
		theme: { fg: (_color: string, value: string) => value },
		setWidget(key: string, content: any) {
			widgets.get(key)?.dispose?.();
			if (typeof content === "function") widgets.set(key, content(tui, ui.theme));
			else widgets.delete(key);
		},
		notify() {},
	};
	const ctx = {
		mode: ctxMode,
		hasUI: ctxMode === "tui" || ctxMode === "rpc",
		ui,
		// Only UI fields are used here; session/model services are intentionally omitted.
	} as unknown as ExtensionContext;
	const transformers = (): MarkdownTransformer[] =>
		registration
			? [
					(markdown, context) =>
						registration!.options?.messageTypes?.includes(context.messageType)
							? registration!.transformer(markdown, context)
							: markdown,
				]
			: [];
	return {
		tui,
		widgets,
		handlers,
		transformers,
		get registrations() {
			return registrations;
		},
		get options() {
			return registration?.options;
		},
		get renderRequests() {
			return renderRequests;
		},
		create(source: string, kind: MarkdownMessageType = "assistant") {
			return new Markdown(source, 0, 0, theme, undefined, {
				transform: createMarkdownTransform(kind, () => false, transformers()),
			});
		},
		apply(source: string, kind: MarkdownMessageType = "assistant", isStreaming = false) {
			return createMarkdownTransform(kind, () => isStreaming, transformers())(source, 80) as string;
		},
		async start() {
			for (const handler of handlers.get("session_start") ?? []) await handler({}, ctx);
		},
		async stop() {
			for (const handler of handlers.get("session_shutdown") ?? []) await handler({}, ctx);
		},
	};
}

for (const enableMarkdownEnhance of [false, true]) {
	for (const enableTableCopy of [false, true]) {
		test(`one transformer preserves both feature switches: enhance=${enableMarkdownEnhance}, copy=${enableTableCopy}`, async () => {
			const host = runtime({ enableMarkdownEnhance, enableTableCopy });
			try {
				assert.equal(host.registrations, enableMarkdownEnhance || enableTableCopy ? 1 : 0);
				if (enableMarkdownEnhance)
					assert.deepEqual(host.options?.messageTypes, [
						"user",
						"assistant",
						"assistant-thinking",
						"custom",
						"summary",
					]);
				else if (enableTableCopy) assert.deepEqual(host.options?.messageTypes, ["assistant"]);
				await host.start();
				assert.equal(text(host.create(TABLE)).includes("Copy TSV"), enableTableCopy);
				assert.equal(host.apply("方案①"), enableMarkdownEnhance ? "方案(1)" : "方案①");
				assert.equal(host.apply("方案①", "assistant-thinking"), "方案①");
				const diagram = "```sequenceDiagram\nA->>B: hi\n```";
				assert.equal(host.apply(diagram).includes("┌"), enableMarkdownEnhance);
				assert.equal(host.apply(diagram, "assistant", true), diagram);
				assert.equal(text(host.create(TABLE, "user")).includes("Copy TSV"), false);
			} finally {
				await host.stop();
			}
		});
	}
}

test("native assistant text is enhanced but native thinking, user text and previews are not", async () => {
	const host = runtime();
	try {
		await host.start();
		const message: AssistantMessage = {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: TABLE },
				{ type: "text", text: TABLE },
			],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "test",
			timestamp: 1,
			stopReason: "stop",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		};
		const assistant = new AssistantMessageComponent(
			message,
			false,
			theme,
			"",
			0,
			host.transformers(),
		);
		assert.equal(text(assistant).split("Copy TSV").length - 1, 1);
		const user = new UserMessageComponent(TABLE, theme, 0, host.transformers());
		assert.doesNotMatch(text(user), /Copy TSV/);
		assert.doesNotMatch(text(new Markdown(TABLE, 0, 0, theme)), /Copy TSV/);
	} finally {
		await host.stop();
	}
});

test("compact-style direct transformer calls still identify assistant body instances", async () => {
	const host = runtime();
	try {
		await host.start();
		const component = new Markdown(TABLE, 0, 0, theme, undefined, {
			transform: (source, availableWidth) =>
				host.transformers().reduce(
					(value, transform) =>
						transform(value, {
							messageType: "assistant",
							isStreaming: true,
							availableWidth,
						}),
					source,
				),
		});
		assert.match(text(component), /Copy TSV/);
		component.setText(TABLE + "\nStreaming tail");
		assert.match(text(component), /Copy TSV/);
	} finally {
		await host.stop();
	}
});

test("installation refreshes pre-rendered messages reached through mounted roots", async () => {
	const host = runtime();
	const component = host.create(TABLE);
	const initial = text(component);
	assert.doesNotMatch(initial, /Copy TSV/);
	const mounted = { getMountedRoots: () => [component] };
	host.tui.children.push(mounted);
	try {
		await host.start();
		assert.match(text(component), /Copy TSV/);
		await host.stop();
		assert.doesNotMatch(text(component), /Copy TSV/);
		assert.equal(host.widgets.size, 0);
	} finally {
		await host.stop();
	}
});

test("widget lifecycle installs only in fullscreen and handles live mode changes and reloads", async () => {
	const original = Markdown.prototype.render;
	const host = runtime(undefined, "regular");
	const component = host.create(TABLE);
	host.tui.children.push(component);
	try {
		await host.start();
		assert.equal(Markdown.prototype.render, original);
		assert.doesNotMatch(text(component), /Copy TSV/);
		const widget = [...host.widgets.values()][0];
		host.tui.mode = "fullscreen";
		widget.invalidate();
		assert.notEqual(Markdown.prototype.render, original);
		assert.match(text(component), /Copy TSV/);
		host.tui.mode = "regular";
		widget.invalidate();
		assert.equal(Markdown.prototype.render, original);
		assert.doesNotMatch(text(component), /Copy TSV/);
		host.tui.mode = "fullscreen";
		widget.invalidate();
		assert.match(text(component), /Copy TSV/);
		assert.ok(host.renderRequests >= 3);
		await host.stop();
		widget.invalidate();
		widget.render();
		assert.equal(Markdown.prototype.render, original, "disposed widgets cannot reinstall a patch");
		await host.start();
		assert.match(text(component), /Copy TSV/);
	} finally {
		await host.stop();
	}
});

test("transcript browsing and non-TUI sessions leave table rendering native", async () => {
	const host = runtime();
	try {
		await host.start();
		const clone = host.create(TABLE);
		assert.doesNotMatch(
			withTranscriptScope(() => text(clone)),
			/Copy TSV/,
		);
		clone.invalidate();
		assert.doesNotMatch(text(clone), /Copy TSV/);
	} finally {
		await host.stop();
	}
	for (const mode of ["rpc", "json", "print"]) {
		const other = runtime(undefined, "fullscreen", mode);
		try {
			await other.start();
			assert.equal(other.widgets.size, 0);
			assert.doesNotMatch(text(other.create(TABLE)), /Copy TSV/);
		} finally {
			await other.stop();
		}
	}
});
