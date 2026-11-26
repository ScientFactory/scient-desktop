import type { EnvironmentId } from "@t3tools/contracts";
import { useRouterState } from "@tanstack/react-router";
import { useEffect } from "react";
import { useClientSettingsHydrated } from "../../hooks/useSettings";
import { usePrimaryEnvironment } from "../../state/environments";
import { useEnvironmentShellStatus } from "../../state/shell";
import { workspaceReadiness } from "./workspaceReadiness";

let startupReported = false;

export function DesktopWorkspaceReadiness(props: {
  readonly environmentId: EnvironmentId | null;
  readonly initialized: boolean;
  readonly projectRestored: boolean;
}) {
  const primary = usePrimaryEnvironment();
  const shell = useEnvironmentShellStatus(primary?.environmentId ?? null);
  const settingsHydrated = useClientSettingsHydrated();
  const navigating = useRouterState({
    select: (state) => state.isLoading || state.isTransitioning,
  });
  const ready = workspaceReadiness({
    initialized: props.initialized,
    settingsHydrated,
    navigating,
    localEnvironment: primary !== null && primary.environmentId === props.environmentId,
    connected: primary?.connection.phase === "connected" && primary.serverConfig !== null,
    liveSnapshot: shell === "live",
  });
  const bridge = window.desktopBridge;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- acknowledges a committed, connected and hydrated local workspace to the native startup and restart owners
  useEffect(() => {
    if (!ready || !bridge?.getRestartReadinessToken || !bridge.reportWorkspaceReady) return;
    let current = true;
    void bridge
      .getRestartReadinessToken()
      .then(async (token) => {
        // Startup timing takes the first report; later ones matter only with a restart token.
        if (!current || (token === null && startupReported)) return;
        startupReported = true;
        await bridge.reportWorkspaceReady?.({ ...token, projectRestored: props.projectRestored });
      })
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, [bridge, ready, props.projectRestored]);
  return null;
}
