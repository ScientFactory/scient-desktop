import type { SettingsScopeSearch } from "~/components/settings/settingsScope";

/**
 * How Scient's settings pages meet the scope picker.
 *
 * Providers and Documents install tools per server, so their picker chooses
 * one environment rather than an aggregate. Documents holds no project
 * settings at all: its preferences live on this device and its tools on one
 * server, so it offers no project choice, and an offline environment hides
 * only its server tools, never the whole page.
 */
const SINGLE_ENVIRONMENT_SETTINGS_PATHS: ReadonlySet<string> = new Set([
  "/settings/providers",
  "/settings/documents",
]);

const SERVER_ONLY_SETTINGS_PATHS: ReadonlySet<string> = new Set(["/settings/documents"]);

const OFFLINE_ENVIRONMENT_SETTINGS_PATHS: ReadonlySet<string> = new Set(["/settings/documents"]);

export function settingsPageChoosesOneEnvironment(pathname: string): boolean {
  return SINGLE_ENVIRONMENT_SETTINGS_PATHS.has(pathname);
}

/** Whether a page offers only the environment choice, with no project or checkout. */
export function settingsPageIgnoresProjects(pathname: string): boolean {
  return SERVER_ONLY_SETTINGS_PATHS.has(pathname);
}

/**
 * The scope a page resolves. A server-only page sets the project and checkout
 * aside; they stay in the address for the pages that use them.
 */
export function settingsPageScopeSearch(
  pathname: string,
  search: SettingsScopeSearch,
): SettingsScopeSearch {
  return settingsPageIgnoresProjects(pathname) ? { machine: search.machine } : search;
}

/** Whether a page still renders while its one selected environment is disconnected. */
export function settingsPageRendersOffline(pathname: string): boolean {
  return OFFLINE_ENVIRONMENT_SETTINGS_PATHS.has(pathname);
}
