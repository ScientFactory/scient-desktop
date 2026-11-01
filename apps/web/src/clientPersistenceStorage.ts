import { ClientSettingsSchema, type ClientSettings } from "@t3tools/contracts";
// SCIENT-FORK:START — one-time resets of saved client preferences.
import { applyClientSettingsResets, CLIENT_SETTINGS_RESET_REVISION } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
// SCIENT-FORK:END

import { getLocalStorageItem, setLocalStorageItem } from "./hooks/useLocalStorage";

import { SCIENT_DESKTOP_IDENTITY } from "@t3tools/shared/scientDesktopIdentity";

const CLIENT_SETTINGS_STORAGE_KEY = SCIENT_DESKTOP_IDENTITY.clientSettingsStorageKey;
// SCIENT-FORK:START — the reset revision sits beside the settings, never inside them.
const CLIENT_SETTINGS_RESETS_STORAGE_KEY = `${CLIENT_SETTINGS_STORAGE_KEY}:resets`;

function readSavedResetRevision(): number {
  try {
    return getLocalStorageItem(CLIENT_SETTINGS_RESETS_STORAGE_KEY, Schema.Number) ?? 0;
  } catch {
    return 0;
  }
}
// SCIENT-FORK:END

function hasWindow(): boolean {
  return typeof window !== "undefined";
}

export function readBrowserClientSettings(): ClientSettings | null {
  if (!hasWindow()) {
    return null;
  }

  // SCIENT-FORK:START — one-time resets of saved client preferences.
  const settings = getLocalStorageItem(CLIENT_SETTINGS_STORAGE_KEY, ClientSettingsSchema);
  return settings === null ? null : applyClientSettingsResets(settings, readSavedResetRevision());
  // SCIENT-FORK:END
}

export function writeBrowserClientSettings(settings: ClientSettings): void {
  if (!hasWindow()) {
    return;
  }

  setLocalStorageItem(CLIENT_SETTINGS_STORAGE_KEY, settings, ClientSettingsSchema);
  // SCIENT-FORK:START — one-time resets of saved client preferences.
  setLocalStorageItem(
    CLIENT_SETTINGS_RESETS_STORAGE_KEY,
    CLIENT_SETTINGS_RESET_REVISION,
    Schema.Number,
  );
  // SCIENT-FORK:END
}
