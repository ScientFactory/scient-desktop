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

import { GeneratedPdfPreview } from "./GeneratedPdfPreview";
import {
  trackedHtmlLogicalDocumentKey,
  type TrackedHtmlSource,
} from "../documentExport/htmlPdfSource";

const environmentId = EnvironmentId.make("environment-1");
const threadRef = scopeThreadRef(environmentId, ThreadId.make("thread-1"));
const trackedSource: TrackedHtmlSource = {
  _tag: "workspace-html",
  environmentId,
  workspaceRoot: "/workspace",
  relativePath: "reports/result.html",
  absolutePath: "/workspace/reports/result.html",
};
const source = PdfSourceDescriptor.make({
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
if (source._tag !== "generated-pdf") throw new Error("expected generated PDF fixture");

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
      /<div class="group\/html-pdf-title flex [^"]*" data-generated-pdf-title-row="true" data-surface-subheader="true" dir="rtl">/u,
    );
    expect(markup).toContain('class="min-w-0 flex-1 truncate px-1 text-start');
    expect(markup).toContain('dir="rtl">דוח תוצאות</span>');
    expect(markup).not.toContain('aria-label="Refresh PDF"');
  });
});
