// @effect-diagnostics globalDate:off globalTimers:off cryptoRandomUUID:off -- Plain async Electron work; expiries follow the wall clock CDP uses.
import type { DesktopQualifyCase, SessionCookie } from "@t3tools/contracts";
import {
  applyUnit,
  deleteCookies,
  readJar,
  sameUnit,
  sessionCookieToCdpParam,
  setCookies,
  type CdpSend,
  type CookieStore,
} from "@t3tools/shared/scientSessionCookies";
import * as Electron from "electron";

import { withCookieDebugger } from "./sessionCookies.ts";
import { copyIntoMain, jarStore } from "./mainFill.ts";
import { watchForeignInserts } from "./mainInserts.ts";

/**
 * Dev-only check that CDP copies cookies between Electron sessions exactly, on this platform's
 * Electron. `scripts/qualify-session-copy.mjs` runs it; it writes only synthetic `.test` cookies
 * into two throwaway partitions and clears them afterwards.
 */
const HOUR = 3600;
const base = {
  value: "synthetic",
  path: "/",
  secure: true,
  httpOnly: true,
  sameSite: "lax",
} as const;
const domainCookie = (name: string, overrides: Partial<SessionCookie> = {}): SessionCookie => ({
  ...base,
  name,
  domain: ".qualify.test",
  hostOnly: false,
  expires: Math.floor(Date.now() / 1000) + HOUR,
  ...overrides,
});
const hostCookie = (name: string, overrides: Partial<SessionCookie> = {}): SessionCookie =>
  domainCookie(name, { domain: "a.qualify.test", hostOnly: true, ...overrides });

const qualifyCookies = async (send: CdpSend) =>
  (await readJar(send)).cookies.filter((cookie) => cookie.domain.endsWith("qualify.test"));
const named = (cookies: ReadonlyArray<SessionCookie>, name: string) =>
  cookies.filter((cookie) => cookie.name === name);
const visibleTo = async (send: CdpSend, url: string) =>
  (
    (await send("Network.getCookies", { urls: [url] })) as { cookies: { name: string }[] }
  ).cookies.map((cookie) => cookie.name);
const PARTITION = "https://partition.test";

interface QualifyJars {
  readonly a: CdpSend;
  readonly b: CdpSend;
  readonly sessionA: Electron.Session;
  readonly sessionB: Electron.Session;
}

type Check = (jars: QualifyJars) => Promise<string | undefined>;

