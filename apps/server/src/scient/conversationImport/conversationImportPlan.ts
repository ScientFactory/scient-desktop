/**
 * Turns a validated conversation package into the one
 * `thread.conversation.import` command that creates its thread.
 *
 * Every id the command carries is new and local. The mapping from each
 * external record to its local id is minted once per attempt
 * (`mintConversationImportIds`), recorded in the attempt journal, and reused
 * on retry, so a resumed attempt dispatches exactly the same history.
 *
 * Turns: every message, reasoning item, plan, answer, and work-log entry of a
 * source turn lands in one new local turn. User messages are stored with no
 * turn (turn starts and mid-turn steering alike), so each one joins the turn
 * of the next message that names one: the turn it started, or the turn it
 * steered. A request never answered gets a turn of its own. Every such turn is
 * inherited history: revert keeps it, as it keeps a fork's inherited turns.
 */
import {
  ApprovalRequestId,
  CommandId,
  EventId,
  MessageId,
  ThreadId,
  TurnId,
  type ChatAttachment,
  type ConversationAttachment,
  type ConversationImportDestination,
  type ConversationWorkLogEntry,
  type OrchestrationCommand,
  type OrchestrationConversationImportOmission,
  type OrchestrationProposedPlan,
  type OrchestrationThreadActivity,
  type ThreadConversationImportTurn,
} from "@t3tools/contracts";
import { importedMessageMarkdown } from "@scientfactory/conversation";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { attachmentFileExtension, toSafeThreadAttachmentSegment } from "../../attachmentStore.ts";
import {
  conversationImportProvenance,
  type ValidatedConversationImport,
} from "./ConversationImporter.ts";

export type ThreadConversationImportCommand = Extract<
  OrchestrationCommand,
  { type: "thread.conversation.import" }
>;

/** The local id of every record an attempt writes, keyed by the external record it replaces. */
export const ConversationImportIds = Schema.Struct({
  threadId: ThreadId,
  commandId: CommandId,
  /** Transcript messages and reasoning, by external message id. */
  messages: Schema.Record(Schema.String, MessageId),
  /** By turn key (see `turnKey`). */
  turns: Schema.Record(Schema.String, TurnId),
  /** By package resource id. */
  attachments: Schema.Record(Schema.String, Schema.String),
  proposedPlans: Schema.Record(Schema.String, Schema.String),
  workLog: Schema.Record(Schema.String, EventId),
  questionAnswers: Schema.Record(
    Schema.String,
    Schema.Struct({ activityId: EventId, requestId: ApprovalRequestId }),
  ),
});
export type ConversationImportIds = typeof ConversationImportIds.Type;

/** Unambiguous turn keys: a source turn, or the record a turn was made for. */
const turnKey = {
  source: (turnId: string) => `turn:${turnId}`,
  message: (messageId: string) => `message:${messageId}`,
  reasoning: (reasoningId: string) => `reasoning:${reasoningId}`,
  question: (questionId: string) => `question:${questionId}`,
};

interface TurnAssignment {
  /** Turn key of each transcript message and reasoning item; null stays turnless. */
  readonly byMessageId: ReadonlyMap<string, string | null>;
  readonly byQuestionId: ReadonlyMap<string, string>;
  /** Every key, in first-appearance order. */
  readonly keys: ReadonlyArray<string>;
}

