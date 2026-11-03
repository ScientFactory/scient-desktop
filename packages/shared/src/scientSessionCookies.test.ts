import type { SessionCookie } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import {
  applyUnit,
  cookieSlot,
  decideUnit,
  type CookieStore,
  jarUnits,
  sameUnit,
  sessionCookieFromCdp,
  sessionCookieFromImported,
  sessionCookieToCdpParam,
} from "./scientSessionCookies.ts";

/** Last two labels, enough for the synthetic hosts here. */
const siteOf = (host: string) => host.split(".").slice(-2).join(".");
const NOW = 1_000_000;

const cookie = (overrides: Partial<SessionCookie> = {}): SessionCookie => ({
  name: "session",
  value: "synthetic-a",
  domain: ".example.test",
  hostOnly: false,
  path: "/",
  secure: true,
  httpOnly: true,
  sameSite: "lax",
  expires: NOW + 3600,
  ...overrides,
});
const cdp = {
  name: "session",
  value: "synthetic-a",
  domain: "app.example.test",
  path: "/",
  expires: -1,
  session: true,
  secure: false,
  httpOnly: false,
};

describe("conversions", () => {
  it("keeps a session cookie without expiry, a host-only domain and the stored ancestor bit", () => {
    expect(sessionCookieFromCdp(cdp)).toEqual({
      name: "session",
      value: "synthetic-a",
      domain: "app.example.test",
      hostOnly: true,
      path: "/",
      secure: false,
      httpOnly: false,
      sameSite: "unspecified",
    });
    const partitioned = sessionCookieFromCdp({
      ...cdp,
      domain: ".example.test",
      session: false,
      expires: NOW,
      sameSite: "None",
      partitionKey: { topLevelSite: "https://top.test", hasCrossSiteAncestor: true },
    });
    expect(partitioned).toMatchObject({
      hostOnly: false,
      expires: NOW,
      sameSite: "no_restriction",
      partitionKey: { topLevelSite: "https://top.test", hasCrossSiteAncestor: true },
    });
  });

  it("refuses opaque and string partition keys", () => {
    expect(sessionCookieFromCdp({ ...cdp, partitionKeyOpaque: true })).toEqual({
      unsupported: "opaque-partition",
    });
    expect(sessionCookieFromCdp({ ...cdp, partitionKey: "https://top.test" })).toEqual({
      unsupported: "string-partition",
    });
  });

  it("writes prefixed and secure cookies from https, host-only ones without a domain", () => {
    const host = sessionCookieToCdpParam(
      cookie({ name: "__Host-x", domain: "app.example.test", hostOnly: true, secure: true }),
    );
    expect(host).toMatchObject({ url: "https://app.example.test/" });
    expect(host).not.toHaveProperty("domain");
    expect(
      sessionCookieToCdpParam(cookie({ name: "__Secure-y", secure: false, expires: undefined })),
    ).toEqual({
      name: "__Secure-y",
      value: "synthetic-a",
      url: "https://example.test/",
      domain: ".example.test",
      path: "/",
      secure: false,
      httpOnly: true,
      sameSite: "Lax",
    });
    expect(
      sessionCookieToCdpParam(cookie({ secure: false, sameSite: "unspecified" })),
    ).toMatchObject({ url: "http://example.test/", expires: NOW + 3600 });
  });

  it("takes an imported cookie's host from its URL when it is host-only", () => {
    expect(
      sessionCookieFromImported({
        url: "https://app.example.test/",
        name: "session",
        value: "synthetic-a",
        domain: undefined,
        path: "/",
        secure: true,
        httpOnly: true,
        expirationDate: undefined,
        sameSite: "strict",
      }),
    ).toEqual({
      name: "session",
      value: "synthetic-a",
      domain: "app.example.test",
      hostOnly: true,
      path: "/",
      secure: true,
      httpOnly: true,
      sameSite: "strict",
    });
  });
});

describe("sameUnit", () => {
  it("compares every attribute, the value and the expiry within a second", () => {
    expect(sameUnit([cookie()], [cookie({ expires: NOW + 3600.5 })])).toBe(true);
    for (const different of [
      { value: "synthetic-b" },
      { httpOnly: false },
      { sameSite: "strict" as const },
      { expires: undefined },
      { path: "/app" },
      { partitionKey: { topLevelSite: "https://top.test", hasCrossSiteAncestor: false } },
    ])
      expect(sameUnit([cookie()], [cookie(different)])).toBe(false);
  });

  it("does not take a group of JavaScript-readable cookies for an empty one", () => {
    expect(sameUnit([cookie({ httpOnly: false })], [])).toBe(false);
  });
});

