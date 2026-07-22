import { resolve } from "node:path";
import {
	SessionManager,
	type ExtensionAPI,
	type SessionInfo,
} from "@earendil-works/pi-coding-agent";
import {
	Text,
	type AutocompleteItem,
	type AutocompleteProvider,
	type AutocompleteSuggestions,
	fuzzyFilter,
} from "@earendil-works/pi-tui";
import {
	SESSION_REFERENCE_CUSTOM_TYPE,
	SESSION_REFERENCE_PREFIX,
	buildReferenceContentFromSections,
	extractSessionReferenceIds,
	formatReferenceSession,
	sessionTitle,
	type ReferenceSessionInfo,
	type ReferenceSource,
} from "./core.ts";

const MAX_SESSION_SUGGESTIONS = 5;
const MAX_FILE_SUGGESTIONS = 10;
const MAX_REFERENCED_SESSIONS = 5;
const MENTION_PATTERN = /(?:^|[\t ])@([^\s@]*)$/;
const SUBAGENT_MANAGER_KEY = Symbol.for("pi-subagents:manager");

// ── In-process subagent record tracker ──────────────────────────────
// pi-subagents does not expose a global manager; we track records
// ourselves by listening to the events it emits.

type SubagentLiveRecord = {
	runId: string;
	sessionId: string;
	agent: string;
	cwd: string;
	startedAt: number;
	completedAt?: number;
};

type ReferenceDetails = {
	sessions: Array<{ id: string; title: string; cwd: string }>;
};

type SessionReference = {
	kind: "session" | "subagent";
	referenceIds: string[];
	info: ReferenceSessionInfo;
	path?: string;
	messages?: unknown[];
};

type SubagentRecord = {
	id: string;
	description?: string;
	startedAt?: number;
	completedAt?: number;
};

type SubagentManager = {
	getRecord(id: string): SubagentRecord | undefined;
};

// Local subagent record tracking (pi-subagents does not expose a global manager).
const liveSubagentRecords = new Map<string, SubagentLiveRecord>();

function trackSubagentFromEvent(data: unknown): void {
	if (!data || typeof data !== "object") return;
	const event = data as Record<string, unknown>;
	// subagent:async-started payload has "id" as the run ID
	// subagent:async-complete payload has "runId" as the run ID
	const runId = (typeof event.id === "string" ? event.id : undefined)
		?? (typeof event.runId === "string" ? event.runId : undefined);
	if (!runId) return;
	const sessionId = typeof event.sessionId === "string" ? event.sessionId : undefined;
	if (!sessionId) return;

	const existing = liveSubagentRecords.get(runId);
	if (existing) {
		// Completion event — mark completedAt
		if (typeof event.endedAt === "number" || typeof event.lastUpdate === "number") {
			existing.completedAt = (typeof event.endedAt === "number" ? event.endedAt : event.lastUpdate) as number;
		}
		return;
	}
	// Started event — create new record
	const agent = typeof event.agent === "string" ? event.agent : "";
	const cwd = typeof event.cwd === "string" ? event.cwd : "";
	const startedAt = typeof event.startedAt === "number" ? event.startedAt as number : Date.now();
	liveSubagentRecords.set(runId, {
		runId,
		sessionId,
		agent,
		cwd,
		startedAt,
	});
}

function getSubagentManager(): SubagentManager | undefined {
	// Try the global manager first (future-proof), fall back to local records.
	const manager = (globalThis as any)[SUBAGENT_MANAGER_KEY] as SubagentManager | undefined;
	if (manager && typeof manager.getRecord === "function") return manager;
	// If no global manager, use our local tracking.
	if (liveSubagentRecords.size === 0) return undefined;
	return {
		getRecord(id: string): SubagentRecord | undefined {
			const record = liveSubagentRecords.get(id);
			if (!record) return undefined;
			return {
				id: record.runId,
				description: record.agent || undefined,
				startedAt: record.startedAt,
				completedAt: record.completedAt,
			};
		},
	};
}

function extractMentionQuery(textBeforeCursor: string): string | undefined {
	return textBeforeCursor.match(MENTION_PATTERN)?.[1];
}

function formatDate(date: Date): string {
	return new Intl.DateTimeFormat(undefined, {
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	}).format(date);
}

function sessionSearchText(reference: SessionReference): string {
	return [
		reference.info.name,
		reference.info.firstMessage,
		reference.info.cwd,
		reference.info.id,
		...reference.referenceIds,
	].filter(Boolean).join(" ");
}

function sessionItem(reference: SessionReference, currentCwd: string): AutocompleteItem {
	const session = reference.info;
	const workspace = samePath(session.cwd, currentCwd) ? "current workspace" : session.cwd || "unknown workspace";
	const label = reference.kind === "subagent" ? "[SubAgent]" : "[Session]";
	return {
		value: `${SESSION_REFERENCE_PREFIX}${reference.referenceIds[0]}`,
		label: `${label} ${sessionTitle(session)}`,
		description: `${workspace} · ${session.messageCount} messages · ${formatDate(session.modified)}`,
	};
}

