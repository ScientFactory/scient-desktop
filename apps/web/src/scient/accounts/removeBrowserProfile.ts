import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import {
  BrowserProfileId,
  DEFAULT_BROWSER_PROFILE_ID,
  type EnvironmentId,
} from "@t3tools/contracts";
import type { AtomRegistry } from "effect/reactivity";

import { previewBridge } from "~/components/preview/previewBridge";
import { clearBrowserProfileData } from "~/components/settings/IntegrationsSettings";
import { environmentCatalog } from "~/connection/catalog";
import { persistClientSettingsUpdate } from "~/hooks/useSettings";
import { forgetBrowserProfile } from "~/scient/browser/useForgetBrowserProfile";
import { environmentPresentations } from "~/state/presentation";
import { previewEnvironment } from "~/state/preview";

import { accountsState } from "./accountsState";

const environmentIdsOf = (registry: AtomRegistry.AtomRegistry) => [
  ...registry.get(environmentPresentations.presentationsAtom).keys(),
];

/** A profile's cookies and cache go in every environment: this desktop's jars and each server's browser. */
export async function clearProfileData(registry: AtomRegistry.AtomRegistry, profileId: string) {
  const environmentIds = environmentIdsOf(registry);
  if (!registry.get(environmentCatalog.catalogValueAtom).isReady || environmentIds.length === 0)
    throw new Error("Browser data unavailable");
  const configs = registry.get(environmentPresentations.serverConfigsAtom);
  await clearBrowserProfileData(previewBridge, environmentIds, profileId, {
    environmentIds: environmentIds.filter(
      (environmentId) => configs.get(environmentId)?.environment.capabilities.serverBrowser,
    ),
    clear: async (environmentId, profileId) => {
      const result = await previewEnvironment.clearProfile.run(registry, {
        environmentId,
        input: { profileId },
      });
      if (result._tag !== "Success") throw new Error("Browser data unavailable");
    },
  });
}

/**
 * Remove and sign out: the profile's cookies everywhere, its record, its place in the list and as
 * the new-tab default, its shortcuts and history. Throws when the cookies can't be cleared.
 */
export async function removeBrowserProfile(
  registry: AtomRegistry.AtomRegistry,
  environmentId: EnvironmentId,
  profileId: string,
): Promise<AtomCommandResult<unknown, unknown>> {
  await clearProfileData(registry, profileId);
  const result = await accountsState.removeProfile.run(registry, {
    environmentId,
    input: { profileId: BrowserProfileId.make(profileId) },
  });
  if (result._tag !== "Success") return result;
  await persistClientSettingsUpdate((current) => ({
    ...current,
    browserProfiles: current.browserProfiles.filter((item) => item.id !== profileId),
    ...(current.browserDefaultProfileId === profileId
      ? { browserDefaultProfileId: DEFAULT_BROWSER_PROFILE_ID }
      : {}),
  }));
  forgetBrowserProfile(registry, environmentIdsOf(registry), profileId);
  return result;
}
