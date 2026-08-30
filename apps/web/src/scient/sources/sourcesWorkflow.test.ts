import type {
  ScientSourceImportOperation,
  ScientSourcesOverviewResult,
  ScientSourcesPreflightResult,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  emptyZoteroPage,
  importOutcomeFromOperation,
  initialSourcesWorkflowState,
  sourcesWorkflowReducer,
  type SourcesWorkflowState,
} from "./sourcesWorkflow";

function overviewWith(
  records: Partial<ScientSourcesOverviewResult["records"][number]>[],
  activeOperation: ScientSourceImportOperation | null = null,
): ScientSourcesOverviewResult {
  return {
    projectState: "initialized",
    issues: [],
    recordDiagnostics: [],
    records: records.map((record) => ({
      sourceId: "source-1",
      revision: 1,
      type: "article",
      title: "A title",
      creators: [],
      issuedYear: 2024,
      identifiers: [],
      containerTitle: null,
      url: null,
      externalReferences: [],
      attachments: [],
      importedAt: "2026-08-13T00:00:00.000Z",
      ...record,
    })),
    activeOperation,
  };
}

function detail(overrides: { sourceId?: string; revision?: number } = {}) {
  return {
    formatVersion: 1 as const,
    sourceId: overrides.sourceId ?? "source-1",
    projectId: "project",
    revision: overrides.revision ?? 1,
    type: "article" as const,
    customType: null,
    title: "A title",
    creators: [],
    issuedRaw: null,
    issuedYear: 2024,
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
    attachments: [],
    fieldProvenance: [],
    importedAt: "2026-08-13T00:00:00.000Z",
  };
}

function operation(
  states: ReadonlyArray<"pending" | "imported" | "skipped" | "failed">,
): ScientSourceImportOperation {
  return {
    formatVersion: 1,
    operationId: "op-1",
    projectId: "project",
    adapter: "local-files",
    actor: "user",
    intake: "local-pdf",
    state: states.includes("pending") ? "running" : "completed",
    createdAt: "2026-08-13T00:00:00.000Z",
    updatedAt: "2026-08-13T00:00:00.000Z",
    items: states.map((state, index) => ({
      itemKey: `item-${index}`,
      state,
      sourceId: state === "imported" ? `source-${index}` : null,
      ...(state === "skipped" ? { duplicateKind: "same-pdf" as const } : {}),
      message: null,
    })),
  };
}

function preflightWith(
  duplicateKinds: ScientSourcesPreflightResult["items"][number]["duplicate"]["kind"][],
): ScientSourcesPreflightResult {
  return {
    items: duplicateKinds.map((kind, index) => ({
      candidate: {
        sourceKey: `key-${index}`,
        type: "article",
        title: `Item ${index}`,
        creators: [],
        issuedRaw: null,
        issuedYear: 2024,
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
        pdfFileName: null,
        pdfAvailable: false,
        pdfAttachmentCount: 0,
      },
      duplicate: {
        kind,
        matchingSourceIds: kind === "new" ? [] : ["existing-1"],
        reason: "assessed",
      },
      metadataDiagnostics: [],
    })),
  };
}

function reduceAll(
  state: SourcesWorkflowState,
  ...actions: Parameters<typeof sourcesWorkflowReducer>[1][]
): SourcesWorkflowState {
  return actions.reduce(sourcesWorkflowReducer, state);
}

