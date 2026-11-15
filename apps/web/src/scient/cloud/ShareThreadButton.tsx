import { useAtomValue } from "@effect/atom-react";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { ShareIcon } from "lucide-react";

import { canShareWithGuestAtom } from "~/components/chat/guestShareAvailability";
import { openGuestShareDialog } from "~/components/chat/guestShareDialogState";
import { Button } from "~/components/ui/button";
import { RoomPeopleButton } from "~/scient/room/RoomDialog";

import { openShareLinkDialog } from "./shareDialogState";
import { hasCloudAccount } from "./useCloudAccount";

/**
 * "Share" in the thread header makes a link: an invite when this computer can host people,
 * otherwise a published copy. The faces before it are the people already in the thread.
 */
export function ShareThreadButton({ threadRef }: { threadRef: ScopedThreadRef }) {
  const canShareWithGuest = useAtomValue(canShareWithGuestAtom(threadRef.environmentId));
  const canShareLink = hasCloudAccount();
  if (!canShareLink && !canShareWithGuest) return <RoomPeopleButton threadRef={threadRef} />;
  return (
    <>
      <RoomPeopleButton threadRef={threadRef} />
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
    </>
  );
}
