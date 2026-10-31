import { normalizePreviewUrl } from "@t3tools/shared/preview";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { isLocalLoopbackHost, normalizeHostname } from "~/browser/browserTargetResolver";
import { resolveStorage } from "~/lib/storage";
import { GMAIL_URL } from "~/scient/accounts/accountsView";
import { isIdentityProvider } from "~/scient/accounts/sessionDetection";

import ICONS from "./browserHomeIcons.json";

export interface HomeSite {
  readonly name: string;
  readonly url: string;
  readonly icon?: string;
}

export interface Shortcut extends HomeSite {
  readonly key: string;
}

interface SiteVisits {
  readonly url: string;
  readonly count: number;
  readonly lastVisitedAt: number;
}

interface SavedShortcuts {
  /** Sites the user added, in the order they added them. */
  readonly added: ReadonlyArray<string>;
  /** Sites the user removed, which suggestions must not bring back. */
  readonly hidden: ReadonlyArray<string>;
  readonly visits: Readonly<Record<string, SiteVisits>>;
}

interface BrowserShortcutsState extends SavedShortcuts {
  recordVisit: (url: string, at: number) => void;
  add: (url: string) => void;
  remove: (shortcut: Shortcut) => void;
}

/** Eight places, one of them the Add circle until the user has added eight of their own. */
const MAX_SHORTCUTS = 8;
const MIN_VISITS_TO_SUGGEST = 2;
const MAX_REMEMBERED_SITES = 100;
const STORAGE_KEY = "scient:browser-shortcuts:v1";

export const GOOGLE: HomeSite = {
  name: "Google",
  url: "https://www.google.com/",
  icon: ICONS.google,
};
export const GMAIL: HomeSite = { name: "Gmail", url: GMAIL_URL, icon: ICONS.gmail };

const DRIVE: HomeSite = { name: "Drive", url: "https://drive.google.com/", icon: ICONS.drive };
const CALENDAR: HomeSite = {
  name: "Calendar",
  url: "https://calendar.google.com/",
  icon: ICONS.calendar,
};
const SCHOLAR: HomeSite = {
  name: "Scholar",
  url: "https://scholar.google.com/",
  icon: ICONS.scholar,
};

export const GOOGLE_APPS: ReadonlyArray<HomeSite> = [
  DRIVE,
  CALENDAR,
  { name: "Docs", url: "https://docs.google.com/document/", icon: ICONS.docs },
  { name: "Sheets", url: "https://docs.google.com/spreadsheets/", icon: ICONS.sheets },
  { name: "Slides", url: "https://docs.google.com/presentation/", icon: ICONS.slides },
  { name: "Meet", url: "https://meet.google.com/", icon: ICONS.meet },
  SCHOLAR,
  { name: "Maps", url: "https://maps.google.com/", icon: ICONS.maps },
  { name: "Translate", url: "https://translate.google.com/", icon: ICONS.translate },
];

const STARTING_SITES: ReadonlyArray<HomeSite> = [
  SCHOLAR,
  { name: "PubMed", url: "https://pubmed.ncbi.nlm.nih.gov/", icon: ICONS.pubmed },
  { name: "arXiv", url: "https://arxiv.org/", icon: ICONS.arxiv },
  { name: "Overleaf", url: "https://www.overleaf.com/", icon: ICONS.overleaf },
  DRIVE,
  CALENDAR,
];

/** A web address, or null when the text isn't one. Chromium percent-encodes spaces in a host. */
export function parseSiteUrl(raw: string): URL | null {
  try {
    const url = new URL(normalizePreviewUrl(raw));
    return url.hostname.includes(".") && !url.hostname.includes("%") ? url : null;
  } catch {
    return null;
  }
}

function siteKey(url: URL) {
  return normalizeHostname(url.hostname).replace(/^www\./, "");
}