describe("decideUnit", () => {
  const decide = (input: Partial<Parameters<typeof decideUnit>[0]>) =>
    decideUnit({
      unit: ["example.test"],
      source: [cookie()],
      target: [],
      mode: "fill",
      replaceAllowed: false,
      nowSeconds: NOW,
      siteOf,
      ...input,
    });

  it("copies into an empty unit, counting expired cookies as empty", () => {
    expect(decide({})).toBe("copy");
    expect(decide({ target: [cookie({ value: "old", expires: NOW - 1 })] })).toBe("copy");
    expect(decide({ target: [cookie()] })).toBe("same");
    expect(decide({ source: [cookie({ domain: ".other.test" })] })).toBe("blocked");
  });

  it("leaves an occupied unit alone unless replace is allowed, and never replaces Google", () => {
    const occupied = { target: [cookie({ value: "synthetic-b" })] };
    expect(decide(occupied)).toBe("conflict");
    expect(decide({ ...occupied, mode: "fill-or-replace" })).toBe("conflict");
    expect(decide({ ...occupied, replaceAllowed: true })).toBe("conflict");
    expect(decide({ ...occupied, mode: "fill-or-replace", replaceAllowed: true })).toBe("copy");
    const google = (value: string) => cookie({ domain: ".google.com", value });
    expect(
      decide({
        unit: ["accounts.google.com"],
        source: [google("synthetic-a")],
        target: [google("synthetic-b")],
        mode: "fill-or-replace",
        replaceAllowed: true,
      }),
    ).toBe("conflict");
  });

  it("decides a multi-site sign-in as one unit", () => {
    const unit = ["https://idp.uni.test", "proxy.test"];
    const source = [
      cookie({ domain: "idp.uni.test", hostOnly: true }),
      cookie({ domain: ".proxy.test" }),
    ];
    // Main holds another identity's proxy session and no IdP session: nothing is copied.
    expect(decide({ unit, source, target: [cookie({ domain: ".proxy.test", value: "b" })] })).toBe(
      "conflict",
    );
    expect(jarUnits(source, siteOf, [unit])).toEqual([["uni.test", "proxy.test"]]);
    expect(jarUnits(source, siteOf)).toEqual([["uni.test"], ["proxy.test"]]);
  });
});

describe("applyUnit", () => {
  const key = (c: Pick<SessionCookie, "name" | "domain" | "path">) => cookieSlot(c);
  /** An in-memory jar whose writes can be broken on purpose. */
  const jar = (initial: ReadonlyArray<SessionCookie>) => {
    const cookies = new Map(initial.map((c) => [key(c), c]));
    // `corrupt` breaks only the next write, so the restore that follows can succeed.
    const faults = { corrupt: false, failSetAfter: Infinity, failRestore: false };
    let sets = 0;
    const store: CookieStore = {
      readUnit: async () => {
        return [...cookies.values()];
      },
      set: async (written) => {
        sets += 1;
        if (sets > 1 && faults.failRestore) throw new Error("synthetic restore failure");
        const corrupt = faults.corrupt;
        faults.corrupt = false;
        for (const [index, c] of written.entries()) {
          if (index >= faults.failSetAfter) throw new Error("synthetic partial write");
          cookies.set(key(c), corrupt ? { ...c, httpOnly: !c.httpOnly } : c);
        }
      },
      remove: async (removed) => {
        for (const c of removed) cookies.delete(key(c));
      },
    };
    return { store, cookies, faults };
  };
  const plan = {
    unit: ["example.test"],
    source: [cookie(), cookie({ name: "csrf", httpOnly: false })],
    mode: "fill-or-replace" as const,
    replaceAllowed: true,
    nowSeconds: NOW,
    siteOf,
  };
  const occupied = [cookie({ value: "synthetic-b" }), cookie({ name: "old", value: "b" })];

  it("copies a unit and reads the whole unit back", async () => {
    const target = jar([]);
    expect(await applyUnit(target.store, plan)).toBe("copied");
    expect(sameUnit([...target.cookies.values()], plan.source)).toBe(true);
    expect(await applyUnit(jar(occupied).store, { ...plan, replaceAllowed: false })).toBe(
      "conflict",
    );
  });

  it("restores an occupied destination exactly when the check fails", async () => {
    const target = jar(occupied);
    target.faults.corrupt = true;
    expect(await applyUnit(target.store, plan)).toBe("failed");
    expect(sameUnit([...target.cookies.values()], occupied)).toBe(true);
  });

  it("undoes a partial batch write and a write whose read-back failed", async () => {
    const partial = jar([]);
    partial.faults.failSetAfter = 1;
    expect(await applyUnit(partial.store, plan)).toBe("failed");
    expect(partial.cookies.size).toBe(0);
    const unread = jar(occupied);
    let reads = 0;
    const store: CookieStore = {
      ...unread.store,
      readUnit: async (unit) => {
        reads += 1;
        if (reads === 2) throw new Error("synthetic read-back failure");
        return unread.store.readUnit(unit);
      },
    };
    expect(await applyUnit(store, plan)).toBe("failed");
    expect(sameUnit([...unread.cookies.values()], occupied)).toBe(true);
  });

  it("reports a restore that fails", async () => {
    const target = jar(occupied);
    target.faults.corrupt = true;
    target.faults.failRestore = true;
    expect(await applyUnit(target.store, plan)).toBe("restore-failed");
  });

  it("accepts a page's insert during the copy, and the restore leaves it", async () => {
    const target = jar(occupied);
    const page = cookie({ name: "page", value: "from-the-site" });
    const changed = new Set<string>();
    const store: CookieStore = {
      ...target.store,
      set: async (written) => {
        await target.store.set(written);
        target.cookies.set(key(page), page);
        changed.add(cookieSlot(page));
      },
    };
    expect(await applyUnit(store, { ...plan, foreign: () => changed })).toBe("copied");
    target.faults.corrupt = true;
    target.cookies.clear();
    for (const c of occupied) target.cookies.set(key(c), c);
    changed.clear();
    expect(await applyUnit(store, { ...plan, foreign: () => changed })).toBe("failed");
    expect(target.cookies.get(key(page))).toEqual(page);
    expect(
      sameUnit(
        [...target.cookies.values()].filter((c) => c.name !== "page"),
        occupied,
      ),
    ).toBe(true);
  });
});
