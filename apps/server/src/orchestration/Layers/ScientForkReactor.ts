/**
 * Durable Scient conversation-fork worker.
 *
 * The event stream is only a wake-up path. The Scient lineage table is the
 * authority for pending, retryable, and completed work, so a server restart
 * cannot strand an accepted fork. All external operations use deterministic
 * refs, branches, worktree discovery, and command ids to make retries safe.
 */
import { CommandId, type ThreadForkedPayload, type VcsRef } from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { checkpointRefForThreadTurn } from "../../checkpointing/Utils.ts";
import { GitWorkflowService } from "../../git/GitWorkflowService.ts";
import { forkParked } from "../../serverActivation.ts";
import {
  claimForkAttempt,
  getRecoverableFork,
  getReadyForkAttachmentIdMap,
  isForkThreadDeleted,
  originTurnAtCheckpoint,
  getForkStatus,
  listRecoverableForks,
  markForkAbandoned,
  markForkFailed,
  type ScientForkCheckpointStatus,
  type ScientForkWorkspaceStatus,
} from "../scient-fork/forkRepository.ts";
import { ScientForkCheckpointBaseline } from "../scient-fork/ForkCheckpointBaseline.ts";
import { ScientForkContextDelivery } from "../scient-fork/ForkContextDelivery.ts";
import { makeForkBoundaryResolver } from "../scient-fork/ForkBoundaryReadModel.ts";
import { retainPrefixMessages } from "../scient-fork/forkDecider.ts";
import { collectForkLiveTail } from "../scient-fork/forkLiveTail.ts";
import { ScientLiveTurnFlush } from "../scient-fork/liveTurnFlush.ts";
import {
  retainQuestionAnswers,
  questionAnswerAttachments,
} from "../scient-fork/retainedQuestionAnswers.ts";
import {
  ScientForkAttachmentCopier,
  ScientForkAttachmentCopyError,
} from "../scient-fork/ForkAttachmentCopier.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import {
  ScientForkCompletionError,
  ScientForkReactor,
  type ScientForkReactorShape,
} from "../Services/ScientForkReactor.ts";

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
const isScientForkCompletionError = Schema.is(ScientForkCompletionError);
const isScientForkAttachmentCopyError = Schema.is(ScientForkAttachmentCopyError);

class ScientForkTerminalProvisioningError extends Schema.TaggedError<ScientForkTerminalProvisioningError>()(
  "ScientForkTerminalProvisioningError",
  { detail: Schema.String },
) {}

const isScientForkTerminalProvisioningError = Schema.is(ScientForkTerminalProvisioningError);

function forkFailure(cause: Cause.Cause<unknown>): unknown {
  return cause.reasons.find(Cause.isFailReason)?.error;
}

function forkFailureDetail(cause: Cause.Cause<unknown>): string {
  const failure = forkFailure(cause);
  if (
    isScientForkCompletionError(failure) ||
    isScientForkTerminalProvisioningError(failure) ||
    isScientForkAttachmentCopyError(failure)
  ) {
    return failure.detail.slice(0, 4_000);
  }
  // Other failures keep their own sentence; stacks stay in the server log.
  if (typeof failure === "object" && failure !== null) {
    for (const key of ["detail", "message"] as const) {
      const value = (failure as Record<string, unknown>)[key];
      if (typeof value === "string" && value.trim().length > 0) return value.trim().slice(0, 4_000);
    }
  }
  return (
    Cause.pretty(cause)
      .split("\n")
      .find((line) => line.trim().length > 0)
      ?.trim()
      .slice(0, 4_000) ?? "Fork setup failed."
  );
}

function isTerminalForkError(failure: unknown): boolean {
  return (
    isScientForkTerminalProvisioningError(failure) ||
    (isScientForkAttachmentCopyError(failure) &&
      (failure.reason === "source-unavailable" || failure.reason === "unsafe-mapping"))
  );
}

function isTerminalForkFailure(cause: Cause.Cause<unknown>): boolean {
  return isTerminalForkError(forkFailure(cause));
}

/** Transient provisioning failures retry in place before the user sees them. */
const PROVISIONING_RETRIES = 3;
const PROVISIONING_RETRY_BASE = Duration.millis(250);
/** One attempt may not hold the serial fork worker indefinitely. */
// Git checkout has a five-minute deadline; leave room for the other provisioning stages.
const PROVISIONING_ATTEMPT_TIMEOUT = Duration.minutes(7);
const LEGACY_FORK_BOUNDARY_TURN_ID = "legacy-fork-boundary";

function forkBranchName(threadId: string): string {
  const safe = threadId
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 72);
  return `scient/fork/${safe || "thread"}`;
}

