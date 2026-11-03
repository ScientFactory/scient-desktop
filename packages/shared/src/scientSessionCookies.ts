import type { SessionCookie } from "@t3tools/contracts";

/** The registrable site of a host, such as `huji.ac.il` for `idp.cc.huji.ac.il`. */
export type SiteOf = (host: string) => string;

/** A cookie as CDP's `Storage.getCookies` and `Network.getAllCookies` return it. */
export interface CdpCookie {
  readonly name: string;
  readonly value: string;
  readonly domain: string;
  readonly path: string;
  readonly expires: number;
  readonly session: boolean;
  readonly secure: boolean;
  readonly httpOnly: boolean;
  readonly sameSite?: "Strict" | "Lax" | "None" | undefined;
  readonly partitionKey?:
    | { readonly topLevelSite: string; readonly hasCrossSiteAncestor: boolean }
    | string
    | undefined;
  readonly partitionKeyOpaque?: boolean | undefined;
}

const SAME_SITE_FROM_CDP = { Strict: "strict", Lax: "lax", None: "no_restriction" } as const;
const SAME_SITE_TO_CDP = { strict: "Strict", lax: "Lax", no_restriction: "None" } as const;

/** A cookie Scient can't carry exactly is refused rather than turned into an ordinary one. */
export function sessionCookieFromCdp(
  cookie: CdpCookie,
): SessionCookie | { readonly unsupported: "opaque-partition" | "string-partition" } {
  if (cookie.partitionKeyOpaque) return { unsupported: "opaque-partition" };
  if (typeof cookie.partitionKey === "string") return { unsupported: "string-partition" };
  return {
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain,
    hostOnly: !cookie.domain.startsWith("."),
    path: cookie.path,
    secure: cookie.secure,
    httpOnly: cookie.httpOnly,
    sameSite: cookie.sameSite ? SAME_SITE_FROM_CDP[cookie.sameSite] : "unspecified",
    ...(cookie.session ? {} : { expires: cookie.expires }),
    ...(cookie.partitionKey
      ? {
          partitionKey: {
            topLevelSite: cookie.partitionKey.topLevelSite,
            hasCrossSiteAncestor: cookie.partitionKey.hasCrossSiteAncestor,
          },
        }
      : {}),
  };
}

const bareHost = (domain: string) => domain.replace(/^\./, "").toLowerCase();

/** Chromium refuses a prefixed cookie, or a secure one, unless it is set from https. */
const needsHttps = (cookie: Pick<SessionCookie, "name" | "secure">) =>
  cookie.secure || cookie.name.startsWith("__Host-") || cookie.name.startsWith("__Secure-");

/** The `Network.CookieParam` that writes the cookie back with every attribute. */
export function sessionCookieToCdpParam(cookie: SessionCookie) {
  return {
    name: cookie.name,
    value: cookie.value,
    url: `${needsHttps(cookie) ? "https" : "http"}://${bareHost(cookie.domain)}${cookie.path}`,
    // A domain makes the cookie a domain cookie; host-only cookies leave it to the URL.
    ...(cookie.hostOnly ? {} : { domain: cookie.domain }),
    path: cookie.path,
    secure: cookie.secure,
    httpOnly: cookie.httpOnly,
    ...(cookie.sameSite === "unspecified" ? {} : { sameSite: SAME_SITE_TO_CDP[cookie.sameSite] }),
    ...(cookie.expires === undefined ? {} : { expires: cookie.expires }),
    ...(cookie.partitionKey ? { partitionKey: cookie.partitionKey } : {}),
  };
}

/** A cookie read from another browser's jar, whose host-only cookies carry no domain. */
export function sessionCookieFromImported(cookie: {
  readonly url: string;
  readonly name: string;
  readonly value: string;
  readonly domain: string | undefined;
  readonly path: string;
  readonly secure: boolean;
  readonly httpOnly: boolean;
  readonly expirationDate: number | undefined;
  readonly sameSite: SessionCookie["sameSite"];
  readonly partitionKey?: SessionCookie["partitionKey"];
}): SessionCookie {
  return {
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain ?? new URL(cookie.url).hostname,
    hostOnly: cookie.domain === undefined,
    path: cookie.path,
    secure: cookie.secure,
    httpOnly: cookie.httpOnly,
    sameSite: cookie.sameSite,
    ...(cookie.expirationDate === undefined ? {} : { expires: cookie.expirationDate }),
    ...(cookie.partitionKey ? { partitionKey: cookie.partitionKey } : {}),
  };
}

