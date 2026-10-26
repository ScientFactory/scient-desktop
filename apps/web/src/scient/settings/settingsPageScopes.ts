import type { SettingsScopeSearch } from "~/components/settings/settingsScope";

/**
 * Tool settings choose one server environment, never an aggregate. Document preferences remain
 * device-local and visible offline; hide only offline server tools. Documents has no project scope,
 * while connector grants list their server's own projects.
 */
const SINGLE_ENVIRONMENT_SETTINGS_PATHS: Readonly<Record<string, true>> = {
  "/settings/providers": true,
  "/settings/documents": true,
  // SCIENT-FORK:START — Scient Accounts: scope account grants to one server.
  "/settings/accounts": true,
  // SCIENT-FORK:END
  "/settings/extensions": true,
};

const SERVER_ONLY_SETTINGS_PATHS: Readonly<Record<string, true>> = {
  "/settings/documents": true,
  // SCIENT-FORK:START — Scient Accounts: scope account grants to one server.
  "/settings/accounts": true,
  // SCIENT-FORK:END
  "/settings/extensions": true,
};

const OFFLINE_ENVIRONMENT_SETTINGS_PATHS: Readonly<Record<string, true>> = {
  "/settings/documents": true,
};

/** The settings section a path belongs to: `/settings/extensions/installed` → `/settings/extensions`. */
function settingsSection(pathname: string): string {
  return pathname.split("/").slice(0, 3).join("/");
}

export function settingsPageChoosesOneEnvironment(pathname: string): boolean {
  return Object.hasOwn(SINGLE_ENVIRONMENT_SETTINGS_PATHS, settingsSection(pathname));
}

/** Whether a page offers only the environment choice, with no project or checkout. */
export function settingsPageIgnoresProjects(pathname: string): boolean {
  return Object.hasOwn(SERVER_ONLY_SETTINGS_PATHS, settingsSection(pathname));
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
  return Object.hasOwn(OFFLINE_ENVIRONMENT_SETTINGS_PATHS, settingsSection(pathname));
}
