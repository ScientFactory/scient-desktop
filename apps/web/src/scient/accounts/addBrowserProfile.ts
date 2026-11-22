import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import {
  BROWSER_PROFILE_MAX_COUNT,
  BrowserProfileId,
  type EnvironmentId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { persistClientSettingsUpdate } from "~/hooks/useSettings";
import { randomUUID } from "~/lib/utils";
import { appAtomRegistry } from "~/rpc/atomRegistry";

import { accountsState } from "./accountsState";
import { importProfileName, mergeProfiles } from "./accountsView";

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
    return {
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
    };
  });
  if (!added) return null;
  await runAtomCommand(
    appAtomRegistry,
    accountsState.updateProfile,
    {
      environmentId,
      input: {
        profileId: BrowserProfileId.make(id),
        madeInScient: DateTime.formatIso(DateTime.nowUnsafe()),
      },
    },
    { reportFailure: false },
  ).catch(() => undefined);
  return id;
}