/** Each case returns why it failed, or nothing. */
const CASES: ReadonlyArray<readonly [string, Check]> = [
  [
    "isolation",
    async ({ a, b, sessionA, sessionB }) => {
      // A value no earlier run wrote, checked through Electron's own cookie API as well as CDP.
      const value = crypto.randomUUID();
      await setCookies(a, [domainCookie("isolated", { value })]);
      const holds = async (session: Electron.Session) =>
        (await session.cookies.get({ name: "isolated" })).some((cookie) => cookie.value === value);
      if (!(await holds(sessionA))) return "the write did not land in A's own session";
      if (named(await qualifyCookies(b), "isolated").length || (await holds(sessionB)))
        return "B sees A's cookie";
      return (await holds(Electron.session.defaultSession))
        ? "the write landed in the app's default session"
        : undefined;
    },
  ],
  [
    "host-only",
    async ({ a, b }) => {
      await setCookies(a, [hostCookie("host")]);
      await setCookies(b, named(await qualifyCookies(a), "host"));
      const [copied] = named(await qualifyCookies(b), "host");
      if (!copied?.hostOnly) return "the copy is not host-only";
      return (await visibleTo(b, "https://b.qualify.test/")).includes("host")
        ? "b.qualify.test sees a host-only cookie of a.qualify.test"
        : undefined;
    },
  ],
  [
    "domain",
    async ({ b }) => {
      await setCookies(b, [domainCookie("domain")]);
      return (await visibleTo(b, "https://b.qualify.test/")).includes("domain")
        ? undefined
        : "b.qualify.test does not see the .qualify.test cookie";
    },
  ],
  [
    "prefixes",
    async ({ a, b }) => {
      const written = [hostCookie("__Host-x"), domainCookie("__Secure-y")];
      await setCookies(a, written);
      await setCookies(b, [
        ...named(await qualifyCookies(a), "__Host-x"),
        ...named(await qualifyCookies(a), "__Secure-y"),
      ]);
      const read = await qualifyCookies(b);
      if (!sameUnit(written, [...named(read, "__Host-x"), ...named(read, "__Secure-y")]))
        return "a prefixed cookie read back different";
      await b("Network.setCookies", {
        cookies: [{ name: "__Secure-z", value: "synthetic", url: "http://a.qualify.test/" }],
      }).catch(() => undefined);
      return named(await qualifyCookies(b), "__Secure-z").length
        ? "a non-https __Secure- cookie was accepted"
        : undefined;
    },
  ],
  [
    "same-site",
    async ({ b }) => {
      const written = (["unspecified", "no_restriction", "lax", "strict"] as const).map(
        (sameSite) => domainCookie(`same-site-${sameSite}`, { sameSite }),
      );
      await setCookies(b, written);
      const read = (await qualifyCookies(b)).filter((cookie) =>
        cookie.name.startsWith("same-site-"),
      );
      return sameUnit(written, read) ? undefined : "a SameSite value read back different";
    },
  ],
  [
    "expiry",
    async ({ b }) => {
      const written = [domainCookie("expires"), domainCookie("session", { expires: undefined })];
      await setCookies(b, written);
      const read = await qualifyCookies(b);
      return sameUnit(written, [...named(read, "expires"), ...named(read, "session")])
        ? undefined
        : "an expiry, or its absence, read back different";
    },
  ],
  [
    "partitions",
    async ({ b }) => {
      const written = [
        domainCookie("chip", { sameSite: "no_restriction" }),
        domainCookie("chip", {
          sameSite: "no_restriction",
          partitionKey: { topLevelSite: PARTITION, hasCrossSiteAncestor: false },
        }),
        domainCookie("chip", {
          sameSite: "no_restriction",
          partitionKey: { topLevelSite: PARTITION, hasCrossSiteAncestor: true },
        }),
      ];
      await setCookies(b, written);
      return sameUnit(written, named(await qualifyCookies(b), "chip"))
        ? undefined
        : "the three partitions did not stay three distinct cookies";
    },
  ],
  [
    "read-back",
    async ({ a, b }) => {
      await setCookies(a, [domainCookie("unit-1"), hostCookie("unit-2", { httpOnly: false })]);
      const unit = (await qualifyCookies(a)).filter((cookie) => cookie.name.startsWith("unit-"));
      await setCookies(b, unit);
      const copied = (await qualifyCookies(b)).filter((cookie) => cookie.name.startsWith("unit-"));
      return sameUnit(unit, copied) ? undefined : "the copied unit is not the same";
    },
  ],
  [
    "exact delete",
    async ({ b }) => {
      const chips = named(await qualifyCookies(b), "chip");
      const [partitioned] = chips.filter((cookie) => cookie.partitionKey?.hasCrossSiteAncestor);
      const plain = chips.find((cookie) => !cookie.partitionKey);
      if (!partitioned || !plain) return "case 7's cookies are missing";
      await deleteCookies(b, [partitioned]);
      if (named(await qualifyCookies(b), "chip").length !== 2)
        return "deleting one partition's cookie did not leave the other two";
      await deleteCookies(b, [plain]);
      const left = named(await qualifyCookies(b), "chip");
      return left.length === 1 && left[0]?.partitionKey
        ? undefined
        : "deleting the unpartitioned cookie touched a partitioned one";
    },
  ],
  [
    "restore",
    async ({ b, sessionB }) => {
      const before = [domainCookie("r", { domain: ".restore.test", value: "before" })];
      await setCookies(b, before);
      const store = jarStore(sessionB, b);
      const outcome = await applyUnit(tamperedReadBack(store), {
        ...replacePlan,
        unit: ["restore.test"],
        source: [domainCookie("r", { domain: ".restore.test", value: "after" })],
      });
      if (outcome !== "failed") return `the copy ended ${outcome}`;
      return sameUnit(await store.readUnit(["restore.test"]), before)
        ? undefined
        : "B was not restored exactly";
    },
  ],
  [
    "foreign insert",
    async ({ b, sessionB }) => {
      const before = [domainCookie("f", { domain: ".foreign.test", value: "before" })];
      await setCookies(b, before);
      const store = jarStore(sessionB, b);
      let pageWrote = false;
      const foreign = watchForeignInserts(sessionB);
      const outcome = await applyUnit(
        tamperedReadBack({
          ...store,
          set: async (cookies) => {
            await store.set(cookies);
            if (pageWrote) return;
            pageWrote = true;
            await pageWrites(sessionB, { url: "https://foreign.test/", name: "page", value: "x" });
          },
        }),
        {
          ...replacePlan,
          unit: ["foreign.test"],
          source: [domainCookie("f", { domain: ".foreign.test", value: "after" })],
          foreign: () => foreign.cookies,
        },
      ).finally(foreign.stop);
      if (outcome !== "failed") return `the copy ended ${outcome}`;
      const after = await store.readUnit(["foreign.test"]);
      if (!named(after, "page").length) return "the restore removed the site's own cookie";
      return sameUnit(
        after.filter((cookie) => cookie.name !== "page"),
        before,
      )
        ? undefined
        : "B was not restored exactly around the site's cookie";
    },
  ],
  [
    "skip",
    async ({ a, sessionA, sessionB }) => {
      await setCookies(a, [domainCookie("s", { domain: ".skip.test" })]);
      const result = await copyIntoMain(sessionA, sessionB, {
        from: "qualify",
        units: [["skip.test"]],
        mode: "fill",
        skipSites: ["skip.test"],
      });
      if (result.units[0]?.outcome !== "blocked") return "a signed-out site was not blocked";
      return (await sessionB.cookies.get({ domain: "skip.test" })).length
        ? "a blocked unit was written"
        : undefined;
    },
  ],
  [
    "navigation first",
    async ({ b, sessionB }) => {
      const store = jarStore(sessionB, b);
      let pageWrote = false;
      const foreign = watchForeignInserts(sessionB);
      const outcome = await applyUnit(
        {
          ...store,
          set: async (cookies) => {
            if (!pageWrote) {
              pageWrote = true;
              // The site sets the same cookie just before the copy writes it.
              await pageWrites(sessionB, {
                url: "https://race.test/",
                name: "n",
                value: "from-the-site",
                secure: true,
                expirationDate: Math.floor(Date.now() / 1000) + HOUR,
              });
            }
            await store.set(cookies);
          },
        },
        {
          ...replacePlan,
          unit: ["race.test"],
          source: [domainCookie("n", { domain: "race.test", hostOnly: true, value: "copied" })],
          foreign: () => foreign.cookies,
        },
      ).finally(foreign.stop);
      if (outcome !== "busy") return `the copy ended ${outcome}`;
      // Read through Electron's own API, not the store under test.
      const left = await sessionB.cookies.get({ name: "n", domain: "race.test" });
      return left.length === 1 && left[0]?.value === "from-the-site"
        ? undefined
        : "the site's newer cookie was not left in place";
    },
  ],
  [
    "partitioned navigation first",
    async ({ b, sessionB }) => {
      const store = jarStore(sessionB, b);
      const partitionKey = { topLevelSite: PARTITION, hasCrossSiteAncestor: false };
      const chip = domainCookie("chip", {
        domain: "pace.test",
        hostOnly: true,
        sameSite: "no_restriction",
        partitionKey,
      });
      let seen = false;
      const foreign = watchForeignInserts(sessionB);
      const outcome = await applyUnit(
        {
          ...store,
          set: async (cookies) => {
            if (!seen) {
              seen = true;
              // The site sets the same partitioned cookie just before the copy writes it.
              await siteWrites(sessionB, () =>
                b("Network.setCookies", {
                  cookies: [sessionCookieToCdpParam({ ...chip, value: "from-the-site" })],
                }),
              );
            }
            await store.set(cookies);
          },
        },
        {
          ...replacePlan,
          unit: ["pace.test"],
          source: [{ ...chip, value: "copied" }],
          foreign: () => foreign.cookies,
        },
      ).finally(foreign.stop);
      if (outcome !== "busy") return `the copy ended ${outcome}`;
      // Read with partition keys, not through the event the copy watched.
      const left = (await readJar(b)).cookies.filter((cookie) => cookie.name === "chip");
      if (left.some((cookie) => !cookie.partitionKey))
        return "an unpartitioned stand-in was written";
      return left.some((cookie) => cookie.value === "copied")
        ? "the copy's value was left in the site's slot"
        : undefined;
    },
  ],
];

