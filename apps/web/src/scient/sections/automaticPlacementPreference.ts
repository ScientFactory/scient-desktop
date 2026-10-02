import { create } from "zustand";

export const AUTOMATIC_PLACEMENT_KEY = "scient:sidebar:automatic-placement";

function readEnabled(): boolean {
  try {
    return window.localStorage.getItem(AUTOMATIC_PLACEMENT_KEY) !== "false";
  } catch {
    return true;
  }
}

export const useAutomaticPlacementPreference = create<{
  enabled: boolean;
  setEnabled: (enabled: boolean) => void;
}>((set) => ({
  enabled: readEnabled(),
  setEnabled: (enabled) => {
    set({ enabled });
    try {
      // Settings unmounts the sidebar. Discard its saved presentation here too,
      // so enabling again starts from current manual order rather than old exceptions.
      if (!enabled) {
        const keys = Array.from({ length: window.localStorage.length }, (_, index) =>
          window.localStorage.key(index),
        );
        for (const key of keys)
          if (key?.startsWith("scient:sidebar:placement-order:"))
            window.localStorage.removeItem(key);
      }
      window.localStorage.setItem(AUTOMATIC_PLACEMENT_KEY, String(enabled));
    } catch {
      // The current window still honours the setting when persistence is unavailable.
    }
  },
}));

if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key === AUTOMATIC_PLACEMENT_KEY || event.key === null) {
      useAutomaticPlacementPreference.setState({ enabled: readEnabled() });
    }
  });
}
