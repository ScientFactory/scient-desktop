import type { ScientDocumentPdfPublished } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  conversationPdfFileName,
  deliverDocumentPdf,
  markdownPdfFileName,
} from "./documentPdfDelivery";

const published = {
  title: "Report",
  warnings: [],
  source: { _tag: "generated-pdf", fileName: "internal-revision-name.pdf" },
} as unknown as ScientDocumentPdfPublished;

describe("document PDF delivery", () => {
  it("suggests the project file's own name with .pdf", () => {
    expect(markdownPdfFileName("notes/Field notes.md")).toBe("Field notes.pdf");
    expect(markdownPdfFileName("report.MARKDOWN")).toBe("report.pdf");
    expect(markdownPdfFileName("notes\\draft.v2.md")).toBe("draft.v2.pdf");
  });

  it("suggests a conversation's title the way its other formats do", () => {
    expect(conversationPdfFileName("Study: phase 2")).toBe("Study phase 2.pdf");
    expect(conversationPdfFileName("   ")).toBe("Conversation.pdf");
  });

  it("saves under the suggested name, never the stored PDF's own name", async () => {
    const saveCopy = vi.fn(async () => ({ _tag: "download-started" as const }));
    expect(await deliverDocumentPdf({ saveCopy }, published, "Field notes.pdf")).toEqual({
      _tag: "delivered",
      title: "Download started",
      description: "Field notes.pdf",
    });
    expect(saveCopy).toHaveBeenCalledWith(published, "Field notes.pdf");
  });
});
