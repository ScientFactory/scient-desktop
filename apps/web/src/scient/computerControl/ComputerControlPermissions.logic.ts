import type { ToolHostPermission } from "@t3tools/contracts";

export const COMPUTER_CONTROL_PERMISSIONS: ReadonlyArray<ToolHostPermission> = [
  "screen-recording",
  "accessibility",
];

export const COMPUTER_CONTROL_PERMISSION_COPY: Record<
  ToolHostPermission,
  { title: string; description: string }
> = {
  "screen-recording": {
    title: "Screen & System Audio Recording",
    description: "Lets the agent see the windows it works in.",
  },
  accessibility: {
    title: "Accessibility",
    description: "Lets the agent read windows and click and type in them.",
  },
};

/** macOS 15+ splits the pane; a switch in the audio-only list leaves screen access off. */
const SCREEN_LIST_HINT = "Turn on Scient in the top list, not in System Audio Recording Only.";
const SCREEN_STILL_OFF =
  "Still off. That pane has two lists: System Audio Recording Only does not let the agent see windows. Turn on Scient in the top list, Screen & System Audio Recording.";

export const computerControlPermissionDescription = (
  permission: ToolHostPermission,
  state: { readonly granted: boolean; readonly requested: boolean; readonly waitingFor: number },
): string => {
  const base = COMPUTER_CONTROL_PERMISSION_COPY[permission].description;
  if (state.granted || permission !== "screen-recording") return base;
  if (state.waitingFor > 0)
    return `Opens System Settings once ${state.waitingFor === 1 ? "the running thread finishes" : `the ${state.waitingFor} running threads finish`}: macOS may close Scient when you turn this on, which would stop ${state.waitingFor === 1 ? "it" : "them"}.`;
  return state.requested ? SCREEN_STILL_OFF : `${base} ${SCREEN_LIST_HINT}`;
};
