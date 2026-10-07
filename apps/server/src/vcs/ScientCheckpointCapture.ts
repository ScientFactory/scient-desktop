/**
 * Scient's checkpoint capture hardening for the Git driver: a changed-file size
 * limit, object staging in a scoped bare repository, publication by fetch, and
 * a whole-capture timeout. GitVcsDriver's capture calls these in order.
 */
// @effect-diagnostics-next-line nodeBuiltinImport:off - FileSystem.stat follows symlinks; checkpoint accounting needs lstat.
import * as NodeFSP from "node:fs/promises";

import { VcsCheckpointUnavailableError, VcsProcessTimeoutError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";

import type * as VcsDriver from "./VcsDriver.ts";
import * as VcsProcess from "./VcsProcess.ts";

const CHECKPOINT_CAPTURE_TIMEOUT_MS = 90_000;
const CHECKPOINT_CAPTURE_MAX_FILE_BYTES = 512n * 1024n * 1024n;
const CHECKPOINT_CAPTURE_MAX_CHANGED_BYTES = 1024n * 1024n * 1024n;

const checkpointFileError = (cwd: string, operation: string, error: { readonly message: string }) =>
  new VcsCheckpointUnavailableError({
    operation: VcsProcess.CHECKPOINT_CAPTURE_OPERATION,
    cwd,
    reason: "filesystem-error",
    detail: `${operation}: ${error.message}`,
  });

// Reject captures that would have to hash unusually large changed files.
// This is a checkpoint availability limit, never a limit on the user's files
// or on their ability to continue a conversation.
export const makeCheckpointSizeCheck = (deps: {
  readonly execute: VcsDriver.VcsDriver["Service"]["execute"];
  readonly path: Path.Path;
}) => {
  const { execute, path } = deps;
  return Effect.fn("GitVcsDriver.checkpoints.checkSize")(function* (
    cwd: string,
    env: NodeJS.ProcessEnv,
  ) {
    const operation = VcsProcess.CHECKPOINT_CAPTURE_OPERATION;
    // Porcelain v1 paths are repository-relative even when cwd is a subdirectory.
    // Scope enumeration to the same pathspec used by checkpoint staging.
    const root = yield* execute({ operation, cwd, args: ["rev-parse", "--show-toplevel"], env });
    const status = yield* execute({
      operation,
      cwd,
      args: ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", "."],
      env: { ...env, GIT_OPTIONAL_LOCKS: "0" },
      maxOutputBytes: 16 * 1024 * 1024,
      outputMode: "truncate",
    });
    if (status.stdoutTruncated) {
      return yield* new VcsCheckpointUnavailableError({
        operation,
        cwd,
        reason: "path-limit",
        detail: "Too many changed paths to safely capture a checkpoint.",
      });
    }
    let changedBytes = 0n;
    const records = status.stdout.split("\0");
    for (let index = 0; index < records.length; index++) {
      const record = records[index];
      if (!record || record.length < 4) continue;
      // Porcelain -z adds the old path as a second record for renames/copies.
      if (/[RC]/.test(record.slice(0, 2))) index++;
      const filePath = path.join(root.stdout.replace(/\r?\n$/, ""), record.slice(3));
      // Git stores the link text, not the target bytes. lstat also preserves
      // dangling links; a following exists/stat pair incorrectly treats them as deletions.
      const info = yield* Effect.tryPromise({
        try: () =>
          NodeFSP.lstat(filePath, { bigint: true }).catch((error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return null; // Deleted while enumerating.
            throw error;
          }),
        catch: (error) =>
          checkpointFileError(cwd, "checkpoint size check", {
            message: error instanceof Error ? error.message : String(error),
          }),
      });
      if (info === null || info.isDirectory()) continue; // Gitlinks contain no file payload.
      if (!info.isFile() && !info.isSymbolicLink()) {
        return yield* new VcsCheckpointUnavailableError({
          operation,
          cwd,
          reason: "unsupported-file",
          detail: "A changed special file cannot be included in file history.",
        });
      }
      const size = info.size;
      changedBytes += size;
      if (
        size > CHECKPOINT_CAPTURE_MAX_FILE_BYTES ||
        changedBytes > CHECKPOINT_CAPTURE_MAX_CHANGED_BYTES
      ) {
        return yield* new VcsCheckpointUnavailableError({
          operation,
          cwd,
          reason: "size-limit",
          detail:
            "Changed files exceed the checkpoint capture size limit (512 MiB per file, 1 GiB total).",
        });
      }
    }
  });
};

/** The environment for Git commands that must not inherit a caller's repository. */
export const checkpointCleanGitEnv = (): NodeJS.ProcessEnv => ({
  ...process.env,
  GIT_DIR: undefined,
  GIT_WORK_TREE: undefined,
  GIT_COMMON_DIR: undefined,
  GIT_INDEX_FILE: undefined,
  GIT_OBJECT_DIRECTORY: undefined,
  GIT_ALTERNATE_OBJECT_DIRECTORIES: undefined,
});

export const prepareCheckpointStagingRepo = Effect.fnUntraced(function* (input: {
  readonly execute: VcsDriver.VcsDriver["Service"]["execute"];
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly operation: string;
  readonly cwd: string;
  readonly gitCommonDir: string;
  readonly commitEnv: NodeJS.ProcessEnv;
  readonly cleanGitEnv: NodeJS.ProcessEnv;
}) {
  const { execute, fileSystem, path, operation, gitCommonDir, commitEnv, cleanGitEnv } = input;
  // Git hashes workspace files into a scoped bare repository, so staging
  // failures cannot strand pack files in the user's repository. Git then
  // transfers the completed object graph and publishes the hidden ref.
  const objectFormat = yield* execute({
    operation,
    cwd: input.cwd,
    args: ["rev-parse", "--show-object-format"],
    env: cleanGitEnv,
    allowNonZeroExit: true,
  });
  const stagingRepo = yield* fileSystem
    .makeTempDirectoryScoped({
      prefix: "scient-checkpoint-",
    })
    .pipe(
      Effect.mapError((error) =>
        checkpointFileError(input.cwd, "create checkpoint staging repository", error),
      ),
    );
  yield* execute({
    operation,
    cwd: input.cwd,
    args: [
      "init",
      "--bare",
      "--quiet",
      ...(objectFormat.stdout.trim() === "sha256" ? ["--object-format=sha256"] : []),
      stagingRepo,
    ],
    env: cleanGitEnv,
  });
  yield* fileSystem
    .writeFileString(
      path.join(stagingRepo, "objects", "info", "alternates"),
      `${path.join(gitCommonDir, "objects").replaceAll("\\", "/")}\n`,
    )
    .pipe(
      Effect.mapError((error) =>
        checkpointFileError(input.cwd, "prepare checkpoint staging repository", error),
      ),
    );
  const stagedEnv: NodeJS.ProcessEnv = {
    ...commitEnv,
    GIT_OBJECT_DIRECTORY: path.join(stagingRepo, "objects"),
    GIT_ALTERNATE_OBJECT_DIRECTORIES: undefined,
  };
  return { stagingRepo, stagedEnv };
});

/** Moves the staged commit's object graph into the user's repository and
 * publishes the hidden checkpoint ref there. */
export const publishStagedCheckpoint = Effect.fnUntraced(function* (input: {
  readonly execute: VcsDriver.VcsDriver["Service"]["execute"];
  readonly operation: string;
  readonly cwd: string;
  readonly stagingRepo: string;
  readonly stagedEnv: NodeJS.ProcessEnv;
  readonly cleanGitEnv: NodeJS.ProcessEnv;
  readonly durableWrite: ReadonlyArray<string>;
  readonly commitOid: string;
  readonly checkpointRef: string;
}) {
  const { execute, operation, stagingRepo, stagedEnv, cleanGitEnv, durableWrite, commitOid } =
    input;
  yield* execute({
    operation,
    cwd: input.cwd,
    args: ["--git-dir", stagingRepo, ...durableWrite, "update-ref", "refs/t3/staging", commitOid],
    env: stagedEnv,
  });
  yield* execute({
    operation,
    cwd: input.cwd,
    args: [
      ...durableWrite,
      "fetch",
      "--quiet",
      "--no-write-fetch-head",
      "--no-tags",
      "--no-recurse-submodules",
      stagingRepo,
      `+refs/t3/staging:${input.checkpointRef}`,
    ],
    env: cleanGitEnv,
  });
});

/** Closes the staging scope and bounds the whole capture. */
export const scopedCheckpointCapture =
  (operation: string, cwd: string) =>
  <A, E, R>(capture: Effect.Effect<A, E, R>) =>
    capture.pipe(
      Effect.scoped,
      Effect.timeoutOrElse({
        duration: CHECKPOINT_CAPTURE_TIMEOUT_MS,
        orElse: () =>
          Effect.fail(
            new VcsProcessTimeoutError({
              operation,
              command: "git checkpoint capture",
              cwd,
              timeoutMs: CHECKPOINT_CAPTURE_TIMEOUT_MS,
            }),
          ),
      }),
    );
