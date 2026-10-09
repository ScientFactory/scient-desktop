/**
 * Builds a `ConversationSnapshotV1` from one consistent read of a thread's
 * durable projections. Pure: the caller performs the read, checks attachment
 * availability, and hashes the canonical content.
 */
import {
  CONVERSATION_SNAPSHOT_FORMAT,
  ChatAttachment,
  type ProviderCitationPresentation,
  type ConversationAttachment,
  type ConversationMessage,
  type ConversationSnapshotSelection,
  type ConversationSnapshotV1,
  type ConversationSnapshotWarning,
  MessageId,
  type OrchestrationMessage,
  type OrchestrationThread,
  type OrchestrationThreadActivity,
  type TurnId,
} from "@t3tools/contracts";
import { htmlRenderFromToolItem, mcpAppFromToolItem } from "@t3tools/shared/toolOutput";
import * as Data from "effect/Data";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";

import { projectInlineReferences } from "./inlineReferences.ts";
import { deriveUnsettledTurnId } from "./workLogGrouping.ts";
import { projectQuestionAnswers, projectWorkLog } from "./workLogProjection.ts";

export type ConversationSnapshotContent = Omit<ConversationSnapshotV1, "contentDigest">;

/** A read-only snapshot source; no execution engine or provider authority is required. */
export type ConversationSnapshotThread = Pick<
  OrchestrationThread,
  | "id"
  | "title"
  | "createdAt"
  | "updatedAt"
  | "workspaceRoot"
  | "worktreePath"
  | "modelSelection"
  | "activities"
  | "proposedPlans"
  | "forkLineage"
  | "conversationImport"
> & {
  readonly messages: ReadonlyArray<
    OrchestrationMessage & { readonly citationPresentation?: ProviderCitationPresentation }
  >;
  readonly latestTurn?: OrchestrationThread["latestTurn"];
  readonly session?: OrchestrationThread["session"];
  readonly activeTurn?: { readonly turnId: TurnId; readonly requestedAt: string } | null;
  readonly providerName?: string | null;
};

/** The range's last message is not a completed user or assistant message of the thread. */
export class SnapshotRangeError extends Data.TaggedError("SnapshotRangeError")<{
  readonly messageId: MessageId;
}> {}

function toAttachment(
  attachment: ChatAttachment,
  isAvailable: (attachment: ChatAttachment) => boolean,
): ConversationAttachment {
  return {
    localId: attachment.id,
    kind: attachment.type === "image" ? "image" : attachment.type === "file" ? "file" : "other",
    name: attachment.name,
    mimeType: attachment.mimeType,
    sizeBytes: attachment.sizeBytes,
    pastedText:
      attachment.type === "file" &&
      "source" in attachment &&
      attachment.source?._tag === "pasted-text",
    available: isAvailable(attachment),
  };
}

function isChatAttachment(value: unknown): value is ChatAttachment {
  return (
    Predicate.isObject(value) &&
    Predicate.isString((value as Record<string, unknown>).id) &&
    Predicate.isString((value as Record<string, unknown>).name) &&
    Predicate.isString((value as Record<string, unknown>).mimeType) &&
    Predicate.isNumber((value as Record<string, unknown>).sizeBytes) &&
    Predicate.isString((value as Record<string, unknown>).type)
  );
}

/**
 * The turn that is still in progress, if any: the session's active turn while
 * it runs, otherwise a latest turn that has not recorded its completion.
 */
export function runningTurnId(thread: ConversationSnapshotThread): TurnId | null {
  if (thread.activeTurn !== undefined) return thread.activeTurn?.turnId ?? null;
  const sessionTurn =
    thread.session?.status === "running" ? (thread.session.activeTurnId ?? null) : null;
  return deriveUnsettledTurnId(thread.latestTurn ?? null, sessionTurn);
}

/**
 * The part of a thread an export covers, before projection: the settled
 * messages (reasoning included) through the range's last message, and the
 * activities and plans recorded before it. Every format is built from this
 * selection, so a range bounds all of them alike.
 */
