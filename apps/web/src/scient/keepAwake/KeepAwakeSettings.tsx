import type { KeepAwakeState } from "@t3tools/contracts";
import { useEffect, useState } from "react";

import { SettingsRow } from "../../components/settings/settingsLayout";
import { searchableSetting } from "../../components/settings/settingsSearch";
import {
  useScopedSettings,
  useUpdateScopedSettings,
} from "../../components/settings/useScopedSettings";
import { Switch } from "../../components/ui/switch";

const STATUS_REFRESH_MS = 15_000;

export function KeepAwakeSettings() {
  const enabled = useScopedSettings((settings) => settings.keepComputerAwake);
  const updateSettings = useUpdateScopedSettings();
  const [state, setState] = useState<KeepAwakeState | null>(null);
  const keepAwake = window.desktopBridge?.keepAwake;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a timer keeps the row's status in step with the desktop process while it's on screen.
  useEffect(() => {
    if (keepAwake === undefined) return;
    const refresh = () => {
      void keepAwake().then(setState, () => setState(null));
    };
    refresh();
    const timer = setInterval(refresh, STATUS_REFRESH_MS);
    return () => clearInterval(timer);
  }, [keepAwake]);

  if (keepAwake === undefined) return null;
  return (
    <SettingsRow
      {...searchableSetting("keep-computer-awake")}
      description={
        <>
          Stop this computer sleeping while its threads work. The screen can still turn off, and
          closing the lid can still put it to sleep.
          {state?.notice ? ` ${state.notice}` : null}
        </>
      }
      status={state?.active ? "Keeping this computer awake" : undefined}
      control={
        <Switch
          aria-label="Keep computer awake"
          checked={enabled}
          onCheckedChange={(checked) => updateSettings({ keepComputerAwake: Boolean(checked) })}
        />
      }
    />
  );
}
