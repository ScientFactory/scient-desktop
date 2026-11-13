import type { EnvironmentId, ScientCloudStatus } from "@t3tools/contracts";
import { useEffect, useState } from "react";

import { readCloudStatus } from "./serverCloud";
import { scientCloudLive } from "./useCloudAccount";

const REFRESH_MS = 60_000;

/**
 * A computer's cloud copy status, read when shown and once a minute after. Null until read, and
 * when the computer can't say (not connected, or a server without Scient Cloud).
 */
export function useCloudStatus(environmentId: EnvironmentId | null) {
  const [state, setState] = useState<{
    readonly environmentId: EnvironmentId | null;
    readonly status: ScientCloudStatus | null;
  }>({ environmentId, status: null });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- polls the computer's server for its cloud copy status
  useEffect(() => {
    // Without Scient Cloud there is nothing to show, so the computer isn't asked.
    if (environmentId === null || !scientCloudLive()) return;
    let cancelled = false;
    const read = () =>
      readCloudStatus(environmentId).then(
        (status) => {
          if (!cancelled) setState({ environmentId, status });
        },
        () => {
          if (!cancelled) setState({ environmentId, status: null });
        },
      );
    void read();
    const timer = setInterval(read, REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [environmentId]);

  return {
    status: state.environmentId === environmentId ? state.status : null,
    /** Shows the status an action returned. */
    replace: (status: ScientCloudStatus) => {
      setState({ environmentId, status });
    },
  };
}
