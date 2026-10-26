import * as DateTime from "effect/DateTime";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import {
  BROWSER_IMPORT_FAILURE_COPY,
  BROWSER_PROFILE_MAX_COUNT,
  BROWSER_PROFILE_NAME_MAX_LENGTH,
  BrowserProfileRecordUpdateInput,
  DEFAULT_BROWSER_PROFILE_ID,
  isBuiltInBrowserProfileId,
  type AccountsSnapshot,
  type EnvironmentId,
  type BrowserProfileRecord,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import { Tooltip, TooltipTrigger, TooltipPopup } from "~/components/ui/tooltip";
import { Button } from "~/components/ui/button";
import { DraftInput } from "~/components/ui/draft-input";
import { Menu, MenuTrigger, MenuPopup, MenuItem, MenuCheckboxItem } from "~/components/ui/menu";
import { Checkbox } from "~/components/ui/checkbox";
import { DiscoveryList, DiscoveryListRow } from "~/components/ui/discovery-list";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogPanel,
  DialogFooter,
} from "~/components/ui/dialog";
import { SettingsRow, SettingsSection } from "~/components/settings/settingsLayout";
import {
  clearBrowserProfileData,
  importBrowserCookiesIntoTarget,
} from "~/components/settings/IntegrationsSettings";
import { previewBridge } from "~/components/preview/previewBridge";
import {
  persistClientSettingsUpdate,
  useClientSettings,
  useClientSettingsHydrated,
} from "~/hooks/useSettings";
import { useEnvironments } from "~/state/environments";
import { useServerConfigs } from "~/state/entities";
import { previewEnvironment } from "~/state/preview";
import { useAtomCommand } from "~/state/use-atom-command";
import { randomUUID } from "~/lib/utils";
import { readLocalApi } from "~/localApi";
import { toastManager } from "~/components/ui/toast";
import { accountsState } from "./accountsState";
import { ProfilePicture } from "./ProfilePicture";
import { useAccountCommand } from "./useAccounts";
import { AccessChip, ControlsMenu, ScopeDialog } from "./AccountControls";
import {
  importProfileName,
  mergeProfiles,
  matchExistingProfile,
  mergeSourceProfiles,
} from "./accountsView";

const decodeProfileUpdate = Schema.decodeOption(BrowserProfileRecordUpdateInput);

/** The desktop lists at most this many signed-in sites per profile. */
const SIGNED_IN_SITES_LIMIT = 50;

type SourceMatch = NonNullable<ReturnType<typeof matchExistingProfile>>;

function profileError() {
  toastManager.add({ type: "error", title: "Browser profile action failed" });
}

