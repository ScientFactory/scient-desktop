import { systemPreferences } from "electron";

/** Turned off when the user picks one spelling language in System Settings. */
const AUTOMATIC_LANGUAGE_KEY = "NSSpellCheckerAutomaticallyIdentifiesLanguages";

/**
 * Lets macOS detect each paragraph's language in Scient even when the user
 * fixed one spelling language system-wide. Scient's own defaults take
 * precedence, so neither System Settings nor other apps change. Chromium reads
 * the setting as it starts, so this must run before the app is ready.
 */
export function enableAutomaticSpellingLanguages(): void {
  try {
    if (!systemPreferences.getUserDefault(AUTOMATIC_LANGUAGE_KEY, "boolean")) {
      systemPreferences.setUserDefault(AUTOMATIC_LANGUAGE_KEY, "boolean", true);
    }
  } catch {
    // Spellcheck must never stop the app from starting.
  }
}
