import { msg } from "gt-react";

import { m } from "../i18n/messages";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { primaryServerLegacyThreadMigrationAtom } from "../state/server";
import { toastManager } from "./ui/toast";

type MigrationToastId = ReturnType<typeof toastManager.add>;

/** Keeps restoration progress or failure visible until the server reports completion. */
export function startLegacyThreadMigrationToast(): () => void {
  let toastId: MigrationToastId | null = null;
  let previous: string | null = null;

  const unsubscribe = appAtomRegistry.subscribe(
    primaryServerLegacyThreadMigrationAtom,
    (migration) => {
      // SCIENT-FORK:START — a failed verification is not a completed restoration.
      const status = migration?.failed === true ? "failed" : migration?.status;
      const totalThreadCount = migration?.totalThreadCount ?? 0;
      const pendingThreadCount = migration?.pendingThreadCount;
      const signature = JSON.stringify([status, totalThreadCount, pendingThreadCount]);
      if (signature === previous) return;
      previous = signature;
      if (toastId !== null) {
        toastManager.close(toastId);
        toastId = null;
      }
      if (status === "failed") {
        toastId = toastManager.add({
          type: "error",
          title: m(msg("Thread restoration needs attention")),
          description:
            pendingThreadCount === undefined
              ? m(
                  msg(
                    "Restoration could not be verified. Your original data is preserved. Restart Scient to retry.",
                  ),
                )
              : m(
                  msg(
                    "{count, plural, one {{total} thread still needs restoration. Original data is preserved. Reopen to retry. Repeated failures need review.} other {{total} threads still need restoration. Original data is preserved. Reopen to retry. Repeated failures need review.}}",
                    {
                      count: pendingThreadCount,
                      total: pendingThreadCount.toLocaleString(),
                    },
                  ),
                ),
          timeout: 0,
        });
        return;
      }
      // SCIENT-FORK:END
      if (status === "running") {
        toastId = toastManager.add({
          type: "loading",
          title: m(msg("Restoring your threads…")),
          description: m(
            msg(
              "{count, plural, one {Migrating {total} thread from the previous version. You can keep working while this finishes.} other {Migrating {total} threads from the previous version. You can keep working while this finishes.}}",
              {
                count: totalThreadCount,
                total: totalThreadCount.toLocaleString(),
              },
            ),
          ),
          timeout: 0,
        });
      }
    },
    { immediate: true },
  );

  return () => {
    unsubscribe();
    if (toastId !== null) toastManager.close(toastId);
  };
}
