import { questionAnswerMessageId, type TurnId } from "@t3tools/contracts";

import {
  isStreamingMessageTextUpdate,
  type ActivePlanState,
  type TimelineEntry,
  type WorkLogEntry,
} from "../../session-logic";
import type { ChatMessage, ProposedPlan } from "../../types";

export interface TurnPlanEntry {
  /** Stable per-turn row id (plans rewrite constantly; the row must not churn). */
  id: string;
  /** Anchor timestamp: the turn's first plan activity, so the chip renders where planning began. */
  createdAt: string;
  turnId: TurnId | null;
  plan: ActivePlanState;
}

/**
 * The legacy projection the activity-driven `deriveTimelineEntries*` pair
 * returns: its own source arrays so a streaming update can be diffed.
 */
export interface ActivityTimelineEntriesProjection {
  readonly messages: ReadonlyArray<ChatMessage>;
  readonly proposedPlans: ReadonlyArray<ProposedPlan>;
  readonly workEntries: ReadonlyArray<WorkLogEntry>;
  readonly turnPlans: ReadonlyArray<TurnPlanEntry>;
  readonly entries: TimelineEntry[];
}

/** Reuse ordered entries across immutable stream updates. Other changes keep the full sort. */
export function deriveTimelineEntriesWithState(
  messages: ReadonlyArray<ChatMessage>,
  proposedPlans: ReadonlyArray<ProposedPlan>,
  workEntries: ReadonlyArray<WorkLogEntry>,
  previous: ActivityTimelineEntriesProjection | null = null,
  turnPlans: ReadonlyArray<TurnPlanEntry> = [],
): ActivityTimelineEntriesProjection {
  if (
    previous !== null &&
    previous.turnPlans.length === turnPlans.length &&
    hasExactArrayPrefix(previous.turnPlans, turnPlans) &&
    previous.proposedPlans.length === proposedPlans.length &&
    previous.workEntries.length === workEntries.length &&
    hasExactArrayPrefix(previous.proposedPlans, proposedPlans) &&
    hasExactArrayPrefix(previous.workEntries, workEntries)
  ) {
    const entries = replaceStreamingTimelineMessages(messages, previous);
    if (entries !== null) return { messages, proposedPlans, workEntries, turnPlans, entries };
  }
  const foldedAnswerMessageIds = new Set(
    workEntries.flatMap(
      (entry) =>
        // SCIENT-FORK:START — imported answers name their message.
        entry.questionAnswer ? [questionAnswerMessageId(entry.questionAnswer)] : [],
      // SCIENT-FORK:END
    ),
  );
  const showMessage = (message: ChatMessage) =>
    message.role !== "user" || !foldedAnswerMessageIds.has(message.id);
  const canAppend =
    previous !== null &&
    hasExactArrayPrefix(previous.turnPlans, turnPlans) &&
    !previous.entries.some((entry) => entry.kind === "message" && !showMessage(entry.message)) &&
    hasExactArrayPrefix(previous.messages, messages) &&
    hasExactArrayPrefix(previous.proposedPlans, proposedPlans) &&
    hasExactArrayPrefix(previous.workEntries, workEntries);

  if (canAppend) {
    const messageRows = messages
      .slice(previous.messages.length)
      .filter(showMessage)
      .map(timelineEntryFromMessage);
    const proposedPlanRows = proposedPlans
      .slice(previous.proposedPlans.length)
      .map(timelineEntryFromProposedPlan);
    const workRows = workEntries.slice(previous.workEntries.length).map(timelineEntryFromWork);
    const turnPlanRows = turnPlans.slice(previous.turnPlans.length).map(timelineEntryFromTurnPlan);
    const suffix = [...messageRows, ...proposedPlanRows, ...turnPlanRows, ...workRows].toSorted(
      compareTimelineEntriesByCreatedAt,
    );
    return {
      messages,
      proposedPlans,
      workEntries,
      entries: mergeTimelineEntrySuffix(previous.entries, suffix),
      turnPlans,
    };
  }

  const messageRows = messages.filter(showMessage).map(timelineEntryFromMessage);
  const proposedPlanRows = proposedPlans.map(timelineEntryFromProposedPlan);
  const workRows = workEntries.map(timelineEntryFromWork);
  return {
    messages,
    proposedPlans,
    workEntries,
    turnPlans,
    entries: [
      ...messageRows,
      ...proposedPlanRows,
      ...turnPlans.map(timelineEntryFromTurnPlan),
      ...workRows,
    ].toSorted(compareTimelineEntriesByCreatedAt),
  };
}

