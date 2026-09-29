/**
 * Turns a validated conversation package into the one
 * `thread.conversation.import` command that creates its thread.
 *
 * Every id the command carries is new and local. The mapping from each
 * external record to its local id is minted once per attempt
 * (`mintConversationImportIds`), recorded in the attempt journal, and reused
 * on retry, so a resumed attempt dispatches exactly the same history.
 *
 * Order: records keep their source timestamps, and history is read back by
 * timestamp, then id. So the ids of messages, reasoning, activities, plans,
 * and turns sort in source order: one random prefix per attempt, then a
 * zero-padded number in history order (`orderedIds`).
 *
 * Turns: every message, reasoning item, plan, answer, and work-log entry of a
 * source turn lands in one new local turn. User messages are stored with no
 * turn (turn starts and mid-turn steering alike), so each one joins the turn
 * of the next record that names one: the turn it started, or the turn it
 * steered, even when that turn has no reply. A request followed by no turn at
 * all gets a turn of its own. Every such turn is inherited history: revert
 * keeps it, as it keeps a fork's inherited turns.
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
  type ConversationQuestionAnswer,
  type ConversationWorkLogEntry,
  type OrchestrationCommand,
  type OrchestrationConversationImportOmission,
  type OrchestrationProposedPlan,
  type OrchestrationThreadActivity,
  type ThreadConversationImportTurn,
} from "@t3tools/contracts";
import { importedMessageMarkdown, importedWorkLogOmissions } from "@scientfactory/conversation";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { attachmentFileExtension, toSafeThreadAttachmentSegment } from "../../attachmentStore.ts";
import {
  CONVERSATION_IMPORT_RUNTIME_MODE,
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
  // The next message naming a turn after each position, scanning from the end.
  const nextNamed: Array<{ readonly turnId: string; readonly createdAt: string } | null> =
    Array.from({ length: snapshot.messages.length }, () => null);
  let upcoming: { readonly turnId: string; readonly createdAt: string } | null = null;
  for (let index = snapshot.messages.length - 1; index >= 0; index -= 1) {
    const message = snapshot.messages[index]!;
    if (message.turnId !== null)
      upcoming = { turnId: message.turnId, createdAt: message.createdAt };
    nextNamed[index] = upcoming;
  }
  // Other records that name a turn, by time: a turn with no reply still has
  // its reasoning, work log, plans, or answers.
  const marks = [
    ...snapshot.reasoning,
    ...snapshot.workLog,
    ...snapshot.proposedPlans,
    ...snapshot.questionAnswers,
  ]
    .flatMap((record) =>
      record.turnId === null ? [] : [{ turnId: record.turnId, createdAt: record.createdAt }],
    )
    .toSorted((left, right) => left.createdAt.localeCompare(right.createdAt));
  const firstMarkFrom = (createdAt: string) => {
    let low = 0;
    let high = marks.length;
    while (low < high) {
      const middle = low + Math.floor((high - low) / 2);
      if (marks[middle]!.createdAt < createdAt) low = middle + 1;
      else high = middle;
    }
    return marks[low];
  };
  for (const [index, message] of snapshot.messages.entries()) {
    if (message.turnId !== null) {
      byMessageId.set(message.id, use(turnKey.source(message.turnId)));
    } else if (message.role === "system") {
      byMessageId.set(message.id, null);
    } else {
      const named = nextNamed[index] ?? null;
      const mark = firstMarkFrom(message.createdAt);
      const next =
        mark !== undefined && (named === null || mark.createdAt < named.createdAt)
          ? mark.turnId
          : (named?.turnId ?? null);
      byMessageId.set(
        message.id,
        use(next === null ? turnKey.message(message.id) : turnKey.source(next)),
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

/**
 * Records in history order: by timestamp, then as listed. The sort is stable,
 * so records that share a timestamp keep their source order.
 */
function inHistoryOrder<T extends { readonly createdAt: string }>(
  records: ReadonlyArray<T>,
): ReadonlyArray<T> {
  return records.toSorted((left, right) => left.createdAt.localeCompare(right.createdAt));
}

