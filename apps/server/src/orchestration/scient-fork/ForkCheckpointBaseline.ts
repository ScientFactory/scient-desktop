/**
 * Scient-owned checkpoint baseline copy for conversation forks.
 *
 * This stays outside T3's CheckpointStore and VCS-driver contracts so the fork
 * feature does not widen generic upstream interfaces. Git arguments are passed
 * directly to the existing bounded process service; no shell is involved.
 */
import type { CheckpointRef, VcsError } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";

import * as CheckpointStore from "../../checkpointing/CheckpointStore.ts";
import { VcsProcess } from "../../vcs/VcsProcess.ts";

export interface ScientForkCheckpointBaselineShape {
  readonly workspaceExists: (cwd: string) => Effect.Effect<boolean>;
  readonly isGitRepository: (cwd: string) => Effect.Effect<boolean, VcsError>;
  readonly hasCheckpoint: (cwd: string, ref: CheckpointRef) => Effect.Effect<boolean, VcsError>;
  readonly resolveCheckpoint: (
    cwd: string,
    ref: CheckpointRef,
  ) => Effect.Effect<string | null, VcsError>;
  readonly copy: (input: {
    readonly cwd: string;
    readonly fromCheckpointRef: CheckpointRef;
    readonly toCheckpointRef: CheckpointRef;
  }) => Effect.Effect<boolean, VcsError>;
  /**
   * Snapshot the current working tree (untracked, non-ignored files included)
   * into a checkpoint ref without touching the user's index. A fork of a
   * running turn starts from this separately captured workspace snapshot.
   */
  readonly capture: (input: {
    readonly cwd: string;
    readonly toCheckpointRef: CheckpointRef;
  }) => Effect.Effect<boolean>;
  /**
   * Whether a fork worktree is this repository's checkout of the fork branch at
   * the frozen checkpoint, with no checkout still in progress. A reused
   * worktree must also be clean: that scan reads the whole tree, so a worktree
   * Git has just created is not scanned.
   */
  readonly verifyWorktree: (input: {
    readonly cwd: string;
    readonly path: string;
    readonly branch: string;
    readonly checkpointRef: string;
    readonly requireClean: boolean;
  }) => Effect.Effect<boolean, VcsError>;
  /**
   * Best-effort removal of what an abandoned fork created: its worktree, its
   * `scient/fork/*` branch and its turn-zero checkpoint ref.
   */
  readonly discard: (input: {
    readonly cwd: string;
    readonly checkpointRef: CheckpointRef;
    readonly worktreePath: string | null;
    readonly branch: string | null;
  }) => Effect.Effect<void>;
}

export class ScientForkCheckpointBaseline extends Context.Service<
  ScientForkCheckpointBaseline,
  ScientForkCheckpointBaselineShape
>()("t3/orchestration/scient-fork/ForkCheckpointBaseline/ScientForkCheckpointBaseline") {}

