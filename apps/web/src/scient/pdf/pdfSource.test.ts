import {
  ArtifactAuthority,
  ArtifactId,
  ArtifactRevisionId,
  BindingGeneration,
  LogicalDocumentKey,
  PdfSourceDescriptor,
} from "@scientfactory/document-artifacts";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import {
  pdfSourceAssetResource,
  usePdfSourceState,
  webPdfSourceResolver,
  workspacePdfSource,
} from "./pdfSource";

describe("PDF source resolution", () => {
  it("exposes the web resolver through the neutral host capability", () => {
    expect(webPdfSourceResolver.useResolve).toBe(usePdfSourceState);
  });

  it("preserves the existing exact workspace-file asset contract", () => {
    const source = workspacePdfSource({
      absolutePath: "/workspace/reports/paper.pdf",
      environmentId: EnvironmentId.make("environment-1"),
      fileName: "paper.pdf",
      threadId: ThreadId.make("thread-1"),
    });
    expect(pdfSourceAssetResource(source)).toEqual({
      _tag: "workspace-file",
      threadId: "thread-1",
      path: "/workspace/reports/paper.pdf",
    });
  });

  it("resolves generated revisions without exposing a producer path", () => {
    const source = PdfSourceDescriptor.make({
      _tag: "generated-pdf",
      authority: ArtifactAuthority.make("environment-1"),
      logicalDocumentKey: LogicalDocumentKey.make("latex:/workspace/paper.tex"),
      artifactId: ArtifactId.make("artifact-1"),
      revisionId: ArtifactRevisionId.make("revision-2"),
      bindingGeneration: BindingGeneration.make(2),
      bindingStatus: "stale",
      staleReason: "Build failed.",
      title: "Paper",
      fileName: "Paper.pdf",
      capabilities: { canSaveCopy: true, canRevealSource: false },
    });
    expect(pdfSourceAssetResource(source)).toEqual({
      _tag: "generated-document",
      authority: "environment-1",
      artifactId: "artifact-1",
      revisionId: "revision-2",
    });
    expect(JSON.stringify(source)).not.toContain("absolutePath");
  });
});
