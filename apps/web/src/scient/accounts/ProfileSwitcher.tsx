import { INCOGNITO_BROWSER_PROFILE_ID, type ScopedThreadRef } from "@t3tools/contracts";
import {
  pageSite,
  pickBrowserProfile,
  profileRows,
  siteIdentities,
  type ProfilePick,
} from "@t3tools/shared/scientBrowserProfileChoice";
import { CheckIcon } from "lucide-react";
import { lazy, Suspense, useState } from "react";

import { previewBridge } from "~/components/preview/previewBridge";
import { Button } from "~/components/ui/button";
import {
  Menu,
  MenuCheckboxItem,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from "~/components/ui/menu";
import { toastManager } from "~/components/ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { useClientSettings } from "~/hooks/useSettings";
import { useQuietThreadShell } from "~/state/entities";

import { accountsState } from "./accountsState";
import { addBrowserProfile } from "./addBrowserProfile";
import { mergeProfiles } from "./accountsView";
import { ProfilePicture } from "./ProfilePicture";
import { useAccountCommand, useAccounts } from "./useAccounts";

// The import wizard is the Accounts page's; the browser only loads it when asked.
const BrowserImportDialog = lazy(() =>
  import("./BrowserProfiles").then((module) => ({ default: module.BrowserImportDialog })),
);

/** Why the tab is in its profile, in the words the switcher shows. */
function pickReason({ reason }: ProfilePick, url: string) {
  const site = pageSite(url)?.hostname.replace(/^www\./, "");
  switch (reason) {
    case "site":
      return site ? `for ${site}` : undefined;
    case "conversation":
      return "this conversation";
    case "project":
      return "this project";
    case "main":
      return "has your sign-ins";
    case "default":
      return "default";
  }
}

/**
 * The tab's browser profile, there even with only Main so people find profiles. Choosing another
 * opens the same page in a new tab in it and is remembered for this conversation and the page's
 * site; "Use in this project" sets the project's. New profiles start here too.
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
  const defaultProfileId = useClientSettings((settings) => settings.browserDefaultProfileId);
  const { data, canWrite } = useAccounts(environmentId);
  const choose = useAccountCommand(accountsState.chooseProfile, environmentId);
  const projectId = useQuietThreadShell(threadRef)?.projectId;
  const [importing, setImporting] = useState(false);
  const profiles = mergeProfiles(userProfiles, data?.profiles ?? []);
  const active = profiles.find((profile) => profile.id === activeProfileId);
  if (!active) return null;
  const openIn = (profileId: string) => {
    void choose({ threadId: threadRef.threadId, profileId, ...(url ? { url } : {}) });
    onOpenInProfile(profileId);
  };
  const addProfile = () =>
    addBrowserProfile(environmentId)
      .then((profileId) => {
        if (profileId) openIn(profileId);
      })
      .catch(() => toastManager.add({ type: "error", title: "Could not add a profile" }));
  const holders = siteIdentities(data?.accounts ?? [], url).map((signIn) => signIn.profileId);
  const projectProfileId = projectId ? data?.profileChoices?.projects[projectId] : undefined;
  const pick = data
    ? pickBrowserProfile({
        url,
        threadId: threadRef.threadId,
        projectId,
        profiles: profiles.map((profile) => profile.id),
        rows: profileRows(data.accounts),
        choices: data.profileChoices,
        defaultProfileId,
      })
    : undefined;
  const reason = pick?.profileId === active.id ? pickReason(pick, url) : undefined;
  const label = reason ? `${active.name} · ${reason}` : active.name;
  return (
    <>
      <Menu>
        <Tooltip>
          <TooltipTrigger
            render={
              <MenuTrigger
                render={
                  <Button size="icon-xs" variant="ghost" aria-label={`Profile: ${active.name}`} />
                }
              >
                <ProfilePicture
                  size="sm"
                  name={active.name}
                  picture={active.record.picture}
                  color={active.record.color}
                  id={active.id}
                  browser={active.record.source?.browser}
                />
              </MenuTrigger>
            }
          />
          <TooltipPopup>Browser profile: {label}</TooltipPopup>
        </Tooltip>
        <MenuPopup align="start">
          <MenuGroup>
            <MenuGroupLabel>{label}</MenuGroupLabel>
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
                    id={profile.id}
                    browser={profile.record.source?.browser}
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
          </MenuGroup>
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
          <MenuSeparator />
          <MenuItem onClick={() => onOpenInProfile(INCOGNITO_BROWSER_PROFILE_ID)}>
            New incognito tab
          </MenuItem>
          <MenuItem onClick={() => void addProfile()}>New profile</MenuItem>
          {previewBridge ? (
            <MenuItem onClick={() => setImporting(true)}>Import from a browser…</MenuItem>
          ) : null}
        </MenuPopup>
      </Menu>
      {importing && data ? (
        <Suspense fallback={null}>
          <BrowserImportDialog
            environmentId={environmentId}
            canWrite={canWrite}
            snapshot={data}
            onClose={() => setImporting(false)}
          />
        </Suspense>
      ) : null}
    </>
  );
}
