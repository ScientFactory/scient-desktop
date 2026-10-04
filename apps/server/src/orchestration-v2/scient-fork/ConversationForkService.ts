import {
  EventId,
  OrchestrationDispatchCommandError,
  type ForkOptions,
  type GetForkOptionsInput,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ThreadProjection,
  type ThreadForkCommand,
  ThreadId,
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
import { makeKeyedSerialExecutor } from "../KeyedSerialExecutor.ts";
import { ProjectionStoreV2 } from "../ProjectionStore.ts";
import { ProjectStoreV2 } from "../ProjectStore.ts";
import { ThreadCommandExecutor } from "../ThreadCommandExecutor.ts";
import { randomUuidV4 } from "../RandomUuid.ts";
import {
  ScientForkAttachmentCopier,
  ScientForkAttachmentCopyError,
} from "./ForkAttachmentCopier.ts";
import { ScientForkCheckpointBaseline } from "./ForkCheckpointBaseline.ts";
import { planConversationFork, type ConversationForkSource } from "./ConversationForkPlan.ts";

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

const isDispatchError = Schema.is(OrchestrationDispatchCommandError);
const isAttachmentCopyError = Schema.is(ScientForkAttachmentCopyError);
const isAbandonedFailure = (cause: unknown) =>
  (isDispatchError(cause) && cause.forkDisposition === "abandoned") ||
  (isAttachmentCopyError(cause) &&
    (cause.reason === "source-unavailable" || cause.reason === "unsafe-mapping"));

const failure = (
  message: string,
  forkDisposition: "rejected" | "failed" | "abandoned" = "rejected",
) => new OrchestrationDispatchCommandError({ message, forkDisposition });

const make = Effect.gen(function* () {
  const projections = yield* ProjectionStoreV2;
  const projects = yield* ProjectStoreV2;
  const receipts = yield* CommandReceiptStoreV2;
  const sink = yield* EventSinkV2;
  const executor = yield* ThreadCommandExecutor;
  const titles = yield* makeKeyedSerialExecutor<string>();
  const baseline = yield* ScientForkCheckpointBaseline;
  const copier = yield* ScientForkAttachmentCopier;
  const git = yield* GitWorkflowService;

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
  ) {
    const projection = yield* projections.getThreadProjection(input.originThreadId);
    if (
      projection.thread.conversationFork != null &&
      projection.thread.conversationFork.status !== "ready"
    )
      return yield* failure("Finish the original fork's workspace setup first.");
    const source = yield* resolveSource(projection, input);
    const plan = yield* planConversationFork({ projection, targetThreadId, source });
    const project = yield* projects.get(projection.thread.projectId);
    if (Option.isNone(project)) return yield* failure("The conversation's project is unavailable.");
    const cwd = projection.thread.worktreePath ?? project.value.workspaceRoot;
    if (!(yield* baseline.workspaceExists(cwd)))
      return yield* failure("The original workspace is unavailable.");
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
      const retainedIds = new Set(plan.items.map((item) => item.inheritedFrom?.itemId));
      if (
        projection.turnItems
          .filter((item) => item.inheritedFrom !== undefined)
          .every((item) => retainedIds.has(item.inheritedFrom?.itemId))
      )
        fromCheckpointRef = projection.thread.conversationFork.checkpointRef;
    }
    const gitRepository = yield* baseline.isGitRepository(cwd);
    const checkpointAvailable =
      gitRepository &&
      (source.kind === "running-turn" ||
        (fromCheckpointRef !== null && (yield* baseline.hasCheckpoint(cwd, fromCheckpointRef))));
    return { projection, source, plan, cwd, fromCheckpointRef, checkpointAvailable };
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
        initial.conversationFork?.status === "pending"
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

  const dispatch = Effect.fn("ConversationFork.dispatch")(function* (command: ThreadForkCommand) {
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
                  conversationFork: { ...target.conversationFork, status: "pending", error: null },
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
      const destinationExists = yield* projections.getThread(command.newThreadId).pipe(
        Effect.as(true),
        Effect.catchTag("ProjectionStoreThreadNotFoundError", () => Effect.succeed(false)),
      );
      if (destinationExists)
        return yield* failure("The destination already exists. Choose a new fork identity.");
      const inspected = yield* inspect(command, command.newThreadId);
      const { projection, plan, source, cwd, fromCheckpointRef, checkpointAvailable } = inspected;
      if (command.workspaceMode === "new-worktree" && !checkpointAvailable)
        return yield* failure(
          "This boundary has no saved workspace checkpoint. Fork locally instead.",
        );
      yield* copier.checkSources({
        threadId: command.newThreadId,
        attachments: plan.attachmentCopies.map(({ source }) => source),
      });
      const checkpointRef = checkpointAvailable
        ? checkpointRefForThreadTurn(command.newThreadId, 0)
        : null;
      if (checkpointRef !== null) {
        const copied =
          source.kind === "running-turn"
            ? yield* baseline.capture({ cwd, toCheckpointRef: checkpointRef })
            : fromCheckpointRef !== null &&
              (yield* baseline.copy({ cwd, fromCheckpointRef, toCheckpointRef: checkpointRef }));
        if (!copied)
          return yield* failure("Unable to freeze this workspace checkpoint. Retry the fork.");
      }
      const now = yield* DateTime.now;
      const shells = yield* projections.getShellSnapshot();
      const archived = yield* projections.getShellSnapshot({ location: "archive" });
      const lastAssistant = plan.items.findLast((item) => item.type === "assistant_message");
      const thread: OrchestrationV2AppThread = {
        ...projection.thread,
        id: command.newThreadId,
        title:
          command.titleOverride ??
          deriveForkTitle({
            origin: projection.thread,
            originHasForkLineage: projection.thread.forkLineage != null,
            projectThreads: [...shells.threads, ...archived.threads].filter(
              (thread) => thread.projectId === projection.thread.projectId,
            ),
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
          status: "pending",
          cwd,
          checkpointRef,
          checkpointOid:
            checkpointRef === null ? null : yield* baseline.resolveCheckpoint(cwd, checkpointRef),
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
      const committed = yield* sink.commitCommand({
        commandId: command.commandId,
        threadId: thread.id,
        commandType: "thread.conversation.fork",
        acceptedAt: now,
        events,
        effects: [
          {
            id: `scient-fork:${command.commandId}:provision`,
            commandId: command.commandId,
            threadId: thread.id,
            request: { type: "scient-fork.provision" },
          },
        ],
      });
      return committed.receipt.resultSequence;
    });
    // Consistent lock order prevents forks in opposite directions deadlocking.
    const locked = [...new Set([command.originThreadId, command.newThreadId])]
      .sort()
      .reduceRight((effect, id) => executor.withLock(id, effect), accept);
    const sequence = yield* titles.withLock("conversation-fork-titles", locked);
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
  });

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
          yield* copier.copyAll({ threadId, copies: fork.attachmentCopies });
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
    yield* program.pipe(
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
                yield* sink.writeWithEffects({
                  events: [abandoned ? { ...event, type: "thread.deleted" } : event],
                  effects: abandoned
                    ? [
                        {
                          id: `scient-fork:${fork.commandId}:abandoned:attachments`,
                          commandId: fork.commandId,
                          threadId,
                          request: {
                            type: "attachment.cleanup",
                            attachmentIds: fork.attachmentCopies.map((copy) => copy.target.id),
                          },
                        },
                      ]
                    : [],
                });
              }),
            ),
      ),
    );
  });

  return ConversationForkService.of({
    dispatch: (command) =>
      dispatch(command).pipe(
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
      inspect(input, ThreadId.make(`scient-options:${input.originThreadId}`)).pipe(
        Effect.map(({ source, checkpointAvailable }): ForkOptions => ({
          available: true,
          localAvailable: true,
          reason: null,
          newWorktree: checkpointAvailable,
          sourceAssistantMessageId: source.kind === "assistant-response" ? source.messageId : null,
          sourceUserMessageId: source.kind === "user-message" ? source.messageId : null,
          sourceRunningRunId: source.kind === "running-turn" ? source.runId : null,
        })),
        Effect.catch((cause) =>
          Effect.succeed({
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