describe("sources workflow tokens", () => {
  it("drops an overview response whose request token was superseded", () => {
    const started = sourcesWorkflowReducer(initialSourcesWorkflowState, {
      type: "overviewRequestStarted",
      request: 1,
    });
    const superseded = sourcesWorkflowReducer(started, {
      type: "overviewRequestStarted",
      request: 2,
    });
    const stale = sourcesWorkflowReducer(superseded, {
      type: "overviewArrived",
      request: 1,
      overview: overviewWith([{ sourceId: "late" }]),
    });
    expect(stale.overview).toBeNull();

    const fresh = sourcesWorkflowReducer(superseded, {
      type: "overviewArrived",
      request: 2,
      overview: overviewWith([{ sourceId: "current" }]),
    });
    expect(fresh.overview?.records[0]?.sourceId).toBe("current");
  });

  it("keeps import progress alive across an overview refresh on another lane", () => {
    // Live-refresh repeats overview loads while a durable import runs; the
    // overview lane must never invalidate import progress updates.
    const importing = reduceAll(
      initialSourcesWorkflowState,
      { type: "requestStarted", request: 1 },
      {
        type: "operationArrived",
        request: 1,
        operation: operation(["pending", "imported"]),
      },
    );
    const refreshed = reduceAll(
      importing,
      { type: "overviewRequestStarted", request: 7 },
      {
        type: "overviewArrived",
        request: 7,
        overview: overviewWith([], null),
      },
      {
        type: "operationArrived",
        request: 1,
        operation: operation(["imported", "imported"]),
      },
    );
    expect(refreshed.operation?.items.map((item) => item.state)).toEqual(["imported", "imported"]);
  });

  it("keeps a Zotero page alive across an overview refresh on another lane", () => {
    const browsing = reduceAll(
      initialSourcesWorkflowState,
      { type: "zoteroRequestStarted", request: 3 },
      { type: "requestStarted", request: 1 },
      {
        type: "zoteroLibraryArrived",
        request: 3,
        page: {
          scope: { kind: "library" },
          items: [],
          start: 0,
          nextStart: 0,
          total: 0,
          hasMore: false,
        },
      },
    );
    expect(browsing.library).not.toBeNull();
  });

  it("drops a late operation update after a newer import request started", () => {
    const started = sourcesWorkflowReducer(initialSourcesWorkflowState, {
      type: "requestStarted",
      request: 1,
    });
    const newer = sourcesWorkflowReducer(started, { type: "requestStarted", request: 2 });
    const rejected = sourcesWorkflowReducer(newer, {
      type: "operationArrived",
      request: started.request,
      operation: operation(["imported"]),
    });
    expect(rejected.operation).toBeNull();
  });

  it("drops a late Zotero page after a newer Zotero request started", () => {
    const started = sourcesWorkflowReducer(initialSourcesWorkflowState, {
      type: "zoteroRequestStarted",
      request: 1,
    });
    const newer = sourcesWorkflowReducer(started, { type: "zoteroRequestStarted", request: 2 });
    const rejected = sourcesWorkflowReducer(newer, {
      type: "zoteroLibraryArrived",
      request: 1,
      page: {
        scope: { kind: "library" },
        items: [],
        start: 0,
        nextStart: 0,
        total: 0,
        hasMore: false,
      },
    });
    expect(rejected.library).toBeNull();
  });

  it("seeds a Zotero page without a request token so it always lands", () => {
    const seeded = sourcesWorkflowReducer(initialSourcesWorkflowState, {
      type: "zoteroLibrarySeeded",
      page: emptyZoteroPage({ kind: "library" }),
    });
    expect(seeded.library?.items).toEqual([]);
    expect(seeded.library?.total).toBe(0);
  });

  it("clears a previous operation summary when an intake flow starts", () => {
    const withOperation = sourcesWorkflowReducer(initialSourcesWorkflowState, {
      type: "operationArrived",
      request: 1,
      operation: operation(["imported"]),
    });
    const cleared = sourcesWorkflowReducer(withOperation, { type: "operationCleared" });
    expect(cleared.operation).toBeNull();
  });

  it("invalidates every in-flight request when the project context changes", () => {
    const started = reduceAll(
      initialSourcesWorkflowState,
      { type: "requestStarted", request: 1 },
      { type: "overviewRequestStarted", request: 1 },
      {
        type: "overviewArrived",
        request: 1,
        overview: overviewWith([{ sourceId: "old-context" }]),
      },
    );
    const reset = sourcesWorkflowReducer(started, {
      type: "contextReset",
      request: 2,
      overviewRequest: 2,
      zoteroRequest: 1,
    });
    expect(reset.overview).toBeNull();
    expect(reset.operation).toBeNull();
    expect(reset.request).toBe(2);
    expect(reset.overviewRequest).toBe(2);
    expect(reset.zoteroRequest).toBe(1);
    const late = sourcesWorkflowReducer(reset, {
      type: "overviewArrived",
      request: started.overviewRequest,
      overview: overviewWith([{ sourceId: "late" }]),
    });
    expect(late.overview).toBeNull();
  });
});

