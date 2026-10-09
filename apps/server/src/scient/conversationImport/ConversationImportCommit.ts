import {
  EventId,
  NodeId,
  PlanId,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2TurnItem,
  TurnItemId,
  RuntimeRequestId,
  UserInputAttachmentAnswerPayload,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { EventSinkV2 } from "../../orchestration-v2/EventSink.ts";
import { CommandReceiptStoreV2 } from "../../orchestration-v2/CommandReceiptStore.ts";
import { ProjectStoreV2 } from "../../orchestration-v2/ProjectStore.ts";
import { ProjectionStoreV2 } from "../../orchestration-v2/ProjectionStore.ts";
import { ThreadCommandExecutor } from "../../orchestration-v2/ThreadCommandExecutor.ts";
import type { PortableConversationImportPlan } from "./conversationImportPlan.ts";

const decodeQuestionAnswer = Schema.decodeUnknownSync(UserInputAttachmentAnswerPayload);

export class ConversationImportCommitError extends Schema.TaggedError<ConversationImportCommitError>()(
  "ConversationImportCommitError",
  { message: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {}

const isCommitError = Schema.is(ConversationImportCommitError);

/** Convert the portable import plan into inert, locally owned V2 history. */
export function conversationImportEvents(command: PortableConversationImportPlan) {
  const now = DateTime.makeUnsafe(command.createdAt);
  const thread: OrchestrationV2AppThread = {
    id: command.threadId,
    projectId: command.projectId,
    title: command.title.trim() || "Imported conversation",
    createdBy: "user",
    creationSource: "server",
    providerInstanceId: command.modelSelection.instanceId,
    modelSelection: command.modelSelection,
    runtimeMode: command.runtimeMode,
    interactionMode: command.interactionMode,
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    historyOrigin: "conversation_import",
    conversationImport: command.origin,
    lineage: { parentThreadId: null, rootThreadId: command.threadId, relationshipToParent: null },
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    deletedAt: null,
    settledAt: null,
    settledOverride: null,
    lastVisitedAt: null,
  };
  const events: OrchestrationV2DomainEvent[] = [];
  const emit = (event: OrchestrationV2DomainEvent) => events.push(event);
  emit({
    id: EventId.make(`${command.commandId}:thread`),
    threadId: thread.id,
    occurredAt: now,
    type: "thread.created",
    payload: thread,
  });
  const unordered = [
    ...command.messages.map((message) => ({
      type: "message" as const,
      message,
      createdAt: message.createdAt,
      id: message.messageId,
    })),
    ...command.activities.map((activity) => ({
      type: "activity" as const,
      activity,
      createdAt: activity.createdAt,
      id: activity.id,
    })),
    ...command.proposedPlans.map((plan) => ({
      type: "plan" as const,
      plan,
      createdAt: plan.createdAt,
      id: plan.id,
    })),
  ];
  const records =
    command.historyOrder === undefined
      ? unordered.toSorted(
          (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
        )
      : (() => {
          const byKey = new Map(unordered.map((record) => [`${record.type}:${record.id}`, record]));
          if (command.historyOrder.length !== unordered.length)
            throw new ConversationImportCommitError({
              message: "The import history order is incomplete.",
            });
          return command.historyOrder.map((ref) => {
            const key = `${ref.type}:${ref.id}`;
            const record = byKey.get(key);
            if (record === undefined)
              throw new ConversationImportCommitError({
                message: "The import history order is invalid.",
              });
            byKey.delete(key);
            return record;
          });
        })();
  for (const [ordinal, record] of records.entries()) {
    const itemId = TurnItemId.make(`${command.commandId}:item:${record.id}`);
    const time = DateTime.makeUnsafe(record.createdAt);
    const base = {
      id: itemId,
      threadId: thread.id,
      runId: null,
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal,
      title: null,
      status: "completed" as const,
      startedAt: time,
      completedAt: time,
      updatedAt: time,
    };
    let item: OrchestrationV2TurnItem;
    switch (record.type) {
      case "message": {
        const message = record.message;
        const updatedAt = DateTime.makeUnsafe(message.updatedAt);
        const history = message.turnId === null ? {} : { historyTurnId: message.turnId };
        switch (message.role) {
          case "user":
          case "assistant": {
            const payload = {
              id: message.messageId,
              threadId: thread.id,
              runId: null,
              nodeId: null,
              createdBy: message.role === "user" ? ("user" as const) : ("agent" as const),
              creationSource: "server" as const,
              role: message.role,
              text: message.text,
              ...(message.role === "assistant" && message.citationPresentation !== undefined
                ? { citationPresentation: message.citationPresentation }
                : {}),
              attachments: message.attachments ?? [],
              streaming: false,
              createdAt: time,
              updatedAt,
            };
            emit({
              id: EventId.make(`${itemId}:message`),
              threadId: thread.id,
              occurredAt: now,
              type: "message.updated",
              payload,
            });
            item =
              message.role === "user"
                ? {
                    ...base,
                    ...history,
                    updatedAt,
                    completedAt: updatedAt,
                    type: "user_message",
                    messageId: message.messageId,
                    text: message.text,
                    attachments: message.attachments ?? [],
                    inputIntent: "turn_start",
                    createdBy: "user",
                    creationSource: "server",
                  }
                : {
                    ...base,
                    ...history,
                    updatedAt,
                    completedAt: updatedAt,
                    type: "assistant_message",
                    ...(message.citationPresentation === undefined
                      ? {}
                      : { citationPresentation: message.citationPresentation }),
                    messageId: message.messageId,
                    text: message.text,
                    attachments: message.attachments ?? [],
                    streaming: false,
                  };
            break;
          }
          case "reasoning":
            item = {
              ...base,
              ...history,
              updatedAt,
              completedAt: updatedAt,
              type: "reasoning",
              text: message.text,
              streaming: false,
            };
            break;
          case "system":
            item = {
              ...base,
              ...history,
              updatedAt,
              completedAt: updatedAt,
              type: "system_notice",
              message: message.text,
            };
            break;
        }
        break;
      }
      case "activity": {
        const activity = record.activity;
        if (activity.kind === "user-input.answer-submitted") {
          const answer = decodeQuestionAnswer(activity.payload);
          item = {
            ...base,
            ...(activity.turnId === null ? {} : { historyTurnId: activity.turnId }),
            type: "user_input_request",
            requestId: RuntimeRequestId.make(answer.requestId),
            questions: Object.keys(answer.answers).map((id) => ({
              id,
              header: "Question",
              question: answer.questionTextById?.[id] ?? id,
              options: [],
            })),
            questionAnswer: answer,
          };
          break;
        }
        // Retain the validated portable work-log/answer payload, never a live request.
        item = {
          ...base,
          ...(activity.turnId === null ? {} : { historyTurnId: activity.turnId }),
          type: "dynamic_tool",
          title: activity.summary,
          toolName: activity.kind,
          input: {
            kind: activity.kind,
            summary: activity.summary,
            tone: activity.tone,
            payload: activity.payload,
          },
        };
        break;
      }
      case "plan": {
        const plan = record.plan;
        const planId = PlanId.make(plan.id);
        const nodeId = NodeId.make(`${command.commandId}:plan-node:${plan.id}`);
        const updatedAt = DateTime.makeUnsafe(plan.updatedAt);
        emit({
          id: EventId.make(`${itemId}:node`),
          threadId: thread.id,
          occurredAt: now,
          type: "node.updated",
          payload: {
            id: nodeId,
            threadId: thread.id,
            runId: null,
            parentNodeId: null,
            rootNodeId: nodeId,
            kind: "plan",
            status: "completed",
            countsForRun: false,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            runtimeRequestId: null,
            checkpointScopeId: null,
            startedAt: time,
            completedAt: updatedAt,
          },
        });
        emit({
          id: EventId.make(`${itemId}:plan`),
          threadId: thread.id,
          occurredAt: now,
          type: "plan.updated",
          payload: {
            id: planId,
            threadId: thread.id,
            runId: null,
            nodeId,
            kind: "proposed_plan",
            status: plan.implementedAt === null ? "active" : "completed",
            markdown: plan.planMarkdown,
          },
        });
        item = {
          ...base,
          ...(plan.turnId === null ? {} : { historyTurnId: plan.turnId }),
          type: "proposed_plan",
          nodeId,
          planId,
          markdown: plan.planMarkdown,
          streaming: false,
          updatedAt,
          completedAt: updatedAt,
        };
        break;
      }
    }
    emit({
      id: EventId.make(`${itemId}:updated`),
      threadId: thread.id,
      occurredAt: now,
      type: "turn-item.updated",
      payload: item,
    });
  }
  return events;
}

export class ConversationImportCommit extends Context.Service<
  ConversationImportCommit,
  {
    readonly dispatch: (
      command: PortableConversationImportPlan,
    ) => Effect.Effect<void, ConversationImportCommitError>;
  }
>()("t3/scient/conversationImport/ConversationImportCommit") {}

export const layer = Layer.effect(
  ConversationImportCommit,
  Effect.gen(function* () {
    const sink = yield* EventSinkV2;
    const receipts = yield* CommandReceiptStoreV2;
    const projects = yield* ProjectStoreV2;
    const projections = yield* ProjectionStoreV2;
    const executor = yield* ThreadCommandExecutor;
    const dispatch = Effect.fn("ConversationImportCommit.dispatch")(
      function* (command: PortableConversationImportPlan) {
        const existing = yield* receipts.getByCommandId(command.commandId);
        if (Option.isSome(existing)) {
          if (
            existing.value.threadId !== command.threadId ||
            existing.value.commandType !== command.type
          )
            return yield* new ConversationImportCommitError({
              message: "The import command identity is already owned.",
            });
          if (existing.value.status === "rejected")
            return yield* new ConversationImportCommitError({
              message: existing.value.error ?? "The import was refused.",
            });
          return;
        }
        const project = yield* projects.get(command.projectId);
        const existingThread = yield* projections
          .getThread(command.threadId)
          .pipe(
            Effect.catchTags({ ProjectionStoreThreadNotFoundError: () => Effect.succeed(null) }),
          );
        if (Option.isNone(project) || existingThread !== null) {
          const message = Option.isNone(project)
            ? "The destination project no longer exists."
            : "The destination thread already exists.";
          yield* sink.commitRejectedCommand({
            commandId: command.commandId,
            threadId: command.threadId,
            commandType: command.type,
            rejectedAt: yield* DateTime.now,
            error: message,
          });
          return yield* new ConversationImportCommitError({ message });
        }
        const events = yield* Effect.try({
          try: () => conversationImportEvents(command),
          catch: (cause) =>
            isCommitError(cause)
              ? cause
              : new ConversationImportCommitError({
                  message: "The import history could not be prepared.",
                  cause,
                }),
        });
        yield* sink.commitCommand({
          commandId: command.commandId,
          threadId: command.threadId,
          commandType: command.type,
          acceptedAt: yield* DateTime.now,
          events,
          effects: [],
        });
      },
      Effect.mapError((cause) =>
        isCommitError(cause)
          ? cause
          : new ConversationImportCommitError({ message: "The import could not commit.", cause }),
      ),
    );
    return ConversationImportCommit.of({
      dispatch: (command) => executor.withLock(command.threadId, dispatch(command)),
    });
  }),
);
