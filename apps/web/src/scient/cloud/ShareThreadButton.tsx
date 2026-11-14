import { useAtomValue } from "@effect/atom-react";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { ShareIcon } from "lucide-react";

import { canShareWithGuestAtom } from "~/components/chat/guestShareAvailability";
import { openGuestShareDialog } from "~/components/chat/guestShareDialogState";
import { Button } from "~/components/ui/button";
import { useQuietThreadProjection } from "~/state/entities";

import { openShareLinkDialog } from "./shareDialogState";
import { hasCloudAccount } from "./useCloudAccount";

/**
 * "Share" in the thread header. It opens one dialog: inviting people when this computer can host
 * them (publishing a copy is a link inside it), otherwise publishing a copy. A shared thread shows
 * its people instead.
 */
export function ShareThreadButton({ threadRef }: { threadRef: ScopedThreadRef }) {
  const canShareWithGuest = useAtomValue(canShareWithGuestAtom(threadRef.environmentId));
  const shared = (useQuietThreadProjection(threadRef)?.projection.thread.room ?? null) !== null;
  const canShareLink = hasCloudAccount();
  if (shared || (!canShareLink && !canShareWithGuest)) return null;
  return (
    <Button
      size="xs"
      variant="ghost"
      className="shrink-0"
      onClick={() =>
        canShareWithGuest ? openGuestShareDialog(threadRef) : openShareLinkDialog(threadRef)
      }
    >
      <ShareIcon aria-hidden />
      Share
    </Button>
  );
}
