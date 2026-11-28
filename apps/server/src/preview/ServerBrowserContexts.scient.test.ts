import * as NodeEvents from "node:events";

import { INCOGNITO_BROWSER_PROFILE_ID } from "@t3tools/contracts";
import { chromium, type BrowserContext, type BrowserType } from "playwright-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { ServerBrowserContexts } from "./ServerBrowserContexts.ts";

const launches = vi.hoisted(() => ({
  persistent: vi.fn<BrowserType["launchPersistentContext"]>(),
  mkdir: vi.fn().mockResolvedValue(undefined),
  rm: vi.fn().mockResolvedValue(undefined),
  chmod: vi.fn().mockResolvedValue(undefined),
  readdir: vi.fn().mockResolvedValue([] as string[]),
}));
vi.spyOn(chromium, "launchPersistentContext").mockImplementation(launches.persistent);
vi.mock("node:fs/promises", () => ({
  mkdir: launches.mkdir,
  rm: launches.rm,
  chmod: launches.chmod,
  readdir: launches.readdir,
}));

const makeContext = () => {
  const events = new NodeEvents.EventEmitter();
  let closed = false;
  return {
    on: vi.fn((event: string, listener: () => void) => events.on(event, listener)),
    pages: vi.fn(() => []),
    close: vi.fn(async () => {
      if (!closed) {
        closed = true;
        events.emit("close");
      }
    }),
  };
};

const options = () => ({
  profilesDir: "/test/profiles",
  executable: vi.fn(async () => "/test/chromium"),
  env: {},
  chrome: { version: "157.0.8103.78", platform: "linux" as NodeJS.Platform },
});

beforeEach(() => {
  launches.persistent.mockReset();
  launches.rm.mockClear();
  launches.chmod.mockClear();
});

describe("ServerBrowserContexts lease", () => {
  // Fake time short of the 10 s limit lets every pending promise chain run.
  const settle = () => vi.advanceTimersByTimeAsync(5_000);
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("makes a profile's directory private to the server's user", async () => {
    launches.persistent.mockResolvedValue(makeContext() as unknown as BrowserContext);
    const pool = new ServerBrowserContexts(options());
    await pool.contextFor("work");
    expect(launches.chmod).toHaveBeenCalledWith("/test/profiles/work", 0o700);
    await pool.close();
  });

  it("holds tab creation and clears until the copy releases the profile", async () => {
    const context = makeContext();
    launches.persistent.mockResolvedValue(context as unknown as BrowserContext);
    const pool = new ServerBrowserContexts(options());
    const lease = await pool.leases.lease("work");
    const order: string[] = [];
    const tab = pool.contextFor("work").then(() => order.push("tab"));
    const clear = pool.clearProfile("work").then(() => order.push("clear"));
    await settle();
    expect(order).toEqual([]);
    expect(launches.rm).not.toHaveBeenCalled();
    order.push("released");
    await lease.release();
    await Promise.all([tab, clear]);
    expect(order[0]).toBe("released");
    expect(launches.rm).toHaveBeenCalledTimes(1);
    await pool.close();
  });

  it("never lets a tab in alongside a hold; after 10 s it asks the copy to stop", async () => {
    const context = makeContext();
    launches.persistent.mockResolvedValue(context as unknown as BrowserContext);
    const pool = new ServerBrowserContexts(options());
    const lease = await pool.leases.lease("work");
    let opened = false;
    const tab = pool.contextFor("work").then(() => (opened = true));
    await vi.advanceTimersByTimeAsync(9_999);
    expect(lease.stopping()).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(lease.stopping()).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(opened).toBe(false);
    await lease.release();
    await tab;
    expect(opened).toBe(true);
    expect(context.close).not.toHaveBeenCalled();
    await pool.close();
  });

  it("lets a tab that waited go before the next hold", async () => {
    launches.persistent.mockResolvedValue(makeContext() as unknown as BrowserContext);
    const pool = new ServerBrowserContexts(options());
    const first = await pool.leases.lease("work");
    const order: string[] = [];
    const tab = pool.contextFor("work").then(() => order.push("tab"));
    const next = pool.leases.lease("work").then((lease) => {
      order.push("next hold");
      return lease;
    });
    await settle();
    expect(order).toEqual([]);
    await first.release();
    await tab;
    await (await next).release();
    expect(order).toEqual(["tab", "next hold"]);
    await pool.close();
  });

  it("closes a context the hold opened when no tab needs it, and never one a tab opened", async () => {
    const opened = makeContext();
    launches.persistent.mockResolvedValueOnce(opened as unknown as BrowserContext);
    const pool = new ServerBrowserContexts(options());
    await (await pool.leases.lease("work")).release();
    expect(opened.close).toHaveBeenCalledTimes(1);

    const tabs = makeContext();
    launches.persistent.mockResolvedValueOnce(tabs as unknown as BrowserContext);
    const context = await pool.contextFor("work");
    const lease = await pool.leases.lease("work");
    expect(lease.context).toBe(context);
    await lease.release();
    expect(tabs.close).not.toHaveBeenCalled();
    await expect(pool.leases.lease(INCOGNITO_BROWSER_PROFILE_ID)).rejects.toThrow("Incognito");
    await pool.close();
  });

  it("runs one hold of a profile at a time", async () => {
    launches.persistent.mockResolvedValue(makeContext() as unknown as BrowserContext);
    const pool = new ServerBrowserContexts(options());
    const first = await pool.leases.lease("work");
    let second = false;
    const waiting = pool.leases.lease("work").then((lease) => {
      second = true;
      return lease;
    });
    await settle();
    expect(second).toBe(false);
    await first.release();
    await (await waiting).release();
    await pool.close();
  });
});

