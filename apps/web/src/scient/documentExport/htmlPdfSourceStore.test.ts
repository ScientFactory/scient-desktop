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

beforeEach(() => {
  useHtmlPdfSourceStore.setState({ relations: {} });
});

describe("HTML PDF source relations", () => {
  it("targets a manual update to the relation in the active thread", () => {
    const store = useHtmlPdfSourceStore.getState();
    store.bind({ threadRef, tabId: "tab-1", source, authorizedUrl: "https://one.test" });
    store.bind({
      threadRef: otherThreadRef,
      tabId: "tab-2",
      source,
      authorizedUrl: "https://two.test",
    });
    const firstId = htmlPdfRelationId(threadRef, "tab-1");
    const secondId = htmlPdfRelationId(otherThreadRef, "tab-2");

    useHtmlPdfSourceStore.getState().requestUpdate(firstId);

    expect(useHtmlPdfSourceStore.getState().relations[firstId]?.manualRequestId).toBe(1);
    expect(useHtmlPdfSourceStore.getState().relations[secondId]?.manualRequestId).toBe(0);
    expect(useHtmlPdfSourceStore.getState().relations[firstId]?.logicalDocumentKey).toBe(
      useHtmlPdfSourceStore.getState().relations[secondId]?.logicalDocumentKey,
    );
  });

  it("preserves the artifact for URL renewal and resets it when the tab opens another source", () => {
    const id = htmlPdfRelationId(threadRef, "tab-1");
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
      .bind({ threadRef, tabId: "tab-1", source, authorizedUrl: "https://renewed.test" });
    expect(useHtmlPdfSourceStore.getState().relations[id]).toMatchObject({
      artifactId: "artifact-1",
      authorizedUrl: "https://renewed.test",
    });

    useHtmlPdfSourceStore.getState().bind({
      threadRef,
      tabId: "tab-1",
      source: {
        ...source,
        relativePath: "reports/other.html",
        absolutePath: "/workspace/reports/other.html",
      },
      authorizedUrl: "https://other.test",
    });
    expect(useHtmlPdfSourceStore.getState().relations[id]?.artifactId).toBeNull();
  });

  it("sanitizes durable relations without retaining authorized URLs or interrupted state", () => {
    const id = htmlPdfRelationId(threadRef, "tab-1");
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
});
