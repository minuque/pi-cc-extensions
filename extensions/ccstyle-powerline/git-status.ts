import { spawn } from "node:child_process";
import type { GitStatus } from "./types.ts";

interface CachedGitStatus {
  staged: number;
  unstaged: number;
  untracked: number;
  added: number;
  deleted: number;
  timestamp: number;
}

interface CachedBranch {
  branch: string | null;
  timestamp: number;
}

export type GitPollingMode = "full" | "branch" | "off";

const CACHE_TTL_MS = 1000; // 1 second for file status
const BRANCH_TTL_MS = 500; // Shorter TTL so branch updates quickly after invalidation
let cachedStatus: CachedGitStatus | null = null;
let cachedBranch: CachedBranch | null = null;
let statusCwd: string | null = null;
let branchCwd: string | null = null;
let pendingFetch: Promise<void> | null = null;
let pendingBranchFetch: Promise<void> | null = null;
let fetchCwd: string | null = null;
let branchFetchCwd: string | null = null;
let invalidationCounter = 0; // Track invalidations to prevent stale updates
let branchInvalidationCounter = 0;

/**
 * Parse git status --porcelain output.
 *
 * Format: XY filename
 * X = index status, Y = working tree status
 * ?? = untracked
 *
 * Each file is counted exactly once:
 * - Y ≠ ' ' → unstaged (working tree has changes; if X also shows staged, Y wins)
 * - X ≠ ' ' && X ≠ '?' → staged only (index has changes, working tree is clean)
 */
function parseGitStatusOutput(output: string): { staged: number; unstaged: number; untracked: number } {
  let staged = 0;
  let unstaged = 0;
  let untracked = 0;

  for (const line of output.split("\n")) {
    if (!line) continue;
    const x = line[0];
    const y = line[1];

    if (x === "?" && y === "?") {
      untracked++;
      continue;
    }

    // Y position (working tree) takes priority — if the file has working-tree
    // changes at all, count it as unstaged.
    if (y && y !== " ") {
      unstaged++;
    } else if (x && x !== " " && x !== "?") {
      // X position (index) only counted when working tree is clean.
      staged++;
    }
  }

  return { staged, unstaged, untracked };
}

function runGit(args: string[], cwd: string, timeoutMs = 200): Promise<string | null> {
  return new Promise((resolve) => {
    const proc = spawn("git", args, {
      stdio: ["ignore", "pipe", "pipe"],
      cwd,
    });

    let stdout = "";
    let resolved = false;

    const finish = (result: string | null) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeoutId);
      resolve(result);
    };

    proc.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    proc.on("close", (code) => {
      finish(code === 0 ? stdout.replace(/\n+$/, "") : null);
    });

    proc.on("error", () => {
      finish(null);
    });

    const timeoutId = setTimeout(() => {
      proc.kill();
      finish(null);
    }, timeoutMs);
  });
}

/**
 * Fetch current git branch asynchronously.
 * For detached HEAD, returns the short commit SHA (matches provider's "detached" behavior).
 */
async function fetchGitBranch(cwd: string): Promise<string | null> {
  const branch = await runGit(["branch", "--show-current"], cwd);
  if (branch === null) return null;
  if (branch) return branch;

  const sha = await runGit(["rev-parse", "--short", "HEAD"], cwd);
  return sha ? `${sha} (detached)` : "detached";
}

/**
 * Parse git diff --shortstat HEAD output.
 * Format: " N files changed, M insertions(+), K deletions(-)"
 */
function parseDiffStat(output: string): { added: number; deleted: number } {
  const added = (output.match(/(\d+) insertion/) ?? [])[1];
  const deleted = (output.match(/(\d+) deletion/) ?? [])[1];
  return {
    added: added ? Number(added) : 0,
    deleted: deleted ? Number(deleted) : 0,
  };
}

/**
 * Fetch line-level diff stats (additions / deletions) from HEAD.
 */
async function fetchDiffStat(cwd: string): Promise<{ added: number; deleted: number } | null> {
  const output = await runGit(["diff", "--shortstat", "HEAD"], cwd, 1000);
  if (output === null) return null;
  return parseDiffStat(output);
}

