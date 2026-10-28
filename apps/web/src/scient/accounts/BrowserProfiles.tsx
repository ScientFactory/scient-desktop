import { clickableAccountRow } from "./clickableAccountRow";
import { usePrimaryEnvironmentId } from "~/state/environments";
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
  type ClientSettings,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { Input } from "~/components/ui/input";
import { DraftInput } from "~/components/ui/draft-input";
import { ArrowRightIcon, CheckIcon, ChevronRightIcon, PlusIcon, RefreshCwIcon } from "lucide-react";
import { Menu, MenuTrigger, MenuPopup, MenuItem, MenuCheckboxItem } from "~/components/ui/menu";
import { QuitStep } from "~/components/settings/BrowserImportWizard";
import { usePermissionStatus } from "~/components/permissions/usePermissionStatus";
import { AccountLogo } from "./AccountLogo";
import { Collapsible, CollapsibleTrigger, CollapsiblePanel } from "~/components/ui/collapsible";
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
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
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
  changedSourceProfile,
} from "./accountsView";

const RUNNING_BROWSER_COPY = "open, quit to import";

const decodeProfileUpdate = Schema.decodeOption(BrowserProfileRecordUpdateInput);

type SourceMatch = NonNullable<ReturnType<typeof matchExistingProfile>>;

/** Links a Scient profile to the browser profile it came from, with that profile's picture. */
function sourceRecord(
  profileId: string,
  browser: SourceMatch["source"]["id"],
  profile: SourceMatch["profile"],
  importedAt = DateTime.formatIso(DateTime.nowUnsafe()),
) {
  return decodeProfileUpdate({
    profileId,
    ...(profile.picture ? { picture: profile.picture } : {}),
    ...(profile.color ? { color: profile.color } : {}),
    source: {
      browser,
      profileName: profile.name,
      directory: profile.directory,
      ...(profile.email ? { email: profile.email } : {}),
      importedAt,
    },
  });
}

function BrowserLogo({ id, name }: { id: string; name: string }) {
  const icon = browserIconUrl(id);
  return icon ? (
    <AccountLogo src={icon} className="size-10 rounded-[25%]" />
  ) : (
    <ProfilePicture name={name} />
  );
}

/**
 * The built-in Main profile is only the starting point: once the user has a profile of their
 * own, the first one opens new tabs instead.
 */
function withOwnDefault(current: ClientSettings): ClientSettings {
  const own = current.browserProfiles.filter((profile) => profile.kind === "persistent");
  return current.browserDefaultProfileId === DEFAULT_BROWSER_PROFILE_ID && own[0]
    ? { ...current, browserDefaultProfileId: own[0].id }
    : current;
}