function assignTurns(input: ValidatedConversationImport): TurnAssignment {
  const { snapshot } = input;
  const keys: string[] = [];
  const seen = new Set<string>();
  const use = (key: string) => {
    if (!seen.has(key)) {
      seen.add(key);
      keys.push(key);
    }
    return key;
  };

  const byMessageId = new Map<string, string | null>();
  // The turn named next after each position, scanning from the end.
  const nextTurn: Array<string | null> = Array.from({ length: snapshot.messages.length });
  let upcoming: string | null = null;
  for (let index = snapshot.messages.length - 1; index >= 0; index -= 1) {
    const turnId = snapshot.messages[index]!.turnId;
    if (turnId !== null) upcoming = turnId;
    nextTurn[index] = upcoming;
  }
  for (const [index, message] of snapshot.messages.entries()) {
    if (message.turnId !== null) {
      byMessageId.set(message.id, use(turnKey.source(message.turnId)));
    } else if (message.role === "system") {
      byMessageId.set(message.id, null);
    } else {
      const next = nextTurn[index];
      byMessageId.set(
        message.id,
        use(
          next === null || next === undefined ? turnKey.message(message.id) : turnKey.source(next),
        ),
      );
    }
  }
  for (const reasoning of snapshot.reasoning) {
    byMessageId.set(
      reasoning.id,
      reasoning.turnId === null
        ? use(turnKey.reasoning(reasoning.id))
        : use(turnKey.source(reasoning.turnId)),
    );
  }

  // An answer belongs to a turn (a fork of the imported thread requires it):
  // its own, else the turn of the latest message before it.
  const byQuestionId = new Map<string, string>();
  for (const answer of snapshot.questionAnswers) {
    if (answer.turnId !== null) {
      byQuestionId.set(answer.id, use(turnKey.source(answer.turnId)));
      continue;
    }
    const preceding = snapshot.messages.findLast(
      (message) => message.createdAt <= answer.createdAt && byMessageId.get(message.id) != null,
    );
    byQuestionId.set(
      answer.id,
      preceding === undefined ? use(turnKey.question(answer.id)) : byMessageId.get(preceding.id)!,
    );
  }
  for (const record of [...snapshot.proposedPlans, ...snapshot.workLog]) {
    if (record.turnId !== null) use(turnKey.source(record.turnId));
  }
  return { byMessageId, byQuestionId, keys };
}

const uuid = Crypto.Crypto.pipe(Effect.flatMap((crypto) => crypto.randomUUIDv4));

function attachmentId(
  threadSegment: string,
  id: string,
  attachment: { readonly kind: string; readonly name: string },
) {
  // File ids carry their extension, as uploaded files do; images derive theirs from the media type.
  return attachment.kind === "file"
    ? `${threadSegment}-${id}-${attachmentFileExtension(attachment.name).slice(1)}`
    : `${threadSegment}-${id}`;
}

/** Fresh local ids for one attempt. */
export const mintConversationImportIds = Effect.fn("mintConversationImportIds")(function* (
  input: ValidatedConversationImport,
) {
  const threadId = ThreadId.make(yield* uuid);
  const threadSegment = toSafeThreadAttachmentSegment(threadId);
  if (threadSegment === null) return yield* Effect.die(new Error("Unsafe thread id."));
  const assignment = assignTurns(input);
  const questionAnswers: Record<string, { activityId: EventId; requestId: ApprovalRequestId }> =
    Object.create(null);
  for (const answer of input.snapshot.questionAnswers) {
    questionAnswers[answer.id] = {
      activityId: EventId.make(yield* uuid),
      requestId: ApprovalRequestId.make(yield* uuid),
    };
  }
  // External IDs are strings, including names such as "__proto__". Never use a
  // prototype-bearing object as a lookup table for untrusted package IDs.
  const messages: Record<string, MessageId> = Object.create(null);
  for (const record of [...input.snapshot.messages, ...input.snapshot.reasoning]) {
    const answeredRequestId =
      record.id.startsWith("async-answer:") && "role" in record && record.role === "user"
        ? record.id.slice("async-answer:".length)
        : null;
    const answerIds =
      answeredRequestId !== null && Object.hasOwn(questionAnswers, answeredRequestId)
        ? questionAnswers[answeredRequestId]
        : undefined;
    messages[record.id] =
      answerIds === undefined
        ? MessageId.make(yield* uuid)
        : MessageId.make(`async-answer:${answerIds.requestId}`);
  }
  const turns: Record<string, TurnId> = Object.create(null);
  for (const key of assignment.keys) turns[key] = TurnId.make(yield* uuid);
  const attachments: Record<string, string> = Object.create(null);
  for (const attachment of input.attachments) {
    attachments[attachment.resourceId] = attachmentId(threadSegment, yield* uuid, attachment);
  }
  const proposedPlans: Record<string, string> = Object.create(null);
  for (const plan of input.snapshot.proposedPlans) proposedPlans[plan.id] = `plan:${yield* uuid}`;
  const workLog: Record<string, EventId> = Object.create(null);
  for (const entry of input.snapshot.workLog) workLog[entry.id] = EventId.make(yield* uuid);
  return {
    threadId,
    commandId: CommandId.make(`server:conversation-import:${yield* uuid}`),
    messages,
    turns,
    attachments,
    proposedPlans,
    workLog,
    questionAnswers,
  } satisfies ConversationImportIds;
});

