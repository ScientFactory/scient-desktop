import { BrowserProfileId, type EnvironmentId, type ScopedThreadRef } from "@t3tools/contracts";

import { openUrlInPreview } from "~/browser/openFileInPreview";
import { toastManager } from "~/components/ui/toast";
import { useRightPanelStore } from "~/rightPanelStore";
import { previewEnvironment } from "~/state/preview";
import { useAtomCommand } from "~/state/use-atom-command";
import { useScratchThread } from "./useScratchThread";

/** Opens a site in a Scient browser tab, beside a conversation or in a new one. */
export function useAccountBrowser(environmentId: EnvironmentId) {
  const scratchThread = useScratchThread(environmentId);
  const openPreview = useAtomCommand(previewEnvironment.open, { reportFailure: false });

  return async (
    url: string,
    profileId?: string,
    /** Opens beside this conversation, for a sign-in in the middle of its work. */
    conversation?: ScopedThreadRef,
  ) => {
    const threadRef = conversation ?? (await scratchThread());
    if (!threadRef) return false;
    if (!conversation) useRightPanelStore.getState().requestMaximize(threadRef);
    const result = await openUrlInPreview({
      threadRef,
      url: /^https?:\/\//.test(url) ? url : `https://${url}`,
      openPreview,
      ...(profileId === undefined ? {} : { profileId: BrowserProfileId.make(profileId) }),
    });
    if (result._tag === "Failure") {
      toastManager.add({ type: "error", title: "Could not open the site" });
      return false;
    }
    return true;
  };
}
