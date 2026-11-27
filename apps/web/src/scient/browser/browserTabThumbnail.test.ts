import { describe, expect, it, vi } from "vite-plus/test";

import { createTabThumbnailCache, isUsableThumbnailDataUrl } from "./browserTabThumbnail";

const PICTURE = "data:image/jpeg;base64,QUJD";

describe("tab thumbnail cache", () => {
  it("serves a captured picture for the same tab and address without recapturing", async () => {
    const cache = createTabThumbnailCache();
    const capture = vi.fn(async () => PICTURE);
    await expect(cache.request("tab_1", "https://example.com/a", capture)).resolves.toBe(PICTURE);
    await expect(cache.request("tab_1", "https://example.com/a", capture)).resolves.toBe(PICTURE);
    expect(capture).toHaveBeenCalledTimes(1);
    expect(cache.get("tab_1", "https://example.com/a")).toBe(PICTURE);
  });

  it("treats a navigated tab as a miss and captures the new page", async () => {
    const cache = createTabThumbnailCache();
    const capture = vi.fn(async () => PICTURE);
    await cache.request("tab_1", "https://example.com/a", capture);
    expect(cache.get("tab_1", "https://example.com/b")).toBeNull();
    await cache.request("tab_1", "https://example.com/b", capture);
    expect(capture).toHaveBeenCalledTimes(2);
  });

  it("shares one capture between concurrent hovers", async () => {
    const cache = createTabThumbnailCache();
    const gate = Promise.withResolvers<string>();
    const capture = vi.fn(() => gate.promise);
    const first = cache.request("tab_1", "https://example.com/", capture);
    const second = cache.request("tab_1", "https://example.com/", capture);
    gate.resolve(PICTURE);
    await expect(first).resolves.toBe(PICTURE);
    await expect(second).resolves.toBe(PICTURE);
    expect(capture).toHaveBeenCalledTimes(1);
  });

  it("does not cache failures, so a later hover retries", async () => {
    const cache = createTabThumbnailCache();
    const capture = vi
      .fn<() => Promise<string | null>>()
      .mockRejectedValueOnce(new Error("guest gone"))
      .mockResolvedValue(PICTURE);
    await expect(cache.request("tab_1", "https://example.com/", capture)).resolves.toBeNull();
    await expect(cache.request("tab_1", "https://example.com/", capture)).resolves.toBe(PICTURE);
    expect(capture).toHaveBeenCalledTimes(2);
  });

  it("rejects unusable capture results instead of caching them", async () => {
    const cache = createTabThumbnailCache();
    const capture = vi.fn(async () => "https://example.com/not-a-data-url");
    await expect(cache.request("tab_1", "https://example.com/", capture)).resolves.toBeNull();
    expect(cache.get("tab_1", "https://example.com/")).toBeNull();
  });

  it("evicts the least recently shown pictures past the bound", async () => {
    const cache = createTabThumbnailCache(2);
    const capture = vi.fn(async () => PICTURE);
    await cache.request("tab_1", "https://one.example/", capture);
    await cache.request("tab_2", "https://two.example/", capture);
    // Showing tab_1 again makes tab_2 the least recently used.
    expect(cache.get("tab_1", "https://one.example/")).toBe(PICTURE);
    await cache.request("tab_3", "https://three.example/", capture);
    expect(cache.get("tab_1", "https://one.example/")).toBe(PICTURE);
    expect(cache.get("tab_2", "https://two.example/")).toBeNull();
    expect(cache.get("tab_3", "https://three.example/")).toBe(PICTURE);
  });

  it("does not cache a late completion for a page the tab has left", async () => {
    const cache = createTabThumbnailCache();
    const gate = Promise.withResolvers<string>();
    const slowCapture = vi.fn(() => gate.promise);
    const fastCapture = vi.fn(async () => "data:image/jpeg;base64,REVG");
    const stale = cache.request("tab_1", "page-a", slowCapture);
    await cache.request("tab_1", "page-b", fastCapture);
    gate.resolve(PICTURE);
    await expect(stale).resolves.toBe(PICTURE);
    expect(cache.get("tab_1", "page-b")).toBe("data:image/jpeg;base64,REVG");
    expect(cache.get("tab_1", "page-a")).toBeNull();
  });

  it("invalidate forgets the picture and discards an in-flight capture", async () => {
    const cache = createTabThumbnailCache();
    const gate = Promise.withResolvers<string>();
    const capture = vi.fn(() => gate.promise);
    const inFlight = cache.request("tab_1", "page-a", capture);
    cache.invalidate("tab_1");
    gate.resolve(PICTURE);
    await inFlight;
    expect(cache.get("tab_1", "page-a")).toBeNull();

    const again = vi.fn(async () => PICTURE);
    await cache.request("tab_1", "page-a", again);
    expect(cache.get("tab_1", "page-a")).toBe(PICTURE);
    cache.invalidate("tab_1");
    expect(cache.get("tab_1", "page-a")).toBeNull();
  });

  it("a request after invalidation does not join the retired capture", async () => {
    const cache = createTabThumbnailCache();
    const gate = Promise.withResolvers<string>();
    const first = vi.fn(() => gate.promise);
    const stale = cache.request("tab_1", "page-a", first);
    cache.invalidate("tab_1");
    const second = vi.fn(async () => "data:image/jpeg;base64,REVG");
    await expect(cache.request("tab_1", "page-a", second)).resolves.toBe(
      "data:image/jpeg;base64,REVG",
    );
    expect(second).toHaveBeenCalledTimes(1);
    gate.resolve(PICTURE);
    await expect(stale).resolves.toBe(PICTURE);
    expect(cache.get("tab_1", "page-a")).toBe("data:image/jpeg;base64,REVG");
  });
});

describe("isUsableThumbnailDataUrl", () => {
  it("accepts small image data URLs and rejects everything else", () => {
    expect(isUsableThumbnailDataUrl(PICTURE)).toBe(true);
    expect(isUsableThumbnailDataUrl(null)).toBe(false);
    expect(isUsableThumbnailDataUrl("data:text/html;base64,QUJD")).toBe(false);
    expect(isUsableThumbnailDataUrl(`data:image/png;base64,${"A".repeat(300_000)}`)).toBe(false);
  });
});
