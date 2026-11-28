import { loadSourceProfiles } from "./accountsView";
import type { DesktopSource } from "./profileReports";

/**
 * This desktop's browser profiles as Accounts' import lists them, for agents to import from:
 * the browser, folder, name and signed-in email only.
 */
export async function desktopSources(): Promise<ReadonlyArray<DesktopSource>> {
  const merged = await loadSourceProfiles();
  return merged.flatMap((source) =>
    source.unavailable === "notInstalled"
      ? []
      : source.profiles.map((profile) => ({
          browser: source.id,
          directory: profile.directory.slice(0, 200),
          name: profile.name.trim().slice(0, 80) || profile.directory.slice(0, 80),
          ...("email" in profile && profile.email ? { email: profile.email.slice(0, 254) } : {}),
        })),
  );
}
