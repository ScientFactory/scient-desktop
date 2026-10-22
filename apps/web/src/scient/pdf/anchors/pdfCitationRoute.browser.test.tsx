import {
  EnvironmentId,
  ThreadId,
  type PdfCitation,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { PDF_TEXT_PROFILE, PdfTarget } from "@scientfactory/document-artifacts";
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { openFile } = vi.hoisted(() => ({ openFile: vi.fn() }));
vi.mock(import("~/rightPanelStore"), async (original) => {
  const actual = await original();
  const getState = actual.useRightPanelStore.getState;
  actual.useRightPanelStore.getState = (() => ({ ...getState(), openFile })) as never;
  return actual;
});

import { useFileCitationTarget } from "~/scient/markdownEditor/fileCitationNavigation";

import { workspacePdfSource } from "../pdfSource";
import { pdfCitationHash } from "./pdfCitationNavigation";
import {
  pdfRevealDocumentKey,
  pendingPdfReveal,
  resetPdfRevealRequests,
} from "./pdfRevealRequests";
import { pdfDocumentIdentity } from "./pdfTextTarget";

const environmentId = EnvironmentId.make("environment-1");
const ref: ScopedThreadRef = { environmentId, threadId: ThreadId.make("thread-1") };
const source = workspacePdfSource({
  environmentId,
  fileName: "paper.pdf",
  workspaceRoot: "/project",
  relativePath: "papers/paper.pdf",
});
const quote: PdfCitation = {
  kind: "pdf",
  version: 1,
  environmentId,
  threadId: ref.threadId,
  target: PdfTarget.make({
    version: 1,
    document: pdfDocumentIdentity(source)!,
    material: null,
    extractor: { profile: PDF_TEXT_PROFILE, version: "6.2.108" },
    selector: {
      type: "text",
      pages: [
        {
          page: 1,
          viewBox: [0, 0, 612, 792],
          rotation: 0,
          userUnit: 1,
          pageTextHash: "b".repeat(64),
          start: 0,
          end: 5,
          quote: "Hello",
          prefix: "",
          suffix: "",
        },
      ],
    },
  }),
};

function Route(props: { href: string }) {
  useFileCitationTarget(ref, { href: props.href, key: "k1" }, "/project", (_id, run) => run());
  return null;
}

describe("opening a PDF quote from its route", () => {
  let root: Root;
  let container: HTMLDivElement;
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    resetPdfRevealRequests();
    openFile.mockClear();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it("opens the PDF once and keeps its reveal through React's development replay", async () => {
    await act(async () =>
      root.render(
        <StrictMode>
          <Route href={`app://x/#${pdfCitationHash(quote)}`} />
        </StrictMode>,
      ),
    );
    await act(async () => new Promise((resolve) => setTimeout(resolve, 5)));
    expect(openFile).toHaveBeenCalledTimes(1);
    expect(openFile).toHaveBeenCalledWith(ref, "papers/paper.pdf");
    expect(pendingPdfReveal(pdfRevealDocumentKey(source))?.target).toEqual(quote.target);
  });

  it("abandons a waiting quote when the conversation is left", async () => {
    await act(async () => root.render(<Route href={`app://x/#${pdfCitationHash(quote)}`} />));
    await act(async () => root.unmount());
    root = createRoot(container);
    await act(async () => new Promise((resolve) => setTimeout(resolve, 5)));
    expect(pendingPdfReveal(pdfRevealDocumentKey(source))).toBeNull();
  });
});
