/**
 * Scient's limits on the Git driver's checkpoint capture: a changed-file size limit and one
 * deadline for the whole capture, submodules included. Forks also witness the commit a capture
 * is about to publish.
 */
// @effect-diagnostics-next-line nodeBuiltinImport:off - FileSystem.stat follows symlinks; checkpoint accounting needs lstat.
import * as NodeFSP from "node:fs/promises";

import { VcsCheckpointUnavailableError, VcsProcessTimeoutError } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Context from "effect/Context";
import type { VcsError } from "@t3tools/contracts";

import type * as VcsDriver from "./VcsDriver.ts";
import * as VcsProcess from "./VcsProcess.ts";
import { makeCheckpointStatusConsumer } from "./CheckpointStatusConsumer.ts";
import * as Schema from "effect/Schema";
import { ProcessReadError } from "../processRunner.ts";
import * as HostProcess from "@t3tools/shared/HostProcess";

const isCheckpointUnavailable = Schema.is(VcsCheckpointUnavailableError);

/** Fork admission persists its expected OID before the capture writes objects or a ref.
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

const CHECKPOINT_CAPTURE_TIMEOUT_MS = 90_000;
const CHECKPOINT_CAPTURE_MAX_FILE_BYTES = 512n * 1024n * 1024n;
const CHECKPOINT_CAPTURE_MAX_CHANGED_BYTES = 1024n * 1024n * 1024n;
/**
 * How long the changed-file size scan may run. Every turn's first message waits for it, so a
 * workspace it cannot finish in time is treated as too large, and a too-large workspace is not
 * rescanned for a while. Tests of capture itself raise it; a loaded runner is not a slow user.
 */
export class CheckpointSizeScanTimeout extends Context.Reference<number>(
  "ScientCheckpointCapture/SizeScanTimeout",
  { defaultValue: () => 2_000 },
) {}
const CHECKPOINT_SIZE_LIMIT_MEMORY_MS = 10 * 60_000;

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
}) => {
  const { execute } = deps;
  const tooLargeUntil = new Map<string, number>();
  const tooLarge = (cwd: string, detail: string) =>
    new VcsCheckpointUnavailableError({
      operation: VcsProcess.CHECKPOINT_CAPTURE_OPERATION,
      cwd,
      reason: "size-limit",
      detail,
    });
  return Effect.fn("GitVcsDriver.checkpoints.checkSize")(function* (
    cwd: string,
    env: NodeJS.ProcessEnv,
  ) {
    const operation = VcsProcess.CHECKPOINT_CAPTURE_OPERATION;
    const scanTimeoutMs = yield* CheckpointSizeScanTimeout;
    const now = yield* Clock.currentTimeMillis;
    if (now < (tooLargeUntil.get(cwd) ?? 0))
      return yield* tooLarge(cwd, "Changed files were too large for file history a moment ago.");
    // Porcelain v1 paths are repository-relative even when cwd is a subdirectory.
    // Scope enumeration to the same pathspec used by checkpoint staging.
    const root = yield* execute({ operation, cwd, args: ["rev-parse", "--show-toplevel"], env });
    const rootPrefix = Buffer.from(`${root.stdout.replace(/\r?\n$/, "")}/`);
    let changedBytes = 0n;
    const consumer = makeCheckpointStatusConsumer({
      cwd,
      operation,
      platform: yield* HostProcess.Platform,
      onPath: Effect.fnUntraced(function* (name: Uint8Array) {
        // Join as bytes so a filename that is not valid UTF-8 is looked up as is.
        const filePath = Buffer.concat([rootPrefix, name]);
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
          return yield* tooLarge(
            cwd,
            "Changed files exceed the checkpoint capture size limit (512 MiB per file, 1 GiB total).",
          );
        }
      }),
    });
    yield* Effect.gen(function* () {
      yield* execute({
        operation,
        cwd,
        args: ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", "."],
        env: { ...env, GIT_OPTIONAL_LOCKS: "0" },
        // Only stderr needs buffering. Every stdout byte goes through the awaited consumer.
        maxOutputBytes: 4096,
        outputMode: "truncate",
        timeoutMs: scanTimeoutMs,
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
            : error._tag === "VcsProcessTimeoutError"
              ? tooLarge(cwd, "Too many changed files to measure for file history.")
              : error,
        ),
      );
      yield* consumer.finish;
    }).pipe(
      Effect.tapError((error) =>
        isCheckpointUnavailable(error) && error.reason === "size-limit"
          ? Clock.currentTimeMillis.pipe(
              Effect.map((at) => tooLargeUntil.set(cwd, at + CHECKPOINT_SIZE_LIMIT_MEMORY_MS)),
            )
          : Effect.void,
      ),
    );
  });
};

/** What remains of one capture's deadline for the work after its own commit, such as submodules. */
export const remainingCheckpointCaptureMs = (startedAtMs: number, nowMs: number) =>
  Math.max(0, CHECKPOINT_CAPTURE_TIMEOUT_MS - (nowMs - startedAtMs));

/** One deadline for the whole capture. */
export const boundCheckpointCapture =
  (operation: string, cwd: string) =>
  <A, E, R>(capture: Effect.Effect<A, E, R>) =>
    capture.pipe(
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
