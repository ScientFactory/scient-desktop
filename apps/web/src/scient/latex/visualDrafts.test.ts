// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vite-plus/test";
import {
  checkpointVisualDraft,
  clearVisualDraft,
  confirmVisualDraft,
  discardVisualDraft,
  readVisualDraft,
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
  checkpointVisualDraft(key, text, baseSource, source, "disk-one");
}

afterEach(() => {
  for (const key of keys) clearVisualDraft(key);
});

describe("Visual draft recovery", () => {
  it("keeps an optimistic complete-source checkpoint durable but silent until disk confirmation", () => {
    retain("pending", "new visual prose", after);
    checkpointVisualDraft("pending", "new visual prose", before, after, "disk-one");

    expect(readVisualDraft("pending", { source: after, revision: "disk-one" })).toBeNull();
    expect(readVisualDraft("pending")).toBe(after);
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
    // Discard must match the latest accepted source.
    expect(discardVisualDraft("discarded", { source: after, baseRevision: "disk-one" })).toBe(
      false,
    );
    expect(discardVisualDraft("discarded", { source: afterBoth, baseRevision: "disk-one" })).toBe(
      true,
    );
    expect(readVisualDraft("discarded")).toBeNull();

    checkpointVisualDraft("wrong-discard", "new visual prose", before, after, "disk-one");
    expect(
      discardVisualDraft("wrong-discard", { source: afterBoth, baseRevision: "disk-one" }),
    ).toBe(false);
    expect(readVisualDraft("wrong-discard")).toBe(after);
  });
});
