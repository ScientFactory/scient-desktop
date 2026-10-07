/**
 * Scient's checkpoint capture hardening for the Git driver: a changed-file size
 * limit, object staging in a scoped bare repository, publication by fetch, and
 * a whole-capture timeout. GitVcsDriver's capture calls these in order.
 */
// @effect-diagnostics-next-line nodeBuiltinImport:off - FileSystem.stat follows symlinks; checkpoint accounting needs lstat.
import * as NodeFSP from "node:fs/promises";

import {
  VcsCheckpointUnavailableError,
  VcsProcessExitError,
  VcsProcessTimeoutError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Context from "effect/Context";
import type { VcsError } from "@t3tools/contracts";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";
import * as Stream from "effect/Stream";

import type * as VcsDriver from "./VcsDriver.ts";
import * as VcsProcess from "./VcsProcess.ts";
import { makeCheckpointStatusConsumer } from "./CheckpointStatusConsumer.ts";
import * as Schema from "effect/Schema";
import { ProcessReadError } from "../processRunner.ts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";

const isCheckpointUnavailable = Schema.is(VcsCheckpointUnavailableError);

/** Fork admission persists its expected OID before the first external ref write.
 * Ordinary checkpoints have no pre-admission ownership record. */
export class CheckpointPublicationWitness extends Context.Reference<
  (input: {
    readonly cwd: string;
    readonly checkpointRef: string;
    readonly commitOid: string;
  }) => Effect.Effect<void, VcsError>
>("ScientCheckpointCapture/PublicationWitness", {
  defaultValue:
    (): ((input: {
      readonly cwd: string;
      readonly checkpointRef: string;
      readonly commitOid: string;
    }) => Effect.Effect<void, VcsError>) =>
    () =>
      Effect.void,
}) {}

const CHECKPOINT_LOOSE_TRANSFER_MAX_BYTES = 16 * 1024 * 1024;
const GIT_DEFAULT_UNPACK_LIMIT = 100;

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
    let changedBytes = 0n;
    const consumer = makeCheckpointStatusConsumer({
      cwd,
      operation,
      platform: yield* HostProcessPlatform,
      onPath: Effect.fnUntraced(function* (name: string) {
        const filePath = path.join(root.stdout.replace(/\r?\n$/, ""), name);
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
        if (info === null || info.isDirectory()) return; // Gitlinks contain no file payload.
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
      }),
    });
    yield* execute({
      operation,
      cwd,
      args: ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", "."],
      env: { ...env, GIT_OPTIONAL_LOCKS: "0" },
      // Only stderr needs buffering. Every stdout byte goes through the awaited consumer.
      maxOutputBytes: 4096,
      outputMode: "truncate",
      timeoutMs: CHECKPOINT_CAPTURE_TIMEOUT_MS,
      onStdoutChunkEffect: (chunk) =>
        consumer.consume(chunk).pipe(
          Effect.mapError(
            (cause) =>
              new ProcessReadError({
                command: "git",
                argumentCount: 6,
                cwd,
                stream: "stdout",
                cause,
              }),
          ),
        ),
    }).pipe(
      Effect.mapError((error) =>
        error._tag === "VcsProcessOutputReadError" && isCheckpointUnavailable(error.cause)
          ? error.cause
          : error,
      ),
    );
    yield* consumer.finish;
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
  return { stagingRepo, stagedEnv, objectFormat: objectFormat.stdout.trim() };
});

/** Moves the staged commit's object graph into the user's repository and
 * publishes the hidden checkpoint ref there. */
