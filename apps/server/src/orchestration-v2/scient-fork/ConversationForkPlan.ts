import {
  MessageId,
  NodeId,
  PlanId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
  OrchestrationV2ConversationMessageJson,
  OrchestrationV2TurnItemJson,
  ChatAttachment,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2TurnItem,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2PlanArtifact,
  type RunId,
  type ThreadForkAttachmentCopy,
} from "@t3tools/contracts";
import { remapComposerContextAttachments } from "@t3tools/shared/composerContextReferences";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { attachmentFileExtension, createDeterministicAttachmentId } from "../../attachmentStore.ts";

export type ConversationForkSource =
  | { readonly kind: "assistant-response"; readonly messageId: MessageId }
  | { readonly kind: "user-message"; readonly messageId: MessageId }
  | { readonly kind: "running-turn"; readonly runId: RunId };

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
const attachmentJson = Schema.fromJsonString(ChatAttachment);

/** Freeze the visible conversation prefix; no source execution or pending request is adopted. */
export const planConversationFork = Effect.fn("ScientConversationFork.plan")(function* (input: {
  readonly projection: OrchestrationV2ThreadProjection;
  readonly targetThreadId: ThreadId;
  readonly source: ConversationForkSource;
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
  if (source.kind === "running-turn") {
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
  const retained = rows.slice(0, end + 1);
  const messageIds = new Map<MessageId, MessageId>();
  const itemIds = new Map<TurnItemId, TurnItemId>();
  const attachmentMap = new Map<string, ChatAttachment>();
  const attachmentCopies: ThreadForkAttachmentCopy[] = [];
  const sourceAttachments: ChatAttachment[] = [];
  const collectAttachments = (attachments: ReadonlyArray<ChatAttachment>) => {
    for (const source of attachments) {
      if (attachmentMap.has(source.id)) continue;
      const rawId = createDeterministicAttachmentId(
        targetThreadId,
        `scient-conversation-fork:${source.id}`,
      );
      if (rawId === null) return false;
      const id =
        source.type === "file"
          ? `${rawId}-${attachmentFileExtension(source.name).slice(1)}`
          : rawId;
      const frozenSource = Schema.decodeSync(attachmentJson)(
        Schema.encodeSync(attachmentJson)(source),
      );
      const target = { ...frozenSource, id };
      attachmentMap.set(source.id, target);
      sourceAttachments.push(frozenSource);
      attachmentCopies.push({ source: frozenSource, target });
    }
    return true;
  };
  for (const [index, { item }] of retained.entries()) {
    itemIds.set(item.id, TurnItemId.make(`scient-fork:${targetThreadId}:item:${index}`));
    if (item.type === "user_message" || item.type === "assistant_message") {
      if (!messageIds.has(item.messageId))
        messageIds.set(
          item.messageId,
          MessageId.make(`scient-fork:${targetThreadId}:message:${messageIds.size}`),
        );
      if (!collectAttachments(item.attachments ?? []))
        return yield* reject("The destination cannot own retained attachment files.");
    }
    if (item.type === "user_input_request" && item.questionAnswer) {
      const answerMessageId = item.questionAnswer.messageId;
      if (answerMessageId !== undefined && !messageIds.has(answerMessageId))
        messageIds.set(
          answerMessageId,
          MessageId.make(`scient-fork:${targetThreadId}:message:${messageIds.size}`),
        );
      if (!collectAttachments(Object.values(item.questionAnswer.attachmentsByQuestionId).flat()))
        return yield* reject("The destination cannot own retained answer attachments.");
    }
  }
  for (const message of projection.messages) {
    if (messageIds.has(message.id) && !collectAttachments(message.attachments))
      return yield* reject("The destination cannot own retained attachment files.");
  }
  const remapAttachments = <A extends ChatAttachment>(attachments: ReadonlyArray<A>) =>
    attachments.map((attachment) => ({ ...attachment, id: attachmentMap.get(attachment.id)!.id }));
  const messages = projection.messages
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
        attachments: remapAttachments(message.attachments),
        ...(message.context === undefined
          ? {}
          : {
              context: remapComposerContextAttachments(message.context, sourceAttachments, [
                ...attachmentMap.values(),
              ]),
            }),
      } satisfies OrchestrationV2ConversationMessage;
    });
  const plans = new Map<PlanId, OrchestrationV2PlanArtifact>();
  const nodes = new Map<NodeId, OrchestrationV2ExecutionNode>();
  const items = retained.map(({ item: sourceItem }, ordinal): OrchestrationV2TurnItem => {
    const original = Schema.decodeSync(itemJson)(Schema.encodeSync(itemJson)(sourceItem));
    const base = {
      id: itemIds.get(original.id)!,
      threadId: targetThreadId,
      runId: null,
      nodeId: null as OrchestrationV2TurnItem["nodeId"],
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId:
        original.parentItemId === null ? null : (itemIds.get(original.parentItemId) ?? null),
      ordinal,
      status: ["idle", "pending", "running", "waiting"].includes(original.status)
        ? ("interrupted" as const)
        : original.status,
      inheritedFrom: original.inheritedFrom ?? {
        threadId: original.threadId,
        itemId: original.id,
        runId: original.runId,
        status: original.status,
      },
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
      case "user_message":
        return {
          ...original,
          ...base,
          messageId: messageIds.get(original.messageId)!,
          attachments: remapAttachments(original.attachments),
          ...(original.context === undefined
            ? {}
            : {
                context: remapComposerContextAttachments(original.context, sourceAttachments, [
                  ...attachmentMap.values(),
                ]),
              }),
        };
      case "assistant_message":
        return {
          ...original,
          ...base,
          type: original.type,
          messageId: messageIds.get(original.messageId)!,
          text: original.text,
          streaming: false,
          ...(original.attachments === undefined
            ? {}
            : { attachments: remapAttachments(original.attachments) }),
        };
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
            : {
                questionAnswer: {
                  ...original.questionAnswer,
                  requestId,
                  ...(original.questionAnswer.messageId === undefined
                    ? {}
                    : {
                        messageId: messageIds.get(original.questionAnswer.messageId)!,
                      }),
                  attachmentsByQuestionId: Object.fromEntries(
                    Object.entries(original.questionAnswer.attachmentsByQuestionId).map(
                      ([key, attachments]) => [key, remapAttachments(attachments)],
                    ),
                  ),
                },
              }),
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
  return {
    items,
    messages,
    plans: [...plans.values()],
    nodes: [...nodes.values()],
    attachmentCopies,
    boundaryRunId,
  };
});
