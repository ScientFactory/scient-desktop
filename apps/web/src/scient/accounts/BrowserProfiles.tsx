import { clickableAccountRow } from "./clickableAccountRow";
import { useEnvironment, usePrimaryEnvironmentId } from "~/state/environments";
import * as DateTime from "effect/DateTime";
import { useEffect, useEffectEvent, useState, useSyncExternalStore, type ReactNode } from "react";
import {
  BROWSER_IMPORT_FAILURE_COPY,
  BROWSER_PROFILE_MAX_COUNT,
  BROWSER_PROFILE_NAME_MAX_LENGTH,
  BrowserProfileRecordUpdateInput,
  DEFAULT_BROWSER_PROFILE_ID,
  BrowserProfileId,
  GOOGLE_SITE,
  isBuiltInBrowserProfileId,
  type AccountsSnapshot,
  type AccountSummary,
  type EnvironmentId,
  type BrowserProfileRecord,
} from "@t3tools/contracts";
import { sitesNest } from "@t3tools/shared/scientSiteMatch";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { Input } from "~/components/ui/input";
import { DraftInput } from "~/components/ui/draft-input";
import {
  ArrowRightIcon,
  CheckIcon,
  ChevronRightIcon,
  InfoIcon,
  PlusIcon,
  RefreshCwIcon,
  XIcon,
} from "lucide-react";
import { Menu, MenuTrigger, MenuPopup, MenuItem, MenuCheckboxItem } from "~/components/ui/menu";
import { QuitStep } from "~/components/settings/BrowserImportWizard";
import { usePermissionStatus } from "~/components/permissions/usePermissionStatus";
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
import { useForgetBrowserProfile } from "~/scient/browser/useForgetBrowserProfile";
import { useEnvironments } from "~/state/environments";
import { useServerConfigs } from "~/state/entities";
import { previewEnvironment } from "~/state/preview";
import { useAtomCommand } from "~/state/use-atom-command";
import { randomUUID } from "~/lib/utils";
import { readLocalApi } from "~/localApi";
import { toastManager } from "~/components/ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { accountsState } from "./accountsState";
import { addBrowserProfile } from "./addBrowserProfile";
import { recordImportedSessions } from "./importedSessions";
import { copySignInIntoMain } from "./mainFill";
import { ProfilePicture } from "./ProfilePicture";
import { useAccountCommand } from "./useAccounts";
import { AccessChip, ControlsMenu, ScopeSubmenu } from "./AccountControls";
import {
  browserName,
  importProfileName,
  mergeProfiles,
  matchExistingProfile,
  mergeSourceProfiles,
  changedSourceProfile,
  foldedNotice,
  loadSourceProfiles,
  cookiesLabel,
  importedLabel,
  renamedSourceLabel,
  signedOutOfGoogle,
  isBrowserSignIn,
  unlistedProfiles,
  sitesToKeep,
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

/** One browser import at a time, even after its dialog closed and was opened again. */
let importRunning = false;

/** Whether a browser import is still adding saved passwords, for the Accounts page to say so. */
let importingPasswords = false;
const importingPasswordsListeners = new Set<() => void>();
function setImportingPasswords(value: boolean) {
  importingPasswords = value;
  for (const listener of importingPasswordsListeners) listener();
}
export function useImportingPasswords() {
  return useSyncExternalStore(
    (listener) => {
      importingPasswordsListeners.add(listener);
      return () => importingPasswordsListeners.delete(listener);
    },
    () => importingPasswords,
  );
}

function profileError() {
  toastManager.add({ type: "error", title: "Browser profile action failed" });
}

type RenderSignIn = (account: AccountSummary, menu: ReactNode) => ReactNode;

/** A profile's browser sign-ins: the rows naming it, Main's also those naming no profile. */
const signInsOf = (accounts: ReadonlyArray<AccountSummary>, profileId: string) =>
  accounts.filter(
    (account) =>
      isBrowserSignIn(account) &&
      account.details.kind === "website" &&
      (account.details.profileId ?? DEFAULT_BROWSER_PROFILE_ID) === profileId,
  );

const rowSites = (row: AccountSummary) => ("sites" in row.details ? row.details.sites : []);

/** The sites a profile's jar holds cookies for that none of its sign-in rows names. */
const unlistedSites = (
  rows: ReadonlyArray<AccountSummary>,
  sites: ReadonlyArray<{ domain: string }>,
) => sites.filter((site) => !rows.some((row) => sitesNest([site.domain], rowSites(row))));

/** How many sites a profile's list shows: its sign-ins' sites, then its other cookie sites. */
const siteCount = (rows: ReadonlyArray<AccountSummary>, sites: ReadonlyArray<{ domain: string }>) =>
  new Set(rows.map((row) => rowSites(row)[0] ?? row.accountId)).size +
  unlistedSites(rows, sites).length;

/** A profile's cookie sites, read from the computer that holds them, again on each sign-in change. */
function useProfileSites(profileId: string, environmentId: EnvironmentId) {
  const [sites, setSites] = useState<ReadonlyArray<{ domain: string }> | null>(null);
  // Another computer's sign-ins live in its own browser, not in this desktop's partitions.
  const remote = environmentId !== usePrimaryEnvironmentId();
  const listRemote = useAccountCommand(accountsState.sessionsList, environmentId);
  const load = useEffectEvent(() =>
    (remote
      ? listRemote({ profileId: BrowserProfileId.make(profileId) }).then((listed) =>
          listed.ok ? listed.value.sites.map(({ site }) => ({ domain: site })) : [],
        )
      : window.desktopBridge?.accounts?.signedInSites(profileId, environmentId)
    )
      ?.then(setSites)
      .catch(() => setSites([])),
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Read this profile's signed-in sites from the computer that holds them, and again when a sign-in changes.
  useEffect(() => {
    void load();
    const reload = () => void load();
    window.addEventListener("scient-accounts-session-changed", reload);
    return () => window.removeEventListener("scient-accounts-session-changed", reload);
  }, []);
  return { sites, remote, reload: () => load() };
}

/** What a profile row says it holds: the same sites its list shows. */
function SitesCount({
  profileId,
  environmentId,
  rows,
}: {
  profileId: string;
  environmentId: EnvironmentId;
  rows: ReadonlyArray<AccountSummary>;
}) {
  const { sites } = useProfileSites(profileId, environmentId);
  const count = siteCount(rows, sites ?? []);
  if (count === 0) return null;
  return (
    <span className="text-xs text-muted-foreground">
      {count === 1 ? "1 site" : `${count} sites`} ›
    </span>
  );
}

/**
 * A profile's sites: its sign-ins as rows, each with its access and status, then the other sites
 * its jar holds cookies for. Either can be signed out of here.
 */
function SignedInSitesDialog({
  profile,
  environmentId,
  canWrite,
  rows,
  renderSignIn,
  onClose,
}: {
  profile: { id: string; name: string; record: BrowserProfileRecord };
  environmentId: EnvironmentId;
  canWrite: boolean;
  rows: ReadonlyArray<AccountSummary>;
  renderSignIn: RenderSignIn;
  onClose: () => void;
}) {
  const { sites, remote, reload } = useProfileSites(profile.id, environmentId);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const remoteLabel = useEnvironment(environmentId)?.label ?? "this computer";
  const sender = profile.record.received?.[0]?.label;
  const signOutRemote = useAccountCommand(accountsState.sessionsSignOutLocal, environmentId);
  const recordSignOut = useAccountCommand(accountsState.profileSignedOut, environmentId);
  const signOut = async (site: string) => {
    setBusy(site);
    const accounts = window.desktopBridge?.accounts;
    const profileId = BrowserProfileId.make(profile.id);
    // Recorded first: other computers then delete the site too, and Main never gets it back.
    const done = remote
      ? (await signOutRemote({ profileId, site })).ok
      : (await recordSignOut({ profileId, site })).ok &&
        (profile.id === DEFAULT_BROWSER_PROFILE_ID
          ? await accounts?.signOutMainSite?.(site, environmentId).catch(() => false)
          : await accounts?.signOutSite?.(profile.id, site, environmentId).catch(() => false));
    if (!done) profileError();
    // Every count and list of this profile reads again, this one too.
    else window.dispatchEvent(new Event("scient-accounts-session-changed"));
    if (!done) await reload();
    setBusy(null);
  };
  const canSignOut = remote || window.desktopBridge?.accounts?.signOutSite !== undefined;
  const find = query.trim().toLowerCase();
  const cookieSiteOf = (row: AccountSummary) =>
    sites?.find((site) => sitesNest([site.domain], rowSites(row)))?.domain;
  const shownRows = rows.filter(
    (row) =>
      row.name.toLowerCase().includes(find) ||
      rowSites(row).some((site) => site.toLowerCase().includes(find)),
  );
  const others = unlistedSites(rows, sites ?? []);
  const shown = others.filter((site) => site.domain.includes(find));
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogPopup data-accounts-dialog>
        <DialogHeader>
          <div className="flex items-center gap-3">
            <ProfilePicture
              name={profile.name}
              picture={profile.record.picture}
              color={profile.record.color}
              id={profile.id}
              browser={profile.record.source?.browser}
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
              placeholder={sites ? `${siteCount(rows, sites)} signed-in sites` : "Signed-in sites"}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            <div className="max-h-96 overflow-y-auto rounded-lg border">
              {shownRows.map((row) => {
                const cookieSite = cookieSiteOf(row);
                return renderSignIn(
                  row,
                  canSignOut && cookieSite ? (
                    <MenuItem
                      disabled={!canWrite || busy !== null}
                      onClick={() => void signOut(cookieSite)}
                    >
                      Sign out of {cookieSite}
                    </MenuItem>
                  ) : null,
                );
              })}
              {shown.map((site) => (
                <div
                  key={site.domain}
                  className="group flex items-center justify-between gap-3 border-b px-3 py-1.5 text-sm last:border-b-0"
                >
                  <span className="truncate">{site.domain}</span>
                  {canSignOut ? (
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
              {sites && shown.length === 0 && shownRows.length === 0 ? (
                <div className="px-3 py-6 text-center text-sm text-muted-foreground">
                  No sign-ins
                </div>
              ) : null}
            </div>
            {remote && sender ? (
              <p className="text-sm text-muted-foreground">
                Signs out on {remoteLabel}. {sender}'s next sign-in to this site copies it again.
              </p>
            ) : null}
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
  const close = () => {
    if (busy) toastManager.add({ type: "info", title: "The import continues in the background" });
    onClose();
  };
  const updateRecord = useAccountCommand(accountsState.updateProfile, environmentId);
  const [quitting, setQuitting] = useState<ReturnType<typeof mergeSourceProfiles>[number] | null>(
    null,
  );
  // What each profile imported here brought, by its key.
  const [brought, setBrought] = useState<ReadonlyMap<string, string>>(new Map());
  const passwordsImporting = useImportingPasswords();
  const linkedProfile = (
    source: ReturnType<typeof mergeSourceProfiles>[number],
    profile: (typeof source.profiles)[number],
  ) =>
    snapshot.profiles.find(
      (item) =>
        item.source?.browser === source.id &&
        (item.source.directory
          ? item.source.directory === profile.directory
          : item.source.profileName === profile.name && item.source.email === profile.email),
    )?.profileId;
  const isImported = (
    source: ReturnType<typeof mergeSourceProfiles>[number],
    profile: (typeof source.profiles)[number],
  ) =>
    brought.has(JSON.stringify([source.id, profile.directory])) ||
    linkedProfile(source, profile) !== undefined;
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
    const passwordSources: Array<{
      sourceId: (typeof loaded)[number]["id"];
      directory: string;
      profileId: string | undefined;
    }> = [];
    const passwordTotals = { imported: 0, skipped: 0, failed: false };
    const sessionsFrom: Array<{ profileId: string; from: string; filled: boolean }> = [];
    try {
      for (const source of loaded)
        for (const profile of source.profiles) {
          const key = JSON.stringify([source.id, profile.directory]);
          if (!selected.has(key) || source.unavailable) continue;
          let profileId: string | undefined = linkedProfile(source, profile);
          // A profile imported before keeps its sign-ins; only its passwords can still come in.
          if (!isImported(source, profile)) {
            profileId = `profile-${randomUUID()}`;
            const outcome = await importBrowserCookiesIntoTarget(
              previewBridge,
              source,
              environmentId,
              {
                sourceProfileDirectory: profile.directory,
                target: { kind: "new", profileId },
                profileName: profile.name,
                fillMain: false,
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
            const label = importedLabel(outcome.imported, outcome.importedSites);
            setBrought((current) => new Map(current).set(key, label));
          }
          done.add(key);
          if (profileId !== undefined)
            sessionsFrom.push({
              profileId,
              from: `${source.name} · ${profile.name}`,
              filled: !isImported(source, profile),
            });
          if (passwords && readPasswords && profile.passwordCount !== undefined)
            passwordSources.push({ sourceId: source.id, directory: profile.directory, profileId });
        }
      if (passwordSources.length) setImportingPasswords(true);
      for (const { profileId, ...input } of passwordSources) {
        const csv = (await readPasswords?.(input).catch(() => null)) ?? null;
        const result = csv
          ? await importPasswords({
              format: "chrome",
              content: csv.content,
              ...(profileId === undefined ? {} : { profileId: BrowserProfileId.make(profileId) }),
            })
          : null;
        if (csv && result?.ok) {
          passwordTotals.imported += result.value.created + result.value.updated;
          passwordTotals.skipped += csv.skipped + result.value.skipped;
        } else passwordTotals.failed = true;
      }
      // After the passwords: a site with a saved password is one whose session gets a row.
      for (const { profileId, from, filled } of sessionsFrom)
        await recordImportedSessions(environmentId, profileId, from, { fillMain: filled });
      if (passwordTotals.failed)
        toastManager.add({ type: "error", title: "Could not import saved passwords" });
      else if (passwordTotals.imported || passwordTotals.skipped)
        toastManager.add({
          type: "success",
          title: passwordTotals.skipped
            ? `Imported ${passwordTotals.imported} passwords, ${passwordTotals.skipped} skipped`
            : `Imported ${passwordTotals.imported} passwords`,
        });
      setSelected((current) => new Set([...current].filter((key) => !done.has(key))));
    } catch {
      profileError();
    }
    setImportingPasswords(false);
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
                            <ProfilePicture name={source.name} browser={source.id} />
                            <span className="grid min-w-0 flex-1 text-sm">
                              <span>{source.name}</span>
                              <span className="text-xs text-muted-foreground">
                                Needs Full Disk Access to see what it holds
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
                                <ProfilePicture
                                  name={profile.name}
                                  picture={profile.picture}
                                  color={profile.color}
                                  browser={source.id}
                                />
                              }
                              title={profile.name}
                              description={
                                alreadyImported
                                  ? [
                                      source.name,
                                      profile.email,
                                      brought.get(key) ?? (passwordsOnly && "Imported"),
                                    ]
                                      .filter(Boolean)
                                      .join(" · ")
                                  : source.unavailable === "browserRunning"
                                    ? `${source.name} · ${RUNNING_BROWSER_COPY}`
                                    : source.unavailable
                                      ? BROWSER_IMPORT_FAILURE_COPY[source.unavailable]
                                      : [
                                          source.name,
                                          profile.email,
                                          cookiesLabel(profile.cookieCount),
                                        ]
                                          .filter(Boolean)
                                          .join(" · ")
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
                            <ProfilePicture name={source.name} browser={source.id} />
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
              {passwordsImporting ? (
                <p role="status" className="py-3 text-sm text-muted-foreground">
                  Importing saved passwords…
                </p>
              ) : readPasswords && selectedPasswordCount !== undefined ? (
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
                {busy || brought.size ? "Close" : "Cancel"}
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

/** After a renamed imported profile's name: where it came from, "· Chrome · Yaacov". */
function RenamedSource({ name, source }: { name: string; source: BrowserProfileRecord["source"] }) {
  const label = renamedSourceLabel(name, source);
  return label ? (
    <span className="min-w-0 truncate text-xs text-muted-foreground">· {label}</span>
  ) : null;
}

/** Google signed this profile out; Google refuses signing in from Scient's browser, so the way back is a browser's sign-in. */
export const GOOGLE_SIGNED_OUT = "Signed out of Google.";
const GOOGLE_REFUSES = "Google doesn't allow signing in inside Scient.";

/**
 * What a signed-out profile does: bring the browser's Google sign-in in again. A profile with no
 * browser behind it, Main, copies another profile's working Google, or else imports one.
 */
export function googleRecovery(
  source: BrowserProfileRecord["source"],
  actions: {
    readonly refresh: () => void;
    readonly importProfile: () => void;
    readonly copyFrom?: { readonly name: string; readonly run: () => void } | undefined;
  },
) {
  if (!source)
    return actions.copyFrom
      ? {
          message: GOOGLE_SIGNED_OUT,
          hint: `${GOOGLE_REFUSES} Main can use ${actions.copyFrom.name}'s Google, which works.`,
          action: `Copy from ${actions.copyFrom.name}`,
          onAction: actions.copyFrom.run,
        }
      : {
          message: GOOGLE_SIGNED_OUT,
          hint: `${GOOGLE_REFUSES} Import a browser profile that's signed in to Google.`,
          action: "Import from a browser…",
          onAction: actions.importProfile,
        };
  const browser = browserName(source.browser);
  return {
    message: GOOGLE_SIGNED_OUT,
    hint: `${GOOGLE_REFUSES} Refresh brings ${browser}'s sign-in. If ${browser} is signed out too, sign in to Google there first.`,
    action: `Refresh from ${browser}`,
    onAction: actions.refresh,
  };
}

/** The line under a profile's name: its address and, when Google refused it, a way back in. */
export function ProfileDetail({
  email,
  signedOut,
  recover,
}: {
  email: string | undefined;
  signedOut: boolean;
  recover?: ReturnType<typeof googleRecovery> | undefined;
}) {
  if (!email && !signedOut) return null;
  if (signedOut && recover)
    return (
      <span className="flex min-w-0 flex-wrap items-center gap-x-1 text-xs text-muted-foreground">
        {email ? <span className="max-w-full truncate">{email} ·</span> : null}
        <span>{recover.message}</span>
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                aria-label="Why signed out of Google"
                onClick={(event) => event.stopPropagation()}
                className="inline-flex shrink-0 text-muted-foreground hover:text-foreground"
              />
            }
          >
            <InfoIcon className="size-3" />
          </TooltipTrigger>
          <TooltipPopup className="max-w-64">{recover.hint}</TooltipPopup>
        </Tooltip>
        <Button size="micro" variant="link" className="-my-0.5 shrink-0" onClick={recover.onAction}>
          <span className="text-xs text-foreground">{recover.action}</span>
        </Button>
      </span>
    );
  return (
    <span className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
      {email ? <span className="truncate">{email}</span> : null}
      {signedOut ? <span className="shrink-0">{email ? "· " : ""}Signed out of Google</span> : null}
    </span>
  );
}

export function BrowserProfiles({
  environmentId,
  snapshot,
  canWrite,
  onImport,
  renderSignIn,
}: {
  environmentId: EnvironmentId;
  snapshot: AccountsSnapshot;
  canWrite: boolean;
  /** A sign-in's row in its profile's sites, with `menu` added to the row's own. */
  renderSignIn: RenderSignIn;
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
  const retireRecord = useAccountCommand(accountsState.retireProfile, environmentId);
  const removeRecord = useAccountCommand(accountsState.removeProfile, environmentId);
  const forgetBrowsing = useForgetBrowserProfile();
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
  const listed = mergeProfiles(settings.browserProfiles, snapshot.profiles);
  const unlisted = unlistedProfiles(snapshot, listed);
  const isUnlisted = (profileId: string) => unlisted.some((profile) => profile.id === profileId);
  const profiles = [...listed, ...unlisted];
  const disabled = !canWrite || !hydrated || busy;
  const linkedProfiles = listed.filter((profile) => profile.record.source);
  const folded = foldedNotice(snapshot, DateTime.nowUnsafe().epochMilliseconds);
  /** Each profile back in use; it was never off this client's list. Stops at the first failure. */
  const undoFold = async (merged: ReadonlyArray<{ profileId: string }>) => {
    for (const { profileId } of merged)
      if (!(await retireRecord({ profileId: BrowserProfileId.make(profileId), undo: true })).ok)
        return;
  };
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
  /** For Main signed out of Google: another listed profile whose Google works, to copy from. */
  const googleToCopy = (profileId: string) => {
    if (profileId !== DEFAULT_BROWSER_PROFILE_ID) return undefined;
    const row = snapshot.accounts.find(
      ({ details, signIn }) =>
        details.kind === "website" &&
        details.profileId !== undefined &&
        details.profileId !== DEFAULT_BROWSER_PROFILE_ID &&
        details.sites.includes(GOOGLE_SITE) &&
        signIn?.state === "signed-in",
    );
    const from = listed.find(
      (profile) => row?.details.kind === "website" && profile.id === row.details.profileId,
    );
    if (!row || !from) return undefined;
    return {
      name: from.name,
      run: () =>
        void act(async () => {
          const outcome = await copySignInIntoMain(environmentId, row);
          if (outcome === "copied" || outcome === "same") {
            toastManager.add({
              type: "success",
              title: `Copied ${from.name}'s Google sign-in into Main`,
            });
            window.dispatchEvent(new Event("scient-accounts-session-changed"));
          } else profileError();
        }),
    };
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
    if (importRunning) {
      toastManager.add({ type: "info", title: "A browser import is already running" });
      return;
    }
    const sources = await loadSourceProfiles();
    const running = new Set<string>();
    /** Profiles whose browser was signed out of Google too: the refresh had nothing to bring. */
    const stillOut: string[] = [];
    const renames: Array<{ id: string; from: string; to: string }> = [];
    let failed = false;
    for (const { id, record } of targets) {
      let refreshed = false;
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
        // Asked now: Accounts may not have seen yet that Google signed this profile out.
        const google = await window.desktopBridge?.accounts
          ?.googleSessions?.(id, environmentId)
          .catch(() => null);
        const result = await importBrowserCookiesIntoTarget(previewBridge, source, environmentId, {
          sourceProfileDirectory: profile.directory,
          target: { kind: "existing", profileId: id, name: linked.profileName },
          keepSites: sitesToKeep(
            snapshot.accounts,
            id,
            google ? google.some((session) => session.valid) : undefined,
          ),
          fillMain: false,
        });
        if (result.kind === "blocked") failed = true;
        else refreshed = true;
        if (refreshed && google && !google.some((session) => session.valid)) {
          const after = await window.desktopBridge?.accounts
            ?.googleSessions?.(id, environmentId)
            .catch(() => null);
          if (after?.length && !after.some((session) => session.valid)) stillOut.push(profile.name);
        }
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
          ? await importPasswords({
              format: "chrome",
              content: csv.content,
              profileId: BrowserProfileId.make(id),
            })
          : null;
        if (!result?.ok) failed = true;
      }
      await recordImportedSessions(environmentId, id, `${source.name} · ${profile.name}`, {
        fillMain: refreshed,
      });
    }
    await followSourceNames(renames);
    // Google and every row look again at what the refresh brought.
    window.dispatchEvent(new Event("scient-accounts-session-changed"));
    if (failed) profileError();
    else if (stillOut.length)
      toastManager.add({
        type: "info",
        title: `Signed out of Google in ${[...new Set(targets.map(({ record }) => browserName(record.source?.browser ?? "chrome")))].join(" and ")} too`,
        description: stillOut.join(", "),
      });
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
  const [sources, setSources] = useState<Awaited<ReturnType<typeof loadSourceProfiles>>>([]);
  const profileIds = listed.map((profile) => profile.id).join("\u0001");
  // Linked profiles follow their source's picture, colour and name; older imports get linked once.
  const syncSources = useEffectEvent((loaded: Awaited<ReturnType<typeof loadSourceProfiles>>) => {
    setSources(loaded);
    const renames: Array<{ id: string; from: string; to: string }> = [];
    for (const profile of listed) {
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
  const fetchSources = useEffectEvent(loadSourceProfiles);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Each time Accounts opens, read what the source browsers show without quitting them: names, emails, pictures and colours.
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
                    await addBrowserProfile(environmentId);
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
      {folded ? (
        <SettingsRow
          title={folded.text}
          control={
            <Button
              size="xs"
              variant="outline"
              disabled={disabled}
              onClick={() => void act(() => undoFold(folded.merged))}
            >
              Undo
            </Button>
          }
        />
      ) : null}
      {settings.mainDefaultNotice ? (
        <SettingsRow
          title="New tabs now open in Main, which has your sign-ins. You can change this here."
          control={
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label="Dismiss"
              onClick={() =>
                void changeSettings((current) => ({ ...current, mainDefaultNotice: false }))
              }
            >
              <XIcon />
            </Button>
          }
        />
      ) : null}
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
                id={profile.id}
                browser={profile.record.source?.browser}
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
                    <RenamedSource name={profile.name} source={profile.record.source} />
                    {settings.browserDefaultProfileId === profile.id ? (
                      <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                        New tabs
                      </span>
                    ) : null}
                  </span>
                  <ProfileDetail
                    email={profile.record.source?.email}
                    signedOut={signedOutOfGoogle(snapshot.accounts, profile.id)}
                    recover={
                      previewBridge
                        ? googleRecovery(profile.record.source, {
                            refresh: () => void act(() => refresh([profile])),
                            importProfile: onImport,
                            copyFrom: googleToCopy(profile.id),
                          })
                        : undefined
                    }
                  />
                </span>
              )}
            </div>
          }
          control={
            <div className="flex items-center gap-2">
              <SitesCount
                profileId={profile.id}
                environmentId={environmentId}
                rows={signInsOf(snapshot.accounts, profile.id)}
              />
              {profile.record.received?.[0] ? (
                <span className="text-xs text-muted-foreground">
                  Set on {profile.record.received[0].label}
                </span>
              ) : null}
              <AccessChip
                environmentId={environmentId}
                target={{ type: "profile", profileId: profile.id }}
                access={profile.record.access}
                disabled={disabled || profile.record.received !== undefined}
              />
              <ControlsMenu disabled={disabled}>
                <MenuCheckboxItem
                  variant="switch"
                  disabled={profile.record.received !== undefined}
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
                {isBuiltInBrowserProfileId(profile.id) || isUnlisted(profile.id) ? null : (
                  <MenuItem onClick={() => setRenaming(profile.id)}>Rename</MenuItem>
                )}
                {isBuiltInBrowserProfileId(profile.id) ||
                isUnlisted(profile.id) ||
                profile.record.source ||
                !previewBridge ? null : (
                  <MenuItem
                    onClick={() => {
                      setLinking(profile.id);
                      void loadSourceProfiles()
                        .then(setSources)
                        .catch(() => undefined);
                    }}
                  >
                    Match to browser profile…
                  </MenuItem>
                )}
                {profile.record.received ? null : (
                  <ScopeSubmenu
                    environmentId={environmentId}
                    target={{ type: "profile", profileId: profile.id }}
                    scope={profile.record.scope}
                  />
                )}
                {isUnlisted(profile.id) ? null : (
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
                )}
                {previewBridge && profile.record.source && !isUnlisted(profile.id) ? (
                  <MenuItem onClick={() => void act(() => refresh([profile]))}>
                    Refresh from {browserName(profile.record.source.browser)}
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
                        forgetBrowsing(profile.id);
                      })
                    }
                  >
                    Remove and sign out
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
          rows={signInsOf(snapshot.accounts, viewingSites)}
          renderSignIn={renderSignIn}
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
                          browser={source.id}
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
