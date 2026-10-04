import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { FooterGitStatsMode } from "../../config/config.ts";

export type GitStats = { add: number; del: number };

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

/** Read only local refs and tracked files; never fetch or change the index. */
export async function readGitStats(
	cwd: string,
	mode: FooterGitStatsMode,
): Promise<GitStats | undefined> {
	const git = async (args: string[]) => {
		const { stdout } = await execFileAsync("git", args, { cwd, timeout: 2000 });
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
					// Missing/dangling remote HEAD: try the local default branches.
				}
			}
			if (!baseCommit) return undefined;
			base = await git(["merge-base", "HEAD", baseCommit]);
		}
		// One comparison includes committed + staged + unstaged net changes,
		// without double-counting edits that are later reverted. Untracked files are excluded.
		return parseGitStats(await git(["diff", "--numstat", base, "--"]));
	} catch {
		// Non-repository, unborn HEAD, unrelated histories, timeout, etc.
		return undefined;
	}
}

/** Coalesce overlapping refreshes and reject stale results after a mode/branch change. */
export function createGitStatsRefresher(options: {
	getMode: () => FooterGitStatsMode;
	query: (mode: FooterGitStatsMode) => Promise<GitStats | undefined>;
	onChange: (stats: GitStats | undefined) => void;
}): { refresh: (reset?: boolean) => void; dispose: () => void } {
	let stats: GitStats | undefined;
	let mode = options.getMode();
	let generation = 0;
	let running = false;
	let pending = false;
	let disposed = false;
	const publish = (next: GitStats | undefined) => {
		if (stats?.add === next?.add && stats?.del === next?.del) return;
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
		void (async () => {
			let next: GitStats | undefined;
			try {
				next = await options.query(nextMode);
			} catch {
				// Failed queries clear the old numbers rather than leaving a stale chip.
			} finally {
				if (!disposed && request === generation && nextMode === options.getMode()) publish(next);
				running = false;
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
		},
	};
}
