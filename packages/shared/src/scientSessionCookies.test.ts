// @effect-diagnostics nodeBuiltinImport:off -- Node's own digest pins the stored fingerprint format.
import * as NodeCrypto from "node:crypto";

import type { SessionCookie } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import {
  applyUnit,
  cookieSlot,
  decideUnit,
  type CookieStore,
  jarUnits,
  mergeUnits,
  planDelivery,
  remoteControls,
  sameUnit,
  shareable,
  travels,
  unitCookies,
  unitFingerprint,
  withdrawCopies,
  sessionCookieFromCdp,
  sessionCookieFromImported,
  sessionCookieToCdpParam,
} from "./scientSessionCookies.ts";

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
    expect(jarUnits(source, [unit])).toEqual([["uni.test", "proxy.test"]]);
    expect(jarUnits(source)).toEqual([["uni.test"], ["proxy.test"]]);
  });
});

describe("applyUnit", () => {
  // A jar holds one cookie per slot and partition.
  const key = (c: Pick<SessionCookie, "name" | "domain" | "path" | "partitionKey">) =>
    JSON.stringify([cookieSlot(c), c.partitionKey ?? null]);
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
        // The snapshot, the last look before writing, then the read-back.
        if (reads === 3) throw new Error("synthetic read-back failure");
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
    const changed = new Map<string, SessionCookie>();
    const store: CookieStore = {
      ...target.store,
      set: async (written) => {
        await target.store.set(written);
        target.cookies.set(key(page), page);
        changed.set(cookieSlot(page), page);
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

  it("leaves the unit to a site that wrote it since the snapshot, and writes nothing", async () => {
    const target = jar(occupied);
    let reads = 0;
    const sets: unknown[] = [];
    const store: CookieStore = {
      ...target.store,
      readUnit: async (unit) => {
        reads += 1;
        // A response lands between the snapshot and the last look before writing.
        if (reads === 2) target.cookies.set(key(occupied[0]!), { ...occupied[0]!, value: "newer" });
        return target.store.readUnit(unit);
      },
      set: async (written) => void sets.push(written),
    };
    expect(await applyUnit(store, plan)).toBe("busy");
    expect(sets).toEqual([]);
    expect(target.cookies.get(key(occupied[0]!))?.value).toBe("newer");
  });

  it("gives a slot back to the site when a navigation wrote it just before the copy did", async () => {
    // The site's session cookie lands first; the copy then writes the same name over it.
    const target = jar([]);
    const site = cookie({ value: "from-the-site", expires: NOW + 7200 });
    const changed = new Map<string, SessionCookie>();
    const store: CookieStore = {
      ...target.store,
      set: async (written) => {
        if (changed.size === 0) {
          target.cookies.set(key(site), site);
          changed.set(cookieSlot(site), site);
        }
        await target.store.set(written);
      },
    };
    expect(await applyUnit(store, { ...plan, foreign: () => changed })).toBe("busy");
    expect(target.cookies.get(key(site))).toEqual(site);
    // The rest of the copy is undone too: the unit is the site's, not half of each.
    expect([...target.cookies.values()]).toEqual([site]);
  });

  describe("a partitioned slot a site wrote during the copy", () => {
    const partitionKey = { topLevelSite: "https://top.test", hasCrossSiteAncestor: false };
    const copy = cookie({
      name: "chip",
      value: "from-work",
      sameSite: "no_restriction",
      partitionKey,
    });
    const site = { ...copy, value: "from-the-site" };
    // What the site's write looks like to the watcher: Electron's event names no partition.
    const { partitionKey: _, ...seen } = site;
    const race = (order: "site-first" | "copy-first") => {
      const target = jar([]);
      const changed = new Map<string, SessionCookie>();
      const store: CookieStore = {
        ...target.store,
        set: async (written) => {
          const first = changed.size === 0;
          if (first && order === "site-first") target.cookies.set(key(site), site);
          await target.store.set(written);
          if (first && order === "copy-first") target.cookies.set(key(site), site);
          if (first) changed.set(cookieSlot(seen), seen);
        },
      };
      return {
        target,
        run: () => applyUnit(store, { ...plan, source: [copy], foreign: () => changed }),
      };
    };

    it("clears only the copy's value after a navigation wrote first, and writes no stand-in", async () => {
      const { target, run } = race("site-first");
      expect(await run()).toBe("busy");
      // The site's partitioned value was overwritten and can't be rebuilt exactly; nothing stands in.
      expect([...target.cookies.values()]).toEqual([]);
    });

    it("leaves the site's value when it wrote after the copy", async () => {
      const { target, run } = race("copy-first");
      expect(await run()).toBe("busy");
      expect([...target.cookies.values()]).toEqual([site]);
    });
  });
});

describe("mergeUnits", () => {
  it("makes sign-ins that share a site, directly or through others, one unit", () => {
    const first = ["https://idp.uni.test", "proxya.test"];
    const second = ["https://idp.uni.test", "proxyb.test"];
    expect(mergeUnits([first, second, ["other.test"]])).toEqual([
      ["https://idp.uni.test", "proxya.test", "proxyb.test"],
      ["other.test"],
    ]);
    const jar = ["idp.uni.test", "proxya.test", "proxyb.test"].map((domain) =>
      cookie({ domain, hostOnly: true }),
    );
    // Two university rows with one IdP and different proxies are one component, decided once.
    expect(jarUnits(jar, [first, second])).toEqual([["uni.test", "proxya.test", "proxyb.test"]]);
  });
});

describe("sharing with other computers", () => {
  const allowed = {
    access: "allowed",
    scope: { type: "all-projects" },
    scriptSignIn: true,
  } as const;

  it("shares persistent profiles Allowed or Ask for all projects with scripts on", () => {
    expect(shareable("work", allowed)).toBe(true);
    expect(shareable("work", { ...allowed, access: "ask" })).toBe(true);
    expect(shareable("incognito", allowed)).toBe(false);
    expect(shareable("work", { ...allowed, access: "off" })).toBe(false);
    expect(shareable("work", { ...allowed, scriptSignIn: false })).toBe(false);
    const limited = { ...allowed, scope: { type: "projects", projectIds: [] } } as const;
    expect(shareable("work", limited)).toBe(false);
    expect(remoteControls(limited)).toEqual({ ...allowed, access: "off" });
  });

  it("keeps the university's sign-in and OpenAthens on this computer", () => {
    const university = ["https://idp.huji.ac.il/login", "huji.ac.il"];
    expect(travels(["github.com"], university)).toBe(true);
    expect(travels(["cc.huji.ac.il"], university)).toBe(false);
    expect(travels(["login.openathens.net"], [])).toBe(false);
  });

  const applied = (
    units: Array<{ sites: string[]; revision: number }> = [],
    withdrawn?: number,
  ) => ({
    bound: true,
    ...(withdrawn === undefined ? {} : { withdrawn }),
    units: units.map((unit) => ({ ...unit, outcome: "copied" as const })),
  });
  const plan = (input: Partial<Parameters<typeof planDelivery>[0]>) =>
    planDelivery({
      log: { head: 0, units: [] },
      applied: applied(),
      jar: [],
      shareable: true,
      travels: () => true,
      ...input,
    });

  it("fills a computer that never received from this desktop with the whole jar", () => {
    expect(
      plan({
        log: { head: 7, units: [{ sites: ["github.com"], revision: 3, kind: "copy" }] },
        applied: { bound: false, units: [] },
        jar: [["github.com"], ["example.test"]],
      }),
    ).toEqual({
      kind: "units",
      mode: "fill",
      head: 7,
      units: [
        { sites: ["github.com"], revision: 7, kind: "copy" },
        { sites: ["example.test"], revision: 7, kind: "copy" },
      ],
    });
  });

  it("sends only revisions newer than what the computer applied, and never replays an old one", () => {
    const log = {
      head: 9,
      units: [
        { sites: ["github.com"], revision: 4, kind: "copy" as const },
        { sites: ["example.test"], revision: 9, kind: "copy" as const },
      ],
    };
    const result = plan({
      log,
      applied: applied([
        { sites: ["github.com"], revision: 4 },
        { sites: ["example.test"], revision: 5 },
      ]),
      jar: [["github.com"], ["example.test"]],
    });
    expect(result).toMatchObject({
      mode: "replace",
      units: [{ sites: ["example.test"], revision: 9, kind: "copy" }],
    });
  });

  it("lets a sign-out issued after a copy win, and never deletes a unit for its absence", () => {
    const result = plan({
      log: {
        head: 6,
        units: [
          { sites: ["github.com"], revision: 6, kind: "delete" },
          { sites: ["gone.test"], revision: 5, kind: "copy" },
        ],
      },
      applied: applied([{ sites: ["github.com"], revision: 5 }]),
      jar: [["github.com"]],
    });
    expect(result).toMatchObject({
      units: [{ sites: ["github.com"], revision: 6, kind: "delete" }],
    });
  });

  it("resends the whole jar when the log fell back to it", () => {
    const result = plan({
      log: { head: 12, jar: 12, units: [] },
      applied: applied([{ sites: ["github.com"], revision: 3 }]),
      jar: [["github.com"], ["example.test"]],
    });
    expect(result).toMatchObject({
      units: [
        { sites: ["github.com"], revision: 12, kind: "copy" },
        { sites: ["example.test"], revision: 12, kind: "copy" },
      ],
    });
  });

  it("withdraws a profile that became restricted, once, and otherwise sends controls only", () => {
    const log = { head: 8, withdrawn: 8, units: [] };
    expect(plan({ log, shareable: false })).toEqual({ kind: "withdraw", revision: 8 });
    expect(plan({ log, shareable: false, applied: applied([], 8) })).toEqual({ kind: "controls" });
    expect(plan({ log: { head: 2, units: [] }, shareable: false })).toEqual({ kind: "controls" });
  });

  it("drops units that don't travel", () => {
    const result = plan({
      log: { head: 3, units: [{ sites: ["huji.ac.il"], revision: 3, kind: "copy" }] },
      jar: [["huji.ac.il"]],
      travels: (unit) => !unit.includes("huji.ac.il"),
    });
    expect(result).toMatchObject({ units: [] });
  });
});

describe("withdrawing copies by their digest", () => {
  it("keeps the digest Node computed for records stored before it moved here", () => {
    const text = JSON.stringify(
      [JSON.stringify(["session", ".example.test", "/", null, null, false, "synthetic-a"])].sort(),
    );
    expect(unitFingerprint([cookie()], NOW)).toBe(
      NodeCrypto.createHash("sha256").update(text).digest("base64url"),
    );
    // Expired cookies are no part of what a copy holds.
    expect(unitFingerprint([cookie(), cookie({ name: "old", expires: NOW - 1 })], NOW)).toBe(
      unitFingerprint([cookie()], NOW),
    );
  });

  it("removes only a unit still holding exactly the copy", async () => {
    let jar = [cookie(), cookie({ domain: ".other.test", value: "rotated" })];
    const store: CookieStore = {
      readUnit: async (unit) => unitCookies(unit, jar),
      set: async () => undefined,
      remove: async (gone) => {
        jar = jar.filter(
          (held) => !gone.some((c) => c.name === held.name && c.domain === held.domain),
        );
      },
    };
    const removed = await withdrawCopies(
      store,
      [
        { sites: ["example.test"], fingerprint: unitFingerprint([cookie()], NOW) },
        {
          sites: ["other.test"],
          fingerprint: unitFingerprint([cookie({ domain: ".other.test" })], NOW),
        },
      ],
      () => NOW,
    );
    expect(removed).toEqual([["example.test"]]);
    expect(jar.map(({ domain }) => domain)).toEqual([".other.test"]);
  });
});
