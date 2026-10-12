import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import agentExt from "../extensions/feature/reference/subagent.ts";

test("PI_CODING_AGENT_DIR is the agent directory", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-cc-agents-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	mkdirSync(join(dir, "agents"));
	writeFileSync(join(dir, "agents", "demo.md"), "---\ndescription: demo agent\n---\n");
	mkdirSync(join(dir, ".pi", "agent", "agents"), { recursive: true });
	writeFileSync(join(dir, ".pi", "agent", "agents", "wrong.md"), "---\ndescription: wrong\n---\n");
	try {
		const events = new Map<string, Function>();
		let provider: any;
		agentExt({
			on(name: string, handler: Function) {
				events.set(name, handler);
			},
		} as any);
		events.get("resources_discover")?.();
		events.get("session_start")?.(
			{},
			{
				mode: "tui",
				ui: {
					addAutocompleteProvider(factory: Function) {
						provider = factory({
							getSuggestions: async () => null,
							applyCompletion: () => {},
						});
					},
				},
			},
		);
		await new Promise((resolve) => setTimeout(resolve, 0));
		assert.ok(provider, "agent under PI_CODING_AGENT_DIR/agents should register");
		const suggestions = await provider.getSuggestions(["@demo"], 0, 5, {
			signal: new AbortController().signal,
		});
		const labels = suggestions.items.map((item: { label: string }) => item.label).join("\n");
		assert.match(labels, /demo/);
		assert.doesNotMatch(labels, /wrong/);
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		rmSync(dir, { recursive: true, force: true });
	}
});
