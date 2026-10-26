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
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
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
import { AccessChip, ControlsMenu, ScopeSubmenu } from "./AccountControls";
import {
  importProfileName,
  mergeProfiles,
  matchExistingProfile,
  mergeSourceProfiles,
} from "./accountsView";

const decodeProfileUpdate = Schema.decodeOption(BrowserProfileRecordUpdateInput);

type SourceMatch = NonNullable<ReturnType<typeof matchExistingProfile>>;

function profileError() {
  toastManager.add({ type: "error", title: "Browser profile action failed" });
}

function SignedInSitesDialog({
  profile,
  environmentId,
  canWrite,
  onClose,
}: {
  profile: { id: string; name: string; record: BrowserProfileRecord };
  environmentId: EnvironmentId;
  canWrite: boolean;
  onClose: () => void;
}) {
  const [sites, setSites] = useState<ReadonlyArray<{ domain: string }> | null>(null);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const load = useEffectEvent(() =>
    window.desktopBridge?.accounts
      ?.signedInSites(profile.id, environmentId)
      .then(setSites)
      .catch(() => setSites([])),
  );
  useEffect(() => {
    void load();
  }, []);
  const signOut = async (site: string) => {
    setBusy(site);
    const done = await window.desktopBridge?.accounts
      ?.signOutSite?.(profile.id, site, environmentId)
      .catch(() => false);
    if (!done) profileError();
    await load();
    setBusy(null);
  };
  const shown = (sites ?? []).filter((site) => site.domain.includes(query.trim().toLowerCase()));
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogPopup>
        <DialogHeader>
          <div className="flex items-center gap-3">
            <ProfilePicture
              name={profile.name}
              picture={profile.record.picture}
              color={profile.record.color}
            />
            <div className="grid">
              <DialogTitle>{profile.name}</DialogTitle>
              {profile.record.source?.email ? (
                <span className="text-sm text-muted-foreground">{profile.record.source.email}</span>
              ) : null}
            </div>
          </div>
        </DialogHeader>
        <DialogPanel>
          <div className="grid gap-3">
            <Input
              type="search"
              aria-label="Find a site"
              placeholder={sites ? `${sites.length} signed-in sites` : "Signed-in sites"}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            <div className="max-h-96 overflow-y-auto rounded-lg border">
              {shown.map((site) => (
                <div
                  key={site.domain}
                  className="group flex items-center justify-between gap-3 border-b px-3 py-1.5 text-sm last:border-b-0"
                >
                  <span className="truncate">{site.domain}</span>
                  {window.desktopBridge?.accounts?.signOutSite ? (
                    <span className="opacity-0 group-focus-within:opacity-100 group-hover:opacity-100">
                      <Button
                        size="xs"
                        variant="ghost"
                        disabled={!canWrite || busy !== null}
                        onClick={() => void signOut(site.domain)}
                      >
                        Sign out
                      </Button>
                    </span>
                  ) : null}
                </div>
              ))}
              {sites && shown.length === 0 ? (
                <div className="px-3 py-6 text-center text-sm text-muted-foreground">
                  No sign-ins
                </div>
              ) : null}
            </div>
          </div>
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
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
  const removeRecord = useAccountCommand(accountsState.removeProfile, environmentId);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [viewingSites, setViewingSites] = useState<string | null>(null);
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
                size="sm"
                name={profile.name}
                picture={profile.record.picture}
                color={profile.record.color}
              />
              {renaming === profile.id ? (
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
              ) : (
                <button
                  type="button"
                  className="flex min-w-0 items-baseline gap-2 text-left outline-none focus-visible:underline"
                  onClick={() => setViewingSites(profile.id)}
                >
                  <span className="truncate text-sm text-foreground">{profile.name}</span>
                  {profile.record.source?.email ? (
                    <span className="truncate text-xs text-muted-foreground">
                      {profile.record.source.email}
                    </span>
                  ) : null}
                </button>
              )}
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
                {window.desktopBridge?.accounts ? (
                  <MenuItem onClick={() => setViewingSites(profile.id)}>Signed-in sites</MenuItem>
                ) : null}
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
                <ScopeSubmenu
                  environmentId={environmentId}
                  target={{ type: "profile", profileId: profile.id }}
                  scope={profile.record.scope}
                />
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
                {profile.record.source?.email && profile.record.source.browser === "chrome" ? (
                  <MenuItem
                    onClick={() =>
                      void readLocalApi()
                        ?.shell.openExternal("https://passwords.google.com")
                        .catch(() => undefined)
                    }
                  >
                    Manage passwords in Google
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
      {viewingSites && profiles.some((profile) => profile.id === viewingSites) ? (
        <SignedInSitesDialog
          profile={profiles.find((profile) => profile.id === viewingSites)!}
          environmentId={environmentId}
          canWrite={canWrite}
          onClose={() => setViewingSites(null)}
        />
      ) : null}
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
    </SettingsSection>
  );
}
