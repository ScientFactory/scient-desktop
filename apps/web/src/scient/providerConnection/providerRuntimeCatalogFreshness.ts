import type { ProviderRuntimeSummary } from "@t3tools/contracts";

import { formatRelativeTimeLabel } from "../../timestampFormat";

/**
 * One line on Scient's qualified releases for a runtime it manages or can
 * manage: how the installed copy compares with the newest one, and how current
 * that list is ("Update 0.241.1 available · checked 5m ago"), with the reason when
 * the latest check failed. Null when the runtime has nothing to do with Scient's
 * list.
 */
export function describeProviderRuntimeCatalog(
  runtime: ProviderRuntimeSummary,
  relativeTime: (iso: string) => string = formatRelativeTimeLabel,
): { readonly text: string; readonly failed: boolean } | null {
  const { catalog } = runtime;
  const managesRuntime =
    runtime.source === "scient_managed" ||
    runtime.actions.includes("install") ||
    runtime.actions.includes("update");
  if (!catalog || !managesRuntime) return null;

  const available =
    runtime.availableManagedVersion && runtime.availableManagedVersion !== runtime.managedVersion
      ? runtime.availableManagedVersion
      : null;
  const qualified = runtime.qualifiedVersion ?? null;
  // "Up to date" needs the installed copy to be the newest qualified release,
  // known from a check that succeeded.
  const current =
    runtime.source === "scient_managed" &&
    qualified !== null &&
    runtime.managedVersion === qualified &&
    catalog.checkedAt !== null &&
    catalog.failure === null &&
    !catalog.checksDisabled;
  const releases = available
    ? `Update ${available} available`
    : current
      ? "Up to date"
      : runtime.source === "scient_managed" &&
          qualified !== null &&
          qualified !== runtime.managedVersion
        ? `Latest qualified ${qualified}`
        : null;
  const lastChecked = catalog.checkedAt ? `last checked ${relativeTime(catalog.checkedAt)}` : null;
  const freshness = catalog.checksDisabled
    ? "automatic update checks are off"
    : catalog.failure
      ? [`couldn't check for updates ${relativeTime(catalog.failure.at)}`, lastChecked]
          .filter((part) => part !== null)
          .join(", ")
      : catalog.checkedAt
        ? `checked ${relativeTime(catalog.checkedAt)}`
        : null;
  const line = [releases, freshness].filter((part) => part !== null).join(" · ");
  if (!line) return null;
  const failed = catalog.failure !== null && !catalog.checksDisabled;
  const text = line.charAt(0).toUpperCase() + line.slice(1);
  return { text: failed ? `${text}. ${catalog.failure!.message}` : text, failed };
}
