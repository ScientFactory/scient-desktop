import {
  FORK_CHECKPOINT_OWNERSHIP_OPERATION,
  makeForkCheckpointOwnership,
} from "./ForkCheckpointOwnership.ts";
import { CheckpointPublicationWitness } from "../../vcs/ScientCheckpointCapture.ts";
import { AttachmentFileArbitration } from "../AttachmentFileUse.ts";
import { ProviderSessionManagerV2 } from "../ProviderSessionManager.ts";
import {
  ProviderTextSnapshotError,
  type CapturedProviderText,
  type ProviderTextSnapshotOwner,
} from "../ProviderAdapter.ts";
import {
  EventId,
  ContextTransferId,
  type OrchestrationV2ContextTransfer,
  OrchestrationDispatchCommandError,
  type ForkOptions,
  type GetForkOptionsInput,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ThreadProjection,
  type ThreadForkCommand,
  ThreadId,
  VcsCheckpointUnavailableError,
  VcsError,
  VcsProcessTimeoutError,
} from "@t3tools/contracts";
import { deriveForkTitle } from "@t3tools/shared/scientForkTitle";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import { checkpointRefForThreadTurn } from "../../checkpointing/Utils.ts";
import { GitWorkflowService } from "../../git/GitWorkflowService.ts";
import { CommandReceiptStoreV2 } from "../CommandReceiptStore.ts";
import { EventSinkV2 } from "../EventSink.ts";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import { ProjectionStoreV2 } from "../ProjectionStore.ts";
import { ProjectStoreV2 } from "../ProjectStore.ts";
import { ThreadCommandExecutor } from "../ThreadCommandExecutor.ts";
import { randomUuidV4 } from "../RandomUuid.ts";
import { LegacyV1ThreadImporter } from "../legacy/LegacyV1ThreadImporter.ts";
import { ScientForkCheckpointBaseline } from "./ForkCheckpointBaseline.ts";
import {
  planConversationFork,
  ConversationForkPlanError,
  type ConversationForkSource,
} from "./ConversationForkPlan.ts";
import { freezeConversationForkNativeSource } from "./ConversationForkNativeSource.ts";
import { conversationForkBoundaryItem } from "./ConversationForkBoundaryItem.ts";

export class ConversationForkService extends Context.Service<
  ConversationForkService,
  {
    readonly dispatch: (
      command: ThreadForkCommand,
    ) => Effect.Effect<
      { readonly sequence: number; readonly forkAttachmentIdMap: Readonly<Record<string, string>> },
      OrchestrationDispatchCommandError
    >;
    readonly getOptions: (
      input: GetForkOptionsInput,
    ) => Effect.Effect<ForkOptions, OrchestrationDispatchCommandError>;
    readonly provision: (
      threadId: ThreadId,
      willRetry: boolean,
    ) => Effect.Effect<void, OrchestrationDispatchCommandError>;
  }
>()("t3/orchestration-v2/scient-fork/ConversationForkService") {}

const isCheckpointUnavailable = Schema.is(VcsCheckpointUnavailableError);
const isSnapshotTimeout = Schema.is(VcsProcessTimeoutError);
const isVcsError = Schema.is(VcsError);
const snapshotFailure = (cause: unknown) => {
  let message = "Unable to freeze this workspace checkpoint. Retry the fork.";
  // Ownership-journal failures are not about the user's files.
  if (isCheckpointUnavailable(cause) && cause.operation !== FORK_CHECKPOINT_OWNERSHIP_OPERATION) {
    if (cause.reason === "size-limit" || cause.reason === "path-limit")
      message =
        "This workspace exceeds the snapshot limits. Fork without a new worktree, or reduce the files included.";
    else if (cause.reason === "unsupported-file")
      message =
        "A special file prevents this workspace snapshot. Fork without a new worktree, or remove it from the snapshot.";
    else message = "A workspace file could not be read. Retry the fork when files are available.";
  } else if (isSnapshotTimeout(cause))
    message =
      "The workspace snapshot timed out. Fork without a new worktree, or reduce the files included.";
  return new OrchestrationDispatchCommandError({ message, forkDisposition: "rejected" });
};

const isDispatchError = Schema.is(OrchestrationDispatchCommandError);
const isPlanError = Schema.is(ConversationForkPlanError);
const isAbandonedFailure = (cause: unknown) =>
  isDispatchError(cause) && cause.forkDisposition === "abandoned";

