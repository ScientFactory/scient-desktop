import { describe, expect, it } from "vite-plus/test";

import type { ScientSourceImportOperation, ScientSourcesPreflightResult } from "@t3tools/contracts";

import {
  completedImportCounts,
  describeImport,
  importedSourceIdToReveal,
  importedSourceIds,
  preflightImportCounts,
  reviewedImportCounts,
  type ScientSourcesImportOutcome,
} from "./importOutcome";

function operation(items: ScientSourceImportOperation["items"]): ScientSourceImportOperation {
  return {
    formatVersion: 1,
    operationId: "operation-1",
    projectId: "project-1",
    adapter: "local-files",
    actor: "user",
    intake: "local-pdf",
    state: "completed",
    createdAt: "2026-08-13T00:00:00.000Z",
    updatedAt: "2026-08-13T00:00:01.000Z",
    items,
  };
}

function preflight(
  kinds: ReadonlyArray<ScientSourcesPreflightResult["items"][number]["duplicate"]["kind"]>,
): ScientSourcesPreflightResult {
  return {
    items: kinds.map((kind, index) => ({
      candidate: {
        sourceKey: `source-${index}`,
        type: "article",
        customType: null,
        title: `Source ${index}`,
        creators: [],
        issuedRaw: null,
        issuedYear: null,
        identifiers: [],
        abstract: null,
        containerTitle: null,
        publisher: null,
        volume: null,
        issue: null,
        pages: null,
        language: null,
        url: null,
        tags: [],
        externalReferences: [],
        fieldProvenance: [],
        pdfAvailable: false,
        pdfFileName: null,
        pdfAttachmentCount: 0,
      },
      duplicate: {
        kind,
        matchingSourceIds: kind === "new" ? [] : [`existing-${index}`],
        reason: kind,
      },
      metadataDiagnostics: [],
    })),
  };
}

describe("Scient Sources import outcomes", () => {
  it("separates exact duplicates from possible matches during preflight", () => {
    expect(
      preflightImportCounts(
        preflight(["new", "same-origin", "same-identifier", "same-pdf", "possible-metadata-match"]),
      ),
    ).toEqual({ imported: 0, alreadyPresent: 3, reviewRequired: 1, failed: 0 });
  });

  it("keeps unconfirmed possible matches separate in a mixed multi-file import", () => {
    const result = preflight(["new", "same-pdf", "possible-metadata-match"]);
    expect(reviewedImportCounts(result, new Set(["source-0"]))).toEqual({
      imported: 0,
      alreadyPresent: 1,
      reviewRequired: 1,
      failed: 0,
    });
  });

  it("reports imported, already-present, review-required, and failed items separately", () => {
    expect(
      completedImportCounts(
        operation([
          {
            itemKey: "imported",
            state: "imported",
            duplicateKind: "new",
            sourceId: "source-imported",
            message: null,
          },
          {
            itemKey: "duplicate",
            state: "skipped",
            duplicateKind: "same-pdf",
            sourceId: null,
            message: "Same PDF",
          },
          {
            itemKey: "review",
            state: "skipped",
            duplicateKind: "possible-metadata-match",
            sourceId: null,
            message: "Possible match",
          },
          {
            itemKey: "failed",
            state: "failed",
            sourceId: null,
            message: "Failed",
          },
        ]),
      ),
    ).toEqual({ imported: 1, alreadyPresent: 1, reviewRequired: 1, failed: 1 });
  });

  it("reveals only a newly imported source and never redirects to an existing duplicate", () => {
    const base = {
      operation: null,
      counts: { imported: 0, alreadyPresent: 1, reviewRequired: 0, failed: 0 },
    } as const;
    const duplicate: ScientSourcesImportOutcome = {
      ...base,
      kind: "already-present",
      sourceId: null,
      existingSourceId: "existing-source",
    };
    const imported: ScientSourcesImportOutcome = {
      ...base,
      kind: "imported",
      sourceId: "new-source",
      existingSourceId: null,
    };

    expect(importedSourceIdToReveal(duplicate)).toBeNull();
    expect(importedSourceIdToReveal(imported)).toBe("new-source");
  });

  it("returns every newly imported source from a bulk outcome", () => {
    const outcome: ScientSourcesImportOutcome = {
      kind: "imported",
      operation: operation([
        {
          itemKey: "one",
          state: "imported",
          duplicateKind: "new",
          sourceId: "source-one",
          message: null,
        },
        {
          itemKey: "two",
          state: "imported",
          duplicateKind: "new",
          sourceId: "source-two",
          message: null,
        },
      ]),
      sourceId: null,
      existingSourceId: null,
      counts: { imported: 2, alreadyPresent: 0, reviewRequired: 0, failed: 0 },
    };

    expect(importedSourceIds(outcome)).toEqual(["source-one", "source-two"]);
  });
});

type Item = ScientSourceImportOperation["items"][number];

/** A file import begun from a project of My Library: each source is added to the project. */
function fileImport(items: ReadonlyArray<Item>): ScientSourceImportOperation {
  return {
    formatVersion: 2,
    operationId: "file-1",
    libraryId: "library-1",
    pinInstanceId: "instance-1",
    adapter: "file",
    actor: "user",
    intake: "file",
    state: "completed",
    createdAt: "2026-11-15T09:00:00.000Z",
    updatedAt: "2026-11-15T09:01:00.000Z",
    items,
  };
}

