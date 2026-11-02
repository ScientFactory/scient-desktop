import { INCOGNITO_BROWSER_PROFILE_ID } from "@t3tools/contracts";
import { normalizePreviewUrl } from "@t3tools/shared/preview";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveBrowserDefaults } from "~/browser/browserDefaults";
import { isLocalLoopbackHost, normalizeHostname } from "~/browser/browserTargetResolver";
import { resolveStorage } from "~/lib/storage";
import { byDomain, GMAIL_URL } from "~/scient/accounts/accountsView";
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

export interface SavedShortcuts {
  /** Sites the user added, in the order they added them. */
  readonly added: ReadonlyArray<string>;
  /** The names the user gave them, by address. */
  readonly names: Readonly<Record<string, string>>;
  /** Sites the user removed, which suggestions must not bring back. */
  readonly hidden: ReadonlyArray<string>;
  readonly visits: Readonly<Record<string, SiteVisits>>;
}

interface ShortcutsByProfile {
  readonly profiles: Readonly<Record<string, SavedShortcuts>>;
  /** Saved before each profile had its own, until the default profile takes them. */
  readonly unclaimed: SavedShortcuts | null;
}

interface BrowserShortcutsState extends ShortcutsByProfile {
  recordVisit: (profileId: string, url: string, at: number) => void;
  /** Adds a site, or replaces `previous`. An empty name leaves the site's own. */
  save: (profileId: string, previous: Shortcut | null, link: string, name: string) => void;
  remove: (profileId: string, shortcut: Shortcut) => void;
  forgetProfile: (profileId: string) => void;
  claimUnclaimed: (profileId: string) => void;
}

/** Eight places, one of them the Add circle until the user has added eight of their own. */
const MAX_SHORTCUTS = 8;
const MIN_VISITS_TO_SUGGEST = 2;
const MAX_REMEMBERED_SITES = 100;
const STORAGE_KEY = "scient:browser-shortcuts:v1";
const NO_SHORTCUTS: SavedShortcuts = { added: [], names: {}, hidden: [], visits: {} };

