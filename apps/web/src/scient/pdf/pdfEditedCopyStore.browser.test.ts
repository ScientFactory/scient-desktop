import type { PdfSourceDescriptor } from "@scientfactory/document-artifacts";
import { expect, it } from "vite-plus/test";

import { currentPdfEditedCopy, rememberPdfEditedCopy } from "./pdfEditedCopyStore";

const prefix = "scient.pdf-edited-copy.v1:";

function generated(revisionId: string) {
  return {
    _tag: "generated-pdf",
    authority: "environment-1",
    logicalDocumentKey: "latex:main",
    title: "Paper",
    fileName: "Paper.pdf",
    capabilities: { canSaveCopy: true, canRevealSource: false },
    artifactId: `artifact-${revisionId}`,
    revisionId,
    bindingGeneration: 1,
    bindingStatus: "current",
    staleReason: null,
  } as PdfSourceDescriptor;
}

const workspace = {
  _tag: "workspace-pdf",
  authority: "environment-1",
  logicalDocumentKey: "workspace:paper",
  title: "Paper",
  fileName: "Paper.pdf",
  capabilities: { canSaveCopy: true, canRevealSource: true },
  workspaceRoot: "/project",
  relativePath: "paper.pdf",
} as PdfSourceDescriptor;

const copy = (originalRevisionId: string | null) => ({
  source: generated("edited"),
  sessionKey: "session",
  showOriginal: false,
  originalRevisionId,
  savedAt: 1,
});

/** Starts from, and leaves behind, empty storage. */
function emptyStorage() {
  localStorage.clear();
  return { [Symbol.dispose]: () => localStorage.clear() };
}

it("drops an edited copy once the generated original is rebuilt", () => {
  expect(currentPdfEditedCopy(copy("revision-1"), generated("revision-1"))).not.toBeNull();
  expect(currentPdfEditedCopy(copy("revision-1"), generated("revision-2"))).toBeNull();
});

it("keeps an edited copy of a file that is never rebuilt", () => {
  expect(currentPdfEditedCopy(copy(null), workspace)).not.toBeNull();
  expect(currentPdfEditedCopy(copy("revision-1"), workspace)).toBeNull();
});

it("remembers at most 100 edited copies, forgetting the oldest", () => {
  using _storage = emptyStorage();
  for (let index = 0; index < 101; index++) {
    rememberPdfEditedCopy(`document-${index}`, {
      source: generated("edited"),
      sessionKey: `session-${index}`,
      showOriginal: false,
      originalRevisionId: null,
    });
    localStorage.setItem(
      prefix + `document-${index}`,
      JSON.stringify({
        ...JSON.parse(localStorage.getItem(prefix + `document-${index}`)!),
        savedAt: index,
      }),
    );
  }
  rememberPdfEditedCopy("document-latest", {
    source: generated("edited"),
    sessionKey: "session-latest",
    showOriginal: false,
    originalRevisionId: null,
  });
  const remembered = Object.keys(localStorage).filter((key) => key.startsWith(prefix));
  expect(remembered).toHaveLength(100);
  expect(remembered).toContain(prefix + "document-latest");
  expect(remembered).not.toContain(prefix + "document-0");
  expect(remembered).not.toContain(prefix + "document-1");
});

it("keeps every edited copy while fewer than the limit are remembered", () => {
  using _storage = emptyStorage();
  for (const name of ["a", "b", "c"])
    rememberPdfEditedCopy(name, {
      source: generated("edited"),
      sessionKey: name,
      showOriginal: false,
      originalRevisionId: null,
    });
  expect(Object.keys(localStorage).filter((key) => key.startsWith(prefix))).toHaveLength(3);
});
