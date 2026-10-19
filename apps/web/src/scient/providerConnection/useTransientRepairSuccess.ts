import { useStableCallback } from "../../hooks/useStableCallback";
import type { ProviderManagedRuntimeAction } from "@t3tools/contracts";
import { useEffect, useRef, useState } from "react";

export const REPAIR_SUCCESS_NOTICE_MS = 4_000;

export function useTransientRepairSuccess(open: boolean) {
  const [visible, setVisible] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancelTimer = useStableCallback(() => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    timeoutRef.current = null;
  });

  const clear = useStableCallback(() => {
    cancelTimer();
    setVisible(false);
  });

  const reportRuntimeActionSucceeded = (action: ProviderManagedRuntimeAction) => {
    if (action !== "repair") return;
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    setVisible(true);
    timeoutRef.current = setTimeout(() => {
      setVisible(false);
      timeoutRef.current = null;
    }, REPAIR_SUCCESS_NOTICE_MS);
  };

  useEffect(() => cancelTimer, [cancelTimer]);

  useEffect(() => {
    if (!open) clear();
  }, [clear, open]);

  return { repairSucceededRecently: visible, reportRuntimeActionSucceeded } as const;
}
