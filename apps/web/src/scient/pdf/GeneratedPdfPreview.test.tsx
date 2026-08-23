import {
  ArtifactAuthority,
  ArtifactId,
  ArtifactRevisionId,
  BindingGeneration,
  LogicalDocumentKey,
  PdfSourceDescriptor,
} from "@scientfactory/document-artifacts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("./ScientPdfReader", () => ({
  ScientPdfReader: () => <div data-generated-pdf-reader />,
}));

import { GeneratedPdfPreview } from "./GeneratedPdfPreview";

describe("GeneratedPdfPreview", () => {
  it("keeps the PDF reader as a direct child of the flex-column surface", () => {
    const source = PdfSourceDescriptor.make({
      _tag: "generated-pdf",
      authority: ArtifactAuthority.make("environment-1"),
      logicalDocumentKey: LogicalDocumentKey.make("browser-export:fixture"),
      title: "Fixture export",
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

    const markup = renderToStaticMarkup(<GeneratedPdfPreview source={source} />);

    expect(markup).toMatch(
      /^<div class="flex min-h-0 flex-1 flex-col bg-background">.*<div data-generated-pdf-reader="true"><\/div><\/div>$/u,
    );
    expect(markup).not.toContain('class="relative min-h-0 flex-1 overflow-hidden"');
  });
});