describe("ServerBrowserContexts generations (round 6b)", () => {
  it("opens a cleared profile in a new folder, keeps the old one, and purges by generation", async () => {
    const first = makeContext();
    const second = makeContext();
    launches.persistent
      .mockResolvedValueOnce(first as unknown as BrowserContext)
      .mockResolvedValueOnce(second as unknown as BrowserContext);
    const pool = new ServerBrowserContexts(options());
    await pool.contextFor("work");
    expect(launches.persistent.mock.calls[0]?.[0]).toBe("/test/profiles/work");
    // Clear: generation 1. The open context closes; the next tab opens the new folder.
    pool.setGenerations(new Map([["work", 1]]));
    await pool.closeProfile("work");
    expect(first.close).toHaveBeenCalled();
    await pool.contextFor("work");
    expect(launches.persistent.mock.calls[1]?.[0]).toBe("/test/profiles/work%7Eg1");
    // The old generation goes alone once its hour is over; nothing was deleted before.
    expect(launches.rm).not.toHaveBeenCalled();
    await pool.purgeProfile("work", 0);
    expect(launches.rm).toHaveBeenCalledWith("/test/profiles/work", expect.anything());
    // A removed profile: every generation's folder, and no one else's.
    launches.rm.mockClear();
    launches.readdir.mockResolvedValueOnce(["work", "work%7Eg1", "work%7Eg3", "workshop", "home"]);
    await pool.purgeProfile("work");
    expect(launches.rm.mock.calls.map(([path]) => path).toSorted()).toEqual([
      "/test/profiles/work",
      "/test/profiles/work%7Eg1",
      "/test/profiles/work%7Eg3",
    ]);
    await pool.close();
  });
});

describe("each generation's folder is its own (round 6c, finding 7)", () => {
  it("purges a profile's generations without touching a profile named like one", async () => {
    launches.readdir.mockResolvedValueOnce([
      "work",
      "work%7Eg1",
      "work%7Eg2",
      // Another profile whose id happens to look like a generation of Work.
      "work~g1",
      "work~g1%7Eg1",
    ]);
    const contexts = new ServerBrowserContexts(options());
    await contexts.purgeProfile("work");
    expect(launches.rm.mock.calls.map(([path]) => path)).toEqual([
      "/test/profiles/work",
      "/test/profiles/work%7Eg1",
      "/test/profiles/work%7Eg2",
    ]);
    launches.rm.mockClear();
    // And one generation of the look-alike is its own folder.
    await contexts.purgeProfile("work~g1", 1);
    expect(launches.rm.mock.calls.map(([path]) => path)).toEqual(["/test/profiles/work~g1%7Eg1"]);
  });
});

describe("a jar's generation is the one its context opened in (round 6e)", () => {
  it("names the open context's generation until it closes, then the profile's", async () => {
    const first = makeContext();
    launches.persistent.mockResolvedValueOnce(first as unknown as BrowserContext);
    const pool = new ServerBrowserContexts(options());
    await pool.contextFor("work");
    expect(pool.contextGeneration("work")).toBe(0);
    // Cleared: the generation moves on, but the jar a hold gets now is still generation 0's.
    pool.setGenerations(new Map([["work", 1]]));
    // regression: a write bound to generation 0 couldn't tell it would land in the old jar.
    expect(pool.contextGeneration("work")).toBe(0);
    await pool.closeProfile("work");
    expect(pool.contextGeneration("work")).toBe(1);
    await pool.close();
  });
});