export function deriveTimelineEntries(
  messages: ReadonlyArray<ChatMessage>,
  proposedPlans: ReadonlyArray<ProposedPlan>,
  workEntries: ReadonlyArray<WorkLogEntry>,
  turnPlans: ReadonlyArray<TurnPlanEntry> = [],
): TimelineEntry[] {
  return deriveTimelineEntriesWithState(messages, proposedPlans, workEntries, null, turnPlans)
    .entries;
}

function timelineEntryFromMessage(message: ChatMessage): TimelineEntry {
  return {
    id: message.id,
    kind: "message",
    createdAt: message.createdAt,
    message,
  };
}

function timelineEntryFromProposedPlan(proposedPlan: ProposedPlan): TimelineEntry {
  return {
    id: proposedPlan.id,
    kind: "proposed-plan",
    createdAt: proposedPlan.createdAt,
    proposedPlan,
  };
}

function timelineEntryFromWork(workEntry: WorkLogEntry): TimelineEntry {
  return {
    id: workEntry.id,
    kind: "work",
    createdAt: workEntry.createdAt,
    entry: workEntry,
  };
}

function timelineEntryFromTurnPlan(turnPlan: TurnPlanEntry): TimelineEntry {
  return { id: turnPlan.id, kind: "turn-plan", createdAt: turnPlan.createdAt, turnPlan };
}

function compareTimelineEntriesByCreatedAt(left: TimelineEntry, right: TimelineEntry): number {
  return left.createdAt.localeCompare(right.createdAt);
}

function timelineEntrySourceOrder(entry: TimelineEntry): number {
  switch (entry.kind) {
    case "message":
      return 0;
    case "proposed-plan":
      return 1;
    case "turn-plan":
      return 2;
    case "work":
      return 3;
    case "event":
      return 4;
  }
}

function shouldTakePreviousTimelineEntry(previous: TimelineEntry, suffix: TimelineEntry): boolean {
  const createdAtComparison = compareTimelineEntriesByCreatedAt(previous, suffix);
  if (createdAtComparison !== 0) return createdAtComparison < 0;
  // The original full derivation sorts a source-ordered array with a stable
  // comparator. On a tie, messages precede plans, plans precede work, and an
  // older item in the same source array precedes a newly appended item.
  return timelineEntrySourceOrder(previous) <= timelineEntrySourceOrder(suffix);
}

function hasExactArrayPrefix<T>(previous: ReadonlyArray<T>, next: ReadonlyArray<T>): boolean {
  if (previous === next) return true;
  if (next.length < previous.length) return false;
  for (let index = 0; index < previous.length; index += 1) {
    if (previous[index] !== next[index]) return false;
  }
  return true;
}

function mergeTimelineEntrySuffix(
  previous: ReadonlyArray<TimelineEntry>,
  suffix: ReadonlyArray<TimelineEntry>,
): TimelineEntry[] {
  if (suffix.length === 0) return [...previous];
  const previousLast = previous.at(-1);
  let suffixIsOrdered = true;
  for (let index = 1; index < suffix.length; index += 1) {
    if (compareTimelineEntriesByCreatedAt(suffix[index - 1]!, suffix[index]!) > 0) {
      suffixIsOrdered = false;
      break;
    }
  }
  if (
    suffixIsOrdered &&
    (previousLast === undefined || shouldTakePreviousTimelineEntry(previousLast, suffix[0]!))
  ) {
    return [...previous, ...suffix];
  }

  const merged: TimelineEntry[] = [];
  let previousIndex = 0;
  let suffixIndex = 0;
  while (previousIndex < previous.length || suffixIndex < suffix.length) {
    const previousEntry = previous[previousIndex];
    const suffixEntry = suffix[suffixIndex];
    if (
      previousEntry !== undefined &&
      (suffixEntry === undefined || shouldTakePreviousTimelineEntry(previousEntry, suffixEntry))
    ) {
      merged.push(previousEntry);
      previousIndex += 1;
    } else if (suffixEntry !== undefined) {
      merged.push(suffixEntry);
      suffixIndex += 1;
    }
  }
  return merged;
}
function replaceStreamingTimelineMessages(
  messages: ReadonlyArray<ChatMessage>,
  previous: ActivityTimelineEntriesProjection,
): TimelineEntry[] | null {
  if (messages.length !== previous.messages.length) return null;
  const replacements = new Map<ChatMessage, ChatMessage>();
  for (const [index, message] of messages.entries()) {
    const previousMessage = previous.messages[index]!;
    if (message === previousMessage) continue;
    if (!isStreamingMessageTextUpdate(previousMessage, message)) return null;
    replacements.set(previousMessage, message);
  }
  if (replacements.size === 0) return previous.entries;
  return previous.entries.map((entry) => {
    const replacement = entry.kind === "message" ? replacements.get(entry.message) : undefined;
    return replacement ? timelineEntryFromMessage(replacement) : entry;
  });
}