export interface SelectedConversationContent {
  readonly runningTurnId: TurnId | null;
  readonly messages: ConversationSnapshotThread["messages"];
  readonly activities: ReadonlyArray<OrchestrationThreadActivity>;
  readonly proposedPlans: OrchestrationThread["proposedPlans"];
}

/**
 * Applies the running-turn cutoff and the range. "Up to a message" ends at
 * exactly that message: later messages are left out, and so are activities,
 * plans, and answers recorded after it, including later items of the turn it
 * belongs to or interrupted. Throws `SnapshotRangeError` when the range's last
 * message is not a completed user or assistant message.
 *
 * Known limitation, and why the server refuses ranges for now: records are
 * cut by creation time, so a plan, reasoning block, or message created before
 * the chosen message and updated after it keeps its later content.
 */
export function selectConversationContent(
  thread: ConversationSnapshotThread,
  throughMessageId: MessageId | null,
): SelectedConversationContent {
  // The running turn and everything from its prompt on are left out.
  const running = runningTurnId(thread);
  let cutoff: string | null = null;
  if (running !== null) {
    const starts = [
      ...(thread.activeTurn?.turnId === running ? [thread.activeTurn.requestedAt] : []),
      ...(thread.latestTurn?.turnId === running ? [thread.latestTurn.requestedAt] : []),
      ...thread.messages.filter((message) => message.turnId === running).map((m) => m.createdAt),
      ...thread.activities
        .filter((activity) => activity.turnId === running)
        .map((a) => a.createdAt),
    ].toSorted();
    cutoff = starts[0] ?? null;
    // The prompt that started the running turn goes with it, unless a settled
    // response already answered it (a steer or a restarted turn).
    const start = cutoff;
    const prompt =
      start === null
        ? undefined
        : thread.messages.findLast(
            (message) => message.role === "user" && message.createdAt <= start,
          );
    if (
      prompt &&
      start !== null &&
      !thread.messages.some(
        (message) =>
          message.role !== "user" &&
          message.turnId !== running &&
          message.createdAt > prompt.createdAt &&
          message.createdAt < start,
      )
    ) {
      cutoff = prompt.createdAt;
    }
  }
  const settled = <A extends { readonly turnId: TurnId | null; readonly createdAt: string }>(
    item: A,
  ) =>
    running === null || (item.turnId !== running && (cutoff === null || item.createdAt < cutoff));

  // As in chat, a message of a settled turn is complete even when a crashed
  // provider left its streaming flag set; only the running turn is left out.
  const completedMessages = thread.messages.filter(settled);

  let messages = completedMessages;
  let rangeEnd: string | null = null;
  if (throughMessageId !== null) {
    const index = completedMessages.findIndex(
      (message) =>
        message.id === throughMessageId &&
        (message.role === "user" || message.role === "assistant"),
    );
    if (index < 0) throw new SnapshotRangeError({ messageId: throughMessageId });
    messages = completedMessages.slice(0, index + 1);
    rangeEnd = completedMessages[index]!.createdAt;
  }
  // Records at the selected message's own time are written after it, so they
  // are after it too.
  const inRange = <A extends { readonly createdAt: string }>(item: A) =>
    rangeEnd === null || item.createdAt < rangeEnd;

  return {
    runningTurnId: running,
    messages,
    activities: thread.activities.filter((activity) => settled(activity) && inRange(activity)),
    proposedPlans: thread.proposedPlans.filter((plan) => settled(plan) && inRange(plan)),
  };
}

const isRecordedAttachment = Schema.is(ChatAttachment);

/**
 * Every attachment the selected content can export: those of its messages and
 * those recorded with its submitted answers. Attachments outside the selection
 * are never inspected, read, or counted.
 */