/** One browser import at a time, even after its dialog closed and was opened again. */
let importRunning = false;

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
  const [passwords, setPasswords] = useState(true);
  // Only the local desktop can read another browser's saved passwords.
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const readPasswords =
    environmentId === primaryEnvironmentId
      ? window.desktopBridge?.accounts?.readBrowserPasswords
      : undefined;
  const importPasswords = useAccountCommand(accountsState.importPasswords, environmentId);
  const [loaded, setLoaded] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  // Closing never stops an import: it finishes in the background and reports in a toast.
  const closed = useRef(false);
  const close = () => {
    closed.current = true;
    if (busy) toastManager.add({ type: "info", title: "The import continues in the background" });
    onClose();
  };
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
        (item.source.directory
          ? item.source.directory === profile.directory
          : item.source.profileName === profile.name && item.source.email === profile.email),
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
  const selectedProfiles = sources.flatMap((source) =>
    source.profiles.filter((profile) =>
      selected.has(JSON.stringify([source.id, profile.directory])),
    ),
  );
  // Chromium profiles carry a count; other browsers' passwords come from their CSV exports.
  const withPasswords = selectedProfiles.filter((profile) => profile.passwordCount !== undefined);
  const selectedPasswordCount = withPasswords.length
    ? withPasswords.reduce((sum, profile) => sum + (profile.passwordCount ?? 0), 0)
    : undefined;
  const runImport = async (loaded = sources) => {
    if (!canWrite || !previewBridge) return;
    if (importRunning) {
      toastManager.add({ type: "info", title: "A browser import is already running" });
      return;
    }
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
    importRunning = true;
    setBusy(true);
    const done = new Set<string>();
    const passwordSources: Array<{ sourceId: (typeof loaded)[number]["id"]; directory: string }> =
      [];
    const passwordTotals = { imported: 0, skipped: 0, failed: false };
    try {
      for (const source of loaded)
        for (const profile of source.profiles) {
          const key = JSON.stringify([source.id, profile.directory]);
          if (!selected.has(key) || source.unavailable) continue;
          // A profile imported before keeps its sign-ins; only its passwords can still come in.
          if (!isImported(source, profile)) {
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
              toastManager.add({
                type: "error",
                title: BROWSER_IMPORT_FAILURE_COPY[outcome.reason],
              });
              continue;
            }
            // Before the passwords: an interrupted import still leaves a complete profile.
            const record = sourceRecord(profileId, source.id, profile);
            if (Option.isSome(record)) await updateRecord(record.value);
            else profileError();
          }
          done.add(key);
          if (passwords && readPasswords && profile.passwordCount !== undefined)
            passwordSources.push({ sourceId: source.id, directory: profile.directory });
        }
      if (done.size > 0) void persistClientSettingsUpdate(withOwnDefault).catch(profileError);
      for (const input of passwordSources) {
        const csv = (await readPasswords?.(input).catch(() => null)) ?? null;
        const result = csv
          ? await importPasswords({ format: "chrome", content: csv.content })
          : null;
        if (csv && result?.ok) {
          passwordTotals.imported += result.value.created + result.value.updated;
          passwordTotals.skipped += csv.skipped + result.value.skipped;
        } else passwordTotals.failed = true;
      }
      if (passwordTotals.failed)
        toastManager.add({ type: "error", title: "Could not import saved passwords" });
      else if (passwordTotals.imported || passwordTotals.skipped)
        toastManager.add({
          type: "success",
          title: passwordTotals.skipped
            ? `Imported ${passwordTotals.imported} passwords, ${passwordTotals.skipped} skipped`
            : `Imported ${passwordTotals.imported} passwords`,
        });
      setImported((current) => new Set([...current, ...done]));
      setSelected((current) => new Set([...current].filter((key) => !done.has(key))));
      if (!closed.current && done.size === selected.size) onClose();
    } catch {
      profileError();
    }
    importRunning = false;
    setBusy(false);
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close();
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
            <DialogPanel scrollAreaClassName="min-h-0 flex-1">
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
                          const passwordsOnly =
                            alreadyImported &&
                            !!readPasswords &&
                            profile.passwordCount !== undefined;
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
                                (alreadyImported && !passwordsOnly) ||
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
                                  ? [source.name, profile.email, passwordsOnly && "Imported"]
                                      .filter(Boolean)
                                      .join(" · ")
                                  : source.unavailable === "browserRunning"
                                    ? `${source.name} · ${RUNNING_BROWSER_COPY}`
                                    : source.unavailable
                                      ? BROWSER_IMPORT_FAILURE_COPY[source.unavailable]
                                      : [source.name, profile.email].filter(Boolean).join(" · ")
                              }
                              action={
                                alreadyImported && !passwordsOnly ? (
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
                {sources.some((source) => source.unavailable === "notInstalled") ? (
                  <Collapsible>
                    <CollapsibleTrigger
                      render={
                        <DiscoveryListRow
                          icon={null}
                          title={<span className="text-muted-foreground">More browsers</span>}
                          description={null}
                          action={
                            <ChevronRightIcon className="size-4 text-muted-foreground in-data-panel-open:rotate-90" />
                          }
                        />
                      }
                    />
                    <CollapsiblePanel animate={false}>
                      {sources
                        .filter((source) => source.unavailable === "notInstalled")
                        .map((source) => (
                          <div
                            key={source.id}
                            className="flex items-center gap-3 border-t border-border/60 px-3 py-3"
                          >
                            <BrowserLogo id={source.id} name={source.name} />
                            <div className="flex min-w-0 flex-1 flex-col">
                              <span className="truncate text-sm font-medium">{source.name}</span>
                              <span className="text-xs text-muted-foreground">Not installed</span>
                            </div>
                          </div>
                        ))}
                    </CollapsiblePanel>
                  </Collapsible>
                ) : null}
              </DiscoveryList>
              {readPasswords && selectedPasswordCount !== undefined ? (
                <label className="flex items-center gap-2 py-3 text-sm">
                  <Checkbox
                    checked={passwords}
                    onCheckedChange={setPasswords}
                    disabled={busy || !canWrite}
                  />
                  Also import saved passwords ({selectedPasswordCount})
                </label>
              ) : null}
              {permission.error ? (
                <p role="status" className="mt-2 text-xs text-muted-foreground">
                  {permission.error}
                </p>
              ) : null}
            </DialogPanel>
            <DialogFooter>
              <Button variant="outline" onClick={close}>
                {busy ? "Close" : "Cancel"}
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
  const importPasswords = useAccountCommand(accountsState.importPasswords, environmentId);
  // Only the local desktop can read another browser's saved passwords.
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const readPasswords =
    environmentId === primaryEnvironmentId
      ? window.desktopBridge?.accounts?.readBrowserPasswords
      : undefined;
  const [renaming, setRenaming] = useState<string | null>(null);
  const [viewingSites, setViewingSites] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const profiles = mergeProfiles(settings.browserProfiles, snapshot.profiles).filter(
    (profile) =>
      profile.id !== DEFAULT_BROWSER_PROFILE_ID ||
      settings.browserProfiles.length === 0 ||
      settings.browserDefaultProfileId === DEFAULT_BROWSER_PROFILE_ID,
  );
  const disabled = !canWrite || !hydrated || busy;
  const linkedProfiles = profiles.filter((profile) => profile.record.source);
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
  const loadSources = async () =>
    previewBridge
      ? mergeSourceProfiles(
          await previewBridge.listBrowserImportSources(),
          (await window.desktopBridge?.accounts?.sourceProfiles().catch(() => [])) ?? [],
        )
      : [];
  // A profile still named after its source follows a rename there; a name chosen in Scient stays.
  const followSourceNames = (renames: ReadonlyArray<{ id: string; from: string; to: string }>) =>
    renames.length
      ? changeSettings((current) => ({
          ...current,
          browserProfiles: current.browserProfiles.map((profile) => {
            const rename = renames.find(
              (rename) => rename.id === profile.id && rename.from === profile.name,
            );
            return rename
              ? {
                  ...profile,
                  name: importProfileName(
                    rename.to,
                    current.browserProfiles
                      .filter((other) => other.id !== profile.id)
                      .map((other) => other.name),
                  ),
                }
              : profile;
          }),
        }))
      : Promise.resolve();
  /** Everything the source browser has for these profiles: sign-ins, saved passwords and details. */
  const refresh = async (targets: ReadonlyArray<{ id: string; record: BrowserProfileRecord }>) => {
    if (!previewBridge) return;
    const sources = await loadSources();
    const running = new Set<string>();
    const renames: Array<{ id: string; from: string; to: string }> = [];
    let failed = false;
    for (const { id, record } of targets) {
      const linked = record.source;
      const source = sources.find((source) => source.id === linked?.browser);
      const profile = source?.profiles.find((profile) =>
        linked?.directory
          ? profile.directory === linked.directory
          : profile.name === linked?.profileName,
      );
      if (!linked || !source || !profile) {
        failed = true;
        continue;
      }
      // Sign-ins can only be read once the browser is closed; passwords and details can now.
      if (source.unavailable === "browserRunning") running.add(source.name);
      else if (source.unavailable) failed = true;
      else {
        const result = await importBrowserCookiesIntoTarget(previewBridge, source, environmentId, {
          sourceProfileDirectory: profile.directory,
          target: { kind: "existing", profileId: id, name: linked.profileName },
        });
        if (result.kind === "blocked") failed = true;
      }
      const metadata = sourceRecord(id, source.id, profile, linked.importedAt);
      if (Option.isSome(metadata)) await updateRecord(metadata.value);
      if (profile.name !== linked.profileName)
        renames.push({ id, from: linked.profileName, to: profile.name });
      if (readPasswords && profile.passwordCount !== undefined) {
        const csv = await readPasswords({
          sourceId: source.id,
          directory: profile.directory,
        }).catch(() => null);
        const result = csv
          ? await importPasswords({ format: "chrome", content: csv.content })
          : null;
        if (!result?.ok) failed = true;
      }
    }
    await followSourceNames(renames);
    if (failed) profileError();
    else if (running.size)
      toastManager.add({
        type: "info",
        title: `Quit ${[...running].join(" and ")} to refresh sign-ins too`,
        description: "Passwords, pictures and names are up to date.",
      });
    else toastManager.add({ type: "success", title: "Browser profiles refreshed" });
  };
  const linkSource = async (profileId: string, match: SourceMatch) => {
    const metadata = sourceRecord(profileId, match.source.id, match.profile);
    if (Option.isSome(metadata)) await updateRecord(metadata.value);
  };
  const [linking, setLinking] = useState<string | null>(null);
  const [sources, setSources] = useState<Awaited<ReturnType<typeof loadSources>>>([]);
  const profileIds = profiles.map((profile) => profile.id).join("\u0001");
  // Linked profiles follow their source's picture, colour and name; older imports get linked once.
  const syncSources = useEffectEvent((loaded: Awaited<ReturnType<typeof loadSources>>) => {
    setSources(loaded);
    const renames: Array<{ id: string; from: string; to: string }> = [];
    for (const profile of profiles) {
      if (isBuiltInBrowserProfileId(profile.id)) continue;
      const linked = profile.record.source;
      if (linked) {
        const changed = changedSourceProfile(profile.record, loaded);
        const record =
          changed && sourceRecord(profile.id, linked.browser, changed, linked.importedAt);
        if (record && Option.isSome(record)) void updateRecord(record.value);
        if (changed && changed.name !== linked.profileName)
          renames.push({ id: profile.id, from: linked.profileName, to: changed.name });
        continue;
      }
      const match = matchExistingProfile(profile.name, loaded);
      if (match) void linkSource(profile.id, match);
    }
    void followSourceNames(renames);
  });
  const fetchSources = useEffectEvent(loadSources);
  // oxlint-disable-next-line t3code/react-effect-budget -- Each time Accounts opens, read what the source browsers show without quitting them: names, emails, pictures and colours.
  useEffect(() => {
    if (!canWrite || !hydrated || profileIds === "") return;
    let live = true;
    void fetchSources()
      .then((loaded) => {
        if (live) syncSources(loaded);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [canWrite, hydrated, profileIds]);
  return (
    <SettingsSection
      id="accounts-browser-profiles"
      title="Browser profiles"
      titleAction={
        <span className="flex items-center gap-1">
          <Menu>
            <MenuTrigger
              render={
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-label="Add profile"
                  disabled={
                    disabled || settings.browserProfiles.length >= BROWSER_PROFILE_MAX_COUNT
                  }
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
                      if (current.browserProfiles.length >= BROWSER_PROFILE_MAX_COUNT)
                        return current;
                      return withOwnDefault({
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
                      });
                    });
                  })
                }
              >
                New profile
              </MenuItem>
              {previewBridge ? (
                <MenuItem onClick={onImport}>Import from a browser…</MenuItem>
              ) : null}
            </MenuPopup>
          </Menu>
          {previewBridge && linkedProfiles.length ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    aria-label="Refresh from browsers"
                    disabled={disabled}
                    onClick={() => void act(() => refresh(linkedProfiles))}
                  />
                }
              >
                <RefreshCwIcon className={busy ? "animate-spin" : undefined} />
              </TooltipTrigger>
              <TooltipPopup>
                Refresh sign-ins, passwords and pictures from your browsers
              </TooltipPopup>
            </Tooltip>
          ) : null}
        </span>
      }
    >
      {profiles.map((profile) => (
        <SettingsRow
          key={profile.id}
          {...clickableAccountRow(() => setViewingSites(profile.id))}
          aria-label={`Signed-in sites for ${profile.name}`}
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
                <span className="grid min-w-0 gap-1 text-left">
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
                </span>
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
                  <MenuItem onClick={() => void act(() => refresh([profile]))}>
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
                        await persistClientSettingsUpdate((current) =>
                          withOwnDefault({
                            ...current,
                            browserProfiles: current.browserProfiles.filter(
                              (item) => item.id !== profile.id,
                            ),
                            ...(current.browserDefaultProfileId === profile.id
                              ? { browserDefaultProfileId: DEFAULT_BROWSER_PROFILE_ID }
                              : {}),
                          }),
                        );
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
