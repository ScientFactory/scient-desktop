import type { Cookie } from "playwright-core";
import type { BrowserContext } from "playwright-core";
import { expect, it, vi } from "vite-plus/test";
import { keepServerSessionCookies, keptCookies } from "./keepServerSessionCookies.ts";

const cookie = (
  name: string,
  expires: number,
  value = "synthetic",
  fields: Partial<Cookie> = {},
): Cookie => ({
  name,
  value,
  domain: ".example.com",
  path: "/",
  expires,
  httpOnly: true,
  secure: true,
  sameSite: "Lax",
  ...fields,
});

it("gives a sign-in that ends with the browser an expiry, and leaves the others", () => {
  const now = 1_800_000_000;
  const read = [cookie("session", -1), cookie("remembered", now + 60)];
  const kept = keptCookies(read, read, now);
  expect(kept.map(({ name }) => name)).toEqual(["session"]);
  expect(kept[0]!.expires).toBeGreaterThan(now + 30 * 24 * 60 * 60);
  expect(kept[0]).toMatchObject({ domain: ".example.com", httpOnly: true, secure: true });
});

it("never writes back a cookie signed out or rotated since it was read", () => {
  const now = 1_800_000_000;
  const read = [cookie("signed-out", -1), cookie("rotated", -1, "old"), cookie("kept", -1)];
  const current = [cookie("rotated", -1, "new"), cookie("kept", -1)];
  expect(keptCookies(read, current, now).map(({ name }) => name)).toEqual(["kept"]);
});

it("keeps only sign-in cookies a page can't delete, with the flags they have now", () => {
  const now = 1_800_000_000;
  const read = [cookie("script", -1, "v", { httpOnly: false }), cookie("tightened", -1)];
  const current = [
    cookie("script", -1, "v", { httpOnly: false }),
    cookie("tightened", -1, "synthetic", { sameSite: "Strict" }),
  ];
  const kept = keptCookies(read, current, now);
  expect(kept.map(({ name }) => name)).toEqual(["tightened"]);
  expect(kept[0]!.sameSite).toBe("Strict");
});

it("writes nothing while Scient changes the jar, or once the site answered after the read", async () => {
  vi.useFakeTimers();
  try {
    const handlers = new Map<string, () => void>();
    const written: Array<ReadonlyArray<Cookie>> = [];
    let answerDuringRead = false;
    const context = {
      on: (event: string, handler: () => void) => void handlers.set(event, handler),
      cookies: async () => {
        // The site's answer lands between the two reads, as a sign-out's would.
        if (answerDuringRead) handlers.get("response")?.();
        return [cookie("session", -1)];
      },
      addCookies: async (cookies: ReadonlyArray<Cookie>) => void written.push(cookies),
    } as unknown as BrowserContext;
    let busy = true;
    keepServerSessionCookies(context, () => busy);
    const settle = async () => {
      handlers.get("response")?.();
      await vi.advanceTimersByTimeAsync(3_000);
    };
    await settle();
    expect(written).toEqual([]);
    busy = false;
    answerDuringRead = true;
    await settle();
    expect(written).toEqual([]);
    answerDuringRead = false;
    await vi.advanceTimersByTimeAsync(3_000);
    expect(written).toHaveLength(1);
  } finally {
    vi.useRealTimers();
  }
});