describe("sources workflow data consistency", () => {
  it("adopts a running operation discovered in an overview snapshot", () => {
    const started = sourcesWorkflowReducer(initialSourcesWorkflowState, {
      type: "overviewRequestStarted",
      request: 1,
    });
    const running = operation(["pending", "imported"]);
    const state = sourcesWorkflowReducer(started, {
      type: "overviewArrived",
      request: 1,
      overview: overviewWith([{ sourceId: "source-1" }], running),
    });
    expect(state.operation).toEqual(running);
  });

  it("keeps a newer local operation when the overview has none", () => {
    const started = sourcesWorkflowReducer(initialSourcesWorkflowState, {
      type: "requestStarted",
      request: 1,
    });
    const withOperation = sourcesWorkflowReducer(started, {
      type: "operationArrived",
      request: started.request,
      operation: operation(["pending"]),
    });
    const refreshed = sourcesWorkflowReducer(withOperation, {
      type: "overviewArrived",
      request: 1,
      overview: overviewWith([], null),
    });
    expect(refreshed.operation).toEqual(operation(["pending"]));
  });

  it("prunes cached details whose revision no longer matches the overview", () => {
    const started = sourcesWorkflowReducer(initialSourcesWorkflowState, {
      type: "overviewRequestStarted",
      request: 1,
    });
    const withDetails = reduceAll(
      started,
      {
        type: "sourceDetailArrived",
        sourceId: "current",
        detail: detail({ sourceId: "current", revision: 2 }),
      },
      {
        type: "sourceDetailArrived",
        sourceId: "stale",
        detail: detail({ sourceId: "stale", revision: 7 }),
      },
    );
    const refreshed = sourcesWorkflowReducer(withDetails, {
      type: "overviewArrived",
      request: 1,
      overview: overviewWith([
        { sourceId: "current", revision: 2 },
        { sourceId: "stale", revision: 9 },
      ]),
    });
    expect(Object.keys(refreshed.sourceDetails).toSorted()).toEqual(["current"]);
  });

  it("accepts an edited record into details and the overview projection", () => {
    const started = sourcesWorkflowReducer(initialSourcesWorkflowState, {
      type: "overviewRequestStarted",
      request: 1,
    });
    const withOverview = sourcesWorkflowReducer(started, {
      type: "overviewArrived",
      request: 1,
      overview: overviewWith([{ sourceId: "source-1", title: "Old title" }]),
    });
    const accepted = sourcesWorkflowReducer(withOverview, {
      type: "sourceRecordAccepted",
      record: detail({ sourceId: "source-1", revision: 2 }),
    });
    expect(accepted.sourceDetails["source-1"]?.revision).toBe(2);
    expect(accepted.overview?.records[0]?.revision).toBe(2);
  });

  it("removes a deleted source from details, records, and diagnostics together", () => {
    const started = sourcesWorkflowReducer(initialSourcesWorkflowState, {
      type: "overviewRequestStarted",
      request: 1,
    });
    const base = reduceAll(
      started,
      {
        type: "overviewArrived",
        request: 1,
        overview: {
          ...overviewWith([{ sourceId: "gone" }, { sourceId: "kept" }]),
          recordDiagnostics: [
            { sourceId: "gone", diagnostics: [] },
            { sourceId: "kept", diagnostics: [] },
          ],
        },
      },
      {
        type: "sourceDetailArrived",
        sourceId: "gone",
        detail: detail({ sourceId: "gone" }),
      },
    );
    const removed = sourcesWorkflowReducer(base, { type: "sourceRemoved", sourceId: "gone" });
    expect(removed.sourceDetails["gone"]).toBeUndefined();
    expect(removed.overview?.records.map((record) => record.sourceId)).toEqual(["kept"]);
    expect(removed.overview?.recordDiagnostics.map((entry) => entry.sourceId)).toEqual(["kept"]);
  });
});

describe("sources workflow import transitions", () => {
  it("routes a possible-match preflight into review and clears preparation", () => {
    const started = sourcesWorkflowReducer(initialSourcesWorkflowState, {
      type: "requestStarted",
      request: 1,
    });
    const reviewing = sourcesWorkflowReducer(started, {
      type: "preflightArrived",
      request: started.request,
      preflight: preflightWith(["new", "possible-metadata-match"]),
      adapter: "local-files",
    });
    expect(reviewing.preflight?.items).toHaveLength(2);
    expect(reviewing.preflightAdapter).toBe("local-files");
    expect(reviewing.importPreparation).toBeNull();
  });

  it("clears preflight and library state when an operation starts", () => {
    const started = sourcesWorkflowReducer(initialSourcesWorkflowState, {
      type: "requestStarted",
      request: 1,
    });
    const prepared = reduceAll(
      started,
      {
        type: "preflightArrived",
        request: started.request,
        preflight: preflightWith(["new"]),
        adapter: "zotero",
      },
      { type: "zoteroLibraryClosed" },
      { type: "importPreparationChanged", preparation: { kind: "zotero", count: 3 } },
    );
    expect(prepared.library).toBeNull();
    const running = sourcesWorkflowReducer(prepared, {
      type: "operationArrived",
      request: started.request,
      operation: operation(["pending"]),
      clearLibrary: true,
      clearPreflight: true,
    });
    expect(running.operation?.state).toBe("running");
    expect(running.preflight).toBeNull();
    expect(running.preflightAdapter).toBeNull();
    expect(running.importPreparation).toBeNull();
  });

  it("keeps the ledger usable when one item fails mid-operation", () => {
    const started = sourcesWorkflowReducer(initialSourcesWorkflowState, {
      type: "requestStarted",
      request: 1,
    });
    const failed = sourcesWorkflowReducer(started, {
      type: "operationArrived",
      request: started.request,
      operation: operation(["imported", "failed", "pending"]),
    });
    expect(failed.operation?.state).toBe("running");
    expect(failed.operation?.items.map((item) => item.state)).toEqual([
      "imported",
      "failed",
      "pending",
    ]);
  });

  it("summarizes a completed single-item import for reveal", () => {
    const outcome = importOutcomeFromOperation({
      operation: operation(["imported"]),
      revealSingleSource: true,
    });
    expect(outcome.kind).toBe("imported");
    expect(outcome.sourceId).toBe("source-0");
  });

  it("classifies an all-duplicates operation as already-present", () => {
    const outcome = importOutcomeFromOperation({
      operation: operation(["skipped", "skipped"]),
      revealSingleSource: false,
    });
    expect(outcome.kind).toBe("already-present");
    expect(outcome.counts.alreadyPresent).toBe(2);
  });

  it("classifies a failed-only operation as review-required, not success", () => {
    // Failures are never a success summary; the panel shows the retry path.
    const outcome = importOutcomeFromOperation({
      operation: operation(["failed", "failed"]),
      revealSingleSource: false,
    });
    expect(outcome.kind).toBe("review-required");
    expect(outcome.counts).toEqual({
      imported: 0,
      alreadyPresent: 0,
      reviewRequired: 0,
      failed: 2,
    });
  });

  it("keeps preparation visible only while the starting request is current", () => {
    const started = sourcesWorkflowReducer(initialSourcesWorkflowState, {
      type: "requestStarted",
      request: 1,
    });
    const prepared = sourcesWorkflowReducer(started, {
      type: "importPreparationChanged",
      preparation: { kind: "local-files", names: ["a.pdf"] },
    });
    const superseded = sourcesWorkflowReducer(prepared, { type: "requestStarted", request: 2 });
    const late = sourcesWorkflowReducer(superseded, {
      type: "operationArrived",
      request: started.request,
      operation: operation(["pending"]),
    });
    expect(late.importPreparation).toEqual({ kind: "local-files", names: ["a.pdf"] });
    expect(late.operation).toBeNull();
  });
});

