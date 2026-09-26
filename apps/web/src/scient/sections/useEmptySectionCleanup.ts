import { useEffect, useMemo } from "react";

import { toastManager } from "../../components/ui/toast";
import { usePrimarySettings } from "../../hooks/useSettings";
import { useThreadSectionCatalog } from "./catalog";

const SWEEP_INTERVAL_MS = 5 * 60 * 1000;
// Threads load shortly after an environment connects; judge emptiness only then.
const CONNECTED_GRACE_MS = 60 * 1000;

/**
 * Optional cleanup (Settings → General → Organization): deletes sections that
 * have held no sidebar threads for the configured number of days. It runs only
 * while every environment is connected, so a section is never judged empty
 * because some of its threads could not be seen. Removals can be undone.
 */
export function useEmptySectionCleanup(input: {
  readonly threads: ReadonlyArray<{
    readonly sectionId?: string | null | undefined;
    readonly archivedAt: string | null;
  }>;
  readonly allEnvironmentsConnected: boolean;
}): void {
  const { available, restoreAll, sweepEmpty } = useThreadSectionCatalog();
  const afterDays = usePrimarySettings((settings) => settings.threadSectionsDeleteEmptyAfterDays);
  // A stable key, so ordinary thread activity doesn't restart the timers.
  const occupiedKey = useMemo(
    () =>
      [
        ...new Set(
          input.threads.flatMap((thread) =>
            thread.archivedAt === null && thread.sectionId != null ? [thread.sectionId] : [],
          ),
        ),
      ]
        .toSorted()
        .join("\n"),
    [input.threads],
  );

  useEffect(() => {
    if (afterDays === null || !available || !input.allEnvironmentsConnected) return;
    const occupied = new Set(occupiedKey.length > 0 ? occupiedKey.split("\n") : []);
    const sweep = async () => {
      const removed = await sweepEmpty(occupied, afterDays);
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
    const first = setTimeout(() => void sweep(), CONNECTED_GRACE_MS);
    const interval = setInterval(() => void sweep(), SWEEP_INTERVAL_MS);
    return () => {
      clearTimeout(first);
      clearInterval(interval);
    };
  }, [afterDays, available, input.allEnvironmentsConnected, occupiedKey, restoreAll, sweepEmpty]);
}
