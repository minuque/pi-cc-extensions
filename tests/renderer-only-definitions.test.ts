import assert from "node:assert/strict";
import test from "node:test";
import { ToolExecutionComponent, initTheme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { config } from "../extensions/config/config.ts";
import { installDefaultMode } from "../extensions/renderer/default-mode.ts";
import { WriteExecutionMetadataStore } from "../extensions/renderer/tool/diff/index.ts";

initTheme("dark");

for (const mode of ["on", "compact"] as const) {
	test(`${mode}: renderer-only definitions retain each replayed tool's identity`, () => {
		const previousMode = config.mode;
		config.mode = mode;
		const hooks = installDefaultMode(new WriteExecutionMetadataStore());
		// Pi 1.0 can return renderers without a full tool definition. A resolver
		// may also share the same renderer object between different tool names.
		const definition = {
			renderCall: () => new Text("native call", 0, 0),
			renderResult: () => new Text("native result", 0, 0),
		};
		const renderers = new Map<string, Function>();
		try {
			for (const name of ["read", "bash", "write", "read"]) {
				const tool = new ToolExecutionComponent(
					name,
					`replay-${name}`,
					name === "bash" ? { command: "echo hello" } : { path: "a.txt", content: "hello" },
					{},
					definition as any,
					{ requestRender() {} } as any,
					process.cwd(),
				) as any;
				const renderer = tool.getCallRenderer();
				if (renderers.has(name)) {
					assert.equal(renderer, renderers.get(name), "same definition and name reuse the wrapper");
				}
				renderers.set(name, renderer);
				tool.updateResult({ content: [{ type: "text", text: "hello" }], isError: false });
				tool.invalidate();
				const output = tool.render(100).join("\n");
				assert.match(output, new RegExp(name[0]!.toUpperCase() + name.slice(1)));
				assert.match(
					output,
					name === "read"
						? /1 line loaded/
						: name === "write" && mode === "on"
							? /diff unavailable/
							: /1 line returned/,
				);
				tool.setExpanded(true);
				assert.match(tool.render(100).join("\n"), name === "bash" ? /hello/ : /a\.txt/);
			}
			assert.notEqual(renderers.get("read"), renderers.get("bash"));
		} finally {
			hooks.shutdown();
			config.mode = previousMode;
		}
	});
}
