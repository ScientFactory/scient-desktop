import type { EnvironmentServerConfig } from "@t3tools/client-runtime/connection";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { EnvironmentCatalogState } from "@t3tools/client-runtime/state/connections";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { effectiveSnoozed } from "@t3tools/client-runtime/state/thread-settled";
import type { EnvironmentId } from "@t3tools/contracts";

import {
  filterSidebarV2VisibleThreads,
  hasUnseenCompletion,
  resolveSidebarThreadSection,
  resolveThreadLastVisitedAt,
} from "../../components/Sidebar.logic";

/**
 * The threads whose sidebar row shows the unread dot outside the snoozed and settled shelves, in
 * any project. It uses the sidebar's own roster (no archived or subagent threads), visit
 * resolution (the server's when it tracks visits), and shelf rules, so reading a thread in the
 * sidebar is what lowers the count.
 */
export function countUnreadConversations(input: {
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly localVisits: Readonly<Record<string, string>>;
  readonly serverConfigs: ReadonlyMap<EnvironmentId, EnvironmentServerConfig>;
  readonly now: string;
}): number {
  let count = 0;
  for (const thread of filterSidebarV2VisibleThreads(input.threads, null)) {
    const capabilities = input.serverConfigs.get(thread.environmentId)?.environment.capabilities;
    const section = resolveSidebarThreadSection({
      snoozed: capabilities?.threadSnooze === true && effectiveSnoozed(thread, { now: input.now }),
      settled: capabilities?.threadSettlement === true && thread.settledOverride === "settled",
      pinned: thread.pinnedAt != null,
    });
    if (section === "snoozed" || section === "settled") continue;
    const key = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
    const lastVisitedAt = resolveThreadLastVisitedAt(thread.lastVisitedAt, input.localVisits[key]);
    if (hasUnseenCompletion({ ...thread, lastVisitedAt })) count += 1;
  }
  return count;
}

/**
 * Whether the catalog lists every environment. It is ready with the saved ones; discovery then adds
 * this machine's own, unless the local environment is turned off.
 */
export function environmentCatalogComplete(
  catalog: EnvironmentCatalogState,
  localEnvironmentDisabled: boolean,
): boolean {
  return (
    catalog.isReady &&
    (localEnvironmentDisabled ||
      [...catalog.entries.values()].some(
        (entry) => entry.target._tag === "PrimaryConnectionTarget",
      ))
  );
}
