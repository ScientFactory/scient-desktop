import type { ScientSourcesRecentChange } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  recentChangeBy,
  recentChangeDetail,
  recentChangeSentence,
  recentChangeState,
} from "./recentChangeLabels";

const at = "2026-11-14T09:00:00.000Z";
const bulk: Extract<ScientSourcesRecentChange, { kind: "bulk-edit" }> = {
  kind: "bulk-edit",
  id: "bulk_1",
  at,
  by: "user",
  parts: [{ batchId: "bulk_1", sourceCount: 40, undone: false }],
  partsMissing: false,
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

  it("says when the first requests of an old, large edit are no longer on record", () => {
    expect(recentChangeSentence({ ...bulk, partsMissing: true })).toBe(
      "Added the tag RCT: 40 sources (the rest of a larger edit; its earlier part is no longer on record)",
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

  it("says what a restore brought back and where the Library it replaced is kept", () => {
    const restore: ScientSourcesRecentChange = {
      kind: "restore",
      id: "restore_1",
      at,
      by: "user",
      backupCreatedAt: "2026-11-10T08:00:00.000Z",
      sources: 1204,
      pdfs: 980,
      kept: { path: "/state/scient/library.replaced-restore_1", sources: 4 },
    };
    const day = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(
      new Date(restore.backupCreatedAt),
    );
    expect(recentChangeSentence(restore)).toBe(
      `Restored the Library from the backup of ${day}: 1,204 sources`,
    );
    // While the replaced Library is kept the row offers its sources and says where it is.
    expect(recentChangeState(restore)).toBeNull();
    expect(recentChangeDetail(restore)).toBe(
      "The Library that was here (4 sources) is kept in /state/scient/library.replaced-restore_1",
    );
    expect(recentChangeState({ ...restore, kept: null })).toBe("Nothing was kept from before");
    expect(recentChangeDetail({ ...restore, kept: null })).toBeNull();
  });

  it("says what was added from another Library, what was left, and how an Undo went", () => {
    const join: ScientSourcesRecentChange = {
      kind: "join",
      id: "join_1",
      at,
      by: "user",
      from: "backup",
      backupCreatedAt: "2026-11-10T08:00:00.000Z",
      state: "done",
      added: 1,
      different: 0,
      removedHere: 0,
      left: 0,
    };
    const day = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(
      new Date("2026-11-10T08:00:00.000Z"),
    );
    expect(recentChangeSentence(join)).toBe(`Added 1 source from the backup of ${day}`);
    expect(recentChangeState(join)).toBeNull();
    expect(recentChangeSentence({ ...join, state: "stopped", added: 40, different: 2 })).toBe(
      `Stopped part way: added 40 sources from the backup of ${day} · 2 that both hold left as here`,
    );
    expect(recentChangeState({ ...join, added: 0 })).toBe("Nothing was new");
    expect(recentChangeState({ ...join, state: "undone", left: 3 })).toBe(
      "Undone; 3 changed since and were left",
    );
    expect(recentChangeState({ ...join, state: "undone" })).toBe("Undone");
  });
});
