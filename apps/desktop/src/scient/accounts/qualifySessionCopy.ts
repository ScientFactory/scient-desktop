// @effect-diagnostics globalDate:off globalTimers:off cryptoRandomUUID:off -- Plain async Electron work; expiries follow the wall clock CDP uses.
import type { DesktopQualifyCase } from "@t3tools/contracts";
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
import {
  COPY_CASES,
  PARTITION,
  domainCookie,
  named,
  runCases,
  type QualifyCase,
  type QualifyJar,
} from "@t3tools/shared/scientSessionQualify";
import * as Electron from "electron";

import { withCookieDebugger } from "./sessionCookies.ts";
import { copyIntoMain, jarStore } from "./mainFill.ts";
import { watchForeignInserts } from "./mainInserts.ts";

/**
 * Dev-only check that CDP copies cookies between Electron sessions exactly, on this platform's
 * Electron. `scripts/qualify-session-copy.mjs` runs it; it writes only synthetic `.test` cookies
 * into two throwaway partitions and clears them afterwards.
 */
interface ElectronJar extends QualifyJar {
  readonly send: CdpSend;
  readonly session: Electron.Session;
}

const electronJar = (send: CdpSend, session: Electron.Session): ElectronJar => ({
  send,
  session,
  set: (cookies) => setCookies(send, cookies),
  read: async () =>
    (await readJar(send)).cookies.filter((cookie) => cookie.domain.endsWith("qualify.test")),
  remove: (cookies) => deleteCookies(send, cookies),
  sentTo: async (url) =>
    (
      (await send("Network.getCookies", { urls: [url] })) as { cookies: { name: string }[] }
    ).cookies.map((cookie) => cookie.name),
});

const CASES: ReadonlyArray<QualifyCase<ElectronJar>> = [
  [
    "isolation",
    async (a, b) => {
      // A value no earlier run wrote, checked through Electron's own cookie API as well as CDP.
      const value = crypto.randomUUID();
      await a.set([domainCookie("isolated", { value })]);
      const holds = async (session: Electron.Session) =>
        (await session.cookies.get({ name: "isolated" })).some((cookie) => cookie.value === value);
      if (!(await holds(a.session))) return "the write did not land in A's own session";
      if (named(await b.read(), "isolated").length || (await holds(b.session)))
        return "B sees A's cookie";
      return (await holds(Electron.session.defaultSession))
        ? "the write landed in the app's default session"
        : undefined;
    },
  ],
  ...COPY_CASES,
  [
    "restore",
    async (_a, { send: b, session: sessionB }) => {
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
    async (_a, { send: b, session: sessionB }) => {
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
    async ({ send: a, session: sessionA }, { session: sessionB }) => {
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
    async (_a, { send: b, session: sessionB }) => {
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
                expirationDate: Math.floor(Date.now() / 1000) + 3600,
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
    async (_a, { send: b, session: sessionB }) => {
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
              await siteWrites(sessionB, "chip", () =>
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

/** A cookie the site writes itself, resolved once the session reports it, or after 2 s. */
const siteWrites = (session: Electron.Session, name: string, write: () => Promise<unknown>) =>
  new Promise<void>((resolve, reject) => {
    const done = () => {
      clearTimeout(timer);
      session.cookies.off("changed", seen);
      resolve();
    };
    const seen = (_event: unknown, cookie: Electron.Cookie, _cause: unknown, removed: boolean) => {
      if (!removed && cookie.name === name) done();
    };
    const timer = setTimeout(done, 2000);
    session.cookies.on("changed", seen);
    write().catch(reject);
  });
const pageWrites = (
  session: Electron.Session,
  details: Electron.CookiesSetDetails & { name: string },
) => siteWrites(session, details.name, () => session.cookies.set(details));

export async function qualifySessionCopy() {
  const id = crypto.randomUUID();
  const sessionA = Electron.session.fromPartition(`persist:scient-qualify-a-${id}`);
  const sessionB = Electron.session.fromPartition(`persist:scient-qualify-b-${id}`);
  const results: DesktopQualifyCase[] = [];
  try {
    await withCookieDebugger(sessionA, (a) =>
      withCookieDebugger(sessionB, (b) =>
        runCases(CASES, electronJar(a, sessionA), electronJar(b, sessionB), results),
      ),
    );
  } finally {
    await Promise.all([sessionA.clearStorageData(), sessionB.clearStorageData()]);
  }
  return results;
}
