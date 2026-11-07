import type { EnvironmentId } from "@t3tools/contracts";
import { RegistryContext } from "@effect/atom-react";
import type { AtomRegistry } from "effect/reactivity";
import { useContext } from "react";

import { useEnvironments } from "~/state/environments";

import { browserHistoryState } from "./browserHistoryState";
import { useBrowserShortcuts } from "./browserShortcuts";

/**
 * Drops a removed profile's shortcuts and history. Its id is never used again, so history an offline
 * server misses can't reappear, and that server drops it after 90 days anyway.
 */
export function forgetBrowserProfile(
  registry: AtomRegistry.AtomRegistry,
  environmentIds: ReadonlyArray<EnvironmentId>,
  profileId: string,
) {
  useBrowserShortcuts.getState().forgetProfile(profileId);
  for (const environmentId of environmentIds)
    void browserHistoryState.clear
      .run(registry, { environmentId, input: { profileId } })
      .catch(() => undefined);
}

export function useForgetBrowserProfile() {
  const registry = useContext(RegistryContext);
  const { environments } = useEnvironments();
  return (profileId: string) =>
    forgetBrowserProfile(
      registry,
      environments.map(({ environmentId }) => environmentId),
      profileId,
    );
}
