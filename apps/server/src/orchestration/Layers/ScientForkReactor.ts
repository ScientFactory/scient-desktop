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
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { checkpointRefForThreadTurn } from "../../checkpointing/Utils.ts";
import { GitWorkflowService } from "../../git/GitWorkflowService.ts";
import { forkParked } from "../../serverActivation.ts";
import {
  claimFork,
  getRecoverableFork,
  getForkStatus,
  listRecoverableForks,
  markForkAbandoned,
  markForkFailed,
  type ScientForkCheckpointStatus,
  type ScientForkWorkspaceStatus,
} from "../scient-fork/forkRepository.ts";
import { ScientForkCheckpointBaseline } from "../scient-fork/ForkCheckpointBaseline.ts";
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

class ScientForkTerminalProvisioningError extends Schema.TaggedErrorClass<ScientForkTerminalProvisioningError>()(
  "ScientForkTerminalProvisioningError",
  { detail: Schema.String },
) {}

const isScientForkTerminalProvisioningError = Schema.is(ScientForkTerminalProvisioningError);

function forkFailure(cause: Cause.Cause<unknown>): unknown {
  return cause.reasons.find(Cause.isFailReason)?.error;
}

function forkFailureDetail(cause: Cause.Cause<unknown>): string {
  const failure = forkFailure(cause);
  return (
    isScientForkCompletionError(failure) ||
    isScientForkTerminalProvisioningError(failure) ||
    isScientForkAttachmentCopyError(failure)
      ? failure.detail
      : Cause.pretty(cause)
  ).slice(0, 4_000);
}

function isTerminalForkFailure(cause: Cause.Cause<unknown>): boolean {
  const failure = forkFailure(cause);
  return (
    isScientForkTerminalProvisioningError(failure) ||
    (isScientForkAttachmentCopyError(failure) &&
      (failure.reason === "source-unavailable" || failure.reason === "unsafe-mapping"))
  );
}

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
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const checkpointBaseline = yield* ScientForkCheckpointBaseline;
  const attachmentCopier = yield* ScientForkAttachmentCopier;
  const gitWorkflow = yield* GitWorkflowService;
  const completions = new Map<string, Deferred.Deferred<void, ScientForkCompletionError>>();

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
    if (!(yield* claimFork(sql, payload.newThreadId, claimedAt))) {
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
    yield* attachmentCopier.copyAll({
      threadId: payload.newThreadId,
      copies: payload.attachmentCopies,
    });
    const originCwd = origin.worktreePath ?? origin.workspaceRoot;
    const toRef = checkpointRefForThreadTurn(payload.newThreadId, 0);
    const sourceCheckpointTurnCount = payload.sourceCheckpointTurnCount;
    const fromRef =
      sourceCheckpointTurnCount === null
        ? null
        : checkpointRefForThreadTurn(payload.originThreadId, sourceCheckpointTurnCount);
    const isGitRepository =
      fromRef === null ? false : yield* checkpointBaseline.isGitRepository(originCwd);
    const baselined =
      isGitRepository && fromRef !== null
        ? yield* checkpointBaseline.copy({
            cwd: originCwd,
            fromCheckpointRef: fromRef,
            toCheckpointRef: toRef,
          })
        : false;
    const checkpointStatus: ScientForkCheckpointStatus = baselined ? "ready" : "unavailable";

    let workspaceStatus: ScientForkWorkspaceStatus;
    if (payload.workspaceMode === "new-worktree") {
      if (!baselined || fromRef === null) {
        return yield* new ScientForkTerminalProvisioningError({
          detail:
            "A new worktree cannot be created because the selected conversation boundary has no ready Git checkpoint.",
        });
      }
      const worktree = yield* ensureWorktree({
        cwd: originCwd,
        fromRef,
        threadId: payload.newThreadId,
      });
      yield* orchestrationEngine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make(`server:scient-fork:workspace:${payload.newThreadId}`),
        threadId: payload.newThreadId,
        branch: worktree.refName,
        worktreePath: worktree.path,
      });
      workspaceStatus = "worktree";
    } else if (origin.worktreePath !== null) {
      yield* orchestrationEngine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make(`server:scient-fork:workspace:${payload.newThreadId}`),
        threadId: payload.newThreadId,
        worktreePath: origin.worktreePath,
      });
      workspaceStatus = "shared";
    } else {
      workspaceStatus = "project-root";
    }

    yield* orchestrationEngine.dispatch({
      type: "thread.fork.complete",
      commandId: CommandId.make(`server:scient-fork:complete:${payload.newThreadId}`),
      threadId: payload.newThreadId,
      checkpointStatus,
      workspaceStatus,
      createdAt: yield* nowIso,
    });
    const completion = yield* completionFor(payload.newThreadId);
    yield* Deferred.succeed(completion, undefined);
    yield* releaseCompletion(payload.newThreadId, completion);
  });

  const processForkSafely = (payload: ThreadForkedPayload) =>
    processFork(payload).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause);
        }
        const error = forkFailureDetail(cause);
        const terminal = isTerminalForkFailure(cause);
        const persistFailure = terminal
          ? orchestrationEngine
              .dispatch({
                type: "thread.delete",
                commandId: CommandId.make(`server:scient-fork:abandon:${payload.newThreadId}`),
                threadId: payload.newThreadId,
              })
              .pipe(
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
        return persistFailure.pipe(
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
                : "Scient fork provisioning failed and will retry after restart",
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

  const worker = yield* makeDrainableWorker(processForkSafely);

  const start: ScientForkReactorShape["start"] = Effect.fn("startScientForkReactor")(function* () {
    // Subscribe first, then load durable work. If a fork lands between those
    // operations it may be queued twice, but the database claim makes the
    // second delivery a no-op.
    yield* forkParked(
      Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) =>
        event.type === "thread.forked" ? worker.enqueue(event.payload) : Effect.void,
      ),
    );
    // A failed recovery query means the durable fork queue cannot be trusted.
    // Fail reactor startup instead of silently accepting forks that could be
    // stranded. The outer service lifecycle treats defects as fatal.
    const recoverable = yield* listRecoverableForks(sql).pipe(Effect.orDie);
    yield* Effect.forEach(recoverable, worker.enqueue, { concurrency: 1, discard: true });
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
    if (status?.status === "failed") {
      return yield* new ScientForkCompletionError({
        threadId,
        detail: status.last_error ?? "Fork provisioning failed.",
      });
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
      yield* worker.enqueue(recoverable);
    }
    return yield* Deferred.await(completion);
  });

  return {
    start,
    drain: worker.drain,
    awaitCompletion,
  } satisfies ScientForkReactorShape;
});

export const ScientForkReactorLive = Layer.effect(ScientForkReactor, make);
