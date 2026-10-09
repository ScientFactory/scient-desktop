import { useAtomValue } from "@effect/atom-react";
import { useEffect, useRef } from "react";

import { primaryServerLegacyThreadMigrationAtom } from "../state/server";
import { toastManager } from "./ui/toast";

type MigrationToastId = ReturnType<typeof toastManager.add>;

export function LegacyThreadMigrationToast() {
  const migration = useAtomValue(primaryServerLegacyThreadMigrationAtom);
  const status = migration?.status;
  const totalThreadCount = migration?.totalThreadCount ?? 0;
  const pendingThreadCount = migration?.pendingThreadCount;
  const toastIdRef = useRef<MigrationToastId | null>(null);

  useEffect(() => {
    if (toastIdRef.current !== null) {
      toastManager.close(toastIdRef.current);
      toastIdRef.current = null;
    }
    if (status === "running") {
      toastIdRef.current = toastManager.add({
        type: "loading",
        title: "Restoring your threads…",
        description: `Migrating ${totalThreadCount.toLocaleString()} ${
          totalThreadCount === 1 ? "thread" : "threads"
        } from the previous version. You can keep working while this finishes.`,
        timeout: 0,
      });
      return;
    }
    if (status === "failed") {
      toastIdRef.current = toastManager.add({
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
    }
  }, [status, totalThreadCount, pendingThreadCount]);

  useEffect(
    () => () => {
      if (toastIdRef.current !== null) {
        toastManager.close(toastIdRef.current);
      }
    },
    [],
  );

  return null;
}
