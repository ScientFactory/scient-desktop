import { EnvironmentId, type ScopedThreadRef } from "@t3tools/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { refresh } = vi.hoisted(() => ({ refresh: vi.fn<() => Promise<string | null>>() }));

vi.mock(import("~/assets/assetUrls"), async (original) => ({
  ...(await original()),
  useAssetUrlRefresh: () => refresh,
}));
vi.mock(import("./AttachmentPdfPreview"), () => ({
  AttachmentPdfPreview: (props: { locator: unknown; environmentId: string }) => (
    <div data-scient-pdf={JSON.stringify(props.locator)} data-environment={props.environmentId} />
  ),
}));

import { AttachmentFilePreview } from "~/components/files/AttachmentFilePreview";

describe("attachment PDFs open in Scient's reader", () => {
  const environmentId = EnvironmentId.make("environment-1");
  const threadRef = { environmentId, threadId: "thread-1" } as unknown as ScopedThreadRef;
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    refresh.mockReset().mockResolvedValue("data:application/pdf,");
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  const reader = () => container.querySelector<HTMLElement>("[data-scient-pdf]");

  it("names a sent attachment by its thread and attachment id", async () => {
    await act(async () => {
      root.render(
        <AttachmentFilePreview
          name="paper.pdf"
          mimeType="application/pdf"
          sizeBytes={10}
          asset={{ environmentId, attachmentId: "attachment-1" }}
          threadRef={threadRef}
        />,
      );
    });
    expect(JSON.parse(reader()!.dataset.scientPdf!)).toEqual({
      _tag: "sent",
      threadId: "thread-1",
      attachmentId: "attachment-1",
    });
    expect(container.querySelector("embed, iframe")).toBeNull();
  });

  it("names a draft by its composer file context and keeps its local bytes", async () => {
    const file = new Blob(["%PDF"], { type: "application/pdf" });
    await act(async () => {
      root.render(
        <AttachmentFilePreview
          name="draft.pdf"
          mimeType="application/pdf"
          sizeBytes={4}
          file={file}
          draftPdf={{ threadRef, contextId: "file:local-1" }}
        />,
      );
    });
    expect(JSON.parse(reader()!.dataset.scientPdf!)).toEqual({
      _tag: "draft",
      threadId: "thread-1",
      fileContextId: "file:local-1",
    });
  });

  it("keeps the browser's own viewer when nothing durable names the PDF", async () => {
    await act(async () => {
      root.render(
        <AttachmentFilePreview
          name="loose.pdf"
          mimeType="application/pdf"
          sizeBytes={10}
          asset={{ environmentId, attachmentId: "attachment-1" }}
        />,
      );
    });
    await vi.waitFor(() =>
      expect(container.querySelector('embed[type="application/pdf"]')).not.toBeNull(),
    );
    expect(reader()).toBeNull();
  });
});
