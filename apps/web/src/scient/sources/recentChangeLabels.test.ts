import type { ScientSourcesRecentChange } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { recentChangeBy, recentChangeSentence, recentChangeState } from "./recentChangeLabels";

const at = "2026-11-14T09:00:00.000Z";
const bulk: Extract<ScientSourcesRecentChange, { kind: "bulk-edit" }> = {
  kind: "bulk-edit",
  id: "bulk_1",
  at,
  by: "user",
  parts: [{ batchId: "bulk_1", sourceCount: 40 }],
  sourceCount: 40,
  tagsAdded: ["RCT"],
  tagsRemoved: [],
  typeChanged: 0,
  collections: [],
  undone: false,
  left: 0,
};
const merge: Extract<ScientSourcesRecentChange, { kind: "merge" }> = {
  kind: "merge",
  id: "merge_1",
  at,
  by: "user",
  automatic: true,
  keptSourceId: "source_keep",
  keptTitle: "Sleep and memory",
  mergedTitle: null,
  undo: "available",
};

describe("the words of a recent change", () => {
  it("says what a bulk edit did and to how many sources", () => {
    expect(recentChangeSentence(bulk)).toBe("Added the tag RCT: 40 sources");
    expect(
      recentChangeSentence({
        ...bulk,
        sourceCount: 1,
        tagsAdded: ["a", "b"],
        tagsRemoved: ["old"],
        typeChanged: 1,
        collections: [
          { name: "Methods", added: 1, removed: 0, created: false },
          { name: null, added: 0, removed: 1, created: false },
        ],
      }),
    ).toBe(
      "Added 2 tags, removed the tag old, changed the type, added to the collection Methods, removed from a deleted collection: 1 source",
    );
  });

  it("does not call a bulk edit undone when Undo left some of it", () => {
    expect(recentChangeState(bulk)).toBeNull();
    expect(recentChangeState({ ...bulk, undone: true })).toBe("Undone");
    expect(recentChangeState({ ...bulk, undone: true, left: 3 })).toBe(
      "Undone; 3 changed since and were left",
    );
  });

  it("names both papers of a merge and keeps who ran an automatic one", () => {
    expect(recentChangeSentence(merge)).toBe("Merged “Untitled source” into “Sleep and memory”");
    expect(recentChangeBy(merge)).toBe("You · automatic merge");
    expect(recentChangeBy({ ...merge, automatic: false, by: "agent" })).toBe("Agent");
    expect(recentChangeState({ ...merge, undo: "merged-source-gone" })).toMatch(
      /^Can no longer be undone/u,
    );
  });

  it("says how many imported sources are in the Library now when that is fewer", () => {
    const imported: ScientSourcesRecentChange = {
      kind: "import",
      id: "op_1",
      at,
      by: "agent",
      intake: "zotero",
      outcome: "completed",
      imported: 10,
      available: 10,
      failed: 0,
    };
    expect(recentChangeSentence(imported)).toBe("Imported 10 sources from Zotero");
    expect(
      recentChangeSentence({
        ...imported,
        outcome: "cancelled",
        failed: 2,
        available: 7,
      }),
    ).toBe("Import stopped: imported 10 sources from Zotero · 2 failed · 7 in the Library now");
  });
});
