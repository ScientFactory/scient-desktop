import {
  BROWSER_PROFILE_MAX_COUNT,
  BrowserProfileId,
  type ClientSettings,
  DEFAULT_BROWSER_PROFILE_ID,
  type EnvironmentId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { persistClientSettingsUpdate } from "~/hooks/useSettings";
import { randomUUID } from "~/lib/utils";
import { appAtomRegistry } from "~/rpc/atomRegistry";

import { accountsState } from "./accountsState";
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

/**
 * Adds a profile named Profile, Profile 2, … and returns its id, or null once there are enough.
 * Its record says Scient made it, which an imported profile can't show.
 */
export async function addBrowserProfile(environmentId: EnvironmentId): Promise<string | null> {
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
  if (!added) return null;
  await accountsState.updateProfile
    .run(appAtomRegistry, {
      environmentId,
      input: {
        profileId: BrowserProfileId.make(id),
        madeInScient: DateTime.formatIso(DateTime.nowUnsafe()),
      },
    })
    .catch(() => undefined);
  return id;
}
