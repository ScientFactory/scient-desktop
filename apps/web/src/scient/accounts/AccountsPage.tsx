import { useAtomValue } from "@effect/atom-react";
import * as Option from "effect/Option";
import {
  AuthOrchestrationReadScope,
  DEFAULT_BROWSER_PROFILE_ID,
  GOOGLE_SITE,
  AccountId,
  PROVIDER_DISPLAY_NAMES,
  ThreadId,
  resolveBrowserProfiles,
  type AccountActivityEntry,
  type AccountCodeSources,
  type AccountPlainKey,
  type AccountSummary,
  type AccountsSnapshot,
  type ConnectorSummary,
  type EnvironmentId,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import {
  ChevronRightIcon,
  EllipsisIcon,
  FileKeyIcon,
  GlobeIcon,
  KeyRoundIcon,
  LinkIcon,
  MessageSquareIcon,
  PlusIcon,
} from "lucide-react";
import { useEffect, useEffectEvent, useRef, useState, type ReactNode } from "react";

import {
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "~/components/settings/settingsLayout";
import { useOptionalSettingsScope } from "~/components/settings/SettingsScopeContext";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { Menu, MenuCheckboxItem, MenuItem, MenuPopup, MenuTrigger } from "~/components/ui/menu";
import { Input } from "~/components/ui/input";
import { Switch } from "~/components/ui/switch";
import { toastManager } from "~/components/ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { useClientSettings } from "~/hooks/useSettings";
import { isMacPlatform } from "~/lib/utils";
import { readLocalApi } from "~/localApi";
import { ExtensionIcon } from "~/scient/extensions/ExtensionRow";
import { extensionsInventory } from "~/scient/extensions/extensionsState";
import { useProviderInventory } from "~/scient/extensions/useProviderInventory";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { useProjects } from "~/state/entities";
import { usePrimaryEnvironmentId } from "~/state/environments";
import { useEnvironmentQuery } from "~/state/query";
import { providersIgnoringCheckedAtAtom, serverEnvironment } from "~/state/server";
import { useEnvironmentScope, usePreparedConnection } from "~/state/session";
import { environmentThreadShells } from "~/state/threads";
import { formatRelativeTimeLabel } from "~/timestampFormat";
import { universityDetails } from "@t3tools/shared/scientPaperLinks";
import { siteIdentities } from "@t3tools/shared/scientBrowserProfileChoice";
import "./accounts.css";
import { AccountApprovals } from "./AccountApprovals";
import { ApiKeyAccountPicker } from "./ApiKeyAccountPicker";
import { AccessChip, ControlsMenu, ScopeSubmenu } from "./AccountControls";
import { AccountDialog } from "./AccountDialog";
import { AccountLogo, SiteFavicon } from "./AccountLogo";
import { accountsState } from "./accountsState";
import {
  KIND_LABELS,
  accountIconUrl,
  accountListRows,
  accountManagePage,
  accountStatusLabel,
  activityLine,
  type KeyInUse,
  isBrowserSignIn,
  isSavedPassword,
  keysInUse,
  mergeProfiles,
  type ProviderRowsCache,
  steadyProviderRows,
  signedIntoUniversity,
} from "./accountsView";
import { UniversityIcon } from "./University";
import { AccountStoreMenuItems } from "./AccountStoreMenuItems";
import { BrowserImportDialog, BrowserProfiles, useImportingPasswords } from "./BrowserProfiles";
import { RemoteComputers } from "./RemoteComputers";
import { clickableAccountRow } from "./clickableAccountRow";
import { OnePasswordDialog, PasswordFileInput, PasswordStores } from "./PasswordStores";
import { ProfilePicture } from "./ProfilePicture";
import { useAccountBrowser } from "./useAccountBrowser";
import { useAccountCommand, useAccounts } from "./useAccounts";
import { useSignIn } from "./useSignIn";
import { useWebsiteSessions } from "./useWebsiteSessions";

/** Provider rows last read per environment, so a refresh doesn't empty "Other sign-ins". */
const providerRowsCache: ProviderRowsCache = new Map();

/** Where each kind of sign-in is managed, for the "Other sign-ins" links. */
const MANAGED_IN = {
  github: "Source Control",
  "custom-model": "Custom models",
  claude: "Claude",
  codex: "Codex",
  extension: "Extensions",
} as const;

export function AccountRow({
  account,
  environmentId,
  canWrite,
  onEdit,
  onActivity,
}: {
  account: AccountSummary;
  environmentId: EnvironmentId;
  canWrite: boolean;
  onEdit: () => void;
  onActivity: (entries: ReadonlyArray<AccountActivityEntry>) => void;
}) {
  const openBrowser = useAccountBrowser(environmentId);
  const profiles = resolveBrowserProfiles(
    useClientSettings((settings) => settings.browserProfiles),
  );
  const newTabProfileId = useClientSettings((settings) => settings.browserDefaultProfileId);
  const controls = useAccountCommand(accountsState.setControls, environmentId);
  const test = useAccountCommand(accountsState.test, environmentId);
  const remove = useAccountCommand(accountsState.remove, environmentId);
  const activity = useAccountCommand(accountsState.activity, environmentId);
  const [busy, setBusy] = useState(false);
  const target = { type: "account", accountId: account.accountId } as const;
  const details = account.details;
  const site = details.kind === "website" ? details.sites[0] : undefined;
  const check = useAccountCommand(accountsState.check, environmentId);
  const statusLabel = accountStatusLabel(account, formatRelativeTimeLabel);
  const university = universityDetails(details);
  const signIn = useSignIn(environmentId);
  const signInAnyRow = useAccounts(environmentId).data?.features?.signInAnyRow === true;
  const signInAgain = ["signed-out", "needs-you"].includes(account.signIn?.state ?? "");
  const openSite = async () => {
    if (!site) return;
    await openBrowser(site, details.kind === "website" ? details.profileId : undefined);
  };
  const iconUrl = accountIconUrl("sites" in details ? details.sites : [], account.name);
  const managePage = accountManagePage("sites" in details ? details.sites : []);
  return (
    <SettingsRow
      {...clickableAccountRow(onEdit)}
      aria-label={`Edit ${account.name}`}
      title={
        <span className="flex min-w-0 items-center gap-3">
          {iconUrl ? (
            <AccountLogo src={iconUrl} className="size-10 self-center rounded-[25%]" />
          ) : university ? (
            <UniversityIcon site={site ?? ""} className="size-10" />
          ) : site ? (
            <SiteFavicon site={site} />
          ) : (
            <span className="flex size-10 shrink-0 items-center justify-center rounded-[25%] bg-muted">
              <KeyRoundIcon className="size-4 text-muted-foreground" />
            </span>
          )}
          <span className="grid min-w-0 gap-1">
            <span className="truncate text-left">{account.name}</span>
            <span className="truncate text-xs text-muted-foreground">
              {details.kind === "website" && (university || !account.secrets.password)
                ? [
                    university
                      ? (university.institution?.domain ?? details.username ?? details.sites[0])
                      : (details.username ?? "Browser sign-in"),
                    profiles.find(
                      (profile) =>
                        profile.id ===
                        (details.profileId ?? newTabProfileId ?? DEFAULT_BROWSER_PROFILE_ID),
                    )?.name,
                  ]
                    .filter(Boolean)
                    .join(" · ")
                : isSavedPassword(account) && details.kind === "website"
                  ? // The username tells two sign-ins to the same site apart.
                    [details.username, account.name === site ? undefined : details.sites.join(", ")]
                      .filter(Boolean)
                      .join(" · ") || KIND_LABELS.website
                  : [
                      KIND_LABELS[details.kind],
                      "sites" in details
                        ? details.sites.join(", ")
                        : details.kind === "database"
                          ? details.host
                          : details.tool,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
            </span>
          </span>
          {statusLabel ? (
            <Tooltip>
              <TooltipTrigger render={<span className="shrink-0 text-xs text-muted-foreground" />}>
                {statusLabel}
              </TooltipTrigger>
              {account.signIn?.detail ? <TooltipPopup>{account.signIn.detail}</TooltipPopup> : null}
            </Tooltip>
          ) : null}
          {account.status === "needs-attention" ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <span
                    role="img"
                    aria-label="Needs attention"
                    className="size-1.5 shrink-0 self-center rounded-full bg-amber-500"
                  />
                }
              />
              <TooltipPopup>{account.statusMessage ?? "Needs attention"}</TooltipPopup>
            </Tooltip>
          ) : null}
        </span>
      }
      control={
        <div className="flex items-center gap-2">
          {university && !signedIntoUniversity(account) ? (
            <Button
              size="xs"
              variant="outline"
              disabled={!canWrite}
              onClick={(event) => {
                event.stopPropagation();
                void signIn(account.accountId);
              }}
            >
              Sign in
            </Button>
          ) : null}
          <AccessChip
            environmentId={environmentId}
            target={target}
            access={account.controls.access}
            disabled={!canWrite || busy}
          />
          <ControlsMenu disabled={!canWrite || busy}>
            {university ? (
              <MenuItem onClick={() => void signIn(account.accountId)}>Sign in</MenuItem>
            ) : signInAgain && details.kind === "website" ? (
              signInAnyRow ? (
                <MenuItem onClick={() => void signIn(account.accountId)}>Sign in again</MenuItem>
              ) : (
                <MenuItem disabled>Update Scient on this computer to sign in from here</MenuItem>
              )
            ) : null}
            {details.kind === "website" ? (
              <MenuItem
                onClick={async () => {
                  setBusy(true);
                  window.dispatchEvent(new Event("scient-accounts-session-changed"));
                  await check({ accountId: account.accountId });
                  setBusy(false);
                }}
              >
                Check sign-in
              </MenuItem>
            ) : null}
            {site && !university ? (
              <MenuItem onClick={() => void openSite()}>Open {site}</MenuItem>
            ) : null}
            <AccountStoreMenuItems account={account} />
            <MenuItem onClick={onEdit}>Edit</MenuItem>
            <MenuItem
              onClick={async () => {
                setBusy(true);
                const result = await test({ accountId: account.accountId });
                setBusy(false);
                if (result.ok) toastManager.add({ type: "success", title: "Account tested" });
              }}
            >
              Test
            </MenuItem>
            <MenuItem
              onClick={async () => {
                const result = await activity({ target });
                if (result.ok) onActivity(result.value);
              }}
            >
              Activity
            </MenuItem>
            {managePage ? (
              <MenuItem
                onClick={() =>
                  void readLocalApi()
                    ?.shell.openExternal(managePage.url)
                    .catch(() => undefined)
                }
              >
                Manage on {managePage.domain}
              </MenuItem>
            ) : null}
            <MenuCheckboxItem
              variant="switch"
              checked={account.controls.visibility === "readable"}
              onCheckedChange={(readable) =>
                void controls({ target, visibility: readable ? "readable" : "hidden" })
              }
            >
              Agents can read it
            </MenuCheckboxItem>
            {details.kind !== "website" ? (
              <MenuItem
                onClick={() =>
                  void controls({
                    target,
                    permission: account.controls.permission === "read-only" ? "full" : "read-only",
                  })
                }
              >
                Permission: {account.controls.permission === "full" ? "Full" : "Read only"}
              </MenuItem>
            ) : null}
            <ScopeSubmenu
              environmentId={environmentId}
              target={target}
              scope={account.controls.scope}
            />
            <MenuItem
              onClick={async () => {
                setBusy(true);
                await remove({ accountId: account.accountId });
                setBusy(false);
              }}
            >
              Remove
            </MenuItem>
          </ControlsMenu>
        </div>
      }
    />
  );
}

function ManagedAccountRow({
  row,
  environmentId,
}: {
  row: {
    kind: "github" | "custom-model" | "extension" | "claude" | "codex";
    instanceId?: ProviderInstanceId;
    name: string;
    detail?: string | undefined;
    href: "/settings/source-control" | "/settings/custom-models" | "/settings/extensions/installed";
  };
  environmentId: EnvironmentId;
}) {
  const domain =
    managedHost(row.detail) ??
    (row.kind === "github" ? "github.com" : row.kind === "claude" ? "claude.ai" : undefined);
  // Our own logos first: the extension catalogue has no GitHub or Claude sign-in entries.
  const logo = accountIconUrl(
    row.kind === "claude"
      ? ["anthropic.com"]
      : row.kind === "codex"
        ? ["openai.com"]
        : domain
          ? [domain]
          : [],
    row.name,
  );
  const content = (
    <>
      {logo ? (
        <AccountLogo src={logo} className="size-10 shrink-0 rounded-[25%]" />
      ) : (
        <ExtensionIcon name={row.name} environmentId={environmentId} />
      )}
      <span className="grid min-w-0 flex-1 gap-1">
        <span className="truncate text-sm font-medium">{row.name}</span>
        {domain ? <span className="truncate text-xs text-muted-foreground">{domain}</span> : null}
      </span>
      <span className="shrink-0 text-xs text-muted-foreground">{MANAGED_IN[row.kind]} ›</span>
    </>
  );
  const className =
    "cursor-pointer flex min-h-15 items-center gap-3 rounded-lg px-4 py-2 text-foreground hover:bg-accent/40";
  return row.instanceId ? (
    <Link
      to="/settings/extensions/store/$instanceId"
      params={{ instanceId: row.instanceId }}
      className={className}
    >
      {content}
    </Link>
  ) : (
    <Link to={row.href} className={className}>
      {content}
    </Link>
  );
}

function managedHost(value: string | undefined) {
  if (!value) return undefined;
  try {
    return new URL(value.includes("://") ? value : `https://${value}`).hostname;
  } catch {
    return undefined;
  }
}

function SavedPasswordsDialog({
  accounts,
  environmentId,
  canWrite,
  onEdit,
  onActivity,
  onClose,
}: {
  accounts: ReadonlyArray<AccountSummary>;
  environmentId: EnvironmentId;
  canWrite: boolean;
  onEdit: (account: AccountSummary) => void;
  onActivity: (entries: ReadonlyArray<AccountActivityEntry>) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const text = query.trim().toLowerCase();
  const shown = accounts
    .filter((account) =>
      [
        account.name,
        ...("sites" in account.details ? account.details.sites : []),
        account.details.kind === "website" ? (account.details.username ?? "") : "",
      ].some((value) => value.toLowerCase().includes(text)),
    )
    .toSorted((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogPopup data-accounts-dialog className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Saved passwords</DialogTitle>
        </DialogHeader>
        <DialogPanel>
          <div className="grid gap-3">
            <Input
              type="search"
              aria-label="Find a saved password"
              placeholder={`Search ${accounts.length} sites`}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            <div className="max-h-[60vh] overflow-y-auto rounded-lg border">
              {shown.map((account) => (
                <AccountRow
                  key={account.accountId}
                  account={account}
                  environmentId={environmentId}
                  canWrite={canWrite}
                  onEdit={() => onEdit(account)}
                  onActivity={onActivity}
                />
              ))}
              {shown.length === 0 ? (
                <div className="px-3 py-6 text-center text-sm text-muted-foreground">
                  No saved passwords match
                </div>
              ) : null}
            </div>
          </div>
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}

/** Google adds another of its accounts to a profile through its own page. */
const addGoogleSession = (email: string) =>
  `https://accounts.google.com/AddSession?Email=${encodeURIComponent(email)}&continue=${encodeURIComponent("https://myaccount.google.com/")}`;

/**
 * One site signed in from several browser profiles: the profiles' pictures, opening to each.
 * When Main has the site but it doesn't work there, the row says which profile is used instead.
 */
export function SignInGroupRow({
  environmentId,
  accounts,
  profiles,
  onOpen,
}: {
  environmentId: EnvironmentId;
  accounts: ReadonlyArray<AccountSummary>;
  profiles: ReturnType<typeof mergeProfiles>;
  onOpen: () => void;
}) {
  const openBrowser = useAccountBrowser(environmentId);
  const first = accounts[0]!;
  const site = "sites" in first.details ? first.details.sites[0] : undefined;
  const iconUrl = accountIconUrl(site ? [site] : [], first.name);
  const profileIds = new Set(
    accounts.map(({ details }) => (details.kind === "website" ? details.profileId : undefined)),
  );
  const signedIn = profiles.filter((profile) => profileIds.has(profile.id));
  const pageUrl = site ? (site.startsWith("https://") ? site : `https://${site}`) : undefined;
  const identities = siteIdentities(accounts, pageUrl).map((identity) => identity.profileId);
  const using =
    profileIds.has(DEFAULT_BROWSER_PROFILE_ID) && !identities.includes(DEFAULT_BROWSER_PROFILE_ID)
      ? profiles.find((profile) => profile.id === identities[0])
      : undefined;
  const usingEmail = accounts.find(
    ({ details }) =>
      details.kind === "website" && details.profileId === using?.id && details.username,
  )?.details;
  const googleEmail =
    site === GOOGLE_SITE && usingEmail?.kind === "website" ? usingEmail.username : undefined;
  return (
    <SettingsRow
      {...clickableAccountRow(onOpen)}
      aria-label={`Show ${first.name} sign-ins`}
      title={
        <span className="flex min-w-0 items-center gap-3">
          {iconUrl ? (
            <AccountLogo src={iconUrl} className="size-10 self-center rounded-[25%]" />
          ) : site ? (
            <SiteFavicon site={site} />
          ) : null}
          <span className="grid min-w-0 gap-1">
            <span className="truncate text-left">{first.name}</span>
            <span className="truncate text-xs text-muted-foreground">
              Browser sign-in ·{" "}
              {using
                ? `Using ${using.name}`
                : signedIn.length > 2
                  ? `${signedIn.length} profiles`
                  : signedIn.map((profile) => profile.name).join(", ")}
            </span>
          </span>
        </span>
      }
      control={
        <span className="flex items-center gap-2">
          {using && pageUrl ? (
            <Menu>
              <MenuTrigger
                render={
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    aria-label={`More for ${first.name} sign-ins`}
                  />
                }
              >
                <EllipsisIcon />
              </MenuTrigger>
              <MenuPopup align="end">
                {googleEmail ? (
                  <MenuItem
                    onClick={() =>
                      void openBrowser(addGoogleSession(googleEmail), DEFAULT_BROWSER_PROFILE_ID)
                    }
                  >
                    Add to Main
                  </MenuItem>
                ) : (
                  <MenuItem onClick={() => void openBrowser(pageUrl, using.id)}>
                    Open in {using.name}
                  </MenuItem>
                )}
              </MenuPopup>
            </Menu>
          ) : null}
          <span className="flex -space-x-1.5">
            {signedIn.map((profile) => (
              <ProfilePicture
                key={profile.id}
                size="sm"
                name={profile.name}
                picture={profile.record.picture}
                color={profile.record.color}
                id={profile.id}
                browser={profile.record.source?.browser}
              />
            ))}
          </span>
          <ChevronRightIcon className="size-4 text-muted-foreground" />
        </span>
      }
    />
  );
}

/** One row standing for a list that grows on its own, opening it in a dialog. */
function ListRow({
  icon,
  title,
  detail,
  description,
  onOpen,
}: {
  icon: ReactNode;
  title: string;
  detail: string;
  description?: string;
  onOpen: () => void;
}) {
  return (
    <SettingsRow
      {...clickableAccountRow(onOpen)}
      aria-label={`Show ${title.toLowerCase()}`}
      description={description}
      descriptionSize="compact"
      title={
        <span className="flex min-w-0 items-center gap-3">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-[25%] bg-muted [&_svg]:size-4 [&_svg]:text-muted-foreground">
            {icon}
          </span>
          <span className="grid min-w-0 gap-1">
            <span className="truncate text-left">{title}</span>
            <span className="truncate text-xs text-muted-foreground">{detail}</span>
          </span>
        </span>
      }
      control={<ChevronRightIcon className="size-4 text-muted-foreground" />}
    />
  );
}

function ListDialog({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogPopup data-accounts-dialog className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <DialogPanel>
          <div className="max-h-[60vh] overflow-y-auto rounded-lg border">{children}</div>
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}

/** The keys Scient itself runs on. Each is edited where it is used; this says what uses what. */
function KeysInUseDialog({
  keys,
  snapshot,
  environmentId,
  canWrite,
  onClose,
}: {
  keys: ReadonlyArray<KeyInUse>;
  snapshot: AccountsSnapshot;
  environmentId: EnvironmentId;
  canWrite: boolean;
  onClose: () => void;
}) {
  const link = useAccountCommand(accountsState.linkKey, environmentId);
  const unlink = useAccountCommand(accountsState.unlinkKey, environmentId);
  const savedKeys = snapshot.accounts.flatMap((account) =>
    account.details.kind === "api-key" && account.secrets.token
      ? [{ value: account.accountId, name: account.name }]
      : [],
  );
  const linked = (key: KeyInUse) =>
    snapshot.keyLinks?.find((item) =>
      key.variables.some(
        (target) => target.instanceId === item.instanceId && target.variable === item.variable,
      ),
    )?.accountId;
  const follow = async (key: KeyInUse, accountId: string) => {
    for (const target of key.variables) {
      await (accountId
        ? link({ ...target, accountId: AccountId.make(accountId) })
        : unlink(target));
    }
  };
  return (
    <ListDialog title="Keys used by Scient" onClose={onClose}>
      {keys.map((key) => (
        <SettingsRow
          key={`${key.href}:${key.name}`}
          title={<span className="font-mono text-xs">{key.name}</span>}
          description={key.usedBy.join(", ")}
          control={
            <span className="flex items-center gap-2">
              {key.variables.length && savedKeys.length ? (
                <ApiKeyAccountPicker
                  aria-label={`Saved key for ${key.name}`}
                  emptyLabel="Its own value"
                  options={savedKeys}
                  size="xs"
                  value={linked(key) ?? ""}
                  disabled={!canWrite}
                  onChange={(event) => void follow(key, event.currentTarget.value)}
                />
              ) : null}
              <Button size="xs" variant="outline" render={<Link to={key.href} />} onClick={onClose}>
                Open
              </Button>
            </span>
          }
        />
      ))}
    </ListDialog>
  );
}

/** Keys in plain files. Keeping one copies it into Accounts; the file stays as it is. */
function PlainKeysDialog({
  keys,
  roots,
  environmentId,
  canWrite,
  onKept,
  onClose,
}: {
  keys: ReadonlyArray<AccountPlainKey>;
  roots: ReadonlyArray<string>;
  environmentId: EnvironmentId;
  canWrite: boolean;
  onKept: (key: AccountPlainKey) => void;
  onClose: () => void;
}) {
  const keeping = useRef(new Set<string>());
  const keep = useAccountCommand(accountsState.keepPlainKey, environmentId);
  return (
    <ListDialog title="Keys in plain files" onClose={onClose}>
      {keys.map((key) => (
        <SettingsRow
          key={`${key.file}:${key.name}`}
          title={<span className="font-mono text-xs">{key.name}</span>}
          description={key.file}
          control={
            <Button
              size="xs"
              variant="outline"
              disabled={!canWrite || key.kept}
              onClick={async () => {
                if (keeping.current.has(key.name)) return;
                keeping.current.add(key.name);
                const result = await keep({ roots, file: key.file, name: key.name });
                keeping.current.delete(key.name);
                if (result.ok) onKept(key);
              }}
            >
              {key.kept ? "In Accounts" : "Keep in Accounts"}
            </Button>
          }
        />
      ))}
    </ListDialog>
  );
}

/** Where Scient may find sign-in codes. Off until the user turns a source on. */
function SignInCodesDialog({
  sources,
  environmentId,
  canWrite,
  onClose,
}: {
  sources: AccountCodeSources;
  environmentId: EnvironmentId;
  canWrite: boolean;
  onClose: () => void;
}) {
  const set = useAccountCommand(accountsState.setCodeSources, environmentId);
  const [chosen, setChosen] = useState(sources);
  const [needsAccess, setNeedsAccess] = useState(false);
  const change = async (next: AccountCodeSources) => {
    setChosen(next);
    const result = await set(next);
    if (result.ok) setNeedsAccess(result.value.messagesNeedAccess);
    else setChosen(sources);
  };
  return (
    <ListDialog title="Sign-in codes" onClose={onClose}>
      <SettingsRow
        title="Codes from Messages"
        description="Texts forwarded to this Mac. Needs Full Disk Access, which also lets Scient read your other files."
        control={
          <Switch
            aria-label="Codes from Messages"
            checked={chosen.messages}
            disabled={!canWrite}
            onCheckedChange={(messages) => void change({ messages })}
          />
        }
      />
      {needsAccess ? (
        <SettingsRow
          title="macOS hasn't given Scient access"
          control={
            <Button
              size="xs"
              variant="outline"
              onClick={() =>
                void readLocalApi()
                  ?.shell.openSystemSettings("full-disk-access")
                  .catch(() => undefined)
              }
            >
              Open Full Disk Access
            </Button>
          }
        />
      ) : null}
    </ListDialog>
  );
}

function AccountsContent({
  environmentId,
  snapshot,
  canWrite,
}: {
  environmentId: EnvironmentId;
  snapshot: AccountsSnapshot;
  canWrite: boolean;
}) {
  const [dialog, setDialog] = useState<
    | "add"
    | "import"
    | "1password"
    | "passwords"
    | "browser-sign-ins"
    | "other-sign-ins"
    | "sign-in-codes"
    | "keys"
    | "plain-keys"
    | null
  >(null);
  const [editing, setEditing] = useState<AccountSummary | null>(null);
  const [signIns, setSignIns] = useState<ReadonlyArray<AccountSummary> | null>(null);
  const [checking, setChecking] = useState(false);
  const [plainKeys, setPlainKeys] = useState<ReadonlyArray<AccountPlainKey>>([]);
  const projectRoots = useProjects()
    .filter((project) => project.environmentId === environmentId)
    .map((project) => project.workspaceRoot);
  const findPlainKeys = useAccountCommand(accountsState.plainKeys, environmentId);
  const scannedRoots = projectRoots.join("\u0000");
  const scanPlainKeys = useEffectEvent((roots: ReadonlyArray<string>) => findPlainKeys({ roots }));
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Looks once per set of projects when the page opens; the files aren't watched.
  useEffect(() => {
    if (!canWrite) return;
    let live = true;
    void scanPlainKeys(scannedRoots ? scannedRoots.split("\u0000") : []).then((result) => {
      if (live && result.ok) setPlainKeys(result.value);
    });
    return () => {
      live = false;
    };
  }, [canWrite, scannedRoots]);
  const serverSettings = useAtomValue(serverEnvironment.settingsValueAtom(environmentId));
  const keys = keysInUse(
    serverSettings?.providerInstances ?? {},
    snapshot.customModelKeys,
    (driver) => PROVIDER_DISPLAY_NAMES[driver as keyof typeof PROVIDER_DISPLAY_NAMES] ?? driver,
  );
  const checkAll = useAccountCommand(accountsState.check, environmentId);
  const profiles = mergeProfiles(
    useClientSettings((settings) => settings.browserProfiles),
    snapshot.profiles,
  );
  const [activity, setActivity] = useState<ReadonlyArray<AccountActivityEntry> | null>(null);
  const passwordFileRef = useRef<HTMLInputElement>(null);
  const inventory = useEnvironmentQuery(extensionsInventory({ environmentId, input: {} }));
  const providers = useAtomValue(providersIgnoringCheckedAtAtom(environmentId));
  const providerInventory = useProviderInventory({
    environmentId,
    providers,
    roots: [],
    projectsKnown: true,
    enabled: true,
  });
  const providerRows = steadyProviderRows(providerRowsCache, environmentId, {
    connection: Option.getOrNull(usePreparedConnection(environmentId)),
    canRead: useEnvironmentScope(environmentId, AuthOrchestrationReadScope),
    permitted: useAtomValue(serverEnvironment.refreshProviders.permissionAtom(environmentId)),
    providers,
    inventory: providerInventory.providers,
  });
  const setAccess = useAccountCommand(accountsState.setAgentAccess, environmentId);
  // Lists that grow on their own (saved passwords, sign-ins recorded while browsing, sign-ins
  // managed elsewhere) are one row each, so the page shows what was added on purpose.
  const savedPasswords = snapshot.accounts.filter(isSavedPassword);
  const importingPasswords = useImportingPasswords();
  const browserSignIns = accountListRows(snapshot.accounts.filter(isBrowserSignIn));
  const managedRows = [
    ...providerRows,
    ...(snapshot.managedElsewhere ??
      snapshot.customModelKeys.map((connection) => ({
        kind: "custom-model" as const,
        id: connection.connectionId,
        name: connection.name,
        detail: connection.origin,
        href: "/settings/custom-models" as const,
      }))),
    // Only connectors you are signed in to; a key bound from Accounts is already its own row.
    ...(inventory.data?.connectors.filter(holdsOwnSignIn).map((connector) => ({
      kind: "extension" as const,
      id: connector.connectorId,
      name: connector.displayName,
      detail: new URL(connector.url).origin,
      href: "/settings/extensions/installed" as const,
    })) ?? []),
  ];
  return (
    <div className="scient-accounts-settings grid gap-8" data-agent-access={snapshot.agentAccess}>
      {snapshot.approvals.length ? (
        <AccountApprovals
          environmentId={environmentId}
          approvals={snapshot.approvals}
          canWrite={canWrite}
        />
      ) : null}
      <SettingsSection
        id="accounts-list"
        title="Accounts"
        headerAction={
          <Button
            size="xs"
            variant="outline"
            disabled={!canWrite || checking}
            onClick={async () => {
              setChecking(true);
              window.dispatchEvent(new Event("scient-accounts-session-changed"));
              const result = await checkAll({});
              setChecking(false);
              if (result.ok)
                toastManager.add({
                  type: "success",
                  title: result.value.alreadyRunning
                    ? "Already checking your accounts"
                    : result.value.checked
                      ? `Checked ${result.value.checked} sign-in${result.value.checked === 1 ? "" : "s"}`
                      : "No sign-ins to check yet",
                });
            }}
          >
            {checking ? "Checking…" : "Check my accounts"}
          </Button>
        }
        titleAction={
          <Menu>
            <MenuTrigger
              render={
                <Button size="icon-xs" variant="ghost" aria-label="Add" disabled={!canWrite} />
              }
            >
              <PlusIcon />
            </MenuTrigger>
            <MenuPopup align="end">
              <MenuItem onClick={() => setDialog("add")}>Add an account…</MenuItem>
              <MenuItem onClick={() => passwordFileRef.current?.click()}>
                Import passwords…
              </MenuItem>
            </MenuPopup>
          </Menu>
        }
      >
        <SettingsRow
          id="accounts-agent-access"
          title="Let agents use your accounts"
          control={
            <Switch
              aria-label="Let agents use your accounts"
              checked={snapshot.agentAccess}
              disabled={!canWrite}
              onCheckedChange={(enabled) => void setAccess({ enabled })}
            />
          }
        />
        {!snapshot.accounts.length ? (
          <SettingsRow
            title="No accounts"
            control={
              <Button
                size="xs"
                variant="outline"
                disabled={!canWrite}
                onClick={() => setDialog("add")}
              >
                Add an account
              </Button>
            }
          />
        ) : null}
        {snapshot.accounts
          .filter((account) => !isSavedPassword(account) && !isBrowserSignIn(account))
          .map((account) => (
            <AccountRow
              key={account.accountId}
              account={account}
              environmentId={environmentId}
              canWrite={canWrite}
              onEdit={() => setEditing(account)}
              onActivity={setActivity}
            />
          ))}
        {savedPasswords.length || importingPasswords ? (
          <ListRow
            icon={<KeyRoundIcon />}
            title="Saved passwords"
            detail={`${importingPasswords ? "Importing… " : ""}${savedPasswords.length === 1 ? "1 site" : `${savedPasswords.length} sites`}`}
            onOpen={() => setDialog("passwords")}
          />
        ) : null}
        {browserSignIns.length ? (
          <ListRow
            icon={<GlobeIcon />}
            title="Browser sign-ins"
            detail={browserSignIns.length === 1 ? "1 site" : `${browserSignIns.length} sites`}
            description="Passwords work in every profile. A sign-in stays in the profile it was made in and is copied into Main, unless Main already has someone else on that site. Then the site's row lets you pick who."
            onOpen={() => setDialog("browser-sign-ins")}
          />
        ) : null}
        {keys.length ? (
          <ListRow
            icon={<KeyRoundIcon />}
            title="Keys used by Scient"
            detail={keys.map((key) => key.name).join(", ")}
            onOpen={() => setDialog("keys")}
          />
        ) : null}
        {plainKeys.some((key) => !key.kept) ? (
          <ListRow
            icon={<FileKeyIcon />}
            title="Keys in plain files"
            detail={[...new Set(plainKeys.filter((key) => !key.kept).map((key) => key.name))].join(
              ", ",
            )}
            onOpen={() => setDialog("plain-keys")}
          />
        ) : null}
        {isMacPlatform(navigator.platform) ? (
          <ListRow
            icon={<MessageSquareIcon />}
            title="Sign-in codes"
            detail={snapshot.codeSources?.messages ? "Messages" : "You type them in"}
            onOpen={() => setDialog("sign-in-codes")}
          />
        ) : null}
        {managedRows.length ? (
          <ListRow
            icon={<LinkIcon />}
            title="Other sign-ins"
            detail={managedRows.map((row) => row.name).join(", ")}
            onOpen={() => setDialog("other-sign-ins")}
          />
        ) : null}
      </SettingsSection>
      <BrowserProfiles
        environmentId={environmentId}
        snapshot={snapshot}
        canWrite={canWrite}
        onImport={() => setDialog("import")}
      />
      <RemoteComputers environmentId={environmentId} snapshot={snapshot} canWrite={canWrite} />
      <PasswordStores
        environmentId={environmentId}
        snapshot={snapshot}
        canWrite={canWrite}
        onConnect={() => setDialog("1password")}
      />
      <PasswordFileInput
        environmentId={environmentId}
        canWrite={canWrite}
        inputRef={passwordFileRef}
      />
      {dialog === "add" || editing ? (
        <AccountDialog
          environmentId={environmentId}
          snapshot={snapshot}
          account={editing}
          canWrite={canWrite}
          onClose={() => {
            setEditing(null);
            // Editing from a list returns to it.
            if (dialog !== "passwords" && dialog !== "browser-sign-ins") setDialog(null);
          }}
        />
      ) : null}
      {dialog === "import" ? (
        <BrowserImportDialog
          environmentId={environmentId}
          canWrite={canWrite}
          snapshot={snapshot}
          onClose={() => setDialog(null)}
        />
      ) : null}
      {dialog === "passwords" ? (
        <SavedPasswordsDialog
          accounts={savedPasswords}
          environmentId={environmentId}
          canWrite={canWrite}
          onEdit={setEditing}
          onActivity={setActivity}
          onClose={() => setDialog(null)}
        />
      ) : null}
      {dialog === "browser-sign-ins" ? (
        <ListDialog title="Browser sign-ins" onClose={() => setDialog(null)}>
          {browserSignIns.map((row) =>
            "accountId" in row ? (
              <AccountRow
                key={row.accountId}
                account={row}
                environmentId={environmentId}
                canWrite={canWrite}
                onEdit={() => setEditing(row)}
                onActivity={setActivity}
              />
            ) : (
              <SignInGroupRow
                key={row[0]!.accountId}
                environmentId={environmentId}
                accounts={row}
                profiles={profiles}
                onOpen={() => setSignIns(row)}
              />
            ),
          )}
        </ListDialog>
      ) : null}
      {dialog === "plain-keys" ? (
        <PlainKeysDialog
          keys={plainKeys}
          roots={projectRoots}
          environmentId={environmentId}
          canWrite={canWrite}
          onKept={(key) =>
            setPlainKeys((current) =>
              current.map((item) => (item.name === key.name ? { ...item, kept: true } : item)),
            )
          }
          onClose={() => setDialog(null)}
        />
      ) : null}
      {dialog === "keys" ? (
        <KeysInUseDialog
          keys={keys}
          snapshot={snapshot}
          environmentId={environmentId}
          canWrite={canWrite}
          onClose={() => setDialog(null)}
        />
      ) : null}
      {dialog === "sign-in-codes" ? (
        <SignInCodesDialog
          sources={snapshot.codeSources ?? { messages: false }}
          environmentId={environmentId}
          canWrite={canWrite}
          onClose={() => setDialog(null)}
        />
      ) : null}
      {dialog === "other-sign-ins" ? (
        <ListDialog title="Other sign-ins" onClose={() => setDialog(null)}>
          {managedRows.map((row) => (
            <ManagedAccountRow
              key={`${row.kind}:${row.id}`}
              row={row}
              environmentId={environmentId}
            />
          ))}
        </ListDialog>
      ) : null}
      {signIns ? (
        <Dialog open onOpenChange={(open) => !open && setSignIns(null)}>
          <DialogPopup data-accounts-dialog className="max-w-2xl">
            <DialogHeader>
              <DialogTitle>{signIns[0]!.name}</DialogTitle>
            </DialogHeader>
            <DialogPanel>
              <div className="rounded-lg border">
                {signIns.map((account) => {
                  const current = snapshot.accounts.find(
                    (item) => item.accountId === account.accountId,
                  );
                  return current ? (
                    <AccountRow
                      key={current.accountId}
                      account={current}
                      environmentId={environmentId}
                      canWrite={canWrite}
                      onEdit={() => setEditing(current)}
                      onActivity={setActivity}
                    />
                  ) : null;
                })}
              </div>
            </DialogPanel>
          </DialogPopup>
        </Dialog>
      ) : null}
      {dialog === "1password" ? (
        <OnePasswordDialog
          environmentId={environmentId}
          canWrite={canWrite}
          onClose={() => setDialog(null)}
        />
      ) : null}
      {activity ? (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open) setActivity(null);
          }}
        >
          <DialogPopup>
            <DialogHeader>
              <DialogTitle>Activity</DialogTitle>
            </DialogHeader>
            <DialogPanel>
              {activity.map((entry) => (
                <div key={JSON.stringify(entry)} className="py-2 text-xs">
                  <time className="text-muted-foreground">
                    {new Date(entry.at).toLocaleString()}
                  </time>{" "}
                  · {activityLine(entry, activityConversation(entry, environmentId))}
                </div>
              ))}
            </DialogPanel>
          </DialogPopup>
        </Dialog>
      ) : null}
    </div>
  );
}

/** The conversation behind an activity entry; the user's own check has none. */
function activityConversation(entry: AccountActivityEntry, environmentId: EnvironmentId) {
  if (!entry.threadId) return undefined;
  if (entry.threadId === ThreadId.make("scient-accounts-check")) return "Check my accounts";
  if (entry.threadId === ThreadId.make("scient-paper-get")) return "Get PDF";
  return appAtomRegistry.get(
    environmentThreadShells.threadShellAtom({ environmentId, threadId: entry.threadId }),
  )?.title;
}

function AccountsEnvironment({ environmentId }: { environmentId: EnvironmentId }) {
  const { data: snapshot, canWrite } = useAccounts(environmentId);
  const data = useWebsiteSessions(environmentId, snapshot);
  return data ? (
    <AccountsContent environmentId={environmentId} snapshot={data} canWrite={canWrite} />
  ) : null;
}
export function AccountsPage() {
  const primary = usePrimaryEnvironmentId();
  const scope = useOptionalSettingsScope();
  const environmentId = scope === null ? primary : (scope.environment?.environmentId ?? null);
  return (
    <SettingsPageContainer>
      {environmentId ? (
        <AccountsEnvironment key={environmentId} environmentId={environmentId} />
      ) : null}
    </SettingsPageContainer>
  );
}

function holdsOwnSignIn(connector: ConnectorSummary): boolean {
  return (
    connector.status === "connected" &&
    (connector.auth.type === "oauth" ||
      (connector.auth.type === "credential" && connector.auth.storage === "owned"))
  );
}
