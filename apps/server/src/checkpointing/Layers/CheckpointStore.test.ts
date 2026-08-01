// FILE: CheckpointStore.test.ts
// Purpose: Verifies filesystem checkpoint store behavior around expensive Git capture work.
// Layer: Checkpointing tests.
// Exports: Vitest coverage for CheckpointStoreLive.
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Fiber, Layer, ManagedRuntime, Option } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CheckpointStoreLive } from "./CheckpointStore.ts";
import { CheckpointStore } from "../Services/CheckpointStore.ts";
import { GitCoreLive } from "../../git/Layers/GitCore.ts";
import { GitCore, type GitCoreShape } from "../../git/Services/GitCore.ts";
import { GitCommandError } from "../../git/Errors.ts";
import { CheckpointRef } from "@synara/contracts";
import { ServerConfig } from "../../config.ts";

const TEMP_INDEX_COMMAND_PREFIX = "-c core.splitIndex=false ";

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for condition");
}

const gitCoreLayer = (
  execute: GitCoreShape["execute"],
  withActionLock: GitCoreShape["withActionLock"] = (_cwd, effect) => effect,
) => Layer.succeed(GitCore, { execute, withActionLock } as unknown as GitCoreShape);

const gitCoreIntegrationLayer = GitCoreLive.pipe(
  Layer.provide(
    ServerConfig.layerTest(process.cwd(), {
      prefix: "scient-checkpoint-index-test-",
    }),
  ),
  Layer.provide(NodeServices.layer),
);
const checkpointIntegrationLayer = CheckpointStoreLive.pipe(
  Layer.provide(gitCoreIntegrationLayer),
  Layer.provide(NodeServices.layer),
);

function runGit(cwd: string, args: ReadonlyArray<string>): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function initializeRepository(cwd: string): void {
  runGit(cwd, ["init", "--quiet"]);
  runGit(cwd, ["config", "user.name", "Scient Test"]);
  runGit(cwd, ["config", "user.email", "scient-test@example.invalid"]);
}

function resolveWorkingIndexPath(cwd: string): string {
  const raw = runGit(cwd, ["rev-parse", "--git-path", "index"]);
  return isAbsolute(raw) ? raw : resolve(cwd, raw);
}

function readSharedIndexes(gitDir: string): ReadonlyMap<string, Buffer> {
  return new Map(
    readdirSync(gitDir)
      .filter((name) => name.startsWith("sharedindex."))
      .map((name) => [name, readFileSync(join(gitDir, name))]),
  );
}

function checkpointTempDirectories(): ReadonlyArray<string> {
  return readdirSync(tmpdir())
    .filter((name) => name.startsWith("scient-fs-checkpoint-"))
    .toSorted();
}