export function selectedConversationAttachments(
  content: SelectedConversationContent,
): ReadonlyArray<ChatAttachment> {
  const answerAttachments = content.activities.flatMap((activity) => {
    if (activity.kind !== "user-input.answer-submitted") return [];
    const byQuestion = Predicate.isObject(activity.payload)
      ? (activity.payload as { readonly attachmentsByQuestionId?: unknown }).attachmentsByQuestionId
      : undefined;
    if (!Predicate.isObject(byQuestion)) return [];
    return Object.values(byQuestion).flatMap((value: unknown) =>
      Array.isArray(value) ? value.filter(isRecordedAttachment) : [],
    );
  });
  return [
    ...content.messages.flatMap((message) => message.attachments ?? []),
    ...answerAttachments,
  ];
}

/**
 * Local IDs of messages that imported answers fold, mapped to the ID a file
 * gives them: `async-answer:<request id>`, as Scient names a live answer's
 * message. Imported history names the folded message on its answer instead,
 * because its local ID sorts in source order.
 */
function foldedAnswerMessageIds(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): ReadonlyMap<string, MessageId> {
  const folded = new Map<string, MessageId>();
  for (const activity of activities) {
    if (activity.kind !== "user-input.answer-submitted" || !Predicate.isObject(activity.payload))
      continue;
    const { messageId, requestId } = activity.payload as {
      readonly messageId?: unknown;
      readonly requestId?: unknown;
    };
    if (typeof messageId === "string" && typeof requestId === "string" && requestId.length > 0) {
      folded.set(messageId, MessageId.make(`async-answer:${requestId}`));
    }
  }
  return folded;
}

