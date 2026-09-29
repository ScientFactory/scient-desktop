import { EnvironmentId } from "@t3tools/contracts";
import { act, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { AttachmentFilePreview } from "./AttachmentFilePreview";

const { refresh } = vi.hoisted(() => ({ refresh: vi.fn<() => Promise<string | null>>() }));

vi.mock("~/assets/assetUrls", () => ({ useAssetUrlRefresh: () => refresh }));
vi.mock("~/hooks/useCopyToClipboard", () => ({
  useCopyToClipboard: () => ({ copyToClipboard: vi.fn(), isCopied: false }),
}));
vi.mock("~/components/ui/toast", () => ({ toastManager: { add: vi.fn() } }));
vi.mock("~/components/ChatMarkdown", () => ({ default: () => null }));
vi.mock("~/components/ui/scroll-area", () => ({
  ScrollArea: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("./ReadOnlySourcePreview", () => ({
  default: ({ text }: { text: string }) => <pre>{text}</pre>,
}));
vi.mock("./fileSurfaceChrome", () => ({
  FILE_SURFACE_SUBHEADER_CLASS: "",
  FileSurfaceAction: ({ label, onPress }: { label: string; onPress: () => void }) => (
    <button aria-label={label} onClick={onPress} />
  ),
  FileSurfaceFailure: ({
    title,
    description,
    details,
    onRetry,
  }: {
    title: string;
    description: string;
    details?: string | null;
    onRetry?: () => void;
  }) => (
    <div role="alert">
      <p data-title>{title}</p>
      <p data-description>{description}</p>
      {details ? <pre data-details>{details}</pre> : null}
      {onRetry ? <button aria-label="Try again" onClick={onRetry} /> : null}
    </div>
  ),
  FileSurfaceLoading: () => <div role="status">Loading</div>,
  FileSurfaceMessage: ({ title }: { title: string }) => <div role="status">{title}</div>,
  FileSurfaceNotice: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

describe("attachment HTML preview recovery", () => {
  const originalUrl = "https://environment.test/original.html";
  const renewedUrl = "https://environment.test/renewed.html";
  let now = 0;
  let renderer: ReactTestRenderer;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    now = 0;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    refresh.mockReset().mockResolvedValueOnce(originalUrl).mockResolvedValue(renewedUrl);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("<p>Captured HTML</p>")),
    );
  });

  afterEach(async () => {
    if (renderer) await act(() => renderer.unmount());
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const openRemote = async () => {
    await act(async () => {
      renderer = create(
        <AttachmentFilePreview
          name="document.html"
          mimeType="text/html"
          sizeBytes={100}
          asset={{ environmentId: EnvironmentId.make("test-environment"), attachmentId: "html" }}
        />,
      );
    });
  };

  const toggleMode = async (label: string) => {
    await act(async () => {
      renderer.root.findByProps({ "aria-label": label }).props.onClick();
    });
  };

  it("keeps a renewed URL for subsequent rendered and source views", async () => {
    await openRemote();
    now = 61 * 60_000;
    await toggleMode("Show HTML source");
    expect(fetch).toHaveBeenCalledExactlyOnceWith(renewedUrl, expect.any(Object));

    await toggleMode("Show rendered page");
    expect(renderer.root.findByType("iframe").props.src).toBe(renewedUrl);
    await toggleMode("Show HTML source");
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(vi.mocked(fetch).mock.calls.map(([url]) => url)).toEqual([renewedUrl, renewedUrl]);
  });

  it("does not fetch or mark an expired URL fresh when reauthorization is unavailable", async () => {
    await openRemote();
    now = 61 * 60_000;
    refresh.mockResolvedValue(null);
    await toggleMode("Show HTML source");
    expect(fetch).not.toHaveBeenCalled();
    // The underlying reason stays behind Details; the visible copy is plain language.
    expect(renderer.root.findByProps({ "data-details": true }).children).toEqual([
      "Reconnect to the environment and try again.",
    ]);
    expect(renderer.root.findByProps({ "data-description": true }).children).toEqual([
      "Scient couldn't load this attachment.",
    ]);

    await toggleMode("Show rendered page");
    await toggleMode("Show HTML source");
    expect(refresh).toHaveBeenCalledTimes(3);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("can return to rendered HTML after local source decoding fails", async () => {
    const bytes = new Uint8Array([0x3c, 0x70, 0x3e, 0xe9]);
    const file = new Blob([bytes], { type: "text/html" });
    vi.spyOn(file, "stream").mockImplementation(
      () =>
        new ReadableStream({
          start: (controller) => {
            controller.enqueue(bytes);
            controller.close();
          },
        }),
    );
    await act(async () => {
      renderer = create(
        <AttachmentFilePreview
          name="document.html"
          mimeType="text/html"
          sizeBytes={file.size}
          file={file}
        />,
      );
    });
    await toggleMode("Show HTML source");
    expect(renderer.root.findByProps({ "data-details": true }).children.join("")).toContain(
      "not UTF-8",
    );

    await toggleMode("Show rendered page");
    expect(renderer.root.findAllByProps({ role: "alert" })).toHaveLength(0);
    expect(renderer.root.findByType("iframe").props.title).toBe("document.html");
  });
});

describe("attachment media failure", () => {
  let renderer: ReactTestRenderer | undefined;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  });

  afterEach(async () => {
    if (renderer) await act(() => renderer?.unmount());
    renderer = undefined;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("shows plain media copy and remounts a local Blob preview on retry", async () => {
    const file = new Blob([new Uint8Array([0x89, 0x50])], { type: "image/png" });
    await act(async () => {
      renderer = create(
        <AttachmentFilePreview name="photo.png" mimeType="image/png" sizeBytes={2} file={file} />,
      );
    });
    const firstImage = renderer!.root.findByType("img");
    const firstSrc: unknown = firstImage.props.src;
    expect(firstSrc).toEqual(expect.any(String));
    await act(async () => firstImage.props.onError());

    expect(renderer!.root.findByProps({ "data-title": true }).children).toEqual([
      "Couldn't display this image",
    ]);
    expect(renderer!.root.findAllByProps({ "data-details": true })).toHaveLength(0);

    await act(async () =>
      renderer!.root.findByProps({ "aria-label": "Try again" }).props.onClick(),
    );

    expect(renderer!.root.findAllByProps({ role: "alert" })).toHaveLength(0);
    expect(renderer!.root.findByType("img").props.src).toBe(firstSrc);
  });
});
