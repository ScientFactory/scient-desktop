import { type EnvironmentId } from "@t3tools/contracts";
import { CheckIcon } from "lucide-react";

import { Button } from "~/components/ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "~/components/ui/menu";
import { useClientSettings } from "~/hooks/useSettings";

import { mergeProfiles } from "./accountsView";
import { ProfilePicture } from "./ProfilePicture";
import { useAccounts } from "./useAccounts";

/** The tab's browser profile; choosing another opens the same page in a new tab in it. */
export function ProfileSwitcher({
  environmentId,
  activeProfileId,
  onOpenInProfile,
}: {
  environmentId: EnvironmentId;
  activeProfileId: string;
  onOpenInProfile: (profileId: string) => void;
}) {
  const userProfiles = useClientSettings((settings) => settings.browserProfiles);
  const records = useAccounts(environmentId).data?.profiles ?? [];
  const profiles = mergeProfiles(userProfiles, records);
  const active = profiles.find((profile) => profile.id === activeProfileId);
  if (!active || profiles.length < 2) return null;
  return (
    <Menu>
      <MenuTrigger
        render={<Button size="icon-xs" variant="ghost" aria-label={`Profile: ${active.name}`} />}
      >
        <ProfilePicture
          size="sm"
          name={active.name}
          picture={active.record.picture}
          color={active.record.color}
        />
      </MenuTrigger>
      <MenuPopup align="start">
        {profiles.map((profile) => (
          <MenuItem
            key={profile.id}
            onClick={() => {
              if (profile.id !== activeProfileId) onOpenInProfile(profile.id);
            }}
          >
            <ProfilePicture
              size="sm"
              name={profile.name}
              picture={profile.record.picture}
              color={profile.record.color}
            />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate">{profile.name}</span>
              {profile.record.source?.email ? (
                <span className="truncate text-xs text-muted-foreground">
                  {profile.record.source.email}
                </span>
              ) : null}
            </span>
            {profile.id === activeProfileId ? <CheckIcon /> : null}
          </MenuItem>
        ))}
      </MenuPopup>
    </Menu>
  );
}