const failure = (
  message: string,
  forkDisposition: "rejected" | "failed" | "abandoned" = "rejected",
) => new OrchestrationDispatchCommandError({ message, forkDisposition });

// VCS errors carry workspace paths and Git output; those stay in server logs.
const withoutVcsDiagnostics = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.tapError((cause) =>
      isVcsError(cause) ? Effect.logWarning("Fork Git operation failed", { cause }) : Effect.void,
    ),
    Effect.mapError((cause) =>
      isVcsError(cause)
        ? failure("Unable to read this workspace's Git history. Retry the fork.")
        : cause,
    ),
  );

const make = Effect.gen(function* () {
  const snapshots = yield* Effect.serviceOption(ProviderSessionManagerV2);
  const attachmentArbitration = yield* AttachmentFileArbitration;
  const projections = yield* ProjectionStoreV2;
  const projects = yield* ProjectStoreV2;
  const receipts = yield* CommandReceiptStoreV2;
  const sink = yield* EventSinkV2;
  const executor = yield* ThreadCommandExecutor;
  const titles = yield* KeyedLock.make<string>();
  const baseline = yield* ScientForkCheckpointBaseline;
  const git = yield* GitWorkflowService;
  const legacyImporter = yield* LegacyV1ThreadImporter;
  const checkpointOwnership = yield* makeForkCheckpointOwnership;
  // Attempts own unique refs and recovery skips active ones, so it can run
  // beside new forks instead of delaying server startup.
  yield* checkpointOwnership.recover().pipe(Effect.forkScoped);

  const resolveSource = (projection: OrchestrationV2ThreadProjection, input: GetForkOptionsInput) =>
    Effect.gen(function* () {
      const selected = [
        input.sourceAssistantMessageId,
        input.sourceUserMessageId,
        input.sourceRunningRunId,
        input.sourceRunningTurnId,
      ].filter((value) => value !== undefined);
      if (selected.length > 1) return yield* failure("Choose exactly one conversation boundary.");
      if (input.sourceRunningRunId !== undefined)
        return {
          kind: "running-turn",
          runId: input.sourceRunningRunId,
        } satisfies ConversationForkSource;
      if (input.sourceRunningTurnId !== undefined) {
        // Older clients name a provider turn. Resolve its durable owning run;
        // a provider identity is never cast into an application run identity.
        const turn = projection.providerTurns.find(
          (turn) => turn.nativeTurnRef?.nativeId === input.sourceRunningTurnId,
        );
        const attempt = projection.attempts.find((attempt) => attempt.id === turn?.runAttemptId);
        const run = projection.runs.find(
          (run) => String(run.id) === input.sourceRunningTurnId || run.id === attempt?.runId,
        );
        if (run === undefined) return yield* failure("The selected running turn is unavailable.");
        return { kind: "running-turn", runId: run.id } satisfies ConversationForkSource;
      }
      if (input.sourceUserMessageId !== undefined)
        return {
          kind: "user-message",
          messageId: input.sourceUserMessageId,
        } satisfies ConversationForkSource;
      const messageId =
        input.sourceAssistantMessageId ??
        projection.visibleTurnItems.findLast(
          ({ item }) =>
            item.type === "assistant_message" && !item.streaming && item.status === "completed",
        )?.item;
      if (typeof messageId === "string")
        return { kind: "assistant-response", messageId } satisfies ConversationForkSource;
      if (messageId?.type === "assistant_message")
        return {
          kind: "assistant-response",
          messageId: messageId.messageId,
        } satisfies ConversationForkSource;
      return yield* failure("There is no completed response to fork yet.");
    });

  const inspect = Effect.fn("ConversationFork.inspect")(function* (
    input: GetForkOptionsInput,
    targetThreadId: ThreadId,
    capturedProjection?: OrchestrationV2ThreadProjection,
  ) {
    yield* legacyImporter.ensureTranscript(input.originThreadId);
    const projection =
      capturedProjection ?? (yield* projections.getThreadProjection(input.originThreadId));
    if (
      projection.thread.conversationFork != null &&
      projection.thread.conversationFork.status !== "ready"
    )
      return yield* failure("Finish the original fork's workspace setup first.");
    const source = yield* resolveSource(projection, input);
    const plan = yield* planConversationFork({ projection, targetThreadId, source });
    const project = yield* projects.get(projection.thread.projectId);
    if (Option.isNone(project)) return yield* failure("The conversation's project is unavailable.");
    const originCwd = projection.thread.worktreePath ?? project.value.workspaceRoot;
    const localAvailable = yield* baseline.workspaceExists(originCwd);
    const sourceRun = projection.runs.find((run) => run.id === plan.boundaryRunId);
    let fromCheckpointRef =
      projection.checkpoints.find(
        (checkpoint) => checkpoint.id === sourceRun?.checkpointId && checkpoint.status === "ready",
      )?.ref ?? null;
    // A frozen fork's own baseline covers all inherited rows, never an earlier
    // boundary inside that baseline. Do not substitute the current checkout.
    if (
      fromCheckpointRef === null &&
      plan.boundaryRunId === null &&
      projection.thread.conversationFork?.checkpointRef != null
    ) {
      const retainedIds = new Set(plan.retained.map((item) => item.id));
      if (
        projection.visibleTurnItems
          .filter(({ item }) => item.inheritedFrom !== undefined)
          .every(({ item }) => retainedIds.has(item.id))
      )
        fromCheckpointRef = projection.thread.conversationFork.checkpointRef;
    }
    const cwd = localAvailable ? originCwd : project.value.workspaceRoot;
    if (
      !localAvailable &&
      (source.kind === "running-turn" ||
        fromCheckpointRef === null ||
        !(yield* baseline.workspaceExists(cwd)))
    )
      return yield* failure("The original workspace is unavailable.");
    const gitRepository = yield* baseline.isGitRepository(cwd);
    const checkpointAvailable =
      gitRepository &&
      (source.kind === "running-turn" ||
        (fromCheckpointRef !== null && (yield* baseline.hasCheckpoint(cwd, fromCheckpointRef))));
    if (!localAvailable && !checkpointAvailable)
      return yield* failure("The original worktree and its saved checkpoint are unavailable.");
    return {
      projection,
      source,
      plan,
      cwd,
      fromCheckpointRef,
      checkpointAvailable,
      localAvailable,
    };
  });

  const metadataEvent = Effect.fnUntraced(function* (
    thread: OrchestrationV2AppThread,
    now: DateTime.Utc,
  ) {
    return {
      id: EventId.make(`scient-fork:${thread.id}:${yield* randomUuidV4}`),
      type: "thread.metadata-updated" as const,
      threadId: thread.id,
      occurredAt: now,
      payload: { ...thread, updatedAt: now },
    } satisfies OrchestrationV2DomainEvent;
  });

  const awaitReady = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const cursor = yield* sink.latestSequence({ threadId });
      const initial = yield* projections.getThread(threadId);
      const final =
        initial.deletedAt === null && initial.conversationFork?.status === "pending"
          ? yield* sink.stream({ threadId, afterSequence: cursor }).pipe(
              Stream.filterMap((stored) => {
                const event = stored.event;
                return (event.type === "thread.metadata-updated" &&
                  event.payload.conversationFork?.status !== "pending") ||
                  event.type === "thread.deleted"
                  ? Result.succeed(event.payload)
                  : Result.failVoid;
              }),
              Stream.take(1),
              Stream.runCollect,
              Effect.map((threads) => threads[0]!),
            )
          : initial;
      if (final.deletedAt !== null || final.conversationFork?.status === "abandoned")
        return yield* failure(
          final.conversationFork?.error ?? "The fork was abandoned.",
          "abandoned",
        );
      if (final.conversationFork?.status !== "ready")
        return yield* failure(
          final.conversationFork?.error ?? "Fork setup failed. Retry the same fork.",
          "failed",
        );
      return Object.fromEntries(
        final.conversationFork.attachmentCopies.map(({ source, target }) => [source.id, target.id]),
      );
    });

  const prepareTextCapture = Effect.fnUntraced(function* (command: ThreadForkCommand) {
    if (command.sourceRunningRunId === undefined && command.sourceRunningTurnId === undefined)
      return null;
    if (Option.isSome(yield* receipts.getByCommandId(command.commandId))) return null;
    yield* legacyImporter.ensureTranscript(command.originThreadId);
    const projection = yield* projections.getThreadProjection(command.originThreadId);
    const source = yield* resolveSource(projection, command);
    if (source.kind !== "running-turn") return null;
    const run = projection.runs.find((row) => row.id === source.runId);
    const thread = projection.providerThreads.find((row) => row.id === run?.providerThreadId);
    if (thread?.driver !== "codex") return null;
    if (Option.isNone(snapshots) || snapshots.value.captureRunningForkText === undefined)
      return yield* failure(
        "Native running text capture is unavailable. Retry after reconnecting.",
      );
    const attempt = projection.attempts.find((row) => row.id === run?.activeAttemptId);
    // Native turn/started can be committed before the start RPC binds the attempt.
    // The accepted turn's exact attempt/root/thread links remain canonical authority.
    const turns = projection.providerTurns.filter(
      (row) =>
        row.runAttemptId === attempt?.id &&
        row.nodeId === run?.rootNodeId &&
        row.providerThreadId === thread.id &&
        row.nativeAcceptance === "accepted" &&
        ["running", "waiting"].includes(row.status) &&
        (attempt?.providerTurnId == null || row.id === attempt.providerTurnId),
    );
    const turn = turns.length === 1 ? turns[0] : undefined;
    if (
      run === undefined ||
      attempt === undefined ||
      turn === undefined ||
      run.rootNodeId === null ||
      thread.providerSessionId === null ||
      thread.nativeThreadRef?.nativeId == null ||
      turn.nativeTurnRef?.nativeId == null
    )
      return yield* failure("The selected native running boundary is not ready. Retry the fork.");
    const owner: ProviderTextSnapshotOwner = {
      threadId: projection.thread.id,
      runId: run.id,
      activeAttemptId: attempt.id,
      rootNodeId: run.rootNodeId,
      runOrdinal: run.ordinal,
      providerThreadId: thread.id,
      nativeThreadId: thread.nativeThreadRef.nativeId,
      providerTurnId: turn.id,
      nativeTurnId: turn.nativeTurnRef.nativeId,
      providerSessionId: thread.providerSessionId,
      providerInstanceId: run.providerInstanceId,
      driver: thread.driver,
    };
    return yield* snapshots.value.captureRunningForkText(owner).pipe(
      Effect.mapError(
        (cause) =>
          new OrchestrationDispatchCommandError({
            message:
              cause.reason === "timed-out"
                ? "The running response took too long to capture. Retry the fork."
                : `Native running text capture refused (${cause.reason}). Retry the fork.`,
            cause,
            forkDisposition: "rejected",
          }),
      ),
    );
  });

  const dispatch = Effect.fn("ConversationFork.dispatch")(function* (command: ThreadForkCommand) {
    const capture: CapturedProviderText | null = yield* Effect.acquireRelease(
      prepareTextCapture(command),
      (captured) =>
        captured === null || Option.isNone(snapshots)
          ? Effect.void
          : (snapshots.value.releaseCapturedForkText?.(captured) ?? Effect.void),
      { interruptible: true },
    );
    const accept = Effect.gen(function* () {
      const receipt = yield* receipts.getByCommandId(command.commandId);
      if (Option.isSome(receipt)) {
        if (
          receipt.value.threadId !== command.newThreadId ||
          receipt.value.commandType !== "thread.conversation.fork"
        )
          return yield* failure("This command identity belongs to another operation.");
        if (receipt.value.status === "rejected")
          return yield* failure(receipt.value.error ?? "This fork was rejected.");
        const target = yield* projections.getThread(command.newThreadId);
        if (target.conversationFork?.status === "failed") {
          const now = yield* DateTime.now;
          const sequence = yield* sink.latestSequence({ threadId: target.id });
          yield* sink.writeWithEffects({
            events: [
              yield* metadataEvent(
                {
                  ...target,
                  conversationFork: {
                    ...target.conversationFork,
                    status: "pending",
                    error: null,
                  },
                },
                now,
              ),
            ],
            effects: [
              {
                id: `scient-fork:${command.commandId}:retry:${sequence}`,
                commandId: command.commandId,
                threadId: target.id,
                request: { type: "scient-fork.provision" },
              },
            ],
          });
        }
        return receipt.value.resultSequence;
      }
      const destinationExists = yield* projections
        .getThread(command.newThreadId)
        .pipe(
          Effect.as(true),
          Effect.catchTags({ ProjectionStoreThreadNotFoundError: () => Effect.succeed(false) }),
        );
      if (destinationExists)
        return yield* failure("The destination already exists. Choose a new fork identity.");
      const inspected = yield* inspect(command, command.newThreadId, capture?.projection);
      const { projection, plan, source, cwd, fromCheckpointRef, checkpointAvailable } = inspected;
      const markerSource =
        source.kind === "user-message"
          ? {
              type: "message" as const,
              threadId: projection.thread.id,
              messageId: source.messageId,
              position: "before" as const,
            }
          : plan.boundaryRunId !== null
            ? { type: "run" as const, threadId: projection.thread.id, runId: plan.boundaryRunId }
            : source.kind === "assistant-response"
              ? {
                  type: "message" as const,
                  threadId: projection.thread.id,
                  messageId: source.messageId,
                  position: "after" as const,
                }
              : yield* failure("The fork's durable conversation boundary is unavailable.");
      if (command.workspaceMode === "local" && !inspected.localAvailable)
        return yield* failure(
          "The original worktree is unavailable. Restore its saved checkpoint into a new worktree instead.",
        );
      if (command.workspaceMode === "new-worktree" && !checkpointAvailable)
        return yield* failure(
          "This boundary has no saved workspace checkpoint. Fork locally instead.",
        );
      const requestedCheckpointRef =
        checkpointAvailable &&
        (source.kind !== "running-turn" || command.workspaceMode === "new-worktree")
          ? checkpointRefForThreadTurn(command.newThreadId, 0)
          : null;
      const owned =
        requestedCheckpointRef === null
          ? null
          : yield* checkpointOwnership
              .reserve({
                cwd,
                commandId: command.commandId,
                targetThreadId: command.newThreadId,
                checkpointRef: requestedCheckpointRef,
              })
              .pipe(
                Effect.tapError((cause) =>
                  Effect.logWarning("Fork snapshot ownership could not be recorded", { cause }),
                ),
                Effect.mapError(snapshotFailure),
              );
      const checkpointRef = owned?.ref ?? null;
      if (checkpointRef !== null) {
        if (source.kind === "running-turn")
          yield* baseline.capture({ cwd, toCheckpointRef: checkpointRef }).pipe(
            Effect.provideService(CheckpointPublicationWitness, owned!.beforePublish),
            Effect.tapError((cause) =>
              Effect.logWarning("Fork workspace snapshot capture failed", { cause }),
            ),
            Effect.mapError(snapshotFailure),
          );
        else {
          const unavailable = failure(
            command.workspaceMode === "new-worktree"
              ? "The saved workspace checkpoint is unavailable. Fork without a new worktree instead."
              : "The saved workspace checkpoint is unavailable. Retry the fork.",
          );
          const copied =
            fromCheckpointRef !== null &&
            (yield* baseline.copy({ cwd, fromCheckpointRef, toCheckpointRef: checkpointRef }).pipe(
              Effect.provideService(CheckpointPublicationWitness, owned!.beforePublish),
              Effect.tapError((cause) =>
                Effect.logWarning("Fork workspace checkpoint copy failed", { cause }),
              ),
              Effect.mapError(() => unavailable),
            ));
          if (!copied) return yield* unavailable;
        }
      }
      const now = yield* DateTime.now;
      const nativeSource = freezeConversationForkNativeSource({
        projection,
        retainedSourceItems: plan.retained,
        boundaryRunId: plan.boundaryRunId,
        sourceKind: source.kind,
      });
      const transfer: OrchestrationV2ContextTransfer = {
        id: ContextTransferId.make(`scient-fork:${command.commandId}:transfer`),
        type: "fork",
        sourceThreadId: projection.thread.id,
        targetThreadId: command.newThreadId,
        sourcePoint: {
          threadId: projection.thread.id,
          ...(plan.boundaryRunId === null ? {} : { runId: plan.boundaryRunId }),
        },
        basePoint: null,
        sourceProviderInstanceId:
          nativeSource.strategy === "native_fork"
            ? nativeSource.frozenSource.sourceRun.providerInstanceId
            : projection.thread.providerInstanceId,
        targetProviderInstanceId: null,
        targetRunId: null,
        status: "pending",
        resolution: null,
        ...(nativeSource.strategy === "native_fork"
          ? { frozenSource: nativeSource.frozenSource }
          : { portableReason: nativeSource.reason }),
        createdBy: "user",
        error: null,
        createdAt: now,
        updatedAt: now,
        consumedAt: null,
      };
      const checkpointOid =
        checkpointRef === null ? null : yield* baseline.resolveCheckpoint(cwd, checkpointRef);
      if (checkpointRef !== null && checkpointOid === null)
        return yield* failure("The frozen workspace checkpoint is unavailable. Retry the fork.");
      // Source/destination locks are already held. Global title allocation only
      // serializes sibling reads and admission, never workspace capture.
      return yield* titles.withLock(
        "conversation-fork-titles",
        Effect.gen(function* () {
          const projectThreads = yield* projections.getProjectThreadTitles(projection.thread.id);
          const lastAssistant = plan.retained.findLast((item) => item.type === "assistant_message");
          const thread: OrchestrationV2AppThread = {
            ...projection.thread,
            id: command.newThreadId,
            title:
              command.titleOverride ??
              deriveForkTitle({
                origin: projection.thread,
                originHasForkLineage: projection.thread.forkLineage != null,
                projectThreads,
              }),
            createdBy: "user",
            creationSource: "web",
            activeProviderThreadId: null,
            lineage: {
              parentThreadId: projection.thread.id,
              rootThreadId: projection.thread.lineage.rootThreadId,
              relationshipToParent: "fork",
            },
            forkedFrom: null,
            historyOrigin: "scient_fork",
            conversationImport: null,
            forkLineage: {
              originThreadId: projection.thread.id,
              baselineAssistantMessageId:
                lastAssistant?.type === "assistant_message" ? lastAssistant.messageId : null,
              ...(projection.thread.conversationImport == null
                ? projection.thread.forkLineage?.sourceImport === undefined
                  ? {}
                  : { sourceImport: projection.thread.forkLineage.sourceImport }
                : { sourceImport: projection.thread.conversationImport }),
            },
            conversationFork: {
              commandId: command.commandId,
              sourceThreadId: projection.thread.id,
              workspaceMode: command.workspaceMode,
              // History is shared, so only a new worktree still needs setting up.
              status: command.workspaceMode === "new-worktree" ? "pending" : "ready",
              cwd,
              checkpointRef,
              checkpointOid,
              // Shared files, recorded so the client keeps their open previews.
              attachmentCopies: plan.attachmentCopies,
              error: null,
            },
            createdAt: now,
            updatedAt: now,
            archivedAt: null,
            deletedAt: null,
            settledAt: null,
            settledOverride: null,
            unsettledAt: null,
            snoozedAt: null,
            snoozedUntil: null,
            limitRecovery: null,
            pinnedAt: null,
            pinOrderKey: null,
            activeOrderKey: null,
            lastVisitedAt: null,
            titleRegeneration: null,
            rollbackFailure: null,
            rollbackRequestId: undefined,
            linkedPullRequest: null,
            branchPullRequest: null,
            pullRequests: [],
          };
          const events: OrchestrationV2DomainEvent[] = [
            {
              id: EventId.make(`scient-fork:${command.commandId}:thread`),
              threadId: thread.id,
              occurredAt: now,
              type: "thread.created",
              payload: thread,
            },
            ...(plan.history.length === 0
              ? []
              : [
                  {
                    id: EventId.make(`scient-fork:${command.commandId}:transfer`),
                    threadId: thread.id,
                    occurredAt: now,
                    type: "context-transfer.created",
                    payload: transfer,
                  } satisfies OrchestrationV2DomainEvent,
                ]),
            ...plan.messages.map((payload, index): OrchestrationV2DomainEvent => ({
              id: EventId.make(`scient-fork:${command.commandId}:message:${index}`),
              threadId: thread.id,
              occurredAt: now,
              type: "message.updated",
              payload,
            })),
            ...plan.items.map((payload, index): OrchestrationV2DomainEvent => ({
              id: EventId.make(`scient-fork:${command.commandId}:item:${index}`),
              threadId: thread.id,
              occurredAt: now,
              type: "turn-item.updated",
              payload,
            })),
            {
              id: EventId.make(`scient-fork:${command.commandId}:boundary`),
              threadId: thread.id,
              occurredAt: now,
              type: "turn-item.updated",
              payload: conversationForkBoundaryItem({
                targetThreadId: thread.id,
                source: markerSource,
                ordinal: plan.history.length,
                createdAt: now,
              }),
            },
            ...plan.nodes.map((payload, index): OrchestrationV2DomainEvent => ({
              id: EventId.make(`scient-fork:${command.commandId}:node:${index}`),
              threadId: thread.id,
              occurredAt: now,
              type: "node.updated",
              payload,
            })),
            ...plan.plans.map((payload, index): OrchestrationV2DomainEvent => ({
              id: EventId.make(`scient-fork:${command.commandId}:plan:${index}`),
              threadId: thread.id,
              occurredAt: now,
              type: "plan.updated",
              payload,
            })),
          ];
          const commit = sink.commitCommand({
            ...(capture === null ? {} : { runningForkSource: { owner: capture.owner, capture } }),
            commandId: command.commandId,
            threadId: thread.id,
            commandType: "thread.conversation.fork",
            acceptedAt: now,
            events,
            forkHistory: plan.history,
            effects:
              thread.conversationFork?.status === "pending"
                ? [
                    {
                      id: `scient-fork:${command.commandId}:provision`,
                      commandId: command.commandId,
                      threadId: thread.id,
                      request: { type: "scient-fork.provision" },
                    },
                  ]
                : [],
          });
          const guardedCommit =
            capture === null
              ? commit
              : Effect.gen(function* () {
                  if (!(yield* baseline.workspaceExists(cwd)))
                    return yield* failure("The captured workspace is unavailable. Retry the fork.");
                  return yield* commit;
                }).pipe(attachmentArbitration.withPermit);
          const committed = yield* (
            capture === null
              ? guardedCommit
              : Option.isSome(snapshots) && snapshots.value.withCapturedForkText !== undefined
                ? snapshots.value.withCapturedForkText(capture, guardedCommit)
                : Effect.fail(new ProviderTextSnapshotError({ reason: "owner-lost" }))
          ).pipe(
            Effect.mapError(
              (cause) =>
                new OrchestrationDispatchCommandError({
                  message: "The running source changed before fork acceptance. Retry the fork.",
                  cause,
                  forkDisposition: "rejected",
                }),
            ),
          );
          return committed.receipt.resultSequence;
        }),
      );
    });
    // Consistent lock order prevents forks in opposite directions deadlocking.
    const locked = [...new Set([command.originThreadId, command.newThreadId])]
      .sort()
      .reduceRight((effect, id) => executor.withLock(id, effect), accept);
    const sequence = yield* locked;
    if (capture !== null && Option.isSome(snapshots))
      yield* snapshots.value.releaseCapturedForkText?.(capture) ?? Effect.void;
    const forkAttachmentIdMap = yield* awaitReady(command.newThreadId).pipe(
      Effect.mapError((cause) =>
        isDispatchError(cause)
          ? cause
          : new OrchestrationDispatchCommandError({
              message:
                "The fork was accepted, but its setup receipt could not be read. Retry the same fork.",
              cause,
              forkDisposition: "pending",
            }),
      ),
    );
    return { sequence, forkAttachmentIdMap };
  }, Effect.scoped);

  const provision = Effect.fn("ConversationFork.provision")(function* (
    threadId: ThreadId,
    willRetry: boolean,
  ) {
    const program = executor
      .withLock(
        threadId,
        Effect.gen(function* () {
          const thread = yield* projections.getThread(threadId);
          const fork = thread.conversationFork;
          if (fork == null || fork.status === "ready" || thread.deletedAt !== null) return;
          let worktreePath = thread.worktreePath;
          let branch = thread.branch;
          if (fork.workspaceMode === "new-worktree") {
            if (
              fork.checkpointRef === null ||
              fork.checkpointOid === null ||
              (yield* baseline.resolveCheckpoint(fork.cwd, fork.checkpointRef)) !==
                fork.checkpointOid
            )
              return yield* failure("The frozen fork checkpoint is unavailable.", "abandoned");
            branch = `scient/fork/${threadId.toLowerCase().replace(/[^a-z0-9._-]+/g, "-")}`;
            const listed = yield* git.listRefs({
              cwd: fork.cwd,
              query: branch,
              refKind: "local",
              includeMatchingRemoteRefs: false,
              refresh: true,
              limit: 100,
            });
            const existing = listed.refs.find((ref) => !ref.isRemote && ref.name === branch);
            const created = existing?.worktreePath == null;
            worktreePath =
              existing?.worktreePath ??
              (yield* git.createWorktree(
                existing
                  ? { cwd: fork.cwd, refName: branch, path: null }
                  : { cwd: fork.cwd, refName: fork.checkpointRef, newRefName: branch, path: null },
              )).worktree.path;
            if (
              !(yield* baseline.verifyWorktree({
                cwd: fork.cwd,
                path: worktreePath,
                branch,
                checkpointRef: fork.checkpointRef,
                requireClean: !created,
              }))
            )
              return yield* failure(
                "The fork worktree changed or did not finish checkout. Its files were left in place; create a fresh fork.",
                "abandoned",
              );
          }
          const now = yield* DateTime.now;
          yield* sink.write({
            events: [
              yield* metadataEvent(
                {
                  ...thread,
                  worktreePath,
                  branch,
                  conversationFork: { ...fork, status: "ready", error: null },
                },
                now,
              ),
            ],
          });
        }),
      )
      .pipe(Effect.scoped);
    // The fork records and returns its setup error. Git and storage errors name
    // workspace paths and carry Git output: those stay in the server log.
    yield* program.pipe(
      Effect.tapError((cause) =>
        isDispatchError(cause)
          ? Effect.void
          : Effect.logWarning("Fork workspace setup failed", { cause }),
      ),
      Effect.mapError((cause) =>
        isDispatchError(cause)
          ? cause
          : failure("Unable to set up this fork's worktree. Retry the fork.", "failed"),
      ),
      Effect.tapError((cause) =>
        willRetry && !isAbandonedFailure(cause)
          ? Effect.void
          : executor.withLock(
              threadId,
              Effect.gen(function* () {
                const thread = yield* projections.getThread(threadId);
                if (
                  thread.conversationFork == null ||
                  thread.deletedAt !== null ||
                  thread.conversationFork.status === "ready"
                )
                  return;
                const abandoned = isAbandonedFailure(cause);
                const now = yield* DateTime.now;
                const updated = {
                  ...thread,
                  ...(abandoned ? { deletedAt: now } : {}),
                  conversationFork: {
                    ...thread.conversationFork,
                    status: abandoned ? ("abandoned" as const) : ("failed" as const),
                    error: cause.message,
                  },
                };
                const event = yield* metadataEvent(updated, now);
                const fork = thread.conversationFork;
                // An abandoned fork is deleted: it releases what deleting it would,
                // such as a deleted source's files it was the last to show.
                const released = abandoned
                  ? yield* projections.getThreadAttachmentIds(threadId)
                  : [];
                yield* sink.writeWithEffects({
                  events: [abandoned ? { ...event, type: "thread.deleted" } : event],
                  effects:
                    released.length === 0
                      ? []
                      : [
                          {
                            id: `scient-fork:${fork.commandId}:abandoned:attachments`,
                            commandId: fork.commandId,
                            threadId,
                            request: { type: "attachment.cleanup", attachmentIds: released },
                          },
                        ],
                });
              }),
            ),
      ),
    );
  });

  return ConversationForkService.of({
    dispatch: (command) =>
      withoutVcsDiagnostics(dispatch(command)).pipe(
        Effect.mapError((cause) =>
          isDispatchError(cause)
            ? cause
            : new OrchestrationDispatchCommandError({
                message: cause.message,
                cause,
                forkDisposition: "rejected",
              }),
        ),
      ),
    provision: (threadId, willRetry) =>
      provision(threadId, willRetry).pipe(
        Effect.mapError((cause) =>
          isDispatchError(cause)
            ? cause
            : new OrchestrationDispatchCommandError({
                message: cause.message,
                cause,
                forkDisposition: "failed",
              }),
        ),
      ),
    getOptions: (input) =>
      withoutVcsDiagnostics(
        inspect(input, ThreadId.make(`scient-options:${input.originThreadId}`)),
      ).pipe(
        Effect.map(({ source, checkpointAvailable, localAvailable }): ForkOptions => ({
          available: true,
          localAvailable,
          reason: localAvailable
            ? null
            : "The original worktree is unavailable. A saved checkpoint can be restored into a new worktree.",
          newWorktree: checkpointAvailable,
          sourceAssistantMessageId: source.kind === "assistant-response" ? source.messageId : null,
          sourceUserMessageId: source.kind === "user-message" ? source.messageId : null,
          sourceRunningRunId: source.kind === "running-turn" ? source.runId : null,
        })),
        Effect.catch((cause) =>
          !isDispatchError(cause) && !isPlanError(cause)
            ? Effect.fail(
                new OrchestrationDispatchCommandError({
                  message: cause.message,
                  cause,
                  forkDisposition: "rejected",
                }),
              )
            : Effect.succeed({
                available: false,
                localAvailable: false,
                reason: cause.message,
                newWorktree: false,
                sourceAssistantMessageId: null,
                sourceUserMessageId: null,
              }),
        ),
      ),
  });
});

export const layer = Layer.effect(ConversationForkService, make);
