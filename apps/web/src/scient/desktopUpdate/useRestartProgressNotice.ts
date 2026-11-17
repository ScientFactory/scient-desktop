import type { DesktopUpdateState } from "@t3tools/contracts";
import { useEffect, useRef, useState } from "react";

import { getDesktopUpdateButtonTooltip } from "~/components/desktopUpdate.logic";
import { toastManager } from "~/components/ui/toast";

import {
  isUpdateNoticeAnchorVisible,
  type ReportDesktopInstallError,
  toastInstallFailure,
} from "./updateReadyNotice";

/** How long the reason a restart did not happen stays beside the update control. */
export const RESTART_FAILURE_NOTICE_MS = 8_000;

export interface RestartProgressNotice {
  /** The update control's tooltip shows this notice without hover; it hides with an off-screen control. */
  readonly open: boolean;
  readonly title: string | null;
  readonly description: string | null;
  /** Install failures from this control: shown beside it when it is on screen, else a toast. */
  readonly reportFailure: ReportDesktopInstallError;
}

/**
 * After Restart now, preparation can take a while with nothing else changing on screen. Its
 * progress, then any reason the restart did not happen, stays open beside the update control
 * without hover. When the control is off screen (the sidebar is closed), progress is one corner
 * toast instead, and a failure is the usual error toast.
 */
export function useRestartProgressNotice(
  state: DesktopUpdateState | null,
  anchorId: string,
): RestartProgressNotice {
  const progress = state?.status === "preparing" ? getDesktopUpdateButtonTooltip(state) : null;
  const preparing = progress !== null;
  const [failure, setFailure] = useState<{ title: string; description: string } | null>(null);
  // A new attempt replaces the reason the last one stopped.
  if (preparing && failure !== null) setFailure(null);
  const mode = preparing ? "progress" : failure !== null ? "failure" : null;
  // Whether the control is on screen; the sidebar can close or open while a notice shows.
  const [anchorVisible, setAnchorVisible] = useState(true);
  // With no notice there is nothing to place; the next one starts by assuming the control shows.
  if (mode === null && !anchorVisible) setAnchorVisible(true);
  const mounted = useRef(false);
  const progressToast = useRef<string | null>(null);
  const shownFailure = useRef(failure);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- tracks whether this control can still show a failure; an unmounted one hands it to a toast
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (progressToast.current !== null) toastManager.close(progressToast.current);
      progressToast.current = null;
    };
  }, []);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- keeps the failure the observer below may hand to a toast current
  useEffect(() => {
    shownFailure.current = failure;
  }, [failure]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- follows whether the control is on screen, which only the DOM knows
  useEffect(() => {
    const anchor = mode === null ? null : document.getElementById(anchorId);
    if (anchor === null || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((entries) => {
      const visible = entries.at(-1)?.isIntersecting ?? true;
      const reason = shownFailure.current;
      if (!visible && mode === "failure" && reason !== null) {
        // The reason moves to the corner rather than staying hidden with the control.
        toastInstallFailure(reason.title, reason.description);
        setFailure(null);
        return;
      }
      setAnchorVisible(visible);
    });
    observer.observe(anchor);
    return () => observer.disconnect();
  }, [mode, anchorId]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- mirrors progress into one corner toast while the control is off screen
  useEffect(() => {
    if (progress === null || anchorVisible) {
      if (progressToast.current !== null) toastManager.close(progressToast.current);
      progressToast.current = null;
      return;
    }
    if (progressToast.current === null) {
      progressToast.current = toastManager.add({ type: "loading", title: progress, timeout: 0 });
    } else {
      toastManager.update(progressToast.current, { title: progress });
    }
  }, [progress, anchorVisible]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a failure's reason steps aside after a while; hover still shows the state's message
  useEffect(() => {
    if (failure === null) return;
    const timer = window.setTimeout(() => setFailure(null), RESTART_FAILURE_NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, [failure]);

  const reportFailure: ReportDesktopInstallError = (title, description) => {
    if (mounted.current && isUpdateNoticeAnchorVisible(document.getElementById(anchorId))) {
      setFailure({ title, description });
      return;
    }
    toastInstallFailure(title, description);
  };

  if (progress !== null) {
    // Held open even off screen (CSS hides it there): reopening would remount the observed trigger.
    return { open: true, title: null, description: progress, reportFailure };
  }
  return {
    open: failure !== null,
    title: failure?.title ?? null,
    description: failure?.description ?? null,
    reportFailure,
  };
}
