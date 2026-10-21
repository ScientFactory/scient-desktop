import { act, render, stubGlobal, type Screen } from "../../../test/render";
import { EnvironmentId } from "@t3tools/contracts";
import { page, userEvent } from "vite-plus/test/browser";
import { describe, expect, it, vi } from "vite-plus/test";

const { refresh } = vi.hoisted(() => ({ refresh: vi.fn<() => Promise<string | null>>() }));

vi.mock(import("~/assets/assetUrls"), async (original) => ({
  ...(await original()),
  useAssetUrlRefresh: () => refresh,
}));
// The real source view highlights through a worker pool; the text it receives is what matters here.
// Never load the original: its highlighter graph can outlast waitFor on a cold CI browser.
vi.mock(import("./ReadOnlySourcePreview"), () => ({
  default: ({ text }: { text: string }) => <pre>{text}</pre>,
}));

import { AttachmentFilePreview } from "./AttachmentFilePreview";

describe("attachment HTML preview recovery", () => {
  const originalUrl = "data:text/html,original";
  const renewedUrl = "data:text/html,renewed";

  function setup() {
    refresh.mockReset().mockResolvedValueOnce(originalUrl).mockResolvedValue(renewedUrl);
  }

  const openRemote = () =>
    render(
      <AttachmentFilePreview
        name="document.html"
        mimeType="text/html"
        sizeBytes={100}
        asset={{ environmentId: EnvironmentId.make("test-environment"), attachmentId: "html" }}
      />,
    );

  const toggleMode = async (screen: Screen, label: string) => {
    const button = screen.container.querySelector<HTMLButtonElement>(
      `button[aria-label="${label}"]`,
    );
    expect(button, label).not.toBeNull();
    await act(async () => button!.click());
  };
  const alert = (screen: Screen) => screen.container.querySelector('[role="alert"]');

  it("keeps a renewed URL for subsequent rendered and source views", async () => {
    setup();
    let now = 0;
    using _now = vi.spyOn(Date, "now").mockImplementation(() => now);
    using _fetch = stubGlobal(
      "fetch",
      vi.fn(async () => new Response("<p>Captured HTML</p>")),
    );
    await using screen = await openRemote();
    expect(screen.container.querySelector("iframe")?.getAttribute("src")).toBe(originalUrl);
    now = 61 * 60_000;
    await toggleMode(screen, "Show HTML source");
    await act(async () => {
      await import("./ReadOnlySourcePreview");
    });
    expect(fetch).toHaveBeenCalledExactlyOnceWith(renewedUrl, expect.any(Object));
    // SCIENT-FORK: the source view is lazy, and its first load can outlast a second on a busy runner.
    await vi.waitFor(
      () => expect(screen.container.querySelector("pre")?.textContent).toBe("<p>Captured HTML</p>"),
      { timeout: 5_000 },
    );

    await toggleMode(screen, "Show rendered page");
    expect(screen.container.querySelector("iframe")?.getAttribute("src")).toBe(renewedUrl);
    await toggleMode(screen, "Show HTML source");
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(vi.mocked(fetch).mock.calls.map(([url]) => url)).toEqual([renewedUrl, renewedUrl]);
  });

  it("does not fetch or mark an expired URL fresh when reauthorization is unavailable", async () => {
    setup();
    let now = 0;
    using _now = vi.spyOn(Date, "now").mockImplementation(() => now);
    using _fetch = stubGlobal(
      "fetch",
      vi.fn(async () => new Response("<p>Captured HTML</p>")),
    );
    await using screen = await openRemote();
    now = 61 * 60_000;
    refresh.mockResolvedValue(null);
    await toggleMode(screen, "Show HTML source");
    expect(fetch).not.toHaveBeenCalled();
    // SCIENT-FORK:START
    await act(() =>
      [...screen.container.querySelectorAll("button")]
        .find((el) => el.textContent?.trim() === "Details")!
        .click(),
    );
    // SCIENT-FORK:END
    expect(alert(screen)?.textContent).toContain("Reconnect to the environment and try again.");

    await toggleMode(screen, "Show rendered page");
    await toggleMode(screen, "Show HTML source");
    expect(refresh).toHaveBeenCalledTimes(3);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("can return to rendered HTML after local source decoding fails", async () => {
    setup();
    let now = 0;
    using _now = vi.spyOn(Date, "now").mockImplementation(() => now);
    using _fetch = stubGlobal(
      "fetch",
      vi.fn(async () => new Response("<p>Captured HTML</p>")),
    );
    const file = new Blob([new Uint8Array([0x3c, 0x70, 0x3e, 0xe9])], { type: "text/html" });
    await using screen = await render(
      <AttachmentFilePreview
        name="document.html"
        mimeType="text/html"
        sizeBytes={file.size}
        file={file}
      />,
    );
    await toggleMode(screen, "Show HTML source");
    await userEvent.click(page.getByRole("button", { name: "Details", exact: true }));
    await vi.waitFor(() => expect(alert(screen)?.textContent).toContain("not UTF-8"));

    await toggleMode(screen, "Show rendered page");
    expect(alert(screen)).toBeNull();
    expect(screen.container.querySelector("iframe")?.title).toBe("document.html");
  });
});

// SCIENT-FORK:START
describe("Scient attachment recovery assertions", () => {
  function setup() {
    const stack = new DisposableStack();
    stack.use(vi.spyOn(Date, "now").mockReturnValue(0));
    refresh
      .mockReset()
      .mockResolvedValueOnce("https://environment.test/original.html")
      .mockResolvedValue("https://environment.test/renewed.html");
    stack.use(
      stubGlobal(
        "fetch",
        vi.fn(async () => new Response("<p>Captured HTML</p>")),
      ),
    );
    return stack.move();
  }
  const click = async (container: HTMLElement, label: string) => {
    const el = [...container.querySelectorAll("button")].find(
      (el) => el.ariaLabel === label || el.textContent?.trim() === label,
    );
    expect(el).toBeDefined();
    await act(() => el!.click());
  };
  const open = () =>
    render(
      <AttachmentFilePreview
        name="document.html"
        mimeType="text/html"
        sizeBytes={100}
        asset={{ environmentId: EnvironmentId.make("test-environment"), attachmentId: "html" }}
      />,
    );
  it("keeps a renewed URL for subsequent rendered and source views with the original remote fixture", async () => {
    using _setup = setup();
    await using screen = await open();
    const { container } = screen;
    vi.mocked(Date.now).mockReturnValue(61 * 60_000);
    await click(container, "Show HTML source");
    expect(fetch).toHaveBeenCalledExactlyOnceWith(
      "https://environment.test/renewed.html",
      expect.any(Object),
    );
    await click(container, "Show rendered page");
    expect(container.querySelector("iframe")?.getAttribute("src")).toBe(
      "https://environment.test/renewed.html",
    );
    await click(container, "Show HTML source");
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(vi.mocked(fetch).mock.calls.map(([url]) => url)).toEqual([
      "https://environment.test/renewed.html",
      "https://environment.test/renewed.html",
    ]);
  });
  it("keeps plain copy visible and the unavailable reauthorization reason behind Details", async () => {
    using _setup = setup();
    await using screen = await open();
    const { container } = screen;
    vi.mocked(Date.now).mockReturnValue(61 * 60_000);
    refresh.mockResolvedValue(null);
    await click(container, "Show HTML source");
    expect(fetch).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "Scient couldn't load this attachment.",
    );
    await click(container, "Details");
    await vi.waitFor(() =>
      expect(container.querySelector("pre")?.textContent).toBe(
        "Reconnect to the environment and try again.",
      ),
    );
    await click(container, "Show rendered page");
    await click(container, "Show HTML source");
    expect(refresh).toHaveBeenCalledTimes(3);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("shows plain media copy and remounts a local Blob preview on retry", async () => {
    const file = new Blob([new Uint8Array([0x89, 0x50])], { type: "image/png" });
    // A valid URL keeps browser decoding from racing the explicit error event.
    using _setup = setup();
    using _url = vi
      .spyOn(URL, "createObjectURL")
      .mockReturnValue(
        "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
      );
    await using screen = await render(
      <AttachmentFilePreview name="photo.png" mimeType="image/png" sizeBytes={2} file={file} />,
    );
    const { container } = screen;
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
    await click(container, "Try again");
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.querySelector("img")?.getAttribute("src")).toBe(src);
    expect(container.querySelector("img")).not.toBe(first);
  });
});
// SCIENT-FORK:END
