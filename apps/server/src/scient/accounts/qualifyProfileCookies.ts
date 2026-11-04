// @effect-diagnostics globalDate:off cryptoRandomUUID:off -- Plain async browser work; expiries follow the wall clock CDP uses.
import type { DesktopQualifyCase, SessionCookie } from "@t3tools/contracts";
import { sameUnit } from "@t3tools/shared/scientSessionCookies";

import type { ProfileCookieJar } from "./profileCookieJar.ts";

/**
 * Checks that the server browser's cookie adapter copies exactly, on this computer's Chromium, in
 * two throwaway profiles that are deleted afterwards. Item 3's cases 1–9, then persistence across a
 * restart of the profile's browser, and the helper page never showing as a page of the profile.
 */
export interface QualifyBrowser {
  /** Holds a profile's jar; `release` closes the context the hold opened. */
  readonly open: (
    profileId: string,
  ) => Promise<{ readonly jar: ProfileCookieJar; readonly release: () => Promise<void> }>;
  readonly clear: (profileId: string) => Promise<void>;
}

type Held = Awaited<ReturnType<QualifyBrowser["open"]>>;

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
const UNIT = ["qualify.test"];
const PARTITION = "https://partition.test";

const named = (cookies: ReadonlyArray<SessionCookie>, name: string) =>
  cookies.filter((cookie) => cookie.name === name);
const read = (held: Held) => held.jar.readUnit(UNIT);

type Check = (a: Held, b: Held) => Promise<string | undefined>;

/** Each case returns why it failed, or nothing. */
const CASES: ReadonlyArray<readonly [string, Check]> = [
  [
    "isolation",
    async (a, b) => {
      const name = `isolated-${crypto.randomUUID()}`;
      await a.jar.set([domainCookie(name)]);
      if (!(await a.jar.independent.names()).includes(name))
        return "the write did not land in A's own context";
      return (await b.jar.independent.names()).includes(name) || named(await read(b), name).length
        ? "B sees A's cookie"
        : undefined;
    },
  ],
  [
    "host-only",
    async (a, b) => {
      await a.jar.set([hostCookie("host")]);
      await b.jar.set(named(await read(a), "host"));
      const [copied] = named(await read(b), "host");
      if (!copied?.hostOnly) return "the copy is not host-only";
      return (await b.jar.independent.names("https://b.qualify.test/")).includes("host")
        ? "b.qualify.test sees a host-only cookie of a.qualify.test"
        : undefined;
    },
  ],
  [
    "domain",
    async (_a, b) => {
      await b.jar.set([domainCookie("domain")]);
      return (await b.jar.independent.names("https://b.qualify.test/")).includes("domain")
        ? undefined
        : "b.qualify.test does not see the .qualify.test cookie";
    },
  ],
  [
    "prefixes",
    async (a, b) => {
      const written = [hostCookie("__Host-x"), domainCookie("__Secure-y")];
      await a.jar.set(written);
      const fromA = await read(a);
      await b.jar.set([...named(fromA, "__Host-x"), ...named(fromA, "__Secure-y")]);
      const fromB = await read(b);
      if (!sameUnit(written, [...named(fromB, "__Host-x"), ...named(fromB, "__Secure-y")]))
        return "a prefixed cookie read back different";
      await b.jar.set([hostCookie("__Secure-z", { secure: false })]).catch(() => undefined);
      return named(await read(b), "__Secure-z").some((cookie) => !cookie.secure)
        ? "a non-secure __Secure- cookie was accepted"
        : undefined;
    },
  ],
  [
    "same-site",
    async (_a, b) => {
      const written = (["unspecified", "no_restriction", "lax", "strict"] as const).map(
        (sameSite) => domainCookie(`same-site-${sameSite}`, { sameSite }),
      );
      await b.jar.set(written);
      const back = (await read(b)).filter((cookie) => cookie.name.startsWith("same-site-"));
      return sameUnit(written, back) ? undefined : "a SameSite value read back different";
    },
  ],
  [
    "expiry",
    async (_a, b) => {
      const written = [domainCookie("expires"), domainCookie("session", { expires: undefined })];
      await b.jar.set(written);
      const back = await read(b);
      return sameUnit(written, [...named(back, "expires"), ...named(back, "session")])
        ? undefined
        : "an expiry, or its absence, read back different";
    },
  ],
  [
    "partitions",
    async (_a, b) => {
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
      await b.jar.set(written);
      return sameUnit(written, named(await read(b), "chip"))
        ? undefined
        : "the three partitions did not stay three distinct cookies";
    },
  ],
  [
    "read-back",
    async (a, b) => {
      await a.jar.set([domainCookie("unit-1"), hostCookie("unit-2", { httpOnly: false })]);
      const unit = (await read(a)).filter((cookie) => cookie.name.startsWith("unit-"));
      await b.jar.set(unit);
      const copied = (await read(b)).filter((cookie) => cookie.name.startsWith("unit-"));
      return sameUnit(unit, copied) ? undefined : "the copied unit is not the same";
    },
  ],
  [
    "exact delete",
    async (_a, b) => {
      const chips = named(await read(b), "chip");
      const partitioned = chips.find((cookie) => cookie.partitionKey?.hasCrossSiteAncestor);
      const plain = chips.find((cookie) => !cookie.partitionKey);
      if (!partitioned || !plain) return "case 7's cookies are missing";
      await b.jar.remove([partitioned]);
      if (named(await read(b), "chip").length !== 2)
        return "deleting one partition's cookie did not leave the other two";
      await b.jar.remove([plain]);
      const left = named(await read(b), "chip");
      return left.length === 1 && left[0]?.partitionKey
        ? undefined
        : "deleting the unpartitioned cookie touched a partitioned one";
    },
  ],
];

export async function qualifyProfileCookies(browser: QualifyBrowser) {
  const id = crypto.randomUUID();
  const profileA = `scient-qualify-a-${id}`;
  const profileB = `scient-qualify-b-${id}`;
  const results: DesktopQualifyCase[] = [];
  const record = (name: string, detail: string | undefined) =>
    results.push({
      case: results.length + 1,
      name,
      ok: detail === undefined,
      ...(detail ? { detail } : {}),
    });
  const failure = (cause: unknown) => (cause instanceof Error ? cause.message : "failed");
  try {
    const a = await browser.open(profileA);
    let releasedA = false;
    try {
      const b = await browser.open(profileB);
      try {
        for (const [name, check] of CASES) record(name, await check(a, b).catch(failure));
        record(
          "helper page",
          a.jar.independent.pages() === 1 && a.jar.openTabSites().length === 0
            ? undefined
            : "the helper page shows as a page of the profile",
        );
      } finally {
        await b.release();
      }
      await a.release();
      releasedA = true;
      // The hold opened A's browser, so release closed it; a new one reads the same directory.
      const again = await browser.open(profileA);
      try {
        const kept = named(await read(again), "unit-1");
        record(
          "persistence",
          kept.length === 1 ? undefined : "a cookie did not outlive the profile's browser",
        );
      } finally {
        await again.release();
      }
    } finally {
      if (!releasedA) await a.release();
    }
  } catch (cause) {
    record("setup", failure(cause));
  } finally {
    await Promise.all([browser.clear(profileA), browser.clear(profileB)]).catch(() => undefined);
  }
  return results;
}
