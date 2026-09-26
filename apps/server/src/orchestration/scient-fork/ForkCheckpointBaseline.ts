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
  readonly copy: (input: {
    readonly cwd: string;
    readonly fromCheckpointRef: CheckpointRef;
    readonly toCheckpointRef: CheckpointRef;
  }) => Effect.Effect<boolean, VcsError>;
  /**
   * Snapshot the current working tree (untracked, non-ignored files included)
   * into a checkpoint ref without touching the user's index. A fork of a
   * running turn starts from the workspace as it stands at the cut.
   */
  readonly capture: (input: {
    readonly cwd: string;
    readonly toCheckpointRef: CheckpointRef;
  }) => Effect.Effect<boolean>;
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

  const copy: ScientForkCheckpointBaselineShape["copy"] = Effect.fn(
    "copyScientForkCheckpointBaseline",
  )(function* (input) {
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
      args: ["update-ref", input.toCheckpointRef, commitOid],
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
    copy,
    capture,
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
    copy: () => Effect.succeed(true),
    capture: () => Effect.succeed(true),
    discard: () => Effect.void,
    ...overrides,
  });
