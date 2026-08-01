/**
 * CheckpointStoreLive - Filesystem checkpoint store adapter layer.
 *
 * Implements hidden Git-ref checkpoint capture/restore directly with
 * Effect-native child process execution (`effect/unstable/process`).
 *
 * This layer owns filesystem/Git interactions only; it does not persist
 * checkpoint metadata and does not coordinate provider rollback semantics.
 *
 * @module CheckpointStoreLive
 */
import { randomUUID } from "node:crypto";

import { Cause, Deferred, Effect, Exit, Layer, FileSystem, Option, Path, Semaphore } from "effect";

import { CheckpointInvariantError, type CheckpointStoreError } from "../Errors.ts";
import { GitCommandError } from "../../git/Errors.ts";
import { GitCore } from "../../git/Services/GitCore.ts";
import { CheckpointStore, type CheckpointStoreShape } from "../Services/CheckpointStore.ts";
import { CheckpointRef } from "@synara/contracts";

const CHECKPOINT_DIFF_MAX_OUTPUT_BYTES = 10_000_000;
const TEMP_INDEX_GIT_CONFIG = ["-c", "core.splitIndex=false"] as const;

// Individual git commands are already bounded by GitCore's default timeout;
// this aggregate cap exists to unstick the shared in-flight capture slot if a
// step without its own bound (e.g. temp-dir filesystem work) hangs. It exceeds
// the worst per-command-capped chain, so it never truncates a capture the
// per-command timeouts would allow.
const CHECKPOINT_CAPTURE_TIMEOUT_MS = 180_000;

