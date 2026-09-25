import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";
import { inspectAlignment, startAlignment } from "./scient-alignment.mjs";

const directories = [];
afterEach(() => {
  for (const directory of directories.splice(0)) {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
});

function fixture({ conflict = true, cleanOverlap = false } = {}) {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "scient-alignment-test-"));
  directories.push(directory);
  const root = NodePath.join(directory, "repo");
  NodeFS.mkdirSync(root);
  const git = (...args) =>
    NodeChildProcess.execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  git("remote", "add", "origin", root);
  git("remote", "add", "upstream", root);
  git("config", "remote.upstream.pushurl", "DISABLED");
  NodeFS.writeFileSync(
    NodePath.join(root, "shared.txt"),
    cleanOverlap ? "first\na\nb\nc\nlast\n" : "base\n",
  );
  NodeFS.writeFileSync(
    NodePath.join(root, "package.json"),
    JSON.stringify({ scripts: { check: "old" }, dependencies: { example: "1.0.0" } }),
  );
  git("add", ".");
  git("commit", "-qm", "initial");
  const previous = git("rev-parse", "HEAD");
  git("branch", "official");
  git("switch", "-q", "official");
  NodeFS.writeFileSync(
    NodePath.join(root, "shared.txt"),
    cleanOverlap ? "official\na\nb\nc\nlast\n" : "official\n",
  );
  git("add", ".");
  git("commit", "-qm", "upstream behavior");
  const target = git("rev-parse", "HEAD");
  git("update-ref", "refs/remotes/upstream/main", target);
  git("switch", "-q", "main");
  NodeFS.writeFileSync(
    NodePath.join(root, "upstream-state.json"),
    JSON.stringify({ updateMode: "thin-fork-merge", integrationBase: previous }),
  );
  if (conflict) NodeFS.writeFileSync(NodePath.join(root, "shared.txt"), "scient\n");
  if (cleanOverlap) {
    NodeFS.writeFileSync(NodePath.join(root, "shared.txt"), "first\na\nb\nc\nscient\n");
  }
  git("add", ".");
  git("commit", "-qm", "owned behavior");
  const base = git("rev-parse", "HEAD");
  git("update-ref", "refs/remotes/origin/main", base);
  return { directory, root, git, previous, base, target };
}