describe("sources workflow transient flags", () => {
  it("clears busy state through an explicit flag change even when requests race", () => {
    const started = reduceAll(
      initialSourcesWorkflowState,
      { type: "requestStarted", request: 1 },
      { type: "busyChanged", busy: true },
    );
    const cleared = sourcesWorkflowReducer(started, { type: "busyChanged", busy: false });
    expect(cleared.busy).toBe(false);
  });

  it("stores Zotero feedback only alongside its status", () => {
    const state = sourcesWorkflowReducer(initialSourcesWorkflowState, {
      type: "zoteroStatusArrived",
      status: { state: "unreachable", apiVersion: null, message: "" },
      feedback: "Zotero is still unavailable.",
    });
    expect(state.zoteroStatus?.state).toBe("unreachable");
    expect(state.zoteroCheckFeedback).toBe("Zotero is still unavailable.");
  });

  it("dismisses the Zotero status screen entirely, including feedback", () => {
    const withStatus = sourcesWorkflowReducer(initialSourcesWorkflowState, {
      type: "zoteroStatusArrived",
      status: { state: "unreachable", apiVersion: null, message: "" },
      feedback: "Zotero is still unavailable.",
    });
    const dismissed = sourcesWorkflowReducer(withStatus, { type: "zoteroStatusDismissed" });
    expect(dismissed.zoteroStatus).toBeNull();
    expect(dismissed.zoteroCheckFeedback).toBeNull();
  });

  it("accepts a source detail without a request token so details land mid-import", () => {
    const started = sourcesWorkflowReducer(initialSourcesWorkflowState, {
      type: "requestStarted",
      request: 1,
    });
    const superseded = sourcesWorkflowReducer(started, { type: "requestStarted", request: 2 });
    const arrived = sourcesWorkflowReducer(superseded, {
      type: "sourceDetailArrived",
      sourceId: "any",
      detail: detail({ sourceId: "any" }),
    });
    expect(arrived.sourceDetails["any"]?.revision).toBe(1);
  });

  it("clears errors explicitly without touching tokens", () => {
    const started = sourcesWorkflowReducer(initialSourcesWorkflowState, {
      type: "requestStarted",
      request: 1,
    });
    const withError = sourcesWorkflowReducer(started, {
      type: "errorArrived",
      error: "failed",
    });
    const cleared = sourcesWorkflowReducer(withError, { type: "errorCleared" });
    expect(cleared.error).toBeNull();
    expect(cleared.request).toBe(started.request);
  });

  it("lets an error ride along with import preparation for skip messages", () => {
    const state = sourcesWorkflowReducer(initialSourcesWorkflowState, {
      type: "importPreparationChanged",
      preparation: { kind: "local-files", names: ["ok.pdf"] },
      error: "Skipped 1 non-PDF file.",
    });
    expect(state.error).toBe("Skipped 1 non-PDF file.");
    expect(state.importPreparation?.kind).toBe("local-files");
  });
});