export function buildConversationSnapshot(input: {
  readonly thread: ConversationSnapshotThread;
  readonly snapshotSequence: number;
  readonly threadSequence: number;
  readonly capturedAt: string;
  readonly selection: ConversationSnapshotSelection;
  readonly isAttachmentAvailable: (attachment: ChatAttachment) => boolean;
  /** The selection already computed for this thread and range, if the caller has it. */
  readonly content?: SelectedConversationContent;
}): ConversationSnapshotContent {
  const { thread, selection } = input;
  const warnings: ConversationSnapshotWarning[] = [];
  const roots = [thread.worktreePath, thread.workspaceRoot].filter(
    (root): root is string => typeof root === "string" && root.length > 0,
  );

  const content = input.content ?? selectConversationContent(thread, selection.throughMessageId);
  const running = content.runningTurnId;
  if (running !== null) warnings.push({ _tag: "running-turn-omitted", turnId: running });
  const transcript = content.messages;
  const activities = content.activities;
  const omittedRenders = activities.filter((activity) => {
    if (activity.kind !== "tool.completed" || !Predicate.isObject(activity.payload)) return false;
    const payload = activity.payload;
    if (payload.status !== "completed" || !Predicate.isObject(payload.data)) return false;
    const data = payload.data;
    if (typeof data.toolName !== "string" || !Predicate.isObject(data.item)) return false;
    const item = { toolName: data.toolName, output: data.item.aggregatedOutput };
    return htmlRenderFromToolItem(item) !== undefined || mcpAppFromToolItem(item) !== undefined;
  }).length;
  if (omittedRenders > 0)
    warnings.push({ _tag: "records-skipped", kind: "rendered-output", count: omittedRenders });
  let skippedContext = 0;
  const foldedIds = foldedAnswerMessageIds(activities);
  const messages: ConversationMessage[] = [];
  for (const message of transcript) {
    if (message.role === "reasoning") continue;
    const attachments = (message.attachments ?? []).map((attachment) =>
      toAttachment(attachment, input.isAttachmentAvailable),
    );
    const n = messages.length + 1;
    const projected = projectInlineReferences({
      text: message.text,
      records: message.context?.records ?? [],
      attachments,
      roots,
    });
    skippedContext += projected.skipped;
    // One warning per unavailable attachment, naming it and its message; none for
    // available ones. Importers check these warnings against the facts.
    for (const attachment of attachments) {
      if (!attachment.available)
        warnings.push({ _tag: "attachment-unavailable", name: attachment.name, messageN: n });
    }
    messages.push({
      n,
      id: (message.role === "user" ? foldedIds.get(message.id) : undefined) ?? message.id,
      role: message.role,
      turnId: message.turnId,
      createdAt: message.createdAt,
      updatedAt: message.updatedAt,
      text: projected.text,
      ...(message.role === "assistant" && message.citationPresentation !== undefined
        ? { citationPresentation: message.citationPresentation }
        : {}),
      attachments,
      references: projected.references,
    });
  }

  const reasoning = selection.reasoning
    ? transcript
        .filter((message) => message.role === "reasoning" && message.text.trim().length > 0)
        .map((message) => ({
          id: message.id,
          turnId: message.turnId,
          createdAt: message.createdAt,
          updatedAt: message.updatedAt,
          text: message.text,
        }))
    : [];

  const workLog = selection.workLog ? projectWorkLog(activities) : { entries: [], skipped: 0 };
  const questions = projectQuestionAnswers(activities, (value) =>
    isChatAttachment(value) ? toAttachment(value, input.isAttachmentAvailable) : null,
  );
  for (const answer of questions.questionAnswers) {
    for (const item of answer.items) {
      for (const attachment of item.attachments) {
        if (!attachment.available)
          warnings.push({ _tag: "attachment-unavailable", name: attachment.name, messageN: null });
      }
    }
  }
  if (workLog.skipped > 0)
    warnings.push({ _tag: "records-skipped", kind: "activity", count: workLog.skipped });
  if (questions.skipped > 0)
    warnings.push({ _tag: "records-skipped", kind: "question-answer", count: questions.skipped });
  if (skippedContext > 0)
    warnings.push({ _tag: "records-skipped", kind: "context", count: skippedContext });

  return {
    format: CONVERSATION_SNAPSHOT_FORMAT,
    version: 1,
    thread: {
      title: thread.title,
      createdAt: thread.createdAt,
      updatedAt: thread.updatedAt,
      provider: thread.providerName ?? thread.session?.providerName ?? null,
      model: thread.modelSelection.model,
    },
    provenance: thread.forkLineage
      ? {
          _tag: "fork",
          originThreadId: thread.forkLineage.originThreadId,
          ...(thread.forkLineage.sourceImport === undefined
            ? {}
            : { sourceImport: thread.forkLineage.sourceImport }),
        }
      : thread.conversationImport
        ? {
            _tag: "import",
            source: thread.conversationImport.source,
            exportId: thread.conversationImport.exportId,
            sourceThreadId: thread.conversationImport.sourceThreadId,
            packageDigest: thread.conversationImport.packageDigest,
            sourceFormat: thread.conversationImport.sourceFormat,
            sourceFormatVersion: thread.conversationImport.sourceFormatVersion,
            importedAt: thread.conversationImport.importedAt,
            omissions: thread.conversationImport.omissions,
            ...(thread.conversationImport.timesShiftedMs === undefined
              ? {}
              : { timesShiftedMs: thread.conversationImport.timesShiftedMs }),
            ...(thread.conversationImport.notices === undefined
              ? {}
              : { notices: thread.conversationImport.notices }),
          }
        : { _tag: "original" },
    captured: {
      threadId: thread.id,
      snapshotSequence: input.snapshotSequence,
      threadSequence: input.threadSequence,
      capturedAt: input.capturedAt,
    },
    selection,
    messages,
    reasoning,
    workLog: workLog.entries,
    proposedPlans: content.proposedPlans.map((plan) => ({
      id: plan.id,
      turnId: plan.turnId,
      createdAt: plan.createdAt,
      updatedAt: plan.updatedAt,
      markdown: plan.planMarkdown,
      implemented: plan.implementedAt !== null,
    })),
    questionAnswers: questions.questionAnswers,
    omittedRunningTurn: running === null ? null : { turnId: running },
    warnings,
  };
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value instanceof Uint8Array) return Array.from(value);
  if (Predicate.isObject(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .toSorted()
        .map((key) => [key, canonicalize((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}

/** The exact text a snapshot's content digest is computed over. */
export function canonicalSnapshotContent(snapshot: ConversationSnapshotContent): string {
  const { captured: _captured, ...content } = snapshot;
  return JSON.stringify(canonicalize(content));
}