function SignedInSites({
  profileId,
  environmentId,
}: {
  profileId: string;
  environmentId: EnvironmentId;
}) {
  const [sites, setSites] = useState<ReadonlyArray<{ domain: string }> | null>(null);
  useEffect(() => {
    let live = true;
    void window.desktopBridge?.accounts
      ?.signedInSites(profileId, environmentId)
      .then((value) => {
        if (live) setSites(value);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [profileId, environmentId]);
  return sites?.length ? (
    <Tooltip>
      <TooltipTrigger render={<div className="flex min-w-0 text-xs text-muted-foreground" />}>
        <span className="truncate">
          {sites
            .slice(0, 3)
            .map((site) => site.domain)
            .join(" · ")}
          {sites.length > 3
            ? ` + ${sites.length - 3}${sites.length >= SIGNED_IN_SITES_LIMIT ? "+" : ""} more`
            : ""}
        </span>
      </TooltipTrigger>
      <TooltipPopup>{sites.map((site) => site.domain).join(", ")}</TooltipPopup>
    </Tooltip>
  ) : null;
}

export function BrowserImportDialog({
  environmentId,
  canWrite,
  onClose,
}: {
  environmentId: EnvironmentId;
  canWrite: boolean;
  onClose: () => void;
}) {
  const [sources, setSources] = useState<ReturnType<typeof mergeSourceProfiles>>([]);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const updateRecord = useAccountCommand(accountsState.updateProfile, environmentId);
  const load = async () => {
    try {
      const [sources, details] = await Promise.all([
        previewBridge?.listBrowserImportSources() ?? [],
        window.desktopBridge?.accounts?.sourceProfiles().catch(() => []) ?? [],
      ]);
      setSources(mergeSourceProfiles(sources, details));
    } catch {
      profileError();
    }
  };
  useEffect(() => {
    let live = true;
    void Promise.all([
      previewBridge?.listBrowserImportSources() ?? [],
      window.desktopBridge?.accounts?.sourceProfiles().catch(() => []) ?? [],
    ])
      .then(([sources, details]) => {
        if (live) setSources(mergeSourceProfiles(sources, details));
      })
      .catch(profileError);
    return () => {
      live = false;
    };
  }, []);
  const runImport = async () => {
    if (!canWrite || !previewBridge || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    const done = new Set<string>();
    try {
      for (const source of sources)
        for (const profile of source.profiles) {
          const key = JSON.stringify([source.id, profile.directory]);
          if (!selected.has(key) || source.unavailable) continue;
          const profileId = `profile-${randomUUID()}`;
          const outcome = await importBrowserCookiesIntoTarget(
            previewBridge,
            source,
            environmentId,
            {
              sourceProfileDirectory: profile.directory,
              target: { kind: "new", profileId },
              profileName: profile.name,
            },
          );
          if (outcome.kind === "blocked") {
            toastManager.add({ type: "error", title: BROWSER_IMPORT_FAILURE_COPY[outcome.reason] });
            continue;
          }
          done.add(key);
          const record = decodeProfileUpdate({
            profileId,
            ...(profile.picture ? { picture: profile.picture } : {}),
            ...(profile.color ? { color: profile.color } : {}),
            source: {
              browser: source.id,
              profileName: profile.name,
              ...(profile.email ? { email: profile.email } : {}),
              importedAt: DateTime.formatIso(DateTime.nowUnsafe()),
            },
          });
          if (Option.isSome(record)) await updateRecord(record.value);
          else profileError();
        }
      setSelected((current) => new Set([...current].filter((key) => !done.has(key))));
      if (done.size === selected.size) onClose();
    } catch {
      profileError();
    }
    inFlight.current = false;
    setBusy(false);
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Import from your browser</DialogTitle>
        </DialogHeader>
        <DialogPanel>
          <div className="grid gap-5">
            {sources.map((source) => (
              <div key={source.id} className="grid gap-2">
                <h3 className="text-sm font-medium">{source.name}</h3>
                {source.unavailable ? (
                  <div className="grid gap-2">
                    <p className="text-xs text-muted-foreground">
                      {BROWSER_IMPORT_FAILURE_COPY[source.unavailable]}
                    </p>
                    {source.unavailable === "needsFullDiskAccess" ? (
                      <Button
                        size="xs"
                        variant="outline"
                        onClick={() =>
                          void readLocalApi()
                            ?.shell.openSystemSettings("full-disk-access")
                            .catch(profileError)
                        }
                      >
                        Open System Settings
                      </Button>
                    ) : null}
                  </div>
                ) : (
                  source.profiles.map((profile) => {
                    const key = JSON.stringify([source.id, profile.directory]);
                    return (
                      <label key={key} className="flex items-center gap-3 text-sm">
                        <Checkbox
                          disabled={busy || !canWrite}
                          checked={selected.has(key)}
                          onCheckedChange={(checked) =>
                            setSelected((current) => {
                              const next = new Set(current);
                              if (checked) next.add(key);
                              else next.delete(key);
                              return next;
                            })
                          }
                        />
                        <ProfilePicture
                          name={profile.name}
                          picture={profile.picture}
                          color={profile.color}
                        />
                        <span>
                          {profile.name}
                          {profile.email ? (
                            <span className="block text-xs text-muted-foreground">
                              {profile.email}
                            </span>
                          ) : null}
                        </span>
                      </label>
                    );
                  })
                )}
              </div>
            ))}
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={() => void load()}>
            Refresh
          </Button>
          <Button
            disabled={busy || !canWrite || selected.size === 0}
            onClick={() => void runImport()}
          >
            Import
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

export function BrowserProfiles({
  environmentId,
  snapshot,
  canWrite,
  onImport,
}: {
  environmentId: EnvironmentId;
  snapshot: AccountsSnapshot;
  canWrite: boolean;
  onImport: () => void;
}) {
  const settings = useClientSettings();
  const hydrated = useClientSettingsHydrated();
  const { environments, isReady } = useEnvironments();
  const configs = useServerConfigs();
  const runClear = useAtomCommand(previewEnvironment.clearProfile, {
    reportFailure: false,
    reportDefect: false,
  });
  const setControls = useAccountCommand(accountsState.setControls, environmentId);
  const updateRecord = useAccountCommand(accountsState.updateProfile, environmentId);
  const [siteRevision, setSiteRevision] = useState(0);
  const removeRecord = useAccountCommand(accountsState.removeProfile, environmentId);
  const [scopeProfile, setScopeProfile] = useState<BrowserProfileRecord | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const profiles = mergeProfiles(settings.browserProfiles, snapshot.profiles);
  const disabled = !canWrite || !hydrated || busy;
  const changeSettings = async (update: Parameters<typeof persistClientSettingsUpdate>[0]) => {
    try {
      await persistClientSettingsUpdate(update);
    } catch {
      profileError();
    }
  };
  const clear = async (profileId: string) => {
    if (!isReady || environments.length === 0) throw new Error("Browser data unavailable");
    await clearBrowserProfileData(
      previewBridge,
      environments.map((env) => env.environmentId),
      profileId,
      {
        environmentIds: environments
          .filter((env) => configs.get(env.environmentId)?.environment.capabilities.serverBrowser)
          .map((env) => env.environmentId),
        clear: async (environmentId, profileId) => {
          const result = await runClear({ environmentId, input: { profileId } });
          if (result._tag !== "Success") throw new Error("Browser data unavailable");
        },
      },
    );
  };
  const act = async (operation: () => Promise<void>) => {
    if (disabled) return;
    setBusy(true);
    try {
      await operation();
      setSiteRevision((revision) => revision + 1);
    } catch {
      profileError();
    }
    setBusy(false);
  };
  const refresh = async (profileId: string, record: BrowserProfileRecord) => {
    if (!previewBridge || !record.source) return;
    const sources = mergeSourceProfiles(
      await previewBridge.listBrowserImportSources(),
      (await window.desktopBridge?.accounts?.sourceProfiles().catch(() => [])) ?? [],
    );
    const source = sources.find((source) => source.id === record.source?.browser);
    const profile = source?.profiles.find((profile) => profile.name === record.source?.profileName);
    if (!source || !profile) {
      profileError();
      return;
    }
    const result = await importBrowserCookiesIntoTarget(previewBridge, source, environmentId, {
      sourceProfileDirectory: profile.directory,
      target: { kind: "existing", profileId, name: record.source.profileName },
    });
    if (result.kind === "blocked")
      toastManager.add({ type: "error", title: BROWSER_IMPORT_FAILURE_COPY[result.reason] });
    else {
      const metadata = decodeProfileUpdate({
        profileId,
        ...(profile.picture ? { picture: profile.picture } : {}),
        ...(profile.color ? { color: profile.color } : {}),
        source: {
          browser: source.id,
          profileName: profile.name,
          ...(profile.email ? { email: profile.email } : {}),
          importedAt: DateTime.formatIso(DateTime.nowUnsafe()),
        },
      });
      if (Option.isSome(metadata)) await updateRecord(metadata.value);
    }
  };
  const linkSource = async (profileId: string, match: SourceMatch) => {
    const metadata = decodeProfileUpdate({
      profileId,
      ...(match.profile.picture ? { picture: match.profile.picture } : {}),
      ...(match.profile.color ? { color: match.profile.color } : {}),
      source: {
        browser: match.source.id,
        profileName: match.profile.name,
        ...(match.profile.email ? { email: match.profile.email } : {}),
        importedAt: DateTime.formatIso(DateTime.nowUnsafe()),
      },
    });
    if (Option.isSome(metadata)) await updateRecord(metadata.value);
  };
  const loadSources = async () =>
    previewBridge
      ? mergeSourceProfiles(
          await previewBridge.listBrowserImportSources(),
          (await window.desktopBridge?.accounts?.sourceProfiles().catch(() => [])) ?? [],
        )
      : [];
  const [linking, setLinking] = useState<string | null>(null);
  const [sources, setSources] = useState<Awaited<ReturnType<typeof loadSources>>>([]);
  const unlinked = profiles
    .filter((profile) => !isBuiltInBrowserProfileId(profile.id) && !profile.record.source)
    .map((profile) => `${profile.id}\u0000${profile.name}`)
    .join("\u0001");
  // Profiles imported before Scient kept their source get its picture, email and name once.
  const linkExisting = useEffectEvent((loaded: Awaited<ReturnType<typeof loadSources>>) => {
    setSources(loaded);
    for (const profile of profiles) {
      if (isBuiltInBrowserProfileId(profile.id) || profile.record.source) continue;
      const match = matchExistingProfile(profile.name, loaded);
      if (match) void linkSource(profile.id, match);
    }
  });
  const fetchSources = useEffectEvent(loadSources);
  useEffect(() => {
    if (!canWrite || !hydrated || unlinked === "") return;
    let live = true;
    void fetchSources()
      .then((loaded) => {
        if (live) linkExisting(loaded);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [canWrite, hydrated, unlinked]);
  return (
    <SettingsSection
      id="accounts-browser-profiles"
      title="Browser profiles"
      headerAction={
        <Menu>
          <MenuTrigger
            render={
              <Button
                size="xs"
                variant="outline"
                disabled={disabled || settings.browserProfiles.length >= BROWSER_PROFILE_MAX_COUNT}
              />
            }
          >
            Add profile
          </MenuTrigger>
          <MenuPopup>
            <MenuItem
              onClick={() =>
                void act(async () => {
                  await persistClientSettingsUpdate((current) => {
                    if (current.browserProfiles.length >= BROWSER_PROFILE_MAX_COUNT) return current;
                    return {
                      ...current,
                      browserProfiles: [
                        ...current.browserProfiles,
                        {
                          id: `profile-${randomUUID()}`,
                          name: importProfileName(
                            "Profile",
                            mergeProfiles(current.browserProfiles, []).map(
                              (profile) => profile.name,
                            ),
                          ),
                          kind: "persistent",
                        },
                      ],
                    };
                  });
                })
              }
            >
              Blank profile
            </MenuItem>
            {previewBridge ? <MenuItem onClick={onImport}>From another browser…</MenuItem> : null}
          </MenuPopup>
        </Menu>
      }
    >
      {profiles.map((profile) => (
        <SettingsRow
          key={profile.id}
          title={
            <div className="flex items-center gap-3">
              <ProfilePicture
                name={profile.name}
                picture={profile.record.picture}
                color={profile.record.color}
              />
              <div className="grid gap-1">
                <div className="flex items-center gap-2">
                  {renaming !== profile.id ? (
                    <span className="text-sm text-foreground">{profile.name}</span>
                  ) : (
                    <DraftInput
                      aria-label="Profile name"
                      autoFocus
                      nativeInput
                      size="sm"
                      value={profile.name}
                      disabled={disabled}
                      maxLength={BROWSER_PROFILE_NAME_MAX_LENGTH}
                      onCommit={(value) => {
                        const name = value.trim();
                        if (name)
                          void changeSettings((current) => ({
                            ...current,
                            browserProfiles: current.browserProfiles.map((item) =>
                              item.id === profile.id ? { ...item, name } : item,
                            ),
                          }));
                      }}
                    />
                  )}
                </div>
                {profile.record.source ? (
                  <span className="text-xs text-muted-foreground">
                    {[
                      profile.record.source.browser[0]!.toUpperCase() +
                        profile.record.source.browser.slice(1),
                      profile.record.source.profileName === profile.name
                        ? undefined
                        : profile.record.source.profileName,
                      profile.record.source.email,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                ) : null}
                <SignedInSites
                  key={`${profile.id}:${siteRevision}`}
                  profileId={profile.id}
                  environmentId={environmentId}
                />
              </div>
            </div>
          }
          control={
            <div className="flex items-center gap-2">
              <AccessChip
                environmentId={environmentId}
                target={{ type: "profile", profileId: profile.id }}
                access={profile.record.access}
                disabled={disabled}
              />
              <ControlsMenu disabled={disabled}>
                <MenuCheckboxItem
                  variant="switch"
                  checked={profile.record.scriptSignIn}
                  onCheckedChange={(scriptSignIn) =>
                    void setControls({
                      target: { type: "profile", profileId: profile.id },
                      scriptSignIn,
                    })
                  }
                >
                  Use in scripts
                </MenuCheckboxItem>
                {isBuiltInBrowserProfileId(profile.id) ? null : (
                  <MenuItem onClick={() => setRenaming(profile.id)}>Rename</MenuItem>
                )}
                {isBuiltInBrowserProfileId(profile.id) ||
                profile.record.source ||
                !previewBridge ? null : (
                  <MenuItem
                    onClick={() => {
                      setLinking(profile.id);
                      void loadSources()
                        .then(setSources)
                        .catch(() => undefined);
                    }}
                  >
                    Match to browser profile…
                  </MenuItem>
                )}
                <MenuItem onClick={() => setScopeProfile(profile.record)}>Available in…</MenuItem>
                <MenuItem
                  disabled={settings.browserDefaultProfileId === profile.id}
                  onClick={() =>
                    void changeSettings((current) => ({
                      ...current,
                      browserDefaultProfileId: profile.id,
                    }))
                  }
                >
                  Set as default
                </MenuItem>
                {previewBridge && profile.record.source ? (
                  <MenuItem onClick={() => void act(() => refresh(profile.id, profile.record))}>
                    Refresh from{" "}
                    {profile.record.source.browser[0]!.toUpperCase() +
                      profile.record.source.browser.slice(1)}
                  </MenuItem>
                ) : null}
                <MenuItem onClick={() => void act(() => clear(profile.id))}>
                  Clear cookies and cache
                </MenuItem>
                {!isBuiltInBrowserProfileId(profile.id) ? (
                  <MenuItem
                    onClick={() =>
                      void act(async () => {
                        await clear(profile.id);
                        const result = await removeRecord({ profileId: profile.id });
                        if (!result.ok) return;
                        await persistClientSettingsUpdate((current) => ({
                          ...current,
                          browserProfiles: current.browserProfiles.filter(
                            (item) => item.id !== profile.id,
                          ),
                          ...(current.browserDefaultProfileId === profile.id
                            ? { browserDefaultProfileId: DEFAULT_BROWSER_PROFILE_ID }
                            : {}),
                        }));
                      })
                    }
                  >
                    Remove
                  </MenuItem>
                ) : null}
              </ControlsMenu>
            </div>
          }
        />
      ))}
      {linking ? (
        <Dialog open onOpenChange={(open) => !open && setLinking(null)}>
          <DialogPopup>
            <DialogHeader>
              <DialogTitle>Match to browser profile</DialogTitle>
            </DialogHeader>
            <DialogPanel>
              <DiscoveryList>
                {sources.flatMap((source) =>
                  source.profiles.map((sourceProfile) => (
                    <DiscoveryListRow
                      key={`${source.id}:${sourceProfile.directory}`}
                      icon={
                        <ProfilePicture
                          name={sourceProfile.name}
                          picture={sourceProfile.picture}
                          color={sourceProfile.color}
                        />
                      }
                      title={sourceProfile.name}
                      description={[source.name, sourceProfile.email].filter(Boolean).join(" · ")}
                      onClick={() => {
                        const profileId = linking;
                        setLinking(null);
                        void act(() => linkSource(profileId, { source, profile: sourceProfile }));
                      }}
                    />
                  )),
                )}
              </DiscoveryList>
            </DialogPanel>
          </DialogPopup>
        </Dialog>
      ) : null}
      {scopeProfile ? (
        <ScopeDialog
          environmentId={environmentId}
          scope={scopeProfile.scope}
          onClose={() => setScopeProfile(null)}
          onSave={async (scope) => {
            if (!canWrite) return;
            const result = await setControls({
              target: { type: "profile", profileId: scopeProfile.profileId },
              scope,
            });
            if (result.ok) setScopeProfile(null);
          }}
        />
      ) : null}
    </SettingsSection>
  );
}
