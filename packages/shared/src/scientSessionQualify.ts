// @effect-diagnostics globalDate:off -- Plain async browser work; expiries follow the wall clock CDP uses.
import type { DesktopQualifyCase, SessionCookie } from "@t3tools/contracts";

import { sameUnit } from "./scientSessionCookies.ts";

/**
 * The dev-only cookie-copy qualification's shared cases, run by the desktop on Electron sessions
 * and by a remote server on its browser's profiles. Both use two throwaway jars, A and B, and only
 * synthetic `.test` cookies.
 */
export interface QualifyJar {
  readonly set: (cookies: ReadonlyArray<SessionCookie>) => Promise<void>;
  /** The jar's `qualify.test` cookies, through the adapter under test. */
  readonly read: () => Promise<ReadonlyArray<SessionCookie>>;
  readonly remove: (cookies: ReadonlyArray<SessionCookie>) => Promise<void>;
  /** The cookie names a request to `url` would carry, read past the adapter under test. */
  readonly sentTo: (url: string) => Promise<ReadonlyArray<string>>;
  /**
   * Where the browser takes a raw write: an http:// page setting `name`, past the adapter's own
   * secure handling. A browser must refuse a `__Secure-` cookie from there.
   */
  readonly setOverHttp?: (name: string) => Promise<void>;
}

/** Returns why the case failed, or nothing. */
export type QualifyCase<J> = readonly [
  name: string,
  check: (a: J, b: J) => Promise<string | undefined>,
];

export const domainCookie = (
  name: string,
  overrides: Partial<SessionCookie> = {},
): SessionCookie => ({
  name,
  value: "synthetic",
  domain: ".qualify.test",
  hostOnly: false,
  path: "/",
  secure: true,
  httpOnly: true,
  sameSite: "lax",
  expires: Math.floor(Date.now() / 1000) + 3600,
  ...overrides,
});
const hostCookie = (name: string, overrides: Partial<SessionCookie> = {}) =>
  domainCookie(name, { domain: "a.qualify.test", hostOnly: true, ...overrides });

export const named = (cookies: ReadonlyArray<SessionCookie>, name: string) =>
  cookies.filter((cookie) => cookie.name === name);
const prefixed = async (jar: QualifyJar, prefix: string) =>
  (await jar.read()).filter((cookie) => cookie.name.startsWith(prefix));

export const PARTITION = "https://partition.test";

/** Cases 2–9, after each side's own isolation case: attributes, partitions, read-back, delete. */
export const COPY_CASES: ReadonlyArray<QualifyCase<QualifyJar>> = [
  [
    "host-only",
    async (a, b) => {
      await a.set([hostCookie("host")]);
      await b.set(named(await a.read(), "host"));
      const [copied] = named(await b.read(), "host");
      if (!copied?.hostOnly) return "the copy is not host-only";
      return (await b.sentTo("https://b.qualify.test/")).includes("host")
        ? "b.qualify.test sees a host-only cookie of a.qualify.test"
        : undefined;
    },
  ],
  [
    "domain",
    async (_a, b) => {
      await b.set([domainCookie("domain")]);
      return (await b.sentTo("https://b.qualify.test/")).includes("domain")
        ? undefined
        : "b.qualify.test does not see the .qualify.test cookie";
    },
  ],
  [
    "prefixes",
    async (a, b) => {
      const written = [hostCookie("__Host-x"), domainCookie("__Secure-y")];
      await a.set(written);
      await b.set([...(await prefixed(a, "__Host-x")), ...(await prefixed(a, "__Secure-y"))]);
      const read = [...(await prefixed(b, "__Host-x")), ...(await prefixed(b, "__Secure-y"))];
      if (!sameUnit(written, read)) return "a prefixed cookie read back different";
      await b.set([hostCookie("__Secure-z", { secure: false })]).catch(() => undefined);
      if (named(await b.read(), "__Secure-z").some((cookie) => !cookie.secure))
        return "a non-secure __Secure- cookie was accepted";
      await b.setOverHttp?.("__Secure-h").catch(() => undefined);
      return named(await b.read(), "__Secure-h").length
        ? "a __Secure- cookie from an http:// page was accepted"
        : undefined;
    },
  ],
  [
    "same-site",
    async (_a, b) => {
      const written = (["unspecified", "no_restriction", "lax", "strict"] as const).map(
        (sameSite) => domainCookie(`same-site-${sameSite}`, { sameSite }),
      );
      await b.set(written);
      return sameUnit(written, await prefixed(b, "same-site-"))
        ? undefined
        : "a SameSite value read back different";
    },
  ],
  [
    "expiry",
    async (_a, b) => {
      const written = [domainCookie("expires"), domainCookie("session", { expires: undefined })];
      await b.set(written);
      const read = await b.read();
      return sameUnit(written, [...named(read, "expires"), ...named(read, "session")])
        ? undefined
        : "an expiry, or its absence, read back different";
    },
  ],
  [
    "partitions",
    async (_a, b) => {
      const chip = (hasCrossSiteAncestor?: boolean) =>
        domainCookie("chip", {
          sameSite: "no_restriction",
          ...(hasCrossSiteAncestor === undefined
            ? {}
            : { partitionKey: { topLevelSite: PARTITION, hasCrossSiteAncestor } }),
        });
      const written = [chip(), chip(false), chip(true)];
      await b.set(written);
      return sameUnit(written, named(await b.read(), "chip"))
        ? undefined
        : "the three partitions did not stay three distinct cookies";
    },
  ],
  [
    "read-back",
    async (a, b) => {
      await a.set([domainCookie("unit-1"), hostCookie("unit-2", { httpOnly: false })]);
      const unit = await prefixed(a, "unit-");
      await b.set(unit);
      return sameUnit(unit, await prefixed(b, "unit-"))
        ? undefined
        : "the copied unit is not the same";
    },
  ],
  [
    "exact delete",
    async (_a, b) => {
      const chips = named(await b.read(), "chip");
      const partitioned = chips.find((cookie) => cookie.partitionKey?.hasCrossSiteAncestor);
      const plain = chips.find((cookie) => !cookie.partitionKey);
      if (!partitioned || !plain) return "case 7's cookies are missing";
      await b.remove([partitioned]);
      if (named(await b.read(), "chip").length !== 2)
        return "deleting one partition's cookie did not leave the other two";
      await b.remove([plain]);
      const left = named(await b.read(), "chip");
      return left.length === 1 && left[0]?.partitionKey
        ? undefined
        : "deleting the unpartitioned cookie touched a partitioned one";
    },
  ],
];

/** Appends a case's result, numbered in order. */
export const recordCase = (
  results: DesktopQualifyCase[],
  name: string,
  detail: string | undefined,
) => {
  results.push({
    case: results.length + 1,
    name,
    ok: detail === undefined,
    ...(detail ? { detail } : {}),
  });
};

/** Runs the cases in order; a case that throws fails with its message. */
export async function runCases<J>(
  cases: ReadonlyArray<QualifyCase<J>>,
  a: J,
  b: J,
  results: DesktopQualifyCase[],
) {
  for (const [name, check] of cases)
    recordCase(results, name, await check(a, b).catch(failureText));
}

export const failureText = (cause: unknown) => (cause instanceof Error ? cause.message : "failed");
