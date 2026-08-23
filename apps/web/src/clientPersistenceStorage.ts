import { ClientSettingsSchema, type ClientSettings } from "@t3tools/contracts";

import { getLocalStorageItem, setLocalStorageItem } from "./hooks/useLocalStorage";

import { SCIENT_DESKTOP_IDENTITY } from "@t3tools/shared/scientDesktopIdentity";

export const CLIENT_SETTINGS_STORAGE_KEY = SCIENT_DESKTOP_IDENTITY.clientSettingsStorageKey;

function hasWindow(): boolean {
  return typeof window !== "undefined";
}

export function readBrowserClientSettings(): ClientSettings | null {
  if (!hasWindow()) {
    return null;
  }

  try {
    return getLocalStorageItem(CLIENT_SETTINGS_STORAGE_KEY, ClientSettingsSchema);
  } catch (error) {
    console.error("Could not read persisted client settings.", error);
    return null;
  }
}

export function writeBrowserClientSettings(settings: ClientSettings): void {
  if (!hasWindow()) {
    return;
  }

  setLocalStorageItem(CLIENT_SETTINGS_STORAGE_KEY, settings, ClientSettingsSchema);
}
