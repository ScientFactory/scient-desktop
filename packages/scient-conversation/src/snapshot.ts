/**
 * Builds a `ConversationSnapshotV1` from one consistent read of a thread's
 * durable projections. Pure: the caller performs the read, checks attachment
 * availability, and hashes the canonical content.
 */
import {
  CONVERSATION_SNAPSHOT_FORMAT,
  type ChatAttachment,
  type ConversationAttachment,
  type ConversationMessage,
  type ConversationSnapshotSelection,
  type ConversationSnapshotV1,
  type ConversationSnapshotWarning,
  type MessageId,
  type OrchestrationThread,
  type TurnId,
} from "@t3tools/contracts";
import * as Data from "effect/Data";
import * as Predicate from "effect/Predicate";

import { projectInlineReferences } from "./inlineReferences.ts";
import { deriveUnsettledTurnId } from "./workLogGrouping.ts";
import { projectQuestionAnswers, projectWorkLog } from "./workLogProjection.ts";

export type ConversationSnapshotContent = Omit<ConversationSnapshotV1, "contentDigest">;

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
export function runningTurnId(thread: OrchestrationThread): TurnId | null {
  const sessionTurn =
    thread.session?.status === "running" ? (thread.session.activeTurnId ?? null) : null;
  return deriveUnsettledTurnId(thread.latestTurn, sessionTurn);
}

export function buildConversationSnapshot(input: {
  readonly thread: OrchestrationThread;
  readonly snapshotSequence: number;
  readonly threadSequence: number;
  readonly capturedAt: string;
  readonly selection: ConversationSnapshotSelection;
  readonly isAttachmentAvailable: (attachment: ChatAttachment) => boolean;
}): ConversationSnapshotContent {
  const { thread, selection } = input;
  const warnings: ConversationSnapshotWarning[] = [];
  const roots = [thread.worktreePath, thread.workspaceRoot].filter(
    (root): root is string => typeof root === "string" && root.length > 0,
  );

  // The running turn and everything from its prompt on are left out.
  const running = runningTurnId(thread);
  let cutoff: string | null = null;
  if (running !== null) {
    const starts = [
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
    warnings.push({ _tag: "running-turn-omitted", turnId: running });
  }
  const settled = <A extends { readonly turnId: TurnId | null; readonly createdAt: string }>(
    item: A,
  ) =>
    running === null || (item.turnId !== running && (cutoff === null || item.createdAt < cutoff));

  // As in chat, a message of a settled turn is complete even when a crashed
  // provider left its streaming flag set; only the running turn is left out.
  const completedMessages = thread.messages.filter(settled);

  // Range: everything through the selected message, and the rest of its turn
  // up to the next message of that turn.
  let transcript = completedMessages;
  let includedTurns: ReadonlySet<TurnId | null> | null = null;
  let lastTurn: TurnId | null = null;
  let lastTurnEnd: string | null = null;
  let rangeEnd: string | null = null;
  if (selection.throughMessageId !== null) {
    const index = completedMessages.findIndex(
      (message) =>
        message.id === selection.throughMessageId &&
        (message.role === "user" || message.role === "assistant"),
    );
    if (index < 0) throw new SnapshotRangeError({ messageId: selection.throughMessageId });
    const selected = completedMessages[index]!;
    transcript = completedMessages.slice(0, index + 1);
    includedTurns = new Set(transcript.map((message) => message.turnId).filter(Boolean));
    lastTurn = selected.turnId;
    lastTurnEnd =
      completedMessages
        .slice(index + 1)
        .find((message) => message.turnId !== null && message.turnId === selected.turnId)
        ?.createdAt ?? null;
    rangeEnd = selected.createdAt;
  }
  const inRange = <A extends { readonly turnId: TurnId | null; readonly createdAt: string }>(
    item: A,
  ) => {
    if (includedTurns === null) return true;
    if (item.turnId === null) return rangeEnd !== null && item.createdAt <= rangeEnd;
    if (!includedTurns.has(item.turnId)) return false;
    return item.turnId !== lastTurn || lastTurnEnd === null || item.createdAt < lastTurnEnd;
  };

  const activities = thread.activities.filter((activity) => settled(activity) && inRange(activity));
  let skippedContext = 0;
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
      id: message.id,
      role: message.role,
      turnId: message.turnId,
      createdAt: message.createdAt,
      updatedAt: message.updatedAt,
      text: projected.text,
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
      provider: thread.session?.providerName ?? null,
      model: thread.modelSelection.model,
    },
    provenance: thread.forkLineage
      ? { _tag: "fork", originThreadId: thread.forkLineage.originThreadId }
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
    proposedPlans: thread.proposedPlans
      .filter((plan) => settled(plan) && inRange(plan))
      .map((plan) => ({
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
