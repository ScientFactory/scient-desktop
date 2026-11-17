/**
 * Page loads in Scient's browser, for people and agents alike: which site, whether it loaded,
 * how long it took and the browser's own error when it did not, and each tab's life when it
 * closes. Read from the preview manager's events, so it can never slow or fail a page.
 *
 * @module BrowserPageAnalytics
 */
import {
  INCOGNITO_BROWSER_PROFILE_ID,
  DEFAULT_BROWSER_PROFILE_ID,
  type PreviewEvent,
  type PreviewSessionSnapshot,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";

import { PreviewManager } from "../preview/Manager.ts";
import { AnalyticsService } from "./AnalyticsService.ts";
import { browserSite } from "./BrowserSite.ts";

const MAX_TRACKED_TABS = 500;
/** Past this many distinct sites a tab's count stops growing; `siteCount` then reads as at least. */
const MAX_SITES_PER_TAB = 200;
/** Chromium's error names, such as ERR_NAME_NOT_RESOLVED; any other description stays home. */
const CHROMIUM_ERROR = /^(?:net::)?(ERR_[A-Z0-9_]{1,60})$/u;

interface TabState {
  /** Who opened the tab. A person can take over an agent's tab; that is not visible here. */
  owner: "agent" | "user";
  runtime: string;
  headless: boolean;
  profile: "main" | "incognito" | "other";
  openedAt: number;
  loadStartedAt: number | undefined;
  /** The current navigation already reported its failure; the desktop repeats it on later reports. */
  failureReported: boolean;
  loads: number;
  failures: number;
  readonly sites: Set<string>;
}

const profileKind = (snapshot: PreviewSessionSnapshot): TabState["profile"] =>
  snapshot.profileId === undefined || snapshot.profileId === DEFAULT_BROWSER_PROFILE_ID
    ? "main"
    : snapshot.profileId === INCOGNITO_BROWSER_PROFILE_ID
      ? "incognito"
      : "other";

/** What a tab's snapshot says about who opened it and where it runs. */
function describe(state: TabState, snapshot: PreviewSessionSnapshot): void {
  state.owner = snapshot.automationOwner === undefined ? "user" : "agent";
  state.runtime = snapshot.runtime ?? "desktop";
  state.headless = snapshot.headless === true;
  state.profile = profileKind(snapshot);
}

export interface BrowserPageObservation {
  readonly name: "browser.page.loaded" | "browser.tab.closed";
  readonly properties: Readonly<Record<string, string | number | boolean>>;
}

/** Turns preview events into page and tab observations; pure, so tests drive it directly. */
export function createBrowserPageMapper() {
  const tabs = new Map<string, TabState>();
  const tabOf = (tabId: string, now: number) => {
    let state = tabs.get(tabId);
    if (state === undefined) {
      if (tabs.size >= MAX_TRACKED_TABS) {
        const oldest = tabs.keys().next().value;
        if (oldest !== undefined) tabs.delete(oldest);
      }
      state = {
        owner: "user",
        runtime: "desktop",
        headless: false,
        profile: "main",
        openedAt: now,
        loadStartedAt: undefined,
        failureReported: false,
        loads: 0,
        failures: 0,
        sites: new Set(),
      };
      tabs.set(tabId, state);
    }
    return state;
  };
  const common = (state: TabState) => ({
    owner: state.owner,
    runtime: state.runtime,
    headless: state.headless,
    profile: state.profile,
  });
  const page = (
    state: TabState,
    now: number,
    url: string,
    fields: Readonly<Record<string, string | number | boolean>>,
  ): BrowserPageObservation => {
    const site = browserSite(url);
    if (site !== undefined && state.sites.size < MAX_SITES_PER_TAB) state.sites.add(site);
    const startedAt = state.loadStartedAt;
    state.loadStartedAt = undefined;
    return {
      name: "browser.page.loaded",
      properties: {
        ...common(state),
        ...(site === undefined ? {} : { site }),
        ...(startedAt === undefined ? {} : { loadMs: Math.max(0, now - startedAt) }),
        ...fields,
      },
    };
  };

  const observe = (event: PreviewEvent, now: number): ReadonlyArray<BrowserPageObservation> => {
    switch (event.type) {
      case "opened":
      case "navigated": {
        const state = tabOf(event.tabId, now);
        describe(state, event.snapshot);
        const status = event.snapshot.navStatus;
        if (status._tag === "Loading") {
          state.loadStartedAt ??= now;
          state.failureReported = false;
          return [];
        }
        // A reload of a title or a same-page update reports Success again without loading.
        if (status._tag !== "Success" || state.loadStartedAt === undefined) return [];
        state.loads += 1;
        return [page(state, now, status.url, { outcome: "loaded" })];
      }
      case "failed": {
        const state = tabOf(event.tabId, now);
        if (state.failureReported) return [];
        state.failureReported = true;
        const download = event.download !== undefined;
        if (!download) state.failures += 1;
        const errorName = CHROMIUM_ERROR.exec(event.description.trim())?.[1];
        return [
          page(state, now, event.url, {
            outcome: download ? "download" : "failed",
            errorCode: event.code,
            ...(errorName === undefined ? {} : { errorName }),
          }),
        ];
      }
      case "closed": {
        const state = tabs.get(event.tabId);
        tabs.delete(event.tabId);
        if (state === undefined) return [];
        return [
          {
            name: "browser.tab.closed",
            properties: {
              ...common(state),
              lifetimeMs: Math.max(0, now - state.openedAt),
              pageLoads: state.loads,
              pageFailures: state.failures,
              siteCount: state.sites.size,
            },
          },
        ];
      }
      default:
        return [];
    }
  };
  return { observe, clear: () => tabs.clear() };
}

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const analytics = yield* AnalyticsService;
    if (!(yield* analytics.status).available) return;
    const manager = yield* PreviewManager;
    const mapper = createBrowserPageMapper();
    const events = yield* manager.subscribeEvents;
    yield* PubSub.take(events).pipe(
      Effect.flatMap((event) =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          for (const observation of mapper.observe(event, now))
            yield* analytics.record(observation.name, observation.properties);
        }),
      ),
      Effect.catchCause((cause) => Effect.logDebug("A browser page was not counted", { cause })),
      Effect.forever,
      Effect.forkScoped,
    );
  }),
);
