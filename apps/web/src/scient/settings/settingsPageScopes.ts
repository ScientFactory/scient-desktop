import type { SettingsScopeSearch } from "~/components/settings/settingsScope";

/**
 * How Scient's settings pages meet the scope picker.
 *
 * Providers, Documents and Extensions install tools per server, so their
 * picker chooses one environment rather than an aggregate. Documents holds no
 * project settings at all: its preferences live on this device and its tools
 * on one server, so it offers no project choice, and an offline environment
 * hides only its server tools, never the whole page. Extensions belong to one
 * server too; its connectors list that server's projects themselves.
 */
const SINGLE_ENVIRONMENT_SETTINGS_PATHS: Readonly<Record<string, true>> = {
  "/settings/providers": true,
  "/settings/documents": true,
  "/settings/extensions": true,
};

const SERVER_ONLY_SETTINGS_PATHS: Readonly<Record<string, true>> = {
  "/settings/documents": true,
  "/settings/extensions": true,
};

const OFFLINE_ENVIRONMENT_SETTINGS_PATHS: Readonly<Record<string, true>> = {
  "/settings/documents": true,
};

export function settingsPageChoosesOneEnvironment(pathname: string): boolean {
  return Object.hasOwn(SINGLE_ENVIRONMENT_SETTINGS_PATHS, pathname);
}

/** Whether a page offers only the environment choice, with no project or checkout. */
export function settingsPageIgnoresProjects(pathname: string): boolean {
  return Object.hasOwn(SERVER_ONLY_SETTINGS_PATHS, pathname);
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
  return Object.hasOwn(OFFLINE_ENVIRONMENT_SETTINGS_PATHS, pathname);
}
