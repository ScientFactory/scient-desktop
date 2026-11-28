import { afterEach, describe, expect, it } from "@effect/vitest";
import { cookieValueDigest } from "@t3tools/shared/scientCookieWriteBack";
import type { CDPSession, Page } from "playwright-core";

import { typeAccountValue, waitForAccountPage, writeAccountCookie } from "./browserOperations.ts";

/** A tab's jar over CDP: `jar` is what Network.getCookies answers; writes are recorded. */
const cdpWith = (jar: Array<Record<string, unknown>>) => {
  const writes: string[] = [];
  const cdp = {
    send: async (method: string) => {
      if (method === "Network.getCookies") return { cookies: jar };
      writes.push(method);
      return {};
    },
  } as unknown as CDPSession;
  return { cdp, writes };
};

const slot = {
  name: "sid",
  value: "synthetic-old",
  domain: "hours.example.test",
  path: "/",
  secure: true,
  httpOnly: true,
  sameSite: "Lax",
};
const write = {
  url: "https://hours.example.test/",
  name: "sid",
  path: "/",
  expected: cookieValueDigest("synthetic-old"),
  sameSite: "lax",
};

describe("writeAccountCookie", () => {
  it("writes nothing over a slot that is no longer the Secure, HttpOnly one Scient read", async () => {
    // regression: only the value was compared, so a same-value cookie a page made readable was replaced.
    const { cdp, writes } = cdpWith([{ ...slot, httpOnly: false }]);
    expect(await writeAccountCookie(cdp, write)).toEqual({ outcome: "changed" });
    expect(writes).toEqual([]);
    const unchanged = cdpWith([slot]);
    expect(await writeAccountCookie(unchanged.cdp, write)).toEqual({ outcome: "lost" });
    expect(unchanged.writes).toEqual(["Network.deleteCookies"]);
  });

  it("writes nothing over a slot the site tightened to Strict with the same value", async () => {
    // regression: SameSite was left out of the compare, so the tightened slot was replaced.
    const { cdp, writes } = cdpWith([{ ...slot, sameSite: "Strict" }]);
    expect(await writeAccountCookie(cdp, write)).toEqual({ outcome: "changed" });
    expect(writes).toEqual([]);
  });
});

describe("waitForAccountPage", () => {
  it("with a load bound, goes on when the page hasn't loaded by then", async () => {
    const asked: number[] = [];
    const page = {
      waitForLoadState: async (_state: string, options: { timeout: number }) => {
        asked.push(options.timeout);
        throw new Error("Timeout");
      },
      waitForTimeout: async () => undefined,
    } as unknown as Page;
    // The look right after a submit: a code page is read within a second, loaded or not.
    expect(await waitForAccountPage(page, { loadMs: 1000 }, 15_000)).toEqual({});
    expect(asked).toEqual([1000]);
    // Without one, a page that never loads is still a failure.
    await expect(waitForAccountPage(page, {}, 15_000)).rejects.toThrow("Timeout");
  });
});

describe("typeAccountValue", () => {
  const before = process.env.DEBUG;
  afterEach(() => {
    if (before === undefined) delete process.env.DEBUG;
    else process.env.DEBUG = before;
  });

  /** A tab whose accounts world says the secret went in, as long as Scient got as far as typing it. */
  const page = {} as Page;
  const cdp = {
    send: async (method: string) =>
      method === "Page.getFrameTree"
        ? { frameTree: { frame: { id: "frame", loaderId: "load" } } }
        : method === "Page.createIsolatedWorld"
          ? { executionContextId: 1 }
          : { result: { value: true } },
  } as unknown as CDPSession;
  const typeSecret = () =>
    typeAccountValue(page, cdp, {
      origin: "https://example.com",
      selector: "#password",
      text: "synthetic-secret",
      clear: true,
      secret: true,
    });

  it("types no secret while any setting of DEBUG turns on a Playwright log", async () => {
    for (const setting of ["pw*", "*protocol", "pw:prot*", "pw:server:channel", "x, *"]) {
      process.env.DEBUG = setting;
      await expect(typeSecret(), setting).rejects.toThrow("Browser debugging is on");
    }
    for (const setting of ["", "express:*", "pw:*,-pw:*"]) {
      process.env.DEBUG = setting;
      await expect(typeSecret(), setting).resolves.toEqual({});
    }
  });
});
