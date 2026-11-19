import { SettingResetButton, SettingsRow } from "../../components/settings/settingsLayout";
import { useSearchableSetting } from "../../components/settings/settingsSearch";
import { Switch } from "../../components/ui/switch";
import { useAutomaticPlacementPreference } from "./automaticPlacementPreference";

export function AutomaticThreadPlacementSettings() {
  const setting = useSearchableSetting();
  const { enabled, setEnabled } = useAutomaticPlacementPreference();
  return (
    <SettingsRow
      {...setting("automatic-thread-placement")}
      description="Move working, monitoring, unread, and attention-needed threads near the top of the sidebar and each section. Your manual moves are respected. The Working section (beta) keeps its own order."
      resetAction={
        !enabled ? (
          <SettingResetButton
            ariaLabel="Reset automatic thread placement to default"
            onClick={() => setEnabled(true)}
          />
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
