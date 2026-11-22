import type { SessionCookie } from "@t3tools/contracts";
import { applyUnit, unitCookies, type CookieStore } from "@t3tools/shared/scientSessionCookies";
import { describe, expect, it, vi } from "vite-plus/test";

import { gatedStore } from "./mainFill.ts";

vi.mock("electron", () => ({
  BrowserWindow: {},
  app: {},
  webContents: {},
  session: {},
  nativeImage: {},
  shell: {},
  clipboard: {},
  ClipboardItem: {},
}));

const cookie = (name: string): SessionCookie => ({
  name,
  value: "synthetic",
  domain: ".overleaf.com",
  hostOnly: false,
  path: "/",
  secure: true,
  httpOnly: true,
  sameSite: "lax",
});

/** Main's jar, in memory, and every write that reached it. */
function jar(initial: ReadonlyArray<SessionCookie>) {
  let cookies = [...initial];
  const writes: Array<string> = [];
  const store: CookieStore = {
    readUnit: async (unit) => unitCookies(unit, cookies),
    set: async (written) => {
      writes.push("set");
      cookies = [...cookies, ...written];
    },
    remove: async (removed) => {
      writes.push("remove");
      cookies = cookies.filter((held) => !removed.some((gone) => gone.name === held.name));
    },
  };
  return { store, writes, cookies: () => cookies };
}

const copy = (store: CookieStore) =>
  applyUnit(store, {
    unit: ["overleaf.com"],
    source: [cookie("session")],
    mode: "fill-or-replace",
    replaceAllowed: true,
    nowSeconds: 0,
  });

describe("a copy into Main stopped before its first write", () => {
  it("leaves Main as it was when going ahead is refused at the first write", async () => {
    const main = jar([cookie("old")]);
    const proceed = vi.fn(() => false);
    const gated = gatedStore(main.store, proceed);
    await copy(gated.store);
    expect(main.writes).toEqual([]);
    expect(main.cookies().map(({ name }) => name)).toEqual(["old"]);
    expect(gated.stopped()).toBe(true);
    expect(proceed).toHaveBeenCalledOnce();
  });

  it("writes once going ahead is allowed, asking only once", async () => {
    const main = jar([]);
    const proceed = vi.fn(() => true);
    const gated = gatedStore(main.store, proceed);
    expect(await copy(gated.store)).toBe("copied");
    expect(main.cookies().map(({ name }) => name)).toEqual(["session"]);
    expect(gated.stopped()).toBe(false);
    expect(proceed).toHaveBeenCalledOnce();
  });
});
