import type { PdfSourceDescriptor } from "@scientfactory/document-artifacts";
import { expect, it } from "vite-plus/test";

import { pdfEditedCopyKey } from "./pdfEditedCopyStore";

it("remembers a copy of a file that is never rebuilt by its document alone", () => {
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
  expect(pdfEditedCopyKey("document", workspace)).toBe("document");
});