const replacePlan = {
  mode: "fill-or-replace",
  replaceAllowed: true,
  nowSeconds: Math.floor(Date.now() / 1000),
} as const;

/** The first read after the copy's write sees a different value, so the check fails on purpose. */
const tamperedReadBack = (store: CookieStore): CookieStore => {
  let wrote = false;
  let tampered = false;
  return {
    ...store,
    set: async (cookies) => {
      wrote = true;
      await store.set(cookies);
    },
    readUnit: async (unit) => {
      const read = await store.readUnit(unit);
      if (!wrote || tampered) return read;
      tampered = true;
      return read.map((cookie) => ({ ...cookie, value: "tampered" }));
    },
  };
};

/** A write the site makes through CDP, resolved once the session reports it, or after 2 s. */
const siteWrites = (session: Electron.Session, write: () => Promise<unknown>) =>
  new Promise<void>((resolve, reject) => {
    const done = () => {
      clearTimeout(timer);
      session.cookies.off("changed", seen);
      resolve();
    };
    const seen = (_event: unknown, cookie: Electron.Cookie, _cause: unknown, removed: boolean) => {
      if (!removed && cookie.name === "chip") done();
    };
    const timer = setTimeout(done, 2000);
    session.cookies.on("changed", seen);
    write().catch(reject);
  });

