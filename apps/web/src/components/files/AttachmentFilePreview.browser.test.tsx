import { EnvironmentId } from "@t3tools/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { refresh } = vi.hoisted(() => ({ refresh: vi.fn<() => Promise<string | null>>() }));

vi.mock(import("~/assets/assetUrls"), async (original) => ({
  ...(await original()),
  useAssetUrlRefresh: () => refresh,
}));
// The real source view highlights through a worker pool; the text it receives is what matters here.
vi.mock(import("./ReadOnlySourcePreview"), async (original) => ({
  ...(await original()),
  default: ({ text }: { text: string }) => <pre>{text}</pre>,
}));

import { AttachmentFilePreview } from "./AttachmentFilePreview";

describe("attachment HTML preview recovery", () => {
  const originalUrl = "data:text/html,original";
  const renewedUrl = "data:text/html,renewed";
  let now = 0;
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    now = 0;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    refresh.mockReset().mockResolvedValueOnce(originalUrl).mockResolvedValue(renewedUrl);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("<p>Captured HTML</p>")),
    );
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const openRemote = () =>
    act(async () =>
      root.render(
        <AttachmentFilePreview
          name="document.html"
          mimeType="text/html"
          sizeBytes={100}
          asset={{ environmentId: EnvironmentId.make("test-environment"), attachmentId: "html" }}
        />,
      ),
    );

  const toggleMode = async (label: string) => {
    const button = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
    expect(button, label).not.toBeNull();
    await act(async () => button!.click());
  };
  const alert = () => container.querySelector('[role="alert"]');

  it("keeps a renewed URL for subsequent rendered and source views", async () => {
    await openRemote();
    expect(container.querySelector("iframe")?.getAttribute("src")).toBe(originalUrl);
    now = 61 * 60_000;
    await toggleMode("Show HTML source");
    expect(fetch).toHaveBeenCalledExactlyOnceWith(renewedUrl, expect.any(Object));
    // SCIENT-FORK: the source view is lazy, and its first load can outlast a second on a busy runner.
    await vi.waitFor(
      () => expect(container.querySelector("pre")?.textContent).toBe("<p>Captured HTML</p>"),
      { timeout: 5_000 },
    );

    await toggleMode("Show rendered page");
    expect(container.querySelector("iframe")?.getAttribute("src")).toBe(renewedUrl);
    await toggleMode("Show HTML source");
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(vi.mocked(fetch).mock.calls.map(([url]) => url)).toEqual([renewedUrl, renewedUrl]);
  });

  it("does not fetch or mark an expired URL fresh when reauthorization is unavailable", async () => {
    await openRemote();
    now = 61 * 60_000;
    refresh.mockResolvedValue(null);
    await toggleMode("Show HTML source");
    expect(fetch).not.toHaveBeenCalled();
    // SCIENT-FORK:START
    await act(() =>
      [...container.querySelectorAll("button")]
        .find((el) => el.textContent?.trim() === "Details")!
        .click(),
    );
    // SCIENT-FORK:END
    expect(alert()?.textContent).toContain("Reconnect to the environment and try again.");

    await toggleMode("Show rendered page");
    await toggleMode("Show HTML source");
    expect(refresh).toHaveBeenCalledTimes(3);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("can return to rendered HTML after local source decoding fails", async () => {
    const file = new Blob([new Uint8Array([0x3c, 0x70, 0x3e, 0xe9])], { type: "text/html" });
    await act(async () =>
      root.render(
        <AttachmentFilePreview
          name="document.html"
          mimeType="text/html"
          sizeBytes={file.size}
          file={file}
        />,
      ),
    );
    await toggleMode("Show HTML source");
    // SCIENT-FORK:START
    await vi.waitFor(() => expect(alert()).not.toBeNull());
    await act(() =>
      [...container.querySelectorAll("button")]
        .find((el) => el.textContent?.trim() === "Details")!
        .click(),
    );
    // SCIENT-FORK:END
    await vi.waitFor(() => expect(alert()?.textContent).toContain("not UTF-8"));

    await toggleMode("Show rendered page");
    expect(alert()).toBeNull();
    expect(container.querySelector("iframe")?.title).toBe("document.html");
  });
});

// SCIENT-FORK:START
describe("Scient attachment recovery assertions", () => {
  let root: Root;
  let container: HTMLDivElement;
  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.spyOn(Date, "now").mockReturnValue(0);
    refresh
      .mockReset()
      .mockResolvedValueOnce("https://environment.test/original.html")
      .mockResolvedValue("https://environment.test/renewed.html");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("<p>Captured HTML</p>")),
    );
  });
  afterEach(async () => {
    await act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });
  const click = async (label: string) => {
    const el = [...container.querySelectorAll("button")].find(
      (el) => el.ariaLabel === label || el.textContent?.trim() === label,
    );
    expect(el).toBeDefined();
    await act(() => el!.click());
  };
  const open = async () => {
    await act(() =>
      root.render(
        <AttachmentFilePreview
          name="document.html"
          mimeType="text/html"
          sizeBytes={100}
          asset={{ environmentId: EnvironmentId.make("test-environment"), attachmentId: "html" }}
        />,
      ),
    );
  };
  it("keeps a renewed URL for subsequent rendered and source views with the original remote fixture", async () => {
    await open();
    vi.mocked(Date.now).mockReturnValue(61 * 60_000);
    await click("Show HTML source");
    expect(fetch).toHaveBeenCalledExactlyOnceWith(
      "https://environment.test/renewed.html",
      expect.any(Object),
    );
    await click("Show rendered page");
    expect(container.querySelector("iframe")?.getAttribute("src")).toBe(
      "https://environment.test/renewed.html",
    );
    await click("Show HTML source");
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(vi.mocked(fetch).mock.calls.map(([url]) => url)).toEqual([
      "https://environment.test/renewed.html",
      "https://environment.test/renewed.html",
    ]);
  });
  it("keeps plain copy visible and the unavailable reauthorization reason behind Details", async () => {
    await open();
    vi.mocked(Date.now).mockReturnValue(61 * 60_000);
    refresh.mockResolvedValue(null);
    await click("Show HTML source");
    expect(fetch).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "Scient couldn't load this attachment.",
    );
    await click("Details");
    await vi.waitFor(() =>
      expect(container.querySelector("pre")?.textContent).toBe(
        "Reconnect to the environment and try again.",
      ),
    );
    await click("Show rendered page");
    await click("Show HTML source");
    expect(refresh).toHaveBeenCalledTimes(3);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("shows plain media copy and remounts a local Blob preview on retry", async () => {
    const file = new Blob([new Uint8Array([0x89, 0x50])], { type: "image/png" });
    // A valid URL keeps browser decoding from racing the explicit error event.
    vi.spyOn(URL, "createObjectURL").mockReturnValue(
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
    );
    await act(() =>
      root.render(
        <AttachmentFilePreview name="photo.png" mimeType="image/png" sizeBytes={2} file={file} />,
      ),
    );
    const first = container.querySelector("img")!;
    const src = first.getAttribute("src");
    expect(src).toEqual(expect.any(String));
    await act(() => first.dispatchEvent(new Event("error")));
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "Couldn't display this image",
    );
    expect(
      [...container.querySelectorAll("button")].some((el) => el.textContent === "Details"),
    ).toBe(false);
    await click("Try again");
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.querySelector("img")?.getAttribute("src")).toBe(src);
    expect(container.querySelector("img")).not.toBe(first);
  });
});
// SCIENT-FORK:END
