import { useGT } from "gt-react";

import { SettingsRow } from "~/components/settings/settingsLayout";
import { useSearchableSetting } from "~/components/settings/settingsSearch";
import {
  useScopedSettings,
  useUpdateScopedSettings,
} from "~/components/settings/useScopedSettings";
import { Switch } from "~/components/ui/switch";

/** Settings → Labs: turns the sidebar's icon rail off or back on. */
export function SidebarNavRailSettingRow() {
  const searchableSetting = useSearchableSetting();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const gt = useGT();
  return (
    <SettingsRow
      {...searchableSetting("sidebar-nav-rail")}
      description={gt(
        "Show a column of icons along the sidebar's edge: Home, Library, Scheduled tasks, Extensions and code review at the top; Settings and other tools at the bottom.",
      )}
      control={
        <Switch
          checked={settings.sidebarNavRailEnabled}
          onCheckedChange={(checked) => updateSettings({ sidebarNavRailEnabled: Boolean(checked) })}
          aria-label={gt("Sidebar icon rail")}
        />
      }
    />
  );
}
