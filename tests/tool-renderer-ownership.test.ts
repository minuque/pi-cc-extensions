import assert from "node:assert/strict";
import test from "node:test";

import { ToolExecutionComponent, initTheme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import claudeCodeStyleExtension, { preservesOriginalRenderer } from "../extensions/claude-code-style.ts";

initTheme("dark");

test("claude-code-style initialization does not register built-in tool overrides", async () => {
	const registeredTools: unknown[] = [];
	const events = new Map<string, Function>();
	const pi = {
		registerTool(tool: unknown) {
			registeredTools.push(tool);
		},
		registerCommand() {},
		registerShortcut() {},
		on(name: string, handler: Function) {
			events.set(name, handler);
		},
	};

	claudeCodeStyleExtension(pi as any);

	assert.deepEqual(registeredTools, []);
	await events.get("session_shutdown")?.({}, { ui: { setStatus() {} } });
});

test("ccstyle is the default renderer and exclusions preserve dedicated renderers", () => {
	const builtIn = {
		name: "edit",
		renderShell: "self",
		renderCall() {},
		renderResult() {},
	};

	assert.equal(
		preservesOriginalRenderer({ name: "edit", renderCall() {} }, "edit", builtIn),
		false,
	);
	assert.equal(
		preservesOriginalRenderer({ name: "edit", renderCall() {} }, "edit", builtIn, ["edit"]),
		true,
	);
	assert.equal(
		preservesOriginalRenderer(undefined, "edit", builtIn, ["edit"]),
		true,
	);
	assert.equal(
		preservesOriginalRenderer({ name: "custom" }, "custom", undefined, ["custom"]),
		false,
	);
	assert.equal(preservesOriginalRenderer(undefined, "Agent"), true);
});

test("Agent keeps its dedicated call/result renderer and explicit shell", async () => {
	const events = new Map<string, Function>();
	const pi = {
		registerCommand() {},
		registerShortcut() {},
		on(name: string, handler: Function) {
			events.set(name, handler);
		},
	};
	claudeCodeStyleExtension(pi as any);
	const extensionTheme = { fg: (_color: string, text: string) => text };
	const ui = {
		theme: extensionTheme,
		setStatus() {},
		requestRender() {},
	};
	const ctx = { mode: "print", hasUI: false, ui };
	await events.get("session_start")?.({}, ctx);
	const definition = {
		name: "Agent",
		renderShell: "default",
		renderCall: () => new Text("agent dedicated call", 0, 0),
		renderResult: () => new Text("agent dedicated result", 0, 0),
	};
	const component = new ToolExecutionComponent(
		"Agent",
		"agent-renderer",
		{},
		{},
		definition,
		ui as any,
		process.cwd(),
	) as any;
	component.updateResult({ content: [{ type: "text", text: "raw" }], isError: false });
	assert.equal(component.children.filter((child: any) => child === component.contentBox).length, 1);
	assert.equal(component.children.includes(component.selfRenderContainer), false);
	const output = component.render(100).join("\n");
	assert.equal(output.match(/agent dedicated call/g)?.length, 1);
	assert.equal(output.match(/agent dedicated result/g)?.length, 1);
	await events.get("session_shutdown")?.({}, ctx);
});

test("global renderer reload chains external wrappers and shutdown restores them", async () => {
	const prototype = ToolExecutionComponent.prototype as any;
	const methodNames = [
		"hasRendererDefinition",
		"getRenderShell",
		"getCallRenderer",
		"getResultRenderer",
	] as const;
	const originals = Object.fromEntries(methodNames.map((name) => [name, prototype[name]])) as Record<string, Function>;
	const firstEvents = new Map<string, Function>();
	const secondEvents = new Map<string, Function>();
	const makePi = (events: Map<string, Function>) => ({
		registerCommand() {},
		registerShortcut() {},
		on(name: string, handler: Function) {
			events.set(name, handler);
		},
	});
	const ctx = { ui: { setStatus() {} } } as any;

	try {
		claudeCodeStyleExtension(makePi(firstEvents) as any);
		const firstPatch = (globalThis as any)[Symbol.for("pi.ccstyle.global-tool-render-patch")];
		const externalCalls = Object.fromEntries(methodNames.map((name) => [name, 0])) as Record<string, number>;
		const external = {} as Record<string, Function>;
		for (const name of methodNames) {
			const downstream = prototype[name];
			external[name] = function (this: any, ...args: any[]) {
				externalCalls[name]++;
				return downstream.apply(this, args);
			};
			prototype[name] = external[name];
		}

		claudeCodeStyleExtension(makePi(secondEvents) as any);
		assert.equal(firstPatch.active, false);
		assert.equal(firstPatch.mode(), "off", "reload disconnects the old config callback");
		for (const name of methodNames) assert.notEqual(prototype[name], external[name]);

		const renderCall = () => new Text("call", 0, 0);
		const renderResult = () => new Text("result", 0, 0);
		const receiver = {
			toolName: "Agent",
			toolDefinition: { name: "Agent", renderShell: "default", renderCall, renderResult },
			builtInToolDefinition: undefined,
			children: [],
		};
		assert.equal(prototype.hasRendererDefinition.call(receiver), true);
		assert.equal(prototype.getRenderShell.call(receiver), "default");
		assert.equal(prototype.getCallRenderer.call(receiver), renderCall);
		assert.equal(prototype.getResultRenderer.call(receiver), renderResult);
		for (const name of methodNames) assert.equal(externalCalls[name], 1, `${name} chains the external wrapper`);

		const secondOwned = Object.fromEntries(methodNames.map((name) => [name, prototype[name]]));
		await firstEvents.get("session_shutdown")?.({}, ctx);
		for (const name of methodNames) {
			assert.equal(prototype[name], secondOwned[name], `stale shutdown keeps ${name}`);
		}

		await secondEvents.get("session_shutdown")?.({}, ctx);
		for (const name of methodNames) {
			assert.equal(prototype[name], external[name], `shutdown restores ${name}'s downstream`);
		}
	} finally {
		await firstEvents.get("session_shutdown")?.({}, ctx);
		await secondEvents.get("session_shutdown")?.({}, ctx);
		for (const name of methodNames) prototype[name] = originals[name];
		delete (globalThis as any)[Symbol.for("pi.ccstyle.global-tool-render-patch")];
	}
});

test("global renderer migrates legacy Symbol state without retaining old wrappers", async () => {
	const prototype = ToolExecutionComponent.prototype as any;
	const methodNames = [
		"hasRendererDefinition",
		"getRenderShell",
		"getCallRenderer",
		"getResultRenderer",
	] as const;
	const originals = Object.fromEntries(methodNames.map((name) => [name, prototype[name]])) as Record<string, Function>;
	const events = new Map<string, Function>();
	const legacy: any = {
		prototype,
		owner: {},
		enabled: () => true,
		wrap: (tool: any) => tool,
		byDefinition: new WeakMap(),
		byName: new Map(),
		originalHasRendererDefinition: originals.hasRendererDefinition,
		originalGetRenderShell: originals.getRenderShell,
		originalGetCallRenderer: originals.getCallRenderer,
		originalGetResultRenderer: originals.getResultRenderer,
	};
	const shouldGloballyStyleTool = () => false;
	const shouldUseSelfShell = () => false;
	prototype.hasRendererDefinition = function (this: any, ...args: any[]) {
		if (shouldGloballyStyleTool()) return true;
		return legacy.originalHasRendererDefinition.apply(this, args);
	};
	prototype.getRenderShell = function (this: any, ...args: any[]) {
		if (shouldUseSelfShell() || shouldGloballyStyleTool()) return "self";
		return legacy.originalGetRenderShell.apply(this, args);
	};
	prototype.getCallRenderer = function (this: any, ...args: any[]) {
		if (shouldGloballyStyleTool()) return undefined;
		return legacy.originalGetCallRenderer.apply(this, args);
	};
	prototype.getResultRenderer = function (this: any, ...args: any[]) {
		if (shouldGloballyStyleTool()) return undefined;
		return legacy.originalGetResultRenderer.apply(this, args);
	};
	(globalThis as any)[Symbol.for("pi.ccstyle.global-tool-render-patch")] = legacy;
	const ctx = { ui: { setStatus() {} } } as any;

	try {
		claudeCodeStyleExtension({
			registerCommand() {},
			registerShortcut() {},
			on(name: string, handler: Function) {
				events.set(name, handler);
			},
		} as any);
		const migrated = (globalThis as any)[Symbol.for("pi.ccstyle.global-tool-render-patch")];
		for (const name of methodNames) assert.equal(migrated.downstream[name], originals[name]);
		assert.equal(legacy.enabled(), false, "legacy callbacks are disconnected");
		await events.get("session_shutdown")?.({}, ctx);
		for (const name of methodNames) assert.equal(prototype[name], originals[name]);
	} finally {
		await events.get("session_shutdown")?.({}, ctx);
		for (const name of methodNames) prototype[name] = originals[name];
		delete (globalThis as any)[Symbol.for("pi.ccstyle.global-tool-render-patch")];
	}
});

test("global renderer shutdown does not overwrite wrappers installed later", async () => {
	const prototype = ToolExecutionComponent.prototype as any;
	const methodNames = [
		"hasRendererDefinition",
		"getRenderShell",
		"getCallRenderer",
		"getResultRenderer",
	] as const;
	const originals = Object.fromEntries(methodNames.map((name) => [name, prototype[name]])) as Record<string, Function>;
	const events = new Map<string, Function>();
	const ctx = { ui: { setStatus() {} } } as any;
	try {
		claudeCodeStyleExtension({
			registerCommand() {},
			registerShortcut() {},
			on(name: string, handler: Function) {
				events.set(name, handler);
			},
		} as any);
		const later = {} as Record<string, Function>;
		for (const name of methodNames) {
			const downstream = prototype[name];
			later[name] = function (this: any, ...args: any[]) {
				return downstream.apply(this, args);
			};
			prototype[name] = later[name];
		}

		await events.get("session_shutdown")?.({}, ctx);
		for (const name of methodNames) {
			assert.equal(prototype[name], later[name], `shutdown preserves later ${name}`);
		}
	} finally {
		await events.get("session_shutdown")?.({}, ctx);
		for (const name of methodNames) prototype[name] = originals[name];
		delete (globalThis as any)[Symbol.for("pi.ccstyle.global-tool-render-patch")];
	}
});
