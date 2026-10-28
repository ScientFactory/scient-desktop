import type { ScientOverleafUndoResult } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import { undoLines } from "./resultLines.ts";

const undone: Extract<ScientOverleafUndoResult, { _tag: "undone" }> = {
  _tag: "undone",
  outcome: "complete",
  restored: ["main.tex"],
  removed: ["added.tex"],
  recreated: ["deleted.tex"],
  skipped: [{ path: "edited.tex", reason: "changed" }],
  sync: { _tag: "duplicate", category: null },
};

describe("Undo tool results", () => {
  it("reports the actual local effects and skipped reason, separately from the follow-up sync", () => {
    expect(undoLines(4, undone)).toEqual([
      "Undo of send #4 completed in the folder.",
      "Removed locally: added.tex.",
      "Put back an earlier version locally: main.tex.",
      "Recreated locally: deleted.tex.",
      "Left as it is: edited.tex (edited since that send).",
      "Then it synced:",
      "This request already ran; nothing ran again.",
    ]);
  });

  it.each(["replan", "attention"] as const)(
    "never claims planned effects completed after %s",
    (outcome) => {
      const lines = undoLines(4, {
        ...undone,
        outcome,
        sync: { _tag: "not-synced", reason: "undo-incomplete" },
      });
      expect(
        lines.some((line) =>
          /^(Removed|Put back an earlier version|Recreated) locally:/u.test(line),
        ),
      ).toBe(false);
      expect(lines).toContain(
        "Undo stopped partway; nothing was sent. Check the files (scient_overleaf_status), then sync.",
      );
    },
  );
});
