import type { SessionCookie } from "@t3tools/contracts";
import { applyUnit, type CdpCookie } from "@t3tools/shared/scientSessionCookies";
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
  const lease = await pool.leases.lease("work");
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

/** A context that stopped answering: no command, page close or context close ever finishes. */
function hungContext() {
  const never = () => new Promise<never>(() => undefined);
  const page = { close: never, isClosed: () => false, url: () => "about:blank" };
  const pages: Array<typeof page> = [];
  return {
    newPage: async () => {
      pages.push(page);
      return page;
    },
    newCDPSession: async () => ({ send: never }),
    pages: () => pages,
    on: () => undefined,
    close: never,
  } as unknown as BrowserContext;
}

it("discards a context whose helper never closes, and the waiting tab opens a fresh one", async () => {
  const hung = hungContext();
  const fresh = stallingContext().context;
  const launch = vi
    .spyOn(chromium, "launchPersistentContext")
    .mockResolvedValueOnce(hung as never)
    .mockResolvedValueOnce(fresh as never);
  const pool = new ServerBrowserContexts({
    profilesDir: "/test/profiles",
    executable: async () => "/test/chromium",
    env: {},
  });
  const lease = await pool.leases.lease("work");
  const { jar, close } = await openProfileCookieJar(lease.context, lease.stopping, 30_000);
  // The copy as ServerBrowser.profileCookies runs it: the unit, then close and release.
  const copy = jar
    .readAll()
    .catch(() => undefined)
    .then(async () => {
      await close();
      await lease.release({ discard: jar.quarantined() });
    });
  let opened: BrowserContext | undefined;
  const tab = pool.contextFor("work").then((context) => (opened = context));
  // 30 s for the command, 30 s for the helper's close, 30 s for the context's close.
  await vi.advanceTimersByTimeAsync(60_000);
  expect([jar.stalled(), jar.quarantined(), opened]).toEqual([true, true, undefined]);
  await expect(jar.readAll()).rejects.toThrow();
  await vi.advanceTimersByTimeAsync(30_000);
  await copy;
  await tab;
  expect(opened).toBe(fresh);
  expect(launch).toHaveBeenCalledTimes(2);
  await pool.close();
});

/** A context whose helper pages answer cookie commands from one in-memory jar a page can write. */
function jarContext() {
  const cookies: CdpCookie[] = [];
  const slot = (cookie: { name: string; domain: string; path: string }) =>
    `${cookie.name} ${cookie.domain} ${cookie.path}`;
  const put = (cookie: CdpCookie) => {
    const index = cookies.findIndex((held) => slot(held) === slot(cookie));
    if (index >= 0) cookies.splice(index, 1);
    cookies.push(cookie);
  };
  const send = async (method: string, params: Record<string, unknown> = {}) => {
    if (method === "Network.getAllCookies") return { cookies: [...cookies] };
    if (method === "Network.setCookies")
      for (const param of params.cookies as Array<Record<string, unknown>>)
        put({
          name: param.name as string,
          value: param.value as string,
          domain: (param.domain as string | undefined) ?? new URL(param.url as string).hostname,
          path: param.path as string,
          expires: (param.expires as number | undefined) ?? -1,
          session: param.expires === undefined,
          secure: param.secure as boolean,
          httpOnly: param.httpOnly as boolean,
          sameSite: param.sameSite as CdpCookie["sameSite"],
        });
    if (method === "Network.deleteCookies") {
      const index = cookies.findIndex((held) => slot(held) === slot(params as never));
      if (index >= 0) cookies.splice(index, 1);
    }
    return {};
  };
  const context = {
    newPage: async () => ({ close: async () => undefined, isClosed: () => false, url: () => "" }),
    newCDPSession: async () => ({ send }),
    pages: () => [],
    cookies: async () => [],
  } as unknown as BrowserContext;
  return { context, cookies, put };
}

it("reads a unit afresh, so a page's write between two units is seen and kept", async () => {
  const { context, cookies, put } = jarContext();
  const { jar } = await openProfileCookieJar(context);
  const copy = (domain: string): SessionCookie => ({
    name: "session",
    value: "synthetic-desktop",
    domain,
    hostOnly: false,
    path: "/",
    secure: true,
    httpOnly: true,
    sameSite: "lax",
    expires: 4_000_000_000,
  });
  const fill = (site: string, domain: string) =>
    applyUnit(jar, {
      unit: [site],
      source: [copy(domain)],
      mode: "fill",
      replaceAllowed: false,
      nowSeconds: 1,
    });
  expect(await fill("github.com", ".github.com")).toBe("copied");
  // An open page signs in to Overleaf after the first unit: the next unit is no longer empty.
  put({
    ...copy(".overleaf.com"),
    value: "synthetic-site",
    expires: 4_000_000_000,
    session: false,
    sameSite: "Lax",
  });
  expect(await fill("overleaf.com", ".overleaf.com")).toBe("conflict");
  expect(cookies.find((cookie) => cookie.domain === ".overleaf.com")?.value).toBe("synthetic-site");
});