const GOOGLE: HomeSite = {
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

/** Gmail has its place at the top of the page, and every Google search would count as Google. */
const NEVER_SUGGESTED: ReadonlyArray<HomeSite> = [GOOGLE, GMAIL];

export const GOOGLE_APPS: ReadonlyArray<HomeSite> = [
  GOOGLE,
  { name: "Account", url: "https://myaccount.google.com/", icon: ICONS.account },
  DRIVE,
  CALENDAR,
  { name: "Docs", url: "https://docs.google.com/document/", icon: ICONS.docs },
  { name: "Sheets", url: "https://docs.google.com/spreadsheets/", icon: ICONS.sheets },
  { name: "Slides", url: "https://docs.google.com/presentation/", icon: ICONS.slides },
  SCHOLAR,
  { name: "Notebook", url: "https://notebook.google.com/", icon: ICONS.notebook },
  { name: "Meet", url: "https://meet.google.com/", icon: ICONS.meet },
  { name: "Tasks", url: "https://tasks.google.com/", icon: ICONS.tasks },
  { name: "YouTube", url: "https://www.youtube.com/", icon: ICONS.youtube },
  { name: "Gemini", url: "https://gemini.google.com/", icon: ICONS.gemini },
  { name: "Photos", url: "https://photos.google.com/", icon: ICONS.photos },
  { name: "Maps", url: "https://maps.google.com/", icon: ICONS.maps },
  { name: "Translate", url: "https://translate.google.com/", icon: ICONS.translate },
  { name: "Forms", url: "https://docs.google.com/forms/", icon: ICONS.forms },
  { name: "Colab", url: "https://colab.research.google.com/", icon: ICONS.colab },
  { name: "Keep", url: "https://keep.google.com/", icon: ICONS.keep },
  { name: "Chat", url: "https://chat.google.com/", icon: ICONS.chat },
  { name: "Contacts", url: "https://contacts.google.com/", icon: ICONS.contacts },
  { name: "Classroom", url: "https://classroom.google.com/", icon: ICONS.classroom },
  { name: "Sites", url: "https://sites.google.com/", icon: ICONS.sites },
  { name: "Groups", url: "https://groups.google.com/", icon: ICONS.groups },
  { name: "Books", url: "https://books.google.com/", icon: ICONS.books },
  { name: "News", url: "https://news.google.com/", icon: ICONS.news },
  { name: "Earth", url: "https://earth.google.com/", icon: ICONS.earth },
];

const STARTING_SITES: ReadonlyArray<HomeSite> = [
  SCHOLAR,
  { name: "PubMed", url: "https://pubmed.ncbi.nlm.nih.gov/", icon: ICONS.pubmed },
  { name: "arXiv", url: "https://arxiv.org/", icon: ICONS.arxiv },
  { name: "Overleaf", url: "https://www.overleaf.com/", icon: ICONS.overleaf },
  DRIVE,
  CALENDAR,
];

const moodle = (url: string, icon: string): HomeSite => ({ name: "Moodle", url, icon });
const REICHMAN = moodle("https://moodle.runi.ac.il/", ICONS.runi);

/** Each university's learning site, by the domain of its people's addresses. */
const UNIVERSITY_SITES: Readonly<Record<string, HomeSite>> = {
  "huji.ac.il": moodle("https://moodle.huji.ac.il/", ICONS.huji),
  "tau.ac.il": moodle("https://moodle.tau.ac.il/", ICONS.tau),
  "technion.ac.il": moodle("https://moodle.technion.ac.il/", ICONS.technion),
  "bgu.ac.il": moodle("https://moodle.bgu.ac.il/", ICONS.bgu),
  "openu.ac.il": { name: "Opal", url: "https://opal.openu.ac.il/", icon: ICONS.openu },
  "ariel.ac.il": moodle("https://moodle.ariel.ac.il/", ICONS.ariel),
  "runi.ac.il": REICHMAN,
  // Reichman was IDC Herzliya, and many still have those addresses.
  "idc.ac.il": REICHMAN,
};

/** A site's host, without its port or the trailing dot of a fully written name. */
function hostOf(site: string) {
  return site
    .replace(/^https?:\/\//i, "")
    .split(/[/?#]/)[0]!
    .replace(/:\d*$/, "")
    .replace(/\.+$/, "")
    .toLowerCase();
}

/** The last two labels of a host, or three under a country's zone such as ac.il or edu.au. */
function organisationDomain(host: string) {
  const labels = host.split(".");
  const inZone =
    labels.length > 2 &&
    labels.at(-1)!.length === 2 &&
    ["ac", "edu", "co", "org", "gov", "net"].includes(labels.at(-2)!);
  return labels.slice(inZone ? -3 : -2).join(".");
}

/**
 * The learning site of the university a profile's own address is at. A listed university has its
 * own; for any other it's the Moodle on that university's domain the profile opens most or signs
 * in to. Other profiles add it as a shortcut.
 */
export function universitySite(
  addressDomain: string | undefined,
  signInSites: ReadonlyArray<string>,
  visits: SavedShortcuts["visits"],
): HomeSite | undefined {
  if (!addressDomain) return undefined;
  const domain = hostOf(addressDomain);
  const listed = byDomain([domain], UNIVERSITY_SITES);
  if (listed) return listed.value;
  const organisation = organisationDomain(domain);
  const opened = Object.values(visits)
    .filter(({ count }) => count >= MIN_VISITS_TO_SUGGEST)
    .toSorted((a, b) => b.count - a.count)
    .map(({ url }) => url);
  const found = [...opened, ...signInSites]
    .flatMap((site) => parseSiteUrl(site) ?? [])
    .find(({ hostname }) => {
      const host = hostOf(hostname);
      return host.startsWith("moodle") && host.endsWith(`.${organisation}`);
    });
  return found ? { name: "Moodle", url: `${found.origin}/` } : undefined;
}

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

/** The first site on each host names it, so everything on docs.google.com reads as Docs. */
const KNOWN_SITES = new Map(
  [...GOOGLE_APPS, ...STARTING_SITES, ...Object.values(UNIVERSITY_SITES)]
    .flatMap((site) => {
      const key = siteKeyOf(site.url);
      return key ? [[key, site] as const] : [];
    })
    .toReversed(),
);

function shortcutFor(url: string, key: string, name?: string): Shortcut {
  const known = KNOWN_SITES.get(key);
  return {
    key,
    url,
    name: name ?? known?.name ?? key,
    ...(known?.icon ? { icon: known.icon } : {}),
  };
}

/** The user's sites, then what they open most, then the starting set, without repeating a site. */
export function visibleShortcuts(
  { added, names, hidden, visits }: SavedShortcuts,
  alsoOnTopRow: ReadonlyArray<HomeSite> = [],
): Shortcut[] {
  const notSuggested = [...NEVER_SUGGESTED, ...alsoOnTopRow].flatMap(
    (site) => siteKeyOf(site.url) ?? [],
  );
  const taken = new Set([...hidden, ...notSuggested]);
  const shortcuts = added.flatMap((url) => {
    const key = siteKeyOf(url);
    if (!key) return [];
    taken.add(key);
    return [shortcutFor(url, key, names[url])];
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

function withoutName(names: SavedShortcuts["names"], url: string | undefined) {
  return Object.fromEntries(Object.entries(names).filter(([site]) => site !== url));
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

/** Incognito keeps nothing, so a change to it changes nothing. */
function changingProfile(
  state: ShortcutsByProfile,
  profileId: string,
  change: (saved: SavedShortcuts) => SavedShortcuts,
) {
  if (profileId === INCOGNITO_BROWSER_PROFILE_ID) return state;
  const profiles = {
    ...state.profiles,
    [profileId]: change(state.profiles[profileId] ?? NO_SHORTCUTS),
  };
  return { profiles };
}

/** What a profile saved wins, so anything done before the old set arrived stays. */
function combined(old: SavedShortcuts, saved: SavedShortcuts): SavedShortcuts {
  return {
    added: [...new Set([...old.added, ...saved.added])],
    names: { ...old.names, ...saved.names },
    hidden: [...new Set([...old.hidden, ...saved.hidden])],
    visits: { ...old.visits, ...saved.visits },
  };
}

/** Version 1 kept one set for every profile. */
export function migrateShortcuts(persisted: unknown, version: number): ShortcutsByProfile {
  return version < 2
    ? { profiles: {}, unclaimed: { ...NO_SHORTCUTS, ...(persisted as Partial<SavedShortcuts>) } }
    : (persisted as ShortcutsByProfile);
}

export const useBrowserShortcuts = create<BrowserShortcutsState>()(
  persist(
    (set) => ({
      profiles: {},
      unclaimed: null,
      recordVisit: (profileId, url, at) =>
        set((state) =>
          changingProfile(state, profileId, (saved) => ({
            ...saved,
            visits: withVisit(saved.visits, url, at),
          })),
        ),
      save: (profileId, previous, link, name) =>
        set((state) => {
          const url = parseSiteUrl(link);
          if (!url) return state;
          return changingProfile(state, profileId, (saved) => {
            const key = siteKey(url);
            const index = previous ? saved.added.indexOf(previous.url) : -1;
            const added =
              index < 0 ? [...saved.added, url.href] : saved.added.with(index, url.href);
            const names = withoutName(saved.names, previous?.url);
            if (name.trim()) names[url.href] = name.trim();
            else delete names[url.href];
            const hidden = saved.hidden.filter((site) => site !== key);
            return {
              ...saved,
              added: [...new Set(added)],
              names,
              // A suggestion moved to another site doesn't come back under its old one.
              hidden: previous && previous.key !== key ? [...hidden, previous.key] : hidden,
            };
          });
        }),
      remove: (profileId, { url, key }) =>
        set((state) =>
          changingProfile(state, profileId, (saved) => ({
            ...saved,
            added: saved.added.filter((site) => site !== url),
            names: withoutName(saved.names, url),
            hidden: saved.hidden.includes(key) ? saved.hidden : [...saved.hidden, key],
          })),
        ),
      forgetProfile: (profileId) =>
        set((state) => ({
          profiles: Object.fromEntries(
            Object.entries(state.profiles).filter(([id]) => id !== profileId),
          ),
        })),
      claimUnclaimed: (profileId) =>
        set((state) =>
          state.unclaimed
            ? {
                unclaimed: null,
                profiles: {
                  ...state.profiles,
                  [profileId]: combined(state.unclaimed, state.profiles[profileId] ?? NO_SHORTCUTS),
                },
              }
            : state,
        ),
    }),
    {
      name: STORAGE_KEY,
      version: 2,
      migrate: migrateShortcuts,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: ({ profiles, unclaimed }) => ({ profiles, unclaimed }),
    },
  ),
);

/** What a profile has saved. Incognito keeps nothing, so it always gets the starting set. */
export function useProfileShortcuts(profileId: string) {
  return useBrowserShortcuts((state) => state.profiles[profileId] ?? NO_SHORTCUTS);
}

if (useBrowserShortcuts.getState().unclaimed) {
  void resolveBrowserDefaults()
    .then(({ profileId }) => useBrowserShortcuts.getState().claimUnclaimed(profileId))
    .catch(() => undefined);
}

if (typeof window !== "undefined")
  window.addEventListener("storage", (event) => {
    if (event.key === STORAGE_KEY) void useBrowserShortcuts.persist.rehydrate();
  });

export function recordSiteVisit(profileId: string, url: string) {
  useBrowserShortcuts.getState().recordVisit(profileId, url, Date.now());
}