function filterSessions(references: SessionReference[], query: string, currentCwd: string): AutocompleteItem[] {
	if (query.startsWith("session:")) return [];

	const ordered = [...references].sort((left, right) => {
		const leftLocal = samePath(left.info.cwd, currentCwd) ? 1 : 0;
		const rightLocal = samePath(right.info.cwd, currentCwd) ? 1 : 0;
		return rightLocal - leftLocal || right.info.modified.getTime() - left.info.modified.getTime();
	});
	const matches = query.trim()
		? fuzzyFilter(ordered, query, sessionSearchText)
		: ordered;
	return matches.slice(0, MAX_SESSION_SUGGESTIONS).map((reference) => sessionItem(reference, currentCwd));
}

function liveSubagentReferences(agentIds: Set<string>, currentSessionId: string): SessionReference[] {
	const manager = getSubagentManager();
	if (!manager) return [];

	const references: SessionReference[] = [];
	for (const agentId of agentIds) {
		const record = manager.getRecord(agentId);
		if (!record) continue;

		// Try the global manager's live session first (future-proof).
		const liveRecord = liveSubagentRecords.get(agentId);
		const sessionId = liveRecord?.sessionId ?? record.id;
		if (!sessionId || sessionId === currentSessionId) continue;

		const name = record.description?.trim() || liveRecord?.agent || undefined;
		const modifiedAt = record.completedAt ?? record.startedAt ?? Date.now();
		references.push({
			kind: "subagent",
			referenceIds: [sessionId, agentId],
			info: {
				id: sessionId,
				name,
				cwd: liveRecord?.cwd ?? "",
				firstMessage: "",
				messageCount: 0,
				modified: new Date(modifiedAt),
			},
		});
	}
	return references;
}

function mergeReferences(sessions: SessionInfo[], subagents: SessionReference[]): SessionReference[] {
	const bySessionId = new Map<string, SessionReference>();
	for (const session of sessions) {
		bySessionId.set(session.id, {
			kind: "session",
			referenceIds: [session.id],
			info: session,
			path: session.path,
		});
	}
	for (const subagent of subagents) {
		// Prefer the live subagent context when a persisted subagent has the same ID.
		bySessionId.set(subagent.info.id, subagent);
	}
	return [...bySessionId.values()];
}

export function createAutocompleteProvider(
	current: AutocompleteProvider,
	getReferences: () => Promise<SessionReference[]>,
	currentCwd: string,
): AutocompleteProvider {
	return {
		triggerCharacters: ["@"],
		async getSuggestions(lines, cursorLine, cursorCol, options): Promise<AutocompleteSuggestions | null> {
			const currentLine = lines[cursorLine] ?? "";
			const query = extractMentionQuery(currentLine.slice(0, cursorCol));
			if (query === undefined) {
				return current.getSuggestions(lines, cursorLine, cursorCol, options);
			}

			const [baseSuggestions, references] = await Promise.all([
				current.getSuggestions(lines, cursorLine, cursorCol, options),
				getReferences(),
			]);
			if (options.signal.aborted) return null;

			const sessionItems = filterSessions(references, query, currentCwd);
			const fileItems = (baseSuggestions?.items ?? []).slice(0, MAX_FILE_SUGGESTIONS);
			const items = [...sessionItems, ...fileItems];
			if (items.length === 0) return null;
			return { prefix: `@${query}`, items };
		},

		applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
			return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
		},

		shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
			return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
		},
	};
}

function samePath(left: string | undefined, right: string): boolean {
	if (!left) return false;
	const normalizedLeft = resolve(left);
	const normalizedRight = resolve(right);
	return process.platform === "win32"
		? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
		: normalizedLeft === normalizedRight;
}