function exactRef(refs: ReadonlyArray<VcsRef>, refName: string): VcsRef | null {
  return refs.find((ref) => !ref.isRemote && ref.name === refName) ?? null;
}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const orchestrationEngine = yield* OrchestrationEngineService;
  const contextDelivery = yield* ScientForkContextDelivery;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const checkpointBaseline = yield* ScientForkCheckpointBaseline;
  const attachmentCopier = yield* ScientForkAttachmentCopier;
  const gitWorkflow = yield* GitWorkflowService;
  const completions = new Map<string, Deferred.Deferred<void, ScientForkCompletionError>>();
  /** What an in-progress provisioning created, so a terminal failure can remove it. */
  const provisioned = new Map<
    string,
    { readonly cwd: string; worktreePath: string | null; branch: string | null }
  >();

  const completionFor = (threadId: ThreadForkedPayload["newThreadId"]) =>
    Effect.sync(() => completions.get(threadId)).pipe(
      Effect.flatMap((existing) =>
        existing
          ? Effect.succeed(existing)
          : Deferred.make<void, ScientForkCompletionError>().pipe(
              Effect.tap((created) => Effect.sync(() => completions.set(threadId, created))),
            ),
      ),
    );

  const releaseCompletion = (
    threadId: ThreadForkedPayload["newThreadId"],
    completion: Deferred.Deferred<void, ScientForkCompletionError>,
  ) =>
    Effect.sync(() => {
      if (completions.get(threadId) === completion) {
        completions.delete(threadId);
      }
    });

  const ensureWorktree = Effect.fn("ensureScientForkWorktree")(function* (input: {
    readonly cwd: string;
    readonly fromRef: string;
    readonly threadId: ThreadForkedPayload["newThreadId"];
  }) {
    const branch = forkBranchName(input.threadId);
    const listed = yield* gitWorkflow.listRefs({
      cwd: input.cwd,
      query: branch,
      refKind: "local",
      includeMatchingRemoteRefs: false,
      refresh: true,
      limit: 100,
    });
    const existing = exactRef(listed.refs, branch);
    if (existing?.worktreePath) {
      const verified = yield* checkpointBaseline.verifyWorktree({
        ...input,
        path: existing.worktreePath,
        branch,
        checkpointRef: input.fromRef,
      });
      if (!verified) {
        return yield* new ScientForkCompletionError({
          threadId: input.threadId,
          detail:
            "The existing fork worktree is incomplete or has changed. Its files were left intact. Restore it to the saved checkpoint before retrying.",
        });
      }
      return { path: existing.worktreePath, refName: branch };
    }

    const created = yield* gitWorkflow.createWorktree(
      existing
        ? { cwd: input.cwd, refName: branch, path: null }
        : {
            cwd: input.cwd,
            refName: input.fromRef,
            newRefName: branch,
            path: null,
          },
    );
    if (
      !(yield* checkpointBaseline.verifyWorktree({
        ...input,
        path: created.worktree.path,
        branch,
        checkpointRef: input.fromRef,
      }))
    ) {
      return yield* new ScientForkTerminalProvisioningError({
        detail: "The new fork worktree did not complete checkout. Nothing was published as ready.",
      });
    }
    return created.worktree;
  });

  const processFork = Effect.fn("processScientFork")(function* (payload: ThreadForkedPayload) {
    const claimedAt = yield* nowIso;
    const attempt = yield* claimForkAttempt(sql, payload.newThreadId, claimedAt);
    if (attempt === null) {
      // Another worker owns the lifecycle or the fork is already terminal.
      const status = yield* getForkStatus(sql, payload.newThreadId);
      if (status?.status !== "ready") return;
      const completion = yield* completionFor(payload.newThreadId);
      yield* Deferred.succeed(completion, undefined);
      yield* releaseCompletion(payload.newThreadId, completion);
      return;
    }

    const context = yield* projectionSnapshotQuery.getThreadCheckpointContext(
      payload.originThreadId,
    );
    if (Option.isNone(context)) {
      return yield* new ScientForkTerminalProvisioningError({
        detail: `Origin workspace context is unavailable for '${payload.originThreadId}'.`,
      });
    }

    const capture = (yield* sql<{
      readonly checkpoint_oid: string;
      readonly captured_at: string;
      readonly source_turn_id: string | null;
      readonly source_running_turn_id: string | null;
    }>`
      SELECT checkpoint_oid, captured_at, source_turn_id, source_running_turn_id FROM scient_fork_snapshot_captures
      WHERE thread_id = ${payload.newThreadId} AND origin_thread_id = ${payload.originThreadId}`)[0];
    if (
      capture &&
      (capture.source_turn_id !== payload.forkAtTurnId ||
        capture.source_running_turn_id !== (payload.midTurnCut?.sourceTurnId ?? null))
    ) {
      return yield* new ScientForkTerminalProvisioningError({
        detail: "The source changed during snapshot capture. Fork its current history again.",
      });
    }
    const origin = context.value;
    // The baseline is copied by checkpoint count. A revert and rerun of the
    // origin can reuse that count for different work: refuse rather than copy it.
    if (
      capture === undefined &&
      payload.workspaceMode === "new-worktree" &&
      payload.midTurnCut === undefined &&
      payload.sourceCheckpointTurnCount !== null &&
      payload.forkAtTurnId !== null &&
      payload.forkAtTurnId !== LEGACY_FORK_BOUNDARY_TURN_ID
    ) {
      const currentTurnId = yield* originTurnAtCheckpoint(sql, {
        originThreadId: payload.originThreadId,
        checkpointTurnCount: payload.sourceCheckpointTurnCount,
      });
      if (currentTurnId !== payload.forkAtTurnId) {
        return yield* new ScientForkTerminalProvisioningError({
          detail:
            "The original conversation changed before this fork was set up: the forked turn was reverted or replaced. Fork it again from its current history.",
        });
      }
    }
    const originWorkspace = origin.worktreePath ?? origin.workspaceRoot;
    const localAvailable = yield* checkpointBaseline.workspaceExists(originWorkspace);
    if (payload.workspaceMode === "local" && !localAvailable) {
      return yield* new ScientForkTerminalProvisioningError({
        detail:
          "The original workspace no longer exists. Restore it or choose New worktree when a saved checkpoint is available.",
      });
    }
    const originCwd = localAvailable ? originWorkspace : origin.workspaceRoot;
    provisioned.set(payload.newThreadId, { cwd: originCwd, worktreePath: null, branch: null });
    const toRef = checkpointRefForThreadTurn(payload.newThreadId, 0);
    const sourceCheckpointTurnCount = payload.sourceCheckpointTurnCount;
    const fromRef =
      sourceCheckpointTurnCount === null
        ? null
        : checkpointRefForThreadTurn(payload.originThreadId, sourceCheckpointTurnCount);
    // A shared workspace has moved on since the forked turn: its first fork turn
    // captures a fresh baseline instead of diffing against historical files.
    const copiesBaseline = payload.workspaceMode === "new-worktree";
    // A running turn uses its separately captured workspace snapshot;
    // completed turns copy the selected turn's saved checkpoint.
    const snapshotsLiveWorkspace = copiesBaseline && payload.midTurnCut !== undefined;
    const isGitRepository =
      !copiesBaseline || (fromRef === null && !snapshotsLiveWorkspace)
        ? false
        : yield* checkpointBaseline.isGitRepository(originCwd);
    const baselined =
      capture !== undefined
        ? true
        : !isGitRepository
          ? false
          : snapshotsLiveWorkspace
            ? localAvailable &&
              // A retry keeps the first snapshot (its worktree may
              // already exist); only the first attempt captures the workspace.
              ((yield* checkpointBaseline
                .hasCheckpoint(originCwd, toRef)
                .pipe(Effect.orElseSucceed(() => false))) ||
                (yield* checkpointBaseline.capture({
                  cwd: originWorkspace,
                  toCheckpointRef: toRef,
                })))
            : fromRef !== null
              ? yield* checkpointBaseline.copy({
                  cwd: originCwd,
                  fromCheckpointRef: fromRef,
                  toCheckpointRef: toRef,
                })
              : false;
    if (baselined) {
      const oid = yield* checkpointBaseline.resolveCheckpoint(originCwd, toRef);
      if (oid === null || (capture !== undefined && capture.checkpoint_oid !== oid)) {
        return yield* new ScientForkTerminalProvisioningError({
          detail: "The frozen fork checkpoint is unavailable or changed. Fork again.",
        });
      }
      yield* sql`UPDATE scient_thread_lineage SET source_checkpoint_oid = ${oid},
        snapshot_captured_at = COALESCE(snapshot_captured_at, ${capture?.captured_at ?? (yield* nowIso)})
        WHERE thread_id = ${payload.newThreadId}`;
    }
    yield* attachmentCopier.copyAll({
      threadId: payload.newThreadId,
      copies: payload.attachmentCopies,
    });
    const checkpointStatus: ScientForkCheckpointStatus = baselined ? "ready" : "unavailable";

    if (yield* isForkThreadDeleted(sql, payload.newThreadId)) {
      return yield* new ScientForkTerminalProvisioningError({
        detail: "This fork was deleted while it was being set up.",
      });
    }
    let workspaceStatus: ScientForkWorkspaceStatus;
    if (payload.workspaceMode === "new-worktree") {
      const worktreeBase = toRef;
      if (!baselined || worktreeBase === null) {
        return yield* new ScientForkTerminalProvisioningError({
          detail: snapshotsLiveWorkspace
            ? "A new worktree cannot be created because the running conversation's workspace could not be snapshotted (it must be a Git repository that still exists)."
            : "A new worktree cannot be created because the selected conversation boundary has no ready Git checkpoint.",
        });
      }
      const worktree = yield* ensureWorktree({
        cwd: originCwd,
        fromRef: worktreeBase,
        threadId: payload.newThreadId,
      });
      provisioned.set(payload.newThreadId, {
        cwd: originCwd,
        worktreePath: worktree.path,
        branch: worktree.refName,
      });
      yield* orchestrationEngine.dispatch({
        type: "thread.meta.update",
        // Attempt-scoped: a rejected attempt's receipt must not reject retries.
        commandId: CommandId.make(`server:scient-fork:workspace:${payload.newThreadId}:${attempt}`),
        threadId: payload.newThreadId,
        branch: worktree.refName,
        worktreePath: worktree.path,
      });
      workspaceStatus = "worktree";
    } else if (origin.worktreePath !== null) {
      yield* orchestrationEngine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make(`server:scient-fork:workspace:${payload.newThreadId}:${attempt}`),
        threadId: payload.newThreadId,
        worktreePath: origin.worktreePath,
      });
      workspaceStatus = "shared";
    } else {
      workspaceStatus = "project-root";
    }

    yield* orchestrationEngine.dispatch({
      type: "thread.fork.complete",
      commandId: CommandId.make(`server:scient-fork:complete:${payload.newThreadId}:${attempt}`),
      threadId: payload.newThreadId,
      checkpointStatus,
      workspaceStatus,
      ...(checkpointStatus === "ready"
        ? {
            checkpointBaseline: {
              turnId: payload.baselineTurnId,
              assistantMessageId: payload.baselineAssistantMessageId,
            },
          }
        : {}),
      createdAt: yield* nowIso,
    });
    provisioned.delete(payload.newThreadId);
    const completion = yield* completionFor(payload.newThreadId);
    yield* Deferred.succeed(completion, undefined);
    yield* releaseCompletion(payload.newThreadId, completion);
  });

  /**
   * Removes what a terminally failed fork created, then its thread. Only
   * fork-owned names are touched (its `scient/fork/<id>` branch, that branch's
   * worktree and its turn-zero ref), found from Git rather than from memory,
   * so a worktree created by an earlier attempt or before a restart is removed.
   */
  const discardProvisioned = (payload: ThreadForkedPayload) =>
    Effect.gen(function* () {
      const created = provisioned.get(payload.newThreadId);
      provisioned.delete(payload.newThreadId);
      const originContext = yield* projectionSnapshotQuery
        .getThreadCheckpointContext(payload.originThreadId)
        .pipe(
          Effect.map(Option.getOrUndefined),
          Effect.orElseSucceed(() => undefined),
        );
      const cwd =
        created?.cwd ?? originContext?.worktreePath ?? originContext?.workspaceRoot ?? null;
      if (cwd !== null) {
        const branch = forkBranchName(payload.newThreadId);
        const existing = yield* gitWorkflow
          .listRefs({
            cwd,
            query: branch,
            refKind: "local",
            includeMatchingRemoteRefs: false,
            refresh: true,
            limit: 100,
          })
          .pipe(
            Effect.map((listed) => exactRef(listed.refs, branch)),
            Effect.orElseSucceed(() => null),
          );
        yield* checkpointBaseline.discard({
          cwd,
          checkpointRef: checkpointRefForThreadTurn(payload.newThreadId, 0),
          worktreePath: existing?.worktreePath ?? created?.worktreePath ?? null,
          branch: existing !== null ? branch : (created?.branch ?? null),
        });
      }
      if (yield* isForkThreadDeleted(sql, payload.newThreadId)) return;
      yield* orchestrationEngine.dispatch({
        type: "thread.delete",
        commandId: CommandId.make(`server:scient-fork:abandon:${payload.newThreadId}`),
        threadId: payload.newThreadId,
      });
    });

  const processForkSafely = (payload: ThreadForkedPayload) =>
    processFork(payload).pipe(
      Effect.timeoutOrElse({
        duration: PROVISIONING_ATTEMPT_TIMEOUT,
        orElse: () =>
          Effect.fail(
            new ScientForkCompletionError({
              threadId: payload.newThreadId,
              detail:
                "Setting up the fork took too long (for example, creating its worktree). Try forking again.",
            }),
          ),
      }),
      Effect.retry({
        schedule: Schedule.exponential(PROVISIONING_RETRY_BASE),
        times: PROVISIONING_RETRIES,
        while: (failure) => !isTerminalForkError(failure) && !isScientForkCompletionError(failure),
      }),
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause);
        }
        const error = forkFailureDetail(cause);
        const terminal = isTerminalForkFailure(cause);
        const logCause = Effect.logWarning("scient fork provisioning failure", {
          newThreadId: payload.newThreadId,
          cause: Cause.pretty(cause),
        });
        const persistFailure = terminal
          ? discardProvisioned(payload).pipe(
              Effect.andThen(
                nowIso.pipe(
                  Effect.flatMap((updatedAt) =>
                    markForkAbandoned(sql, {
                      threadId: payload.newThreadId,
                      error,
                      updatedAt,
                    }),
                  ),
                ),
              ),
              Effect.catchCause((compensationCause) =>
                nowIso.pipe(
                  Effect.flatMap((updatedAt) =>
                    markForkFailed(sql, {
                      threadId: payload.newThreadId,
                      error:
                        `${error}\nCompensation failed: ${Cause.pretty(compensationCause)}`.slice(
                          0,
                          4_000,
                        ),
                      updatedAt,
                    }),
                  ),
                ),
              ),
            )
          : nowIso.pipe(
              Effect.flatMap((updatedAt) =>
                markForkFailed(sql, {
                  threadId: payload.newThreadId,
                  error,
                  updatedAt,
                }),
              ),
            );
        return logCause.pipe(
          Effect.andThen(persistFailure),
          Effect.catchCause((persistCause) =>
            Effect.logError("failed to persist Scient fork failure", {
              newThreadId: payload.newThreadId,
              cause: Cause.pretty(persistCause),
            }),
          ),
          Effect.andThen(
            Effect.logWarning(
              terminal
                ? "Scient fork provisioning failed terminally; the unusable fork was removed"
                : "Scient fork provisioning failed after retries and will retry after restart",
              {
                newThreadId: payload.newThreadId,
                cause: error,
              },
            ),
          ),
          Effect.andThen(
            completionFor(payload.newThreadId).pipe(
              Effect.flatMap((completion) =>
                Deferred.fail(
                  completion,
                  new ScientForkCompletionError({
                    threadId: payload.newThreadId,
                    detail: error,
                  }),
                ).pipe(Effect.andThen(releaseCompletion(payload.newThreadId, completion))),
              ),
            ),
          ),
        );
      }),
    );

  const queuedForks = new Set<string>();
  const worker = yield* makeDrainableWorker((payload: ThreadForkedPayload) =>
    processForkSafely(payload).pipe(
      Effect.ensuring(Effect.sync(() => queuedForks.delete(payload.newThreadId))),
    ),
  );
  const enqueue = (payload: ThreadForkedPayload) =>
    Effect.gen(function* () {
      if (queuedForks.has(payload.newThreadId)) return;
      queuedForks.add(payload.newThreadId);
      yield* worker.enqueue(payload);
    });

  const start: ScientForkReactorShape["start"] = Effect.fn("startScientForkReactor")(function* () {
    // Subscribe first, then load durable work. If a fork lands between those
    // operations it may be queued twice, but the database claim makes the
    // second delivery a no-op.
    yield* forkParked(
      Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) => {
        if (event.type === "thread.forked") return enqueue(event.payload);
        // A revert that removed the turn carrying a fork's context supersedes
        // that delivery; the next turn delivers it again.
        if (event.type === "thread.reverted") {
          return contextDelivery
            .onThreadReverted({
              threadId: event.payload.threadId,
              turnCount: event.payload.turnCount,
            })
            .pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("scient fork reactor could not reconcile reverted context", {
                  threadId: event.payload.threadId,
                  cause: Cause.pretty(cause),
                }),
              ),
            );
        }
        return Effect.void;
      }),
    );
    // A failed recovery query means the durable fork queue cannot be trusted.
    // Fail reactor startup instead of silently accepting forks that could be
    // stranded. The outer service lifecycle treats defects as fatal.
    const recoverable = yield* listRecoverableForks(sql).pipe(Effect.orDie);
    yield* Effect.forEach(recoverable, enqueue, { concurrency: 1, discard: true });
  });

  const readForkStatus = (threadId: ThreadForkedPayload["newThreadId"]) =>
    getForkStatus(sql, threadId).pipe(
      Effect.catchCause(
        (cause) =>
          new ScientForkCompletionError({
            threadId,
            detail: `Unable to read fork status: ${Cause.pretty(cause).slice(0, 4_000)}`,
          }),
      ),
    );

  const resolveFinishedStatus = Effect.fn("resolveFinishedScientForkStatus")(function* (
    threadId: ThreadForkedPayload["newThreadId"],
  ) {
    const status = yield* readForkStatus(threadId);
    if (status?.status === "ready") {
      return true;
    }
    if (status?.status === "abandoned") {
      return yield* new ScientForkCompletionError({
        threadId,
        detail: status.last_error ?? "Fork provisioning could not be completed.",
      });
    }
    return false;
  });

  const awaitCompletion: ScientForkReactorShape["awaitCompletion"] = Effect.fn(
    "awaitScientForkCompletion",
  )(
    function* (threadId) {
      if (yield* resolveFinishedStatus(threadId)) return;
      const completion = yield* completionFor(threadId);
      // Close the race where provisioning finishes between the first durable
      // status read and registration of this in-memory waiter.
      if (yield* resolveFinishedStatus(threadId)) {
        yield* releaseCompletion(threadId, completion);
        return;
      }
      // The durable row is authoritative. Self-enqueueing here closes the live
      // subscription handoff race for every user-facing fork request; duplicate
      // delivery is harmless because claimFork is idempotent.
      const recoverable = yield* getRecoverableFork(sql, threadId).pipe(
        Effect.mapError(
          (cause) =>
            new ScientForkCompletionError({
              threadId,
              detail: `Unable to recover fork provisioning: ${Cause.pretty(Cause.fail(cause)).slice(
                0,
                4_000,
              )}`,
            }),
        ),
      );
      if (recoverable !== null) {
        yield* enqueue(recoverable);
      } else {
        if (yield* resolveFinishedStatus(threadId)) {
          yield* releaseCompletion(threadId, completion);
          return;
        }
      }
      return yield* Deferred.await(completion);
    },
    (effect, threadId) =>
      effect.pipe(
        Effect.andThen(getReadyForkAttachmentIdMap(sql, threadId)),
        // View continuity must not turn a provisioned fork into a failed command.
        Effect.catchTags({
          SqlError: () => Effect.succeed({}),
          SchemaError: () => Effect.succeed({}),
        }),
      ),
  );

  const getDisposition: ScientForkReactorShape["getDisposition"] = (threadId) =>
    readForkStatus(threadId).pipe(Effect.map((status) => status?.status ?? "unknown"));

  const boundaryResolver = makeForkBoundaryResolver(sql);
  const getOptions: ScientForkReactorShape["getOptions"] = Effect.fn("getScientForkOptions")(
    function* (input) {
      const unavailable = (reason: string) => ({
        available: false,
        localAvailable: false,
        reason,
        sourceAssistantMessageId: null,
        sourceUserMessageId: null,
        sourceRunningTurnId: null,
        newWorktree: false,
      });
      const result = yield* Effect.gen(function* () {
        if (
          [
            input.sourceAssistantMessageId,
            input.sourceUserMessageId,
            input.sourceRunningTurnId,
          ].filter((source) => source !== undefined).length > 1
        ) {
          return unavailable("Choose one message to fork from.");
        }
        const originOption = yield* projectionSnapshotQuery.getThreadDetailById(
          input.originThreadId,
        );
        if (Option.isNone(originOption) || originOption.value.deletedAt !== null) {
          return unavailable("The original conversation is no longer available.");
        }
        const origin = originOption.value;
        if (origin.projectId === null)
          return unavailable(
            "This older conversation has no project workspace and cannot be forked.",
          );
        const resolved = yield* boundaryResolver.resolve({
          originThreadId: input.originThreadId,
          threadCreatedAt: origin.createdAt,
          ...(input.sourceAssistantMessageId === undefined
            ? {}
            : { sourceAssistantMessageId: input.sourceAssistantMessageId }),
          ...(input.sourceUserMessageId === undefined
            ? {}
            : { sourceUserMessageId: input.sourceUserMessageId }),
          ...(input.sourceRunningTurnId === undefined
            ? {}
            : { sourceRunningTurnId: input.sourceRunningTurnId }),
        });
        const forkPoint = resolved.forkPoint;
        if (forkPoint.kind === "running-turn") {
          const running =
            origin.session?.activeTurnId === forkPoint.turnId ||
            (origin.latestTurn?.turnId === forkPoint.turnId &&
              origin.latestTurn.state === "running");
          if (!running) return unavailable("This turn has finished. Fork its response instead.");
        }
        const source =
          forkPoint.kind === "running-turn"
            ? undefined
            : origin.messages.find((message) => message.id === forkPoint.messageId);
        if (forkPoint.kind !== "running-turn" && (!source || source.streaming))
          return unavailable(
            "This message is still being written. Choose a completed response or a sent message.",
          );
        if (
          forkPoint.kind === "user-message" &&
          source?.attachments?.some((attachment) => attachment.type !== "image")
        ) {
          return unavailable(
            "Fork from the completed response to retain this message and its files. Editing a fork from a message with file attachments is not supported yet.",
          );
        }
        const retained = resolved.boundaries.slice(
          0,
          resolved.boundaries.indexOf(resolved.selectedBoundary) + 1,
        );
        const prefix = retainPrefixMessages(
          origin.messages,
          retained,
          new Set(
            retained.flatMap((boundary) => (boundary.turnId === null ? [] : [boundary.turnId])),
          ),
        );
        const retainedAnswers = retainQuestionAnswers(
          origin.activities,
          new Set(
            retained.flatMap((boundary) => (boundary.turnId === null ? [] : [boundary.turnId])),
          ),
        );
        if (retainedAnswers.error) return unavailable(retainedAnswers.error);
        const liveTail =
          forkPoint.kind === "running-turn"
            ? collectForkLiveTail({
                origin,
                retainedMessageIds: new Set(prefix.messages.map((message) => message.id)),
                retainedTurnIds: new Set(
                  retained.flatMap((boundary) =>
                    boundary.turnId === null ? [] : [boundary.turnId],
                  ),
                ),
                runningTurnId: forkPoint.turnId,
                turnRequests: resolved.turnRequests ?? [],
              })
            : null;
        yield* attachmentCopier.checkSources({
          threadId: origin.id,
          attachments: [
            ...prefix.messages.flatMap((message) => message.attachments ?? []),
            ...(liveTail?.messages.flatMap((message) => message.attachments ?? []) ?? []),
            ...questionAnswerAttachments(retainedAnswers.answers),
          ],
        });
        const context = yield* projectionSnapshotQuery.getThreadCheckpointContext(origin.id);
        if (Option.isNone(context))
          return unavailable(
            "The original conversation's workspace is unavailable. Restore its project before forking.",
          );
        const cwd = context.value.worktreePath ?? context.value.workspaceRoot;
        const localAvailable = yield* checkpointBaseline.workspaceExists(cwd);
        const checkpointCwd = localAvailable ? cwd : context.value.workspaceRoot;
        const checkpoint = origin.checkpoints.find(
          (checkpoint) =>
            checkpoint.turnId === resolved.selectedBoundary.turnId && checkpoint.status === "ready",
        );
        // A running-turn fork snapshots the current workspace, so it needs a
        // Git repository rather than a saved checkpoint.
        const newWorktree =
          liveTail !== null
            ? localAvailable &&
              (yield* checkpointBaseline
                .isGitRepository(cwd)
                .pipe(Effect.catch(() => Effect.succeed(false))))
            : checkpoint !== undefined &&
              (yield* checkpointBaseline
                .hasCheckpoint(
                  checkpointCwd,
                  checkpointRefForThreadTurn(origin.id, checkpoint.checkpointTurnCount),
                )
                .pipe(Effect.catch(() => Effect.succeed(false))));
        return {
          available: localAvailable || newWorktree,
          localAvailable,
          reason: localAvailable
            ? null
            : newWorktree
              ? "The original worktree no longer exists. Choose New worktree to restore the saved checkpoint in an independent workspace."
              : "The original workspace is unavailable. Restore its folder before forking.",
          sourceAssistantMessageId:
            forkPoint.kind === "assistant-response" ? forkPoint.messageId : null,
          sourceUserMessageId: forkPoint.kind === "user-message" ? forkPoint.messageId : null,
          sourceRunningTurnId: forkPoint.kind === "running-turn" ? forkPoint.turnId : null,
          newWorktree,
        };
      }).pipe(
        Effect.catch((error) =>
          Effect.succeed(
            unavailable(
              error._tag === "ForkBoundaryResolutionError"
                ? "This response did not finish successfully or its completion record is unavailable. Choose an earlier completed response or fork from a sent message."
                : error instanceof Error
                  ? error.message
                  : "Unable to check this fork. Reconnect and try again.",
            ),
          ),
        ),
      );
      return result;
    },
  );

  const liveTurnFlush = yield* Effect.serviceOption(ScientLiveTurnFlush);
  const prepareFork: NonNullable<ScientForkReactorShape["prepareFork"]> = Effect.fn(
    "prepareScientFork",
  )(
    function* (command) {
      if (command.sourceRunningTurnId !== undefined) {
        if (Option.isNone(liveTurnFlush))
          return yield* new ScientForkCompletionError({
            threadId: command.newThreadId,
            detail: "Running-turn capture is unavailable. Retry after reconnecting.",
          });
        yield* liveTurnFlush.value.flush(command.originThreadId);
      }
      if (command.workspaceMode !== "new-worktree") return;
      // An existing destination belongs to the decider's idempotency/conflict
      // path. Never prepare or clean up refs owned by a pre-existing thread.
      if (
        Option.isSome(
          yield* projectionSnapshotQuery.getThreadDetailById(command.newThreadId, {
            activityKinds: [],
          }),
        )
      )
        return;
      const previous =
        yield* sql`SELECT thread_id FROM scient_fork_snapshot_captures WHERE thread_id = ${command.newThreadId}`;
      if (previous.length > 0) return;
      const origin = Option.getOrUndefined(
        yield* projectionSnapshotQuery.getThreadDetailById(command.originThreadId, {
          activityKinds: [],
        }),
      );
      const workspace = Option.getOrUndefined(
        yield* projectionSnapshotQuery.getThreadCheckpointContext(command.originThreadId),
      );
      if (!origin || !workspace)
        return yield* new ScientForkCompletionError({
          threadId: command.newThreadId,
          detail: "The origin workspace is unavailable.",
        });
      const resolved = yield* boundaryResolver.resolve({
        originThreadId: command.originThreadId,
        threadCreatedAt: origin.createdAt,
        ...(command.sourceAssistantMessageId === undefined
          ? {}
          : { sourceAssistantMessageId: command.sourceAssistantMessageId }),
        ...(command.sourceUserMessageId === undefined
          ? {}
          : { sourceUserMessageId: command.sourceUserMessageId }),
        ...(command.sourceRunningTurnId === undefined
          ? {}
          : { sourceRunningTurnId: command.sourceRunningTurnId }),
      });
      const originCwd = workspace.worktreePath ?? workspace.workspaceRoot;
      const originAvailable = yield* checkpointBaseline.workspaceExists(originCwd);
      if (command.sourceRunningTurnId !== undefined && !originAvailable)
        return yield* new ScientForkCompletionError({
          threadId: command.newThreadId,
          detail: "The running conversation workspace is no longer available.",
        });
      const cwd = originAvailable ? originCwd : workspace.workspaceRoot;
      const toRef = checkpointRefForThreadTurn(command.newThreadId, 0);
      const count =
        origin.checkpoints.find(
          (checkpoint) =>
            checkpoint.turnId === resolved.selectedBoundary.turnId && checkpoint.status === "ready",
        )?.checkpointTurnCount ?? null;
      const copied =
        command.sourceRunningTurnId !== undefined
          ? (yield* checkpointBaseline.hasCheckpoint(cwd, toRef)) ||
            (yield* checkpointBaseline.capture({ cwd, toCheckpointRef: toRef }))
          : count !== null &&
            (yield* checkpointBaseline.copy({
              cwd,
              fromCheckpointRef: checkpointRefForThreadTurn(command.originThreadId, count),
              toCheckpointRef: toRef,
            }));
      const oid = copied ? yield* checkpointBaseline.resolveCheckpoint(cwd, toRef) : null;
      if (oid === null)
        return yield* new ScientForkCompletionError({
          threadId: command.newThreadId,
          detail: "The selected workspace checkpoint could not be frozen. Nothing was forked.",
        });
      yield* sql`INSERT INTO scient_fork_snapshot_captures
        (thread_id, origin_thread_id, source_turn_id, source_running_turn_id, checkpoint_oid, captured_at, cwd)
        VALUES (${command.newThreadId}, ${command.originThreadId}, ${resolved.selectedBoundary.turnId},
          ${command.sourceRunningTurnId ?? null}, ${oid}, ${yield* nowIso}, ${cwd})`;
    },
    (effect, command) =>
      effect.pipe(
        Effect.mapError(
          (error) =>
            new ScientForkCompletionError({
              threadId: command.newThreadId,
              detail: isScientForkCompletionError(error)
                ? error.detail
                : `Fork capture failed: ${error.message}`,
            }),
        ),
      ),
  );

  const discardPreparation: NonNullable<ScientForkReactorShape["discardPreparation"]> = (
    threadId,
  ) =>
    Effect.gen(function* () {
      if ((yield* getForkStatus(sql, threadId)) !== null) return;
      const capture = (yield* sql<{
        readonly cwd: string;
      }>`SELECT cwd FROM scient_fork_snapshot_captures WHERE thread_id = ${threadId}`)[0];
      if (!capture) return;
      yield* checkpointBaseline.discard({
        cwd: capture.cwd,
        checkpointRef: checkpointRefForThreadTurn(threadId, 0),
        worktreePath: null,
        branch: null,
      });
      yield* sql`DELETE FROM scient_fork_snapshot_captures WHERE thread_id = ${threadId}`;
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Could not discard rejected fork snapshot", { threadId, cause }),
      ),
    );

  return {
    start,
    drain: worker.drain,
    awaitCompletion,
    prepareFork,
    discardPreparation,
    getDisposition,
    getOptions,
  } satisfies ScientForkReactorShape;
});

export const ScientForkReactorLive = Layer.effect(ScientForkReactor, make);
