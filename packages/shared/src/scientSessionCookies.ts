import {
  INCOGNITO_BROWSER_PROFILE_ID,
  type AccountSessionsApplied,
  type AccountSummary,
  type BrowserProfileRecord,
  type ProfileSendLog,
  type SentProfileControls,
  type SessionCookie,
} from "@t3tools/contracts";

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

/** Sends one CDP command to a page whose browser context holds the jar. */
export type CdpSend = (method: string, params?: object) => Promise<unknown>;

const SET_BATCH = 100;

/**
 * Network commands act on the sending page's own context. Storage commands without a browser
 * context id act on the browser's default one, whatever page sends them, so none is used here.
 */
export async function setCookies(send: CdpSend, cookies: ReadonlyArray<SessionCookie>) {
  for (let start = 0; start < cookies.length; start += SET_BATCH)
    await send("Network.setCookies", {
      cookies: cookies.slice(start, start + SET_BATCH).map(sessionCookieToCdpParam),
    });
}

/** Every cookie of the page's jar, partitioned ones included. */
export async function readJar(send: CdpSend) {
  const read = (await send("Network.getAllCookies")) as {
    readonly cookies: ReadonlyArray<CdpCookie>;
  };
  const cookies: SessionCookie[] = [];
  let unsupported = 0;
  for (const cookie of read.cookies) {
    const converted = sessionCookieFromCdp(cookie);
    if ("unsupported" in converted) unsupported += 1;
    else cookies.push(converted);
  }
  return { cookies, unsupported };
}