/** The ids leave nothing of this package unmapped (a journal written for this import). */
export function idsCoverImport(
  ids: ConversationImportIds,
  input: ValidatedConversationImport,
): boolean {
  const { snapshot } = input;
  const assignment = assignTurns(input);
  return (
    [...snapshot.messages, ...snapshot.reasoning].every((record) =>
      Object.hasOwn(ids.messages, record.id),
    ) &&
    assignment.keys.every((key) => Object.hasOwn(ids.turns, key)) &&
    input.attachments.every((attachment) =>
      Object.hasOwn(ids.attachments, attachment.resourceId),
    ) &&
    snapshot.proposedPlans.every((plan) => Object.hasOwn(ids.proposedPlans, plan.id)) &&
    snapshot.workLog.every((entry) => Object.hasOwn(ids.workLog, entry.id)) &&
    snapshot.questionAnswers.every((answer) => Object.hasOwn(ids.questionAnswers, answer.id))
  );
}

/** A published attachment: the staged resource and the chat attachment the history references. */
export interface PlannedConversationImportAttachment {
  readonly resourceId: string;
  readonly attachment: ChatAttachment;
}

function toChatAttachment(attachment: ConversationAttachment, id: string): ChatAttachment | null {
  switch (attachment.kind) {
    case "image":
      return {
        type: "image",
        id,
        name: attachment.name,
        mimeType: attachment.mimeType,
        sizeBytes: attachment.sizeBytes,
      };
    case "file":
      return {
        type: "file",
        id,
        name: attachment.name,
        mimeType: attachment.mimeType,
        sizeBytes: attachment.sizeBytes,
        ...(attachment.pastedText ? { source: { _tag: "pasted-text" as const } } : {}),
      };
    default:
      return null;
  }
}

/** Every attachment the history references, once per staged resource. */
export function plannedAttachments(
  input: ValidatedConversationImport,
  ids: ConversationImportIds,
): ReadonlyArray<PlannedConversationImportAttachment> {
  const byResource = new Map<string, ConversationAttachment>();
  for (const attachment of [
    ...input.snapshot.messages.flatMap((message) => message.attachments),
    ...input.snapshot.questionAnswers.flatMap((answer) =>
      answer.items.flatMap((item) => item.attachments),
    ),
  ]) {
    if (attachment.available && !byResource.has(attachment.localId)) {
      byResource.set(attachment.localId, attachment);
    }
  }
  return input.attachments.flatMap((staged) => {
    const described = byResource.get(staged.resourceId);
    const id = ids.attachments[staged.resourceId];
    const attachment =
      described === undefined || id === undefined ? null : toChatAttachment(described, id);
    return attachment === null ? [] : [{ resourceId: staged.resourceId, attachment }];
  });
}

const trimmedOr = (value: string, fallback: string) => {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : fallback;
};

function statusText(status: string | null): string | undefined {
  switch (status) {
    case null:
      return undefined;
    case "in-progress":
      return "inProgress";
    default:
      return status;
  }
}

/**
 * A work-log entry as a history activity, in the payload shape chat's work log
 * and the export projection read. It describes work done elsewhere and is
 * never executed.
 */
