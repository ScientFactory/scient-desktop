import { RunId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  deriveMessagesTimelineRows,
  type MessagesTimelineRow,
  timelineTurnFoldRunIdsByEntryId,
} from "~/components/chat/MessagesTimeline.logic";

const DIAGNOSIS = "## Diagnosis\nThe cache key ignores the locale, so French pages read English.";

let second = 0;
function assistant(id: string, text: string, streaming = false) {
  second += 2;
  const at = (offset: number) => `2026-01-01T00:00:${String(second + offset).padStart(2, "0")}Z`;
  return {
    id: `${id}-entry`,
    kind: "message" as const,
    createdAt: at(0),
    message: {
      id: id as never,
      role: "assistant" as const,
      text,
      runId: "turn-1" as never,
      createdAt: at(0),
      updatedAt: at(1),
      streaming,
    },
  };
}

function rowsFor(
  timelineEntries: ReturnType<typeof assistant>[],
  running = false,
): MessagesTimelineRow[] {
  return deriveMessagesTimelineRows({
    timelineEntries,
    isWorking: running,
    activeTurnStartedAt: null,
    turnDiffSummaries: [],
    supportsConversationRollback: false,
    ...(running ? { runningRunId: RunId.make("turn-1") } : {}),
  });
}

function messageRow(rows: MessagesTimelineRow[], id: string) {
  const row = rows.find((candidate) => candidate.id === id);
  if (row?.kind !== "message") throw new Error(`no message row ${id}`);
  return row;
}

describe("kept answers", () => {
  it("keeps an earlier real answer visible while progress notes fold", () => {
    second = 0;
    const entries = [
      assistant("note-1", "Let me check the tests…"),
      assistant("answer", DIAGNOSIS),
      assistant("note-2", "Pushed. Next is a short final re-review."),
      assistant("final", "Done."),
    ];
    const rows = rowsFor(entries);
    expect(rows.map((row) => row.id)).toEqual(["turn-fold:turn-1", "answer-entry", "final-entry"]);

    // The kept answer carries a copy row and the answer's spacing, but stays
    // out of the final answer's roles (fork, trailing tool footer).
    const kept = messageRow(rows, "answer-entry");
    expect(kept.keptAnswer).toBe(true);
    expect(kept.showAssistantCopyButton).toBe(true);
    expect(kept.showAssistantMeta).toBe(false);
    expect(kept.canForkConversation).toBeUndefined();
    expect(messageRow(rows, "final-entry").showAssistantMeta).toBe(true);
    expect(messageRow(rows, "final-entry").keptAnswer).toBeUndefined();
  });

  it("does not fold a turn whose only earlier messages are real answers", () => {
    second = 0;
    const rows = rowsFor([assistant("answer", "a".repeat(400)), assistant("final", "Done.")]);
    expect(rows.map((row) => row.id)).toEqual(["answer-entry", "final-entry"]);
  });

  it("leaves find in thread consistent: a kept answer is not inside the fold", () => {
    second = 0;
    const timelineEntries = [
      assistant("note", "Checking."),
      assistant("answer", DIAGNOSIS),
      assistant("final", "Done."),
    ];
    const folded = timelineTurnFoldRunIdsByEntryId({ timelineEntries, isWorking: false });
    expect(folded.has("note-entry")).toBe(true);
    expect(folded.has("answer-entry")).toBe(false);
    expect(folded.has("final-entry")).toBe(false);
  });

  it("adds nothing while the turn is still running", () => {
    second = 0;
    const rows = rowsFor(
      [
        assistant("note", "Checking."),
        assistant("answer", DIAGNOSIS),
        assistant("live", "Still writ", true),
      ],
      true,
    );
    expect(rows.some((row) => row.kind === "turn-fold")).toBe(false);
    expect(messageRow(rows, "answer-entry").keptAnswer).toBeUndefined();
    expect(messageRow(rows, "answer-entry").showAssistantCopyButton).toBe(false);
  });
});
