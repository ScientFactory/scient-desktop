import type {
  ConversationAttachment,
  ConversationMessage,
  ConversationProposedPlan,
  ConversationQuestionAnswer,
  ConversationReasoning,
  ConversationSnapshotV1,
  ConversationWorkLogEntry,
  TurnId,
} from "@t3tools/contracts";
import {
  deriveTerminalAssistantMessageIds,
  deriveTurnFolds,
  type GroupingTimelineEntry,
} from "@scientfactory/conversation/work-log-grouping";
import type { CloudConversation, SnapshotSidecar } from "@scientfactory/scient-cloud/api";

/** One step of a work log, as the reader shows it. */
export type SnapshotWorkStep =
  | { readonly kind: "work"; readonly id: string; readonly entry: ConversationWorkLogEntry }
  | { readonly kind: "reasoning"; readonly id: string; readonly reasoning: ConversationReasoning };

export type SnapshotRow =
  | { readonly kind: "user"; readonly id: string; readonly message: ConversationMessage }
  | {
      readonly kind: "assistant";
      readonly id: string;
      readonly message: ConversationMessage;
      /** Set on the last answer of a response. */
      readonly model: SnapshotAnswerModel | null;
    }
  | {
      readonly kind: "fold";
      readonly id: string;
      readonly label: string;
      readonly steps: ReadonlyArray<SnapshotWorkStep>;
    }
  | { readonly kind: "step"; readonly id: string; readonly step: SnapshotWorkStep }
  | { readonly kind: "plan"; readonly id: string; readonly plan: ConversationProposedPlan }
  | { readonly kind: "answer"; readonly id: string; readonly answer: ConversationQuestionAnswer };

export interface SnapshotAnswerModel {
  readonly provider: string | null;
  readonly model: string | null;
}

interface Work {
  readonly turnId: TurnId | null;
  readonly tone: string;
  readonly sourceActivityKind?: string;
  readonly questionAnswer?: ConversationQuestionAnswer;
  readonly entry: ConversationWorkLogEntry | null;
}

type Entry = GroupingTimelineEntry<Work>;

/** Chat folds an answered question's "async-answer" message into the answer itself. */
function isFoldedAnswerMessage(message: ConversationMessage, answered: ReadonlySet<string>) {
  return (
    message.role === "user" &&
    message.id.startsWith("async-answer:") &&
    answered.has(message.id.slice("async-answer:".length))
  );
}

function answerModels(
  snapshot: ConversationSnapshotV1,
  sidecar: SnapshotSidecar | undefined,
): (messageId: string) => SnapshotAnswerModel | null {
  const byMessage = new Map(
    (sidecar?.answers ?? []).map((answer) => [
      answer.messageId as string,
      { provider: answer.provider, model: answer.model },
    ]),
  );
  const fallback =
    snapshot.thread.provider !== null || snapshot.thread.model !== null
      ? { provider: snapshot.thread.provider, model: snapshot.thread.model }
      : null;
  return (messageId) => byMessage.get(messageId) ?? fallback;
}

/**
 * The reader's rows for a snapshot, in chat's order, with each settled turn's work folded behind
 * a "Worked for …" row the way chat folds it.
 */