describe("CheckpointStoreLive", () => {
  let runtime: ManagedRuntime.ManagedRuntime<CheckpointStore, unknown> | null = null;

  afterEach(async () => {
    if (runtime) {
      await runtime.dispose();
    }
    runtime = null;
  });

  it("seeds the throwaway index from Git's resolved working index", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "scient-checkpoint-seed-test-"));
    const cwd = join(tempRoot, "repo");
    const gitDir = join(cwd, ".git");
    mkdirSync(gitDir, { recursive: true });
    const liveIndexPath = join(gitDir, "index");
    writeFileSync(liveIndexPath, "working-index-stat-cache");
    let capturedSeed = "";
    const execute = vi.fn<GitCoreShape["execute"]>((input) => {
      const args = input.args.join(" ");
      if (args === "rev-parse --show-toplevel") {
        return Effect.succeed({ code: 0, stdout: `${cwd}\n`, stderr: "" });
      }
      if (args === "rev-parse --git-path index") {
        return Effect.succeed({ code: 0, stdout: ".git/index\n", stderr: "" });
      }
      if (args === `${TEMP_INDEX_COMMAND_PREFIX}update-index --no-split-index`) {
        return Effect.succeed({ code: 0, stdout: "", stderr: "" });
      }
      if (args === `${TEMP_INDEX_COMMAND_PREFIX}ls-files -v -z`) {
        return Effect.succeed({ code: 0, stdout: "H tracked.txt\0", stderr: "" });
      }
      if (args === `${TEMP_INDEX_COMMAND_PREFIX}add -A -- .`) {
        capturedSeed = readFileSync(input.env?.GIT_INDEX_FILE ?? "", "utf8");
        return Effect.succeed({ code: 0, stdout: "", stderr: "" });
      }
      if (args === `${TEMP_INDEX_COMMAND_PREFIX}write-tree`) {
        return Effect.succeed({ code: 0, stdout: "tree-oid\n", stderr: "" });
      }
      if (args.startsWith(`${TEMP_INDEX_COMMAND_PREFIX}commit-tree `)) {
        return Effect.succeed({ code: 0, stdout: "commit-oid\n", stderr: "" });
      }
      if (args.startsWith("update-ref ")) {
        return Effect.succeed({ code: 0, stdout: "", stderr: "" });
      }
      throw new Error(`Unexpected git args: ${args}`);
    });
    runtime = ManagedRuntime.make(
      CheckpointStoreLive.pipe(
        Layer.provide(gitCoreLayer(execute)),
        Layer.provide(NodeServices.layer),
      ),
    );

    try {
      const store = await runtime.runPromise(Effect.service(CheckpointStore));
      await runtime.runPromise(
        store.captureCheckpoint({
          cwd,
          checkpointRef: CheckpointRef.makeUnsafe("refs/scient-checkpoints/thread/stat-cache"),
        }),
      );

      expect(capturedSeed).toBe("working-index-stat-cache");
      expect(readFileSync(liveIndexPath, "utf8")).toBe("working-index-stat-cache");
      const temporaryIndexCalls = execute.mock.calls
        .map(([call]) => call)
        .filter((call) => call.env?.GIT_INDEX_FILE !== undefined);
      expect(temporaryIndexCalls.length).toBeGreaterThan(0);
      expect(
        temporaryIndexCalls.every(
          (call) => call.args[0] === "-c" && call.args[1] === "core.splitIndex=false",
        ),
      ).toBe(true);
      expect(
        execute.mock.calls.some(([call]) => call.args.join(" ") === "rev-parse --verify HEAD"),
      ).toBe(false);
      expect(
        execute.mock.calls.some(
          ([call]) => call.args.join(" ") === `${TEMP_INDEX_COMMAND_PREFIX}read-tree HEAD`,
        ),
      ).toBe(false);
    } finally {
      await runtime.dispose();
      runtime = null;
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it.each(["missing", "copy-failure", "normalization-failure"] as const)(
    "falls back to HEAD when the working index is %s",
    async (mode) => {
      const tempRoot = mkdtempSync(join(tmpdir(), "scient-checkpoint-fallback-test-"));
      const cwd = join(tempRoot, "repo");
      mkdirSync(cwd, { recursive: true });
      const indexPath = join(
        cwd,
        mode === "missing"
          ? "missing-index"
          : mode === "copy-failure"
            ? "index-directory"
            : "copied-index",
      );
      if (mode === "copy-failure") {
        mkdirSync(indexPath);
      } else if (mode === "normalization-failure") {
        writeFileSync(indexPath, "unusable copied index");
      }
      const commands: string[] = [];
      const execute = vi.fn<GitCoreShape["execute"]>((input) => {
        const args = input.args.join(" ");
        commands.push(args);
        if (args === "rev-parse --show-toplevel") {
          return Effect.succeed({ code: 0, stdout: `${cwd}\n`, stderr: "" });
        }
        if (args === "rev-parse --git-path index") {
          return Effect.succeed({ code: 0, stdout: `${indexPath}\n`, stderr: "" });
        }
        if (args === `${TEMP_INDEX_COMMAND_PREFIX}update-index --no-split-index`) {
          if (mode === "normalization-failure") {
            return Effect.fail(
              new GitCommandError({
                operation: input.operation,
                command: "git update-index --no-split-index",
                cwd,
                detail: "invalid index metadata",
              }),
            );
          }
          return Effect.succeed({ code: 0, stdout: "", stderr: "" });
        }
        if (args === "rev-parse --verify HEAD") {
          return Effect.succeed({ code: 0, stdout: "head-oid\n", stderr: "" });
        }
        if (
          args === `${TEMP_INDEX_COMMAND_PREFIX}read-tree HEAD` ||
          args === `${TEMP_INDEX_COMMAND_PREFIX}add -A -- .`
        ) {
          return Effect.succeed({ code: 0, stdout: "", stderr: "" });
        }
        if (args === `${TEMP_INDEX_COMMAND_PREFIX}write-tree`) {
          return Effect.succeed({ code: 0, stdout: "tree-oid\n", stderr: "" });
        }
        if (args.startsWith(`${TEMP_INDEX_COMMAND_PREFIX}commit-tree `)) {
          return Effect.succeed({ code: 0, stdout: "commit-oid\n", stderr: "" });
        }
        if (args.startsWith("update-ref ")) {
          return Effect.succeed({ code: 0, stdout: "", stderr: "" });
        }
        throw new Error(`Unexpected git args: ${args}`);
      });
      runtime = ManagedRuntime.make(
        CheckpointStoreLive.pipe(
          Layer.provide(gitCoreLayer(execute)),
          Layer.provide(NodeServices.layer),
        ),
      );

      try {
        const store = await runtime.runPromise(Effect.service(CheckpointStore));
        await runtime.runPromise(
          store.captureCheckpoint({
            cwd,
            checkpointRef: CheckpointRef.makeUnsafe(
              `refs/scient-checkpoints/thread/${mode}-fallback`,
            ),
          }),
        );
        const readTree = `${TEMP_INDEX_COMMAND_PREFIX}read-tree HEAD`;
        const add = `${TEMP_INDEX_COMMAND_PREFIX}add -A -- .`;
        expect(commands).toContain(readTree);
        expect(commands.indexOf(readTree)).toBeLessThan(commands.indexOf(add));
      } finally {
        await runtime.dispose();
        runtime = null;
        rmSync(tempRoot, { recursive: true, force: true });
      }
    },
  );

  it("captures an unborn repository without creating its live index", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "scient-checkpoint-unborn-test-"));
    const repo = join(tempRoot, "repo");
    mkdirSync(repo);
    initializeRepository(repo);
    writeFileSync(join(repo, "first.txt"), "first content\n");
    const liveIndexPath = resolveWorkingIndexPath(repo);
    expect(existsSync(liveIndexPath)).toBe(false);
    runtime = ManagedRuntime.make(checkpointIntegrationLayer);

    try {
      const store = await runtime.runPromise(Effect.service(CheckpointStore));
      const checkpointRef = CheckpointRef.makeUnsafe(
        "refs/scient-checkpoints/thread/unborn-index-fallback",
      );
      await runtime.runPromise(store.captureCheckpoint({ cwd: repo, checkpointRef }));

      expect(runGit(repo, ["show", `${checkpointRef}:first.txt`])).toBe("first content");
      expect(existsSync(liveIndexPath)).toBe(false);
    } finally {
      await runtime.dispose();
      runtime = null;
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("preserves staged and unstaged capture content without changing the live index", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "scient-checkpoint-parity-test-"));
    const repo = join(tempRoot, "repo");
    mkdirSync(repo);
    initializeRepository(repo);
    writeFileSync(join(repo, "tracked.txt"), "base\n");
    writeFileSync(join(repo, "mixed.txt"), "base\n");
    runGit(repo, ["add", "tracked.txt", "mixed.txt"]);
    runGit(repo, ["commit", "--quiet", "-m", "base"]);

    writeFileSync(join(repo, "tracked.txt"), "unstaged tracked\n");
    writeFileSync(join(repo, "mixed.txt"), "staged version\n");
    runGit(repo, ["add", "mixed.txt"]);
    writeFileSync(join(repo, "mixed.txt"), "staged and then unstaged\n");
    writeFileSync(join(repo, "untracked.txt"), "untracked content\n");

    const liveIndexPath = resolveWorkingIndexPath(repo);
    const indexBefore = readFileSync(liveIndexPath);
    const statusBefore = runGit(repo, ["status", "--porcelain=v1", "--untracked-files=all"]);
    runtime = ManagedRuntime.make(checkpointIntegrationLayer);

    try {
      const store = await runtime.runPromise(Effect.service(CheckpointStore));
      const checkpointRef = CheckpointRef.makeUnsafe(
        "refs/scient-checkpoints/thread/staged-unstaged-parity",
      );
      await runtime.runPromise(store.captureCheckpoint({ cwd: repo, checkpointRef }));

      expect(runGit(repo, ["show", `${checkpointRef}:tracked.txt`])).toBe("unstaged tracked");
      expect(runGit(repo, ["show", `${checkpointRef}:mixed.txt`])).toBe("staged and then unstaged");
      expect(runGit(repo, ["show", `${checkpointRef}:untracked.txt`])).toBe("untracked content");
      expect(readFileSync(liveIndexPath)).toEqual(indexBefore);
      expect(runGit(repo, ["status", "--porcelain=v1", "--untracked-files=all"])).toBe(
        statusBefore,
      );
    } finally {
      await runtime.dispose();
      runtime = null;
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("rehashes a same-size rewrite whose timestamp still matches the live index", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "scient-checkpoint-racy-index-test-"));
    const repo = join(tempRoot, "repo");
    mkdirSync(repo);
    initializeRepository(repo);
    const trackedPath = join(repo, "tracked.txt");
    writeFileSync(trackedPath, "before\n");
    const racyTimestamp = new Date(1_000);
    utimesSync(trackedPath, racyTimestamp, racyTimestamp);
    runGit(repo, ["add", "tracked.txt"]);
    runGit(repo, ["commit", "--quiet", "-m", "base"]);
    runGit(repo, ["config", "core.trustctime", "false"]);
    runGit(repo, ["config", "core.checkStat", "minimal"]);

    const originalStat = statSync(trackedPath);
    const liveIndexPath = resolveWorkingIndexPath(repo);
    utimesSync(liveIndexPath, originalStat.atime, originalStat.mtime);
    writeFileSync(trackedPath, "after!\n");
    utimesSync(trackedPath, originalStat.atime, originalStat.mtime);
    runtime = ManagedRuntime.make(checkpointIntegrationLayer);

    try {
      const store = await runtime.runPromise(Effect.service(CheckpointStore));
      const checkpointRef = CheckpointRef.makeUnsafe(
        "refs/scient-checkpoints/thread/racy-same-size-rewrite",
      );
      await runtime.runPromise(store.captureCheckpoint({ cwd: repo, checkpointRef }));

      expect(runGit(repo, ["show", `${checkpointRef}:tracked.txt`])).toBe("after!");
    } finally {
      await runtime.dispose();
      runtime = null;
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("does not run a clean filter for an untouched tracked file", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "scient-checkpoint-filter-scope-test-"));
    const repo = join(tempRoot, "repo");
    mkdirSync(repo);
    initializeRepository(repo);
    const filteredPath = join(repo, "filtered.txt");
    writeFileSync(filteredPath, "untouched\n");
    utimesSync(filteredPath, new Date(1_000), new Date(1_000));
    writeFileSync(join(repo, "changed.txt"), "before\n");
    runGit(repo, ["add", "filtered.txt", "changed.txt"]);
    runGit(repo, ["commit", "--quiet", "-m", "base"]);
    writeFileSync(join(repo, ".gitattributes"), "filtered.txt filter=must-not-run\n");
    runGit(repo, ["add", ".gitattributes"]);
    runGit(repo, ["commit", "--quiet", "-m", "attributes"]);
    runGit(repo, ["config", "filter.must-not-run.clean", "scient-filter-must-not-run"]);
    runGit(repo, ["config", "filter.must-not-run.required", "true"]);
    writeFileSync(join(repo, "changed.txt"), "after\n");
    runtime = ManagedRuntime.make(checkpointIntegrationLayer);

    try {
      const store = await runtime.runPromise(Effect.service(CheckpointStore));
      const checkpointRef = CheckpointRef.makeUnsafe(
        "refs/scient-checkpoints/thread/untouched-filter",
      );
      await runtime.runPromise(store.captureCheckpoint({ cwd: repo, checkpointRef }));

      expect(runGit(repo, ["show", `${checkpointRef}:changed.txt`])).toBe("after");
      expect(runGit(repo, ["show", `${checkpointRef}:filtered.txt`])).toBe("untouched");
    } finally {
      await runtime.dispose();
      runtime = null;
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("falls back from a nested cwd without leaking staged content outside that workspace", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "scient-checkpoint-nested-cwd-test-"));
    const repo = join(tempRoot, "repo");
    const nested = join(repo, "nested");
    mkdirSync(nested, { recursive: true });
    initializeRepository(repo);
    writeFileSync(join(repo, "outside.txt"), "outside base\n");
    writeFileSync(join(nested, "inside.txt"), "inside base\n");
    runGit(repo, ["add", "outside.txt", "nested/inside.txt"]);
    runGit(repo, ["commit", "--quiet", "-m", "base"]);

    writeFileSync(join(repo, "outside.txt"), "outside staged secret\n");
    runGit(repo, ["add", "outside.txt"]);
    writeFileSync(join(nested, "inside.txt"), "inside workspace change\n");

    const liveIndexPath = resolveWorkingIndexPath(repo);
    const indexBefore = readFileSync(liveIndexPath);
    const statusBefore = runGit(repo, ["status", "--porcelain=v1", "--untracked-files=all"]);
    const tempDirectoriesBefore = checkpointTempDirectories();
    runtime = ManagedRuntime.make(checkpointIntegrationLayer);

    try {
      const store = await runtime.runPromise(Effect.service(CheckpointStore));
      const checkpointRef = CheckpointRef.makeUnsafe(
        "refs/scient-checkpoints/thread/nested-cwd-boundary",
      );
      await runtime.runPromise(store.captureCheckpoint({ cwd: nested, checkpointRef }));

      expect(runGit(repo, ["show", `${checkpointRef}:nested/inside.txt`])).toBe(
        "inside workspace change",
      );
      expect(runGit(repo, ["show", `${checkpointRef}:outside.txt`])).toBe("outside base");
      expect(readFileSync(liveIndexPath)).toEqual(indexBefore);
      expect(runGit(repo, ["status", "--porcelain=v1", "--untracked-files=all"])).toBe(
        statusBefore,
      );
      expect(checkpointTempDirectories()).toEqual(tempDirectoriesBefore);
    } finally {
      await runtime.dispose();
      runtime = null;
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it.each(["assume-unchanged", "skip-worktree"] as const)(
    "falls back without inheriting the live index's %s behavior",
    async (flag) => {
      const tempRoot = mkdtempSync(join(tmpdir(), "scient-checkpoint-index-flag-test-"));
      const repo = join(tempRoot, "repo");
      mkdirSync(repo);
      initializeRepository(repo);
      writeFileSync(join(repo, "tracked.txt"), "base\n");
      runGit(repo, ["add", "tracked.txt"]);
      runGit(repo, ["commit", "--quiet", "-m", "base"]);
      runGit(repo, ["update-index", `--${flag}`, "tracked.txt"]);
      writeFileSync(join(repo, "tracked.txt"), `${flag} content\n`);

      const liveIndexPath = resolveWorkingIndexPath(repo);
      const indexBefore = readFileSync(liveIndexPath);
      runtime = ManagedRuntime.make(checkpointIntegrationLayer);

      try {
        const store = await runtime.runPromise(Effect.service(CheckpointStore));
        const checkpointRef = CheckpointRef.makeUnsafe(
          `refs/scient-checkpoints/thread/${flag}-fallback`,
        );
        await runtime.runPromise(store.captureCheckpoint({ cwd: repo, checkpointRef }));

        expect(runGit(repo, ["show", `${checkpointRef}:tracked.txt`])).toBe(`${flag} content`);
        expect(readFileSync(liveIndexPath)).toEqual(indexBefore);
      } finally {
        await runtime.dispose();
        runtime = null;
        rmSync(tempRoot, { recursive: true, force: true });
      }
    },
  );

  it("disables configured split-index writes for every temporary index command", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "scient-checkpoint-split-index-test-"));
    const repo = join(tempRoot, "repo");
    mkdirSync(repo);
    initializeRepository(repo);
    writeFileSync(join(repo, "tracked.txt"), "base\n");
    runGit(repo, ["add", "tracked.txt"]);
    runGit(repo, ["commit", "--quiet", "-m", "base"]);
    runGit(repo, ["config", "core.splitIndex", "true"]);
    runGit(repo, ["update-index", "--split-index"]);
    writeFileSync(join(repo, "tracked.txt"), "split-index content\n");

    const gitDir = runGit(repo, ["rev-parse", "--absolute-git-dir"]);
    const liveIndexPath = resolveWorkingIndexPath(repo);
    const indexBefore = readFileSync(liveIndexPath);
    const sharedIndexesBefore = readSharedIndexes(gitDir);
    expect(sharedIndexesBefore.size).toBeGreaterThan(0);
    runtime = ManagedRuntime.make(checkpointIntegrationLayer);

    try {
      const store = await runtime.runPromise(Effect.service(CheckpointStore));
      const checkpointRef = CheckpointRef.makeUnsafe(
        "refs/scient-checkpoints/thread/split-index-seed",
      );
      await runtime.runPromise(store.captureCheckpoint({ cwd: repo, checkpointRef }));

      expect(runGit(repo, ["show", `${checkpointRef}:tracked.txt`])).toBe("split-index content");
      expect(readFileSync(liveIndexPath)).toEqual(indexBefore);
      expect(readSharedIndexes(gitDir)).toEqual(sharedIndexesBefore);
    } finally {
      await runtime.dispose();
      runtime = null;
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("uses the linked worktree's exact index without changing either live index", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "scient-checkpoint-worktree-test-"));
    const repo = join(tempRoot, "repo");
    const linked = join(tempRoot, "linked");
    mkdirSync(repo);
    initializeRepository(repo);
    writeFileSync(join(repo, "tracked.txt"), "base\n");
    runGit(repo, ["add", "tracked.txt"]);
    runGit(repo, ["commit", "--quiet", "-m", "base"]);
    runGit(repo, ["worktree", "add", "--quiet", "-b", "checkpoint-linked", linked]);
    writeFileSync(join(linked, "tracked.txt"), "linked worktree content\n");

    const mainIndexPath = resolveWorkingIndexPath(repo);
    const linkedIndexPath = resolveWorkingIndexPath(linked);
    expect(linkedIndexPath).not.toBe(mainIndexPath);
    const mainIndexBefore = readFileSync(mainIndexPath);
    const linkedIndexBefore = readFileSync(linkedIndexPath);
    runtime = ManagedRuntime.make(checkpointIntegrationLayer);

    try {
      const store = await runtime.runPromise(Effect.service(CheckpointStore));
      const checkpointRef = CheckpointRef.makeUnsafe(
        "refs/scient-checkpoints/thread/linked-worktree-index",
      );
      await runtime.runPromise(store.captureCheckpoint({ cwd: linked, checkpointRef }));

      expect(runGit(linked, ["show", `${checkpointRef}:tracked.txt`])).toBe(
        "linked worktree content",
      );
      expect(readFileSync(mainIndexPath)).toEqual(mainIndexBefore);
      expect(readFileSync(linkedIndexPath)).toEqual(linkedIndexBefore);
    } finally {
      await runtime.dispose();
      runtime = null;
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("deduplicates concurrent captures for the same checkpoint ref", async () => {
    let releaseAdd: (() => void) | undefined;
    const addGate = new Promise<void>((resolve) => {
      releaseAdd = resolve;
    });
    const execute = vi.fn<GitCoreShape["execute"]>((input) => {
      const args = input.args.join(" ");
      if (args === "rev-parse --show-toplevel") {
        return Effect.succeed({ code: 1, stdout: "", stderr: "missing index" });
      }
      if (args === "rev-parse --verify HEAD") {
        return Effect.succeed({ code: 1, stdout: "", stderr: "" });
      }
      if (args === `${TEMP_INDEX_COMMAND_PREFIX}add -A -- .`) {
        return Effect.promise(() => addGate).pipe(Effect.as({ code: 0, stdout: "", stderr: "" }));
      }
      if (args === `${TEMP_INDEX_COMMAND_PREFIX}write-tree`) {
        return Effect.succeed({ code: 0, stdout: "tree-oid\n", stderr: "" });
      }
      if (args.startsWith(`${TEMP_INDEX_COMMAND_PREFIX}commit-tree `)) {
        return Effect.succeed({ code: 0, stdout: "commit-oid\n", stderr: "" });
      }
      if (args.startsWith("update-ref ")) {
        return Effect.succeed({ code: 0, stdout: "", stderr: "" });
      }
      throw new Error(`Unexpected git args: ${args}`);
    });
    const layer = CheckpointStoreLive.pipe(
      Layer.provide(gitCoreLayer(execute)),
      Layer.provide(NodeServices.layer),
    );
    runtime = ManagedRuntime.make(layer);

    await runtime.runPromise(
      Effect.gen(function* () {
        const store = yield* CheckpointStore;
        const input = {
          cwd: "/repo",
          checkpointRef: CheckpointRef.makeUnsafe("refs/synara-checkpoints/thread/message"),
        };

        const first = yield* store.captureCheckpoint(input).pipe(Effect.forkChild);
        yield* Effect.promise(() =>
          waitFor(() =>
            execute.mock.calls.some(
              ([call]) => call.args.join(" ") === `${TEMP_INDEX_COMMAND_PREFIX}add -A -- .`,
            ),
          ),
        );
        const second = yield* store.captureCheckpoint(input).pipe(Effect.forkChild);
        yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 25)));

        expect(
          execute.mock.calls.filter(
            ([call]) => call.args.join(" ") === `${TEMP_INDEX_COMMAND_PREFIX}add -A -- .`,
          ),
        ).toHaveLength(1);

        releaseAdd?.();
        yield* Fiber.join(first);
        yield* Fiber.join(second);
      }),
    );
  });

  it("clears in-flight capture state when the owner is interrupted", async () => {
    let addCalls = 0;
    const execute = vi.fn<GitCoreShape["execute"]>((input) => {
      const args = input.args.join(" ");
      if (args === "rev-parse --show-toplevel") {
        return Effect.succeed({ code: 1, stdout: "", stderr: "missing index" });
      }
      if (args === "rev-parse --verify HEAD") {
        return Effect.succeed({ code: 1, stdout: "", stderr: "" });
      }
      if (args === `${TEMP_INDEX_COMMAND_PREFIX}add -A -- .`) {
        addCalls += 1;
        if (addCalls === 1) {
          return Effect.never;
        }
        return Effect.succeed({ code: 0, stdout: "", stderr: "" });
      }
      if (args === `${TEMP_INDEX_COMMAND_PREFIX}write-tree`) {
        return Effect.succeed({ code: 0, stdout: "tree-oid\n", stderr: "" });
      }
      if (args.startsWith(`${TEMP_INDEX_COMMAND_PREFIX}commit-tree `)) {
        return Effect.succeed({ code: 0, stdout: "commit-oid\n", stderr: "" });
      }
      if (args.startsWith("update-ref ")) {
        return Effect.succeed({ code: 0, stdout: "", stderr: "" });
      }
      throw new Error(`Unexpected git args: ${args}`);
    });
    const layer = CheckpointStoreLive.pipe(
      Layer.provide(gitCoreLayer(execute)),
      Layer.provide(NodeServices.layer),
    );
    runtime = ManagedRuntime.make(layer);

    await runtime.runPromise(
      Effect.gen(function* () {
        const store = yield* CheckpointStore;
        const input = {
          cwd: "/repo",
          checkpointRef: CheckpointRef.makeUnsafe("refs/synara-checkpoints/thread/message"),
        };

        const first = yield* store.captureCheckpoint(input).pipe(Effect.forkChild);
        yield* Effect.promise(() => waitFor(() => addCalls === 1));
        const waiter = yield* store.captureCheckpoint(input).pipe(
          Effect.map(() => "completed" as const),
          Effect.catch((error) => Effect.succeed(error._tag)),
          Effect.forkChild,
        );
        yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 25)));

        yield* Fiber.interrupt(first);
        // The owner's interruption must surface to waiters as a typed store
        // error, not replay as the waiter's own fiber being interrupted.
        const waiterResult = yield* Fiber.join(waiter);
        expect(waiterResult).toBe("CheckpointInvariantError");

        const thirdResult = yield* store
          .captureCheckpoint(input)
          .pipe(Effect.timeoutOption("100 millis"));
        expect(Option.isSome(thirdResult)).toBe(true);
        expect(addCalls).toBe(2);
      }),
    );
  });

  it("skips the capture when skipIfExists is set and the ref already exists", async () => {
    const existingRef = "refs/synara-checkpoints/thread/existing";
    const missingRef = "refs/synara-checkpoints/thread/missing";
    const execute = vi.fn<GitCoreShape["execute"]>((input) => {
      const args = input.args.join(" ");
      if (args === `rev-parse --verify --quiet ${existingRef}^{commit}`) {
        return Effect.succeed({ code: 0, stdout: "existing-commit\n", stderr: "" });
      }
      if (args === `rev-parse --verify --quiet ${missingRef}^{commit}`) {
        return Effect.succeed({ code: 1, stdout: "", stderr: "" });
      }
      if (args === "rev-parse --show-toplevel") {
        return Effect.succeed({ code: 1, stdout: "", stderr: "missing index" });
      }
      if (args === "rev-parse --verify HEAD") {
        return Effect.succeed({ code: 1, stdout: "", stderr: "" });
      }
      if (args === `${TEMP_INDEX_COMMAND_PREFIX}add -A -- .`) {
        return Effect.succeed({ code: 0, stdout: "", stderr: "" });
      }
      if (args === `${TEMP_INDEX_COMMAND_PREFIX}write-tree`) {
        return Effect.succeed({ code: 0, stdout: "tree-oid\n", stderr: "" });
      }
      if (args.startsWith(`${TEMP_INDEX_COMMAND_PREFIX}commit-tree `)) {
        return Effect.succeed({ code: 0, stdout: "commit-oid\n", stderr: "" });
      }
      if (args.startsWith("update-ref ")) {
        return Effect.succeed({ code: 0, stdout: "", stderr: "" });
      }
      throw new Error(`Unexpected git args: ${args}`);
    });
    const layer = CheckpointStoreLive.pipe(
      Layer.provide(gitCoreLayer(execute)),
      Layer.provide(NodeServices.layer),
    );
    runtime = ManagedRuntime.make(layer);

    await runtime.runPromise(
      Effect.gen(function* () {
        const store = yield* CheckpointStore;
        const captureArgs = (args: string) =>
          execute.mock.calls.filter(([call]) => call.args.join(" ") === args);

        yield* store.captureCheckpoint({
          cwd: "/repo",
          checkpointRef: CheckpointRef.makeUnsafe(existingRef),
          skipIfExists: true,
        });
        expect(captureArgs(`${TEMP_INDEX_COMMAND_PREFIX}add -A -- .`)).toHaveLength(0);

        yield* store.captureCheckpoint({
          cwd: "/repo",
          checkpointRef: CheckpointRef.makeUnsafe(missingRef),
          skipIfExists: true,
        });
        expect(captureArgs(`${TEMP_INDEX_COMMAND_PREFIX}add -A -- .`)).toHaveLength(1);
        expect(captureArgs(`update-ref ${missingRef} commit-oid`)).toHaveLength(1);
      }),
    );
  });

  it("holds a destructive restore behind the shared repository action lock", async () => {
    const checkpointRef = CheckpointRef.makeUnsafe("refs/synara-checkpoints/thread/restore/target");
    const commands: string[] = [];
    let lockEntered = false;
    let releaseLock: (() => void) | undefined;
    const lockGate = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    const execute = vi.fn<GitCoreShape["execute"]>((input) => {
      const args = input.args.join(" ");
      commands.push(args);
      if (args === `rev-parse --verify --quiet ${checkpointRef}^{commit}`) {
        return Effect.succeed({ code: 0, stdout: "checkpoint-oid\n", stderr: "" });
      }
      if (args === "restore --source checkpoint-oid --worktree --staged -- .") {
        return Effect.succeed({ code: 0, stdout: "", stderr: "" });
      }
      if (args === "clean -fd -- .") {
        return Effect.succeed({ code: 0, stdout: "", stderr: "" });
      }
      if (args === "rev-parse --verify HEAD") {
        return Effect.succeed({ code: 1, stdout: "", stderr: "" });
      }
      throw new Error(`Unexpected git args: ${args}`);
    });
    const withActionLock: GitCoreShape["withActionLock"] = (cwd, effect) =>
      Effect.sync(() => {
        expect(cwd).toBe("/repo");
        lockEntered = true;
      }).pipe(Effect.andThen(Effect.promise(() => lockGate)), Effect.andThen(effect));
    const layer = CheckpointStoreLive.pipe(
      Layer.provide(gitCoreLayer(execute, withActionLock)),
      Layer.provide(NodeServices.layer),
    );
    runtime = ManagedRuntime.make(layer);

    const restore = runtime.runPromise(
      Effect.gen(function* () {
        const store = yield* CheckpointStore;
        return yield* store.restoreCheckpoint({ cwd: "/repo", checkpointRef });
      }),
    );

    await waitFor(() => lockEntered);
    expect(commands).toEqual([]);
    releaseLock?.();
    await expect(restore).resolves.toBe(true);
    expect(commands).toEqual([
      `rev-parse --verify --quiet ${checkpointRef}^{commit}`,
      "restore --source checkpoint-oid --worktree --staged -- .",
      "clean -fd -- .",
      "rev-parse --verify HEAD",
    ]);
  });

  it("resolves checkpoint refs concurrently before falling back to HEAD", async () => {
    const fromRef = CheckpointRef.makeUnsafe("refs/synara-checkpoints/thread/diff/from");
    const toRef = CheckpointRef.makeUnsafe("refs/synara-checkpoints/thread/diff/to");
    const started = new Set<string>();
    let releaseTo: (() => void) | undefined;
    const toGate = new Promise<void>((resolve) => {
      releaseTo = resolve;
    });
    const execute = vi.fn<GitCoreShape["execute"]>((input) => {
      const args = input.args.join(" ");
      if (args === `rev-parse --verify --quiet ${fromRef}^{commit}`) {
        started.add("from");
        return Effect.succeed({ code: 1, stdout: "", stderr: "" });
      }
      if (args === `rev-parse --verify --quiet ${toRef}^{commit}`) {
        started.add("to");
        return Effect.promise(() => toGate).pipe(
          Effect.as({ code: 0, stdout: "to-oid\n", stderr: "" }),
        );
      }
      if (args === "rev-parse --verify --quiet HEAD^{commit}") {
        started.add("head");
        return Effect.succeed({ code: 0, stdout: "head-oid\n", stderr: "" });
      }
      if (args.startsWith("diff --patch --minimal")) {
        return Effect.succeed({ code: 0, stdout: "checkpoint diff", stderr: "" });
      }
      throw new Error(`Unexpected git args: ${args}`);
    });
    const layer = CheckpointStoreLive.pipe(
      Layer.provide(gitCoreLayer(execute)),
      Layer.provide(NodeServices.layer),
    );
    runtime = ManagedRuntime.make(layer);

    const result = runtime.runPromise(
      Effect.gen(function* () {
        const store = yield* CheckpointStore;
        return yield* store.diffCheckpoints({
          cwd: "/repo",
          fromCheckpointRef: fromRef,
          toCheckpointRef: toRef,
          fallbackFromToHead: true,
          ignoreWhitespace: false,
        });
      }),
    );

    await waitFor(() => started.has("from") && started.has("to"));
    expect(started.has("head")).toBe(false);
    releaseTo?.();
    await expect(result).resolves.toBe("checkpoint diff");
    expect(started.has("head")).toBe(true);
  });

  it("resolves both checkpoint refs concurrently before reversing a diff", async () => {
    const fromRef = CheckpointRef.makeUnsafe("refs/synara-checkpoints/thread/reverse/from");
    const toRef = CheckpointRef.makeUnsafe("refs/synara-checkpoints/thread/reverse/to");
    const started = new Set<string>();
    let releaseRefs: (() => void) | undefined;
    const refsGate = new Promise<void>((resolve) => {
      releaseRefs = resolve;
    });
    const execute = vi.fn<GitCoreShape["execute"]>((input) => {
      const args = input.args.join(" ");
      if (args === `rev-parse --verify --quiet ${fromRef}^{commit}`) {
        started.add("from");
        return Effect.promise(() => refsGate).pipe(
          Effect.as({ code: 0, stdout: "from-oid\n", stderr: "" }),
        );
      }
      if (args === `rev-parse --verify --quiet ${toRef}^{commit}`) {
        started.add("to");
        return Effect.promise(() => refsGate).pipe(
          Effect.as({ code: 0, stdout: "to-oid\n", stderr: "" }),
        );
      }
      if (args.startsWith("diff --patch --binary --full-index")) {
        return Effect.succeed({ code: 0, stdout: "", stderr: "" });
      }
      throw new Error(`Unexpected git args: ${args}`);
    });
    const layer = CheckpointStoreLive.pipe(
      Layer.provide(gitCoreLayer(execute)),
      Layer.provide(NodeServices.layer),
    );
    runtime = ManagedRuntime.make(layer);

    const result = runtime.runPromise(
      Effect.gen(function* () {
        const store = yield* CheckpointStore;
        return yield* store.reverseCheckpointDiff({
          cwd: "/repo",
          fromCheckpointRef: fromRef,
          toCheckpointRef: toRef,
        });
      }),
    );

    await waitFor(() => started.has("from") && started.has("to"));
    releaseRefs?.();
    await expect(result).resolves.toBe(true);
  });

  it("restores the worktree patch when resetting the index fails during file undo", async () => {
    const fromRef = CheckpointRef.makeUnsafe("refs/synara-checkpoints/thread/turn/start");
    const toRef = CheckpointRef.makeUnsafe("refs/synara-checkpoints/thread/turn/end");
    const commands: string[] = [];
    const execute = vi.fn<GitCoreShape["execute"]>((input) => {
      const args = input.args.join(" ");
      commands.push(args);
      if (args === `rev-parse --verify --quiet ${fromRef}^{commit}`) {
        return Effect.succeed({ code: 0, stdout: "from-oid\n", stderr: "" });
      }
      if (args === `rev-parse --verify --quiet ${toRef}^{commit}`) {
        return Effect.succeed({ code: 0, stdout: "to-oid\n", stderr: "" });
      }
      if (args.startsWith("diff --patch --binary --full-index")) {
        return Effect.succeed({ code: 0, stdout: "turn patch", stderr: "" });
      }
      if (args === "diff --name-only --no-renames -z from-oid to-oid") {
        return Effect.succeed({ code: 0, stdout: "src/file.ts\0", stderr: "" });
      }
      if (input.args[0] === "apply" && input.args[1] === "--reverse") {
        return Effect.succeed({ code: 0, stdout: "", stderr: "" });
      }
      if (args === "reset --quiet from-oid -- src/file.ts") {
        return Effect.fail(
          new GitCommandError({
            operation: input.operation,
            command: args,
            cwd: input.cwd,
            detail: "reset failed",
          }),
        );
      }
      if (input.args[0] === "apply" && input.args[1] === "--whitespace=nowarn") {
        return Effect.succeed({ code: 0, stdout: "", stderr: "" });
      }
      throw new Error(`Unexpected git args: ${args}`);
    });
    const layer = CheckpointStoreLive.pipe(
      Layer.provide(gitCoreLayer(execute)),
      Layer.provide(NodeServices.layer),
    );
    runtime = ManagedRuntime.make(layer);

    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const store = yield* CheckpointStore;
        return yield* store
          .reverseCheckpointDiff({
            cwd: "/repo",
            fromCheckpointRef: fromRef,
            toCheckpointRef: toRef,
          })
          .pipe(
            Effect.map(() => "success" as const),
            Effect.catch((error) => Effect.succeed(error._tag)),
          );
      }),
    );

    expect(result).toBe("GitCommandError");
    expect(commands.filter((command) => command.startsWith("apply "))).toHaveLength(2);
    expect(commands.at(-1)).toMatch(/^apply --whitespace=nowarn -- /);
  });
});
