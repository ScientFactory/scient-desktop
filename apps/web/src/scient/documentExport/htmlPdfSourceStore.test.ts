import {
  ArtifactAuthority,
  ArtifactId,
  ArtifactRevisionId,
  BindingGeneration,
  PdfSourceDescriptor,
} from "@scientfactory/document-artifacts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { trackedHtmlLogicalDocumentKey, type TrackedHtmlSource } from "./htmlPdfSource";
import {
  htmlPdfRelationId,
  normalizePersistedHtmlPdfRelations,
  readHtmlPdfRelation,
  useHtmlPdfSourceStore,
} from "./htmlPdfSourceStore";

const environmentId = EnvironmentId.make("environment-1");
const threadRef = scopeThreadRef(environmentId, ThreadId.make("thread-1"));
const otherThreadRef = scopeThreadRef(environmentId, ThreadId.make("thread-2"));
const source: TrackedHtmlSource = {
  _tag: "workspace-html",
  environmentId,
  workspaceRoot: "/workspace",
  relativePath: "reports/result.html",
  absolutePath: "/workspace/reports/result.html",
};
const logicalDocumentKey = trackedHtmlLogicalDocumentKey(source);

beforeEach(() => {
  useHtmlPdfSourceStore.setState({ relations: {} });
});