/**
 * Get the current git branch with caching.
 * Falls back to provider branch if our cache is empty.
 */
export function getCurrentBranch(providerBranch: string | null, cwd: string): string | null {
  const now = Date.now();

  // Invalidate cache if cwd changed (different repo)
  if (branchCwd !== cwd) {
    cachedBranch = null;
    branchCwd = cwd;
  }

  // Return cached if fresh
  if (cachedBranch && now - cachedBranch.timestamp < BRANCH_TTL_MS) {
    return cachedBranch.branch;
  }

  // Trigger background fetch if not already pending
  if (!pendingBranchFetch) {
    const fetchId = branchInvalidationCounter;
    branchFetchCwd = cwd;
    pendingBranchFetch = fetchGitBranch(cwd).then((result) => {
      // Cache result if no invalidation happened AND cwd hasn't changed
      if (fetchId === branchInvalidationCounter && branchFetchCwd === cwd) {
        cachedBranch = {
          branch: result,
          timestamp: Date.now(),
        };
      }
      pendingBranchFetch = null;
    });
  }

  // Return stale cache while refreshing; only use provider before first fetch
  return cachedBranch ? cachedBranch.branch : providerBranch;
}

/**
 * Get git status with caching.
 * Returns cached value if within TTL, otherwise triggers async fetch.
 * This is designed for synchronous render() calls - returns last known value
 * while refreshing in background.
 */
export function getGitStatus(providerBranch: string | null, cwd: string, pollingMode: GitPollingMode = "full"): GitStatus {
  const now = Date.now();
  const branch = pollingMode === "off" ? providerBranch : getCurrentBranch(providerBranch, cwd);

  if (pollingMode !== "full") {
    return { branch, staged: 0, unstaged: 0, untracked: 0, added: 0, deleted: 0 };
  }

  // Invalidate cache if cwd changed (different repo)
  if (statusCwd !== cwd) {
    cachedStatus = null;
    statusCwd = cwd;
  }

  // Return cached if fresh
  if (cachedStatus && now - cachedStatus.timestamp < CACHE_TTL_MS) {
    return { 
      branch, 
      staged: cachedStatus.staged,
      unstaged: cachedStatus.unstaged,
      untracked: cachedStatus.untracked,
      added: cachedStatus.added,
      deleted: cachedStatus.deleted,
    };
  }

  // Trigger background fetch if not already pending
  if (!pendingFetch) {
    const fetchId = invalidationCounter; // Capture current counter
    fetchCwd = cwd;
    pendingFetch = Promise.all([
      fetchGitStatus(cwd),
      fetchDiffStat(cwd),
    ]).then(([statusResult, diffResult]) => {
      // Cache result if no invalidation happened AND cwd hasn't changed
      if (fetchId === invalidationCounter && fetchCwd === cwd) {
        cachedStatus = statusResult
          ? {
              staged: statusResult.staged,
              unstaged: statusResult.unstaged,
              untracked: statusResult.untracked,
              added: diffResult?.added ?? 0,
              deleted: diffResult?.deleted ?? 0,
              timestamp: Date.now(),
            }
          : {
              staged: 0,
              unstaged: 0,
              untracked: 0,
              added: 0,
              deleted: 0,
              timestamp: Date.now(),
            };
      }
      pendingFetch = null;
    });
  }

  // Return last cached or empty
  if (cachedStatus) {
    return { 
      branch, 
      staged: cachedStatus.staged,
      unstaged: cachedStatus.unstaged,
      untracked: cachedStatus.untracked,
      added: cachedStatus.added,
      deleted: cachedStatus.deleted,
    };
  }

  return { branch, staged: 0, unstaged: 0, untracked: 0, added: 0, deleted: 0 };
}

/**
 * Force refresh git status (call when you know files changed)
 */
export function invalidateGitStatus(): void {
  cachedStatus = null;
  invalidationCounter++; // Increment to invalidate any pending fetches
}

/**
 * Force refresh git branch (call when you know branch might have changed)
 */
export function invalidateGitBranch(): void {
  cachedBranch = null;
  branchInvalidationCounter++;
}
