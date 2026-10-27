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
import { ArrowRightIcon, CheckIcon, PlusIcon } from "lucide-react";
import { Menu, MenuTrigger, MenuPopup, MenuItem, MenuCheckboxItem } from "~/components/ui/menu";
import { QuitStep } from "~/components/settings/BrowserImportWizard";
import { usePermissionStatus } from "~/components/permissions/usePermissionStatus";
import { AccountLogo } from "./AccountLogo";
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
  browserIconUrl,
  importProfileName,
  mergeProfiles,
  matchExistingProfile,
  mergeSourceProfiles,
} from "./accountsView";

// oxlint-disable-next-line t3code/no-em-dash-copy -- The Accounts design brief specifies this exact running-browser label.
const RUNNING_BROWSER_COPY = "Open — quit to import";

const decodeProfileUpdate = Schema.decodeOption(BrowserProfileRecordUpdateInput);

type SourceMatch = NonNullable<ReturnType<typeof matchExistingProfile>>;

function BrowserLogo({ id, name }: { id: string; name: string }) {
  const icon = browserIconUrl(id);
  return icon ? (
    <AccountLogo src={icon} className="size-9 rounded-lg" />
  ) : (
    <ProfilePicture name={name} />
  );
}

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
  // oxlint-disable-next-line t3code/react-effect-budget -- Read this profile's signed-in sites from the desktop when the view opens.
  useEffect(() => {
    void load();
  }, []);
  const signOut = async (site: string) => {
    setBusy(site);
    const done = await window.desktopBridge?.accounts
      ?.signOutSite?.(profile.id, site, environmentId)
      .catch(() => false);
    if (!done) profileError();
    else window.dispatchEvent(new Event("scient-accounts-session-changed"));
    await load();
    setBusy(null);
  };
  const shown = (sites ?? []).filter((site) => site.domain.includes(query.trim().toLowerCase()));
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogPopup data-accounts-dialog>
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
  snapshot,
  onClose,
}: {
  environmentId: EnvironmentId;
  canWrite: boolean;
  snapshot: AccountsSnapshot;
  onClose: () => void;
}) {
  const [sources, setSources] = useState<ReturnType<typeof mergeSourceProfiles>>([]);
  const [loaded, setLoaded] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const updateRecord = useAccountCommand(accountsState.updateProfile, environmentId);
  const [quitting, setQuitting] = useState<ReturnType<typeof mergeSourceProfiles>[number] | null>(
    null,
  );
  const [imported, setImported] = useState<ReadonlySet<string>>(new Set());
  const isImported = (
    source: ReturnType<typeof mergeSourceProfiles>[number],
    profile: (typeof source.profiles)[number],
  ) =>
    imported.has(JSON.stringify([source.id, profile.directory])) ||
    snapshot.profiles.some(
      (item) =>
        item.source?.browser === source.id &&
        item.source.profileName === profile.name &&
        item.source.email === profile.email,
    );
  const load = async () => {
    const [sources, details] = await Promise.all([
      previewBridge?.listBrowserImportSources() ?? [],
      window.desktopBridge?.accounts?.sourceProfiles().catch(() => []) ?? [],
    ]);
    return mergeSourceProfiles(sources, details);
  };
  const permission = usePermissionStatus(
    async () => {
      const loaded = await load();
      setSources(loaded);
      setLoaded(true);
      return {
        fullDiskAccess: !loaded.some((source) => source.unavailable === "needsFullDiskAccess"),
      };
    },
    { fullDiskAccess: false },
    !busy && (!loaded || sources.some((source) => source.unavailable === "needsFullDiskAccess")),
  );
  const runImport = async (loaded = sources) => {
    if (!canWrite || !previewBridge || inFlight.current) return;
    const running = loaded.find(
      (source) =>
        source.unavailable === "browserRunning" &&
        source.profiles.some((profile) =>
          selected.has(JSON.stringify([source.id, profile.directory])),
        ),
    );
    if (running) {
      setQuitting(running);
      return;
    }
    setQuitting(null);
    inFlight.current = true;
    setBusy(true);
    const done = new Set<string>();
    try {
      for (const source of loaded)
        for (const profile of source.profiles) {
          const key = JSON.stringify([source.id, profile.directory]);
          if (!selected.has(key) || source.unavailable || isImported(source, profile)) continue;
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
      setImported((current) => new Set([...current, ...done]));
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
      <DialogPopup data-accounts-dialog>
        {quitting ? (
          <QuitStep
            source={quitting}
            onCancel={() => setQuitting(null)}
            onRechecked={() => {
              void load()
                .then((loaded) => {
                  setSources(loaded);
                  void runImport(loaded);
                })
                .catch(profileError);
            }}
          />
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Import from a browser</DialogTitle>
            </DialogHeader>
            <DialogPanel>
              <DiscoveryList>
                {sources
                  .filter((source) => source.unavailable !== "notInstalled")
                  .flatMap((source) =>
                    source.unavailable === "needsFullDiskAccess"
                      ? [
                          <div
                            key={source.id}
                            className="flex min-h-15 items-center gap-3 px-3 py-2"
                          >
                            <BrowserLogo id={source.id} name={source.name} />
                            <span className="grid min-w-0 flex-1 text-sm">
                              <span>{source.name}</span>
                              <span className="text-xs text-muted-foreground">
                                Needs Full Disk Access
                              </span>
                            </span>
                            <div className="shrink-0">
                              <Button
                                size="xs"
                                variant="outline"
                                onClick={() =>
                                  void readLocalApi()
                                    ?.shell.openSystemSettings("full-disk-access")
                                    .catch(profileError)
                                }
                              >
                                Open Settings <ArrowRightIcon />
                              </Button>
                            </div>
                          </div>,
                        ]
                      : source.profiles.map((profile) => {
                          const key = JSON.stringify([source.id, profile.directory]);
                          const alreadyImported = isImported(source, profile);
                          const checked = selected.has(key);
                          return (
                            <DiscoveryListRow
                              key={key}
                              role="checkbox"
                              aria-checked={checked}
                              aria-label={`${profile.name} · ${source.name}`}
                              disabled={
                                busy ||
                                !canWrite ||
                                alreadyImported ||
                                (!!source.unavailable && source.unavailable !== "browserRunning")
                              }
                              icon={
                                profile.picture ? (
                                  <ProfilePicture
                                    name={profile.name}
                                    picture={profile.picture}
                                    color={profile.color}
                                  />
                                ) : (
                                  <BrowserLogo id={source.id} name={profile.name} />
                                )
                              }
                              title={profile.name}
                              description={
                                alreadyImported
                                  ? [source.name, profile.email].filter(Boolean).join(" · ")
                                  : source.unavailable === "browserRunning"
                                    ? RUNNING_BROWSER_COPY
                                    : source.unavailable
                                      ? BROWSER_IMPORT_FAILURE_COPY[source.unavailable]
                                      : [source.name, profile.email].filter(Boolean).join(" · ")
                              }
                              action={
                                alreadyImported ? (
                                  <span className="text-xs text-muted-foreground">Imported</span>
                                ) : (
                                  <span
                                    aria-hidden
                                    className={`flex size-4 shrink-0 items-center justify-center rounded border ${checked ? "border-primary bg-primary text-primary-foreground" : "border-input"}`}
                                  >
                                    {checked ? <CheckIcon className="size-3" /> : null}
                                  </span>
                                )
                              }
                              onClick={() =>
                                setSelected((current) => {
                                  const next = new Set(current);
                                  if (next.has(key)) next.delete(key);
                                  else next.add(key);
                                  return next;
                                })
                              }
                            />
                          );
                        }),
                  )}
                {loaded &&
                sources.every(
                  (source) =>
                    source.unavailable === "notInstalled" ||
                    (source.profiles.length === 0 && source.unavailable !== "needsFullDiskAccess"),
                ) ? (
                  <div className="px-3 py-3 text-sm text-muted-foreground">No browsers found</div>
                ) : null}
              </DiscoveryList>
              {permission.error ? (
                <p role="status" className="mt-2 text-xs text-muted-foreground">
                  {permission.error}
                </p>
              ) : null}
            </DialogPanel>
            <DialogFooter>
              <Button variant="outline" disabled={busy} onClick={onClose}>
                Cancel
              </Button>
              <Button
                disabled={busy || !canWrite || selected.size === 0}
                onClick={() => void runImport()}
              >
                Import ({selected.size})
              </Button>
            </DialogFooter>
          </>
        )}
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
  // oxlint-disable-next-line t3code/react-effect-budget -- Once saved profiles load, link profiles imported before Accounts to their source browser profile.
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
      titleAction={
        <Menu>
          <MenuTrigger
            render={
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label="Add profile"
                disabled={disabled || settings.browserProfiles.length >= BROWSER_PROFILE_MAX_COUNT}
              />
            }
          >
            <PlusIcon />
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
              New profile
            </MenuItem>
            {previewBridge ? <MenuItem onClick={onImport}>Import from a browser…</MenuItem> : null}
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
                  className="grid min-w-0 gap-1 text-left outline-none focus-visible:underline"
                  onClick={() => setViewingSites(profile.id)}
                >
                  <span className="flex items-center gap-2">
                    <span className="truncate text-sm text-foreground">{profile.name}</span>
                    {settings.browserDefaultProfileId === profile.id ? (
                      <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                        New tabs
                      </span>
                    ) : null}
                  </span>
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
                  Share with scripts
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
                  Use for new tabs
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
          <DialogPopup data-accounts-dialog>
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
