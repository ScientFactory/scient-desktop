import { useEffect } from "react";

import { useStableCallback } from "~/hooks/useStableCallback";
import { isLocalEnvironmentDisabled } from "~/localEnvironment";
import { computeEnvironment } from "~/state/compute";
import { usePrimaryEnvironmentId } from "~/state/environments";
import { useAtomQueryRunner } from "~/state/use-atom-query-runner";

const REPORT_EVERY_MS = 3000;

/** Keeps the desktop app told how many runs quitting would stop, so Quit can ask first. */
export function ComputeQuitGuardReport() {
  // Quit stops this computer's work only. Another computer's server may also predate this request.
  return window.desktopBridge?.setRunningWork && !isLocalEnvironmentDisabled() ? (
    <RunningWorkReport />
  ) : null;
}

function RunningWorkReport() {
  const environmentId = usePrimaryEnvironmentId();
  const readActiveWork = useAtomQueryRunner(computeEnvironment.activeWork, {
    reportFailure: false,
    reportDefect: false,
    refresh: true,
  });
  const report = useStableCallback(async () => {
    if (environmentId === null) return;
    const work = await readActiveWork({ environmentId, input: {} });
    if (work._tag === "Success") void window.desktopBridge?.setRunningWork?.(work.value.count);
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- mirrors the server's running work to the desktop main process, which owns Quit
  useEffect(() => {
    const timer = setInterval(() => void report(), REPORT_EVERY_MS);
    return () => clearInterval(timer);
  }, [report]);
  return null;
}
