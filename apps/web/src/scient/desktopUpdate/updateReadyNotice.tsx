import type { DesktopBridge, DesktopUpdateState } from "@t3tools/contracts";
import { ArrowRightIcon } from "lucide-react";

import {
  getDesktopUpdateActionError,
  getDesktopUpdateDownloadedVersion,
  getDesktopUpdateReleaseUrl,
} from "~/components/desktopUpdate.logic";
import { openDesktopUpdateReleaseNotes } from "~/components/desktopUpdate.toast";
import { anchoredToastManager, stackedThreadToast, toastManager } from "~/components/ui/toast";
import { isWindowsPlatform } from "~/lib/utils";

/**
 * How long the "update ready" notice stays up before it steps aside for the
 * footer's Restart button. Hover and window blur pause it (Base UI toast timers).
 */
export const SCIENT_UPDATE_READY_NOTICE_TIMEOUT_MS = 5_000;

type UpdateInstallShell = Pick<DesktopBridge, "installUpdate">;
type UpdateNoticeShell = Pick<DesktopBridge, "installUpdate" | "openExternal">;

export interface ScientUpdateReadyNoticeHandle {
  readonly close: () => void;
}

const WINDOWS_INSTALL_NOTE =
  "Scient may stay closed for a few minutes while the update installs, then reopens.";

function isWindowsHost(): boolean {
  return typeof navigator !== "undefined" && isWindowsPlatform(navigator.platform);
}

/**
 * Restarts into the downloaded update. Restarting is the user's explicit
 * action, so there is no confirmation step; failures surface as a toast and
 * leave the footer's Retry state to the updater.
 */
export async function installDesktopUpdateNow(shell: UpdateInstallShell): Promise<void> {
  try {
    const result = await shell.installUpdate();
    const actionError = getDesktopUpdateActionError(result);
    if (!actionError) return;
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: "Could not install update",
        description: actionError,
      }),
    );
  } catch (error) {
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: "Could not install update",
        description: error instanceof Error ? error.message : "An unexpected error occurred.",
      }),
    );
  }
}

/**
 * The notice anchors to the update button only when that button is actually on
 * screen: the offcanvas sidebar keeps its footer in the DOM while sliding it
 * out of view, so presence alone is not enough.
 */
export function isUpdateNoticeAnchorVisible(anchor: Element | null): anchor is Element {
  if (anchor === null || !anchor.isConnected) return false;
  const rect = anchor.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return false;
  return (
    rect.right > 0 &&
    rect.bottom > 0 &&
    rect.left < window.innerWidth &&
    rect.top < window.innerHeight
  );
}

function ReleaseNotesLink({ shell, releaseUrl }: { shell: UpdateNoticeShell; releaseUrl: string }) {
  return (
    <button
      className="inline cursor-pointer text-muted-foreground underline decoration-dotted underline-offset-4 transition-colors hover:text-foreground"
      onClick={() => {
        void openDesktopUpdateReleaseNotes(shell, releaseUrl);
      }}
      type="button"
    >
      Read more
      <ArrowRightIcon
        aria-hidden
        className="ml-1 inline size-3 -rotate-45 align-[-0.125em]"
        strokeWidth={2.25}
      />
    </button>
  );
}

/**
 * Announces a finished download with a direct Restart action. Shown next to the
 * update button when it is visible, otherwise in the corner stack. After the
 * timeout (or when dismissed) the footer's Restart button remains the way in.
 */
export function showScientUpdateReadyNotice({
  shell,
  state,
  anchor,
}: {
  readonly shell: UpdateNoticeShell;
  readonly state: DesktopUpdateState;
  readonly anchor: Element | null;
}): ScientUpdateReadyNoticeHandle {
  const version = getDesktopUpdateDownloadedVersion(state);
  const releaseUrl = getDesktopUpdateReleaseUrl(version);
  const windowsNote = isWindowsHost() ? WINDOWS_INSTALL_NOTE : null;
  const description =
    windowsNote || releaseUrl ? (
      <>
        {windowsNote}
        {windowsNote && releaseUrl ? " " : null}
        {releaseUrl ? <ReleaseNotesLink releaseUrl={releaseUrl} shell={shell} /> : null}
      </>
    ) : undefined;

  const anchored = isUpdateNoticeAnchorVisible(anchor);
  const manager = anchored ? anchoredToastManager : toastManager;
  let toastId: string | null = null;
  const close = () => {
    if (toastId !== null) manager.close(toastId);
  };

  const notice = stackedThreadToast({
    type: "success",
    title: version ? `Update ${version} is ready` : "Update is ready",
    ...(description !== undefined ? { description } : {}),
    timeout: SCIENT_UPDATE_READY_NOTICE_TIMEOUT_MS,
    actionProps: {
      children: "Restart now",
      onClick: () => {
        close();
        void installDesktopUpdateNow(shell);
      },
    },
  });

  toastId = manager.add(
    anchored ? { ...notice, positionerProps: { anchor, side: "top", sideOffset: 8 } } : notice,
  );
  return { close };
}
