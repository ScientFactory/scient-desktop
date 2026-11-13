import type { EnvironmentId } from "@t3tools/contracts";

import { recordScientAnalyticsInContext, scientAnalyticsProductContext } from "./client";

/**
 * The computer Scient's browser runs on: the desktop app's own platform, never that of a server
 * it is connected to.
 */
export type BrowserPlatform = "windows" | "macos" | "linux" | "unknown";

const desktopPlatform = () => {
  const bridge = typeof window === "undefined" ? undefined : window.desktopBridge;
  // Bridges stubbed in tests may leave it out.
  return typeof bridge?.getClientPlatform === "function" ? bridge.getClientPlatform() : undefined;
};

export function browserPlatform(platform = desktopPlatform()): BrowserPlatform {
  if (platform === "win32") return "windows";
  if (platform === "darwin") return "macos";
  if (platform === "linux") return "linux";
  return "unknown";
}

export type ChromiumBrowserName = "chrome" | "edge" | "brave" | "chromium" | "other";

export const chromiumBrowserName = (name: string | undefined): ChromiumBrowserName => {
  const lower = name?.toLowerCase() ?? "";
  if (lower.includes("edge")) return "edge";
  if (lower.includes("brave")) return "brave";
  if (lower.includes("chromium")) return "chromium";
  return lower.includes("chrome") ? "chrome" : "other";
};

export type GoogleCopySource = "browser_window" | "browser_import" | "main_copy";

/** Each event's fields: fixed codes and coarse buckets, never names, sites, URLs or addresses. */
export type AccountBrowserEvents = {
  /** Scient's browser stopped a Google sign-in page before it ran. */
  readonly "accounts.google_signin.blocked": {
    readonly variant: "credentials" | "transit" | "rejected";
    readonly context: "tab" | "popup" | "frame";
  };
  /** One run of the sign-in window in the person's own browser. */
  readonly "accounts.browser_window": {
    readonly variant:
      | "copied"
      | "partial"
      | "nothing"
      | "cancelled"
      | "busy"
      | "no_browser"
      | "failed";
    readonly browser: ChromiumBrowserName;
    readonly purpose: "google" | "site";
    readonly google: "accepted" | "rejected" | "unknown" | "none";
  };
  /** One import or refresh of sign-ins from a browser on this computer. */
  readonly "accounts.browser_import": {
    readonly variant: "complete" | "partial" | "blocked" | "failed";
    readonly sourceBrowser: string;
    /** What `importedBucket` counts: an import into Main copies sign-ins. */
    readonly importedUnit: "cookies" | "sign_ins";
    readonly importedBucket: string;
    readonly protectedSkipped: string;
  };
  /** Google's first answer about a copied Google sign-in. */
  readonly "accounts.google_copy.checked": {
    readonly variant: GoogleCopySource;
    readonly outcome: "valid" | "invalid";
  };
  /** Google stopped accepting a copied sign-in it had been sent. */
  readonly "accounts.google_copy.ended": {
    readonly variant: GoogleCopySource;
    readonly ageBucket: string;
    readonly lastValidBucket: string;
  };
};

export type AccountBrowserFeature = keyof AccountBrowserEvents;

/** Records one of these events. Analytics never affects the action it observes. */
export type RecordAccountBrowserEvent = <F extends AccountBrowserFeature>(
  feature: F,
  fields: AccountBrowserEvents[F],
) => void;

/**
 * Work whose outcome arrives later, observed under the consent in force when it began: the event
 * carries that consent's context, and the server drops it when consent changed or the server
 * restarted in between.
 */
export interface AccountBrowserObservation {
  /** Undefined when nothing may be collected; then `record` does nothing. */
  readonly context: string | undefined;
  readonly record: RecordAccountBrowserEvent;
}

export function recordInAccountBrowserContext<F extends AccountBrowserFeature>(
  environmentId: EnvironmentId,
  context: string,
  feature: F,
  fields: AccountBrowserEvents[F],
): void {
  try {
    recordScientAnalyticsInContext(environmentId, context, {
      name: "feature.used",
      properties: { ...fields, feature, browserPlatform: browserPlatform() },
    });
  } catch {
    // Nothing to do: the observation is lost, the action is not.
  }
}

export function beginAccountBrowserObservation(
  environmentId: EnvironmentId,
): AccountBrowserObservation {
  const context = scientAnalyticsProductContext(environmentId);
  return {
    context,
    record: (feature, fields) => {
      if (context !== undefined)
        recordInAccountBrowserContext(environmentId, context, feature, fields);
    },
  };
}

/** Records something that just happened. */
export function recordAccountBrowserEvent<F extends AccountBrowserFeature>(
  environmentId: EnvironmentId,
  feature: F,
  fields: AccountBrowserEvents[F],
): void {
  beginAccountBrowserObservation(environmentId).record(feature, fields);
}

const AGE_BUCKETS: ReadonlyArray<readonly [number, string]> = [
  [5 * 60_000, "lt_5m"],
  [30 * 60_000, "5m_30m"],
  [2 * 3_600_000, "30m_2h"],
  [24 * 3_600_000, "2h_24h"],
  [7 * 86_400_000, "1d_7d"],
  [30 * 86_400_000, "7d_30d"],
];

/** A duration as a coarse bucket, so no exact time is sent. */
export function ageBucket(milliseconds: number): string {
  for (const [limit, bucket] of AGE_BUCKETS) if (milliseconds < limit) return bucket;
  return "gt_30d";
}

/** A count as a coarse bucket. */
export function countBucket(count: number): string {
  if (count <= 0) return "0";
  if (count <= 10) return "1_10";
  if (count <= 100) return "11_100";
  return "gt_100";
}
