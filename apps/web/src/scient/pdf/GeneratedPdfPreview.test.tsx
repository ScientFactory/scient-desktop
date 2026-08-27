import {
  ArtifactAuthority,
  ArtifactId,
  ArtifactRevisionId,
  BindingGeneration,
  PdfSourceDescriptor,
} from "@scientfactory/document-artifacts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("./ScientPdfReader", () => ({
  ScientPdfReader: () => <div data-generated-pdf-reader />,
}));

import { GeneratedPdfPreview, GeneratedPdfTitleRow } from "./GeneratedPdfPreview";
import {
  trackedHtmlLogicalDocumentKey,
  type TrackedHtmlSource,
} from "../documentExport/htmlPdfSource";
import {
  htmlPdfRelationId,
  type HtmlPdfSourceRelation,
  type HtmlPdfUpdatePhase,
} from "../documentExport/htmlPdfSourceStore";

const environmentId = EnvironmentId.make("environment-1");
const threadRef = scopeThreadRef(environmentId, ThreadId.make("thread-1"));
const trackedSource: TrackedHtmlSource = {
  _tag: "workspace-html",
  environmentId,
  workspaceRoot: "/workspace",
  relativePath: "reports/result.html",
  absolutePath: "/workspace/reports/result.html",
};
const sourceCandidate = PdfSourceDescriptor.make({
  _tag: "generated-pdf",
  authority: ArtifactAuthority.make("environment-1"),
  logicalDocumentKey: trackedHtmlLogicalDocumentKey(trackedSource),
  title: "דוח תוצאות",
  fileName: "Fixture export.pdf",
  capabilities: { canSaveCopy: true, canRevealSource: false },
  artifactId: ArtifactId.make("artifact-1"),
  revisionId: ArtifactRevisionId.make("revision-1"),
  bindingGeneration: BindingGeneration.make(1),
  bindingStatus: "current",
  staleReason: null,
  pageCount: 1,
});
if (sourceCandidate._tag !== "generated-pdf") throw new Error("expected generated PDF fixture");
const source = sourceCandidate;
const relationId = htmlPdfRelationId(threadRef, source.logicalDocumentKey);

function renderWithRelation(updatePhase: HtmlPdfUpdatePhase, updateMessage: string | null = null) {
  const relation: HtmlPdfSourceRelation = {
    id: relationId,
    threadRef,
    tabId: "tab-1",
    source: trackedSource,
    logicalDocumentKey: source.logicalDocumentKey,
    artifactId: source.artifactId,
    authorizedUrl: "http://127.0.0.1:16491/api/assets/token/result.html",
    updatePhase,
    updateMessage,
    manualRequestId: 0,
  };
  return renderToStaticMarkup(
    <GeneratedPdfTitleRow title={source.title} relation={relation} onRequestUpdate={() => {}} />,
  );
}

describe("GeneratedPdfPreview", () => {
  it("keeps the PDF reader as a direct child of the flex-column surface", () => {
    const markup = renderToStaticMarkup(
      <GeneratedPdfPreview source={source} threadRef={threadRef} />,
    );

    expect(markup).toMatch(
      /^<div class="flex min-h-0 flex-1 flex-col bg-background">.*<div data-generated-pdf-reader="true"><\/div><\/div>$/u,
    );
    expect(markup).not.toContain('class="relative min-h-0 flex-1 overflow-hidden"');
    expect(markup).toMatch(
      /<div class="flex [^"]*" data-generated-pdf-title-row="true" data-surface-subheader="true" dir="rtl">/u,
    );
    expect(markup).toContain('class="min-w-0 flex-1 truncate px-1 text-start');
    expect(markup).toContain('dir="rtl">דוח תוצאות</span>');
    expect(markup).not.toContain('aria-label="Refresh PDF"');
  });

  it("keeps the manual HTML update action visible while the relation is healthy", () => {
    const markup = renderWithRelation("idle");

    expect(markup).toContain('aria-label="Update PDF from HTML"');
    expect(markup).toContain('data-html-pdf-update-phase="idle"');
    expect(markup).not.toContain("opacity-0");
    expect(markup).not.toMatch(/\sdisabled(?:=|\s|>)/u);
  });

  it("presents update availability as a visible, truthful recovery action", () => {
    const markup = renderWithRelation("update-available", "Automatic source watching paused.");

    expect(markup).toContain('aria-label="Source changed — update PDF from HTML"');
    expect(markup).toContain('data-html-pdf-update-phase="update-available"');
    expect(markup).toContain("text-warning");
    expect(markup).toContain('role="status"');
    expect(markup).toContain("Automatic source watching paused.");
  });

  it("disables duplicate updates and announces progress", () => {
    const markup = renderWithRelation("updating");

    expect(markup).toContain('aria-label="Updating PDF from HTML…"');
    expect(markup).toContain('aria-busy="true"');
    expect(markup).toContain('data-html-pdf-update-phase="updating"');
    expect(markup).toContain("disabled");
    expect(markup).toContain("animate-spin");
  });

  it("keeps failed updates recoverable without hover", () => {
    const markup = renderWithRelation("failed", "The last update failed.");

    expect(markup).toContain('aria-label="Retry PDF update from HTML"');
    expect(markup).toContain('data-html-pdf-update-phase="failed"');
    expect(markup).toContain("text-destructive");
    expect(markup).not.toContain("opacity-0");
    expect(markup).toContain("The last update failed.");
  });
});
