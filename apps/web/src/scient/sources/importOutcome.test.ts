import { describe, expect, it } from "vite-plus/test";

import type { ScientSourceImportOperation, ScientSourcesPreflightResult } from "@t3tools/contracts";

import {
  completedImportCounts,
  importedSourceIdToReveal,
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
});