/** A cookie's identity in a jar: two cookies with one key can't both exist. */
const cookieKey = (cookie: Pick<SessionCookie, "name" | "domain" | "path" | "partitionKey">) =>
  JSON.stringify([
    cookie.name,
    cookie.domain,
    cookie.path,
    cookie.partitionKey?.topLevelSite ?? null,
    cookie.partitionKey?.hasCrossSiteAncestor ?? null,
  ]);

const siteHost = (site: string) => {
  if (!site.startsWith("https://")) return bareHost(site);
  try {
    return new URL(site).hostname;
  } catch {
    return bareHost(site);
  }
};

/** The registrable sites of a unit, whose entries may be bare sites or `https://` origins. */
export const unitSites = (unit: ReadonlyArray<string>, siteOf: SiteOf) =>
  new Set(unit.map((site) => siteOf(siteHost(site))));

/** The cookies of a jar that belong to a unit, expired ones included. */
export const unitCookies = (
  unit: ReadonlyArray<string>,
  jar: ReadonlyArray<SessionCookie>,
  siteOf: SiteOf,
) => {
  const sites = unitSites(unit, siteOf);
  return jar.filter((cookie) => sites.has(siteOf(bareHost(cookie.domain))));
};

const isLive = (cookie: SessionCookie, nowSeconds: number) =>
  cookie.expires === undefined || cookie.expires > nowSeconds;

/** A unit with no live cookie is empty, whatever expired ones it still holds. */
function unitState(
  unit: ReadonlyArray<string>,
  jar: ReadonlyArray<SessionCookie>,
  nowSeconds: number,
  siteOf: SiteOf,
): "empty" | { readonly live: ReadonlyArray<SessionCookie> } {
  const live = unitCookies(unit, jar, siteOf).filter((cookie) => isLive(cookie, nowSeconds));
  return live.length === 0 ? "empty" : { live };
}

const sameCookie = (a: SessionCookie, b: SessionCookie) =>
  cookieKey(a) === cookieKey(b) &&
  a.value === b.value &&
  a.hostOnly === b.hostOnly &&
  a.secure === b.secure &&
  a.httpOnly === b.httpOnly &&
  a.sameSite === b.sameSite &&
  (a.expires === undefined
    ? b.expires === undefined
    : b.expires !== undefined && Math.abs(a.expires - b.expires) <= 1);

/** Two live groups are the same when every cookie matches in value and every attribute. */
export function sameUnit(a: ReadonlyArray<SessionCookie>, b: ReadonlyArray<SessionCookie>) {
  return (
    a.length === b.length &&
    a.every((cookie) => b.some((other) => sameCookie(cookie, other))) &&
    b.every((cookie) => a.some((other) => sameCookie(cookie, other)))
  );
}

/** Each registrable group of a jar, except that groups one multi-site sign-in covers stay one unit. */
export function jarUnits(
  jar: ReadonlyArray<SessionCookie>,
  siteOf: SiteOf,
  join: ReadonlyArray<ReadonlyArray<string>> = [],
): ReadonlyArray<ReadonlyArray<string>> {
  const joined = join.map((unit) => [...unitSites(unit, siteOf)]);
  const units = new Map<string, ReadonlyArray<string>>();
  for (const cookie of jar) {
    const site = siteOf(bareHost(cookie.domain));
    const unit = joined.find((sites) => sites.includes(site)) ?? [site];
    units.set(unit.join("\u0000"), unit);
  }
  return [...units.values()];
}

const GOOGLE = "google.com";

export type UnitDecision = "copy" | "same" | "conflict" | "blocked";

/**
 * What a copy of one unit does. `source` and `target` are each jar's cookies of the unit. Fill
 * copies only into an empty unit; replace needs the caller's proof the target's session ended, and
 * never touches Google, where one jar holds several accounts.
 */
