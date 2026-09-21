// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vite-plus/test";
import {
  checkpointVisualDraft,
  clearUncheckpointedVisualDraft,
  clearVisualDraft,
  confirmVisualDraft,
  discardVisualDraft,
  readVisualDraft,
  reconcileVisualDraft,
  retainVisualDraft,
} from "./visualDrafts";

const keys = [
  "versioned",
  "legacy",
  "v1",
  "v2",
  "invalid",
  "pending",
  "failed",
  "confirmed",
  "newer",
  "nonexact",
  "reloaded",
  "unchanged",
  "multiple",
  "discarded",
  "wrong-discard",
];
const before = [
  "\\documentclass{article}",
  "\\begin{document}",
  "A deliberately long surrounding paragraph contains old visual prose for recovery.",
  "",
  "A second editable paragraph remains unchanged.",
  "\\end{document}",
].join("\n");
const after = before.replace("old visual prose", "new visual prose");
const afterBoth = after.replace("remains unchanged", "is now edited too");

function retain(key: string, text: string, source: string, baseSource = before) {
  retainVisualDraft(key, { text, source, baseSource, baseRevision: "disk-one" });
}

afterEach(() => {
  for (const key of keys) clearVisualDraft(key);
});

describe("Visual draft recovery", () => {
  it("stores immediate input as a versioned complete-source recovery record", () => {
    retain("versioned", "new visual prose", after);
    expect(
      JSON.parse(localStorage.getItem("scient:latex-visual-draft:v3:versioned")!),
    ).toMatchObject({
      schemaVersion: 3,
      text: "new visual prose",
      source: after,
      baseRevision: "disk-one",
    });
    expect(readVisualDraft("versioned")).toBe(after);
  });

  it("reads raw-string and structured records from earlier candidates without overstating them", () => {
    localStorage.setItem("scient:latex-visual-draft:legacy", "legacy recovery text");
    localStorage.setItem(
      "scient:latex-visual-draft:v1:v1",
      JSON.stringify({ schemaVersion: 1, text: "v1 recovery text" }),
    );
    localStorage.setItem(
      "scient:latex-visual-draft:v2:v2",
      JSON.stringify({ schemaVersion: 2, text: "v2 recovery text" }),
    );

    expect(readVisualDraft("legacy")).toBe("legacy recovery text");
    expect(readVisualDraft("v1", { source: before, revision: "disk-one" })).toBe(
      "v1 recovery text",
    );
    expect(readVisualDraft("v2", { source: before, revision: "disk-one" })).toBe(
      "v2 recovery text",
    );
  });

  it("fails closed on an unknown stored schema", () => {
    localStorage.setItem(
      "scient:latex-visual-draft:v3:invalid",
      JSON.stringify({ schemaVersion: 4, text: "not trusted" }),
    );
    expect(readVisualDraft("invalid")).toBeNull();
  });

  it("keeps an optimistic complete-source checkpoint durable but silent until disk confirmation", () => {
    retain("pending", "new visual prose", after);
    checkpointVisualDraft("pending", "new visual prose", before, after, "disk-one");

    expect(readVisualDraft("pending", { source: after, revision: "disk-one" })).toBeNull();
    expect(localStorage.getItem("scient:latex-visual-draft:v3:pending")).not.toBeNull();
  });

  it("preserves the complete source when a save fails or confirms different contents", () => {
    checkpointVisualDraft("failed", "new visual prose", before, after, "disk-one");

    expect(confirmVisualDraft("failed", before)).toBe(false);
    expect(readVisualDraft("failed", { source: before, revision: "disk-one" })).toBe(after);
  });

  it("clears only after the exact complete checkpoint reaches a confirmed disk write", () => {
    checkpointVisualDraft("confirmed", "new visual prose", before, after, "disk-one");

    expect(confirmVisualDraft("confirmed", after)).toBe(true);
    expect(readVisualDraft("confirmed")).toBeNull();
  });

  it("does not let an older save confirmation erase newer uncheckpointed source", () => {
    checkpointVisualDraft("newer", "new visual prose", before, after, "disk-one");
    retain("newer", "second block raw text", afterBoth);

    expect(confirmVisualDraft("newer", after)).toBe(false);
    expect(readVisualDraft("newer")).toBe(afterBoth);
  });

  it("fails closed instead of using a last-block proof for a nonexact save", () => {
    checkpointVisualDraft("nonexact", "new visual prose", before, after, "disk-one");
    const later = `% unrelated edit\n${after}`;

    expect(confirmVisualDraft("nonexact", later)).toBe(false);
    expect(readVisualDraft("nonexact")).toBe(after);
  });

  it("recognizes a complete checkpoint already on disk after a crash before the callback", () => {
    checkpointVisualDraft("reloaded", "new visual prose", before, after, "disk-one");

    expect(reconcileVisualDraft("reloaded", { source: after, revision: "disk-two" })).toBeNull();
    expect(localStorage.getItem("scient:latex-visual-draft:v3:reloaded")).toBeNull();
  });

  it("restores the prior checkpoint when a newly entered block remains unchanged", () => {
    checkpointVisualDraft("unchanged", "new visual prose", before, after, "disk-one");
    retain("unchanged", "A second editable paragraph remains unchanged.", after);

    clearUncheckpointedVisualDraft("unchanged", after);

    expect(readVisualDraft("unchanged", { source: after, revision: "disk-one" })).toBeNull();
    expect(readVisualDraft("unchanged", { source: before, revision: "disk-one" })).toBe(after);
  });

  it("retains the full latest source across multiple edited blocks", () => {
    checkpointVisualDraft("multiple", "new visual prose", before, after, "disk-one");
    retain("multiple", "A second editable paragraph is now edited too.", afterBoth);
    checkpointVisualDraft(
      "multiple",
      "A second editable paragraph is now edited too.",
      after,
      afterBoth,
      "disk-one",
    );

    expect(readVisualDraft("multiple", { source: before, revision: "disk-one" })).toBe(afterBoth);
    expect(confirmVisualDraft("multiple", afterBoth)).toBe(true);
  });

  it("clears a transaction only for a matching Discard identity while Retry can retain it", () => {
    checkpointVisualDraft("discarded", "new visual prose", before, after, "disk-one");
    retain("discarded", "newer raw second block", afterBoth);

    expect(discardVisualDraft("discarded", { source: after, baseRevision: "wrong-revision" })).toBe(
      false,
    );
    expect(readVisualDraft("discarded")).toBe(afterBoth);
    // The pending shared buffer is `after`; the journal may additionally own
    // raw input. Explicit Discard removes the whole matching transaction.
    expect(discardVisualDraft("discarded", { source: after, baseRevision: "disk-one" })).toBe(true);
    expect(readVisualDraft("discarded")).toBeNull();

    checkpointVisualDraft("wrong-discard", "new visual prose", before, after, "disk-one");
    expect(
      discardVisualDraft("wrong-discard", { source: afterBoth, baseRevision: "disk-one" }),
    ).toBe(false);
    expect(readVisualDraft("wrong-discard")).toBe(after);
  });
});
