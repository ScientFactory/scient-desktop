import { useAtomValue } from "@effect/atom-react";
import { DEFAULT_KEEP_AWAKE_SETTINGS } from "@t3tools/contracts";
import { Switch } from "../../components/ui/switch";
import { SettingsRow } from "../../components/settings/settingsLayout";
import { keepAwakeErrorAtom, keepAwakeStateAtom, requestKeepAwake } from "./state";
import { searchableSetting } from "../../components/settings/settingsSearch";

export function KeepAwakeSettings() {
  const state = useAtomValue(keepAwakeStateAtom);
  const error = useAtomValue(keepAwakeErrorAtom);
  if (!window.desktopBridge?.keepAwake) return null;
  const settings = state?.settings ?? DEFAULT_KEEP_AWAKE_SETTINGS;
  return (
    <SettingsRow
      {...searchableSetting("keep-computer-awake")}
      description="Prevent automatic sleep while threads are running. The screen can still turn off."
      status={error ?? state?.error ?? undefined}
      control={
        <Switch
          aria-label="Keep computer awake"
          checked={settings.mode === "running"}
          disabled={!state}
          onCheckedChange={(checked) => {
            void requestKeepAwake({
              type: "configure",
              settings: { mode: checked ? "running" : "system" },
            });
          }}
        />
      }
    />
  );
}
