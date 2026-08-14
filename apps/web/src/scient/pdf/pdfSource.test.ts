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

import { createMemoryStorage } from "~/lib/storage";

import {
  pdfSourceAssetResource,
  usePdfSourceState,
  webPdfSourceResolver,
  workspacePdfRelativePath,
  workspacePdfSource,
  workspacePdfSourceForPreview,
} from "./pdfSource";
import { createPdfReaderSessionStore, pdfReaderSessionDocumentKey } from "./pdfReaderSessionStore";

describe("PDF source resolution", () => {
  it("exposes the web resolver through the neutral host capability", () => {
    expect(webPdfSourceResolver.useResolve).toBe(usePdfSourceState);
  });

  it("authorizes a workspace PDF from its root while retaining a legacy fallback", () => {
    const source = workspacePdfSource({
      environmentId: EnvironmentId.make("environment-1"),
      fileName: "paper.pdf",
      workspaceRoot: "/workspace",
      relativePath: "reports/paper.pdf",
      legacyLocator: {
        threadId: ThreadId.make("thread-1"),
        absolutePath: "/workspace/reports/paper.pdf",
      },
    });
    expect(pdfSourceAssetResource(source)).toEqual({
      _tag: "workspace-file",
      cwd: "/workspace",
      relativePath: "reports/paper.pdf",
      threadId: "thread-1",
      path: "/workspace/reports/paper.pdf",
    });
  });

  it("does not require a thread compatibility locator", () => {
    const source = workspacePdfSource({
      environmentId: EnvironmentId.make("environment-1"),
      fileName: "paper.pdf",
      workspaceRoot: "/workspace",
      relativePath: "reports/paper.pdf",
    });
    expect(pdfSourceAssetResource(source)).toEqual({
      _tag: "workspace-file",
      cwd: "/workspace",
      relativePath: "reports/paper.pdf",
    });
  });

  it("shares reader state across authorizing threads but isolates environments", () => {
    const sourceForThread = (environmentId: string, threadId: string) =>
      workspacePdfSource({
        environmentId: EnvironmentId.make(environmentId),
        fileName: "paper.pdf",
        workspaceRoot: "/workspace",
        relativePath: "reports/paper.pdf",
        legacyLocator: {
          threadId: ThreadId.make(threadId),
          absolutePath: "/workspace/reports/paper.pdf",
        },
      });
    const original = sourceForThread("environment-1", "thread-1");
    const fork = sourceForThread("environment-1", "thread-2");
    const otherEnvironment = sourceForThread("environment-2", "thread-3");
    const store = createPdfReaderSessionStore({
      storage: createMemoryStorage(),
      writeDelayMs: 0,
    });

    store.updateSidebar(pdfReaderSessionDocumentKey(original), "outline");

    expect(original.logicalDocumentKey).toBe(fork.logicalDocumentKey);
    expect(store.get(pdfReaderSessionDocumentKey(fork)).sidebar).toBe("outline");
    expect(store.get(pdfReaderSessionDocumentKey(otherEnvironment)).sidebar).toBe("closed");
    expect(pdfSourceAssetResource(original)).toMatchObject({ threadId: "thread-1" });
    expect(pdfSourceAssetResource(fork)).toMatchObject({ threadId: "thread-2" });
  });

  it("normalizes Windows workspace paths for reader identity", () => {
    const sourceForPath = (workspaceRoot: string, relativePath: string) =>
      workspacePdfSource({
        environmentId: EnvironmentId.make("environment-1"),
        fileName: "paper.pdf",
        workspaceRoot,
        relativePath,
      });

    expect(sourceForPath("C:\\Workspace", "Reports\\Paper.pdf").logicalDocumentKey).toBe(
      sourceForPath("c:/workspace", "reports/paper.pdf").logicalDocumentKey,
    );
  });

  it("recovers root-relative paths from older Sources responses", () => {
    expect(workspacePdfRelativePath("/workspace", "/workspace/sources/דוח.pdf")).toBe(
      "sources/דוח.pdf",
    );
    expect(workspacePdfRelativePath("C:\\Workspace", "c:/workspace/Sources/Paper.pdf")).toBe(
      "Sources/Paper.pdf",
    );
    expect(workspacePdfRelativePath("/workspace", "/another/paper.pdf")).toBeNull();
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
          workspaceRoot: "/workspace",
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
        workspaceRoot: "/workspace",
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
        workspaceRoot: "/workspace",
      }),
    ).toMatchObject({
      _tag: "workspace-pdf",
      fileName: "PAPER.PDF",
      workspaceRoot: "/workspace",
      relativePath: "reports/PAPER.PDF",
      legacyLocator: {
        threadId: "thread-1",
        absolutePath: "/workspace/reports/PAPER.PDF",
      },
    });
  });

  it("removes browser suffixes before constructing a PDF source", () => {
    expect(
      workspacePdfSourceForPreview({
        absolutePath: "/workspace/reports/paper.pdf?download=1",
        environmentId: EnvironmentId.make("environment-1"),
        relativePath: "reports/paper.pdf?download=1",
        threadId: ThreadId.make("thread-1"),
        workspaceRoot: "/workspace",
      }),
    ).toMatchObject({
      relativePath: "reports/paper.pdf",
      fileName: "paper.pdf",
      legacyLocator: { absolutePath: "/workspace/reports/paper.pdf" },
    });
  });

  it("preserves special characters in the workspace directory", () => {
    expect(
      workspacePdfSourceForPreview({
        absolutePath: "/workspace/Project #1/reports/paper.pdf",
        environmentId: EnvironmentId.make("environment-1"),
        relativePath: "reports/paper.pdf",
        threadId: ThreadId.make("thread-1"),
        workspaceRoot: "/workspace/Project #1",
      }),
    ).toMatchObject({
      workspaceRoot: "/workspace/Project #1",
      relativePath: "reports/paper.pdf",
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
