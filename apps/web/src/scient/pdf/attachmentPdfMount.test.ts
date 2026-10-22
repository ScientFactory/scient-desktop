import { EnvironmentId, type ScopedThreadRef } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import { attachmentPdfMount } from "./attachmentPdfMount";
import { attachmentPdfSource, pdfSourceAssetResource } from "./pdfSource";

const environmentId = EnvironmentId.make("environment-1");
const uploadEnvironmentId = EnvironmentId.make("environment-2");
const threadRef = { environmentId, threadId: "thread-1" } as unknown as ScopedThreadRef;
const file = new Blob(["%PDF"], { type: "application/pdf" });

describe("attachment PDF identity", () => {
  it("names a sent attachment by its thread and persisted id", () => {
    expect(
      attachmentPdfMount({ asset: { environmentId, attachmentId: "a-1" }, threadRef }),
    ).toEqual({
      environmentId,
      locator: { _tag: "sent", threadId: "thread-1", attachmentId: "a-1" },
    });
  });

  it("names a draft by its file context, fetching from its upload once there is one", () => {
    const draftPdf = { threadRef, contextId: "file:local-1" };
    expect(attachmentPdfMount({ file, draftPdf })).toEqual({
      environmentId,
      locator: { _tag: "draft", threadId: "thread-1", fileContextId: "file:local-1" },
    });
    expect(
      attachmentPdfMount({
        file,
        draftPdf,
        asset: { environmentId: uploadEnvironmentId, attachmentId: "a-2" },
      }),
    ).toEqual({
      environmentId: uploadEnvironmentId,
      locator: {
        _tag: "draft",
        threadId: "thread-1",
        fileContextId: "file:local-1",
        uploadedAttachmentId: "a-2",
      },
    });
  });

  it("names nothing it could not load or identify", () => {
    expect(attachmentPdfMount({ draftPdf: { threadRef, contextId: "file:x" } })).toBeNull();
    expect(attachmentPdfMount({ asset: { environmentId, attachmentId: "a-1" } })).toBeNull();
    expect(attachmentPdfMount({ file })).toBeNull();
  });

  it("authorizes a sent or uploaded attachment inline, and leaves local-only bytes to the preview", () => {
    const sent = attachmentPdfSource({
      environmentId,
      fileName: "paper.pdf",
      locator: { _tag: "sent", threadId: "thread-1", attachmentId: "a-1" },
    });
    expect(sent.logicalDocumentKey).toBe("attachment:a-1");
    expect(pdfSourceAssetResource(sent)).toEqual({
      _tag: "attachment",
      attachmentId: "a-1",
      fileName: "paper.pdf",
      mimeType: "application/pdf",
      disposition: "inline",
    });

    const uploaded = attachmentPdfSource({
      environmentId,
      fileName: "draft.pdf",
      locator: {
        _tag: "draft",
        threadId: "thread-1",
        fileContextId: "file:local-1",
        uploadedAttachmentId: "a-2",
      },
    });
    expect(uploaded.logicalDocumentKey).toBe("draft-attachment:thread-1:file:local-1");
    expect(pdfSourceAssetResource(uploaded)).toMatchObject({ attachmentId: "a-2" });

    const local = attachmentPdfSource({
      environmentId,
      fileName: "draft",
      locator: { _tag: "draft", threadId: "thread-1", fileContextId: "file:local-1" },
    });
    expect(local.fileName).toBe("draft.pdf");
    expect(pdfSourceAssetResource(local)).toBeNull();
  });
});

describe("attachment PDF names", () => {
  it("keeps any attachment name as the title and derives a valid save-as name", () => {
    const locator = { _tag: "sent" as const, threadId: "thread-1", attachmentId: "a-1" };
    const separated = attachmentPdfSource({ environmentId, fileName: "a\\b/c.pdf", locator });
    expect(separated.title).toBe("a\\b/c.pdf");
    expect(separated.fileName).toBe("a_b_c.pdf");
    expect(attachmentPdfSource({ environmentId, fileName: ".pdf", locator }).fileName).toBe(
      "attachment.pdf",
    );
  });
});

describe("attachment PDF names ending in a doubled suffix", () => {
  it("keeps a stem that itself ends in .pdf", () => {
    const locator = { _tag: "sent" as const, threadId: "thread-1", attachmentId: "a-1" };
    for (const fileName of [".pdf.pdf", ".PDF.PDF", "paper.pdf.pdf"]) {
      const source = attachmentPdfSource({ environmentId, fileName, locator });
      expect(source.fileName.toLowerCase()).toBe(fileName.toLowerCase());
      expect(source.title).toBe(fileName);
    }
    const long = attachmentPdfSource({
      environmentId,
      fileName: `${"x".repeat(400)}.pdf`,
      locator,
    });
    expect(long.fileName).toHaveLength(255);
  });
});