const kitReport = {
  format: "bibtex" as const,
  entryCount: 7,
  importCount: 6,
  alreadyInLibrary: 0,
  remaining: 0,
  unreadableCount: 0,
  unreadable: [],
  sameWork: [
    { citationKey: "lecun2015deep_copy", line: 41, sameAs: "lecun2015deep", identifier: "DOI" },
  ],
  incompleteAuthors: [{ sourceKey: "alphafold", label: "jumper2021alphafold", named: 3 }],
  notKept: [],
  withoutCitationKey: 0,
};

function kitItems(authorList: "completed" | "incomplete"): Item[] {
  return ["vaswani", "lecun", "alphafold", "he", "silver", "goodfellow"].map((itemKey) => ({
    itemKey,
    state: "imported",
    sourceId: `source_${itemKey}`,
    message: null,
    ...(itemKey === "lecun"
      ? {
          citationKeys: [
            { citationKey: "lecun2015deep", outcome: "added" as const },
            { citationKey: "lecun2015deep_copy", outcome: "added" as const },
          ],
        }
      : {}),
    ...(itemKey === "alphafold" ? { authorList } : {}),
  }));
}

const titleOf = (sourceId: string) => (sourceId === "source_alphafold" ? "AlphaFold" : null);

describe("what a finished import says it did", () => {
  it("says first what a reference file brought, then its exceptions in plain words", () => {
    const receipt = describeImport({
      operation: fileImport(kitItems("completed")),
      outcome: null,
      referenceFile: { name: "references.bib", report: kitReport },
      target: "project",
      sourceTitle: titleOf,
    });
    expect(receipt).toMatchObject({
      tone: "success",
      headline: "6 references imported and added to this project",
      notes: [
        "7 entries describe 6 works; lecun2015deep_copy cites the same paper as lecun2015deep",
        "AlphaFold: full author list taken from its DOI",
      ],
    });
    expect(
      describeImport({
        operation: fileImport(kitItems("incomplete")),
        outcome: null,
        referenceFile: { name: "references.bib", report: kitReport },
        target: "project",
        sourceTitle: titleOf,
      }).notes[1],
    ).toBe("AlphaFold lists 3 authors and others; the full list was unavailable");
  });

  it("counts what came in from the finished items, not from what the file staged", () => {
    const items = kitItems("completed");
    items[0] = { ...items[0]!, state: "failed", sourceId: null, message: "The disk is full." };
    const receipt = describeImport({
      operation: fileImport(items),
      outcome: null,
      referenceFile: { name: "references.bib", report: kitReport },
      target: "project",
    });
    expect(receipt.headline).toBe("5 references imported and added to this project");
    expect(receipt.notes).toContain("1 could not be imported");
    expect(receipt).toMatchObject({ tone: "error", failures: ["The disk is full."] });
  });

  it("tells a file's works already in this project from those added from My Library", () => {
    const present = (itemKey: string, outcome: "added" | "cited"): Item => ({
      itemKey,
      state: "skipped",
      duplicateKind: "same-identifier",
      sourceId: `source_${itemKey}`,
      message: null,
      citationKeys: [{ citationKey: itemKey, outcome }],
    });
    const { sameWork: _same, incompleteAuthors: _authors, ...plain } = kitReport;
    const receiptFor = (items: ReadonlyArray<Item>) =>
      describeImport({
        operation: fileImport(items),
        outcome: null,
        referenceFile: {
          name: "references.bib",
          report: { ...plain, entryCount: items.length, importCount: 0 },
        },
        target: "project",
      });
    expect(receiptFor([present("a", "cited"), present("b", "cited")]).headline).toBe(
      "2 references were already in this project",
    );
    expect(
      receiptFor([present("a", "added"), present("b", "added"), present("c", "cited")]),
    ).toMatchObject({
      tone: "success",
      headline: "2 references added to this project from My Library",
      notes: ["1 was already in this project"],
    });
  });

  it("says where an import into My Library put its sources and what it already had", () => {
    const { pinInstanceId: _pin, ...libraryImport } = fileImport([
      { itemKey: "one", state: "imported", sourceId: "source-one", message: null },
    ]);
    const receipt = describeImport({
      operation: { ...libraryImport, adapter: "zotero", intake: "zotero" },
      outcome: {
        kind: "imported",
        operation: null,
        sourceId: null,
        existingSourceId: null,
        counts: { imported: 1, alreadyPresent: 2, reviewRequired: 0, failed: 0 },
      },
      referenceFile: null,
      target: "library",
    });
    expect(receipt).toMatchObject({
      headline: "1 reference imported and added to My Library",
      notes: ["2 were already in My Library"],
      libraryOnlySourceIds: ["source-one"],
    });
  });

  it("words PDFs already in a project as such, never as selected sources", () => {
    const receipt = describeImport({
      operation: null,
      outcome: {
        kind: "already-present",
        operation: null,
        sourceId: null,
        existingSourceId: "existing",
        counts: { imported: 0, alreadyPresent: 1, reviewRequired: 0, failed: 0 },
      },
      referenceFile: null,
      target: "project-folder",
      intake: "local-pdf",
    });
    expect(receipt).toMatchObject({
      tone: "info",
      headline: "1 PDF was already in this project",
      notes: [],
      existingSourceId: "existing",
    });
  });
});
