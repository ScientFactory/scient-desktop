import type { DesktopBridge } from "@t3tools/contracts";

/** How long after an update restart's readiness its workspace is observed again. */
export const RESTART_SETTLE_MS = 1_000;

export interface WorkspaceInteraction {
  readonly projectControlsVisible: boolean;
  readonly composerUsable: boolean;
  readonly windowUnlocked: boolean;
}

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

/** Marks the restored project's own control (its chat-header breadcrumb) with the project id. */
const PROJECT_CONTROL_ATTRIBUTE = "data-workspace-project-id";
const COMPOSER_SELECTOR = '[data-testid="composer-editor"]';

// Reachable by the user: not inert or disabled, shown, and on top where a click would land.
function reachable(element: Element): boolean {
  if (element.closest('[inert], [aria-disabled="true"]') !== null) return false;
  if (element.matches(":disabled")) return false;
  if (!element.checkVisibility({ opacityProperty: true, visibilityProperty: true })) return false;
  const box = element.getBoundingClientRect();
  const hit = element.ownerDocument.elementFromPoint(
    box.left + box.width / 2,
    box.top + box.height / 2,
  );
  return hit !== null && element.contains(hit);
}

/** Whether the user can reach the restored project and its composer; reports booleans only. */
export function observeWorkspaceInteraction(
  document: Document,
  projectId: string | null,
): WorkspaceInteraction {
  return {
    projectControlsVisible:
      projectId !== null &&
      [...document.querySelectorAll(`[${PROJECT_CONTROL_ATTRIBUTE}]`)].some(
        (element) =>
          element.getAttribute(PROJECT_CONTROL_ATTRIBUTE) === projectId && reachable(element),
      ),
    composerUsable: [...document.querySelectorAll(COMPOSER_SELECTOR)].some(
      (element) =>
        element instanceof HTMLElement &&
        element.isContentEditable &&
        element.getAttribute("aria-readonly") !== "true" &&
        reachable(element),
    ),
    windowUnlocked: !document.body.inert,
  };
}

/**
 * Tells the desktop a workspace is ready. The first report in this renderer ends startup timing;
 * only a restored workspace (not `startupOnly`, like Getting Started) may fetch and spend the
 * update restart's token, so that restart still ends where its workspace comes back. A restart it
 * completes is observed again after `settle`, so a lock that appears just after readiness shows.
 */
export async function reportDesktopWorkspaceReady(input: {
  readonly bridge: Pick<
    DesktopBridge,
    "getRestartReadinessToken" | "reportWorkspaceReady" | "reportWorkspaceSettled"
  >;
  readonly startupOnly: boolean;
  readonly projectRestored: boolean;
  /** Shared by every report in this renderer. */
  readonly startup: { reported: boolean };
  readonly isCurrent: () => boolean;
  readonly observe: () => WorkspaceInteraction;
  readonly settle: () => Promise<void>;
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
  // Only an update restart's own workspace is observed; ordinary startup timing skips the scan.
  const completed = await bridge.reportWorkspaceReady({
    projectRestored: input.projectRestored,
    ...(token === null ? {} : { ...token, interaction: input.observe() }),
  });
  if (!completed || token === null || !bridge.reportWorkspaceSettled) return;
  await input.settle();
  await bridge.reportWorkspaceSettled({ ...token, interaction: input.observe() });
}
