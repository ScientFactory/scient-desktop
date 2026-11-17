/**
 * One-time resets of saved client preferences, applied when older settings are read.
 * 1: contrast returns to upstream's 100. 2: a saved `local` dictation engine returns to `auto`
 * so ChatGPT is offered once. 3: every font size returns to the current defaults.
 */
import { DEFAULT_CLIENT_SETTINGS, type ClientSettings } from "./settings.ts";

export const CLIENT_SETTINGS_RESET_REVISION = 3;

export function applyClientSettingsResets(
  settings: ClientSettings,
  savedRevision: number,
): ClientSettings {
  let reset = settings;
  if (savedRevision < 1) reset = { ...reset, appearanceContrast: 100 };
  if (savedRevision < 2 && reset.voiceDictationEngine === "local") {
    reset = { ...reset, voiceDictationEngine: "auto" };
  }
  if (savedRevision < 3) {
    reset = {
      ...reset,
      fontSizeInterface: DEFAULT_CLIENT_SETTINGS.fontSizeInterface,
      fontSizePrompt: DEFAULT_CLIENT_SETTINGS.fontSizePrompt,
      fontSizeCode: DEFAULT_CLIENT_SETTINGS.fontSizeCode,
      fontSizeTerminal: DEFAULT_CLIENT_SETTINGS.fontSizeTerminal,
    };
  }
  return reset;
}