function siteKeyOf(raw: string) {
  const url = parseSiteUrl(raw);
  return url ? siteKey(url) : null;
}

const KNOWN_SITES = new Map(
  [...GOOGLE_APPS, ...STARTING_SITES].flatMap((site) => {
    const key = siteKeyOf(site.url);
    return key ? [[key, site] as const] : [];
  }),
);

function shortcutFor(url: string, key: string): Shortcut {
  const known = KNOWN_SITES.get(key);
  return { key, url, name: known?.name ?? key, ...(known?.icon ? { icon: known.icon } : {}) };
}

/** The user's sites, then what they open most, then the starting set, without repeating a site. */
export function visibleShortcuts({ added, hidden, visits }: SavedShortcuts): Shortcut[] {
  const onHomeAlready = [GOOGLE, GMAIL].flatMap((site) => siteKeyOf(site.url) ?? []);
  const taken = new Set([...hidden, ...onHomeAlready]);
  const shortcuts = added.flatMap((url) => {
    const key = siteKeyOf(url);
    if (!key) return [];
    taken.add(key);
    return [shortcutFor(url, key)];
  });
  const frequent = Object.values(visits)
    .filter(({ count }) => count >= MIN_VISITS_TO_SUGGEST)
    .toSorted((a, b) => b.count - a.count || b.lastVisitedAt - a.lastVisitedAt);
  for (const { url } of [...frequent, ...STARTING_SITES]) {
    const key = siteKeyOf(url);
    if (!key || taken.has(key)) continue;
    taken.add(key);
    shortcuts.push(shortcutFor(url, key));
  }
  return shortcuts.slice(0, canAddShortcut(added) ? MAX_SHORTCUTS - 1 : MAX_SHORTCUTS);
}

export function canAddShortcut(added: ReadonlyArray<string>) {
  return added.length < MAX_SHORTCUTS;
}

function withVisit(
  visits: SavedShortcuts["visits"],
  raw: string,
  at: number,
): SavedShortcuts["visits"] {
  const url = parseSiteUrl(raw);
  if (!url || isIdentityProvider(url.href)) return visits;
  const host = normalizeHostname(url.hostname);
  if (isLocalLoopbackHost(host) || host === "0.0.0.0") return visits;
  const key = siteKey(url);
  const next = {
    ...visits,
    [key]: { url: `${url.origin}/`, count: (visits[key]?.count ?? 0) + 1, lastVisitedAt: at },
  };
  const remembered = Object.entries(next)
    .toSorted(([, a], [, b]) => b.lastVisitedAt - a.lastVisitedAt)
    .slice(0, MAX_REMEMBERED_SITES);
  return Object.fromEntries(remembered);
}

export const useBrowserShortcuts = create<BrowserShortcutsState>()(
  persist(
    (set) => ({
      added: [],
      hidden: [],
      visits: {},
      recordVisit: (url, at) => set((state) => ({ visits: withVisit(state.visits, url, at) })),
      add: (raw) =>
        set((state) => {
          const url = parseSiteUrl(raw);
          if (!url) return state;
          const key = siteKey(url);
          return {
            added: state.added.includes(url.href) ? state.added : [...state.added, url.href],
            hidden: state.hidden.filter((site) => site !== key),
          };
        }),
      remove: ({ url, key }) =>
        set((state) => ({
          added: state.added.filter((site) => site !== url),
          hidden: state.hidden.includes(key) ? state.hidden : [...state.hidden, key],
        })),
    }),
    {
      name: STORAGE_KEY,
      version: 1,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: ({ added, hidden, visits }) => ({ added, hidden, visits }),
    },
  ),
);

if (typeof window !== "undefined")
  window.addEventListener("storage", (event) => {
    if (event.key === STORAGE_KEY) void useBrowserShortcuts.persist.rehydrate();
  });

export function recordSiteVisit(url: string) {
  useBrowserShortcuts.getState().recordVisit(url, Date.now());
}
