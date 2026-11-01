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
          title: "Thread restoration needs attention",
          description:
            pendingThreadCount === undefined
              ? "Restoration could not be verified. Your original data is preserved. Restart Scient to retry."
              : `${pendingThreadCount.toLocaleString()} ${
                  pendingThreadCount === 1 ? "thread still needs" : "threads still need"
                } restoration. Original data is preserved. Reopen to retry. Repeated failures need review.`,
          timeout: 0,
        });
        return;
      }
      // SCIENT-FORK:END
      if (status === "running") {
        toastId = toastManager.add({
          type: "loading",
          title: "Restoring your threads…",
          description: `Migrating ${totalThreadCount.toLocaleString()} ${
            totalThreadCount === 1 ? "thread" : "threads"
          } from the previous version. You can keep working while this finishes.`,
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
