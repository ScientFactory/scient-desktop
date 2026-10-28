/**
 * One-time resets of saved client preferences. Stores keep the last saved
 * revision beside the settings; older settings get newer resets when read.
 * Revision 1 returns appearance contrast to upstream's 100.
 */
import type { ClientSettings } from "./settings.ts";

export const CLIENT_SETTINGS_RESET_REVISION = 1;

export function applyClientSettingsResets(
  settings: ClientSettings,
  savedRevision: number,
): ClientSettings {
  return savedRevision >= 1 ? settings : { ...settings, appearanceContrast: 100 };
}