/** Transcript messages and reasoning, in the order the import command writes them. */
function transcriptOrder({ snapshot }: ValidatedConversationImport) {
  return inHistoryOrder([
    ...snapshot.messages.map((message) => ({
      kind: "message" as const,
      id: message.id,
      message,
      createdAt: message.createdAt,
    })),
    ...snapshot.reasoning.map((reasoning) => ({
      kind: "reasoning" as const,
      id: reasoning.id,
      reasoning,
      createdAt: reasoning.createdAt,
    })),
  ]);
}

/** Answers and work-log entries, in the order the import command writes them as activities. */
function activityOrder({ snapshot }: ValidatedConversationImport) {
  return inHistoryOrder([
    ...snapshot.questionAnswers.map((answer) => ({
      kind: "answer" as const,
      answer,
      createdAt: answer.createdAt,
    })),
    ...snapshot.workLog.map((entry) => ({
      kind: "work-log" as const,
      entry,
      createdAt: entry.createdAt,
    })),
  ]);
}

/**
 * The external ID of the message each answer folds, by answer ID. A file names
 * a folded answer's user message `async-answer:<answer id>`, as Scient names a
 * live one; the imported answer names that message's local ID instead.
 */
function foldedAnswerMessages({ snapshot }: ValidatedConversationImport): Map<string, string> {
  const answerIds = new Set(snapshot.questionAnswers.map((answer) => answer.id));
  const folded = new Map<string, string>();
  for (const message of snapshot.messages) {
    if (message.role !== "user" || !message.id.startsWith("async-answer:")) continue;
    const answerId = message.id.slice("async-answer:".length);
    if (answerIds.has(answerId) && !folded.has(answerId)) folded.set(answerId, message.id);
  }
  return folded;
}

/**
 * Ids that sort in the order they are minted: `imp-<attempt uuid>-<number>`,
 * the number zero-padded to one width for the whole attempt. Unique across
 * every kind of record, so no two tables share an id.
 */
