import { EnvironmentId, type ScopedThreadRef } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { render } from "../../../test/render";

const { refresh, pdfInputs } = vi.hoisted(() => ({
  refresh: vi.fn<() => Promise<string | null>>(),
  pdfInputs: [] as Array<{ locator: unknown; environmentId: string; file?: Blob | null }>,
}));

vi.mock(import("~/assets/assetUrls"), async (original) => ({
  ...(await original()),
  useAssetUrlRefresh: () => refresh,
}));
vi.mock(import("./AttachmentPdfPreview"), () => ({
  AttachmentPdfPreview: (props: {
    locator: unknown;
    environmentId: string;
    file?: Blob | null;
  }) => {
    pdfInputs.push(props);
    return (
      <div
        data-testid="scient-pdf-reader"
        data-scient-pdf={JSON.stringify(props.locator)}
        data-environment={props.environmentId}
      />
    );
  },
}));

import { ComposerFilePreviewDialog } from "~/components/chat/ComposerAttachmentStrip";
import { AttachmentFilePreview } from "~/components/files/AttachmentFilePreview";

function setup() {
  refresh.mockReset().mockResolvedValue("data:application/pdf,");
  pdfInputs.length = 0;
}

describe("attachment PDFs open in Scient's reader", () => {
  const environmentId = EnvironmentId.make("environment-1");
  const threadRef = { environmentId, threadId: "thread-1" } as unknown as ScopedThreadRef;

  it("names a sent attachment by its thread and attachment id", async () => {
    setup();
    await using screen = await render(
      <AttachmentFilePreview
        name="paper.pdf"
        mimeType="application/pdf"
        sizeBytes={10}
        asset={{ environmentId, attachmentId: "attachment-1" }}
        threadRef={threadRef}
      />,
    );
    await expect.element(screen.getByTestId("scient-pdf-reader")).toHaveAttribute(
      "data-scient-pdf",
      JSON.stringify({
        _tag: "sent",
        threadId: "thread-1",
        attachmentId: "attachment-1",
        sizeBytes: 10,
      }),
    );
    expect(screen.container.querySelector("embed, iframe")).toBeNull();
  });

  it("names a draft by its composer file context and keeps its local bytes", async () => {
    setup();
    const file = new Blob(["%PDF"], { type: "application/pdf" });
    await using screen = await render(
      <AttachmentFilePreview
        name="draft.pdf"
        mimeType="application/pdf"
        sizeBytes={4}
        file={file}
        draftPdf={{ threadRef, contextId: "file:local-1" }}
      />,
    );
    await expect.element(screen.getByTestId("scient-pdf-reader")).toHaveAttribute(
      "data-scient-pdf",
      JSON.stringify({
        _tag: "draft",
        threadId: "thread-1",
        fileContextId: "file:local-1",
      }),
    );
    expect(pdfInputs.at(-1)?.file).toBe(file);
  });

  it("keeps draft identity through the extracted composer preview dialog", async () => {
    setup();
    const file = new File(["%PDF"], "draft.pdf", { type: "application/pdf" });
    await using _screen = await render(
      <ComposerFilePreviewDialog
        file={{
          type: "file",
          id: "local-1",
          name: file.name,
          mimeType: file.type,
          sizeBytes: file.size,
          file,
        }}
        draftPdf={{ threadRef, contextId: "file:local-1" }}
        onRemove={() => undefined}
        onPreviewFileIdChange={() => undefined}
      />,
    );
    await expect.element(page.getByTestId("scient-pdf-reader")).toHaveAttribute(
      "data-scient-pdf",
      JSON.stringify({
        _tag: "draft",
        threadId: "thread-1",
        fileContextId: "file:local-1",
      }),
    );
    await expect
      .element(page.getByTestId("scient-pdf-reader"))
      .toHaveAttribute("data-environment", environmentId);
    expect(pdfInputs.at(-1)?.file).toBe(file);
    expect(document.querySelector("embed, iframe")).toBeNull();
  });

  it("keeps the browser's own viewer when nothing durable names the PDF", async () => {
    setup();
    await using screen = await render(
      <AttachmentFilePreview
        name="loose.pdf"
        mimeType="application/pdf"
        sizeBytes={10}
        asset={{ environmentId, attachmentId: "attachment-1" }}
      />,
    );
    await vi.waitFor(() =>
      expect(screen.container.querySelector('embed[type="application/pdf"]')).not.toBeNull(),
    );
    expect(screen.container.querySelector("[data-scient-pdf]")).toBeNull();
  });
});