/** A cookie the site sets itself, resolved once the session reports it. */
const pageWrites = (session: Electron.Session, details: Electron.CookiesSetDetails) =>
  new Promise<void>((resolve, reject) => {
    const seen = (_event: unknown, cookie: Electron.Cookie, _cause: unknown, removed: boolean) => {
      if (removed || cookie.name !== details.name) return;
      session.cookies.off("changed", seen);
      resolve();
    };
    session.cookies.on("changed", seen);
    session.cookies.set(details).catch(reject);
  });

export async function qualifySessionCopy() {
  const id = crypto.randomUUID();
  const sessionA = Electron.session.fromPartition(`persist:scient-qualify-a-${id}`);
  const sessionB = Electron.session.fromPartition(`persist:scient-qualify-b-${id}`);
  const results: DesktopQualifyCase[] = [];
  try {
    await withCookieDebugger(sessionA, (a) =>
      withCookieDebugger(sessionB, async (b) => {
        for (const [index, [name, check]] of CASES.entries()) {
          const detail = await check({ a, b, sessionA, sessionB }).catch((cause: unknown) =>
            cause instanceof Error ? cause.message : "failed",
          );
          results.push({
            case: index + 1,
            name,
            ok: detail === undefined,
            ...(detail ? { detail } : {}),
          });
        }
      }),
    );
  } finally {
    await Promise.all([sessionA.clearStorageData(), sessionB.clearStorageData()]);
    await clearDefaultSessionLeftovers().catch(() => undefined);
  }
  return results;
}

const SYNTHETIC_SITES = /(?:^|\.)(?:qualify|restore|foreign|skip|race|pace|partition|probe)\.test$/;

/**
 * Builds before this fix wrote their synthetic cookies into the app's default session, since
 * CDP's Storage domain acts there. Those reserved `.test` cookies are removed, partitioned ones too.
 */
async function clearDefaultSessionLeftovers() {
  await withCookieDebugger(Electron.session.defaultSession, async (send) => {
    const { cookies } = await readJar(send);
    await deleteCookies(
      send,
      cookies.filter((cookie) => SYNTHETIC_SITES.test(cookie.domain.replace(/^\./, ""))),
    );
  });
}
