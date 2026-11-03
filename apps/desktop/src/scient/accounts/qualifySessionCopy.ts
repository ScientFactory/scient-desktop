// @effect-diagnostics globalDate:off cryptoRandomUUID:off -- Plain async Electron work; expiries follow the wall clock CDP uses.
import type { DesktopQualifyCase, SessionCookie } from "@t3tools/contracts";
import { sameUnit } from "@t3tools/shared/scientSessionCookies";
import * as Electron from "electron";

import {
  deleteCookies,
  readJar,
  setCookies,
  withCookieDebugger,
  type CdpSend,
} from "./sessionCookies.ts";

/**
 * Dev-only check that CDP copies cookies between Electron sessions exactly, on this platform's
 * Electron. `scripts/qualify-session-copy.mjs` runs it; it writes only synthetic `qualify.test`
 * cookies into two throwaway partitions and clears them afterwards.
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
  readonly sessionB: Electron.Session;
}

type Check = (jars: QualifyJars) => Promise<string | undefined>;

/** Each case returns why it failed, or nothing. */
const CASES: ReadonlyArray<readonly [string, Check]> = [
  [
    "isolation",
    async ({ a, b }) => {
      await setCookies(a, [domainCookie("isolated")]);
      return named(await qualifyCookies(b), "isolated").length ? "B sees A's cookie" : undefined;
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
      await b("Storage.setCookies", {
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
];

export async function qualifySessionCopy() {
  const id = crypto.randomUUID();
  const sessionA = Electron.session.fromPartition(`persist:scient-qualify-a-${id}`);
  const sessionB = Electron.session.fromPartition(`persist:scient-qualify-b-${id}`);
  const results: DesktopQualifyCase[] = [];
  try {
    await withCookieDebugger(sessionA, (a) =>
      withCookieDebugger(sessionB, async (b) => {
        for (const [index, [name, check]] of CASES.entries()) {
          const detail = await check({ a, b, sessionB }).catch((cause: unknown) =>
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
  }
  return results;
}
