import type { EnvironmentServerConfig } from "@t3tools/client-runtime/connection";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { effectiveSnoozed } from "@t3tools/client-runtime/state/thread-settled";
import { sortActiveThreadsByOrderKey } from "@t3tools/client-runtime/state/thread-sort";
import type { EnvironmentId } from "@t3tools/contracts";

import { filterSidebarV2VisibleThreads } from "../../components/Sidebar.logic";

export function automaticPlacementThreads(
  threads: readonly EnvironmentThreadShell[],
  serverConfigs: ReadonlyMap<EnvironmentId, EnvironmentServerConfig>,
  now: string,
) {
  return sortActiveThreadsByOrderKey(
    filterSidebarV2VisibleThreads(threads, null).filter((thread) => {
      const capabilities = serverConfigs.get(thread.environmentId)?.environment.capabilities;
      return (
        thread.pinnedAt == null &&
        !(capabilities?.threadSettlement && thread.settledOverride === "settled") &&
        !(capabilities?.threadSnooze && effectiveSnoozed(thread, { now }))
      );
    }),
  );
}
