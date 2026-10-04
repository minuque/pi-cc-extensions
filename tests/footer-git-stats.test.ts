import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	config,
	normalizeConfig,
	setConfig,
	type FooterGitStatsMode,
} from "../extensions/config/config.ts";
import { applyCustomFooter, refreshFooterGitStats } from "../extensions/feature/shell/footer.ts";
import {
	createGitStatsRefresher,
	readGitStats,
	type GitStats,
} from "../extensions/feature/shell/git-stats.ts";

function repository(t: test.TestContext, initialBranch = "main") {
	const cwd = mkdtempSync(join(tmpdir(), "pi-footer-git-"));
	t.after(() => rmSync(cwd, { recursive: true, force: true }));
	const git = (...args: string[]) =>
		execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
	git("init", "--template=", `--initial-branch=${initialBranch}`);
	git("config", "user.name", "Footer Test");
	git("config", "user.email", "footer@example.invalid");
	git("config", "commit.gpgsign", "false");
	git("config", "core.autocrlf", "false");
	git("config", "core.hooksPath", join(cwd, "no-hooks"));
	const write = (name: string, content: string) => writeFileSync(join(cwd, name), content);
	const commit = () => {
		git("add", ".");
		git("commit", "-m", "fixture");
	};
	write("source.txt", "one\ntwo\nthree\n");
	commit();
	return { cwd, git, write, commit };
}

test("working preserves HEAD-relative staged/unstaged net stats and excludes untracked files", async (t) => {
	const { cwd, git, write } = repository(t);
	git("switch", "-c", "feature");
	write("source.txt", "one\nchanged\nthree\n");
	git("add", "source.txt");
	write("source.txt", "one\nchanged\nthree\nfour\n");
	write("untracked.txt", "not counted\n");
	write("new.txt", "new line\n");
	git("add", "new.txt");
	assert.deepEqual(await readGitStats(cwd, "working"), { add: 3, del: 1 });
	assert.deepEqual(await readGitStats(cwd, "branch"), { add: 3, del: 1 });
	// Staged changes undone in the worktree must not be counted twice.
	write("source.txt", "one\ntwo\nthree\n");
	assert.deepEqual(await readGitStats(cwd, "working"), { add: 1, del: 0 });
});

test("branch includes committed new files and uncommitted edits, and remains stable across commit", async (t) => {
	const { cwd, git, write, commit } = repository(t);
	git("switch", "-c", "feature");
	write("source.txt", "one\nchanged\nthree\n");
	write("committed-test.txt", "test one\ntest two\n");
	commit();
	assert.deepEqual(await readGitStats(cwd, "working"), { add: 0, del: 0 });
	assert.deepEqual(await readGitStats(cwd, "branch"), { add: 3, del: 1 });
	write("source.txt", "one\nchanged\nthree\nextra\n");
	write("staged.txt", "staged line\n");
	git("add", "staged.txt");
	write("untracked.txt", "excluded\n");
	assert.deepEqual(await readGitStats(cwd, "branch"), { add: 5, del: 1 });
	git("add", "source.txt");
	git("commit", "-m", "commit tracked edits");
	assert.deepEqual(await readGitStats(cwd, "branch"), { add: 5, del: 1 });
});

test("branch counts net changes, not summed commits, and uses the merge base rather than base tip", async (t) => {
	const { cwd, git, write, commit } = repository(t);
	git("switch", "-c", "feature");
	write("source.txt", "one\nchanged\nthree\n");
	commit();
	write("source.txt", "one\ntwo\nthree\n");
	commit();
	git("switch", "main");
	write("main-only.txt", "unrelated main change\n");
	commit();
	git("switch", "feature");
	assert.deepEqual(await readGitStats(cwd, "branch"), { add: 0, del: 0 });
});

test("origin/HEAD takes priority over local main, never the feature upstream", async (t) => {
	const { cwd, git, write, commit } = repository(t);
	git("switch", "-c", "feature");
	write("feature.txt", "first\n");
	commit();
	git("update-ref", "refs/remotes/origin/develop", "HEAD");
	git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/develop");
	write("feature.txt", "first\nsecond\n");
	commit();
	git("remote", "add", "origin", "https://example.invalid/repo.git");
	git("update-ref", "refs/remotes/origin/feature", "HEAD");
	git("config", "branch.feature.remote", "origin");
	git("config", "branch.feature.merge", "refs/heads/feature");
	assert.deepEqual(await readGitStats(cwd, "branch"), { add: 1, del: 0 });
	// Re-resolve refs every time; advancing remote HEAD must not use a cached base.
	git("update-ref", "refs/remotes/origin/develop", "HEAD");
	assert.deepEqual(await readGitStats(cwd, "branch"), { add: 0, del: 0 });
});

