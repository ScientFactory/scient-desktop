import { DEFAULT_UNIFIED_SETTINGS, type UnifiedSettings } from "@t3tools/contracts/settings";

// Restore defaults in T3's `useSettingsRestore` (SettingsPanels.tsx) composes these for the
// settings only Scient has. Font weight and search suggestions are already labelled by the
// typography and browser label helpers; they only need resetting here.
export function getChangedScientSettingLabels(
  settings: Pick<UnifiedSettings, "contentDirection">,
): string[] {
  return settings.contentDirection !== DEFAULT_UNIFIED_SETTINGS.contentDirection
    ? ["Conversation text direction"]
    : [];
}

export const SCIENT_RESTORED_SETTING_DEFAULTS = {
  contentDirection: DEFAULT_UNIFIED_SETTINGS.contentDirection,
  fontWeightInterface: DEFAULT_UNIFIED_SETTINGS.fontWeightInterface,
  browserSearchSuggestions: DEFAULT_UNIFIED_SETTINGS.browserSearchSuggestions,
} satisfies Partial<UnifiedSettings>;
