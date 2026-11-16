const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { resolveComparisonBase } = require("./ci-comparison-base.cjs");

test("a PR run compares with the main its tested merge was made on", (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ci-comparison-base-"));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "CI",
    GIT_AUTHOR_EMAIL: "ci@example.invalid",
    GIT_COMMITTER_NAME: "CI",
    GIT_COMMITTER_EMAIL: "ci@example.invalid",
  };
  const git = (...args) => execFileSync("git", args, { cwd, env, encoding: "utf8" }).trim();
  git("init", "-q");
  const tree = git("write-tree");
  const commit = (message, ...parents) =>
    git("commit-tree", tree, ...parents.flatMap((parent) => ["-p", parent]), "-m", message);
  // The event's base lags: main moved on before GitHub made the merge the run tests.
  const eventBase = commit("main when the PR event fired");
  const main = commit("main the merge was made on", eventBase);
  const head = commit("PR head", eventBase);
  const merge = commit("GitHub's test merge", main, head);
  const pr = { pull_request: { base: { sha: eventBase }, head: { sha: head } } };
  const base = (event, tested, at = cwd) => resolveComparisonBase({ event, head: tested, cwd: at });

  assert.equal(base(pr, merge), main);
  // Anything that is not a merge of this PR's head keeps the event's base, which no receipt joins.
  assert.equal(base(pr, head), eventBase);
  assert.equal(
    base({ pull_request: { ...pr.pull_request, head: { sha: main } } }, merge),
    eventBase,
  );
  // Parents Git cannot see leave the base unknown, so the gates run everything.
  assert.equal(base(pr, "0".repeat(40)), undefined);
  const shallow = path.join(cwd, "shallow");
  git("update-ref", "refs/heads/test-merge", merge);
  execFileSync("git", [
    "clone",
    "-q",
    "--depth=1",
    "--branch=test-merge",
    `file://${cwd}`,
    shallow,
  ]);
  assert.equal(base(pr, merge, shallow), undefined);
  // Queue runs and main pushes keep their own bases.
  assert.equal(base({ merge_group: { base_sha: eventBase } }, merge), eventBase);
  assert.equal(base({ before: eventBase }, merge), eventBase);
});
