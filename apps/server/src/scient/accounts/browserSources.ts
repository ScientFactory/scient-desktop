import type { BrowserSourceProfile } from "@t3tools/contracts";

/** How a source's browser is named to agents and in a new profile's name: "Chrome · Work". */
const BROWSER_NAMES: Record<BrowserSourceProfile["browser"], string> = {
  chrome: "Chrome",
  chromium: "Chromium",
  edge: "Edge",
  brave: "Brave",
  vivaldi: "Vivaldi",
  opera: "Opera",
  arc: "Arc",
  helium: "Helium",
  firefox: "Firefox",
  zen: "Zen",
  safari: "Safari",
};

export const sourceName = (source: Pick<BrowserSourceProfile, "browser" | "name">) =>
  `${BROWSER_NAMES[source.browser]} · ${source.name}`.slice(0, 80);

/** A desktop whose last report is older than this is off: its sources can't be imported now. */
export const SOURCES_FRESH_MS = 10 * 60 * 1000;

/**
 * Round 6e: a desktop not heard from for this long is gone from the list, whether its reports
 * failed or it went off: nothing it named stays on offer.
 */
export const SOURCES_EXPIRE_MS = 60 * 60 * 1000;

/** A source's id for agents: the desktop, the browser and the profile folder. */
export const sourceIdOf = (
  computer: { readonly id: string },
  source: { readonly browser: string; readonly directory: string },
) => `${computer.id}/${source.browser}/${source.directory}`;
