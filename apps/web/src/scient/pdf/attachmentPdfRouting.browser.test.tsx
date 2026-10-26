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

  it("keeps an unnamed PDF available to save without inventing a reader identity", async () => {
    setup();
    const original = new Uint8Array([37, 80, 68, 70, 45, 0, 128, 255, 10]);
    const sourceUrl = URL.createObjectURL(new Blob([original], { type: "application/pdf" }));
    let savedUrl: string | undefined;
    let savedName: string | undefined;
    using _click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      savedUrl = this.href;
      savedName = this.download;
    });
    refresh.mockResolvedValue(sourceUrl);
    try {
      await using screen = await render(
        <AttachmentFilePreview
          name="paper.pdf"
          mimeType="application/pdf"
          sizeBytes={original.length}
          asset={{ environmentId, attachmentId: "attachment-1" }}
        />,
      );
      expect(screen.container.querySelector("embed, iframe, [data-scient-pdf]")).toBeNull();
      await screen.getByRole("button", { name: "Save file", exact: true }).click();
      await vi.waitFor(() => expect(savedName).toBe("paper.pdf"));
      expect(savedUrl).toMatch(/^blob:/);
      expect(new Uint8Array(await (await fetch(savedUrl!)).arrayBuffer())).toEqual(original);
      expect(pdfInputs).toHaveLength(0);
    } finally {
      URL.revokeObjectURL(sourceUrl);
      if (savedUrl) URL.revokeObjectURL(savedUrl);
    }
  });
});