export function buildSnapshotRows(conversation: CloudConversation): ReadonlyArray<SnapshotRow> {
  const { snapshot, sidecar } = conversation;
  const answered = new Set(snapshot.questionAnswers.map((answer) => answer.id));
  const messages = snapshot.messages.filter(
    (message) => message.role !== "system" && !isFoldedAnswerMessage(message, answered),
  );
  const messageById = new Map(messages.map((message) => [message.id as string, message]));
  const reasoningById = new Map(snapshot.reasoning.map((item) => [item.id as string, item]));
  const planById = new Map(snapshot.proposedPlans.map((plan) => [`plan:${plan.id}`, plan]));
  const answerById = new Map(snapshot.questionAnswers.map((qa) => [`answer:${qa.id}`, qa]));
  const workById = new Map(snapshot.workLog.map((entry) => [`work:${entry.id}`, entry]));

  const timeline: Entry[] = [
    ...messages.map((message): Entry => ({
      id: message.id,
      kind: "message",
      createdAt: message.createdAt,
      message: { ...message, role: message.role, streaming: false },
    })),
    ...snapshot.reasoning.map((reasoning): Entry => ({
      id: reasoning.id,
      kind: "message",
      createdAt: reasoning.createdAt,
      message: { ...reasoning, role: "reasoning", streaming: false },
    })),
    ...snapshot.proposedPlans.map((plan): Entry => ({
      id: `plan:${plan.id}`,
      kind: "proposed-plan",
      createdAt: plan.createdAt,
      proposedPlan: { turnId: plan.turnId },
    })),
    ...snapshot.questionAnswers.map((answer): Entry => ({
      id: `answer:${answer.id}`,
      kind: "work",
      createdAt: answer.createdAt,
      entry: { turnId: answer.turnId, tone: "tool", questionAnswer: answer, entry: null },
    })),
    ...snapshot.workLog.map((entry): Entry => ({
      id: `work:${entry.id}`,
      kind: "work",
      createdAt: entry.createdAt,
      entry: {
        turnId: entry.turnId,
        tone: entry._tag === "notice" && entry.level === "error" ? "error" : "tool",
        ...(entry._tag === "compaction" ? { sourceActivityKind: "context-compaction" } : {}),
        entry,
      },
    })),
  ].toSorted((left, right) => left.createdAt.localeCompare(right.createdAt));

  const terminalIds = deriveTerminalAssistantMessageIds(timeline);
  const folds = deriveTurnFolds({
    timelineEntries: timeline,
    terminalAssistantMessageIds: terminalIds,
    latestTurn: null,
    unfoldedTurnIds: new Set(),
    workIndicatesFailure: (work) =>
      (work.entry?._tag === "tool" || work.entry?._tag === "task") &&
      work.entry.status === "failed",
  });
  const hidden = new Set([...folds.values()].flatMap((fold) => [...fold.hiddenEntryIds]));
  const modelFor = answerModels(snapshot, sidecar);

  const stepFor = (entry: Entry): SnapshotWorkStep | null => {
    const work = workById.get(entry.id);
    if (work !== undefined) return { kind: "work", id: entry.id, entry: work };
    const reasoning = reasoningById.get(entry.id);
    return reasoning === undefined ? null : { kind: "reasoning", id: entry.id, reasoning };
  };

  const rows: SnapshotRow[] = [];
  for (const entry of timeline) {
    const fold = folds.get(entry.id);
    if (fold !== undefined) {
      const steps = timeline
        .filter((candidate) => fold.hiddenEntryIds.has(candidate.id))
        .flatMap((candidate) => stepFor(candidate) ?? []);
      if (steps.length > 0) {
        rows.push({ kind: "fold", id: `fold:${fold.turnId}`, label: fold.label, steps });
      }
      continue;
    }
    if (hidden.has(entry.id)) continue;
    const message = messageById.get(entry.id);
    if (message !== undefined) {
      rows.push(
        message.role === "user"
          ? { kind: "user", id: message.id, message }
          : {
              kind: "assistant",
              id: message.id,
              message,
              model: terminalIds.has(message.id) ? modelFor(message.id) : null,
            },
      );
      continue;
    }
    const plan = planById.get(entry.id);
    if (plan !== undefined) {
      rows.push({ kind: "plan", id: entry.id, plan });
      continue;
    }
    const answer = answerById.get(entry.id);
    if (answer !== undefined) {
      rows.push({ kind: "answer", id: entry.id, answer });
      continue;
    }
    const step = stepFor(entry);
    if (step !== null) rows.push({ kind: "step", id: entry.id, step });
  }
  return rows;
}

/** The blob that holds an attachment's bytes, when the copy carries one. */
export function attachmentBlobSha256(
  conversation: CloudConversation,
  attachment: ConversationAttachment,
): string | null {
  const listed = conversation.sidecar?.attachments?.find(
    (entry) => entry.localId === attachment.localId,
  );
  return listed?.sha256 ?? null;
}
