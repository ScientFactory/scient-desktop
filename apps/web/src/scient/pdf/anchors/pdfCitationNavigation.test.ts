import {
  ArtifactAuthority,
  ArtifactId,
  ArtifactRevisionId,
  BindingGeneration,
  LogicalDocumentKey,
  PDF_TEXT_PROFILE,
  PdfSourceDescriptor,
  PdfTarget,
  type PdfDocumentIdentity,
} from "@scientfactory/document-artifacts";
import { EnvironmentId, ThreadId, type PdfCitation } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { openFile, openScient, openAttachment, toast, currentDocument } = vi.hoisted(() => ({
  openFile: vi.fn(),
  openScient: vi.fn(),
  openAttachment: vi.fn(),
  toast: vi.fn(),
  currentDocument: vi.fn(),
}));
vi.mock("~/scient/latex/client", () => ({ readCurrentGeneratedDocument: currentDocument }));
/** A right panel whose one thread state the tests change, with the store's subscribe. */
const panel = vi.hoisted(() => {
  type State = { byThreadKey: Record<string, { activeSurfaceId: string | null; isOpen: boolean }> };
  const listeners = new Set<(state: State, previous: State) => void>();
  let thread = { activeSurfaceId: null as string | null, isOpen: true };
  const state = (): State => {
    const snapshot = { ...thread };
    return { byThreadKey: new Proxy({}, { get: () => snapshot }) };
  };
  return {
    listeners,
    current: state,
    reset() {
      thread = { activeSurfaceId: null, isOpen: true };
      listeners.clear();
    },
    set(next: Partial<typeof thread>) {
      const previous = state();
      thread = { ...thread, ...next };
      for (const listener of Array.from(listeners)) listener(state(), previous);
    },
  };
});
vi.mock("~/rightPanelStore", () => ({
  useRightPanelStore: {
    getState: () => ({ openFile, openScient, openAttachment, ...panel.current() }),
    subscribe: (listener: (state: never, previous: never) => void) => {
      panel.listeners.add(listener as never);
      return () => panel.listeners.delete(listener as never);
    },
  },
}));
vi.mock("~/components/ui/toast", () => ({ toastManager: { add: toast } }));

import { environmentPdfSource, workspacePdfSource } from "../pdfSource";
import {
  openPdfCitation,
  pdfCitationFromLocation,
  pdfCitationHash,
  pdfCitationNavigation,
} from "./pdfCitationNavigation";
import {
  pdfRevealDocumentKey,
  pendingPdfReveal,
  resetPdfRevealRequests,
} from "./pdfRevealRequests";
import { pdfDocumentIdentity } from "./pdfTextTarget";

const environmentId = EnvironmentId.make("environment-1");
/** Runs the departure at once, as when nothing is waiting to save. */
const now = (_surfaceId: string, run: () => void) => run();

function citation(document: PdfDocumentIdentity): PdfCitation {
  return {
    kind: "pdf",
    version: 1,
    environmentId,
    threadId: ThreadId.make("thread-1"),
    target: PdfTarget.make({
      version: 1,
      document,
      material: null,
      extractor: { profile: PDF_TEXT_PROFILE, version: "6.2.108" },
      selector: {
        type: "text",
        pages: [
          {
            page: 2,
            viewBox: [0, 0, 612, 792],
            rotation: 0,
            userUnit: 1,
            pageTextHash: "d".repeat(64),
            start: 0,
            end: 5,
            quote: "Hello",
            prefix: "",
            suffix: " world",
          },
        ],
      },
    }),
  };
}

const workspaceSource = workspacePdfSource({
  environmentId,
  fileName: "paper.pdf",
  workspaceRoot: "/project",
  relativePath: "papers/paper.pdf",
});