/** Removes exactly these cookies: name, domain, path and partition must all match. */
export async function deleteCookies(
  send: CdpSend,
  cookies: ReadonlyArray<Pick<SessionCookie, "name" | "domain" | "path" | "partitionKey">>,
) {
  for (const cookie of cookies)
    await send("Network.deleteCookies", {
      name: cookie.name,
      domain: cookie.domain,
      path: cookie.path,
      ...(cookie.partitionKey ? { partitionKey: cookie.partitionKey } : {}),
    });
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

/**
 * Units that share a registrable site, directly or through others, merged into one: two
 * university sign-ins with one IdP and different proxies are copied whole or not at all.
 */
export function mergeUnits(
  units: ReadonlyArray<ReadonlyArray<string>>,
  siteOf: SiteOf,
): ReadonlyArray<ReadonlyArray<string>> {
  const parent = new Map<string, string>();
  const root = (site: string): string => {
    const up = parent.get(site) ?? site;
    if (up === site) return site;
    const top = root(up);
    parent.set(site, top);
    return top;
  };
  for (const unit of units) {
    const [first, ...rest] = unitSites(unit, siteOf);
    if (first === undefined) continue;
    for (const site of rest) parent.set(root(site), root(first));
  }
  const merged = new Map<string, Set<string>>();
  for (const unit of units)
    for (const entry of unit) {
      const key = root(siteOf(siteHost(entry)));
      merged.set(key, (merged.get(key) ?? new Set()).add(entry));
    }
  return [...merged.values()].map((entries) => [...entries]);
}

/** Each registrable group of a jar, except that groups multi-site sign-ins cover stay one unit. */
export function jarUnits(
  jar: ReadonlyArray<SessionCookie>,
  siteOf: SiteOf,
  join: ReadonlyArray<ReadonlyArray<string>> = [],
): ReadonlyArray<ReadonlyArray<string>> {
  const present = new Set(jar.map((cookie) => siteOf(bareHost(cookie.domain))));
  return mergeUnits([...join, ...[...present].map((site) => [site])], siteOf)
    .map((unit) => [...unitSites(unit, siteOf)])
    .filter((sites) => sites.some((site) => present.has(site)));
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
  /** A computer that mirrors the desktop's profile replaces its Google jar whole too. */
  readonly replaceGoogle?: boolean;
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
    (input.replaceGoogle === true || !unitSites(input.unit, input.siteOf).has(GOOGLE))
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

export type UnitOutcome =
  | "copied"
  | "same"
  | "conflict"
  | "blocked"
  | "busy"
  | "failed"
  | "restore-failed";

/**
 * One unit into a jar as one transaction: snapshot, decide, write, read the whole unit back,
 * restore on a failed check. `foreign` holds by slot what a page wrote meanwhile; such a write to
 * a slot the copy touches wins (`busy`). Events carry no partition: a partitioned slot is only cleared.
 */
export async function applyUnit(
  store: CookieStore,
  plan: {
    readonly unit: ReadonlyArray<string>;
    readonly source: ReadonlyArray<SessionCookie>;
    readonly mode: "fill" | "fill-or-replace";
    readonly replaceAllowed: boolean;
    readonly replaceGoogle?: boolean;
    readonly nowSeconds: number;
    readonly siteOf: SiteOf;
    readonly foreign?: () => ReadonlyMap<string, SessionCookie>;
  },
): Promise<UnitOutcome> {
  const live = (cookies: ReadonlyArray<SessionCookie>) =>
    cookies.filter((cookie) => isLive(cookie, plan.nowSeconds));
  const foreign = () => plan.foreign?.() ?? new Map<string, SessionCookie>();
  const before = live(await store.readUnit(plan.unit));
  const decision = decideUnit({ ...plan, target: before });
  if (decision !== "copy") return decision;
  const written = live(unitCookies(plan.unit, plan.source, plan.siteOf));
  const slots = new Set([...written, ...before].map(cookieSlot));
  const competing = () => new Map([...foreign()].filter(([slot]) => slots.has(slot)));
  // The last look before writing: a change since the snapshot is newer than the copy.
  const still = await store.readUnit(plan.unit).then(live, () => undefined);
  if (!still) return "failed";
  if (competing().size > 0 || !sameUnit(still, before)) return "busy";
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
    competing().size === 0 &&
    written.every((cookie) => after.some((read) => sameCookie(cookie, read))) &&
    after.every(
      (read) =>
        changed.has(cookieSlot(read)) ||
        written.some((cookie) => cookieKey(cookie) === cookieKey(read)),
    )
  )
    return "copied";
  try {
    const raced = competing();
    const ambiguous = new Set(
      [...raced.keys()].filter((slot) =>
        [...written, ...before].some(
          (cookie) => cookie.partitionKey && cookieSlot(cookie) === slot,
        ),
      ),
    );
    const current = await store.readUnit(plan.unit);
    const ours = current.filter(
      (read) =>
        raced.get(cookieSlot(read))?.value !== read.value &&
        written.some(
          (cookie) => cookieKey(cookie) === cookieKey(read) && cookie.value === read.value,
        ),
    );
    if (ours.length) await store.remove(ours);
    const kept = current.filter((read) => !ours.includes(read));
    const holds = (cookie: SessionCookie, cookies: ReadonlyArray<SessionCookie>) =>
      cookies.some(
        (read) => cookieSlot(read) === cookieSlot(cookie) && read.value === cookie.value,
      );
    // A site's cookie the copy overwrote goes back; it is newer than both the copy and the snapshot.
    const overwritten = live([...raced.values()]).filter(
      (cookie) => !ambiguous.has(cookieSlot(cookie)) && !holds(cookie, kept),
    );
    const missing = before.filter(
      (cookie) =>
        !foreign().has(cookieSlot(cookie)) &&
        !kept.some((read) => cookieKey(read) === cookieKey(cookie)),
    );
    if (missing.length || overwritten.length) await store.set([...missing, ...overwritten]);
    const restored = live(await store.readUnit(plan.unit));
    const untouched = (cookie: SessionCookie) => !foreign().has(cookieSlot(cookie));
    const copyLeft = restored.some(
      (read) =>
        ambiguous.has(cookieSlot(read)) &&
        raced.get(cookieSlot(read))?.value !== read.value &&
        written.some(
          (cookie) => cookieKey(cookie) === cookieKey(read) && cookie.value === read.value,
        ),
    );
    const restoredExactly =
      !copyLeft &&
      sameUnit(restored.filter(untouched), before.filter(untouched)) &&
      live([...raced.values()])
        .filter((cookie) => !ambiguous.has(cookieSlot(cookie)))
        .every((cookie) => holds(cookie, restored));
    if (!restoredExactly) return "restore-failed";
    return raced.size > 0 ? "busy" : "failed";
  } catch {
    return "restore-failed";
  }
}

/** A unit's live cookies, values included, in one order: hashed, it tells a copy from later changes. */
export const unitFingerprintText = (cookies: ReadonlyArray<SessionCookie>, nowSeconds: number) =>
  JSON.stringify(
    cookies
      .filter((cookie) => isLive(cookie, nowSeconds))
      .map((c) =>
        JSON.stringify([
          c.name,
          c.domain,
          c.path,
          c.partitionKey?.topLevelSite ?? null,
          c.partitionKey?.hasCrossSiteAncestor ?? null,
          c.hostOnly,
          c.value,
        ]),
      )
      .sort(),
  );

/** One unit a copy wrote into Main: from which profile, and the digest of exactly what it wrote. */
export interface MainCopy {
  readonly from: string;
  readonly sites: ReadonlyArray<string>;
  readonly fingerprint: string;
}

/** A newer copy of a unit replaces every record that shares a site with it. */
export function withMainCopies(
  records: ReadonlyArray<MainCopy>,
  added: ReadonlyArray<MainCopy>,
  siteOf: SiteOf,
): ReadonlyArray<MainCopy> {
  const replaced = (record: MainCopy) =>
    added.some((copy) => {
      const sites = unitSites(copy.sites, siteOf);
      return [...unitSites(record.sites, siteOf)].some((site) => sites.has(site));
    });
  return [...records.filter((record) => !replaced(record)), ...added];
}

/**
 * Removes each copy that still holds exactly what it wrote; a unit the site rotated or someone
 * signed in to since is no longer the copy, and stays. Returns the units removed.
 */
export async function withdrawMainCopies(
  store: CookieStore,
  copies: ReadonlyArray<MainCopy>,
  fingerprint: (cookies: ReadonlyArray<SessionCookie>) => string,
): Promise<ReadonlyArray<ReadonlyArray<string>>> {
  const removed: Array<ReadonlyArray<string>> = [];
  for (const copy of copies) {
    const present = await store.readUnit(copy.sites);
    if (present.length === 0 || fingerprint(present) !== copy.fingerprint) continue;
    await store.remove(present);
    removed.push(copy.sites);
  }
  return removed;
}

type ProfileControls = Pick<BrowserProfileRecord, "access" | "scope" | "scriptSignIn">;

/** A profile whose sign-ins go to other computers: Allowed or Ask for all projects, scripts on. */
export const shareable = (profileId: string, record: ProfileControls) =>
  profileId !== INCOGNITO_BROWSER_PROFILE_ID &&
  record.access !== "off" &&
  record.scope.type === "all-projects" &&
  record.scriptSignIn;

/** The controls another computer shows for a profile: a project limit there becomes Off. */
export const remoteControls = (record: ProfileControls): SentProfileControls => ({
  access: record.scope.type === "all-projects" ? record.access : "off",
  scope: { type: "all-projects" },
  scriptSignIn: record.scriptSignIn,
});

/** A computer drops a desktop's copies after this many days without that desktop proving its key. */
export const SENDER_KEEP_DAYS = 30;

const OPENATHENS = "openathens.net";

/** Every site of the university rows, their learned sign-in addresses included. */
export const universitySites = (accounts: ReadonlyArray<AccountSummary>) =>
  accounts.flatMap(({ details }) =>
    details.kind === "website" && details.institution ? details.sites : [],
  );

/**
 * The university's sign-in never goes to another computer: OpenAthens, and any unit sharing a
 * registrable site with a university row. That computer signs in to the university itself.
 */
export const travels = (
  unit: ReadonlyArray<string>,
  university: ReadonlyArray<string>,
  siteOf: SiteOf,
) => {
  const sites = unitSites(unit, siteOf);
  if (sites.has(OPENATHENS)) return false;
  return ![...unitSites(university, siteOf)].some((site) => sites.has(site));
};

/**
 * A unit goes to another computer only while one of its sites has a website row naming this
 * profile in Accounts; the rest of the jar stays here.
 */
export const hasAccountRow = (
  unit: ReadonlyArray<string>,
  accounts: ReadonlyArray<AccountSummary>,
  profileId: string,
  siteOf: SiteOf,
) => {
  const sites = unitSites(unit, siteOf);
  return accounts.some(
    ({ details }) =>
      details.kind === "website" &&
      details.profileId === profileId &&
      [...unitSites(details.sites, siteOf)].some((site) => sites.has(site)),
  );
};

export interface PlannedUnit {
  readonly sites: ReadonlyArray<string>;
  readonly revision: number;
  readonly kind: "copy" | "delete";
}

export type DeliveryPlan =
  | { readonly kind: "controls" }
  | { readonly kind: "withdraw"; readonly revision: number }
  | {
      readonly kind: "units";
      readonly mode: "fill" | "replace";
      readonly units: ReadonlyArray<PlannedUnit>;
      /** The highest revision the remote holds once these units apply. */
      readonly head: number;
    };

const overlaps = (a: ReadonlyArray<string>, b: ReadonlyArray<string>, siteOf: SiteOf) => {
  const sites = unitSites(a, siteOf);
  return [...unitSites(b, siteOf)].some((site) => sites.has(site));
};

/**
 * What one profile still owes another computer, from durable state only: the desktop's send log,
 * the units its jar holds now (names), and what the remote applied from this desktop. A unit gone
 * from the jar is never deleted for its absence; only a delete revision removes it.
 */
export function planDelivery(input: {
  readonly log: ProfileSendLog | undefined;
  readonly applied: AccountSessionsApplied;
  readonly jar: ReadonlyArray<ReadonlyArray<string>>;
  readonly shareable: boolean;
  /**
   * The desktop no longer tracks what this computer applied (it was unlinked): the jar goes whole,
   * and every copy it holds that the jar no longer has is deleted, all at the log's head.
   */
  readonly reconcile?: boolean;
  readonly travels: (unit: ReadonlyArray<string>) => boolean;
  readonly siteOf: SiteOf;
}): DeliveryPlan {
  const { log, applied, siteOf } = input;
  const head = log?.head ?? 0;
  if (!input.shareable)
    return applied.bound &&
      log?.withdrawn !== undefined &&
      log.withdrawn > (applied.withdrawn ?? -1)
      ? { kind: "withdraw", revision: log.withdrawn }
      : { kind: "controls" };
  const jar = input.jar.filter((unit) => input.travels(unit));
  if (!applied.bound)
    return {
      kind: "units",
      mode: "fill",
      units: jar.map((sites) => ({ sites, revision: head, kind: "copy" as const })),
      head,
    };
  if (input.reconcile) {
    const gone = applied.units.filter(
      (unit) =>
        (unit.outcome === "copied" || unit.outcome === "same") &&
        !jar.some((present) => overlaps(present, unit.sites, siteOf)),
    );
    return {
      kind: "units",
      mode: "replace",
      units: [
        ...jar.map((sites) => ({ sites, revision: head, kind: "copy" as const })),
        ...gone.map(({ sites }) => ({ sites, revision: head, kind: "delete" as const })),
      ],
      head,
    };
  }
  const entries = (log?.units ?? []).filter(({ sites }) => input.travels(sites));
  const floor = applied.withdrawn ?? -1;
  const units: PlannedUnit[] = [];
  const components = mergeUnits(
    [...entries.map(({ sites }) => sites), ...(log?.jar === undefined ? [] : jar)],
    siteOf,
  );
  for (const sites of components) {
    if (!input.travels(sites)) continue;
    const inJar = jar.some((unit) => overlaps(unit, sites, siteOf));
    const entry = entries
      .filter((candidate) => overlaps(candidate.sites, sites, siteOf))
      .reduce<PlannedUnit | undefined>(
        (newest, candidate) =>
          newest === undefined || candidate.revision > newest.revision ? candidate : newest,
        undefined,
      );
    const jarRevision = log?.jar !== undefined && inJar ? log.jar : -1;
    const revision = Math.max(entry?.revision ?? -1, jarRevision);
    const kind = entry && entry.revision >= jarRevision ? entry.kind : "copy";
    const held = applied.units.filter((unit) => overlaps(unit.sites, sites, siteOf));
    const appliedRevision = held.length ? Math.min(...held.map((unit) => unit.revision)) : -1;
    if (revision <= Math.max(appliedRevision, floor)) continue;
    // Nothing to copy: the jar no longer has the unit.
    if (kind === "copy" && !inJar) continue;
    units.push({ sites, revision, kind });
  }
  return { kind: "units", mode: "replace", units, head };
}
