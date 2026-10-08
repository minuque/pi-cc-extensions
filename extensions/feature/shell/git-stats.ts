import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { FooterGitStatsMode } from "../../config/config.ts";

export type GitStats = { add: number; del: number; status?: string };

const execFileAsync = promisify(execFile);
const BRANCH_BASE_REFS = ["refs/remotes/origin/HEAD", "refs/heads/main", "refs/heads/master"];

export function parseGitStats(stdout: string): GitStats {
	let add = 0;
	let del = 0;
	for (const line of stdout.split("\n")) {
		const match = line.match(/^(\d+)\s+(\d+)/);
		if (match) {
			add += Number(match[1]);
			del += Number(match[2]);
		}
	}
	return { add, del };
}

const CONFLICT_CODES = new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]);

/**
 * git status --porcelain --branch 的第一行带分支头（## branch...origin/branch [ahead N, behind M]），
 * 其余行是 XY 文件状态。返回 Starship 风格的状态符号串（= ! ? ⇡⇣），无变化时 undefined。
 */
export function parseGitStatus(stdout: string): string | undefined {
	let conflicted = false;
	let modified = false;
	let untracked = false;
	let ahead: number | undefined;
	let behind: number | undefined;
	for (const line of stdout.split("\n")) {
		if (line.startsWith("## ")) {
			ahead = Number(line.match(/ahead (\d+)/)?.[1]) || undefined;
			behind = Number(line.match(/behind (\d+)/)?.[1]) || undefined;
			continue;
		}
		const code = line.slice(0, 2);
		if (code === "??") untracked = true;
		else if (CONFLICT_CODES.has(code)) {
			// 冲突文件必然也有未提交内容，! 与 = 同时出现
			conflicted = true;
			modified = true;
		} else if (line.trim()) modified = true;
	}
	let status = "";
	if (conflicted) status += "=";
	if (modified) status += "!";
	if (untracked) status += "?";
	if (ahead) status += `⇡${ahead}`;
	if (behind) status += `⇣${behind}`;
	return status || undefined;
}

/** Read only local refs and tracked files; never fetch or change the index. */
export async function readGitStats(
	cwd: string,
	mode: FooterGitStatsMode,
	signal?: AbortSignal,
): Promise<GitStats | undefined> {
	const git = async (args: string[]) => {
		const { stdout } = await execFileAsync("git", args, {
			cwd,
			timeout: 2000,
			maxBuffer: 16 * 1024 * 1024,
			signal,
		});
		return stdout.trim();
	};
	try {
		let base = "HEAD";
		if (mode === "branch") {
			let baseCommit: string | undefined;
			for (const ref of BRANCH_BASE_REFS) {
				try {
					baseCommit = await git(["rev-parse", "--verify", `${ref}^{commit}`]);
					break;
				} catch {
					if (signal?.aborted) return undefined;
					// Missing/dangling remote HEAD: try the local default branches.
				}
			}
			if (!baseCommit) return undefined;
			base = await git(["merge-base", "HEAD", baseCommit]);
		}
		// One comparison includes committed + staged + unstaged net changes,
		// without double-counting edits that are later reverted. Untracked files are excluded.
		const [numstat, statusOut] = await Promise.all([
			git(["diff", "--numstat", base, "--"]),
			git(["status", "--porcelain", "--branch"]).catch(() => ""),
		]);
		if (signal?.aborted) return undefined;
		const stats = parseGitStats(numstat);
		const status = parseGitStatus(statusOut);
		return status ? { ...stats, status } : stats;
	} catch {
		// Non-repository, unborn HEAD, unrelated histories, timeout, etc.
		return undefined;
	}
}

/** Coalesce overlapping refreshes and reject stale results after a mode/branch change. */
export function createGitStatsRefresher(options: {
	getMode: () => FooterGitStatsMode;
	query: (mode: FooterGitStatsMode, signal: AbortSignal) => Promise<GitStats | undefined>;
	onChange: (stats: GitStats | undefined) => void;
}): { refresh: (reset?: boolean) => void; dispose: () => void } {
	let stats: GitStats | undefined;
	let mode = options.getMode();
	let generation = 0;
	let running = false;
	let pending = false;
	let disposed = false;
	let controller: AbortController | undefined;
	const publish = (next: GitStats | undefined) => {
		if (stats?.add === next?.add && stats?.del === next?.del && stats?.status === next?.status)
			return;
		stats = next;
		options.onChange(next);
	};
	const refresh = (reset = false) => {
		if (disposed) return;
		const nextMode = options.getMode();
		if (reset || mode !== nextMode) publish(undefined);
		mode = nextMode;
		const request = ++generation;
		if (running) {
			pending = true;
			return;
		}
		running = true;
		const queryController = new AbortController();
		controller = queryController;
		void (async () => {
			let next: GitStats | undefined;
			try {
				next = await options.query(nextMode, queryController.signal);
			} catch {
				// Failed queries clear the old numbers rather than leaving a stale chip.
			} finally {
				if (!disposed && request === generation && nextMode === options.getMode()) publish(next);
				running = false;
				controller = undefined;
				if (pending && !disposed) {
					pending = false;
					refresh();
				}
			}
		})();
	};
	return {
		refresh,
		dispose: () => {
			disposed = true;
			generation++;
			controller?.abort();
		},
	};
}
