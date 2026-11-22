import type { DesktopBridge, DesktopUpdateState } from "@t3tools/contracts";
import { msg, T } from "gt-react";
import { ArrowRightIcon } from "lucide-react";

import {
  getDesktopUpdateActionError,
  getDesktopUpdateDownloadedVersion,
  getDesktopUpdateReleaseUrl,
} from "~/components/desktopUpdate.logic";
import { openDesktopUpdateReleaseNotes } from "~/components/desktopUpdate.toast";
import { anchoredToastManager, stackedThreadToast, toastManager } from "~/components/ui/toast";
import { m } from "~/i18n/messages";
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

const WINDOWS_INSTALL_NOTE = msg(
  "Scient may stay closed for a few minutes while the update installs, then reopens.",
);

function isWindowsHost(): boolean {
  return typeof navigator !== "undefined" && isWindowsPlatform(navigator.platform);
}

/** Where an install failure goes: a toast by default, or a bulk update's summary. */
export type ReportDesktopInstallError = (title: string, description: string) => void;

/** The default report: a corner toast. */
export const toastInstallFailure: ReportDesktopInstallError = (title, description) => {
  toastManager.add(stackedThreadToast({ type: "error", title, description }));
};

let installInFlight: Promise<boolean> | null = null;

/**
 * Restart is an explicit user action and needs no second confirmation. Share concurrent calls and
 * report failure through the first caller; only an accepted, error-free install means relaunching.
 * With `expectedVersion`, only that downloaded build installs, never one that replaced it.
 */
export function installDesktopUpdateNow(
  shell: UpdateInstallShell,
  reportError: ReportDesktopInstallError = toastInstallFailure,
  expectedVersion?: string | null,
): Promise<boolean> {
  installInFlight ??= runInstall(shell, reportError, expectedVersion ?? undefined).finally(() => {
    installInFlight = null;
  });
  return installInFlight;
}

async function runInstall(
  shell: UpdateInstallShell,
  reportError: ReportDesktopInstallError,
  expectedVersion: string | undefined,
): Promise<boolean> {
  const title = m(msg("Could not install update"));
  try {
    const result = await shell.installUpdate(expectedVersion);
    if (!result.accepted) {
      const replaced =
        expectedVersion !== undefined && result.state.downloadedVersion !== expectedVersion;
      reportError(
        title,
        replaced
          ? m(
              msg(
                "Update {version} is no longer the one ready to install. Use the update button again.",
                { version: expectedVersion },
              ),
            )
          : result.state.message?.trim() ||
              m(msg("Another update step is still running. Try again in a moment.")),
      );
      return false;
    }
    const actionError = getDesktopUpdateActionError(result);
    if (actionError) {
      reportError(title, actionError);
      return false;
    }
    return true;
  } catch (error) {
    reportError(
      title,
      error instanceof Error ? error.message : m(msg("An unexpected error occurred.")),
    );
    return false;
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
      <T>Read more</T>
      <ArrowRightIcon
        aria-hidden
        className="ml-1 inline size-3 -rotate-45 align-[-0.125em]"
        strokeWidth={2.25}
      />
    </button>
  );
}

/**
 * Announces a downloaded update with a direct Restart action. Shown next to the
 * update button when it is visible, otherwise in the corner stack. A finished
 * download's announcement times out; the card the Update button opens stays
 * until the user restarts or dismisses it.
 */
export function showScientUpdateReadyNotice({
  shell,
  state,
  anchor,
  install = (version) => installDesktopUpdateNow(shell, undefined, version),
  persistent = false,
  onClose,
}: {
  readonly shell: UpdateNoticeShell;
  readonly state: DesktopUpdateState;
  readonly anchor: Element | null;
  /** The caller's install, so its own pending state covers Restart now too. It receives the
   * version the card names, so Restart installs exactly that build. */
  readonly install?: (version: string | null) => Promise<unknown>;
  /** Opened by the user, so it waits for them instead of timing out. */
  readonly persistent?: boolean;
  readonly onClose?: () => void;
}): ScientUpdateReadyNoticeHandle {
  const version = getDesktopUpdateDownloadedVersion(state);
  const releaseUrl = getDesktopUpdateReleaseUrl(version);
  const windowsNote = isWindowsHost() ? m(WINDOWS_INSTALL_NOTE) : null;
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

  const notice = {
    ...stackedThreadToast({
      type: "success",
      title: version ? m(msg("Update {version} is ready", { version })) : m(msg("Update is ready")),
      ...(description !== undefined ? { description } : {}),
      timeout: persistent ? 0 : SCIENT_UPDATE_READY_NOTICE_TIMEOUT_MS,
      actionProps: {
        children: m(msg("Restart now")),
        onClick: () => {
          close();
          void install(version);
        },
      },
    }),
    ...(onClose !== undefined ? { onClose } : {}),
  };

  toastId = manager.add(
    anchored ? { ...notice, positionerProps: { anchor, side: "top", sideOffset: 8 } } : notice,
  );
  return { close };
}
