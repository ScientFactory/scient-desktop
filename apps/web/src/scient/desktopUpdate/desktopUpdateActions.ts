import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import type { DesktopBridge } from "@t3tools/contracts";
import { msg } from "gt-react";

import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { m } from "~/i18n/messages";

// The sidebar pill owns the download; provider recovery starts the same one.
export { downloadLocalUpdate } from "~/components/sidebar/SidebarUpdatePill";

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
