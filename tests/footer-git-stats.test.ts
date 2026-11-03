import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseGitStatus, readGitStats } from "../extensions/feature/shell/git-stats.ts";
import { repository } from "./helpers/git-repo.ts";

test("working preserves HEAD-relative staged/unstaged net stats and excludes untracked files", async (t) => {
	const { cwd, git, write } = repository(t);
	git("switch", "-c", "feature");
	write("source.txt", "one\nchanged\nthree\n");
	git("add", "source.txt");
	write("source.txt", "one\nchanged\nthree\nfour\n");
	write("untracked.txt", "not counted\n");
	write("new.txt", "new line\n");
	git("add", "new.txt");
	assert.deepEqual(await readGitStats(cwd, "working"), { add: 3, del: 1, status: "!?" });
	assert.deepEqual(await readGitStats(cwd, "branch"), { add: 3, del: 1, status: "!?" });
	// Staged changes undone in the worktree must not be counted twice.
	write("source.txt", "one\ntwo\nthree\n");
	assert.deepEqual(await readGitStats(cwd, "working"), { add: 1, del: 0, status: "!?" });
	// Untracked and modified files surface as Starship-style status symbols.
	write("untracked2.txt", "ignored by counts\n");
	assert.equal((await readGitStats(cwd, "working"))?.status, "!?");
});

test("readGitStats cancels an in-flight git query", async (t) => {
	const { cwd } = repository(t);
	assert.deepEqual(await readGitStats(cwd, "working"), { add: 0, del: 0 });
	const controller = new AbortController();
	const query = readGitStats(cwd, "working", controller.signal);
	controller.abort();
	assert.equal(await query, undefined);
	assert.equal(await readGitStats(cwd, "branch", controller.signal), undefined);
});

test("missing base, unborn HEAD and non-repositories hide stats without working fallback", async (t) => {
	const { cwd, git, write } = repository(t, "trunk");
	write("source.txt", "modified\n");
	assert.deepEqual(await readGitStats(cwd, "working"), { add: 1, del: 3, status: "!" });
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

test("binary files and filenames resembling refs do not affect line sums", async (t) => {
	const { cwd, write, commit } = repository(t);
	write("HEAD", "a file, not a ref\n");
	write("binary.dat", "\0binary\n");
	commit();
	write("HEAD", "changed\n");
	write("binary.dat", "\0changed\nextra\n");
	assert.deepEqual(await readGitStats(cwd, "working"), { add: 1, del: 1, status: "!" });
});

test("parseGitStatus maps porcelain to Starship-style symbols", () => {
	assert.equal(parseGitStatus("## main...origin/main\n M a.txt\n"), "!");
	assert.equal(parseGitStatus("## main\n?? new.txt\n"), "?");
	assert.equal(parseGitStatus("## main\n M a.txt\n?? new.txt\n"), "!?");
	assert.equal(parseGitStatus("## main\nUU a.txt\n"), "=!");
	assert.equal(parseGitStatus("## feature...origin/feature [ahead 3, behind 2]\n"), "⇡3⇣2");
	assert.equal(parseGitStatus("## feature...origin/feature [ahead 3]\n R a.txt"), "!⇡3");
	assert.equal(parseGitStatus("## feature...origin/feature\n"), undefined);
});
