import { useAtomValue } from "@effect/atom-react";
import { EnvironmentId } from "@t3tools/contracts";
import { useEffect, useMemo } from "react";

import { toastManager } from "../../components/ui/toast";
import { environmentServerConfigsAtom } from "../../state/server";
import { useThreadSectionCatalogs } from "./catalog";
import { loadedThreadEnvironmentsKeyAtom } from "./loadedEnvironments";
import type { SectionOccupancy } from "./logic";

const SWEEP_INTERVAL_MS = 5 * 60 * 1000;
// Debounce cleanup after an environment's complete thread list becomes live.
const SYNCHRONIZED_GRACE_MS = 60 * 1000;

const NO_OCCUPANCY: SectionOccupancy = new Map();

/**
 * Keeps each environment's catalog occupancy current and runs the optional
 * cleanup (Settings → General → Organization), which deletes sections that
 * have held no sidebar threads for the configured number of days. Each
 * environment has its own setting, and its sections are judged only by its
 * own threads, since no other environment's thread can be in them.
 *
 * Occupancy is recorded as soon as membership changes: seeing a thread in a
 * section clears its empty stamp. That runs whether or not cleanup is on, so
 * turning it on later is safe. Judging a section empty waits until this
 * client has held the environment's live thread list for a minute. Removals
 * can be undone.
 */
export function useEmptySectionCleanup(input: {
  readonly threads: ReadonlyArray<{
    readonly environmentId: string;
    readonly sectionId?: string | null | undefined;
    readonly archivedAt: string | null;
  }>;
}): void {
  const { catalogs, restoreAll, sweepEmpty } = useThreadSectionCatalogs();
  const configs = useAtomValue(environmentServerConfigsAtom);
  const loadedKey = useAtomValue(loadedThreadEnvironmentsKeyAtom);
  // Stable keys, so ordinary thread activity doesn't restart the timers.
  const environmentsKey = catalogs
    .map((catalog) => catalog.environmentId)
    .toSorted()
    .join("\n");
  const occupancyKey = useMemo(
    () =>
      [
        ...new Set(
          input.threads.flatMap((thread) =>
            thread.archivedAt === null && thread.sectionId != null
              ? [`${thread.environmentId}\t${thread.sectionId}`]
              : [],
          ),
        ),
      ]
        .toSorted()
        .join("\n"),
    [input.threads],
  );
  /** Environment → its catalog's occupancy. */
  const occupancyByEnvironment = useMemo(() => {
    const map = new Map<string, Map<string, Set<string>>>();
    for (const line of occupancyKey.length > 0 ? occupancyKey.split("\n") : []) {
      const [environmentId, sectionId] = line.split("\t") as [string, string];
      const occupancy = map.get(environmentId) ?? new Map<string, Set<string>>();
      occupancy.set(sectionId, new Set([environmentId]));
      map.set(environmentId, occupancy);
    }
    return map as ReadonlyMap<string, SectionOccupancy>;
  }, [occupancyKey]);
  /** Each environment's cleanup age in days, when it has cleanup on: `${id}\t${days}` lines. */
  const cleanupKey = (environmentsKey.length > 0 ? environmentsKey.split("\n") : [])
    .flatMap((environmentId) => {
      const days = configs.get(EnvironmentId.make(environmentId))?.settings
        .threadSectionsDeleteEmptyAfterDays;
      return days == null ? [] : [`${environmentId}\t${days}`];
    })
    .join("\n");

  // Record what is visible now. Never stamps or removes, so it needs no grace.
  useEffect(() => {
    for (const environmentId of environmentsKey.length > 0 ? environmentsKey.split("\n") : []) {
      void sweepEmpty(EnvironmentId.make(environmentId), {
        occupancy: occupancyByEnvironment.get(environmentId) ?? NO_OCCUPANCY,
        judge: false,
        afterDays: 1,
      });
    }
  }, [environmentsKey, occupancyByEnvironment, sweepEmpty]);

  useEffect(() => {
    const loaded = new Set(loadedKey.length > 0 ? loadedKey.split("\n") : []);
    const timers: ReturnType<typeof setTimeout>[] = [];
    let current = true;
    for (const line of cleanupKey.length > 0 ? cleanupKey.split("\n") : []) {
      const [id, days] = line.split("\t") as [string, string];
      // Only a client holding the environment's complete thread list judges its sections.
      if (!loaded.has(id)) continue;
      const environmentId = EnvironmentId.make(id);
      const sweep = async () => {
        const removed = await sweepEmpty(environmentId, {
          occupancy: occupancyByEnvironment.get(id) ?? NO_OCCUPANCY,
          judge: true,
          afterDays: Number(days),
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
              void restoreAll(environmentId, removed);
            },
          },
        });
      };
      timers.push(setTimeout(() => void sweep(), SYNCHRONIZED_GRACE_MS));
      timers.push(setInterval(() => void sweep(), SWEEP_INTERVAL_MS));
    }
    return () => {
      current = false;
      for (const timer of timers) {
        clearTimeout(timer);
        clearInterval(timer);
      }
    };
  }, [cleanupKey, loadedKey, occupancyByEnvironment, restoreAll, sweepEmpty]);
}
