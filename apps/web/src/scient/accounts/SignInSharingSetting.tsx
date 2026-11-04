import { SettingsRow } from "~/components/settings/settingsLayout";
import { Switch } from "~/components/ui/switch";
import { updateClientSettings, useClientSettings } from "~/hooks/useSettings";

/** Labs: this desktop's browser sign-ins go to its other computers only while this is on. */
export function SignInSharingSetting() {
  const enabled = useClientSettings((settings) => settings.signInSharingEnabled);
  if (!window.desktopBridge?.accounts?.readSessions) return null;
  return (
    <SettingsRow
      title="Send sign-ins to other computers"
      description="Copy this computer's browser sign-ins for the sites in Accounts to the computers it connects to, so agents there are signed in too. Not yet tested on real servers. While it is off, nothing is sent."
      control={
        <Switch
          aria-label="Send sign-ins to other computers"
          checked={enabled}
          onCheckedChange={(checked) =>
            void updateClientSettings({ signInSharingEnabled: Boolean(checked) })
          }
        />
      }
    />
  );
}