describe("PDF quote identity and navigation", () => {
  beforeEach(() => {
    panel.reset();
    resetPdfRevealRequests();
    openFile.mockClear();
    openScient.mockClear();
    openAttachment.mockClear();
    toast.mockClear();
  });
  afterEach(() => vi.restoreAllMocks());

  it("names each kind of PDF durably, and nothing for an unsent draft", () => {
    expect(pdfDocumentIdentity(workspaceSource)?.locator).toEqual({
      _tag: "workspace",
      workspaceRoot: "/project",
      relativePath: "papers/paper.pdf",
    });
    const fromSources = workspacePdfSource({
      environmentId,
      fileName: "paper.pdf",
      workspaceRoot: "/project",
      relativePath: ".scient/sources/files/paper.pdf",
      origin: { _tag: "source", workspaceRoot: "/project", sourceId: "s-1", attachmentId: "a-1" },
    });
    expect(pdfDocumentIdentity(fromSources)?.locator).toEqual({
      _tag: "source",
      workspaceRoot: "/project",
      sourceId: "s-1",
      attachmentId: "a-1",
      relativePath: ".scient/sources/files/paper.pdf",
    });
    const generated = PdfSourceDescriptor.make({
      _tag: "generated-pdf",
      authority: ArtifactAuthority.make(environmentId),
      logicalDocumentKey: LogicalDocumentKey.make("latex:/project/main.tex"),
      title: "Thesis",
      fileName: "main.pdf",
      capabilities: { canSaveCopy: true, canRevealSource: false },
      artifactId: ArtifactId.make("artifact-1"),
      revisionId: ArtifactRevisionId.make("revision-1"),
      bindingGeneration: BindingGeneration.make(4),
      bindingStatus: "current",
      staleReason: null,
    });
    expect(pdfDocumentIdentity(generated)?.locator).toEqual({
      _tag: "generated",
      artifactId: "artifact-1",
      revisionId: "revision-1",
      bindingGeneration: 4,
    });
    const attachment = (locator: object) =>
      PdfSourceDescriptor.make({
        _tag: "attachment-pdf",
        authority: ArtifactAuthority.make(environmentId),
        logicalDocumentKey: LogicalDocumentKey.make("attachment:a-9"),
        title: "notes.pdf",
        fileName: "notes.pdf",
        capabilities: { canSaveCopy: true, canRevealSource: false },
        locator: locator as never,
      });
    expect(
      pdfDocumentIdentity(
        attachment({ _tag: "sent", threadId: "thread-1", attachmentId: "a-9", sizeBytes: 42 }),
      )?.locator,
    ).toEqual({ _tag: "attachment", threadId: "thread-1", attachmentId: "a-9", sizeBytes: 42 });
    expect(
      pdfDocumentIdentity(attachment({ _tag: "draft", threadId: "thread-1", fileContextId: "f" })),
    ).toBeNull();
  });

  it("round-trips through the route hash", () => {
    const quote = citation(pdfDocumentIdentity(workspaceSource)!);
    const navigation = pdfCitationNavigation(quote);
    expect(navigation.params).toEqual({ environmentId, threadId: "thread-1" });
    expect(pdfCitationFromLocation(`app://x/#${pdfCitationHash(quote)}`)).toEqual(quote);
    expect(pdfCitationFromLocation("app://x/#file-citation=abc")).toBeNull();
  });

  it("opens each kind of PDF where it lives", () => {
    const ref = { environmentId, threadId: "thread-1" };
    openPdfCitation(citation(pdfDocumentIdentity(workspaceSource)!), "/project", now);
    expect(openFile).toHaveBeenLastCalledWith(ref, "papers/paper.pdf");
    expect(toast).not.toHaveBeenCalled();

    // From another workspace the original file opens by its full path.
    openPdfCitation(citation(pdfDocumentIdentity(workspaceSource)!), "/elsewhere", now);
    expect(openFile).toHaveBeenLastCalledWith(ref, "/project/papers/paper.pdf");
    expect(toast).toHaveBeenCalledTimes(1);

    const environment = environmentPdfSource({
      environmentId,
      canonicalPath: "/tmp/outside.pdf",
      fileName: "outside.pdf",
    });
    openPdfCitation(citation(pdfDocumentIdentity(environment)!), "/project", now);
    expect(openScient).toHaveBeenLastCalledWith(
      ref,
      expect.objectContaining({ module: "file", path: "/tmp/outside.pdf" }),
    );

    const sent = PdfSourceDescriptor.make({
      _tag: "attachment-pdf",
      authority: ArtifactAuthority.make(environmentId),
      logicalDocumentKey: LogicalDocumentKey.make("attachment:a-9"),
      title: "notes (v2).pdf",
      fileName: "notes (v2).pdf",
      capabilities: { canSaveCopy: true, canRevealSource: false },
      locator: { _tag: "sent", threadId: "thread-1", attachmentId: "a-9", sizeBytes: 42 },
    });
    openPdfCitation(citation(pdfDocumentIdentity(sent)!), "/project", now);
    expect(openAttachment).toHaveBeenLastCalledWith(ref, {
      type: "file",
      id: "a-9",
      name: "notes (v2).pdf",
      mimeType: "application/pdf",
      sizeBytes: 42,
    });
  });

  it("files the reveal under the document the reader will show", () => {
    const quote = citation(pdfDocumentIdentity(workspaceSource)!);
    openPdfCitation(quote, "/project", now);
    // The reader looks its pending reveal up by the source it shows.
    expect(pendingPdfReveal(pdfRevealDocumentKey(workspaceSource))?.target).toEqual(quote.target);
  });

  it("waits for the active editor's pending save before leaving it", () => {
    let held: (() => void) | null = null;
    const holding = vi.fn((_surfaceId: string, run: () => void) => {
      held = run;
    });
    openPdfCitation(citation(pdfDocumentIdentity(workspaceSource)!), "/project", holding);
    expect(holding).toHaveBeenCalledWith("file:papers/paper.pdf", expect.any(Function));
    expect(openFile).not.toHaveBeenCalled();
    expect(pendingPdfReveal(pdfRevealDocumentKey(workspaceSource))).toBeNull();
    held!();
    expect(openFile).toHaveBeenCalledTimes(1);
  });

  it("opens a generated PDF at its current revision, or the captured one when it is gone", async () => {
    const captured = PdfSourceDescriptor.make({
      _tag: "generated-pdf",
      authority: ArtifactAuthority.make(environmentId),
      logicalDocumentKey: LogicalDocumentKey.make("latex:/project/main.tex"),
      title: "Thesis",
      fileName: "main.pdf",
      capabilities: { canSaveCopy: true, canRevealSource: false },
      artifactId: ArtifactId.make("artifact-1"),
      revisionId: ArtifactRevisionId.make("revision-1"),
      bindingGeneration: BindingGeneration.make(4),
      bindingStatus: "current",
      staleReason: null,
    });
    const current = { ...captured, revisionId: ArtifactRevisionId.make("revision-7") };
    const quote = citation(pdfDocumentIdentity(captured)!);

    currentDocument.mockResolvedValueOnce({ descriptor: current });
    openPdfCitation(quote, "/project", now);
    await vi.waitFor(() => expect(openScient).toHaveBeenCalledTimes(1));
    expect(openScient.mock.calls[0]![1]).toMatchObject({
      module: "generated-pdf",
      source: current,
    });
    expect(pendingPdfReveal(pdfRevealDocumentKey(captured))?.target).toEqual(quote.target);

    currentDocument.mockResolvedValueOnce({ descriptor: null });
    openPdfCitation(quote, "/project", now);
    await vi.waitFor(() => expect(openScient).toHaveBeenCalledTimes(2));
    expect(openScient.mock.calls[1]![1]).toMatchObject({
      source: expect.objectContaining({ revisionId: "revision-1" }),
    });
  });

  it("names a file inside the current workspace the way the Files panel will", () => {
    const nested = workspacePdfSource({
      environmentId,
      fileName: "paper.pdf",
      workspaceRoot: "/project/sub",
      relativePath: "paper.pdf",
    });
    openPdfCitation(citation(pdfDocumentIdentity(nested)!), "/project", now);
    expect(openFile).toHaveBeenLastCalledWith(
      { environmentId, threadId: "thread-1" },
      "sub/paper.pdf",
    );
    const shown = workspacePdfSource({
      environmentId,
      fileName: "paper.pdf",
      workspaceRoot: "/project",
      relativePath: "sub/paper.pdf",
    });
    expect(pendingPdfReveal(pdfRevealDocumentKey(shown))).not.toBeNull();
  });

  it("lets a later quote click supersede a generated PDF still being looked up", async () => {
    const generated = PdfSourceDescriptor.make({
      _tag: "generated-pdf",
      authority: ArtifactAuthority.make(environmentId),
      logicalDocumentKey: LogicalDocumentKey.make("html:/project/report.html"),
      title: "Report",
      fileName: "report.pdf",
      capabilities: { canSaveCopy: true, canRevealSource: false },
      artifactId: ArtifactId.make("artifact-2"),
      revisionId: ArtifactRevisionId.make("revision-2"),
      bindingGeneration: BindingGeneration.make(1),
      bindingStatus: "current",
      staleReason: null,
    });
    const answer = Promise.withResolvers<{ descriptor: null }>();
    currentDocument.mockReturnValueOnce(answer.promise);
    openPdfCitation(citation(pdfDocumentIdentity(generated)!), "/project", now);
    openPdfCitation(citation(pdfDocumentIdentity(workspaceSource)!), "/project", now);
    answer.resolve({ descriptor: null });
    // A message task follows the resolved lookup's microtasks without a clock delay.
    const channel = new MessageChannel();
    try {
      await new Promise<void>((resolve) => {
        channel.port1.onmessage = () => resolve();
        channel.port2.postMessage(null);
      });
    } finally {
      channel.port1.close();
      channel.port2.close();
    }
    expect(openFile).toHaveBeenCalledTimes(1);
    expect(openScient).not.toHaveBeenCalled();
  });

  it("refuses, with a notice, a parsed quote whose attachment can't be named", () => {
    const quote = citation(pdfDocumentIdentity(workspaceSource)!);
    const broken = {
      ...quote,
      target: {
        ...quote.target,
        document: {
          ...quote.target.document,
          locator: { _tag: "attachment" as const, threadId: "thread-1", attachmentId: "   " },
        },
      },
    } as PdfCitation;
    expect(() => openPdfCitation(broken, "/project", now)).not.toThrow();
    expect(openAttachment).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ type: "error" }));
  });

  it("opens a quote whose comment is as long as the editor allows", () => {
    const quote = {
      ...citation(pdfDocumentIdentity(workspaceSource)!),
      comment: "語".repeat(8_000),
    };
    expect(pdfCitationFromLocation(`app://x/#${pdfCitationHash(quote)}`)).toEqual(quote);
  });

  it.each([
    ["opens something else in the panel", { activeSurfaceId: "file:notes.md" }],
    ["closes the panel", { isOpen: false }],
  ])("drops a deferred quote once the user %s", (_label, change) => {
    let held: (() => void) | null = null;
    const holding = (_surfaceId: string, run: () => void) => {
      held = run;
    };
    openPdfCitation(citation(pdfDocumentIdentity(workspaceSource)!), "/project", holding);
    panel.set(change);
    // Even back where it was, the user acted in between.
    panel.set({ activeSurfaceId: null, isOpen: true });
    held!();
    expect(openFile).not.toHaveBeenCalled();
    expect(pendingPdfReveal(pdfRevealDocumentKey(workspaceSource))).toBeNull();
  });

  it("abandons an earlier quote's reveal when another quote is opened", () => {
    const first = citation(pdfDocumentIdentity(workspaceSource)!);
    openPdfCitation(first, "/project", now);
    expect(pendingPdfReveal(pdfRevealDocumentKey(workspaceSource))).not.toBeNull();
    const other = environmentPdfSource({
      environmentId,
      canonicalPath: "/tmp/other.pdf",
      fileName: "other.pdf",
    });
    openPdfCitation(citation(pdfDocumentIdentity(other)!), "/project", now);
    expect(pendingPdfReveal(pdfRevealDocumentKey(workspaceSource))).toBeNull();
    expect(pendingPdfReveal(pdfRevealDocumentKey(other))).not.toBeNull();
  });

  it("keeps an opened quote's reveal while its PDF is shown, and drops it when the user leaves first", () => {
    openFile.mockImplementation(() => panel.set({ activeSurfaceId: "file:papers/paper.pdf" }));
    openPdfCitation(citation(pdfDocumentIdentity(workspaceSource)!), "/project", now);
    const key = pdfRevealDocumentKey(workspaceSource);
    expect(pendingPdfReveal(key)).not.toBeNull();
    // Unrelated panel state (e.g. its width) changing keeps it.
    panel.set({});
    expect(pendingPdfReveal(key)).not.toBeNull();
    // The user switches to another view before the PDF's reader took it.
    panel.set({ activeSurfaceId: "file:notes.md" });
    expect(pendingPdfReveal(key)).toBeNull();
    openFile.mockReset();
  });
});
