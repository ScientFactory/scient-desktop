import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import { afterEach, assert, describe, it } from "vite-plus/test";

import { decide, KEEP_MARKER, parseArgs, sweep, threadCounts } from "./worktree-sweep.mjs";

const HOUR = 60 * 60 * 1000;
const NOW = Date.parse("2026-11-24T12:00:00Z");
const OLD = new Date("2020-01-01T00:00:00Z");
const roots = [];

afterEach(() => {
  for (const root of roots.splice(0)) NodeFS.rmSync(root, { recursive: true, force: true });
});

function baseFacts(overrides = {}) {
  return {
    protected: null,
    linked: true,
    dirty: false,
    running: false,
    threads: 0,
    merged: null,
    devState: false,
    ignoredKept: [],
    lastActivityMs: NOW - 10 * 24 * HOUR,
    ...overrides,
  };
}

const at = { now: NOW, idleDays: 3 };

describe("decide", () => {
  it("keeps anything that could hold unsaved, unique or in-use work, even when merged", () => {
    for (const overrides of [
      { protected: "protected checkout" },
      { linked: false },
      { dirty: true },
      { running: true },
      { threads: 2 },
      { devState: true },
      { ignoredKept: [".env.local"] },
    ]) {
      const decision = decide(baseFacts({ merged: "in origin/main", ...overrides }), at);
      assert.equal(decision.action, "keep", JSON.stringify(overrides));
    }
  });

  it("removes merged work only after a quiet period", () => {
    assert.equal(decide(baseFacts({ merged: "in origin/main" }), at).action, "remove");
    assert.equal(
      decide(baseFacts({ merged: "in origin/main", lastActivityMs: NOW - HOUR }), at).action,
      "keep",
    );
  });

  it("removes idle unmerged work with an archive tag", () => {
    assert.deepInclude(decide(baseFacts(), at), { action: "remove", archive: true });
    assert.equal(decide(baseFacts({ lastActivityMs: NOW - 2 * 24 * HOUR }), at).action, "keep");
  });
});

describe("parseArgs", () => {
  it("needs a root and a sensible idle period, and refuses --apply on Windows", () => {
    assert.throws(() => parseArgs([], {}, "darwin"), /--root/u);
    assert.throws(
      () => parseArgs(["--root", "/x", "--idle-days", "0"], {}, "darwin"),
      /idle-days/u,
    );
    const options = parseArgs(
      ["--apply"],
      { SCIENT_WORKTREES_ROOT: "/x", T3CODE_HOME: "/h" },
      "darwin",
    );
    assert.equal(options.root, NodePath.resolve("/x"));
    assert.equal(options.stateDb, NodePath.join("/h", "userdata", "statev2.sqlite"));
    assert.isTrue(options.apply);
    assert.throws(() => parseArgs(["--root", "/x", "--apply"], {}, "win32"), /lsof/u);
  });
});

function sh(cwd, ...args) {
  return NodeChildProcess.execFileSync(
    "git",
    ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@t", ...args],
    { encoding: "utf8", stdio: "pipe" },
  ).trim();
}

function ageCheckout(checkout) {
  for (const file of ["logs/HEAD", "index", "HEAD"]) {
    const absolute = NodePath.resolve(checkout, sh(checkout, "rev-parse", "--git-path", file));
    if (NodeFS.existsSync(absolute)) NodeFS.utimesSync(absolute, OLD, OLD);
  }
}

// Mirrors the two tables Scient resolves a thread's folder from.
function writeThreadDb(path, threads) {
  NodeFS.rmSync(path, { force: true });
  const db = new NodeSqlite.DatabaseSync(path);
  db.exec(`
    create table projection_projects (project_id text, workspace_root text);
    create table orchestration_v2_projection_threads
      (project_id text, payload_json text, deleted_at text);
  `);
  threads.forEach(({ worktreePath = null, projectRoot = null }, index) => {
    db.prepare("insert into projection_projects values (?, ?)").run(`p${index}`, projectRoot);
    db.prepare("insert into orchestration_v2_projection_threads values (?, ?, null)").run(
      `p${index}`,
      JSON.stringify({ worktreePath }),
    );
  });
  db.close();
}

