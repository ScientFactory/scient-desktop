import {
  MessageId,
  NodeId,
  PlanId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
  OrchestrationV2ConversationMessageJson,
  OrchestrationV2TurnItemJson,
  type CommandId,
  type OrchestrationV2AppThread,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2TurnItem,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2PlanArtifact,
  type RunId,
  type ChatAttachment,
  type ThreadForkAttachmentCopy,
} from "@t3tools/contracts";
import { resolveForkInitialization } from "@t3tools/shared/orchestrationV2ForkInitialization";
import type * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { readHistoricalSystemMessage } from "../legacy/HistoricalSystemMessage.ts";
import type { PendingOrchestrationEffectV2 } from "../EffectOutbox.ts";
import {
  forkHistoryEntry,
  frozenHistoryFields,
  isCopiedForkItem,
  openRunIds,
  type ForkHistoryEntry,
} from "./ForkHistory.ts";

export type ConversationForkSource =
  | { readonly kind: "assistant-response"; readonly messageId: MessageId }
  | { readonly kind: "user-message"; readonly messageId: MessageId }
  | { readonly kind: "running-turn"; readonly runId: RunId }
  | { readonly kind: "settled-run"; readonly runId: RunId };

export class ConversationForkPlanError extends Schema.TaggedError<ConversationForkPlanError>()(
  "ConversationForkPlanError",
  { sourceThreadId: ThreadId, detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}

const itemJson = Schema.fromJsonString(OrchestrationV2TurnItemJson);
const messageJson = Schema.fromJsonString(OrchestrationV2ConversationMessageJson);

/** Freeze the visible conversation prefix; no source execution or pending request is adopted. */
export const planConversationFork = Effect.fn("ScientConversationFork.plan")(function* (input: {
  readonly projection: OrchestrationV2ThreadProjection;
  readonly targetThreadId: ThreadId;
  readonly source: ConversationForkSource;
  /** False to check a fork without building its copies (the options check). */
  readonly materialize?: boolean;
}) {
  const { projection, source, targetThreadId } = input;
  const reject = (detail: string) =>
    new ConversationForkPlanError({ sourceThreadId: projection.thread.id, detail });
  if (projection.thread.id === targetThreadId)
    return yield* reject("A conversation fork must have its own identity.");
  if (projection.thread.deletedAt !== null)
    return yield* reject("The original conversation was deleted.");

  const rows = projection.visibleTurnItems.toSorted(
    (left, right) => left.position - right.position,
  );
  // Frozen history has no executable run. Its recorded origin still groups
  // one response with the reasoning and tool results at that same boundary.
  const belongsToBoundary = (
    candidate: OrchestrationV2TurnItem,
    selected: OrchestrationV2TurnItem,
  ) =>
    selected.runId !== null
      ? candidate.runId === selected.runId
      : selected.historyTurnId !== undefined
        ? candidate.historyTurnId === selected.historyTurnId
        : selected.inheritedFrom?.runId != null &&
          candidate.inheritedFrom?.threadId === selected.inheritedFrom.threadId &&
          candidate.inheritedFrom?.runId === selected.inheritedFrom.runId;
  let end = -1;
  let boundaryRunId: RunId | null = null;
  if (source.kind === "settled-run") {
    const run = projection.runs.find((run) => run.id === source.runId);
    if (
      !run ||
      !["completed", "waiting", "failed", "interrupted", "cancelled"].includes(run.status)
    )
      return yield* reject("The selected run has not settled at a forkable boundary.");
    boundaryRunId = run.id;
    end = rows.findLastIndex(({ item }) => item.runId === run.id);
    if (end < 0) {
      // A cancelled queued run has no rendered item. Preserve the preceding
      // history, without admitting a later run or adopting its execution.
      const ordinals = new Map(
        projection.runs.map((candidate) => [candidate.id, candidate.ordinal]),
      );
      const next = rows.findIndex(
        ({ item }) => item.runId !== null && (ordinals.get(item.runId) ?? Infinity) > run.ordinal,
      );
      end = next < 0 ? rows.length - 1 : next - 1;
    }
  } else if (source.kind === "running-turn") {
    const run = projection.runs.find((run) => run.id === source.runId);
    if (!run || !["preparing", "starting", "running", "waiting"].includes(run.status)) {
      return yield* reject(
        "The selected run is no longer active. Fork its completed response instead.",
      );
    }
    boundaryRunId = run.id;
    end = rows.findLastIndex(({ item }) => item.runId === run.id);
    // A preparing run can have an accepted message without a rendered turn item yet.
    if (end < 0)
      return yield* reject(
        "The running request has not reached a durable conversation boundary yet.",
      );
  } else {
    const expectedType =
      source.kind === "assistant-response" ? "assistant_message" : "user_message";
    const clicked = rows.findIndex(
      ({ item }) => item.type === expectedType && item.messageId === source.messageId,
    );
    if (clicked < 0)
      return yield* reject("The selected message is no longer in the visible conversation.");
    const item = rows[clicked]!.item;
    boundaryRunId = item.runId;
    if (source.kind === "user-message") {
      // A steering message belongs to the active run too. Its fork starts
      // before that run, rather than treating unfinished work as a completed prefix.
      const firstInBoundary = rows.findIndex(({ item: candidate }) =>
        belongsToBoundary(candidate, item),
      );
      end = firstInBoundary < 0 ? clicked - 1 : firstInBoundary - 1;
      boundaryRunId =
        rows.slice(0, end + 1).findLast(({ item }) => item.runId !== null)?.item.runId ?? null;
    } else {
      if (item.type !== "assistant_message" || item.streaming || item.status !== "completed") {
        return yield* reject("Choose a completed response, or fork the active run.");
      }
      const run =
        item.runId === null ? undefined : projection.runs.find((run) => run.id === item.runId);
      const node = projection.nodes.find((node) => node.id === item.nodeId);
      if (
        run &&
        run.rootNodeId !== null &&
        item.nodeId !== null &&
        item.nodeId !== run.rootNodeId &&
        !(
          node?.kind === "assistant_message" &&
          node.threadId === projection.thread.id &&
          node.runId === run.id &&
          node.parentNodeId === run.rootNodeId &&
          node.rootNodeId === run.rootNodeId
        )
      ) {
        return yield* reject("Choose a response from the conversation, not a nested task.");
      }
      if (
        run &&
        !["completed", "failed", "interrupted", "cancelled", "waiting"].includes(run.status)
      ) {
        return yield* reject("This response's run has not settled yet.");
      }
      const lastInBoundary = rows.findLastIndex(({ item: candidate }) =>
        belongsToBoundary(candidate, item),
      );
      end = lastInBoundary < 0 ? clicked : lastInBoundary;
    }
  }
  const selectedRun = projection.runs.find((run) => run.id === boundaryRunId);
  const runOrdinals = new Map(projection.runs.map((run) => [run.id, run.ordinal]));
  // A later request can be recorded before the selected answer finishes.
  // Durable run ownership prevents that overlap from extending this prefix.
  const retained = rows.slice(0, end + 1).filter(
    ({ item, visibility }) =>
      selectedRun === undefined ||
      // Inherited rows carry other conversations' runs; they all precede local ones.
      visibility !== "local" ||
      item.runId === null ||
      (runOrdinals.get(item.runId) ?? Infinity) <= selectedRun.ordinal,
  );
  // The fork shares the retained history by reference (its frozen membership)
  // and owns copies only of what still changes or what it can act on.
  const openRuns = openRunIds(projection.runs);
  // A synthetic row (upstream's fork marker) exists only in memory: copy it too.
  const copies = (row: (typeof retained)[number]) =>
    row.visibility === "synthetic" || isCopiedForkItem(row.item, openRuns);
  const copied = retained.filter(copies);
  for (const { item } of retained)
    if (
      item.type === "user_input_request" &&
      item.questionAnswer !== undefined &&
      item.status === "completed" &&
      item.runId === null &&
      item.historyTurnId === undefined &&
      item.inheritedFrom?.runId == null
    )
      return yield* reject(
        "A retained submitted question answer has no authoritative turn boundary.",
      );
  const copyIds = new Map<TurnItemId, TurnItemId>(
    retained.flatMap((row, index) =>
      copies(row)
        ? [[row.item.id, TurnItemId.make(`scient-fork:${targetThreadId}:item:${index}`)] as const]
        : [],
    ),
  );
  const messageIds = new Map<MessageId, MessageId>();
  for (const { item } of copied)
    if (
      (item.type === "user_message" || item.type === "assistant_message") &&
      !messageIds.has(item.messageId)
    )
      messageIds.set(
        item.messageId,
        MessageId.make(`scient-fork:${targetThreadId}:message:${messageIds.size}`),
      );
  const history: ReadonlyArray<ForkHistoryEntry> = retained.map(
    ({ item, sourceThreadId, sourceItemId }) => {
      const copyId = copyIds.get(item.id);
      if (copyId === undefined) return forkHistoryEntry(sourceThreadId, sourceItemId, item);
      const entry = forkHistoryEntry(targetThreadId, copyId, item);
      return entry.messageId === null
        ? entry
        : {
            ...entry,
            messageId: messageIds.get(MessageId.make(entry.messageId)) ?? entry.messageId,
          };
    },
  );
  const materialize = input.materialize !== false;
  const messages = (materialize ? projection.messages : [])
    .filter((message) => messageIds.has(message.id))
    .map((source) => {
      const message = Schema.decodeSync(messageJson)(Schema.encodeSync(messageJson)(source));
      return {
        ...message,
        id: messageIds.get(message.id)!,
        threadId: targetThreadId,
        runId: null,
        nodeId: null,
        streaming: false,
      } satisfies OrchestrationV2ConversationMessage;
    });
  const plans = new Map<PlanId, OrchestrationV2PlanArtifact>();
  const nodes = new Map<NodeId, OrchestrationV2ExecutionNode>();
  const positions = new Map(retained.map(({ item }, index) => [item.id, index]));
  const items = (materialize ? copied : []).map(({ item: sourceItem }): OrchestrationV2TurnItem => {
    const original = Schema.decodeSync(itemJson)(Schema.encodeSync(itemJson)(sourceItem));
    const ordinal = positions.get(sourceItem.id)!;
    const base = {
      ...frozenHistoryFields(original),
      id: copyIds.get(original.id)!,
      threadId: targetThreadId,
      parentItemId: original.parentItemId,
      ordinal,
    };
    if (original.type === "proposed_plan" || original.type === "todo_list") {
      // Historical plans remain explicitly actionable, with destination-owned
      // artifacts. A detached completed node grants no provider/run authority.
      const prior = plans.get(original.planId);
      const id = prior?.id ?? PlanId.make(`scient-fork:${targetThreadId}:plan:${ordinal}`);
      const nodeId =
        prior?.nodeId ?? NodeId.make(`scient-fork:${targetThreadId}:plan-node:${ordinal}`);
      const sourcePlan = projection.plans.find((plan) => plan.id === original.planId);
      const planBase = {
        id,
        threadId: targetThreadId,
        runId: null,
        nodeId,
        status: sourcePlan?.status ?? ("active" as const),
      };
      plans.set(
        original.planId,
        original.type === "proposed_plan"
          ? { ...planBase, kind: "proposed_plan", markdown: original.markdown }
          : {
              ...planBase,
              kind: "todo_list",
              steps: original.steps,
              ...(original.explanation === undefined ? {} : { explanation: original.explanation }),
            },
      );
      nodes.set(nodeId, {
        id: nodeId,
        threadId: targetThreadId,
        runId: null,
        parentNodeId: null,
        rootNodeId: nodeId,
        kind: original.type === "proposed_plan" ? "plan" : "todo_list",
        status: "completed",
        countsForRun: false,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        runtimeRequestId: null,
        checkpointScopeId: null,
        startedAt: original.startedAt,
        completedAt: original.completedAt,
      });
      base.nodeId = nodeId;
    }
    switch (original.type) {
      case "handoff": {
        const forkInitialization = resolveForkInitialization(original, projection.contextTransfers);
        return {
          ...original,
          ...base,
          ...(forkInitialization === undefined ? {} : { forkInitialization }),
        };
      }
      case "user_message":
      case "assistant_message":
        return {
          ...original,
          ...base,
          messageId: messageIds.get(original.messageId)!,
          ...(original.type === "assistant_message" ? { streaming: false } : {}),
        } as OrchestrationV2TurnItem;
      case "reasoning":
        return { ...original, ...base, type: original.type, text: original.text, streaming: false };
      case "proposed_plan":
        return {
          ...original,
          ...base,
          type: original.type,
          planId: plans.get(original.planId)!.id,
          markdown: original.markdown,
          streaming: false,
        };
      case "todo_list":
        return {
          ...original,
          ...base,
          type: original.type,
          planId: plans.get(original.planId)!.id,
          steps: original.steps,
          ...(original.explanation === undefined ? {} : { explanation: original.explanation }),
        };
      case "approval_request":
        return {
          ...original,
          ...base,
          type: original.type,
          requestId: RuntimeRequestId.make(`scient-fork:${targetThreadId}:request:${ordinal}`),
          status: original.status === "completed" ? "completed" : "cancelled",
        };
      case "user_input_request": {
        const requestId = RuntimeRequestId.make(`scient-fork:${targetThreadId}:request:${ordinal}`);
        return {
          ...original,
          ...base,
          type: original.type,
          requestId,
          status: original.status === "completed" ? "completed" : "cancelled",
          ...(original.questionAnswer === undefined
            ? {}
            : { questionAnswer: { ...original.questionAnswer, requestId } }),
        };
      }
      case "fork": {
        const { providerThreadId: _sourceProviderThreadId, ...historicalFork } = original;
        const { providerThreadId: _destinationProviderThreadId, ...forkBase } = base;
        return { ...historicalFork, ...forkBase };
      }
      default:
        return { ...original, ...base };
    }
  });
  // Retained files are shared, not copied: each maps to itself.
  const sharedAttachments = new Map<string, ChatAttachment>();
  const share = (attachments: ReadonlyArray<ChatAttachment> | null | undefined) => {
    for (const attachment of attachments ?? [])
      if (!sharedAttachments.has(attachment.id)) sharedAttachments.set(attachment.id, attachment);
  };
  const retainedMessageIds = new Set<string>();
  for (const { item } of retained) {
    if (item.type === "user_message" || item.type === "assistant_message") {
      share(item.attachments);
      retainedMessageIds.add(item.messageId);
    }
    if (item.type === "user_input_request" && item.questionAnswer !== undefined)
      share(Object.values(item.questionAnswer.attachmentsByQuestionId).flat());
    const system = readHistoricalSystemMessage(item);
    if (Option.isSome(system)) share(system.value.attachments);
  }
  for (const message of projection.messages)
    if (retainedMessageIds.has(message.id)) share(message.attachments);
  const lastAssistant = retained.findLast(({ item }) => item.type === "assistant_message")?.item;
  return {
    /** The retained prefix as the source shows it, in order. */
    retained: retained.map(({ item }) => item),
    /** The fork's last retained answer, by the message id the fork shows for it. */
    baselineAssistantMessageId:
      lastAssistant?.type === "assistant_message"
        ? (messageIds.get(lastAssistant.messageId) ?? lastAssistant.messageId)
        : null,
    attachmentCopies: [...sharedAttachments.values()].map(
      (attachment): ThreadForkAttachmentCopy => ({ source: attachment, target: attachment }),
    ),
    history,
    items,
    messages,
    plans: [...plans.values()],
    nodes: [...nodes.values()],
    boundaryRunId,
  };
});

/** The inherited history a fork commits after its thread and transfer, in commit order:
 * messages, items, the fork boundary, nodes, then plans. */
export function conversationForkHistoryEvents(input: {
  readonly targetThreadId: ThreadId;
  readonly history: Pick<
    Effect.Success<ReturnType<typeof planConversationFork>>,
    "messages" | "items" | "nodes" | "plans"
  >;
  readonly boundaryItem: OrchestrationV2TurnItem;
  readonly occurredAt: DateTime.Utc;
}): ReadonlyArray<Omit<OrchestrationV2DomainEvent, "id">> {
  const { targetThreadId: threadId, history, boundaryItem, occurredAt } = input;
  return [
    ...history.messages.map((payload) => ({
      type: "message.updated" as const,
      threadId,
      occurredAt,
      payload,
    })),
    ...history.items.map((payload) => ({
      type: "turn-item.updated" as const,
      threadId,
      occurredAt,
      payload,
    })),
    { type: "turn-item.updated" as const, threadId, occurredAt, payload: boundaryItem },
    ...history.nodes.map((payload) => ({
      type: "node.updated" as const,
      threadId,
      occurredAt,
      payload,
    })),
    ...history.plans.map((payload) => ({
      type: "plan.updated" as const,
      threadId,
      occurredAt,
      payload,
    })),
  ];
}

/** A fork whose workspace is still pending asks the effect worker to provision it. */
export function conversationForkProvisionEffect(
  commandId: CommandId,
  targetThread: OrchestrationV2AppThread,
): PendingOrchestrationEffectV2 | undefined {
  return targetThread.conversationFork?.status === "pending"
    ? {
        id: `effect:${commandId}:scient-fork.provision`,
        commandId,
        threadId: targetThread.id,
        request: { type: "scient-fork.provision" },
      }
    : undefined;
}
