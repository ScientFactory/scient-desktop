import { useAtomValue } from "@effect/atom-react";
import { useEffect, useMemo } from "react";

import { toastManager } from "../../components/ui/toast";
import { usePrimarySettings } from "../../hooks/useSettings";
import { allEnvironmentProjectSnapshotsReadyAtom } from "../../state/shell";
import { useThreadSectionCatalog } from "./catalog";
import type { SectionOccupancy } from "./logic";

const SWEEP_INTERVAL_MS = 5 * 60 * 1000;
// Debounce cleanup after the complete shell inventories become live.
const SYNCHRONIZED_GRACE_MS = 60 * 1000;

/**
 * Keeps the catalog's occupancy current and runs the optional cleanup
 * (Settings → General → Organization), which deletes sections that have held
 * no sidebar threads for the configured number of days.
 *
 * Occupancy is recorded as soon as membership changes: seeing a thread in a
 * section clears its empty stamp and records the thread's environment. That
 * runs whether or not cleanup is on, so turning it on later is safe. Judging
 * a section empty waits until every environment has a live shell snapshot for a
 * minute, and only covers sections whose recorded environments are all
 * visible here. Removals can be undone.
 */
export function useEmptySectionCleanup(input: {
  readonly threads: ReadonlyArray<{
    readonly environmentId: string;
    readonly sectionId?: string | null | undefined;
    readonly archivedAt: string | null;
  }>;
  /** Every environment this client knows, once all are connected; else null. */
  readonly connectedEnvironmentIds: ReadonlySet<string> | null;
}): void {
  const snapshotsReady = useAtomValue(allEnvironmentProjectSnapshotsReadyAtom);
  const { available, restoreAll, sweepEmpty } = useThreadSectionCatalog();
  const afterDays = usePrimarySettings((settings) => settings.threadSectionsDeleteEmptyAfterDays);
  // A stable key, so ordinary thread activity doesn't restart the timers.
  const occupancyKey = useMemo(
    () =>
      [
        ...new Set(
          input.threads.flatMap((thread) =>
            thread.archivedAt === null && thread.sectionId != null
              ? [`${thread.sectionId}\t${thread.environmentId}`]
              : [],
          ),
        ),
      ]
        .toSorted()
        .join("\n"),
    [input.threads],
  );
  const occupancy = useMemo((): SectionOccupancy => {
    const map = new Map<string, Set<string>>();
    for (const line of occupancyKey.length > 0 ? occupancyKey.split("\n") : []) {
      const [sectionId, environmentId] = line.split("\t") as [string, string];
      const environments = map.get(sectionId) ?? new Set<string>();
      environments.add(environmentId);
      map.set(sectionId, environments);
    }
    return map;
  }, [occupancyKey]);

  // Record what is visible now. Never stamps or removes, so it needs no grace.
  useEffect(() => {
    if (!available) return;
    void sweepEmpty({ occupancy, visibleEnvironmentIds: null, afterDays: afterDays ?? 1 });
  }, [afterDays, available, occupancy, sweepEmpty]);

  const visibleEnvironmentIds = snapshotsReady ? input.connectedEnvironmentIds : null;
  useEffect(() => {
    if (afterDays === null || !available || visibleEnvironmentIds === null) return;
    let current = true;
    const sweep = async () => {
      const removed = await sweepEmpty({
        occupancy,
        visibleEnvironmentIds,
        afterDays,
        // Rechecked inside the catalog queue and on conflict retries.
        isCurrent: () => current,
      });
      if (removed.length === 0) return;
      toastManager.add({
        type: "success",
        title:
          removed.length === 1
            ? `Removed empty section “${removed[0]!.section.name}”`
            : `Removed ${removed.length} empty sections`,
        actionProps: {
          children: "Undo",
          onClick: () => {
            void restoreAll(removed);
          },
        },
      });
    };
    const first = setTimeout(() => void sweep(), SYNCHRONIZED_GRACE_MS);
    const interval = setInterval(() => void sweep(), SWEEP_INTERVAL_MS);
    return () => {
      current = false;
      clearTimeout(first);
      clearInterval(interval);
    };
  }, [afterDays, available, occupancy, restoreAll, sweepEmpty, visibleEnvironmentIds]);
}
