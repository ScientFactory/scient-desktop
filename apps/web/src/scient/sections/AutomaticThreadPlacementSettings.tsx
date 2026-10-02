import { SettingResetButton, SettingsRow } from "../../components/settings/settingsLayout";
import { searchableSetting } from "../../components/settings/settingsSearch";
import { Switch } from "../../components/ui/switch";
import { useAutomaticPlacementPreference } from "./automaticPlacementPreference";

export function AutomaticThreadPlacementSettings() {
  const { enabled, setEnabled } = useAutomaticPlacementPreference();
  return (
    <SettingsRow
      {...searchableSetting("automatic-thread-placement")}
      description="In Sections view, move working, monitoring, unread, and attention-needed threads near the top of each section. Your manual moves are respected."
      resetAction={
        !enabled ? (
          <SettingResetButton label="automatic thread placement" onClick={() => setEnabled(true)} />
        ) : null
      }
      control={
        <Switch
          checked={enabled}
          onCheckedChange={setEnabled}
          aria-label="Keep active threads near the top"
        />
      }
    />
  );
}
