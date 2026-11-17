/**
 * A conversation fork on T3's `thread.fork`: Scient freezes the boundary, T3's builder makes the
 * thread and transfer, and Scient's frozen facts replace the live source link. Side chats keep
 * T3's own path.
 */
import {
  OrchestrationDispatchCommandError,
  type ContextTransferId,
  type OrchestrationV2AppThread,
  type OrchestrationV2ContextSourcePoint,
  type OrchestrationV2ContextTransfer,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2Run,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ThreadProjection,
  type ScientConversationFork,
  type ThreadId,
} from "@t3tools/contracts";
import {
  ProviderTextSnapshotError,
  type CapturedProviderText,
} from "@t3tools/provider-core/server/ProviderAdapter";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";

import type { PendingOrchestrationEffectV2 } from "../EffectOutbox.ts";
import type {
  OrchestratorCommandRejectedError,
  OrchestratorDispatchError,
  OrchestratorV2Error,
} from "../Orchestrator.ts";
import type { ProjectionStoreV2Shape } from "../ProjectionStore.ts";
import { isForkableSourceRunStatus, type ThreadForkServiceV2Shape } from "../ThreadForkService.ts";
import { conversationForkBoundaryItem } from "./ConversationForkBoundaryItem.ts";
import {
  conversationForkHistoryEvents,
  conversationForkProvisionEffect,
} from "./ConversationForkPlan.ts";
import type {
  ConversationForkAdmission,
  ConversationForkBoundary,
  ConversationForkCommitInput,
  ConversationForkService,
  ThreadForkV2Command,
} from "./ConversationForkService.ts";
import type { ForkHistoryEntry } from "./ForkHistory.ts";

/** A running turn's unsaved text, captured before the fork took its thread locks. */
export const RunningForkCapture = Context.Reference<CapturedProviderText | null>(
  "scient/orchestration-v2/RunningForkCapture",
  { defaultValue: () => null },
);

/** The fork attempt's scope: its checkpoint reservation lasts until the fork commits or fails. */
export const ForkAttemptScope = Context.Reference<Scope.Scope | undefined>(
  "scient/orchestration-v2/ForkAttemptScope",
  { defaultValue: () => undefined },
);

/** How the dispatched fork commits: its history and the fence around the commit. */
export interface ConversationForkCommitPlan {
  readonly forkHistory: ReadonlyArray<ForkHistoryEntry>;
  readonly commit: <A, E, R>(
    commit: (input: ConversationForkCommitInput) => Effect.Effect<A, E, R>,
    events: ReadonlyArray<OrchestrationV2DomainEvent>,
  ) => Effect.Effect<A, E | OrchestratorCommandRejectedError, R>;
}

const isForkRefusal = Schema.is(
  Schema.Union([OrchestrationDispatchCommandError, ProviderTextSnapshotError]),
);

type Emit = (
  events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
  command: OrchestrationV2ServerCommand,
) => <Event extends OrchestrationV2DomainEvent>(
  event: Omit<Event, "id">,
) => Effect.Effect<Event, OrchestratorDispatchError>;

type MapDispatchError = (
  command: OrchestrationV2ServerCommand,
) => <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, OrchestratorDispatchError, R>;

