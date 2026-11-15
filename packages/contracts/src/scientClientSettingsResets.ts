/**
 * One-time resets of saved client preferences, applied when older settings are read.
 * 1: appearance contrast returns to upstream's 100. 2: a saved `local` dictation engine, mostly
 * the old default from before ChatGPT dictation, returns to `auto` so ChatGPT is offered once.
 */
import type { ClientSettings } from "./settings.ts";

export const CLIENT_SETTINGS_RESET_REVISION = 2;

export function applyClientSettingsResets(
  settings: ClientSettings,
  savedRevision: number,
): ClientSettings {
  let reset = settings;
  if (savedRevision < 1) reset = { ...reset, appearanceContrast: 100 };
  if (savedRevision < 2 && reset.voiceDictationEngine === "local") {
    reset = { ...reset, voiceDictationEngine: "auto" };
  }
  return reset;
}
