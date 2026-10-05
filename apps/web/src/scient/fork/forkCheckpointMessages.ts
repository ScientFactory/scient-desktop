import type { MessageId, RunId } from "@t3tools/contracts";

import {
  deriveTerminalAssistantMessageIds,
  deriveUnsettledRunId,
  type TimelineLatestRun,
} from "../../components/chat/MessagesTimeline.logic";
import type { TimelineEntry } from "../../session-logic";

export function findLatestCompletedAssistantMessageId(input: {
  timelineEntries: ReadonlyArray<TimelineEntry>;
  latestRun: TimelineLatestRun | null;
  runningRunId: RunId | null;
}): MessageId | null {
  const terminalAssistantMessageIds = deriveTerminalAssistantMessageIds(input.timelineEntries);
  const unsettledRunId = deriveUnsettledRunId(input.latestRun, input.runningRunId);

  for (let index = input.timelineEntries.length - 1; index >= 0; index -= 1) {
    const entry = input.timelineEntries[index];
    if (
      entry?.kind === "message" &&
      entry.message.role === "assistant" &&
      !entry.message.streaming &&
      (unsettledRunId === null || entry.message.runId !== unsettledRunId) &&
      terminalAssistantMessageIds.has(entry.message.id)
    ) {
      return entry.message.id;
    }
  }
  return null;
}

export function findPrecedingCompletedAssistantMessageId(input: {
  readonly timelineEntries: ReadonlyArray<TimelineEntry>;
  readonly sourceUserMessageId: MessageId;
}): MessageId | null {
  const sourceIndex = input.timelineEntries.findIndex(
    (entry) =>
      entry.kind === "message" &&
      entry.message.role === "user" &&
      entry.message.id === input.sourceUserMessageId,
  );
  if (sourceIndex < 0) return null;

  const terminalAssistantMessageIds = deriveTerminalAssistantMessageIds(
    input.timelineEntries.slice(0, sourceIndex),
  );
  for (let index = sourceIndex - 1; index >= 0; index -= 1) {
    const entry = input.timelineEntries[index];
    if (
      entry?.kind === "message" &&
      entry.message.role === "assistant" &&
      !entry.message.streaming &&
      terminalAssistantMessageIds.has(entry.message.id)
    ) {
      return entry.message.id;
    }
  }
  return null;
}
