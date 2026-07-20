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
} from "./core.ts";

const MAX_SESSION_SUGGESTIONS = 10;
const MAX_FILE_SUGGESTIONS = 10;
const MAX_REFERENCED_SESSIONS = 5;
const MENTION_PATTERN = /(?:^|[\t ])@([^\s@]*)$/;

type ReferenceDetails = {
	sessions: Array<{ id: string; title: string; cwd: string }>;
};

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

function sessionSearchText(session: SessionInfo): string {
	return [session.name, session.firstMessage, session.cwd, session.id].filter(Boolean).join(" ");
}

function sessionItem(session: SessionInfo, currentCwd: string): AutocompleteItem {
	const workspace = samePath(session.cwd, currentCwd) ? "current workspace" : session.cwd || "unknown workspace";
	return {
		value: `${SESSION_REFERENCE_PREFIX}${session.id}`,
		label: `[Session] ${sessionTitle(session)}`,
		description: `${workspace} · ${session.messageCount} messages · ${formatDate(session.modified)}`,
	};
}

function filterSessions(sessions: SessionInfo[], query: string, currentCwd: string): AutocompleteItem[] {
	if (query.startsWith("session:")) return [];

	const ordered = [...sessions].sort((left, right) => {
		const leftLocal = samePath(left.cwd, currentCwd) ? 1 : 0;
		const rightLocal = samePath(right.cwd, currentCwd) ? 1 : 0;
		return rightLocal - leftLocal || right.modified.getTime() - left.modified.getTime();
	});
	const matches = query.trim()
		? fuzzyFilter(ordered, query, sessionSearchText)
		: ordered;
	return matches.slice(0, MAX_SESSION_SUGGESTIONS).map((session) => sessionItem(session, currentCwd));
}

function createAutocompleteProvider(
	current: AutocompleteProvider,
	getSessions: () => Promise<SessionInfo[]>,
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

			const [baseSuggestions, sessions] = await Promise.all([
				current.getSuggestions(lines, cursorLine, cursorCol, options),
				getSessions(),
			]);
			if (options.signal.aborted) return null;

			const sessionItems = filterSessions(sessions, query, currentCwd);
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
	let getAvailableSessions: (() => Promise<SessionInfo[]>) | undefined;

	pi.registerMessageRenderer(SESSION_REFERENCE_CUSTOM_TYPE, (message, _options, theme) => {
		const details = message.details as ReferenceDetails | undefined;
		const sessions = details?.sessions ?? [];
		const labels = sessions.map((session) => session.title).join(", ");
		const summary = sessions.length === 1 ? "Referenced 1 session" : `Referenced ${sessions.length} sessions`;
		const text = labels ? `${theme.fg("accent", summary)}\n${theme.fg("dim", labels)}` : summary;
		return new Text(text, 1, 0);
	});

	pi.on("session_start", (_event, ctx) => {
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

		getAvailableSessions = getSessions;
		if (ctx.mode === "tui") {
			void getSessions();
			ctx.ui.addAutocompleteProvider((current) => createAutocompleteProvider(current, getSessions, ctx.cwd));
		}
	});

	pi.on("before_agent_start", async (event, ctx) => {
		const referenceIds = extractSessionReferenceIds(event.prompt);
		if (referenceIds.length === 0) return;

		const currentSessionId = ctx.sessionManager.getSessionId();
		const sessions = await (getAvailableSessions?.() ?? SessionManager.listAll());
		const sessionsById = new Map(sessions.map((session) => [session.id, session]));
		const matchingSessions = referenceIds
			.filter((id) => id !== currentSessionId)
			.map((id) => sessionsById.get(id))
			.filter((session): session is SessionInfo => session !== undefined);
		const selected = matchingSessions.slice(0, MAX_REFERENCED_SESSIONS);

		if (selected.length === 0) {
			ctx.ui.notify("session-reference: referenced sessions were not found", "warning");
			return;
		}

		if (matchingSessions.length > MAX_REFERENCED_SESSIONS) {
			ctx.ui.notify(`session-reference: only the first ${MAX_REFERENCED_SESSIONS} sessions were included`, "warning");
		}

		const sections: string[] = [];
		const referencedSessions: ReferenceDetails["sessions"] = [];
		for (const session of selected) {
			try {
				const source = SessionManager.open(session.path);
				sections.push(
					formatReferenceSession({ info: session, messages: source.buildSessionContext().messages }),
				);
				referencedSessions.push({
					id: session.id,
					title: sessionTitle(session),
					cwd: session.cwd,
				});
			} catch (error) {
				const reason = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`session-reference: failed to read ${session.id}: ${reason}`, "warning");
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
}