function workLogActivity(
  entry: ConversationWorkLogEntry,
  id: EventId,
  turnId: TurnId | null,
): OrchestrationThreadActivity {
  const base = { id, turnId, createdAt: entry.createdAt };
  switch (entry._tag) {
    case "tool":
      return {
        ...base,
        kind:
          entry.status === "declined"
            ? "tool.denied"
            : entry.status === "in-progress"
              ? "tool.updated"
              : "tool.completed",
        tone: entry.status === "failed" ? "error" : "tool",
        summary: trimmedOr(entry.title, "Tool call"),
        payload: {
          title: entry.title,
          ...(entry.itemType === null ? {} : { itemType: entry.itemType }),
          ...(statusText(entry.status) === undefined ? {} : { status: statusText(entry.status) }),
          ...(entry.detail === null ? {} : { detail: entry.detail.text }),
          data: {
            ...(entry.toolName === null ? {} : { toolName: entry.toolName }),
            item: {
              ...(entry.command === null ? {} : { command: entry.command.text }),
              ...(entry.output === null ? {} : { aggregatedOutput: entry.output.text }),
              ...(entry.changedFiles.length === 0
                ? {}
                : { changes: entry.changedFiles.map((path) => ({ path })) }),
            },
          },
        },
      };
    case "task":
      return {
        ...base,
        kind: entry.status === "in-progress" ? "task.progress" : "task.completed",
        tone: entry.status === "failed" ? "error" : "info",
        summary: trimmedOr(entry.title, "Task"),
        payload: {
          taskId: id,
          summary: entry.title,
          ...(entry.status === null ? {} : { status: entry.status }),
          ...(entry.agentRole === null ? {} : { role: entry.agentRole }),
          ...(entry.detail === null ? {} : { detail: entry.detail.text }),
        },
      };
    case "notice":
      return {
        ...base,
        kind: entry.level === "error" ? "runtime.error" : "runtime.warning",
        tone: entry.level === "error" ? "error" : "info",
        summary: trimmedOr(entry.title, "Notice"),
        payload: { message: entry.detail?.text ?? entry.title },
      };
    case "compaction":
      return {
        ...base,
        kind: "context-compaction",
        tone: "info",
        summary: trimmedOr(entry.title, "Context compacted"),
        payload: {},
      };
    case "plan-steps":
      return {
        ...base,
        kind: "turn.plan.updated",
        tone: "info",
        summary: "Plan updated",
        payload: {
          ...(entry.explanation === null ? {} : { explanation: entry.explanation.text }),
          plan: entry.steps.map((step) => ({
            step: step.step,
            status: step.status === "in-progress" ? "inProgress" : step.status,
          })),
        },
      };
  }
}

/** The import banner's omissions: what the sender's file did not carry. */
function importOmissions(
  input: ValidatedConversationImport,
  skippedRecords: number,
): ReadonlyArray<OrchestrationConversationImportOmission> {
  const omissions: OrchestrationConversationImportOmission[] = [];
  let unavailableAttachments = 0;
  let skipped = skippedRecords;
  for (const omission of input.omissions) {
    switch (omission._tag) {
      case "work-log-excluded":
      case "reasoning-excluded":
      case "range-truncated":
        omissions.push(omission);
        break;
      case "snapshot-warning":
        switch (omission.warning._tag) {
          case "running-turn-omitted":
            omissions.push({ _tag: "running-turn-omitted" });
            break;
          case "attachment-unavailable":
          case "attachment-unsupported":
            unavailableAttachments += 1;
            break;
          case "records-skipped":
            skipped += omission.warning.count;
            break;
        }
        break;
    }
  }
  if (unavailableAttachments > 0) {
    omissions.push({ _tag: "attachments-unavailable", count: unavailableAttachments });
  }
  if (skipped > 0) omissions.push({ _tag: "records-skipped", count: skipped });
  // A transfer can itself have been made from a partial imported history.
  // Keep those earlier gaps, even when this sender selected every local item.
  const sourceOmissions =
    input.snapshot.provenance._tag === "import" ? (input.snapshot.provenance.omissions ?? []) : [];
  const byKind = new Map<string, OrchestrationConversationImportOmission>();
  for (const omission of [...sourceOmissions, ...omissions]) {
    const previous = byKind.get(omission._tag);
    if (previous?._tag === "range-truncated" && omission._tag === "range-truncated") {
      byKind.set(omission._tag, {
        _tag: "range-truncated",
        throughMessageN: Math.min(previous.throughMessageN, omission.throughMessageN),
      });
    } else if (
      previous?._tag === "attachments-unavailable" &&
      omission._tag === "attachments-unavailable"
    ) {
      byKind.set(omission._tag, {
        _tag: "attachments-unavailable",
        count: Math.max(previous.count, omission.count),
      });
    } else if (previous?._tag === "records-skipped" && omission._tag === "records-skipped") {
      byKind.set(omission._tag, {
        _tag: "records-skipped",
        count: Math.max(previous.count, omission.count),
      });
    } else if (previous === undefined) {
      byKind.set(omission._tag, omission);
    }
  }
  return [...byKind.values()];
}

