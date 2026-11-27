import type { EnvironmentId } from "@t3tools/contracts";
import { useRouterState } from "@tanstack/react-router";
import { useEffect } from "react";
import { useClientSettingsHydrated } from "../../hooks/useSettings";
import { usePrimaryEnvironment } from "../../state/environments";
import { useEnvironmentShellStatus } from "../../state/shell";
import {
  observeWorkspaceInteraction,
  reportDesktopWorkspaceReady,
  RESTART_SETTLE_MS,
  workspaceReadiness,
} from "./workspaceReadiness";

const startup = { reported: false };

export function DesktopWorkspaceReadiness(props: {
  readonly environmentId: EnvironmentId | null;
  readonly initialized: boolean;
  readonly projectRestored: boolean;
  /** The restored project, whose own control must be reachable. */
  readonly projectId?: string | null;
  /** Ends startup timing only; an update restart ends where its workspace is restored. */
  readonly startupOnly?: boolean;
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
  const startupOnly = props.startupOnly === true;
  const projectId = props.projectId ?? null;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- acknowledges a committed, connected and hydrated local workspace to the native startup and restart owners
  useEffect(() => {
    if (!ready || !bridge) return;
    let current = true;
    void reportDesktopWorkspaceReady({
      bridge,
      startupOnly,
      projectRestored: props.projectRestored,
      startup,
      isCurrent: () => current,
      observe: () => observeWorkspaceInteraction(document, projectId),
      settle: () => new Promise((resolve) => setTimeout(resolve, RESTART_SETTLE_MS)),
    }).catch(() => undefined);
    return () => {
      current = false;
    };
  }, [bridge, ready, startupOnly, props.projectRestored, projectId]);
  return null;
}
