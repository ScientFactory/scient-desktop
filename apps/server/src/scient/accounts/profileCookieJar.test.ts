import { chromium, type BrowserContext } from "playwright-core";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import { ServerBrowserContexts } from "../../preview/ServerBrowserContexts.ts";
import { openProfileCookieJar } from "./profileCookieJar.ts";

vi.mock("node:fs/promises", () => ({
  mkdir: vi.fn(async () => undefined),
  rm: vi.fn(async () => undefined),
  chmod: vi.fn(async () => undefined),
}));

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

/** A context whose first page's CDP calls never answer; later pages answer at once. */
function stallingContext() {
  const pages: Array<{ closed: boolean; close: () => Promise<void> }> = [];
  const context = {
    newPage: async () => {
      const page = {
        closed: false,
        close: async () => void (page.closed = true),
        isClosed: () => page.closed,
        url: () => "about:blank",
      };
      pages.push(page);
      return page;
    },
    newCDPSession: async (page: unknown) => ({
      send: () =>
        page === pages[0] ? new Promise(() => undefined) : Promise.resolve({ cookies: [] }),
    }),
    pages: () => pages.filter((page) => !page.closed),
    on: () => undefined,
    close: async () => undefined,
  } as unknown as BrowserContext;
  return { context, pages };
}

it("aborts a stalled cookie operation at its deadline and runs the next on a fresh page", async () => {
  const { context, pages } = stallingContext();
  const { jar, close } = await openProfileCookieJar(context, () => false, 30_000);
  const stalled = jar.readAll();
  const failure = expect(stalled).rejects.toThrow();
  await vi.advanceTimersByTimeAsync(29_999);
  expect(jar.stalled()).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  await failure;
  expect(jar.stalled()).toBe(true);
  expect(pages[0]?.closed).toBe(true);
  // A restore after the stall still reaches the jar, on a new helper page.
  expect(await jar.readAll()).toEqual([]);
  expect(pages).toHaveLength(2);
  expect(jar.openTabSites()).toEqual([]);
  await close();
  expect(pages.every((page) => page.closed)).toBe(true);
});

it("lets a waiting tab in once a stalled operation is aborted and the copy gives the hold back", async () => {
  const { context } = stallingContext();
  vi.spyOn(chromium, "launchPersistentContext").mockResolvedValue(context as never);
  const pool = new ServerBrowserContexts({
    profilesDir: "/test/profiles",
    executable: async () => "/test/chromium",
    env: {},
  });
  const lease = await pool.lease("work");
  const { jar, close } = await openProfileCookieJar(lease.context, lease.stopping, 30_000);
  // The copy as the receiver runs it: a stalled unit ends, then the hold is released.
  const copy = jar
    .readAll()
    .catch(() => undefined)
    .then(async () => {
      await close();
      await lease.release();
    });
  let opened = false;
  const tab = pool.contextFor("work").then(() => (opened = true));
  await vi.advanceTimersByTimeAsync(29_000);
  expect(opened).toBe(false);
  await vi.advanceTimersByTimeAsync(1_000);
  await copy;
  await tab;
  expect([opened, jar.stalled()]).toEqual([true, true]);
  await pool.close();
});
