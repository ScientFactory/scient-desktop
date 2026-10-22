import * as Schema from "effect/Schema";

import { SettingResetButton, SettingsRow } from "../../components/settings/settingsLayout";
import { searchableSetting } from "../../components/settings/settingsSearch";
import { Switch } from "../../components/ui/switch";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { APP_BADGE_ENABLED_KEY } from "./ScientAnswerBadgeCoordinator";

// Neither OS reports whether it displays the badge, so each says where it is allowed.
const DESCRIPTIONS: Partial<Record<string, string>> = {
  darwin:
    "Show how many threads have an unread answer on the Dock icon. macOS asks once to allow notifications; if the count doesn't appear, allow badges for Scient in System Settings › Notifications.",
  win32:
    "Show how many threads have an unread answer on the taskbar button. If the count doesn't appear, turn on badges in Windows Settings › Personalization › Taskbar.",
};

/** Desktop only: whether the app icon shows the unread count. */
export function AppBadgeSettings() {
  const [enabled, setEnabled] = useLocalStorage(APP_BADGE_ENABLED_KEY, true, Schema.Boolean);
  const bridge = window.desktopBridge;
  if (!bridge?.setUnreadAnswerBadge) return null;
  return (
    <SettingsRow
      {...searchableSetting("app-icon-badge")}
      description={
        DESCRIPTIONS[bridge.getClientPlatform?.() ?? ""] ??
        "Show how many threads have an unread answer on the app icon, in docks that support badges."
      }
      resetAction={
        enabled ? null : (
          <SettingResetButton label="app icon badge" onClick={() => setEnabled(true)} />
        )
      }
      control={
        <Switch checked={enabled} onCheckedChange={setEnabled} aria-label="App icon badge" />
      }
    />
  );
}
