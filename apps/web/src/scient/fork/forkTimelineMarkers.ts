import type { MessageId, ThreadId } from "@t3tools/contracts";

import type { TimelineEntry } from "../../session-logic";

/**
 * "Conversation forked here": this fork's own baseline separator, or an earlier
 * fork point the conversation inherited (a fork of a fork shows its parent's).
 */
export interface ForkMarkerRow {
  kind: "fork-marker";
  id: string;
  /** An earlier fork point this conversation shows, and the conversation it came from. */
  originThreadId?: ThreadId | undefined;
}

/** Where this conversation was forked from, as the timeline host receives it. */
export interface ForkBaselineInput {
  hasForkBaseline?: boolean | undefined;
  forkBaselineAssistantMessageId?: MessageId | null | undefined;
}

const BASELINE_FORK_MARKER_ID = "conversation-fork-marker";

/** Whether this fork's baseline separator is among the rows. */
export function forkBaselineMarkerVisible(
  input: ForkBaselineInput,
  timelineEntries: ReadonlyArray<TimelineEntry>,
): boolean {
  return (
    input.hasForkBaseline === true &&
    (input.forkBaselineAssistantMessageId === null ||
      timelineEntries.some(
        (entry) =>
          entry.kind === "message" && entry.message.id === input.forkBaselineAssistantMessageId,
      ))
  );
}

/** A fork made before any answer leads the conversation with its separator. */
export function leadingForkMarkerRow(input: ForkBaselineInput): ForkMarkerRow | null {
  return input.hasForkBaseline === true && input.forkBaselineAssistantMessageId === null
    ? { kind: "fork-marker", id: BASELINE_FORK_MARKER_ID }
    : null;
}

/** The separator that follows the answer this conversation was forked after. */
export function forkBaselineMarkerRowAfter(
  input: ForkBaselineInput,
  messageId: MessageId,
): ForkMarkerRow | null {
  return input.hasForkBaseline === true &&
    input.forkBaselineAssistantMessageId !== undefined &&
    input.forkBaselineAssistantMessageId !== null &&
    messageId === input.forkBaselineAssistantMessageId
    ? { kind: "fork-marker", id: BASELINE_FORK_MARKER_ID }
    : null;
}

/**
 * This conversation's own incoming fork event, which the baseline separator
 * already represents. Outgoing and inherited fork records stay distinct history.
 */
export function isLocalIncomingForkEvent(entry: TimelineEntry): boolean {
  return (
    entry.kind === "event" &&
    entry.projectedItem.visibility === "local" &&
    entry.projectedItem.item.type === "fork" &&
    (entry.projectedItem.item.source.type === "run" ||
      entry.projectedItem.item.source.type === "message") &&
    entry.projectedItem.item.targetThreadId === entry.projectedItem.item.threadId
  );
}

/** An inherited point where an earlier conversation was forked reads like this fork's own separator. */
export function inheritedForkMarkerRow(entry: TimelineEntry): ForkMarkerRow | null {
  if (
    entry.kind === "event" &&
    entry.projectedItem.visibility === "inherited" &&
    entry.projectedItem.item.type === "fork" &&
    (entry.projectedItem.item.source.type === "run" ||
      entry.projectedItem.item.source.type === "message")
  ) {
    return {
      kind: "fork-marker",
      id: `fork-marker:${entry.id}`,
      originThreadId: entry.projectedItem.item.source.threadId,
    };
  }
  return null;
}
