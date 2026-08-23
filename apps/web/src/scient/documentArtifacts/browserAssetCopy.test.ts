import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { saveAssetCopyInBrowser } from "./browserAssetCopy";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("browser asset copy", () => {
  it("starts a same-origin Blob download and revokes its object URL", async () => {
    vi.useFakeTimers();
    const click = vi.fn();
    const remove = vi.fn();
    const append = vi.fn();
    const anchor = { click, remove, hidden: false, href: "", download: "" };
    const createObjectURL = vi.fn(() => "blob:scient-report");
    const revokeObjectURL = vi.fn();
    class BrowserUrl extends URL {
      static override createObjectURL = createObjectURL;
      static override revokeObjectURL = revokeObjectURL;
    }
    vi.stubGlobal("URL", BrowserUrl);
    vi.stubGlobal("document", {
      createElement: vi.fn(() => anchor),
      body: { append },
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("%PDF-1.7")));

    await expect(
      saveAssetCopyInBrowser({
        url: "https://assets.scient.test/report.pdf",
        suggestedFileName: "report.pdf",
      }),
    ).resolves.toEqual({ _tag: "download-started" });
    expect(anchor).toMatchObject({
      hidden: true,
      href: "blob:scient-report",
      download: "report.pdf",
    });
    expect(append).toHaveBeenCalledWith(anchor);
    expect(click).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledOnce();
    expect(revokeObjectURL).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:scient-report");
  });
});