/** The fork's T3 thread with Scient's frozen facts in place of the live source link. */
function withFrozenFacts(input: {
  readonly command: ThreadForkV2Command;
  readonly admission: ConversationForkAdmission;
  readonly targetThread: Effect.Success<
    ReturnType<ThreadForkServiceV2Shape["plan"]>
  >["targetThread"];
  readonly transfer: OrchestrationV2ContextTransfer;
  readonly sourceTokenUsage: OrchestrationV2ProviderTurn["tokenUsage"] | undefined;
}) {
  const { command, admission } = input;
  const source = admission.projection.thread;
  const native = admission.nativeSource;
  const targetThread = {
    ...input.targetThread,
    ...(admission.inProjectFolder ? { worktreePath: null, branch: null } : {}),
    // Frozen history replaces T3's live read of the source.
    forkedFrom: null,
    historyOrigin: "scient_fork" as const,
    conversationImport: null,
    forkLineage: {
      originThreadId: source.id,
      baselineAssistantMessageId: admission.plan.baselineAssistantMessageId,
      ...(source.conversationImport != null
        ? { sourceImport: source.conversationImport }
        : source.forkLineage?.sourceImport === undefined
          ? {}
          : { sourceImport: source.forkLineage.sourceImport }),
    },
  };
  const conversationFork: ScientConversationFork = {
    commandId: command.commandId,
    sourceThreadId: source.id,
    workspaceMode: admission.workspaceMode,
    // History is shared, so only a new worktree still needs setting up.
    status: admission.workspaceMode === "new-worktree" ? ("pending" as const) : ("ready" as const),
    cwd: admission.cwd,
    checkpointRef: admission.checkpointRef,
    checkpointOid: admission.checkpointOid,
    // Shared files, recorded so the client keeps their open previews.
    attachmentCopies: admission.plan.attachmentCopies,
    error: null,
  };
  const transfer: OrchestrationV2ContextTransfer = {
    ...input.transfer,
    sourcePoint: {
      threadId: source.id,
      ...(admission.plan.boundaryRunId === null ? {} : { runId: admission.plan.boundaryRunId }),
    },
    sourceProviderInstanceId:
      native.strategy === "native_fork"
        ? native.frozenSource.sourceRun.providerInstanceId
        : source.providerInstanceId,
    // Only an exact native fork keeps the source's context window.
    sourceTokenUsage: native.strategy === "native_fork" ? input.sourceTokenUsage : undefined,
    ...(native.strategy === "native_fork"
      ? { frozenSource: native.frozenSource }
      : { portableReason: native.reason }),
  };
  return { targetThread, transfer, conversationFork };
}