test("dangling origin/HEAD falls back to local main, then master", async (t) => {
	const { cwd, git, write, commit } = repository(t, "master");
	git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/missing");
	git("switch", "-c", "feature");
	write("new.txt", "new\n");
	commit();
	assert.deepEqual(await readGitStats(cwd, "branch"), { add: 1, del: 0 });
	git("branch", "main", "HEAD");
	assert.deepEqual(await readGitStats(cwd, "branch"), { add: 0, del: 0 });
});

test("missing base, unborn HEAD and non-repositories hide stats without working fallback", async (t) => {
	const { cwd, git, write } = repository(t, "trunk");
	write("source.txt", "modified\n");
	assert.deepEqual(await readGitStats(cwd, "working"), { add: 1, del: 3 });
	assert.equal(await readGitStats(cwd, "branch"), undefined);
	const plain = join(cwd, "plain");
	mkdirSync(plain);
	git("init", "--template=", "--initial-branch=main", plain);
	assert.equal(await readGitStats(plain, "working"), undefined);
	assert.equal(await readGitStats(plain, "branch"), undefined);
	const nonRepo = mkdtempSync(join(tmpdir(), "pi-footer-no-git-"));
	t.after(() => rmSync(nonRepo, { recursive: true, force: true }));
	assert.equal(await readGitStats(nonRepo, "working"), undefined);
	assert.equal(await readGitStats(nonRepo, "branch"), undefined);
	assert.equal(git("branch", "--show-current"), "trunk");
});

test("unrelated base histories hide branch stats", async (t) => {
	const { cwd, git, write, commit } = repository(t);
	git("switch", "--orphan", "feature");
	write("orphan.txt", "new history\n");
	commit();
	assert.equal(await readGitStats(cwd, "branch"), undefined);
});

test("binary files and filenames resembling refs do not affect line sums", async (t) => {
	const { cwd, write, commit } = repository(t);
	write("HEAD", "a file, not a ref\n");
	write("binary.dat", "\0binary\n");
	commit();
	write("HEAD", "changed\n");
	write("binary.dat", "\0changed\nextra\n");
	assert.deepEqual(await readGitStats(cwd, "working"), { add: 1, del: 1 });
});

