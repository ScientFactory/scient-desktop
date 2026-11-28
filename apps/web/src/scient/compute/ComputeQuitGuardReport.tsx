import { useEffect } from "react";

import { isLocalEnvironmentDisabled } from "~/localEnvironment";
import { computeEnvironment } from "~/state/compute";
import { usePrimaryEnvironmentId } from "~/state/environments";
import { useEnvironmentQuery } from "~/state/query";

/** Keeps the desktop app told how many runs quitting would stop, so Quit can ask first. */
export function ComputeQuitGuardReport() {
  // Quit stops this computer's work only. Another computer's server may also predate this request.
  return window.desktopBridge?.setRunningWork && !isLocalEnvironmentDisabled() ? (
    <RunningWorkReport />
  ) : null;
}

function RunningWorkReport() {
  const environmentId = usePrimaryEnvironmentId();
  const work = useEnvironmentQuery(
    environmentId === null ? null : computeEnvironment.activeWork({ environmentId, input: {} }),
  );
  const count = work.data?.count;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- mirrors the server's running work to the desktop main process, which owns Quit
  useEffect(() => {
    if (count !== undefined) void window.desktopBridge?.setRunningWork?.(count);
  }, [count]);
  return null;
}
