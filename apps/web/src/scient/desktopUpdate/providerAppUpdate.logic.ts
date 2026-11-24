import type { DesktopUpdateState } from "@t3tools/contracts";

import {
  canCheckForUpdate,
  resolveDesktopUpdateButtonAction,
} from "~/components/desktopUpdate.logic";

export function resolveProviderAppUpdateAction(state: DesktopUpdateState | null) {
  if (!state || !canCheckForUpdate(state)) return null;
  const action = resolveDesktopUpdateButtonAction(state);
  if (action === "install") {
    return state.errorContext === "install" ? "retry-install" : "confirm-install";
  }
  return action === "download" ? "download" : "check";
}
