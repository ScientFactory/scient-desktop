import type { EnvironmentId } from "@t3tools/contracts";
import { useRouterState } from "@tanstack/react-router";
import { useEffect } from "react";
import { useClientSettingsHydrated } from "../../hooks/useSettings";
import { usePrimaryEnvironment } from "../../state/environments";
import { useEnvironmentShellStatus } from "../../state/shell";
import { workspaceReadiness } from "./workspaceReadiness";

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

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- acknowledges a committed, connected and hydrated local workspace to the native restart owner
  useEffect(() => {
    if (!ready || !bridge?.getRestartReadinessToken || !bridge.reportWorkspaceReady) return;
    let current = true;
    void bridge
      .getRestartReadinessToken()
      .then(async (token) => {
        if (!current || token === null) return;
        await bridge.reportWorkspaceReady?.({ ...token, projectRestored: props.projectRestored });
      })
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, [bridge, ready, props.projectRestored]);
  return null;
}
