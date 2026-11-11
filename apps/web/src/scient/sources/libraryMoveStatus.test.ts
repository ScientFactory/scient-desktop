import type { ScientSourcesMoveStatus } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { libraryMoveLine, libraryMoveRunning } from "./libraryMoveStatus";

const progress = (phase: "files" | "restoring", done: number, total: number) => ({
  phase,
  done,
  total,
});

describe("the Library's move line", () => {
  it.each<{
    readonly status: ScientSourcesMoveStatus;
    readonly movingBack?: boolean;
    readonly line: ReturnType<typeof libraryMoveLine>;
  }>([
    { status: { state: "nothing-to-move" }, line: null },
    {
      status: { state: "waiting" },
      line: { text: "The Library is waiting to move out of this project.", action: null },
    },
    {
      status: { state: "moving", progress: progress("files", 12, 340) },
      line: {
        text: "Moving the Library out of this project: copying PDFs 12 of 340.",
        action: null,
      },
    },
    {
      status: { state: "moving", progress: null },
      line: { text: "Moving the Library out of this project.", action: null },
    },
    // Dismissed, or a move with nothing to tell: the status carries no lines.
    { status: { state: "done", lines: [] }, line: null },
    {
      status: {
        state: "done",
        lines: [
          "Merged 3 duplicates. 1 kept different values: Review.",
          "Undo for bulk edits made before the move was not kept.",
        ],
      },
      line: {
        text: "Merged 3 duplicates. 1 kept different values: Review. Undo history of bulk edits from before the move was not carried over.",
        action: "dismiss",
      },
    },
    {
      status: { state: "cleanup-pending", filesLeft: 2, lines: ["Merged 1 duplicate."] },
      line: {
        text: "2 files are still open and will be removed from the project later. Merged 1 duplicate. Undo history of bulk edits from before the move was not carried over.",
        action: "dismiss",
      },
    },
    {
      status: { state: "cleanup-pending", filesLeft: 1, lines: [] },
      line: {
        text: "1 file is still open and will be removed from the project later.",
        action: null,
      },
    },
    {
      status: { state: "restoring", progress: progress("restoring", 4, 9) },
      line: { text: "Moving the Library back into this project: 4 of 9.", action: null },
    },
    {
      status: { state: "restoring", progress: null },
      movingBack: true,
      line: { text: "Moving the Library back into this project.", action: null },
    },
    {
      status: { state: "restoring", progress: null },
      line: {
        text: "Moving back stopped before it finished. It finishes with the next change to the Library.",
        action: null,
      },
    },
    {
      status: { state: "moved-back", restoredSources: 1, restoredPdfs: 2 },
      line: { text: "The Library is back in this project: 1 source, 2 PDFs.", action: null },
    },
    {
      status: { state: "failed", reason: "The disk is full." },
      line: { text: "Moving the Library failed: The disk is full.", action: "retry" },
    },
  ])("$status.state", ({ status, movingBack = false, line }) => {
    expect(libraryMoveLine(status, { movingBack })).toEqual(line);
  });

  it("asks again only while the move waits or runs", () => {
    expect(libraryMoveRunning({ state: "waiting" })).toBe(true);
    expect(libraryMoveRunning({ state: "restoring", progress: null })).toBe(true);
    expect(libraryMoveRunning({ state: "done", lines: [] })).toBe(false);
    expect(libraryMoveRunning(null)).toBe(false);
  });
});
