import { UserButton, useAuth } from "@clerk/react";
// SCIENT-FORK:START — the icon rail's account item labels itself with gt().
import { T, useGT, useMessages } from "gt-react";
// SCIENT-FORK:END
import { LogInIcon, RotateCwIcon } from "lucide-react";

import { hasCloudPublicConfig } from "../../cloud/publicConfig";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "../ui/sidebar";
// SCIENT-FORK:START — the icon rail's account item.
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
// SCIENT-FORK:END
import { retryClerkLoad, useClerkLoadFailed } from "./clerkLoadFailure";
// SCIENT-FORK:START — the account pages Scient offers (no T3 Chat).
import { SCIENT_ACCOUNT_PAGES as T3_CONNECT_ACCOUNT_PAGES } from "./T3ConnectAccountPages";
// SCIENT-FORK:END
import { useT3ConnectAuthPrompt } from "./useT3ConnectAuthPrompt";

export function T3ConnectSidebarSignIn() {
  if (!hasCloudPublicConfig()) return null;

  return <ConfiguredT3ConnectSidebarSignIn />;
}

export function T3ConnectSidebarAvatar() {
  if (!hasCloudPublicConfig()) return null;

  return <ConfiguredT3ConnectSidebarAvatar />;
}

// SCIENT-FORK:START — `compact` is the icon rail's smaller avatar, sized to sit with its icons.
function ConfiguredT3ConnectSidebarAvatar({ compact = false }: { compact?: boolean }) {
  // SCIENT-FORK:END
  const { isLoaded, isSignedIn } = useAuth();
  const m = useMessages();

  if (!isLoaded || !isSignedIn) return null;

  return (
    <UserButton
      appearance={{
        elements: {
          // SCIENT-FORK:START — the icon rail's compact avatar.
          avatarBox: compact ? "size-6 ring-1 ring-sidebar-border" : "size-7",
          // SCIENT-FORK:END
          // Clerk's unlayered trigger reset (padding, radius, background) beats layered utilities.
          userButtonTrigger: "mb-1! rounded-lg! p-1! hover:bg-sidebar-row-hover!",
        },
      }}
    >
      {T3_CONNECT_ACCOUNT_PAGES.map((page) => (
        <UserButton.UserProfilePage
          key={page.url}
          label={m(page.label)}
          labelIcon={page.icon}
          url={page.url}
        >
          {page.content}
        </UserButton.UserProfilePage>
      ))}
    </UserButton>
  );
}

// SCIENT-FORK:START — the icon rail's account item.
/**
 * The sidebar icon rail's account item: the avatar when signed in, otherwise an icon that
 * signs in to Scient Connect. Renders a menu item for the rail's own list.
 */
export function T3ConnectRailAccount() {
  if (!hasCloudPublicConfig()) return null;

  return <ConfiguredT3ConnectRailAccount />;
}

/** Sets the account apart from the rail's other buttons; it shows only with the account item. */
const RAIL_ACCOUNT_DIVIDER = (
  <div aria-hidden className="mt-0.5 mb-1.5 h-px w-6 bg-sidebar-border" />
);

function ConfiguredT3ConnectRailAccount() {
  const { isLoaded, isSignedIn } = useAuth();
  const loadFailed = useClerkLoadFailed();
  const { openAuthPrompt } = useT3ConnectAuthPrompt();
  const gt = useGT();

  if (!loadFailed && isSignedIn) {
    return (
      <SidebarMenuItem className="flex flex-col items-center">
        {RAIL_ACCOUNT_DIVIDER}
        <ConfiguredT3ConnectSidebarAvatar compact />
      </SidebarMenuItem>
    );
  }
  if (!loadFailed && !isLoaded) return null;
  const label = loadFailed ? gt("Retry Scient Connect") : gt("Sign in to Scient Connect");
  return (
    <SidebarMenuItem className="flex shrink-0 flex-col items-center">
      {RAIL_ACCOUNT_DIVIDER}
      <Tooltip>
        <TooltipTrigger
          render={
            <SidebarMenuButton
              aria-label={label}
              onClick={loadFailed ? retryClerkLoad : openAuthPrompt}
              size="icon"
            >
              {loadFailed ? <RotateCwIcon /> : <LogInIcon />}
            </SidebarMenuButton>
          }
        />
        <TooltipPopup side="right">{label}</TooltipPopup>
      </Tooltip>
    </SidebarMenuItem>
  );
}
// SCIENT-FORK:END

function ConfiguredT3ConnectSidebarSignIn() {
  const { isLoaded, isSignedIn } = useAuth();
  const loadFailed = useClerkLoadFailed();
  const { openAuthPrompt } = useT3ConnectAuthPrompt();

  if (loadFailed) {
    return (
      <SidebarMenu>
        <SidebarMenuItem>
          <SidebarMenuButton onClick={retryClerkLoad}>
            <RotateCwIcon />
            <span>
              <T>Retry Scient Connect</T>
            </span>
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>
    );
  }
  if (!isLoaded || isSignedIn) return null;

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <SidebarMenuButton onClick={openAuthPrompt}>
          <LogInIcon />
          <span>
            <T>Sign in to Scient Connect</T>
          </span>
        </SidebarMenuButton>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
