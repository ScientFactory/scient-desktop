import { type ScopedThreadRef } from "@t3tools/contracts";
import { profileSignIns, profilesSignedIn } from "@t3tools/shared/scientBrowserProfileChoice";
import { CheckIcon } from "lucide-react";

import { Button } from "~/components/ui/button";
import {
  Menu,
  MenuCheckboxItem,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from "~/components/ui/menu";
import { useClientSettings } from "~/hooks/useSettings";
import { useQuietThreadShell } from "~/state/entities";

import { accountsState } from "./accountsState";
import { mergeProfiles } from "./accountsView";
import { ProfilePicture } from "./ProfilePicture";
import { useAccountCommand, useAccounts } from "./useAccounts";

/**
 * The tab's browser profile. Choosing another opens the same page in a new tab in it and is
 * remembered for this conversation and the page's site; "Use in this project" sets the project's.
 */
export function ProfileSwitcher({
  threadRef,
  url,
  activeProfileId,
  onOpenInProfile,
}: {
  threadRef: ScopedThreadRef;
  url: string;
  activeProfileId: string;
  onOpenInProfile: (profileId: string) => void;
}) {
  const environmentId = threadRef.environmentId;
  const userProfiles = useClientSettings((settings) => settings.browserProfiles);
  const { data } = useAccounts(environmentId);
  const choose = useAccountCommand(accountsState.chooseProfile, environmentId);
  const projectId = useQuietThreadShell(threadRef)?.projectId;
  const profiles = mergeProfiles(userProfiles, data?.profiles ?? []);
  const active = profiles.find((profile) => profile.id === activeProfileId);
  if (!active || profiles.length < 2) return null;
  const openIn = (profileId: string) => {
    void choose({ threadId: threadRef.threadId, profileId, ...(url ? { url } : {}) });
    onOpenInProfile(profileId);
  };
  const profileIds = profiles.map((profile) => profile.id);
  const signIns = profileSignIns(data?.accounts ?? []);
  const holders = profilesSignedIn(url, profileIds, signIns);
  const projectProfileId = projectId ? data?.profileChoices?.projects[projectId] : undefined;
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
        {profiles.map((profile) => {
          const detail = holders.includes(profile.id)
            ? `Signed in to ${new URL(url).hostname}`
            : profile.record.source?.email;
          return (
            <MenuItem
              key={profile.id}
              onClick={() => {
                if (profile.id !== activeProfileId) openIn(profile.id);
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
                {detail ? (
                  <span className="truncate text-xs text-muted-foreground">{detail}</span>
                ) : null}
              </span>
              {profile.id === activeProfileId ? <CheckIcon /> : null}
            </MenuItem>
          );
        })}
        {projectId ? (
          <>
            <MenuSeparator />
            <MenuCheckboxItem
              checked={projectProfileId === activeProfileId}
              onCheckedChange={(checked) =>
                void choose({ projectId, profileId: checked ? activeProfileId : null })
              }
            >
              Use {active.name} in this project
            </MenuCheckboxItem>
          </>
        ) : null}
      </MenuPopup>
    </Menu>
  );
}