const orderedIds = Effect.fn("orderedIds")(function* (count: number) {
  const prefix = `imp-${yield* uuid}`;
  const width = Math.max(6, String(count).length);
  let next = 0;
  return () => `${prefix}-${String(next++).padStart(width, "0")}`;
});

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
  const { snapshot } = input;
  const threadId = ThreadId.make(yield* uuid);
  const threadSegment = toSafeThreadAttachmentSegment(threadId);
  if (threadSegment === null) return yield* Effect.die(new Error("Unsafe thread id."));
  const assignment = assignTurns(input);
  const transcript = transcriptOrder(input);
  const activities = activityOrder(input);
  const answers = inHistoryOrder(snapshot.questionAnswers);
  const plans = inHistoryOrder(snapshot.proposedPlans);
  const nextId = yield* orderedIds(
    transcript.length + activities.length + answers.length + plans.length + assignment.keys.length,
  );

  // External IDs are strings, including names such as "__proto__". Never use a
  // prototype-bearing object as a lookup table for untrusted package IDs.
  const activityIds: Record<string, EventId> = Object.create(null);
  const workLog: Record<string, EventId> = Object.create(null);
  for (const activity of activities) {
    const id = EventId.make(nextId());
    if (activity.kind === "answer") activityIds[activity.answer.id] = id;
    else workLog[activity.entry.id] = id;
  }
  const questionAnswers: Record<string, { activityId: EventId; requestId: ApprovalRequestId }> =
    Object.create(null);
  for (const answer of answers) {
    questionAnswers[answer.id] = {
      activityId: activityIds[answer.id]!,
      requestId: ApprovalRequestId.make(nextId()),
    };
  }
  // Every message, a folded answer's too, sorts in source order; the answer
  // names its message (`foldedAnswerMessages`).
  const messages: Record<string, MessageId> = Object.create(null);
  for (const record of transcript) messages[record.id] = MessageId.make(nextId());
  const turns: Record<string, TurnId> = Object.create(null);
  for (const key of assignment.keys) turns[key] = TurnId.make(nextId());
  const proposedPlans: Record<string, string> = Object.create(null);
  for (const plan of plans) proposedPlans[plan.id] = `plan:${nextId()}`;
  const attachments: Record<string, string> = Object.create(null);
  for (const attachment of input.attachments) {
    attachments[attachment.resourceId] = attachmentId(threadSegment, yield* uuid, attachment);
  }
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
  // What the sender left out, so a re-export says so again.
  const omissions = importedWorkLogOmissions(entry);
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
          ...omissions,
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
          ...omissions,
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
        payload: { message: entry.detail?.text ?? entry.title, ...omissions },
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
          ...omissions,
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
  // Each unavailable attachment once, although an answer and its folded
  // message both list it (and so both carry a warning for it).
  const unavailableAttachments = new Set(
    [
      ...input.snapshot.messages.flatMap((message) => message.attachments),
      ...input.snapshot.questionAnswers.flatMap((answer) =>
        answer.items.flatMap((item) => item.attachments),
      ),
    ]
      .filter((attachment) => !attachment.available)
      .map((attachment) => attachment.localId),
  ).size;
  let skipped = skippedRecords + (input.skippedSourceRecords ?? 0);
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
            // Counted from the attachments themselves, above.
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
    input.snapshot.provenance._tag === "import"
      ? (input.snapshot.provenance.omissions ?? [])
      : input.snapshot.provenance._tag === "fork"
        ? (input.snapshot.provenance.sourceImport?.omissions ?? [])
        : [];
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
      // An earlier transfer's gaps and this file's are different records.
      byKind.set(omission._tag, {
        _tag: "attachments-unavailable",
        count: previous.count + omission.count,
      });
    } else if (previous?._tag === "records-skipped" && omission._tag === "records-skipped") {
      byKind.set(omission._tag, {
        _tag: "records-skipped",
        count: previous.count + omission.count,
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

  const messages: ThreadConversationImportCommand["messages"] = transcriptOrder(validated).map(
    (record) => {
      if (record.kind === "reasoning") {
        const { reasoning } = record;
        return {
          messageId: ids.messages[reasoning.id]!,
          role: "reasoning",
          text: reasoning.text,
          turnId: localTurn(assignment.byMessageId.get(reasoning.id)),
          createdAt: reasoning.createdAt,
          updatedAt: reasoning.updatedAt,
        };
      }
      const { message } = record;
      const attachments = chatAttachments(message.attachments);
      return {
        messageId: ids.messages[message.id]!,
        role: message.role,
        text: importedMessageMarkdown(message),
        ...(attachments.length > 0 ? { attachments } : {}),
        turnId: localTurn(assignment.byMessageId.get(message.id)),
        createdAt: message.createdAt,
        updatedAt: message.updatedAt,
      };
    },
  );

  let skippedRecords = 0;
  const proposedPlans: OrchestrationProposedPlan[] = [];
  for (const plan of inHistoryOrder(snapshot.proposedPlans)) {
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

  const foldedMessages = foldedAnswerMessages(validated);
  const answerActivity = (answer: ConversationQuestionAnswer): OrchestrationThreadActivity => {
    const answerIds = ids.questionAnswers[answer.id]!;
    const foldedMessage = foldedMessages.get(answer.id);
    const messageId = foldedMessage === undefined ? undefined : ids.messages[foldedMessage];
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
    return {
      id: answerIds.activityId,
      tone: "info",
      kind: "user-input.answer-submitted",
      summary: "Question answer submitted",
      turnId: localTurn(assignment.byQuestionId.get(answer.id)),
      createdAt: answer.createdAt,
      payload: {
        requestId: answerIds.requestId,
        ...(messageId === undefined ? {} : { messageId }),
        answers,
        questionTextById,
        attachmentsByQuestionId,
        ...(names.length > 0 ? { detail: names.join("\n") } : {}),
      },
    };
  };
  const activities = activityOrder(validated).map((record) =>
    record.kind === "answer"
      ? answerActivity(record.answer)
      : workLogActivity(
          record.entry,
          ids.workLog[record.entry.id]!,
          sourceTurn(record.entry.turnId),
        ),
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
    runtimeMode: CONVERSATION_IMPORT_RUNTIME_MODE,
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
