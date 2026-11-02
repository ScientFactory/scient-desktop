import {
  BROWSER_PROFILE_MAX_COUNT,
  type ClientSettings,
  DEFAULT_BROWSER_PROFILE_ID,
} from "@t3tools/contracts";

import { persistClientSettingsUpdate } from "~/hooks/useSettings";
import { randomUUID } from "~/lib/utils";

import { importProfileName, mergeProfiles } from "./accountsView";

/**
 * The built-in Main profile is only the starting point: once the user has a profile of their
 * own, the first one opens new tabs instead.
 */
export function withOwnDefault(current: ClientSettings): ClientSettings {
  const own = current.browserProfiles.filter((profile) => profile.kind === "persistent");
  return current.browserDefaultProfileId === DEFAULT_BROWSER_PROFILE_ID && own[0]
    ? { ...current, browserDefaultProfileId: own[0].id }
    : current;
}

/** Adds a profile named Profile, Profile 2, … and returns its id, or null once there are enough. */
export async function addBrowserProfile(): Promise<string | null> {
  const id = `profile-${randomUUID()}`;
  let added = false;
  await persistClientSettingsUpdate((current) => {
    if (current.browserProfiles.length >= BROWSER_PROFILE_MAX_COUNT) return current;
    added = true;
    return withOwnDefault({
      ...current,
      browserProfiles: [
        ...current.browserProfiles,
        {
          id,
          name: importProfileName(
            "Profile",
            mergeProfiles(current.browserProfiles, []).map((profile) => profile.name),
          ),
          kind: "persistent",
        },
      ],
    });
  });
  return added ? id : null;
}