export const dispatchConversationFork = Effect.fn("ConversationForkDispatch.dispatch")(function* (
  deps: {
    readonly conversationForks: ConversationForkService["Service"];
    readonly threadForkService: ThreadForkServiceV2Shape;
    readonly projectionStore: Pick<ProjectionStoreV2Shape, "getThread" | "getThreadProjection">;
    readonly allocateTransferId: Effect.Effect<ContextTransferId, OrchestratorDispatchError>;
    readonly mapDispatchError: MapDispatchError;
    readonly emit: Emit;
    readonly refuseAboveDispatchModeLimit: (
      command: ThreadForkV2Command,
      threadId: ThreadId,
      thread: OrchestrationV2AppThread,
    ) => Effect.Effect<void, OrchestratorV2Error>;
    readonly reject: (cause: unknown) => OrchestratorCommandRejectedError;
    /** Upstream's failure for a T3 source point, so callers see what a T3 fork returns. */
    readonly fail: (cause: string) => OrchestratorDispatchError;
    /** The folder T3 gives a fork of this run; a mobile or MCP fork falls back to it. */
    readonly runtimeCwd: (
      projection: OrchestrationV2ThreadProjection,
      run: OrchestrationV2Run,
    ) => Effect.Effect<string, OrchestratorDispatchError>;
    readonly runForSourcePoint: (
      projection: OrchestrationV2ThreadProjection,
    ) => OrchestrationV2Run | null;
    readonly providerThreadForRun: (
      projection: OrchestrationV2ThreadProjection,
      run: OrchestrationV2Run,
    ) => OrchestrationV2ProviderThread | undefined;
    readonly providerTurnForRun: (
      projection: OrchestrationV2ThreadProjection,
      run: OrchestrationV2Run,
    ) => OrchestrationV2ProviderTurn | undefined;
    readonly contextSourcePointForRun: (
      projection: OrchestrationV2ThreadProjection,
      run: OrchestrationV2Run,
    ) => OrchestrationV2ContextSourcePoint;
  },
  command: ThreadForkV2Command,
  events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
  effects: Ref.Ref<Array<PendingOrchestrationEffectV2>>,
) {
  const { conversationForks, mapDispatchError, projectionStore } = deps;
  // Accepted retries replay their receipt before dispatch; a fresh fork never
  // resurrects a tombstone or replaces another conversation.
  const destinationExists = yield* projectionStore
    .getThread(command.targetThreadId)
    .pipe(
      Effect.as(true),
      Effect.catchTags({ ProjectionStoreThreadNotFoundError: () => Effect.succeed(false) }),
      mapDispatchError(command),
    );
  if (destinationExists)
    return yield* deps.reject("The destination already exists. Choose a new fork identity.");
  const capture = yield* RunningForkCapture;
  // A running fork plans from its source as the capture read it, at the captured frame.
  const projection =
    capture?.projection ??
    (yield* projectionStore
      .getThreadProjection(command.sourceThreadId)
      .pipe(mapDispatchError(command)));
  // Read under the source's lock; validate the modes copied here, not an earlier read.
  yield* deps.refuseAboveDispatchModeLimit(command, command.sourceThreadId, projection.thread);
  if (projection.thread.deletedAt !== null)
    return yield* deps.reject("The original conversation was deleted.");
  let boundary: ConversationForkBoundary;
  let fallbackCwd: string | undefined;
  if (command.scient !== undefined) boundary = command.scient.boundary;
  else {
    // Mobile and MCP name T3's source point: the fork stops after that settled run.
    const run = deps.runForSourcePoint(projection);
    if (run === null)
      return yield* deps.fail(
        `No stable source run was found for fork source ${command.sourcePoint.type}.`,
      );
    boundary = { kind: "settled-run", runId: run.id };
    fallbackCwd = yield* deps.runtimeCwd(projection, run);
  }
  const attemptScope = yield* ForkAttemptScope;
  if (attemptScope === undefined)
    return yield* Effect.die(
      new Error("A conversation fork dispatched outside its attempt scope."),
    );
  const admission = yield* conversationForks
    .admit({
      command,
      boundary,
      sourceProjection: projection,
      ...(fallbackCwd === undefined ? {} : { fallbackCwd }),
    })
    .pipe(Scope.provide(attemptScope), Effect.mapError(deps.reject));
  const boundaryRun =
    admission.projection.runs.find((run) => run.id === admission.plan.boundaryRunId) ?? null;
  // T3's builder takes only a settled run; Scient's frozen facts own every other boundary.
  const sourceRun =
    boundaryRun !== null && isForkableSourceRunStatus(boundaryRun.status) ? boundaryRun : null;
  const now = command.createdAt ?? (yield* DateTime.now);
  const transferId = yield* deps.allocateTransferId;
  const planned = yield* deps.threadForkService
    .plan({
      sourceProjection: admission.projection,
      sourceRun,
      sourceProviderThread:
        sourceRun === null ? undefined : deps.providerThreadForRun(admission.projection, sourceRun),
      sourceTokenUsage: undefined,
      canonicalSourcePoint:
        sourceRun === null
          ? { threadId: admission.projection.thread.id }
          : deps.contextSourcePointForRun(admission.projection, sourceRun),
      transferId,
      targetThreadId: command.targetThreadId,
      ...(command.title === undefined ? {} : { title: command.title }),
      createdBy: command.createdBy,
      creationSource: command.creationSource,
      createdAt: now,
    })
    .pipe(mapDispatchError(command));
  const { targetThread, transfer, conversationFork } = withFrozenFacts({
    command,
    admission,
    targetThread: planned.targetThread,
    transfer: planned.transfer,
    sourceTokenUsage:
      boundaryRun === null
        ? undefined
        : deps.providerTurnForRun(admission.projection, boundaryRun)?.tokenUsage,
  });
  const emitEvent = deps.emit(events, command);
  yield* emitEvent({
    type: "thread.created",
    threadId: command.targetThreadId,
    providerInstanceId: targetThread.providerInstanceId,
    occurredAt: now,
    payload: targetThread,
  });
  // An empty prefix (a fork from the first message) has no context to carry.
  if (admission.plan.history.length > 0)
    yield* emitEvent({
      type: "context-transfer.created",
      threadId: command.targetThreadId,
      providerInstanceId: transfer.sourceProviderInstanceId ?? targetThread.providerInstanceId,
      occurredAt: now,
      payload: transfer,
    });
  for (const event of conversationForkHistoryEvents({
    targetThreadId: targetThread.id,
    history: admission.plan,
    boundaryItem: conversationForkBoundaryItem({
      targetThreadId: targetThread.id,
      source: admission.markerSource,
      ordinal: admission.plan.history.length,
      createdAt: now,
    }),
    occurredAt: now,
  }))
    yield* emitEvent(event);
  const provision = conversationForkProvisionEffect(
    command.commandId,
    targetThread.id,
    conversationFork,
  );
  if (provision !== undefined) yield* Ref.update(effects, (existing) => [...existing, provision]);
  return {
    forkHistory: admission.plan.history,
    commit: (commit, plannedEvents) =>
      conversationForks
        .commit({ command, admission, capture, events: plannedEvents, conversationFork, commit })
        .pipe(Effect.catchIf(isForkRefusal, (cause) => Effect.fail(deps.reject(cause)))),
  } satisfies ConversationForkCommitPlan;
});
