import type { PdfSourceDescriptor } from "@scientfactory/document-artifacts";
import { expect, it } from "vite-plus/test";

import { pdfEditedCopyKey, readPdfEditedCopy, rememberPdfEditedCopy } from "./pdfEditedCopyStore";

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

/** Starts from, and leaves behind, empty storage. */
function emptyStorage() {
  localStorage.clear();
  return { [Symbol.dispose]: () => localStorage.clear() };
}

const remember = (key: string) =>
  rememberPdfEditedCopy(key, {
    source: generated("edited"),
    sessionKey: key,
    showOriginal: false,
  });

it("remembers a generated PDF's copy per revision, so a rebuild shows the new build", () => {
  using _storage = emptyStorage();
  const before = pdfEditedCopyKey("document", generated("revision-1"));
  const after = pdfEditedCopyKey("document", generated("revision-2"));
  expect(before).not.toBe(after);
  remember(before);
  expect(readPdfEditedCopy(after)).toBeNull();
  // A save still finishing for the old build cannot replace the new build's copy.
  remember(after);
  remember(before);
  expect(readPdfEditedCopy(after)?.sessionKey).toBe(after);
});

it("remembers a copy of a file that is never rebuilt by its document alone", () => {
  expect(pdfEditedCopyKey("document", workspace)).toBe("document");
});

it("remembers at most 100 edited copies, forgetting the oldest", () => {
  using _storage = emptyStorage();
  for (let index = 0; index < 101; index++) {
    rememberPdfEditedCopy(`document-${index}`, {
      source: generated("edited"),
      sessionKey: `session-${index}`,
      showOriginal: false,
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
    });
  expect(Object.keys(localStorage).filter((key) => key.startsWith(prefix))).toHaveLength(3);
});
