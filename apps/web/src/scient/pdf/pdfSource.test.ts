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
  workspacePdfSourceForPreview,
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

  it.each(["README.md", "analysis.m", "figure.png", "data.txt"])(
    "does not construct a PDF source for a restored %s preview",
    (relativePath) => {
      expect(
        workspacePdfSourceForPreview({
          absolutePath: `/workspace/${relativePath}`,
          environmentId: EnvironmentId.make("environment-1"),
          relativePath,
          threadId: ThreadId.make("thread-1"),
        }),
      ).toBeNull();
    },
  );

  it("does not construct a PDF source for an empty preview", () => {
    expect(
      workspacePdfSourceForPreview({
        absolutePath: null,
        environmentId: EnvironmentId.make("environment-1"),
        relativePath: null,
        threadId: ThreadId.make("thread-1"),
      }),
    ).toBeNull();
  });

  it("constructs a PDF source for a restored PDF preview", () => {
    expect(
      workspacePdfSourceForPreview({
        absolutePath: "/workspace/reports/PAPER.PDF",
        environmentId: EnvironmentId.make("environment-1"),
        relativePath: "reports/PAPER.PDF",
        threadId: ThreadId.make("thread-1"),
      }),
    ).toMatchObject({
      _tag: "workspace-pdf",
      absolutePath: "/workspace/reports/PAPER.PDF",
      fileName: "PAPER.PDF",
      threadId: "thread-1",
    });
  });

  it("removes browser suffixes before constructing a PDF source", () => {
    expect(
      workspacePdfSourceForPreview({
        absolutePath: "/workspace/reports/paper.pdf?download=1",
        environmentId: EnvironmentId.make("environment-1"),
        relativePath: "reports/paper.pdf?download=1",
        threadId: ThreadId.make("thread-1"),
      }),
    ).toMatchObject({
      absolutePath: "/workspace/reports/paper.pdf",
      fileName: "paper.pdf",
    });
  });

  it("preserves special characters in the workspace directory", () => {
    expect(
      workspacePdfSourceForPreview({
        absolutePath: "/workspace/Project #1/reports/paper.pdf",
        environmentId: EnvironmentId.make("environment-1"),
        relativePath: "reports/paper.pdf",
        threadId: ThreadId.make("thread-1"),
      }),
    ).toMatchObject({
      absolutePath: "/workspace/Project #1/reports/paper.pdf",
      fileName: "paper.pdf",
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
