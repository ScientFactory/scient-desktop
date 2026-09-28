import { EnvironmentId, ThreadId, type ScientDocumentPdfPublished } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { useRightPanelStore } from "~/rightPanelStore";

import {
  conversationPdfFileName,
  deliverDocumentPdf,
  documentPdfSavedNotice,
  markdownPdfFileName,
} from "./documentPdfDelivery";

const published = {
  title: "Report",
  warnings: [],
  source: {
    _tag: "generated-pdf",
    authority: "local",
    fileName: "internal-revision-name.pdf",
    artifactId: "artifact-1",
    revisionId: "revision-1",
  },
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

  it("opens the PDF in the thread that owns the editor, after switching threads", () => {
    const owner = { environmentId: EnvironmentId.make("local"), threadId: ThreadId.make("owner") };
    const openScient = vi.spyOn(useRightPanelStore.getState(), "openScient");
    const navigate = vi.fn(async (_target: unknown) => undefined);
    const notice = documentPdfSavedNotice({
      delivery: { _tag: "delivered", title: "Export saved", description: "/tmp/Report.pdf" },
      published,
      threadRef: owner,
      navigate: navigate as never,
    });
    expect(notice).toMatchObject({
      type: "success",
      title: "Export saved",
      description: "/tmp/Report.pdf",
      actionProps: { children: "Open" },
    });
    // The user moves to another thread before choosing Open.
    void navigate({ to: "/$environmentId/$threadId", params: { threadId: "other" } });
    notice.actionProps.onClick();
    expect(openScient).toHaveBeenCalledWith(owner, expect.anything());
    expect(navigate).toHaveBeenLastCalledWith({
      to: "/$environmentId/$threadId",
      params: { environmentId: owner.environmentId, threadId: owner.threadId },
    });
    openScient.mockRestore();
  });
});