describe("alignment workflow", () => {
  it("freezes ancestry, lists overlaps, and simulates conflicts without touching the checkout", () => {
    const f = fixture();
    NodeFS.writeFileSync(NodePath.join(f.root, "local-note.txt"), "keep");
    const before = f.git("status", "--porcelain=v1");
    const objectsBefore = f.git("count-objects", "-v");
    const temporaryBefore = NodeFS.readdirSync(NodeOS.tmpdir())
      .filter((name) => name.startsWith("scient-alignment-plan-"))
      .sort();
    const plan = inspectAlignment(["plan", "--base", f.base, "--target", f.target], {
      cwd: f.root,
    });
    expect(plan.previous).toBe(f.previous);
    expect(plan.commits).toHaveLength(1);
    expect(plan.overlappingPaths).toEqual(["shared.txt"]);
    expect(plan.predictedConflicts).toEqual(["shared.txt"]);
    expect(plan.predictedCleanMerge).toBe(false);
    expect(plan.impactSignals).toEqual([]);
    expect(f.git("status", "--porcelain=v1")).toBe(before);
    expect(f.git("count-objects", "-v")).toBe(objectsBefore);
    expect(
      NodeFS.readdirSync(NodeOS.tmpdir())
        .filter((name) => name.startsWith("scient-alignment-plan-"))
        .sort(),
    ).toEqual(temporaryBefore);
  });

  it("starts a history-preserving merge in a new worktree and leaves conflicts for review", () => {
    const f = fixture();
    const worktree = NodePath.join(f.directory, "candidate");
    const branch = "codex/test-alignment";
    const plan = inspectAlignment(
      ["start", "--base", f.base, "--target", f.target, "--worktree", worktree, "--branch", branch],
      { cwd: f.root },
    );
    const result = startAlignment(plan);
    expect(result.status).toBe("needs-resolution");
    expect(result.unmergedPaths).toEqual(["shared.txt"]);
    expect(NodeFS.existsSync(NodePath.join(worktree, ".git"))).toBe(true);
    expect(
      NodeChildProcess.execFileSync("git", ["rev-parse", "MERGE_HEAD"], {
        cwd: worktree,
        encoding: "utf8",
      }).trim(),
    ).toBe(f.target);
    expect(f.git("rev-parse", "main")).toBe(f.base);
  });

  it("keeps a rerere-reused resolution unstaged for explicit review", () => {
    const f = fixture();
    f.git("config", "rerere.enabled", "true");
    f.git("switch", "-q", "-c", "learning");
    const learningMerge = NodeChildProcess.spawnSync("git", ["merge", "--no-commit", f.target], {
      cwd: f.root,
      encoding: "utf8",
    });
    expect(learningMerge.status).toBe(1);
    NodeFS.writeFileSync(NodePath.join(f.root, "shared.txt"), "reviewed resolution\n");
    f.git("rerere");
    f.git("add", "shared.txt");
    f.git("commit", "-qm", "teach disposable fixture resolution");
    f.git("switch", "-q", "main");

    const worktree = NodePath.join(f.directory, "candidate");
    const plan = inspectAlignment(
      [
        "start",
        "--base",
        f.base,
        "--target",
        f.target,
        "--worktree",
        worktree,
        "--branch",
        "codex/rerere-alignment",
      ],
      { cwd: f.root },
    );
    const result = startAlignment(plan);
    expect(result.status).toBe("needs-resolution");
    expect(result.unmergedPaths).toEqual(["shared.txt"]);
    expect(NodeFS.readFileSync(NodePath.join(worktree, "shared.txt"), "utf8")).toBe(
      "reviewed resolution\n",
    );
  });

  it("leaves a clean native merge uncommitted for semantic review", () => {
    const f = fixture({ conflict: false });
    const worktree = NodePath.join(f.directory, "candidate");
    const plan = inspectAlignment(
      [
        "start",
        "--base",
        f.base,
        "--target",
        f.target,
        "--worktree",
        worktree,
        "--branch",
        "codex/clean-alignment",
      ],
      { cwd: f.root },
    );
    expect(plan.predictedCleanMerge).toBe(true);
    const result = startAlignment(plan);
    expect(result.status).toBe("awaiting-review");
    expect(result.unmergedPaths).toEqual([]);
    expect(NodeFS.readFileSync(NodePath.join(worktree, "shared.txt"), "utf8")).toBe("official\n");
    expect(f.git("rev-parse", "main")).toBe(f.base);
  });

  it("reports a clean textual merge as an overlapping path requiring semantic review", () => {
    const f = fixture({ conflict: false, cleanOverlap: true });
    const plan = inspectAlignment(["plan", "--base", f.base, "--target", f.target], {
      cwd: f.root,
    });
    expect(plan.predictedCleanMerge).toBe(true);
    expect(plan.predictedConflicts).toEqual([]);
    expect(plan.overlappingPaths).toEqual(["shared.txt"]);
  });

  it("flags changed quality rules, shared UI, and contracts without calling them conflicts", () => {
    const f = fixture({ conflict: false });
    f.git("switch", "-q", "official");
    for (const path of [
      "vite.config.ts",
      "apps/web/src/components/ui/button.tsx",
      "packages/contracts/src/model.ts",
    ]) {
      const file = NodePath.join(f.root, path);
      NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
      NodeFS.writeFileSync(file, "changed\n");
    }
    f.git("add", ".");
    f.git("commit", "-qm", "change shared policy and APIs");
    const target = f.git("rev-parse", "HEAD");
    f.git("update-ref", "refs/remotes/upstream/main", target);
    f.git("switch", "-q", "main");
    const plan = inspectAlignment(["plan", "--base", f.base, "--target", target], {
      cwd: f.root,
    });
    expect(plan.impactSignals.map((signal) => signal.id)).toEqual([
      "quality-policy",
      "shared-web-ui",
      "shared-contracts",
    ]);
    expect(plan.impactSignals[0].paths).toEqual(["vite.config.ts"]);
    expect(plan.predictedConflicts).toEqual([]);
  });

  it("flags script changes but not dependency-only package changes", () => {
    const f = fixture({ conflict: false });
    f.git("switch", "-q", "official");
    const packagePath = NodePath.join(f.root, "package.json");
    NodeFS.writeFileSync(
      packagePath,
      JSON.stringify({ scripts: { check: "old" }, dependencies: { example: "2.0.0" } }),
    );
    f.git("add", "package.json");
    f.git("commit", "-qm", "update dependency");
    const dependencyTarget = f.git("rev-parse", "HEAD");
    NodeFS.writeFileSync(
      packagePath,
      JSON.stringify({ scripts: { check: "new" }, dependencies: { example: "2.0.0" } }),
    );
    f.git("add", "package.json");
    f.git("commit", "-qm", "change check script");
    const scriptTarget = f.git("rev-parse", "HEAD");
    f.git("update-ref", "refs/remotes/upstream/main", scriptTarget);
    f.git("switch", "-q", "main");
    expect(
      inspectAlignment(["plan", "--base", f.base, "--target", dependencyTarget], {
        cwd: f.root,
      }).impactSignals,
    ).toEqual([]);
    expect(
      inspectAlignment(["plan", "--base", f.base, "--target", scriptTarget], {
        cwd: f.root,
      }).impactSignals[0].paths,
    ).toEqual(["package.json"]);
  });

  it("treats a removed root manifest as an advisory signal instead of breaking the plan", () => {
    const f = fixture({ conflict: false });
    f.git("switch", "-q", "official");
    NodeFS.rmSync(NodePath.join(f.root, "package.json"));
    f.git("add", "-u");
    f.git("commit", "-qm", "remove root manifest");
    const target = f.git("rev-parse", "HEAD");
    f.git("update-ref", "refs/remotes/upstream/main", target);
    f.git("switch", "-q", "main");
    expect(
      inspectAlignment(["plan", "--base", f.base, "--target", target], {
        cwd: f.root,
      }).impactSignals[0].paths,
    ).toEqual(["package.json"]);
  });

  it("plans a committed alignment extension in the same worktree while main is ahead", () => {
    const f = fixture({ conflict: false });
    const worktree = NodePath.join(f.directory, "candidate");
    const run = (...args) =>
      NodeChildProcess.execFileSync("git", args, { cwd: worktree, encoding: "utf8" }).trim();
    startAlignment(
      inspectAlignment(
        [
          "start",
          "--base",
          f.base,
          "--target",
          f.target,
          "--worktree",
          worktree,
          "--branch",
          "codex/existing-alignment",
        ],
        { cwd: f.root },
      ),
    );
    expect(() =>
      inspectAlignment(["plan", "--existing", "--base", "HEAD", "--target", f.target], {
        cwd: worktree,
      }),
    ).toThrow(/Finish the current merge/u);
    run("commit", "-qm", "merge official target");
    const merge = run("rev-parse", "HEAD");
    NodeFS.writeFileSync(
      NodePath.join(worktree, "upstream-state.json"),
      JSON.stringify({
        updateMode: "thin-fork-merge",
        integrationBase: f.target,
        lastRefreshMerge: merge,
        lastRefreshBranch: "codex/existing-alignment",
      }),
    );
    run("add", "upstream-state.json");
    run("commit", "-qm", "record alignment");

    f.git("switch", "-q", "official");
    NodeFS.writeFileSync(NodePath.join(f.root, "next.txt"), "next official change\n");
    f.git("add", "next.txt");
    f.git("commit", "-qm", "next official change");
    const nextTarget = f.git("rev-parse", "HEAD");
    f.git("update-ref", "refs/remotes/upstream/main", nextTarget);
    f.git("switch", "-q", "main");
    NodeFS.writeFileSync(NodePath.join(f.root, "owned.txt"), "new owned change\n");
    f.git("add", "owned.txt");
    f.git("commit", "-qm", "advance owned main");
    f.git("update-ref", "refs/remotes/origin/main", f.git("rev-parse", "HEAD"));

    const head = run("rev-parse", "HEAD");
    const plan = inspectAlignment(
      ["plan", "--existing", "--base", "HEAD", "--target", nextTarget],
      { cwd: worktree },
    );
    expect(plan.existingBranch).toBe(true);
    expect(plan.ownedMainCatchUpRequired).toBe(true);
    expect(plan.previous).toBe(f.target);
    expect(plan.commits).toHaveLength(1);
    expect(run("rev-parse", "HEAD")).toBe(head);
    expect(run("status", "--porcelain=v1")).toBe("");
    expect(() =>
      inspectAlignment(
        [
          "start",
          "--existing",
          "--base",
          head,
          "--target",
          nextTarget,
          "--worktree",
          NodePath.join(f.directory, "another"),
          "--branch",
          "codex/another",
        ],
        { cwd: worktree },
      ),
    ).toThrow(/plan-only/u);
    NodeFS.writeFileSync(
      NodePath.join(worktree, "upstream-state.json"),
      JSON.stringify({
        updateMode: "thin-fork-merge",
        integrationBase: f.target,
        lastRefreshMerge: merge,
        lastRefreshBranch: "codex/a-different-pr",
      }),
    );
    run("add", "upstream-state.json");
    run("commit", "-qm", "record different PR branch");
    expect(() =>
      inspectAlignment(["plan", "--existing", "--base", "HEAD", "--target", nextTarget], {
        cwd: worktree,
      }),
    ).toThrow(/recorded codex\/ alignment branch/u);
  });

  it("rejects stale or untrusted boundaries before creating a worktree", () => {
    const f = fixture();
    const worktree = NodePath.join(f.directory, "candidate");
    expect(() =>
      inspectAlignment(
        [
          "start",
          "--base",
          "origin/main",
          "--target",
          f.target,
          "--worktree",
          worktree,
          "--branch",
          "codex/test",
        ],
        { cwd: f.root },
      ),
    ).toThrow(/frozen full/u);
    f.git("update-ref", "refs/remotes/upstream/main", f.previous);
    expect(() =>
      inspectAlignment(["plan", "--base", f.base, "--target", f.target], {
        cwd: f.root,
      }),
    ).toThrow(/not on official/u);
    expect(NodeFS.existsSync(worktree)).toBe(false);
  });

  it("rejects a writable upstream or an owned base behind origin/main", () => {
    const f = fixture();
    f.git("config", "remote.upstream.pushurl", f.root);
    expect(() =>
      inspectAlignment(["plan", "--base", f.base, "--target", f.target], {
        cwd: f.root,
      }),
    ).toThrow(/push URL must be DISABLED/u);
    f.git("config", "remote.upstream.pushurl", "DISABLED");
    NodeFS.writeFileSync(NodePath.join(f.root, "new-main.txt"), "later\n");
    f.git("add", ".");
    f.git("commit", "-qm", "new main");
    f.git("update-ref", "refs/remotes/origin/main", f.git("rev-parse", "HEAD"));
    expect(() =>
      inspectAlignment(["plan", "--base", f.base, "--target", f.target], {
        cwd: f.root,
      }),
    ).toThrow(/behind origin\/main/u);
    const replay = inspectAlignment(
      ["plan", "--historical", "--base", f.base, "--target", f.target],
      { cwd: f.root },
    );
    expect(replay.historicalReplay).toBe(true);
    expect(replay.predictedConflicts).toEqual(["shared.txt"]);
    expect(() =>
      inspectAlignment(
        [
          "start",
          "--historical",
          "--base",
          f.base,
          "--target",
          f.target,
          "--worktree",
          NodePath.join(f.directory, "candidate"),
          "--branch",
          "codex/test",
        ],
        { cwd: f.root },
      ),
    ).toThrow(/plan-only/u);
  });

  it("refuses to reuse an existing worktree path", () => {
    const f = fixture();
    const worktree = NodePath.join(f.directory, "candidate");
    NodeFS.mkdirSync(worktree);
    const plan = inspectAlignment(
      [
        "start",
        "--base",
        f.base,
        "--target",
        f.target,
        "--worktree",
        worktree,
        "--branch",
        "codex/test",
      ],
      { cwd: f.root },
    );
    expect(() => startAlignment(plan)).toThrow(/Worktree path already exists/u);
    expect(f.git("branch", "--list", "codex/test")).toBe("");
  });
});