describe("HTML PDF source relations", () => {
  it("targets a manual update to the relation in the active thread", () => {
    const store = useHtmlPdfSourceStore.getState();
    store.bind({ threadRef, tabId: "tab-1", source, authorizedUrl: "https://one.test" });
    store.bind({
      threadRef: otherThreadRef,
      tabId: "tab-1",
      source,
      authorizedUrl: "https://two.test",
    });
    const firstId = htmlPdfRelationId(threadRef, logicalDocumentKey);
    const secondId = htmlPdfRelationId(otherThreadRef, logicalDocumentKey);

    useHtmlPdfSourceStore.getState().requestUpdate(firstId);

    expect(useHtmlPdfSourceStore.getState().relations[firstId]?.manualRequestId).toBe(1);
    expect(useHtmlPdfSourceStore.getState().relations[secondId]?.manualRequestId).toBe(0);
    expect(useHtmlPdfSourceStore.getState().relations[firstId]?.logicalDocumentKey).toBe(
      useHtmlPdfSourceStore.getState().relations[secondId]?.logicalDocumentKey,
    );
    expect(readHtmlPdfRelation(threadRef, "tab-1")?.id).toBe(firstId);
    expect(readHtmlPdfRelation(otherThreadRef, "tab-1")?.id).toBe(secondId);
  });

  it("preserves one artifact relation when the same document reopens in another Browser tab", () => {
    const id = htmlPdfRelationId(threadRef, logicalDocumentKey);
    useHtmlPdfSourceStore
      .getState()
      .bind({ threadRef, tabId: "tab-1", source, authorizedUrl: "https://old.test" });
    const generated = PdfSourceDescriptor.make({
      _tag: "generated-pdf",
      authority: ArtifactAuthority.make(environmentId),
      logicalDocumentKey: trackedHtmlLogicalDocumentKey(source),
      title: "Result",
      fileName: "Result.pdf",
      capabilities: { canSaveCopy: true, canRevealSource: false },
      artifactId: ArtifactId.make("artifact-1"),
      revisionId: ArtifactRevisionId.make("revision-1"),
      bindingGeneration: BindingGeneration.make(1),
      bindingStatus: "current",
      staleReason: null,
      pageCount: 1,
    });
    if (generated._tag !== "generated-pdf") throw new Error("expected generated PDF fixture");
    useHtmlPdfSourceStore.getState().recordExport(id, generated);

    useHtmlPdfSourceStore
      .getState()
      .bind({ threadRef, tabId: "tab-2", source, authorizedUrl: "https://renewed.test" });
    expect(useHtmlPdfSourceStore.getState().relations[id]).toMatchObject({
      artifactId: "artifact-1",
      tabId: "tab-2",
      authorizedUrl: "https://renewed.test",
    });
    expect(Object.keys(useHtmlPdfSourceStore.getState().relations)).toEqual([id]);
  });

  it("detaches an older document when its Browser tab opens another source", () => {
    const id = htmlPdfRelationId(threadRef, logicalDocumentKey);
    useHtmlPdfSourceStore
      .getState()
      .bind({ threadRef, tabId: "tab-1", source, authorizedUrl: "https://old.test" });

    const otherSource: TrackedHtmlSource = {
      ...source,
      relativePath: "reports/other.html",
      absolutePath: "/workspace/reports/other.html",
    };
    useHtmlPdfSourceStore.getState().bind({
      threadRef,
      tabId: "tab-1",
      source: otherSource,
      authorizedUrl: "https://other.test",
    });

    expect(useHtmlPdfSourceStore.getState().relations[id]).toMatchObject({
      tabId: null,
      authorizedUrl: null,
    });
    expect(
      useHtmlPdfSourceStore.getState().relations[
        htmlPdfRelationId(threadRef, trackedHtmlLogicalDocumentKey(otherSource))
      ],
    ).toMatchObject({ tabId: "tab-1", artifactId: null });
  });

  it("resumes a pending PDF update when its HTML source is reopened", () => {
    const id = htmlPdfRelationId(threadRef, logicalDocumentKey);
    useHtmlPdfSourceStore
      .getState()
      .bind({ threadRef, tabId: "tab-1", source, authorizedUrl: "https://old.test" });
    const current = useHtmlPdfSourceStore.getState().relations[id];
    if (!current) throw new Error("expected source relation");
    useHtmlPdfSourceStore.setState((state) => ({
      relations: {
        ...state.relations,
        [id]: {
          ...current,
          artifactId: "artifact-1",
          updatePhase: "update-available",
          updateMessage: "Open the HTML Browser tab to update this PDF.",
        },
      },
    }));

    useHtmlPdfSourceStore
      .getState()
      .bind({ threadRef, tabId: "tab-2", source, authorizedUrl: "https://renewed.test" });

    expect(useHtmlPdfSourceStore.getState().relations[id]).toMatchObject({
      tabId: "tab-2",
      manualRequestId: 1,
      updatePhase: "update-available",
    });
  });

  it("keeps the last exported artifact while an update fails", () => {
    const id = htmlPdfRelationId(threadRef, logicalDocumentKey);
    useHtmlPdfSourceStore
      .getState()
      .bind({ threadRef, tabId: "tab-1", source, authorizedUrl: "https://old.test" });
    const current = useHtmlPdfSourceStore.getState().relations[id];
    if (!current) throw new Error("expected source relation");
    useHtmlPdfSourceStore.setState({
      relations: {
        ...useHtmlPdfSourceStore.getState().relations,
        [id]: { ...current, artifactId: "artifact-1" },
      },
    });

    useHtmlPdfSourceStore.getState().setUpdateState(id, "updating");
    useHtmlPdfSourceStore.getState().setUpdateState(id, "failed", "The update failed.");

    expect(useHtmlPdfSourceStore.getState().relations[id]).toMatchObject({
      artifactId: "artifact-1",
      updatePhase: "failed",
      updateMessage: "The update failed.",
    });
  });

  it("sanitizes durable relations without retaining authorized URLs or interrupted state", () => {
    const id = htmlPdfRelationId(threadRef, logicalDocumentKey);
    useHtmlPdfSourceStore
      .getState()
      .bind({ threadRef, tabId: "tab-1", source, authorizedUrl: "https://secret.test" });
    const relation = useHtmlPdfSourceStore.getState().relations[id];
    if (!relation) throw new Error("expected source relation");

    expect(
      normalizePersistedHtmlPdfRelations({
        garbage: { source: null },
        [id]: {
          ...relation,
          logicalDocumentKey: "tampered",
          updatePhase: "updating",
          manualRequestId: 9,
        },
      }),
    ).toEqual({
      [id]: {
        ...relation,
        logicalDocumentKey: trackedHtmlLogicalDocumentKey(source),
        authorizedUrl: null,
        updatePhase: "update-available",
        updateMessage: "The source may have changed while Scient was closed.",
        manualRequestId: 0,
      },
    });
  });

  it("collapses legacy per-tab relations without losing the last exported artifact", () => {
    useHtmlPdfSourceStore
      .getState()
      .bind({ threadRef, tabId: "tab-1", source, authorizedUrl: "https://one.test" });
    const id = htmlPdfRelationId(threadRef, logicalDocumentKey);
    const relation = useHtmlPdfSourceStore.getState().relations[id];
    if (!relation) throw new Error("expected source relation");

    expect(
      normalizePersistedHtmlPdfRelations({
        "legacy-tab-1": {
          ...relation,
          id: "legacy-tab-1",
          tabId: "tab-1",
          artifactId: "artifact-1",
          updatePhase: "failed",
          updateMessage: "Previous update failed.",
        },
        "legacy-tab-2": {
          ...relation,
          id: "legacy-tab-2",
          tabId: "tab-2",
          artifactId: null,
          updatePhase: "idle",
          updateMessage: null,
        },
      }),
    ).toEqual({
      [id]: {
        ...relation,
        id,
        tabId: "tab-2",
        artifactId: "artifact-1",
        authorizedUrl: null,
        updatePhase: "failed",
        updateMessage: "Previous update failed.",
        manualRequestId: 0,
      },
    });
  });
});
