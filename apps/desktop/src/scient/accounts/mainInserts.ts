// @effect-diagnostics globalDate:off -- Electron cookie events run outside Effect.
import { DEFAULT_BROWSER_PROFILE_ID, type SessionCookie } from "@t3tools/contracts";
import { cookieSlot } from "@t3tools/shared/scientSessionCookies";
import type { Cookie, Session } from "electron";

import { accountsSessionIdentity } from "./sessionIdentity.ts";
import { siteOf } from "./signedInSites.ts";

type CookieSession = Pick<Session, "cookies">;

/** A mark is consumed by the insert it announces, or dropped if that insert never comes. */
const MARK_MS = 60_000;
const TRACKED_SITES = 20_000;

const writeId = (
  cookie: { readonly name: string; readonly domain?: string; readonly path?: string },
  value: string,
  session: boolean,
) => JSON.stringify([cookieSlot(cookie), value, session]);

interface Marks {
  readonly ids: Map<string, { count: number; until: number }>;
}
const mark = (marks: Marks, id: string) => {
  const entry = marks.ids.get(id);
  const until = Date.now() + MARK_MS;
  marks.ids.set(id, { count: (entry?.count ?? 0) + 1, until });
};
const take = (marks: Marks, id: string) => {
  const entry = marks.ids.get(id);
  if (!entry) return false;
  if (entry.count <= 1) marks.ids.delete(id);
  else entry.count -= 1;
  return entry.until >= Date.now();
};

/**
 * One listener per session sorts each cookie insert: the coordinator's own write, the upkeep of
 * `keepSessionCookies`, or anything else (a page, a response). Transactions see every slot
 * someone else changed; the Main tracker sees only inserts that bring something new.
 */
interface Changes {
  readonly own: Marks;
  readonly upkeep: Marks;
  readonly watchers: Set<(slot: string) => void>;
  installedAt: number;
  onInsert?: (cookie: Cookie) => void;
}
const changes = new WeakMap<object, Changes>();

function changesFor(session: CookieSession): Changes {
  const existing = changes.get(session);
  if (existing) return existing;
  const created: Changes = {
    own: { ids: new Map() },
    upkeep: { ids: new Map() },
    watchers: new Set(),
    installedAt: Date.now(),
  };
  changes.set(session, created);
  session.cookies.on("changed", (_event, cookie, _cause, removed) => {
    if (removed) return;
    if (take(created.own, writeId(cookie, cookie.value, cookie.session === true))) return;
    for (const watcher of created.watchers) watcher(cookieSlot(cookie));
    const upkeep = !cookie.session && take(created.upkeep, writeId(cookie, cookie.value, false));
    if (!upkeep) created.onInsert?.(cookie);
  });
  return created;
}

/** Marks the coordinator's writes before it makes them, so its own inserts aren't foreign. */
export function markOwnWrites(session: CookieSession, cookies: ReadonlyArray<SessionCookie>) {
  const own = changesFor(session).own;
  for (const cookie of cookies)
    mark(own, writeId(cookie, cookie.value, cookie.expires === undefined));
}

/** Marks `keepSessionCookies` giving a session cookie its expiry: the same cookie, kept. */
export function markUpkeep(session: CookieSession, cookie: Cookie) {
  mark(changesFor(session).upkeep, writeId(cookie, cookie.value, false));
}

/** The slots anything but the coordinator writes into the session until `stop`. */
export function watchForeignInserts(session: CookieSession) {
  const slots = new Set<string>();
  const watcher = (slot: string) => void slots.add(slot);
  const { watchers } = changesFor(session);
  watchers.add(watcher);
  return { slots, stop: () => void watchers.delete(watcher) };
}

/**
 * When each site last got a cookie in Main from anything but the coordinator, since
 * `trackingSince`. Evicting a site raises `trackingSince`, so it never claims to know what it
 * dropped. It answers only "was Main touched here since T", and infers nothing about sign-outs.
 */
export function makeInsertTracker(trackingSince: number, cap = TRACKED_SITES) {
  const sites = new Map<string, number>();
  let since = trackingSince;
  return {
    record: (site: string, at: number) => {
      sites.delete(site);
      sites.set(site, at);
      if (sites.size <= cap) return;
      const [oldest, oldestAt] = sites.entries().next().value!;
      sites.delete(oldest);
      since = Math.max(since, oldestAt);
    },
    /** True when something may have put a cookie into these sites after `time`. */
    touchedSince: (unit: ReadonlyArray<string>, time: number) =>
      time < since || unit.some((site) => (sites.get(site) ?? -Infinity) > time),
  };
}

/** Each environment has one Main session, so a tracker per session is one per environment. */
const trackers = new WeakMap<object, ReturnType<typeof makeInsertTracker>>();

/** The tracker of an environment's Main session; undefined for any other session. */
export function mainInsertTracker(session: CookieSession) {
  const identity = accountsSessionIdentity(session);
  if (identity?.profileId !== DEFAULT_BROWSER_PROFILE_ID || !identity.persistent) return undefined;
  let tracker = trackers.get(session);
  if (!tracker) {
    tracker = makeInsertTracker(changesFor(session).installedAt);
    trackers.set(session, tracker);
  }
  return tracker;
}

/** Installed with every persistent session; it records inserts only once the session is a Main. */
export function trackMainInserts(session: CookieSession) {
  changesFor(session).onInsert = (cookie) => {
    const site = cookie.domain === undefined ? undefined : siteOf(cookie.domain);
    if (site) mainInsertTracker(session)?.record(site, Date.now());
  };
}
