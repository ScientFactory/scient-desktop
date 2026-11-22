import { useGT } from "gt-react";

import { SettingResetButton, SettingsRow } from "../../components/settings/settingsLayout";
import { useSearchableSetting } from "../../components/settings/settingsSearch";
import { Switch } from "../../components/ui/switch";
import { useAutomaticPlacementPreference } from "./automaticPlacementPreference";

export function AutomaticThreadPlacementSettings() {
  const gt = useGT();
  const setting = useSearchableSetting();
  const { enabled, setEnabled } = useAutomaticPlacementPreference();
  return (
    <SettingsRow
      {...setting("automatic-thread-placement")}
      description={gt(
        "Move working, monitoring, unread, and attention-needed threads near the top of the sidebar and each section. Your manual moves are respected. The Working section (beta) keeps its own order.",
      )}
      resetAction={
        !enabled ? (
          <SettingResetButton
            ariaLabel={gt("Reset automatic thread placement to default")}
            onClick={() => setEnabled(true)}
          />
        ) : null
      }
      control={
        <Switch
          checked={enabled}
          onCheckedChange={setEnabled}
          aria-label={gt("Keep active threads near the top")}
        />
      }
    />
  );
}