const makeCheckpointStore = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const git = yield* GitCore;
  const captureLock = yield* Semaphore.make(1);
  const inFlightCaptures = new Map<string, Deferred.Deferred<void, CheckpointStoreError>>();

  // Normalize the cwd so captures for the same repo reached via differently
  // written paths (trailing slash, relative segments) share one in-flight slot.
  const captureKey = (input: { readonly cwd: string; readonly checkpointRef: CheckpointRef }) =>
    `${path.resolve(input.cwd)}\0${input.checkpointRef}`;

  const resolveHeadCommit = (cwd: string): Effect.Effect<string | null, GitCommandError> =>
    git
      .execute({
        operation: "CheckpointStore.resolveHeadCommit",
        cwd,
        args: ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"],
        allowNonZeroExit: true,
      })
      .pipe(
        Effect.map((result) => {
          if (result.code !== 0) {
            return null;
          }
          const commit = result.stdout.trim();
          return commit.length > 0 ? commit : null;
        }),
      );

  const hasHeadCommit = (cwd: string): Effect.Effect<boolean, GitCommandError> =>
    git
      .execute({
        operation: "CheckpointStore.hasHeadCommit",
        cwd,
        args: ["rev-parse", "--verify", "HEAD"],
        allowNonZeroExit: true,
      })
      .pipe(Effect.map((result) => result.code === 0));

  const seedCheckpointIndex = (cwd: string, tempIndexPath: string): Effect.Effect<boolean> =>
    Effect.gen(function* () {
      const topLevelResult = yield* git.execute({
        operation: "CheckpointStore.resolveWorktreeTopLevel",
        cwd,
        args: ["rev-parse", "--show-toplevel"],
        allowNonZeroExit: true,
      });
      const topLevelRaw = topLevelResult.stdout.trim();
      if (topLevelResult.code !== 0 || topLevelRaw.length === 0) {
        return false;
      }

      const [canonicalCwd, canonicalTopLevel] = yield* Effect.all([
        fs.realPath(path.resolve(cwd)),
        fs.realPath(path.resolve(cwd, topLevelRaw)),
      ]);
      if (canonicalCwd !== canonicalTopLevel) {
        return false;
      }

      const indexPathResult = yield* git.execute({
        operation: "CheckpointStore.resolveWorkingIndex",
        cwd,
        args: ["rev-parse", "--git-path", "index"],
        allowNonZeroExit: true,
      });
      const indexPathRaw = indexPathResult.stdout.trim();
      if (indexPathResult.code !== 0 || indexPathRaw.length === 0) {
        return false;
      }

      const indexPath = path.isAbsolute(indexPathRaw)
        ? indexPathRaw
        : path.resolve(cwd, indexPathRaw);
      const tempIndexEnv: NodeJS.ProcessEnv = {
        ...process.env,
        GIT_INDEX_FILE: tempIndexPath,
      };
      const discardSeed = fs.remove(tempIndexPath, { force: true }).pipe(
        Effect.catch(() => Effect.void),
        Effect.as(false),
      );

      // Git writes the live index through index.lock + rename, so copying the
      // resolved file observes a complete old or new index without touching
      // the user's staging area.
      return yield* Effect.gen(function* () {
        yield* fs.copyFile(indexPath, tempIndexPath);

        // A split index refers to sharedindex.* in the repository. Expand only
        // the temporary copy so no checkpoint command can create or rotate
        // shared-index files beside the user's live index.
        yield* git.execute({
          operation: "CheckpointStore.normalizeCheckpointIndex",
          cwd,
          args: [...TEMP_INDEX_GIT_CONFIG, "update-index", "--no-split-index"],
          env: tempIndexEnv,
        });

        // assume-unchanged and skip-worktree entries make `git add -A`
        // intentionally ignore worktree content. Keep the established capture
        // semantics by using the HEAD/empty-index fallback for these uncommon
        // indexes instead of copying their behavior flags.
        const flagsResult = yield* git.execute({
          operation: "CheckpointStore.inspectCheckpointIndexFlags",
          cwd,
          args: [...TEMP_INDEX_GIT_CONFIG, "ls-files", "-v", "-z"],
          env: tempIndexEnv,
          maxOutputBytes: CHECKPOINT_DIFF_MAX_OUTPUT_BYTES,
        });
        const hasProtectedEntryFlags = flagsResult.stdout
          .split("\0")
          .some((entry) => /^[a-zS] /.test(entry));
        if (hasProtectedEntryFlags) {
          return yield* discardSeed;
        }

        // Force tracked entries through Git's clean/hash path before the full
        // add. A copied live index can otherwise treat a rapid same-size
        // rewrite as stat-clean and silently reuse its stale blob id.
        yield* git.execute({
          operation: "CheckpointStore.rehashCheckpointIndex",
          cwd,
          args: [...TEMP_INDEX_GIT_CONFIG, "add", "--renormalize", "-u", "--", "."],
          env: tempIndexEnv,
        });

        return true;
      }).pipe(Effect.catch(() => discardSeed));
    }).pipe(Effect.catch(() => Effect.succeed(false)));

  const resolveCheckpointCommit = (
    cwd: string,
    checkpointRef: CheckpointRef,
  ): Effect.Effect<string | null, GitCommandError> =>
    git
      .execute({
        operation: "CheckpointStore.resolveCheckpointCommit",
        cwd,
        args: ["rev-parse", "--verify", "--quiet", `${checkpointRef}^{commit}`],
        allowNonZeroExit: true,
      })
      .pipe(
        Effect.map((result) => {
          if (result.code !== 0) {
            return null;
          }
          const commit = result.stdout.trim();
          return commit.length > 0 ? commit : null;
        }),
      );

  const isGitRepository: CheckpointStoreShape["isGitRepository"] = (cwd) =>
    git
      .execute({
        operation: "CheckpointStore.isGitRepository",
        cwd,
        args: ["rev-parse", "--is-inside-work-tree"],
        allowNonZeroExit: true,
      })
      .pipe(
        Effect.map((result) => result.code === 0 && result.stdout.trim() === "true"),
        Effect.catch(() => Effect.succeed(false)),
      );

  const captureCheckpointOnce: CheckpointStoreShape["captureCheckpoint"] = (input) =>
    Effect.gen(function* () {
      const operation = "CheckpointStore.captureCheckpoint";

      // Checked inside the single-flight owner (see captureCheckpoint) so the
      // existence probe and the capture cannot interleave with another capture
      // for the same (cwd, checkpointRef).
      if (input.skipIfExists) {
        const existingCommit = yield* resolveCheckpointCommit(input.cwd, input.checkpointRef);
        if (existingCommit !== null) {
          return;
        }
      }

      yield* Effect.acquireUseRelease(
        fs.makeTempDirectory({ prefix: "scient-fs-checkpoint-" }),
        (tempDir) =>
          Effect.gen(function* () {
            const tempIndexPath = path.join(tempDir, `index-${randomUUID()}`);
            const commitEnv: NodeJS.ProcessEnv = {
              ...process.env,
              GIT_INDEX_FILE: tempIndexPath,
              GIT_AUTHOR_NAME: "Scient",
              GIT_AUTHOR_EMAIL: "scient@users.noreply.github.com",
              GIT_COMMITTER_NAME: "Scient",
              GIT_COMMITTER_EMAIL: "scient@users.noreply.github.com",
            };

            const seededFromWorkingIndex = yield* seedCheckpointIndex(input.cwd, tempIndexPath);
            if (!seededFromWorkingIndex && (yield* hasHeadCommit(input.cwd))) {
              yield* git.execute({
                operation,
                cwd: input.cwd,
                args: [...TEMP_INDEX_GIT_CONFIG, "read-tree", "HEAD"],
                env: commitEnv,
              });
            }

            yield* git.execute({
              operation,
              cwd: input.cwd,
              args: [...TEMP_INDEX_GIT_CONFIG, "add", "-A", "--", "."],
              env: commitEnv,
            });

            const writeTreeResult = yield* git.execute({
              operation,
              cwd: input.cwd,
              args: [...TEMP_INDEX_GIT_CONFIG, "write-tree"],
              env: commitEnv,
            });
            const treeOid = writeTreeResult.stdout.trim();
            if (treeOid.length === 0) {
              return yield* new GitCommandError({
                operation,
                command: "git write-tree",
                cwd: input.cwd,
                detail: "git write-tree returned an empty tree oid.",
              });
            }

            const message = `Scient checkpoint ref=${input.checkpointRef}`;
            const commitTreeResult = yield* git.execute({
              operation,
              cwd: input.cwd,
              args: [...TEMP_INDEX_GIT_CONFIG, "commit-tree", treeOid, "-m", message],
              env: commitEnv,
            });
            const commitOid = commitTreeResult.stdout.trim();
            if (commitOid.length === 0) {
              return yield* new GitCommandError({
                operation,
                command: "git commit-tree",
                cwd: input.cwd,
                detail: "git commit-tree returned an empty commit oid.",
              });
            }

            yield* git.execute({
              operation,
              cwd: input.cwd,
              args: ["update-ref", input.checkpointRef, commitOid],
            });
          }),
        (tempDir) => fs.remove(tempDir, { recursive: true }),
      ).pipe(
        Effect.catchTags({
          PlatformError: (error) =>
            Effect.fail(
              new CheckpointInvariantError({
                operation: "CheckpointStore.captureCheckpoint",
                detail: "Failed to capture checkpoint.",
                cause: error,
              }),
            ),
        }),
      );
    });

  const captureCheckpoint: CheckpointStoreShape["captureCheckpoint"] = (input) =>
    Effect.gen(function* () {
      const key = captureKey(input);
      const registration = yield* captureLock.withPermits(1)(
        Effect.gen(function* () {
          const existing = inFlightCaptures.get(key);
          if (existing) {
            return { owner: false as const, deferred: existing };
          }
          const deferred = yield* Deferred.make<void, CheckpointStoreError>();
          inFlightCaptures.set(key, deferred);
          return { owner: true as const, deferred };
        }),
      );

      if (!registration.owner) {
        return yield* Deferred.await(registration.deferred);
      }

      // Let the git capture remain interruptible, but always notify waiters
      // and clear the shared in-flight slot before this owner fiber exits.
      return yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const exit = yield* Effect.exit(
            restore(
              git.withActionLock(input.cwd, captureCheckpointOnce(input)).pipe(
                Effect.timeoutOption(CHECKPOINT_CAPTURE_TIMEOUT_MS),
                Effect.flatMap((completed) =>
                  Option.isSome(completed)
                    ? Effect.void
                    : Effect.fail(
                        new CheckpointInvariantError({
                          operation: "CheckpointStore.captureCheckpoint",
                          detail: `Checkpoint capture timed out after ${CHECKPOINT_CAPTURE_TIMEOUT_MS}ms.`,
                        }),
                      ),
                ),
              ),
            ),
          );
          // Waiters joined an in-flight capture they do not control; replaying the
          // owner's raw interrupt cause would make callers treat it as their own
          // fiber being interrupted. Surface a typed error instead.
          const waiterExit =
            Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)
              ? Exit.fail(
                  new CheckpointInvariantError({
                    operation: "CheckpointStore.captureCheckpoint",
                    detail: "Checkpoint capture was interrupted before completion.",
                  }),
                )
              : exit;
          yield* Deferred.done(registration.deferred, waiterExit);
          yield* captureLock.withPermits(1)(Effect.sync(() => inFlightCaptures.delete(key)));
          if (Exit.isFailure(exit)) {
            return yield* Effect.failCause(exit.cause);
          }
        }),
      );
    });

  const hasCheckpointRef: CheckpointStoreShape["hasCheckpointRef"] = (input) =>
    resolveCheckpointCommit(input.cwd, input.checkpointRef).pipe(
      Effect.map((commit) => commit !== null),
    );

  const copyCheckpointRef: CheckpointStoreShape["copyCheckpointRef"] = (input) =>
    git.withActionLock(
      input.cwd,
      Effect.gen(function* () {
        const operation = "CheckpointStore.copyCheckpointRef";
        const commitOid = yield* resolveCheckpointCommit(input.cwd, input.fromCheckpointRef);
        if (!commitOid) {
          return false;
        }

        yield* git.execute({
          operation,
          cwd: input.cwd,
          args: ["update-ref", input.toCheckpointRef, commitOid],
        });
        return true;
      }),
    );

  const restoreCheckpoint: CheckpointStoreShape["restoreCheckpoint"] = (input) =>
    git.withActionLock(
      input.cwd,
      Effect.gen(function* () {
        const operation = "CheckpointStore.restoreCheckpoint";

        let commitOid = yield* resolveCheckpointCommit(input.cwd, input.checkpointRef);

        if (!commitOid && input.fallbackToHead === true) {
          commitOid = yield* resolveHeadCommit(input.cwd);
        }

        if (!commitOid) {
          return false;
        }

        yield* git.execute({
          operation,
          cwd: input.cwd,
          args: ["restore", "--source", commitOid, "--worktree", "--staged", "--", "."],
        });
        yield* git.execute({
          operation,
          cwd: input.cwd,
          args: ["clean", "-fd", "--", "."],
        });

        const headExists = yield* hasHeadCommit(input.cwd);
        if (headExists) {
          yield* git.execute({
            operation,
            cwd: input.cwd,
            args: ["reset", "--quiet", "--", "."],
          });
        }

        return true;
      }),
    );

  const diffCheckpoints: CheckpointStoreShape["diffCheckpoints"] = (input) =>
    Effect.gen(function* () {
      const operation = "CheckpointStore.diffCheckpoints";

      let [fromCommitOid, toCommitOid] = yield* Effect.all(
        [
          resolveCheckpointCommit(input.cwd, input.fromCheckpointRef),
          resolveCheckpointCommit(input.cwd, input.toCheckpointRef),
        ],
        { concurrency: "unbounded" },
      );

      if (!fromCommitOid && input.fallbackFromToHead === true) {
        const headCommit = yield* resolveHeadCommit(input.cwd);
        if (headCommit) {
          fromCommitOid = headCommit;
        }
      }

      if (!fromCommitOid || !toCommitOid) {
        return yield* new GitCommandError({
          operation,
          command: "git diff",
          cwd: input.cwd,
          detail: "Checkpoint ref is unavailable for diff operation.",
        });
      }

      const result = yield* git.execute({
        operation,
        cwd: input.cwd,
        args: [
          "diff",
          "--patch",
          "--minimal",
          "--no-color",
          "--no-ext-diff",
          "--no-textconv",
          ...(input.ignoreWhitespace ? ["--ignore-all-space"] : []),
          fromCommitOid,
          toCommitOid,
        ],
        maxOutputBytes: input.maxOutputBytes ?? CHECKPOINT_DIFF_MAX_OUTPUT_BYTES,
      });

      return result.stdout;
    });

  const reverseCheckpointDiff: CheckpointStoreShape["reverseCheckpointDiff"] = (input) =>
    git.withActionLock(
      input.cwd,
      Effect.gen(function* () {
        const operation = "CheckpointStore.reverseCheckpointDiff";
        const [fromCommitOid, toCommitOid] = yield* Effect.all(
          [
            resolveCheckpointCommit(input.cwd, input.fromCheckpointRef),
            resolveCheckpointCommit(input.cwd, input.toCheckpointRef),
          ],
          { concurrency: "unbounded" },
        );

        if (!fromCommitOid || !toCommitOid) {
          return false;
        }

        const diff = yield* git.execute({
          operation,
          cwd: input.cwd,
          args: [
            "diff",
            "--patch",
            "--binary",
            "--full-index",
            "--no-color",
            "--no-ext-diff",
            "--no-textconv",
            fromCommitOid,
            toCommitOid,
          ],
          maxOutputBytes: input.maxOutputBytes ?? CHECKPOINT_DIFF_MAX_OUTPUT_BYTES,
        });
        if (diff.stdout.length === 0) {
          return true;
        }

        const changedPaths = yield* git.execute({
          operation,
          cwd: input.cwd,
          args: ["diff", "--name-only", "--no-renames", "-z", fromCommitOid, toCommitOid],
          maxOutputBytes: input.maxOutputBytes ?? CHECKPOINT_DIFF_MAX_OUTPUT_BYTES,
        });
        const affectedPaths = changedPaths.stdout.split("\0").filter((entry) => entry.length > 0);

        return yield* Effect.acquireUseRelease(
          fs.makeTempDirectory({ prefix: "scient-checkpoint-undo-" }),
          (tempDir) =>
            Effect.gen(function* () {
              const patchPath = path.join(tempDir, "turn.patch");
              yield* fs.writeFileString(patchPath, diff.stdout);
              yield* git.execute({
                operation,
                cwd: input.cwd,
                args: ["apply", "--reverse", "--whitespace=nowarn", "--", patchPath],
              });
              if (affectedPaths.length > 0) {
                const resetExit = yield* Effect.exit(
                  git.execute({
                    operation,
                    cwd: input.cwd,
                    args: ["reset", "--quiet", fromCommitOid, "--", ...affectedPaths],
                  }),
                );
                if (Exit.isFailure(resetExit)) {
                  yield* git.execute({
                    operation,
                    cwd: input.cwd,
                    args: ["apply", "--whitespace=nowarn", "--", patchPath],
                  });
                  return yield* Effect.failCause(resetExit.cause);
                }
              }
              return true;
            }),
          (tempDir) => fs.remove(tempDir, { recursive: true }),
        ).pipe(
          Effect.catchTag("PlatformError", (error) =>
            Effect.fail(
              new CheckpointInvariantError({
                operation,
                detail: "Failed to prepare the checkpoint patch for undo.",
                cause: error,
              }),
            ),
          ),
        );
      }),
    );

  const deleteCheckpointRefs: CheckpointStoreShape["deleteCheckpointRefs"] = (input) =>
    git.withActionLock(
      input.cwd,
      Effect.gen(function* () {
        const operation = "CheckpointStore.deleteCheckpointRefs";

        // Ref deletion writes contend on packed-refs.lock, so keep these writes
        // explicitly sequential; allowNonZeroExit would otherwise hide a race.
        yield* Effect.forEach(
          input.checkpointRefs,
          (checkpointRef) =>
            git.execute({
              operation,
              cwd: input.cwd,
              args: ["update-ref", "-d", checkpointRef],
              allowNonZeroExit: true,
            }),
          { concurrency: 1, discard: true },
        );
      }),
    );

  return {
    isGitRepository,
    captureCheckpoint,
    copyCheckpointRef,
    hasCheckpointRef,
    restoreCheckpoint,
    diffCheckpoints,
    reverseCheckpointDiff,
    deleteCheckpointRefs,
  } satisfies CheckpointStoreShape;
});

export const CheckpointStoreLive = Layer.effect(CheckpointStore, makeCheckpointStore);