/**
 * The import command for one attempt. Pure: the same package, ids, and
 * destination always give the same command.
 */
export function buildConversationImportCommand(input: {
  readonly validated: ValidatedConversationImport;
  readonly ids: ConversationImportIds;
  readonly destination: ConversationImportDestination;
  /** When the attempt began; recorded in the journal and reused on retry. */
  readonly importedAt: string;
}): ThreadConversationImportCommand {
  const { validated, ids, destination, importedAt } = input;
  const { snapshot } = validated;
  const assignment = assignTurns(validated);
  const localTurn = (key: string | null | undefined): TurnId | null =>
    key === null || key === undefined ? null : (ids.turns[key] ?? null);
  const sourceTurn = (turnId: string | null) =>
    localTurn(turnId === null ? null : turnKey.source(turnId));
  const attachmentByResource = new Map(
    plannedAttachments(validated, ids).map(({ resourceId, attachment }) => [
      resourceId,
      attachment,
    ]),
  );
  const chatAttachments = (attachments: ReadonlyArray<ConversationAttachment>) =>
    attachments.flatMap((attachment) => {
      const published = attachment.available
        ? attachmentByResource.get(attachment.localId)
        : undefined;
      return published === undefined ? [] : [published];
    });

  type PlannedMessage = ThreadConversationImportCommand["messages"][number];
  const timeline: Array<{ readonly order: number; readonly message: PlannedMessage }> = [];
  for (const message of snapshot.messages) {
    const attachments = chatAttachments(message.attachments);
    timeline.push({
      order: timeline.length,
      message: {
        messageId: ids.messages[message.id]!,
        role: message.role,
        text: importedMessageMarkdown(message),
        ...(attachments.length > 0 ? { attachments } : {}),
        turnId: localTurn(assignment.byMessageId.get(message.id)),
        createdAt: message.createdAt,
        updatedAt: message.updatedAt,
      },
    });
  }
  for (const reasoning of snapshot.reasoning) {
    timeline.push({
      order: timeline.length,
      message: {
        messageId: ids.messages[reasoning.id]!,
        role: "reasoning",
        text: reasoning.text,
        turnId: localTurn(assignment.byMessageId.get(reasoning.id)),
        createdAt: reasoning.createdAt,
        updatedAt: reasoning.updatedAt,
      },
    });
  }
  const messages = timeline
    .toSorted(
      (left, right) =>
        left.message.createdAt.localeCompare(right.message.createdAt) || left.order - right.order,
    )
    .map(({ message }) => message);

  let skippedRecords = 0;
  const proposedPlans: OrchestrationProposedPlan[] = [];
  for (const plan of snapshot.proposedPlans) {
    const markdown = plan.markdown.trim();
    if (markdown.length === 0) {
      skippedRecords += 1;
      continue;
    }
    proposedPlans.push({
      id: ids.proposedPlans[plan.id]!,
      turnId: sourceTurn(plan.turnId),
      planMarkdown: markdown,
      implementedAt: plan.implemented ? plan.updatedAt : null,
      implementationThreadId: null,
      createdAt: plan.createdAt,
      updatedAt: plan.updatedAt,
    });
  }

  const activities: OrchestrationThreadActivity[] = [];
  for (const answer of snapshot.questionAnswers) {
    const answerIds = ids.questionAnswers[answer.id]!;
    const questionTextById: Record<string, string> = {};
    const answers: Record<string, string> = {};
    const attachmentsByQuestionId: Record<string, ReadonlyArray<ChatAttachment>> = {};
    for (const [index, item] of answer.items.entries()) {
      const questionId = `question-${index + 1}`;
      if (item.question !== null) questionTextById[questionId] = item.question;
      answers[questionId] = item.answer;
      attachmentsByQuestionId[questionId] = chatAttachments(item.attachments);
    }
    const names = Object.values(attachmentsByQuestionId)
      .flat()
      .map((attachment) => attachment.name);
    activities.push({
      id: answerIds.activityId,
      tone: "info",
      kind: "user-input.answer-submitted",
      summary: "Question answer submitted",
      turnId: localTurn(assignment.byQuestionId.get(answer.id)),
      createdAt: answer.createdAt,
      payload: {
        requestId: answerIds.requestId,
        answers,
        questionTextById,
        attachmentsByQuestionId,
        ...(names.length > 0 ? { detail: names.join("\n") } : {}),
      },
    });
  }
  for (const entry of snapshot.workLog) {
    activities.push(workLogActivity(entry, ids.workLog[entry.id]!, sourceTurn(entry.turnId)));
  }
  activities.sort(
    (left, right) =>
      left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
  );

  // Turns with a response become completed turn rows, named by their request.
  const turnRecords = new Map<
    TurnId,
    {
      user: MessageId | null;
      assistant: MessageId | null;
      requestedAt: string;
      completedAt: string;
    }
  >();
  for (const message of messages) {
    if (message.turnId === null) continue;
    const record = turnRecords.get(message.turnId) ?? {
      user: null,
      assistant: null,
      requestedAt: message.createdAt,
      completedAt: message.updatedAt,
    };
    if (message.role === "user" && record.user === null) record.user = message.messageId;
    if (message.role === "assistant") record.assistant = message.messageId;
    if (message.createdAt < record.requestedAt) record.requestedAt = message.createdAt;
    if (message.updatedAt > record.completedAt) record.completedAt = message.updatedAt;
    turnRecords.set(message.turnId, record);
  }
  const turns: ThreadConversationImportTurn[] = [...turnRecords]
    .filter(([, record]) => record.assistant !== null)
    .map(([turnId, record]) => ({
      turnId,
      userMessageId: record.user,
      assistantMessageId: record.assistant,
      requestedAt: record.requestedAt,
      completedAt: record.completedAt,
    }))
    .toSorted(
      (left, right) =>
        left.requestedAt.localeCompare(right.requestedAt) ||
        left.turnId.localeCompare(right.turnId),
    );

  const { _tag: _provenance, ...provenance } = conversationImportProvenance(
    validated.package,
    importedAt,
  );
  return {
    type: "thread.conversation.import",
    commandId: ids.commandId,
    threadId: ids.threadId,
    projectId: destination.projectId,
    title: snapshot.thread.title,
    modelSelection: destination.modelSelection,
    runtimeMode: destination.runtimeMode,
    interactionMode: destination.interactionMode,
    messages,
    proposedPlans,
    activities,
    inheritedTurnIds: assignment.keys.flatMap((key) => {
      const turnId = ids.turns[key];
      return turnId === undefined ? [] : [turnId];
    }),
    turns,
    origin: { ...provenance, omissions: importOmissions(validated, skippedRecords) },
    createdAt: importedAt,
  };
}
