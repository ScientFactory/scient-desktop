import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import { afterEach, assert, describe, it } from "vite-plus/test";

import { decide, KEEP_MARKER, parseArgs, sweep } from "./worktree-sweep.mjs";

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
    lastActivityMs: NOW - 10 * 24 * HOUR,
    ...overrides,
  };
}

describe("decide", () => {
  it("keeps anything that could hold unsaved or in-use work, even when merged", () => {
    for (const overrides of [
      { protected: "protected checkout" },
      { linked: false },
      { dirty: true },
      { running: true },
      { threads: 2 },
    ]) {
      const decision = decide(baseFacts({ merged: "in origin/main", ...overrides }), {
        now: NOW,
        idleDays: 3,
      });
      assert.equal(decision.action, "keep", JSON.stringify(overrides));
    }
  });

  it("removes merged work after a quiet period, including dev app state", () => {
    assert.deepInclude(
      decide(baseFacts({ merged: "PR #1 merged at this head", devState: true }), {
        now: NOW,
        idleDays: 3,
      }),
      { action: "remove" },
    );
    assert.equal(
      decide(baseFacts({ merged: "in origin/main", lastActivityMs: NOW - HOUR }), {
        now: NOW,
        idleDays: 3,
      }).action,
      "keep",
    );
  });

  it("removes idle unmerged work with an archive tag, but keeps unmerged dev app state", () => {
    assert.deepInclude(decide(baseFacts(), { now: NOW, idleDays: 3 }), {
      action: "remove",
      archive: true,
    });
    assert.equal(decide(baseFacts({ devState: true }), { now: NOW, idleDays: 3 }).action, "keep");
    assert.equal(
      decide(baseFacts({ lastActivityMs: NOW - 2 * 24 * HOUR }), { now: NOW, idleDays: 3 }).action,
      "keep",
    );
  });
});

describe("parseArgs", () => {
  it("needs a root and a sensible idle period", () => {
    assert.throws(() => parseArgs([], {}), /--root/u);
    assert.throws(() => parseArgs(["--root", "/x", "--idle-days", "0"], {}), /idle-days/u);
    const options = parseArgs(["--apply"], { SCIENT_WORKTREES_ROOT: "/x", T3CODE_HOME: "/h" });
    assert.equal(options.root, "/x");
    assert.equal(options.stateDb, NodePath.join("/h", "userdata", "statev2.sqlite"));
    assert.isTrue(options.apply);
    assert.throws(() => parseArgs(["--root", "/x", "--apply"], {}, "win32"), /lsof/u);
  });
});

function sh(cwd, ...args) {
  NodeChildProcess.execFileSync("git", ["-C", cwd, ...args], { stdio: "pipe" });
}

function ageCheckout(checkout) {
  for (const file of ["logs/HEAD", "index", "HEAD"]) {
    const path = NodeChildProcess.execFileSync(
      "git",
      ["-C", checkout, "rev-parse", "--git-path", file],
      {
        encoding: "utf8",
      },
    ).trim();
    const absolute = NodePath.resolve(checkout, path);
    if (NodeFS.existsSync(absolute)) NodeFS.utimesSync(absolute, OLD, OLD);
  }
}

function makeFixture() {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "worktree-sweep-"));
  roots.push(root);
  const origin = NodePath.join(root, "origin.git");
  const repo = NodePath.join(root, "repo");
  const worktrees = NodePath.join(root, "worktrees");
  NodeFS.mkdirSync(worktrees);
  NodeChildProcess.execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
  NodeChildProcess.execFileSync("git", ["clone", "-q", origin, repo], { stdio: "pipe" });
  sh(
    repo,
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@t",
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    "base",
  );
  sh(repo, "push", "-q", "origin", "HEAD:main");
  sh(repo, "fetch", "-q", "origin");
  const add = (name, { commit = false } = {}) => {
    const checkout = NodePath.join(worktrees, name);
    sh(repo, "worktree", "add", "-q", "-b", name, checkout, "origin/main");
    if (commit) {
      sh(
        checkout,
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@t",
        "commit",
        "-q",
        "--allow-empty",
        "-m",
        name,
      );
    }
    ageCheckout(checkout);
    return checkout;
  };
  return { root, repo, worktrees, add };
}

function writeThreadDb(path, worktreePaths) {
  const db = new NodeSqlite.DatabaseSync(path);
  db.exec("create table orchestration_v2_projection_threads (payload_json text, deleted_at text)");
  const insert = db.prepare("insert into orchestration_v2_projection_threads values (?, null)");
  for (const worktreePath of worktreePaths) insert.run(JSON.stringify({ worktreePath }));
  db.close();
}

const noProcesses = () => ({ commands: "", cwds: [] });

describe("sweep", () => {
  it("reports without --apply and removes only what is safe with it", () => {
    const fixture = makeFixture();
    const merged = fixture.add("merged");
    const idle = fixture.add("idle-work", { commit: true });
    const dirty = fixture.add("dirty", { commit: true });
    NodeFS.writeFileSync(NodePath.join(dirty, "notes.txt"), "unsaved");
    const bound = fixture.add("bound", { commit: true });
    const marked = fixture.add("marked", { commit: true });
    NodeFS.writeFileSync(NodePath.join(marked, KEEP_MARKER), "");
    NodeFS.writeFileSync(
      NodePath.join(fixture.repo, ".git", "info", "exclude"),
      `${KEEP_MARKER}\n`,
    );
    const stateDb = NodePath.join(fixture.root, "state.sqlite");
    writeThreadDb(stateDb, [NodePath.join(bound, "apps")]);

    const options = { root: fixture.worktrees, idleDays: 3, stateDb, apply: false, json: false };
    const dryRun = sweep(options, { listProcesses: noProcesses });
    assert.deepEqual(Object.fromEntries(dryRun.map((result) => [result.name, result.action])), {
      bound: "keep",
      dirty: "keep",
      "idle-work": "remove",
      marked: "keep",
      merged: "remove",
    });
    assert.isTrue(NodeFS.existsSync(merged));

    const applied = sweep({ ...options, apply: true }, { listProcesses: noProcesses });
    assert.deepEqual(
      applied.filter((result) => result.removed).map((result) => result.name),
      ["idle-work", "merged"],
    );
    assert.isFalse(NodeFS.existsSync(idle));
    assert.isFalse(NodeFS.existsSync(merged));
    for (const kept of [dirty, bound, marked]) assert.isTrue(NodeFS.existsSync(kept));
    // The branch and an archive tag keep unmerged commits reachable.
    const tagged = NodeChildProcess.execFileSync(
      "git",
      ["-C", fixture.repo, "rev-parse", "archive/idle-work", "idle-work"],
      { encoding: "utf8" },
    ).split("\n");
    assert.equal(tagged[0], tagged[1]);
  });

  it("keeps a checkout a process is using", () => {
    const fixture = makeFixture();
    const busy = fixture.add("busy", { commit: true });
    const results = sweep(
      {
        root: fixture.worktrees,
        idleDays: 3,
        stateDb: "/missing.sqlite",
        apply: true,
        json: false,
      },
      { listProcesses: () => ({ commands: "", cwds: [NodePath.join(busy, "apps")] }) },
    );
    assert.equal(results[0].action, "keep");
    assert.isTrue(NodeFS.existsSync(busy));
  });
});
