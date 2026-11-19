// @effect-diagnostics nodeBuiltinImport:off -- This test verifies the Node filesystem adapter.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it, vi } from "@effect/vitest";

import { bulkUpdateScientSources } from "./collections.ts";
import {
  listScientLibraryImportSources,
  listScientLibraryRecentChanges,
} from "./libraryChanges.ts";
import { mergeScientLibrarySources } from "./libraryMerge.ts";
import { ensureScientLibrary, scientLibraryLocation } from "./libraryRoot.ts";
import type { ScientSourceCandidate } from "./model.ts";
import {
  createSourceImportOperation,
  importScientSource,
  importScientSourceOperationItem,
  removeScientSource,
  updateSourceImportOperationItem,
} from "./store.ts";
import { sourceCandidate } from "./testing/sourceFixtures.ts";

const fixtures: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(
    fixtures.splice(0).map((root) => NodeFSP.rm(root, { recursive: true, force: true })),
  );
});

function candidate(sourceKey: string, title: string): ScientSourceCandidate {
  return sourceCandidate({
    sourceKey,
    title,
    creators: [
      { creatorType: "author", givenName: "Ada", familyName: "Lovelace", literalName: null },
    ],
    issuedRaw: "2026",
    issuedYear: 2026,
    identifiers: [{ scheme: "doi", value: `10.1000/${sourceKey.toLowerCase()}` }],
    containerTitle: "Journal",
  });
}

describe("the Library's recent changes", () => {
  it("lists an import, a merge, a bulk edit and a removal, newest first", async () => {
    const base = await NodeFSP.realpath(
      await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-library-changes-")),
    );
    fixtures.push(base);
    const root = NodePath.join(base, "scient", "library");
    await ensureScientLibrary(root);
    const library = scientLibraryLocation(root);
    // The order asserted below is by time: a clock set after the import moves a second per change.
    vi.useFakeTimers({ toFake: ["Date"] });
    let clock = Date.UTC(2100, 0, 1);
    const later = () => vi.setSystemTime((clock += 1000));

    // An import of two sources from a reference file, by an agent.
    const operationId = NodeCrypto.randomUUID();
    await createSourceImportOperation({
      root: library,
      operationId,
      adapter: "file",
      intake: "file",
      actor: "agent",
      itemKeys: ["A1", "B2"],
    });
    const imported: string[] = [];
    for (const [key, title] of [
      ["A1", "Sleep and memory"],
      ["B2", "Soil carbon budgets"],
    ] as const) {
      const result = await importScientSourceOperationItem({
        root: library,
        operationId,
        candidate: candidate(key, title),
      });
      imported.push(result.record!.sourceId);
      await updateSourceImportOperationItem({
        root: library,
        operationId,
        itemKey: key,
        state: "imported",
        sourceId: result.record!.sourceId,
      });
    }
    const [sleep, soil] = imported as [string, string];
    const other = (
      await importScientSource({
        root: library,
        operationId: NodeCrypto.randomUUID(),
        candidate: candidate("C3", "Sleep and memory, a copy"),
      })
    ).record!;

    // The first import's paper is merged into a later copy, the other is tagged, then removed.
    later();
    const merged = await mergeScientLibrarySources({
      library,
      sourceIds: [other.sourceId, sleep],
      survivorId: other.sourceId,
    });
    if (merged.outcome !== "merged") throw new Error(`Not merged: ${merged.outcome}`);
    later();
    const tagged = await bulkUpdateScientSources({
      root: library,
      change: { sourceIds: [soil, other.sourceId], addTags: ["Screened"] },
      actor: "user",
    });
    const soilNow = tagged.sources.find((entry) => entry.sourceId === soil)!;
    later();
    await removeScientSource({
      root: library,
      sourceId: soil,
      expectedRevision: soilNow.revision!,
      actor: "agent",
    });

    const listed = await listScientLibraryRecentChanges(library, 10);
    expect(listed.more).toBe(false);
    expect(listed.changes).toMatchObject([
      { kind: "trash", id: soil, by: "agent", title: "Soil carbon budgets" },
      {
        kind: "bulk-edit",
        id: tagged.undo?.batchId,
        by: "user",
        sourceCount: 2,
        tagsAdded: ["Screened"],
        undone: false,
      },
      {
        kind: "merge",
        id: merged.merge.mergeId,
        automatic: false,
        keptSourceId: other.sourceId,
        keptTitle: "Sleep and memory, a copy",
        mergedTitle: "Sleep and memory",
        undo: "available",
      },
      // One imported paper lives on in the copy that kept it; the other is in the Trash.
      {
        kind: "import",
        id: operationId,
        by: "agent",
        intake: "file",
        outcome: "completed",
        imported: 2,
        available: 1,
        failed: 0,
      },
    ]);
    expect(await listScientLibraryImportSources(library, operationId)).toEqual([other.sourceId]);
    // The copy a merge took away is not a removal.
    expect(listed.changes.filter((change) => change.kind === "trash")).toHaveLength(1);

    const firstTwo = await listScientLibraryRecentChanges(library, 2);
    expect(firstTwo.changes.map((change) => change.kind)).toEqual(["trash", "bulk-edit"]);
    expect(firstTwo.more).toBe(true);
  });
});
