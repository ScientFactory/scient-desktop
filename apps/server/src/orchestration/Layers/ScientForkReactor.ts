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
const PROVISIONING_ATTEMPT_TIMEOUT = Duration.minutes(3);
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

    const origin = context.value;
    // The baseline is copied by checkpoint count. A revert and rerun of the
    // origin can reuse that count for different work: refuse rather than copy it.
    if (
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
      if (currentTurnId !== null && currentTurnId !== payload.forkAtTurnId) {
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
    yield* attachmentCopier.copyAll({
      threadId: payload.newThreadId,
      copies: payload.attachmentCopies,
    });
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
    // A fork of a running turn snapshots the origin's workspace as it stands
    // at the cut; other forks copy the forked turn's saved checkpoint.
    const snapshotsLiveWorkspace = copiesBaseline && payload.midTurnCut !== undefined;
    const isGitRepository =
      !copiesBaseline || (fromRef === null && !snapshotsLiveWorkspace)
        ? false
        : yield* checkpointBaseline.isGitRepository(originCwd);
    const baselined = !isGitRepository
      ? false
      : snapshotsLiveWorkspace
        ? localAvailable &&
          // A retry keeps the snapshot taken at the cut (its worktree may
          // already exist); only the first attempt captures the workspace.
          ((yield* checkpointBaseline
            .hasCheckpoint(originCwd, toRef)
            .pipe(Effect.orElseSucceed(() => false))) ||
            (yield* checkpointBaseline.capture({ cwd: originWorkspace, toCheckpointRef: toRef })))
        : fromRef !== null
          ? yield* checkpointBaseline.copy({
              cwd: originCwd,
              fromCheckpointRef: fromRef,
              toCheckpointRef: toRef,
            })
          : false;
    const checkpointStatus: ScientForkCheckpointStatus = baselined ? "ready" : "unavailable";

    if (yield* isForkThreadDeleted(sql, payload.newThreadId)) {
      return yield* new ScientForkTerminalProvisioningError({
        detail: "This fork was deleted while it was being set up.",
      });
    }
    let workspaceStatus: ScientForkWorkspaceStatus;
    if (payload.workspaceMode === "new-worktree") {
      const worktreeBase = snapshotsLiveWorkspace ? toRef : fromRef;
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
  )(function* (threadId) {
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
  });

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
  const prepareFork: NonNullable<ScientForkReactorShape["prepareFork"]> = (command) =>
    command.sourceRunningTurnId === undefined || Option.isNone(liveTurnFlush)
      ? Effect.void
      : liveTurnFlush.value.flush(command.originThreadId);

  return {
    start,
    drain: worker.drain,
    awaitCompletion,
    prepareFork,
    getDisposition,
    getOptions,
  } satisfies ScientForkReactorShape;
});

export const ScientForkReactorLive = Layer.effect(ScientForkReactor, make);
