/**
 * How Scient's settings pages meet the scope picker.
 *
 * Providers and Documents install tools per server, so their picker chooses
 * one environment rather than an aggregate. Documents also holds preferences
 * that live on this device, so an offline environment hides only its server
 * tools, never the whole page.
 */
const SINGLE_ENVIRONMENT_SETTINGS_PATHS: ReadonlySet<string> = new Set([
  "/settings/providers",
  "/settings/documents",
]);

const OFFLINE_ENVIRONMENT_SETTINGS_PATHS: ReadonlySet<string> = new Set(["/settings/documents"]);

export function settingsPageChoosesOneEnvironment(pathname: string): boolean {
  return SINGLE_ENVIRONMENT_SETTINGS_PATHS.has(pathname);
}

/** Whether a page still renders while its one selected environment is disconnected. */
export function settingsPageRendersOffline(pathname: string): boolean {
  return OFFLINE_ENVIRONMENT_SETTINGS_PATHS.has(pathname);
}