function makeFixture() {
  const root = NodeFS.realpathSync(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "worktree-sweep-")),
  );
  roots.push(root);
  const origin = NodePath.join(root, "origin.git");
  const repo = NodePath.join(root, "repo");
  const worktrees = NodePath.join(root, "worktrees");
  NodeFS.mkdirSync(worktrees);
  NodeChildProcess.execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
  NodeChildProcess.execFileSync("git", ["clone", "-q", origin, repo], { stdio: "pipe" });
  NodeFS.writeFileSync(NodePath.join(repo, ".gitignore"), "node_modules/\n*.local\n");
  sh(repo, "add", ".gitignore");
  sh(repo, "commit", "-q", "-m", "base");
  sh(repo, "push", "-q", "origin", "HEAD:main");
  sh(repo, "fetch", "-q", "origin");
  const add = (name, { commit = false, detach = null } = {}) => {
    const checkout = NodePath.join(worktrees, name);
    if (detach) sh(repo, "worktree", "add", "-q", "--detach", checkout, detach);
    else sh(repo, "worktree", "add", "-q", "-b", name, checkout, "origin/main");
    if (commit) sh(checkout, "commit", "-q", "--allow-empty", "-m", name);
    ageCheckout(checkout);
    return checkout;
  };
  const stateDb = NodePath.join(root, "state.sqlite");
  writeThreadDb(stateDb, []);
  return { root, repo, worktrees, add, stateDb };
}

const noProcesses = () => ({ commands: "", cwds: [] });
const options = (fixture, overrides = {}) => ({
  root: fixture.worktrees,
  idleDays: 3,
  stateDb: fixture.stateDb,
  apply: false,
  json: false,
  ...overrides,
});
const actions = (results) =>
  Object.fromEntries(results.map((result) => [result.name, result.action]));