export const publishStagedCheckpoint = Effect.fnUntraced(function* (input: {
  readonly execute: VcsDriver.VcsDriver["Service"]["execute"];
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly gitCommonDir: string;
  readonly objectFormat: string;
  readonly operation: string;
  readonly cwd: string;
  readonly stagingRepo: string;
  readonly stagedEnv: NodeJS.ProcessEnv;
  readonly cleanGitEnv: NodeJS.ProcessEnv;
  readonly durableWrite: ReadonlyArray<string>;
  readonly commitOid: string;
  readonly checkpointRef: string;
}) {
  const {
    execute,
    operation,
    stagingRepo,
    stagedEnv,
    cleanGitEnv,
    durableWrite,
    commitOid,
    fileSystem,
    path,
    gitCommonDir,
    objectFormat,
  } = input;
  // Same precedence as fetch: fetch.unpackLimit, then transfer.unpackLimit, then 100.
  const resolveUnpackLimit = (cwd: string, env: NodeJS.ProcessEnv) =>
    execute({
      operation: VcsProcess.CHECKPOINT_CAPTURE_OPERATION,
      cwd,
      args: ["config", "--type=int", "--get-regexp", "^(fetch|transfer)\\.unpacklimit$"],
      env,
      allowNonZeroExit: true,
    }).pipe(
      Effect.map((result) => {
        const limit = (section: string) => {
          const values = [
            ...result.stdout.matchAll(new RegExp(`^${section}\\.unpacklimit (-?\\d+)$`, "gm")),
          ];
          const value = Number(values.at(-1)?.[1] ?? -1);
          return value >= 0 ? value : undefined;
        };
        return limit("fetch") ?? limit("transfer") ?? GIT_DEFAULT_UNPACK_LIMIT;
      }),
    );

  // A fetch from the staging repository would re-send every unchanged file:
  // the checkpoint commit has no parent, so upload-pack cannot exclude what the
  // workspace repository already has. Pack only the staging repository's own
  // objects (--local skips those borrowed through the alternate), as one pack
  // whatever size limit the user's Git configuration sets.
  yield* (yield* CheckpointPublicationWitness)({
    cwd: input.cwd,
    checkpointRef: input.checkpointRef,
    commitOid,
  });
  const packBase = path.join(stagingRepo, "checkpoint");
  const packResult = yield* execute({
    operation,
    cwd: input.cwd,
    args: [
      "--git-dir",
      stagingRepo,
      "-c",
      "pack.packSizeLimit=0",
      "pack-objects",
      "--revs",
      "--local",
      "-q",
      packBase,
    ],
    stdin: `${commitOid}\n`,
    env: stagedEnv,
  });
  const packHash = packResult.stdout.trim();
  if (!/^[0-9a-f]+$/.test(packHash)) {
    return yield* new VcsProcessExitError({
      operation,
      command: "git pack-objects",
      cwd: input.cwd,
      exitCode: 0,
      detail: "git pack-objects returned an invalid pack name.",
    });
  }
  const packPath = `${packBase}-${packHash}.pack`;
  const packInfo = yield* fileSystem
    .stat(packPath)
    .pipe(
      Effect.mapError((error) => checkpointFileError(input.cwd, "read checkpoint pack", error)),
    );
  const smallPack =
    Number(packInfo.size) <= CHECKPOINT_LOOSE_TRANSFER_MAX_BYTES
      ? yield* fileSystem
          .readFile(packPath)
          .pipe(
            Effect.mapError((error) =>
              checkpointFileError(input.cwd, "read checkpoint pack", error),
            ),
          )
      : undefined;
  const unpackLimit = yield* resolveUnpackLimit(input.cwd, cleanGitEnv);
  // Pack header: "PACK", version, then the big-endian object count.
  const packObjectCount =
    smallPack === undefined || smallPack.byteLength < 12
      ? Number.POSITIVE_INFINITY
      : new DataView(smallPack.buffer, smallPack.byteOffset, 12).getUint32(8);

  if (smallPack !== undefined && packObjectCount < unpackLimit) {
    // Like a small fetch, store few objects loose instead of adding a pack per turn.
    yield* execute({
      operation,
      cwd: input.cwd,
      args: [...durableWrite, "unpack-objects", "-q"],
      stdinBytes: smallPack,
      env: cleanGitEnv,
    });
    // Never publish an incomplete checkpoint. This is the check fetch runs; doing
    // it first keeps a failure from falling back to a full upload-pack transfer.
    yield* execute({
      operation,
      cwd: input.cwd,
      args: ["rev-list", "--objects", "--quiet", commitOid, "--not", "--all", "--alternate-refs"],
      env: cleanGitEnv,
    });
    // Every object is local now, so fetch only checks connectivity, updates
    // the ref and runs automatic maintenance, as any fetch would.
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
        gitCommonDir,
        `+${commitOid}:${input.checkpointRef}`,
      ],
      env: cleanGitEnv,
    });
  } else {
    // Large transfers arrive as a bundle; fetch checks connectivity and keeps the pack.
    const bundlePath = path.join(stagingRepo, "checkpoint.bundle");
    const bundleHeader =
      objectFormat === "sha256"
        ? `# v3 git bundle\n@object-format=sha256\n${commitOid} refs/t3/staging\n\n`
        : `# v2 git bundle\n${commitOid} refs/t3/staging\n\n`;
    yield* fileSystem.writeFileString(bundlePath, bundleHeader, { flag: "wx" }).pipe(
      Effect.andThen(
        Stream.run(fileSystem.stream(packPath), fileSystem.sink(bundlePath, { flag: "a" })),
      ),
      Effect.mapError((error) => checkpointFileError(input.cwd, "write checkpoint bundle", error)),
    );
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
        bundlePath,
        `+refs/t3/staging:${input.checkpointRef}`,
      ],
      env: cleanGitEnv,
    });
  }
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
