import { useAtomValue } from "@effect/atom-react";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { LinkIcon, ShareIcon, UserPlusIcon } from "lucide-react";

import { canShareWithGuestAtom } from "~/components/chat/guestShareAvailability";
import { openGuestShareDialog } from "~/components/chat/guestShareDialogState";
import { Button } from "~/components/ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "~/components/ui/menu";

import { openShareLinkDialog } from "./shareDialogState";
import { hasCloudAccount } from "./useCloudAccount";

/**
 * "Share" in the thread header. With both kinds of sharing it asks which one; with one it opens it.
 */
export function ShareThreadButton({ threadRef }: { threadRef: ScopedThreadRef }) {
  const canShareWithGuest = useAtomValue(canShareWithGuestAtom(threadRef.environmentId));
  const canShareLink = hasCloudAccount();
  if (!canShareLink && !canShareWithGuest) return null;

  const shareButton = (onClick?: () => void) => (
    <Button size="xs" variant="ghost" className="shrink-0" onClick={onClick}>
      <ShareIcon aria-hidden />
      Share
    </Button>
  );
  if (!canShareWithGuest) return shareButton(() => openShareLinkDialog(threadRef));
  if (!canShareLink) return shareButton(() => openGuestShareDialog(threadRef));
  return (
    <Menu>
      <MenuTrigger render={shareButton()} />
      <MenuPopup align="end">
        <MenuItem onClick={() => openShareLinkDialog(threadRef)}>
          <LinkIcon aria-hidden />
          Link…
        </MenuItem>
        <MenuItem onClick={() => openGuestShareDialog(threadRef)}>
          <UserPlusIcon aria-hidden />
          Invite a guest…
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}
