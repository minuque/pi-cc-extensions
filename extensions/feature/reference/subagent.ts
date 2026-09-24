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
	thinking?: string;
	filePath: string;
};

export const SUBAGENT_DELEGATION_CUSTOM_TYPE = "subagent-delegation";
export const SUBAGENT_REFERENCE_PREFIX = "@subagent:";

const MAX_SUGGESTIONS = 2;
const MENTION_PATTERN = /(?:^|[\t ])@([^\s@]*)$/;
const SUBAGENT_REFERENCE_PATTERN = /(?:^|\s)@subagent:\[([^\]]+)](?![\w-])/g;

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
				thinking: fm.thinking,
				filePath,
			};
		});
}

function extractMentionQuery(textBeforeCursor: string): string | undefined {
	return textBeforeCursor.match(MENTION_PATTERN)?.[1];
}

/** Filter text for agent names, or null when this provider should not claim the @ query. */
function agentSearchQuery(raw: string): string | null {
	if (raw.startsWith("session:")) return null;
	if (raw === "subagent") return "";
	const prefixed = raw.match(/^subagent:\[?([^\]]*)$/);
	if (prefixed) return prefixed[1] ?? "";
	return raw;
}

export function extractSubagentReferenceNames(text: string): string[] {
	const names: string[] = [];
	const seen = new Set<string>();
	for (const match of text.matchAll(SUBAGENT_REFERENCE_PATTERN)) {
		const name = match[1]?.trim();
		if (name && !seen.has(name)) {
			seen.add(name);
			names.push(name);
		}
	}
	return names;
}

export function subagentReferenceValue(name: string): string {
	return `${SUBAGENT_REFERENCE_PREFIX}[${name}]`;
}

export function createAgentAutocompleteProvider(
	current: AutocompleteProvider,
	getAgents: () => AgentInfo[],
): AutocompleteProvider {
	return {
		triggerCharacters: ["@"],
		async getSuggestions(
			lines: string[],
			cursorLine: number,
			cursorCol: number,
			options: { signal: AbortSignal; force?: boolean },
		): Promise<AutocompleteSuggestions | null> {
			const currentLine = lines[cursorLine] ?? "";
			const textBeforeCursor = currentLine.slice(0, cursorCol);
			const rawQuery = extractMentionQuery(textBeforeCursor);
			if (rawQuery === undefined) {
				return current.getSuggestions(lines, cursorLine, cursorCol, options);
			}

			const search = agentSearchQuery(rawQuery);
			if (search === null) {
				return current.getSuggestions(lines, cursorLine, cursorCol, options);
			}

			const agents = getAgents();

			if (options.signal.aborted || agents.length === 0) {
				return current.getSuggestions(lines, cursorLine, cursorCol, options);
			}

			const [baseSuggestions, matches] = await Promise.all([
				current.getSuggestions(lines, cursorLine, cursorCol, options),
				Promise.resolve(search.trim() ? fuzzyFilter(agents, search, (a) => a.name) : agents),
			]);
			if (options.signal.aborted) return null;

			const agentItems: AutocompleteItem[] = matches.slice(0, MAX_SUGGESTIONS).map((agent) => ({
				value: subagentReferenceValue(agent.name),
				label: `[SubAgent] ${agent.displayName}`,
				description: `${agent.model ?? "?"} · ${agent.thinking ?? "?"}`,
			}));
			const prefix = `@${rawQuery}`;
			const hasCompatibleBaseSuggestions = baseSuggestions?.prefix === prefix;
			const agentValues = new Set(
				agents.flatMap((agent) => [`@${agent.name}`, subagentReferenceValue(agent.name)]),
			);
			const baseItems = hasCompatibleBaseSuggestions
				? baseSuggestions.items.filter((item) => !agentValues.has(item.value))
				: [];
			const seen = new Set<string>();
			const items = [...agentItems, ...baseItems].filter((item) => {
				const key = `${item.value}\0${item.label}`;
				if (seen.has(key)) return false;
				seen.add(key);
				return true;
			});

			if (items.length === 0 && !hasCompatibleBaseSuggestions) return baseSuggestions;
			return { items, prefix };
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
	let sessionGeneration = 0;

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
		const generation = ++sessionGeneration;
		const agents = getAgents();
		if (agents.length === 0 || ctx.mode !== "tui") return;

		// Register after other session_start handlers have installed their wrappers.
		// pi-fff handles every @ prefix and otherwise shadows providers loaded before it.
		setTimeout(() => {
			if (generation !== sessionGeneration) return;
			ctx.ui.addAutocompleteProvider((current) =>
				createAgentAutocompleteProvider(current, getAgents),
			);
		}, 0);
	});

	pi.on("session_shutdown", () => {
		sessionGeneration++;
	});

	// Inject as a request message, not systemPrompt, so the cached prefix stays stable.
	pi.on("before_agent_start", async (event, _ctx) => {
		const agents = getAgents();
		if (agents.length === 0) return;

		const mentions: string[] = [];
		for (const name of extractSubagentReferenceNames(event.prompt)) {
			if (agents.some((a) => a.name === name) && !mentions.includes(name)) {
				mentions.push(name);
			}
		}
		if (mentions.length === 0) return;

		const agentMap = new Map(agents.map((a) => [a.name, a]));
		const agentList = mentions.map((n) => `"${n}" (${agentMap.get(n)!.displayName})`).join(", ");

		return {
			message: {
				customType: SUBAGENT_DELEGATION_CUSTOM_TYPE,
				content:
					`The user's prompt references these subagent types: ${agentList}. ` +
					`You MUST use the Agent tool for EACH mentioned subagent to delegate the relevant parts of the request. ` +
					`Handle different subagents separately — do NOT merge their tasks into a single Agent call. ` +
					`For example, if the user mentions @subagent:[coder] and @subagent:[explore], make two separate Agent tool calls, one with subagent_type="coder" and another with subagent_type="explore".`,
				display: false,
			},
		};
	});
}
