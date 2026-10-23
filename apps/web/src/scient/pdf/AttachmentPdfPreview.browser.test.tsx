import type {
  PdfSourceActions,
  PdfSourceDescriptor,
  PdfSourceResolution,
  PdfSourceResolver,
} from "@scientfactory/document-artifacts";
import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { render } from "../../../test/render";

const { assetUrlState } = vi.hoisted(() => ({
  assetUrlState: vi.fn((_environmentId: unknown, resource: unknown) =>
    resource === null
      ? { _tag: "Loading" as const, refresh: () => undefined }
      : {
          _tag: "Success" as const,
          url: "https://environment.test/attachment.pdf",
          expiresAt: 1,
          refresh: () => undefined,
        },
  ),
}));
const seen: {
  resolution?: PdfSourceResolution;
  source?: PdfSourceDescriptor;
  actions?: PdfSourceActions;
  mounts: number;
} = { mounts: 0 };

vi.mock(import("~/assets/assetUrls"), async (original) => ({
  ...(await original()),
  useAssetUrlState: assetUrlState as never,
}));
vi.mock(import("./ScientPdfReader"), async () => {
  const { useEffect } = await import("react");
  return {
    ScientPdfReader: ((props: {
      source: PdfSourceDescriptor;
      resolver: PdfSourceResolver;
      actions: PdfSourceActions;
    }) => {
      seen.resolution = props.resolver.useResolve(props.source);
      seen.source = props.source;
      seen.actions = props.actions;
      useEffect(() => {
        seen.mounts += 1;
      }, []);
      return null;
    }) as never,
  };
});

import { AttachmentPdfPreview } from "./AttachmentPdfPreview";

const environmentId = EnvironmentId.make("environment-1");
const file = new Blob(["%PDF"], { type: "application/pdf" });
const draft = { _tag: "draft" as const, threadId: "thread-1", fileContextId: "file:local-1" };

function setup() {
  assetUrlState.mockClear();
  delete seen.resolution;
  delete seen.source;
  delete seen.actions;
  seen.mounts = 0;
}

describe("attachment PDF preview", () => {
  it("reads a draft's local bytes without minting a URL, then follows its upload in place", async () => {
    setup();
    await using screen = await render(
      <AttachmentPdfPreview
        environmentId={environmentId}
        fileName="draft.pdf"
        locator={draft}
        file={file}
      />,
    );
    await vi.waitFor(() => expect(seen.resolution?._tag).toBe("Success"));
    expect(seen.resolution).toMatchObject({ url: expect.stringMatching(/^blob:/u) });
    expect(assetUrlState).toHaveBeenLastCalledWith(environmentId, null);

    // The same reader instance moves to the uploaded bytes: hook order must not change.
    await screen.rerender(
      <AttachmentPdfPreview
        environmentId={environmentId}
        fileName="draft.pdf"
        locator={{ ...draft, uploadedAttachmentId: "a-2" }}
      />,
    );
    expect(seen.mounts).toBe(1);
    expect(seen.resolution).toMatchObject({
      _tag: "Success",
      url: "https://environment.test/attachment.pdf",
    });
    expect(assetUrlState).toHaveBeenLastCalledWith(
      environmentId,
      expect.objectContaining({ _tag: "attachment", attachmentId: "a-2" }),
    );
  });

  it("keeps the same document while the caller rebuilds an equal locator", async () => {
    setup();
    const sent = { _tag: "sent" as const, threadId: "thread-1", attachmentId: "a-1" };
    await using screen = await render(
      <AttachmentPdfPreview environmentId={environmentId} fileName="paper.pdf" locator={sent} />,
    );
    const first = seen.source;
    await screen.rerender(
      <AttachmentPdfPreview
        environmentId={environmentId}
        fileName="paper.pdf"
        locator={{ ...sent }}
      />,
    );
    expect(seen.source).toBe(first);
    await screen.rerender(
      <AttachmentPdfPreview
        environmentId={environmentId}
        fileName="paper.pdf"
        locator={{ ...sent, attachmentId: "a-2" }}
      />,
    );
    expect(seen.source).not.toBe(first);
    expect(seen.source?.logicalDocumentKey).toBe("attachment:a-2");
  });

  it("saves local bytes by downloading them in the renderer", async () => {
    setup();
    await using _screen = await render(
      <AttachmentPdfPreview
        environmentId={environmentId}
        fileName="draft.pdf"
        locator={draft}
        file={file}
      />,
    );
    using click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    await vi.waitFor(() => expect(seen.resolution?._tag).toBe("Success"));
    const resolved = seen.resolution;
    if (resolved?._tag !== "Success") throw new Error("expected a resolved draft");
    await expect(seen.actions!.saveCopy(seen.source!, resolved)).resolves.toEqual({
      _tag: "download-started",
    });
    expect(click).toHaveBeenCalledTimes(1);
    expect((click.mock.contexts[0] as HTMLAnchorElement).download).toBe("draft.pdf");
  });
});
