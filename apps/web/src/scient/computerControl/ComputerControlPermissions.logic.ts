import type { ToolHostPermission } from "@t3tools/contracts";
import { msg } from "gt-react";

import { m, type MessageResolver } from "~/i18n/messages";

export const COMPUTER_CONTROL_PERMISSIONS: ReadonlyArray<ToolHostPermission> = [
  "screen-recording",
  "accessibility",
];

export const COMPUTER_CONTROL_PERMISSION_COPY: Record<
  ToolHostPermission,
  { title: string; description: string }
> = {
  "screen-recording": {
    title: msg("Screen & System Audio Recording", { $context: "macOS privacy setting name" }),
    description: msg("Lets the agent see the windows it works in."),
  },
  accessibility: {
    title: msg("Accessibility", { $context: "macOS privacy setting name" }),
    description: msg("Lets the agent read windows and click and type in them."),
  },
};

/**
 * macOS 15+ splits the pane; a switch in the audio-only list leaves screen access off. macOS then
 * offers Quit & Reopen, but Scient sees the grant without a restart.
 */
const SCREEN_LIST_HINT = msg(
  "Turn on Scient in the top list, not in System Audio Recording Only. If macOS asks, choose Later.",
);
const SCREEN_STILL_OFF = msg(
  "Still off. That pane has two lists: System Audio Recording Only does not let the agent see windows. Turn on Scient in the top list, Screen & System Audio Recording. If macOS asks, choose Later.",
);

export const computerControlPermissionDescription = (
  permission: ToolHostPermission,
  state: { readonly granted: boolean; readonly requested: boolean },
  resolve: MessageResolver = m,
): string => {
  const base = resolve(COMPUTER_CONTROL_PERMISSION_COPY[permission].description);
  if (state.granted || permission !== "screen-recording") return base;
  return state.requested ? resolve(SCREEN_STILL_OFF) : `${base} ${resolve(SCREEN_LIST_HINT)}`;
};
