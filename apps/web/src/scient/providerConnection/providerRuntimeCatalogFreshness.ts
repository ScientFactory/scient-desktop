import type { ProviderRuntimeSummary } from "@t3tools/contracts";
import { msg } from "gt-react";

import { m, type MessageResolver } from "~/i18n/messages";

import { formatRelativeTimeLabel } from "../../timestampFormat";

/**
 * Only managed/manageable runtimes have qualified-catalog freshness. Show last-check failure with
 * comparison state so an old list cannot imply current release knowledge.
 */
export function describeProviderRuntimeCatalog(
  runtime: ProviderRuntimeSummary,
  relativeTime: (iso: string) => string = formatRelativeTimeLabel,
  resolve: MessageResolver = m,
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
    ? resolve(msg("Update {version} available"), { version: available })
    : current
      ? resolve(msg("Up to date"))
      : runtime.source === "scient_managed" &&
          qualified !== null &&
          qualified !== runtime.managedVersion
        ? resolve(msg("Latest qualified {version}"), { version: qualified })
        : null;
  // After the releases phrase the freshness continues the line; alone it starts it.
  const lead = releases === null;
  const freshness = catalog.checksDisabled
    ? lead
      ? resolve(msg("Automatic update checks are off"))
      : resolve(msg("automatic update checks are off"))
    : catalog.failure
      ? catalog.checkedAt
        ? resolve(
            lead
              ? msg("Couldn't check for updates {failedAt}, last checked {checkedAt}")
              : msg("couldn't check for updates {failedAt}, last checked {checkedAt}"),
            {
              failedAt: relativeTime(catalog.failure.at),
              checkedAt: relativeTime(catalog.checkedAt),
            },
          )
        : resolve(
            lead
              ? msg("Couldn't check for updates {failedAt}")
              : msg("couldn't check for updates {failedAt}"),
            { failedAt: relativeTime(catalog.failure.at) },
          )
      : catalog.checkedAt
        ? resolve(lead ? msg("Checked {time}") : msg("checked {time}"), {
            time: relativeTime(catalog.checkedAt),
          })
        : null;
  const text = [releases, freshness].filter((part) => part !== null).join(" · ");
  if (!text) return null;
  const failed = catalog.failure !== null && !catalog.checksDisabled;
  return { text: failed ? `${text}. ${catalog.failure!.message}` : text, failed };
}