describe("sweep", () => {
  it("reports without --apply and removes only what is safe with it", () => {
    const fixture = makeFixture();
    const merged = fixture.add("merged");
    const idle = fixture.add("idle-work", { commit: true });
    NodeFS.mkdirSync(NodePath.join(idle, "node_modules", "pkg"), { recursive: true });
    const dirty = fixture.add("dirty", { commit: true });
    NodeFS.writeFileSync(NodePath.join(dirty, "notes.txt"), "unsaved");
    const ignored = fixture.add("ignored-note", { commit: true });
    NodeFS.writeFileSync(NodePath.join(ignored, ".env.local"), "SECRET=1");
    const devApp = fixture.add("merged-dev-app");
    NodeFS.writeFileSync(NodePath.join(fixture.repo, ".git", "info", "exclude"), ".scient-next\n");
    NodeFS.mkdirSync(NodePath.join(devApp, ".scient-next"));
    const bound = fixture.add("bound", { commit: true });
    const projectBound = fixture.add("project-bound", { commit: true });
    const marked = fixture.add("marked", { commit: true });
    NodeFS.writeFileSync(NodePath.join(marked, KEEP_MARKER), "");
    writeThreadDb(fixture.stateDb, [
      { worktreePath: NodePath.join(bound, "apps") },
      { projectRoot: projectBound },
    ]);

    const dryRun = sweep(options(fixture), { listProcesses: noProcesses });
    assert.deepEqual(actions(dryRun), {
      bound: "keep",
      dirty: "keep",
      "idle-work": "remove",
      "ignored-note": "keep",
      marked: "keep",
      merged: "remove",
      "merged-dev-app": "keep",
      "project-bound": "keep",
    });
    assert.isTrue(NodeFS.existsSync(merged));

    const applied = sweep(options(fixture, { apply: true }), { listProcesses: noProcesses });
    assert.deepEqual(
      applied.filter((result) => result.removed).map((result) => result.name),
      ["idle-work", "merged"],
    );
    for (const gone of [idle, merged]) assert.isFalse(NodeFS.existsSync(gone));
    for (const kept of [dirty, ignored, devApp, bound, projectBound, marked]) {
      assert.isTrue(NodeFS.existsSync(kept));
    }
    const idleHead = applied.find((result) => result.name === "idle-work").head;
    assert.equal(sh(fixture.repo, "rev-parse", "idle-work"), idleHead);
  });

  it("gives each removed commit its own archive tag when a folder name is reused", () => {
    const fixture = makeFixture();
    const base = sh(fixture.repo, "rev-parse", "HEAD");
    const first = sh(fixture.repo, "commit-tree", "-p", base, "-m", "a", `${base}^{tree}`);
    const second = sh(fixture.repo, "commit-tree", "-p", base, "-m", "b", `${base}^{tree}`);
    for (const commit of [first, second]) {
      fixture.add("scratch", { detach: commit });
      const [result] = sweep(options(fixture, { apply: true }), { listProcesses: noProcesses });
      assert.isTrue(result.removed, result.error ?? result.reason);
    }
    const tags = sh(fixture.repo, "tag", "--list", "archive/scratch-*", "--format=%(objectname)");
    assert.sameMembers(tags.split("\n"), [first, second]);
  });

  it("keeps a checkout a process names or works in, but not its sibling", () => {
    const fixture = makeFixture();
    fixture.add("busy", { commit: true });
    const busySibling = fixture.add("busy-2", { commit: true });
    const cwdBusy = fixture.add("cwd-busy", { commit: true });
    const results = sweep(options(fixture), {
      listProcesses: () => ({
        commands: `codex -C ${busySibling} resume\n`,
        cwds: [NodePath.join(cwdBusy, "apps")],
      }),
    });
    assert.deepEqual(actions(results), { busy: "remove", "busy-2": "keep", "cwd-busy": "keep" });
  });

  it("keeps old dev app data, nested repositories and edits hidden by index flags", () => {
    const fixture = makeFixture();
    NodeFS.writeFileSync(NodePath.join(fixture.repo, ".git", "info", "exclude"), ".t3\nbuild\n");
    const markersOnly = fixture.add("markers-only");
    NodeFS.mkdirSync(NodePath.join(markersOnly, ".t3"));
    NodeFS.writeFileSync(NodePath.join(markersOnly, ".t3", "setup-done"), "");
    const oldDevApp = fixture.add("old-dev-app");
    NodeFS.mkdirSync(NodePath.join(oldDevApp, ".t3", "userdata"), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(oldDevApp, ".t3", "userdata", "statev2.sqlite"), "db");
    const nested = fixture.add("nested-repo");
    NodeFS.mkdirSync(NodePath.join(nested, "build", "upstream", ".git"), { recursive: true });
    for (const flag of ["--assume-unchanged", "--skip-worktree"]) {
      const flagged = fixture.add(`flag${flag}`);
      sh(flagged, "update-index", flag, ".gitignore");
      NodeFS.appendFileSync(NodePath.join(flagged, ".gitignore"), "edit\n");
      ageCheckout(flagged);
    }
    assert.deepEqual(actions(sweep(options(fixture), { listProcesses: noProcesses })), {
      "flag--assume-unchanged": "keep",
      "flag--skip-worktree": "keep",
      "markers-only": "remove",
      "nested-repo": "keep",
      "old-dev-app": "keep",
    });
  });

  it("sees processes and threads that name the checkout through a root alias", () => {
    const fixture = makeFixture();
    const alias = NodePath.join(fixture.root, "alias");
    NodeFS.symlinkSync(fixture.worktrees, alias);
    fixture.add("named");
    fixture.add("candidate");
    fixture.add("idle");
    writeThreadDb(fixture.stateDb, [{ projectRoot: NodePath.join(alias, "candidate", "gone") }]);
    const results = sweep(
      { ...options(fixture), root: fixture.worktrees, rootAlias: alias },
      { listProcesses: () => ({ commands: `codex -C ${alias}/named resume\n`, cwds: [] }) },
    );
    assert.deepEqual(actions(results), { candidate: "keep", idle: "remove", named: "keep" });
  });

  it("stops when it cannot read the Scient database", () => {
    assert.throws(() => threadCounts("/missing/statev2.sqlite", []), /--state-db/u);
  });
});
