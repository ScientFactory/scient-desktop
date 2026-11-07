import type { EnvironmentId, ProjectId } from "@t3tools/contracts";

import { SettingsRow, SettingsSection } from "~/components/settings/settingsLayout";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { useClientSettings } from "~/hooks/useSettings";

import { accountsState } from "./accountsState";
import { mergeProfiles } from "./accountsView";
import { useAccountCommand, useAccounts } from "./useAccounts";

const NONE = "none";

/** The project's browser profile: its conversations open tabs in it unless they chose another. */
export function ProjectBrowserProfile({
  environmentId,
  projectId,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
}) {
  const userProfiles = useClientSettings((settings) => settings.browserProfiles);
  const { data, canWrite } = useAccounts(environmentId);
  const choose = useAccountCommand(accountsState.chooseProfile, environmentId);
  if (!data) return null;
  const profiles = mergeProfiles(userProfiles, data.profiles);
  const chosen = data.profileChoices?.projects[projectId];
  const value = profiles.some((profile) => profile.id === chosen) ? chosen! : NONE;
  return (
    <SettingsSection title="Browser">
      <SettingsRow
        title="Browser profile"
        description="Conversations in this project open web pages in this profile, unless they choose another."
        control={
          <Select
            value={value}
            disabled={!canWrite}
            onValueChange={(next) =>
              void choose({ projectId, profileId: next === NONE || next === null ? null : next })
            }
          >
            <SelectTrigger size="sm" aria-label="Browser profile for this project">
              <SelectValue>
                {profiles.find((profile) => profile.id === value)?.name ?? "New-tab default"}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              <SelectItem hideIndicator value={NONE}>
                New-tab default
              </SelectItem>
              {profiles.map((profile) => (
                <SelectItem hideIndicator key={profile.id} value={profile.id}>
                  {profile.name}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
    </SettingsSection>
  );
}