test("active footer switches working → branch → working without recreation or reload", async (t) => {
	const { cwd, git, write, commit } = repository(t);
	git("switch", "-c", "feature");
	write("committed.txt", "first\nsecond\n");
	commit();
	write("source.txt", "one\nchanged\nthree\n");
	const previous = { ...config };
	setConfig(normalizeConfig({ footerGitStatsMode: "working", footerNerdIcons: false }));
	t.after(() => setConfig(previous));
	let footer!: { render: (width: number) => string[]; dispose: () => void };
	let factoryCalls = 0;
	let branchChanged!: () => void;
	let unsubscribed = false;
	const ctx = {
		cwd,
		hasUI: true,
		getContextUsage: () => undefined,
		sessionManager: {
			getBranch: () => [],
			getEntries: () => [],
			getSessionName: () => undefined,
		},
		ui: {
			setFooter: (factory: (tui: unknown, theme: unknown, data: unknown) => typeof footer) => {
				factoryCalls++;
				footer = factory(
					{ requestRender: () => {} },
					{
						fg: (_color: string, text: string) => text,
						getThinkingBorderColor: () => (text: string) => text,
					},
					{
						getGitBranch: () => "feature",
						getExtensionStatuses: () => new Map(),
						onBranchChange: (callback: () => void) => {
							branchChanged = callback;
							return () => {
								unsubscribed = true;
							};
						},
					},
				);
			},
		},
	};
	applyCustomFooter(ctx as never);
	t.after(() => footer.dispose());
	const line = () => footer.render(200)[1];
	const waitForStats = async (stats: string) => {
		const deadline = Date.now() + 5000;
		while (!line().includes(stats)) {
			assert.ok(Date.now() < deadline, `Expected ${stats}, got ${line()}`);
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
	};
	await waitForStats("(+1 −1)");
	setConfig(normalizeConfig({ ...config, footerGitStatsMode: "branch" }));
	refreshFooterGitStats();
	assert.doesNotMatch(line(), /\(\+/);
	await waitForStats("(+3 −1)");
	setConfig(normalizeConfig({ ...config, footerGitStatsMode: "working" }));
	refreshFooterGitStats();
	await waitForStats("(+1 −1)");
	assert.equal(factoryCalls, 1);
	// A branch change must drop old numbers even if the mode stays the same.
	write("source.txt", "one\ntwo\nthree\n");
	git("switch", "main");
	branchChanged();
	assert.doesNotMatch(line(), /\(\+/);
	footer.dispose();
	assert.equal(unsubscribed, true);
});

function deferred() {
	let resolve!: (stats: GitStats | undefined) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<GitStats | undefined>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

function refresherFixture(t: test.TestContext) {
	let mode: FooterGitStatsMode = "working";
	const requests: Array<ReturnType<typeof deferred> & { mode: FooterGitStatsMode }> = [];
	const updates: Array<GitStats | undefined> = [];
	const refresher = createGitStatsRefresher({
		getMode: () => mode,
		query: (requestedMode) => {
			const request = { ...deferred(), mode: requestedMode };
			requests.push(request);
			return request.promise;
		},
		onChange: (stats) => updates.push(stats),
	});
	t.after(() => refresher.dispose());
	return { ...refresher, requests, updates, setMode: (next: FooterGitStatsMode) => (mode = next) };
}

test("mode changes clear old stats immediately and discard in-flight results", async (t) => {
	const f = refresherFixture(t);
	f.refresh();
	f.requests[0].resolve({ add: 15, del: 9 });
	await tick();
	f.refresh();
	f.setMode("branch");
	f.refresh(true);
	assert.deepEqual(f.updates, [{ add: 15, del: 9 }, undefined]);
	assert.equal(f.requests.length, 2);
	f.requests[1].resolve({ add: 16, del: 9 });
	await tick();
	assert.equal(f.requests[2].mode, "branch");
	assert.deepEqual(f.updates, [{ add: 15, del: 9 }, undefined]);
	f.requests[2].resolve({ add: 75, del: 9 });
	await tick();
	assert.deepEqual(f.updates, [{ add: 15, del: 9 }, undefined, { add: 75, del: 9 }]);
});

test("branch resets and overlapping tool refreshes queue just one latest query", async (t) => {
	const f = refresherFixture(t);
	f.refresh();
	f.refresh(true);
	f.refresh();
	f.refresh();
	assert.equal(f.requests.length, 1);
	f.requests[0].resolve({ add: 99, del: 0 });
	await tick();
	assert.equal(f.requests.length, 2);
	assert.deepEqual(f.updates, []);
	f.requests[1].resolve({ add: 1, del: 0 });
	await tick();
	assert.deepEqual(f.updates, [{ add: 1, del: 0 }]);
});

test("unchanged polls avoid repaint, failures clear stats and later queries recover", async (t) => {
	const f = refresherFixture(t);
	f.refresh();
	f.requests[0].resolve({ add: 1, del: 0 });
	await tick();
	f.refresh();
	f.requests[1].resolve({ add: 1, del: 0 });
	await tick();
	assert.equal(f.updates.length, 1);
	f.refresh();
	f.requests[2].reject(new Error("timeout"));
	await tick();
	assert.deepEqual(f.updates, [{ add: 1, del: 0 }, undefined]);
	f.refresh();
	f.requests[3].resolve(undefined);
	await tick();
	assert.equal(f.updates.length, 2);
	f.refresh();
	f.requests[4].resolve({ add: 2, del: 1 });
	await tick();
	assert.deepEqual(f.updates.at(-1), { add: 2, del: 1 });
});

test("disposed footers neither publish nor start queued queries", async (t) => {
	const f = refresherFixture(t);
	f.refresh();
	f.refresh();
	f.dispose();
	f.dispose();
	f.requests[0].resolve({ add: 1, del: 0 });
	await tick();
	f.refresh();
	assert.equal(f.requests.length, 1);
	assert.deepEqual(f.updates, []);
});
