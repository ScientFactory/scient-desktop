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
}

export class ScientForkCheckpointBaseline extends Context.Service<
  ScientForkCheckpointBaseline,
  ScientForkCheckpointBaselineShape
>()("t3/orchestration/scient-fork/ForkCheckpointBaseline/ScientForkCheckpointBaseline") {}

const make = Effect.gen(function* () {
  const process = yield* VcsProcess;
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

  return {
    isGitRepository,
    hasCheckpoint,
    workspaceExists,
    copy,
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
    ...overrides,
  });
