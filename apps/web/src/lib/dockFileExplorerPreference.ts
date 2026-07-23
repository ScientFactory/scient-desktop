// FILE: dockFileExplorerPreference.ts
// Purpose: Best-effort persistence for the file surface's embedded explorer toggle.
// Layer: Web UI preference helper

const DOCK_FILE_EXPLORER_OPEN_STORAGE_KEY = "scient:right-dock-file-explorer-open:v1";

interface PreferenceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function browserStorage(): PreferenceStorage | null {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function readDockFileExplorerOpen(storage: PreferenceStorage | null = browserStorage()) {
  if (!storage) {
    return true;
  }
  try {
    return storage.getItem(DOCK_FILE_EXPLORER_OPEN_STORAGE_KEY) !== "false";
  } catch {
    return true;
  }
}

export function storeDockFileExplorerOpen(
  open: boolean,
  storage: PreferenceStorage | null = browserStorage(),
): void {
  if (!storage) {
    return;
  }
  try {
    storage.setItem(DOCK_FILE_EXPLORER_OPEN_STORAGE_KEY, String(open));
  } catch {
    // Best-effort UI preference only.
  }
}