const make = Effect.gen(function* () {
  const process = yield* VcsProcess;
  const checkpointStore = yield* CheckpointStore.CheckpointStore;
  const fs = yield* FileSystem.FileSystem;
  const workspaceExists: ScientForkCheckpointBaselineShape["workspaceExists"] = (cwd) =>
    fs.stat(cwd).pipe(
      Effect.map((info) => info.type === "Directory"),
      Effect.orElseSucceed(() => false),
    );

  const isGitRepository: ScientForkCheckpointBaselineShape["isGitRepository"] = (cwd) =>
    process
      .run({
        operation: "ScientForkCheckpointBaseline.isGitRepository",
        command: "git",
        args: ["rev-parse", "--is-inside-work-tree"],
        cwd,
        allowNonZeroExit: true,
      })
      .pipe(
        Effect.map(
          (result) => result.exitCode === 0 && result.stdout.trim().toLowerCase() === "true",
        ),
      );

  const resolveCheckpoint: ScientForkCheckpointBaselineShape["resolveCheckpoint"] = (cwd, ref) =>
    process
      .run({
        operation: "ScientForkCheckpointBaseline.resolve",
        command: "git",
        args: ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`],
        cwd,
        allowNonZeroExit: true,
      })
      .pipe(
        Effect.map((result) =>
          result.exitCode === 0 && /^[0-9a-f]{40,64}$/i.test(result.stdout.trim())
            ? result.stdout.trim()
            : null,
        ),
      );

  const copy: ScientForkCheckpointBaselineShape["copy"] = Effect.fn(
    "copyScientForkCheckpointBaseline",
  )(function* (input) {
    // Once frozen, retries never replace this fork's snapshot with a newer ref.
    if ((yield* resolveCheckpoint(input.cwd, input.toCheckpointRef)) !== null) return true;
    const resolved = yield* process.run({
      operation: "ScientForkCheckpointBaseline.resolve",
      command: "git",
      args: ["rev-parse", "--verify", "--quiet", `${input.fromCheckpointRef}^{commit}`],
      cwd: input.cwd,
      allowNonZeroExit: true,
    });
    if (resolved.exitCode !== 0) return false;
    const commitOid = resolved.stdout.trim();
    if (!/^[0-9a-f]{40,64}$/i.test(commitOid)) return false;

    yield* process.run({
      operation: "ScientForkCheckpointBaseline.copy",
      command: "git",
      args: ["update-ref", input.toCheckpointRef, commitOid, ""],
      cwd: input.cwd,
    });
    return true;
  });

  const hasCheckpoint: ScientForkCheckpointBaselineShape["hasCheckpoint"] = (cwd, ref) =>
    process
      .run({
        operation: "ScientForkCheckpointBaseline.hasCheckpoint",
        command: "git",
        args: ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`],
        cwd,
        allowNonZeroExit: true,
      })
      .pipe(Effect.map((result) => result.exitCode === 0));

  const capture: ScientForkCheckpointBaselineShape["capture"] = (input) =>
    checkpointStore
      .captureCheckpoint({ cwd: input.cwd, checkpointRef: input.toCheckpointRef })
      .pipe(
        Effect.as(true),
        Effect.catchCause((cause) =>
          Effect.logWarning("scient fork could not snapshot the running workspace", {
            cwd: input.cwd,
            cause,
          }).pipe(Effect.as(false)),
        ),
      );

  const verifyWorktree: ScientForkCheckpointBaselineShape["verifyWorktree"] = Effect.fn(
    "verifyScientForkWorktree",
  )(function* (input) {
    const git = (cwd: string, args: string[]) =>
      process.run({
        operation: "ScientForkCheckpointBaseline.verifyWorktree",
        command: "git",
        args,
        cwd,
        allowNonZeroExit: true,
      });
    const head = yield* git(input.path, ["rev-parse", "HEAD"]);
    const expected = yield* git(input.cwd, ["rev-parse", `${input.checkpointRef}^{commit}`]);
    const branch = yield* git(input.path, ["symbolic-ref", "--short", "HEAD"]);
    const common = yield* git(input.path, [
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ]);
    const originCommon = yield* git(input.cwd, [
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ]);
    const lock = yield* git(input.path, [
      "rev-parse",
      "--path-format=absolute",
      "--git-path",
      "index.lock",
    ]);
    if (
      ![head, expected, branch, common, originCommon, lock].every(
        (result) => result.exitCode === 0,
      ) ||
      head.stdout.trim() !== expected.stdout.trim() ||
      branch.stdout.trim() !== input.branch ||
      common.stdout.trim() !== originCommon.stdout.trim() ||
      (yield* fs.exists(lock.stdout.trim()).pipe(Effect.orElseSucceed(() => true)))
    ) {
      return false;
    }
    if (!input.requireClean) return true;
    const status = yield* git(input.path, ["status", "--porcelain", "--untracked-files=all"]);
    return status.exitCode === 0 && status.stdout.trim() === "";
  });

  const discard: ScientForkCheckpointBaselineShape["discard"] = Effect.fn(
    "discardScientForkWorkspace",
  )(function* (input) {
    const git = (operation: string, args: ReadonlyArray<string>) =>
      process
        .run({ operation, command: "git", args: [...args], cwd: input.cwd, allowNonZeroExit: true })
        .pipe(Effect.ignore);
    if (input.worktreePath !== null) {
      yield* git("ScientForkCheckpointBaseline.discardWorktree", [
        "worktree",
        "remove",
        "--force",
        input.worktreePath,
      ]);
    }
    if (input.branch !== null) {
      yield* git("ScientForkCheckpointBaseline.discardBranch", ["branch", "-D", input.branch]);
    }
    yield* git("ScientForkCheckpointBaseline.discardRef", [
      "update-ref",
      "-d",
      input.checkpointRef,
    ]);
  });

  return {
    isGitRepository,
    hasCheckpoint,
    workspaceExists,
    resolveCheckpoint,
    copy,
    capture,
    verifyWorktree,
    discard,
  } satisfies ScientForkCheckpointBaselineShape;
});

export const ScientForkCheckpointBaselineLive = Layer.effect(ScientForkCheckpointBaseline, make);

export const testLayer = (
  overrides?: Partial<ScientForkCheckpointBaselineShape>,
): Layer.Layer<ScientForkCheckpointBaseline> =>
  Layer.succeed(ScientForkCheckpointBaseline, {
    isGitRepository: () => Effect.succeed(true),
    hasCheckpoint: () => Effect.succeed(true),
    workspaceExists: () => Effect.succeed(true),
    resolveCheckpoint: () => Effect.succeed("a".repeat(40)),
    copy: () => Effect.succeed(true),
    capture: () => Effect.succeed(true),
    verifyWorktree: () => Effect.succeed(true),
    discard: () => Effect.void,
    ...overrides,
  });
