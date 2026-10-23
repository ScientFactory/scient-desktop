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
      description={
        <>
          Prevent automatic sleep while local threads are running. The screen can still turn off.
          {state?.platformNotice ? <> {state.platformNotice}</> : null}
        </>
      }
      status={
        error ??
        state?.error ??
        (state?.blocking
          ? "Keep-awake requested"
          : state?.threads.some((thread) => thread.status === "paused")
            ? "Paused: waiting for work that can continue"
            : "No keep-awake request")
      }
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