export function decideUnit(input: {
  readonly unit: ReadonlyArray<string>;
  readonly source: ReadonlyArray<SessionCookie>;
  readonly target: ReadonlyArray<SessionCookie>;
  readonly mode: "fill" | "fill-or-replace";
  readonly replaceAllowed: boolean;
  readonly nowSeconds: number;
  readonly siteOf: SiteOf;
}): UnitDecision {
  const source = unitState(input.unit, input.source, input.nowSeconds, input.siteOf);
  if (source === "empty") return "blocked";
  const target = unitState(input.unit, input.target, input.nowSeconds, input.siteOf);
  if (target === "empty") return "copy";
  if (sameUnit(source.live, target.live)) return "same";
  return input.mode === "fill-or-replace" &&
    input.replaceAllowed &&
    !unitSites(input.unit, input.siteOf).has(GOOGLE)
    ? "copy"
    : "conflict";
}

/** Where cookies are a cookie's slot: name, domain and path, whatever its partition. */
export const cookieSlot = (cookie: {
  readonly name: string;
  readonly domain?: string | undefined;
  readonly path?: string | undefined;
}) => JSON.stringify([cookie.name, cookie.domain ?? "", cookie.path ?? "/"]);

/** One jar as a copy sees it. Item 3 writes Electron jars; a remote computer writes its own. */
export interface CookieStore {
  /** The unit's cookies, expired ones included. */
  readonly readUnit: (unit: ReadonlyArray<string>) => Promise<ReadonlyArray<SessionCookie>>;
  readonly set: (cookies: ReadonlyArray<SessionCookie>) => Promise<void>;
  readonly remove: (
    cookies: ReadonlyArray<Pick<SessionCookie, "name" | "domain" | "path" | "partitionKey">>,
  ) => Promise<void>;
}

export type UnitOutcome = "copied" | "same" | "conflict" | "blocked" | "failed" | "restore-failed";

/**
 * Copies one unit into a jar as one transaction: snapshot, decide, write, read the whole unit
 * back, and on a failed check restore the snapshot. `foreign` names the slots something else
 * changed meanwhile (a page, a response); the check accepts them and the restore leaves them.
 */
export async function applyUnit(
  store: CookieStore,
  plan: {
    readonly unit: ReadonlyArray<string>;
    readonly source: ReadonlyArray<SessionCookie>;
    readonly mode: "fill" | "fill-or-replace";
    readonly replaceAllowed: boolean;
    readonly nowSeconds: number;
    readonly siteOf: SiteOf;
    readonly foreign?: () => ReadonlySet<string>;
  },
): Promise<UnitOutcome> {
  const live = (cookies: ReadonlyArray<SessionCookie>) =>
    cookies.filter((cookie) => isLive(cookie, plan.nowSeconds));
  const foreign = () => plan.foreign?.() ?? new Set<string>();
  const before = live(await store.readUnit(plan.unit));
  const decision = decideUnit({ ...plan, target: before });
  if (decision !== "copy") return decision;
  const written = live(unitCookies(plan.unit, plan.source, plan.siteOf));
  try {
    if (before.length) await store.remove(before);
    await store.set(written);
  } catch {
    // A partial write is found by the check below and undone.
  }
  const after = await store.readUnit(plan.unit).then(live, () => undefined);
  const changed = foreign();
  if (
    after &&
    written.every(
      (cookie) => changed.has(cookieSlot(cookie)) || after.some((read) => sameCookie(cookie, read)),
    ) &&
    after.every(
      (read) =>
        changed.has(cookieSlot(read)) ||
        written.some((cookie) => cookieKey(cookie) === cookieKey(read)),
    )
  )
    return "copied";
  try {
    const current = await store.readUnit(plan.unit);
    const untouched = (cookie: SessionCookie) => !foreign().has(cookieSlot(cookie));
    const ours = current.filter(
      (read) =>
        untouched(read) &&
        written.some(
          (cookie) => cookieKey(cookie) === cookieKey(read) && cookie.value === read.value,
        ),
    );
    if (ours.length) await store.remove(ours);
    const kept = current.filter((read) => !ours.includes(read));
    const missing = before.filter(
      (cookie) => untouched(cookie) && !kept.some((read) => cookieKey(read) === cookieKey(cookie)),
    );
    if (missing.length) await store.set(missing);
    const restored = live(await store.readUnit(plan.unit)).filter(untouched);
    return sameUnit(restored, before.filter(untouched)) ? "failed" : "restore-failed";
  } catch {
    return "restore-failed";
  }
}
