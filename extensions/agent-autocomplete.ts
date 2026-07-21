import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	type AutocompleteItem,
	type AutocompleteProvider,
	type AutocompleteSuggestions,
	fuzzyFilter,
} from "@earendil-works/pi-tui";

type AgentInfo = {
	name: string;
	displayName: string;
	description: string;
	model?: string;
	filePath: string;
};

const MAX_SUGGESTIONS = 10;
// Match `@name` but NOT `@session:` (reserved by session-reference extension).
const AGENT_NAME_PATTERN = /(?:^|[\t ])@([^\s:@][^\s:]*)$/;

function getAgentDir(): string {
	const override = process.env.PI_CODING_AGENT_DIR;
	return join(override ? override : homedir(), ".pi", "agent", "agents");
}

function parseFrontmatter(content: string): Record<string, string> {
	const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
	if (!match) return {};
	const result: Record<string, string> = {};
	for (const line of match[1]!.split("\n")) {
		const kv = line.match(/^(\w+):\s*(.*)$/);
		if (kv) result[kv[1]!] = kv[2]!.trim();
	}
	return result;
}

function loadAgents(): AgentInfo[] {
	const dir = getAgentDir();
	if (!existsSync(dir)) return [];

	return readdirSync(dir)
		.filter((f) => f.endsWith(".md"))
		.map((file) => {
			const filePath = join(dir, file);
			const content = readFileSync(filePath, "utf-8");
			const fm = parseFrontmatter(content);
			const name = file.replace(/\.md$/, "");
			return {
				name,
				displayName: fm.display_name || name,
				description: fm.description || "",
				model: fm.model,
				filePath,
			};
		});
}

function createAgentAutocompleteProvider(
	current: AutocompleteProvider,
	getAgents: () => AgentInfo[],
): AutocompleteProvider {
	return {
		async getSuggestions(
			lines: string[],
			cursorLine: number,
			cursorCol: number,
			options: { signal: AbortSignal; force?: boolean },
		): Promise<AutocompleteSuggestions | null> {
			const currentLine = lines[cursorLine] ?? "";
			const textBeforeCursor = currentLine.slice(0, cursorCol);
			const match = textBeforeCursor.match(AGENT_NAME_PATTERN);

			if (!match) {
				return current.getSuggestions(lines, cursorLine, cursorCol, options);
			}

			const query = match[1]!;
			const agents = getAgents();

			if (options.signal.aborted || agents.length === 0) {
				return current.getSuggestions(lines, cursorLine, cursorCol, options);
			}

			const matches = query.trim()
				? fuzzyFilter(agents, query, (a) => `${a.name} ${a.displayName} ${a.description}`)
				: agents;

			const items: AutocompleteItem[] = matches
				.slice(0, MAX_SUGGESTIONS)
				.map((agent) => ({
					value: `@${agent.name}`,
					label: `[SubAgent] ${agent.displayName}`,
					description: agent.description
						+ (agent.model ? ` · ${agent.model}` : ""),
				}));

			if (items.length === 0) {
				return current.getSuggestions(lines, cursorLine, cursorCol, options);
			}

			return { items, prefix: `@${query}` };
		},

		applyCompletion(
			lines: string[],
			cursorLine: number,
			cursorCol: number,
			item: AutocompleteItem,
			prefix: string,
		) {
			return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
		},

		shouldTriggerFileCompletion(lines: string[], cursorLine: number, cursorCol: number) {
			return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
		},
	};
}

export default function agentAutocompleteExtension(pi: ExtensionAPI): void {
	let cachedAgents: AgentInfo[] | undefined;

	const getAgents = (): AgentInfo[] => {
		if (!cachedAgents) {
			cachedAgents = loadAgents();
		}
		return cachedAgents;
	};

	// Reload agents on /reload
	pi.on("resources_discover", () => {
		cachedAgents = undefined;
	});

	pi.on("session_start", (_event, ctx) => {
		const agents = getAgents();
		if (agents.length === 0 || ctx.mode !== "tui") return;
		ctx.ui.addAutocompleteProvider((current) =>
			createAgentAutocompleteProvider(current, getAgents),
		);
	});

	// Inject instruction when user types @agent-name (not @session:) in prompt.
	// Supports multiple different subagents in a single prompt.
	const AGENT_PROMPT_PATTERN = /(?:^|[\s])@([^\s:@][^\s:]*)/g;
	pi.on("before_agent_start", async (event, _ctx) => {
		const agents = getAgents();
		if (agents.length === 0) return;

		const mentions: string[] = [];
		for (const m of event.prompt.matchAll(AGENT_PROMPT_PATTERN)) {
			const name = m[1]!;
			if (agents.some((a) => a.name === name) && !mentions.includes(name)) {
				mentions.push(name);
			}
		}
		if (mentions.length === 0) return;

		const agentMap = new Map(agents.map((a) => [a.name, a]));
		const agentList = mentions.map((n) => `"${n}" (${agentMap.get(n)!.displayName})`).join(", ");
		const agentTypes = mentions.map((n) => `"${n}"`).join(" | ");

		return {
			systemPrompt:
				event.systemPrompt
				+ `\n\nThe user's prompt references these subagent types: ${agentList}. `
				+ `You MUST use the Agent tool for EACH mentioned subagent to delegate the relevant parts of the request. `
				+ `Handle different subagents separately — do NOT merge their tasks into a single Agent call. `
				+ `For example, if the user mentions @coder and @explore, make two separate Agent tool calls, one with subagent_type="coder" and another with subagent_type="explore".`,
		};
	});
}