export default function sessionReferenceExtension(pi: ExtensionAPI): void {
	let getAvailableReferences: (() => Promise<SessionReference[]>) | undefined;
	let sessionGeneration = 0;
	const subagentIds = new Set<string>();
	// pi-subagents emits "subagent:async-started" and "subagent:async-complete" events.
	// We track records locally so @[SubAgent] suggestions work even without a global manager.
	const subagentEventNames = ["subagent:async-started", "subagent:async-complete"];
	const unsubscribeSubagentEvents = subagentEventNames.map(
		(eventName) =>
			pi.events.on(eventName, (data) => {
				trackSubagentFromEvent(data);
				if (!data || typeof data !== "object") return;
				const payload = data as Record<string, unknown>;
				// subagent:async-started uses "id", subagent:async-complete uses "runId"
				const id = (typeof payload.id === "string" ? payload.id : undefined)
					?? (typeof payload.runId === "string" ? payload.runId : undefined);
				if (typeof id === "string" && id) subagentIds.add(id);
			}),
	);

	pi.registerMessageRenderer(SESSION_REFERENCE_CUSTOM_TYPE, (message, _options, theme) => {
		const details = message.details as ReferenceDetails | undefined;
		const sessions = details?.sessions ?? [];
		const labels = sessions.map((session) => session.title).join(", ");
		const summary = sessions.length === 1 ? "Referenced 1 session" : `Referenced ${sessions.length} sessions`;
		const text = labels ? `${theme.fg("accent", summary)}\n${theme.fg("dim", labels)}` : summary;
		return new Text(text, 1, 0);
	});

	pi.on("session_start", (_event, ctx) => {
		const generation = ++sessionGeneration;
		subagentIds.clear();
		let loadErrorShown = false;
		const currentSessionId = ctx.sessionManager.getSessionId();
		const currentSessionFile = ctx.sessionManager.getSessionFile();
		let sessionsPromise: Promise<SessionInfo[]> | undefined;

		const getSessions = (): Promise<SessionInfo[]> => {
			sessionsPromise ||= SessionManager.listAll()
				.then((sessions) =>
					sessions.filter(
						(session) => session.id !== currentSessionId && !samePath(currentSessionFile, session.path),
					),
				)
				.catch((error: unknown) => {
					if (!loadErrorShown) {
						loadErrorShown = true;
						const reason = error instanceof Error ? error.message : String(error);
						ctx.ui.notify(`session-reference: failed to load sessions: ${reason}`, "error");
					}
					return [];
				});
			return sessionsPromise;
		};

		const getReferences = async (): Promise<SessionReference[]> =>
			mergeReferences(await getSessions(), liveSubagentReferences(subagentIds, currentSessionId));

		getAvailableReferences = getReferences;
		if (ctx.mode === "tui") {
			void getReferences();
			// Register after other session_start handlers. pi-fff claims every @
			// prefix, so a provider installed before it would never see session mentions.
			setTimeout(() => {
				if (generation !== sessionGeneration) return;
				ctx.ui.addAutocompleteProvider((current) =>
					createAutocompleteProvider(current, getReferences, ctx.cwd),
				);
			}, 0);
		}
	});

	pi.on("before_agent_start", async (event, ctx) => {
		const referenceIds = extractSessionReferenceIds(event.prompt);
		if (referenceIds.length === 0) return;

		const currentSessionId = ctx.sessionManager.getSessionId();
		const references = await (
			getAvailableReferences?.() ??
			SessionManager.listAll().then((sessions) =>
				mergeReferences(
					sessions.filter((session) => session.id !== currentSessionId),
					liveSubagentReferences(subagentIds, currentSessionId),
				),
			)
		);
		const referencesById = new Map<string, SessionReference>();
		for (const reference of references) {
			for (const id of reference.referenceIds) referencesById.set(id, reference);
		}
		const seenReferences = new Set<SessionReference>();
		const matchingReferences = referenceIds
			.map((id) => referencesById.get(id))
			.filter((reference): reference is SessionReference => {
				if (!reference || reference.info.id === currentSessionId || seenReferences.has(reference)) return false;
				seenReferences.add(reference);
				return true;
			});
		const selected = matchingReferences.slice(0, MAX_REFERENCED_SESSIONS);

		if (selected.length === 0) {
			ctx.ui.notify("session-reference: referenced sessions were not found", "warning");
			return;
		}

		if (matchingReferences.length > MAX_REFERENCED_SESSIONS) {
			ctx.ui.notify(`session-reference: only the first ${MAX_REFERENCED_SESSIONS} sessions were included`, "warning");
		}

		const sections: string[] = [];
		const referencedSessions: ReferenceDetails["sessions"] = [];
		for (const reference of selected) {
			try {
				const info = reference.info;
				const messages = reference.messages ?? (
					reference.path
						? SessionManager.open(reference.path).buildSessionContext().messages
						: (() => {
							throw new Error("reference session is no longer available");
						})()
				);
				const source: ReferenceSource = { info, messages };
				sections.push(formatReferenceSession(source));
				referencedSessions.push({
					id: info.id,
					title: sessionTitle(info),
					cwd: info.cwd,
				});
			} catch (error) {
				const reason = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`session-reference: failed to read ${reference.info.id}: ${reason}`, "warning");
			}
		}
		if (sections.length === 0) return;

		const details: ReferenceDetails = { sessions: referencedSessions };
		return {
			message: {
				customType: SESSION_REFERENCE_CUSTOM_TYPE,
				content: buildReferenceContentFromSections(sections),
				display: true,
				details,
			},
		};
	});

	pi.on("session_before_switch", () => {
		subagentIds.clear();
		getAvailableReferences = undefined;
	});

	pi.on("session_shutdown", () => {
		sessionGeneration++;
		for (const unsubscribe of unsubscribeSubagentEvents) unsubscribe();
		subagentIds.clear();
		getAvailableReferences = undefined;
	});
}
