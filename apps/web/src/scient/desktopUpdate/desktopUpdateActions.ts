import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import type { DesktopBridge } from "@t3tools/contracts";
import { msg } from "gt-react";

import {
  getDesktopUpdateActionError,
  shouldToastDesktopUpdateActionResult,
} from "~/components/desktopUpdate.logic";
import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { m } from "~/i18n/messages";

/** Checks for an app update as the sidebar pill does, toasting why a check could not run. */
export async function checkForDesktopUpdate(
  bridge: Pick<DesktopBridge, "checkForUpdate">,
  updatesDenial: string | undefined,
): Promise<void> {
  const title = m(msg("Could not check for updates"));
  const toastError = (description: string) =>
    toastManager.add(stackedThreadToast({ type: "error", title, description }));
  try {
    const result = await bridge.checkForUpdate();
    if (result.checked) return;
    toastError(
      updatesDenial ??
        result.state.message ??
        m(msg("Automatic updates are not available in this build.")),
    );
  } catch (error) {
    toastError(thrownErrorMessage(error, m) ?? m(msg("Update check failed.")));
  }
}

/**
 * Downloads the available app update as the sidebar pill's download does, toasting a failure.
 * Its own copy, so a provider view does not load the sidebar pill.
 */
export async function downloadLocalUpdate(
  bridge: Pick<DesktopBridge, "downloadUpdate">,
): Promise<boolean> {
  const toastError = (title: string, description: string) =>
    toastManager.add(stackedThreadToast({ type: "error", title, description }));
  try {
    const result = await bridge.downloadUpdate();
    const actionError = shouldToastDesktopUpdateActionResult(result)
      ? getDesktopUpdateActionError(result)
      : null;
    if (actionError) toastError(m(msg("Could not download update")), actionError);
    return result.completed;
  } catch (error) {
    toastError(
      m(msg("Could not start update download")),
      thrownErrorMessage(error, m) ?? m(msg("An unexpected error occurred.")),
    );
    return false;
  }
}
