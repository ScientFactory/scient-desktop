import { useGT } from "gt-react";
import { useState } from "react";

import { Switch } from "../ui/switch";
import { SettingsRow } from "./settingsLayout";
import { useSearchableSetting } from "./settingsSearch";

/** Settings → General: closing the last window keeps Scient running. Per machine. */
export function BackgroundRunningSetting() {
  const searchableSetting = useSearchableSetting();
  const gt = useGT();
  const bridge = window.desktopBridge;
  // The main process applies the platform's default; the renderer never assumes one.
  const [enabled, setEnabled] = useState(() => bridge?.getKeepRunningInBackground?.() === true);
  const [pending, setPending] = useState(false);
  const setKeepRunningInBackground = bridge?.setKeepRunningInBackground;
  if (!setKeepRunningInBackground) return null;

  // A save that fails simply does not take effect (AMENDMENTS 57).
  const change = (next: boolean) => {
    setEnabled(next);
    setPending(true);
    void setKeepRunningInBackground(next)
      .catch(() => setEnabled(bridge?.getKeepRunningInBackground?.() ?? !next))
      .finally(() => setPending(false));
  };

  return (
    <SettingsRow
      {...searchableSetting("keep-running-in-background")}
      control={
        <Switch
          checked={enabled}
          disabled={pending}
          onCheckedChange={(checked) => change(Boolean(checked))}
          aria-label={gt("Keep Scient running in the background")}
        />
      }
    />
  );
}
