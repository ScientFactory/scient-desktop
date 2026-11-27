import type { DesktopBridge } from "@t3tools/contracts";

export function workspaceReadiness(input: {
  readonly initialized: boolean;
  readonly settingsHydrated: boolean;
  readonly navigating: boolean;
  readonly localEnvironment: boolean;
  readonly connected: boolean;
  readonly liveSnapshot: boolean;
}): boolean {
  return (
    input.initialized &&
    input.settingsHydrated &&
    !input.navigating &&
    input.localEnvironment &&
    input.connected &&
    input.liveSnapshot
  );
}

/**
 * Tells the desktop a workspace is ready. The first report in this renderer ends startup timing;
 * only a restored workspace (not `startupOnly`, like Getting Started) may fetch and spend the
 * update restart's token, so that restart still ends where its workspace comes back.
 */
export async function reportDesktopWorkspaceReady(input: {
  readonly bridge: Pick<DesktopBridge, "getRestartReadinessToken" | "reportWorkspaceReady">;
  readonly startupOnly: boolean;
  readonly projectRestored: boolean;
  /** Shared by every report in this renderer. */
  readonly startup: { reported: boolean };
  readonly isCurrent: () => boolean;
}): Promise<void> {
  const { bridge, startup } = input;
  if (!bridge.reportWorkspaceReady) return;
  if (input.startupOnly) {
    if (startup.reported) return;
    startup.reported = true;
    await bridge.reportWorkspaceReady({ projectRestored: input.projectRestored });
    return;
  }
  if (!bridge.getRestartReadinessToken) return;
  const token = await bridge.getRestartReadinessToken();
  if (!input.isCurrent() || (token === null && startup.reported)) return;
  startup.reported = true;
  await bridge.reportWorkspaceReady({ ...token, projectRestored: input.projectRestored });
}
