import { useAtomValue } from "@effect/atom-react";
import * as Option from "effect/Option";
import {
  ACCOUNTS_PROTOCOL,
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
import { Link, useNavigate } from "@tanstack/react-router";
import {
  ChevronRightIcon,
  EllipsisIcon,
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
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import {
  Menu,
  MenuCheckboxItem,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuTrigger,
} from "~/components/ui/menu";
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
import { signInHeld } from "@t3tools/shared/scientAccountSignIn";
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
  accountManagePage,
  accountStatusLabel,
  activityLine,
  type ApiKeyRow,
  apiKeyRows,
  type GitHubIdentity,
  githubIdentities,
  isBrowserSignIn,
  isSavedPassword,
  mergeProfiles,
  onlyIn,
  type ProviderRowsCache,
  steadyProviderRows,
  signedIntoUniversity,
} from "./accountsView";
import { UniversityIcon } from "./University";
import { AccountStoreMenuItems } from "./AccountStoreMenuItems";
import {
  BrowserImportDialog,
  BrowserProfiles,
  GOOGLE_SIGNED_OUT,
  useImportingPasswords,
} from "./BrowserProfiles";
import { copySignInIntoMain } from "./mainFill";
import { CHROME_WINDOW_ACTION, useChromeSignIn } from "./ChromeSignIn";
import { RemoteComputers } from "./RemoteComputers";
import { clickableAccountRow } from "./clickableAccountRow";
import { OnePasswordDialog, PasswordFileInput, PasswordStores } from "./PasswordStores";
import { useAccountBrowser } from "./useAccountBrowser";
import { useAccountCommand, useAccounts } from "./useAccounts";
import { useSignIn } from "./useSignIn";
import { useWebsiteSessions } from "./useWebsiteSessions";

/** Provider rows last read per environment, so a refresh doesn't empty "Apps and connectors". */
const providerRowsCache: ProviderRowsCache = new Map();

/** Where each kind of sign-in is managed, for the "Apps and connectors" links. */
const MANAGED_IN = {
  claude: "Claude",
  codex: "Codex",
  droid: "Droid",
  extension: "Extensions",
  scient: "Scient Agent",
} as const;

export function AccountRow({
  account,
  environmentId,
  canWrite,
  onEdit,
  onActivity,
  aside,
  menu,
  detail,
}: {
  account: AccountSummary;
  environmentId: EnvironmentId;
  canWrite: boolean;
  onEdit: () => void;
  onActivity: (entries: ReadonlyArray<AccountActivityEntry>) => void;
  /** The line under the name, in place of what the account's kind says. */
  detail?: string;
  /** Beside the access chip, such as which profile Main uses for the site. */
  aside?: ReactNode;
  /** More items for the row's menu. */
  menu?: ReactNode;
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
  const signInAnyRow =
    (useAccounts(environmentId).data?.accountsProtocol ?? 0) >= ACCOUNTS_PROTOCOL;
  const held = signInHeld(account.signIn);
  const signInAgain = held || account.signIn?.state === "signed-out";
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
              {detail ??
                (details.kind === "website" && (university || !account.secrets.password)
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
                      [
                        details.username,
                        account.name === site ? undefined : details.sites.join(", "),
                      ]
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
                        .join(" · "))}
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
          {(university && !signedIntoUniversity(account)) ||
          (!university && held && signInAnyRow && details.kind === "website") ? (
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
          {aside}
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
            {menu}
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
    kind: "extension" | "claude" | "codex" | "droid" | "scient";
    instanceId?: ProviderInstanceId;
    name: string;
    detail?: string | undefined;
    href: "/settings/extensions/installed";
  };
  environmentId: EnvironmentId;
}) {
  const domain = managedHost(row.detail) ?? (row.kind === "claude" ? "claude.ai" : undefined);
  // Our own logos first: the extension catalogue has no GitHub or Claude sign-in entries.
  const logo = accountIconUrl(
    row.kind === "claude"
      ? ["anthropic.com"]
      : row.kind === "codex" || row.kind === "scient"
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

const SOURCE_CONTROL_VIA = { gh: "GitHub CLI", app: "Scient for GitHub", token: "Token" } as const;

/** One GitHub login with a chip per use; each chip shows that use's own state. */
function GitHubIdentityRow({ identity }: { identity: GitHubIdentity }) {
  const logo = accountIconUrl(["github.com"], identity.login);
  const via = identity.sourceControl?.via;
  const connector = identity.connector;
  return (
    <div className="flex min-h-15 items-center gap-3 rounded-lg px-4 py-2 text-foreground">
      {logo ? <AccountLogo src={logo} className="size-10 shrink-0 rounded-[25%]" /> : null}
      <span className="grid min-w-0 flex-1 gap-1">
        <span className="truncate text-sm font-medium">{identity.login}</span>
        <span className="flex flex-wrap gap-1">
          {identity.sourceControl ? (
            <Badge variant="success" render={<Link to="/settings/source-control" />}>
              {via ? `Source Control · ${SOURCE_CONTROL_VIA[via]}` : "Source Control"}
            </Badge>
          ) : null}
          {connector ? (
            <Badge
              variant={connector.status === "connected" ? "success" : "warning"}
              render={
                <Link
                  to="/settings/extensions/item/connector/$connectorId"
                  params={{ connectorId: connector.connectorId }}
                />
              }
            >
              {connector.status === "connected"
                ? "Connector"
                : `Connector · ${connector.status === "needs-auth" ? "Needs sign-in" : "Account missing"}`}
            </Badge>
          ) : null}
        </span>
      </span>
    </div>
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

const siteKey = (account: AccountSummary) =>
  "sites" in account.details
    ? (account.details.sites[0]?.replace(/^https:\/\//, "").toLowerCase() ?? "")
    : "";

/**
 * On Main's row for a site: the profile Main uses there when Main's own sign-in doesn't work and
 * another profile's does. Google refuses signing in from Scient's browser, so Main gets Google
 * only as a copy, or through importing a browser profile that has it.
 */
export function MainSiteChoice({
  environmentId,
  account,
  accounts,
  profiles,
  onImport,
  onChromeWindow,
}: {
  environmentId: EnvironmentId;
  /** Main's row for the site. */
  account: AccountSummary;
  accounts: ReadonlyArray<AccountSummary>;
  profiles: ReturnType<typeof mergeProfiles>;
  onImport?: () => void;
  /** Signs Main in to Google in a Chrome window; absent where the desktop can't. */
  onChromeWindow?: (() => void) | undefined;
}) {
  const openBrowser = useAccountBrowser(environmentId);
  const site = "sites" in account.details ? account.details.sites[0] : undefined;
  const key = siteKey(account);
  const group = accounts.filter((row) => isBrowserSignIn(row) && siteKey(row) === key);
  const pageUrl = site ? (site.startsWith("https://") ? site : `https://${site}`) : undefined;
  const identities = siteIdentities(group, pageUrl).map((identity) => identity.profileId);
  const mainWorks = identities.includes(DEFAULT_BROWSER_PROFILE_ID);
  const using = mainWorks ? undefined : profiles.find((profile) => profile.id === identities[0]);
  const google = site === GOOGLE_SITE;
  const usingRow = group.find(
    ({ details }) => details.kind === "website" && details.profileId === using?.id,
  );
  // Main's Google doesn't work and no profile here holds one that does.
  const googleMissing = google && !using && !mainWorks;
  if (!(using && pageUrl) && !(googleMissing && onImport)) return null;
  const copyIntoMain = async (row: AccountSummary, from: string) => {
    const outcome = await copySignInIntoMain(environmentId, row);
    if (outcome === "copied" || outcome === "same")
      toastManager.add({ type: "success", title: `Copied ${from}'s Google sign-in into Main` });
    else if (outcome === "conflict")
      toastManager.add({
        type: "info",
        title: "Main already holds a Google sign-in",
        description: "Sign out of Google in Main, then copy again.",
      });
    else toastManager.add({ type: "error", title: "Couldn't copy the sign-in into Main" });
  };
  return (
    <span className="flex items-center gap-1">
      {using ? <span className="text-xs text-muted-foreground">Using {using.name}</span> : null}
      <Menu>
        <MenuTrigger
          render={
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label={`Who Main uses on ${account.name}`}
              onClick={(event) => event.stopPropagation()}
            />
          }
        >
          <EllipsisIcon />
        </MenuTrigger>
        <MenuPopup align="end">
          {googleMissing && onImport ? (
            <MenuGroup>
              <MenuGroupLabel className="max-w-64">{GOOGLE_SIGNED_OUT}</MenuGroupLabel>
              {onChromeWindow ? (
                <MenuItem onClick={onChromeWindow}>{CHROME_WINDOW_ACTION}</MenuItem>
              ) : null}
              <MenuItem onClick={onImport}>Import from a browser…</MenuItem>
            </MenuGroup>
          ) : google && using && usingRow ? (
            <MenuItem onClick={() => void copyIntoMain(usingRow, using.name)}>
              Copy from {using.name}
            </MenuItem>
          ) : using && pageUrl ? (
            <MenuItem onClick={() => void openBrowser(pageUrl, using.id)}>
              Open in {using.name}
            </MenuItem>
          ) : null}
        </MenuPopup>
      </Menu>
    </span>
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

/** The line under a key's name: its service and what uses it. */
const keyDetail = (row: ApiKeyRow) =>
  [row.service, [...new Set(row.uses.map((use) => use.label))].join(", ")]
    .filter(Boolean)
    .join(" · ");

/** Every key, wherever it is stored. Keeping one in Accounts makes it the copy its users follow. */
function ApiKeysDialog({
  rows,
  roots,
  environmentId,
  canWrite,
  onEdit,
  onActivity,
  onKept,
  onClose,
}: {
  rows: ReadonlyArray<ApiKeyRow>;
  roots: ReadonlyArray<string>;
  environmentId: EnvironmentId;
  canWrite: boolean;
  onEdit: (account: AccountSummary) => void;
  onActivity: (entries: ReadonlyArray<AccountActivityEntry>) => void;
  onKept: (file: string, name: string) => void;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const keeping = useRef(new Set<string>());
  const link = useAccountCommand(accountsState.linkKey, environmentId);
  const unlink = useAccountCommand(accountsState.unlinkKey, environmentId);
  const keepPlainKey = useAccountCommand(accountsState.keepPlainKey, environmentId);
  const savedKeys = rows.flatMap((row) =>
    row.stored === "accounts" && row.account.secrets.token
      ? [{ value: row.account.accountId, name: row.name }]
      : [],
  );
  const open = (href: ApiKeyRow["uses"][number]["href"]) => {
    onClose();
    void navigate({ to: href });
  };
  const openLabel = (label: string) =>
    label === "Custom models" ? "Open Custom models" : `Open ${label} settings`;
  const keep = async (row: ApiKeyRow) => {
    if (keeping.current.has(row.id)) return;
    keeping.current.add(row.id);
    const result =
      row.stored === "agent"
        ? await link({ instanceId: row.instanceId, variable: row.variable })
        : row.stored === "files"
          ? await keepPlainKey({ roots, file: row.file, name: row.name })
          : undefined;
    keeping.current.delete(row.id);
    if (!result?.ok) return;
    if (row.stored === "files") onKept(row.file, row.name);
    toastManager.add({ type: "success", title: `Kept ${row.name} in Accounts` });
  };
  return (
    <ListDialog title="API keys" onClose={onClose}>
      {rows.map((row) =>
        row.stored === "accounts" ? (
          <AccountRow
            key={row.id}
            account={row.account}
            environmentId={environmentId}
            canWrite={canWrite}
            onEdit={() => onEdit(row.account)}
            onActivity={onActivity}
            detail={keyDetail(row) || KIND_LABELS["api-key"]}
            menu={
              <>
                {[...new Map(row.uses.map((use) => [use.label, use.href])).entries()].map(
                  ([label, href]) => (
                    <MenuItem key={label} onClick={() => open(href)}>
                      {openLabel(label)}
                    </MenuItem>
                  ),
                )}
                {row.uses.flatMap(({ label, link: target }) =>
                  target
                    ? [
                        <MenuItem
                          key={`${target.instanceId}:${target.variable}`}
                          onClick={() => void unlink(target)}
                        >
                          Stop using in {label}
                        </MenuItem>,
                      ]
                    : [],
                )}
              </>
            }
          />
        ) : (
          <SettingsRow
            key={row.id}
            {...(row.uses[0] ? clickableAccountRow(() => open(row.uses[0]!.href)) : {})}
            aria-label={row.uses[0] ? `Open where ${row.name} is used` : undefined}
            title={
              <span className="flex min-w-0 items-center gap-3">
                <span className="flex size-10 shrink-0 items-center justify-center rounded-[25%] bg-muted">
                  <KeyRoundIcon className="size-4 text-muted-foreground" />
                </span>
                <span className="grid min-w-0 gap-1">
                  <span className="truncate text-left">{row.name}</span>
                  <span className="truncate text-xs text-muted-foreground">
                    {onlyIn(row) ?? keyDetail(row)}
                  </span>
                </span>
              </span>
            }
            control={
              <span className="flex items-center gap-2">
                {row.stored === "agent" && savedKeys.length ? (
                  <span className="w-36 shrink-0">
                    <ApiKeyAccountPicker
                      aria-label={`Key in Accounts for ${row.name}`}
                      emptyLabel="Its own key"
                      options={savedKeys}
                      size="xs"
                      value=""
                      disabled={!canWrite}
                      onChange={(event) => {
                        const accountId = event.currentTarget.value;
                        if (accountId)
                          void link({
                            instanceId: row.instanceId,
                            variable: row.variable,
                            accountId: AccountId.make(accountId),
                          });
                      }}
                    />
                  </span>
                ) : null}
                {row.stored === "agent" || row.stored === "files" ? (
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={!canWrite}
                    onClick={() => void keep(row)}
                  >
                    Keep in Accounts
                  </Button>
                ) : null}
              </span>
            }
          />
        ),
      )}
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
  const chromeSignIn = useChromeSignIn(environmentId);
  const [dialog, setDialog] = useState<
    "add" | "import" | "1password" | "passwords" | "apps" | "sign-in-codes" | "api-keys" | null
  >(null);
  const [editing, setEditing] = useState<AccountSummary | null>(null);
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
  const keys = apiKeyRows({
    accounts: snapshot.accounts,
    keyLinks: snapshot.keyLinks,
    instances: serverSettings?.providerInstances ?? {},
    customModelKeys: snapshot.customModelKeys,
    plainKeys,
    driverName: (driver) =>
      PROVIDER_DISPLAY_NAMES[driver as keyof typeof PROVIDER_DISPLAY_NAMES] ?? driver,
  });
  const keysToKeep = keys.filter((row) => onlyIn(row) !== undefined).length;
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
  // Lists that grow on their own (saved passwords, sign-ins managed elsewhere) are one row each,
  // and browser sign-ins are under their profiles, so the page shows what was added on purpose.
  const savedPasswords = snapshot.accounts.filter(isSavedPassword);
  const importingPasswords = useImportingPasswords();
  const githubRows = githubIdentities(snapshot.managedElsewhere, inventory.data?.connectors ?? []);
  // Connections you sign in to. GitHub's are its identities above; Custom models' are API keys.
  const managedRows = [
    ...providerRows,
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
          .filter(
            (account) =>
              !isSavedPassword(account) &&
              !isBrowserSignIn(account) &&
              account.details.kind !== "api-key",
          )
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
        {keys.length ? (
          <ListRow
            icon={<KeyRoundIcon />}
            title="API keys"
            detail={[
              keys.length === 1 ? "1 key" : `${keys.length} keys`,
              keysToKeep ? `${keysToKeep} not in Accounts` : undefined,
            ]
              .filter(Boolean)
              .join(" · ")}
            onOpen={() => setDialog("api-keys")}
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
        {managedRows.length || githubRows.length ? (
          <ListRow
            icon={<LinkIcon />}
            title="Apps and connectors"
            detail={[
              ...githubRows.map((row) => row.login),
              ...managedRows.map((row) => row.name),
            ].join(", ")}
            onOpen={() => setDialog("apps")}
          />
        ) : null}
      </SettingsSection>
      <BrowserProfiles
        environmentId={environmentId}
        snapshot={snapshot}
        canWrite={canWrite}
        onImport={() => setDialog("import")}
        onChromeWindow={chromeSignIn.available ? chromeSignIn.start : undefined}
        renderSignIn={(account, menu) => (
          <AccountRow
            key={account.accountId}
            account={account}
            environmentId={environmentId}
            canWrite={canWrite}
            onEdit={() => setEditing(account)}
            onActivity={setActivity}
            menu={menu}
            aside={
              account.details.kind === "website" &&
              account.details.profileId === DEFAULT_BROWSER_PROFILE_ID ? (
                <MainSiteChoice
                  environmentId={environmentId}
                  account={account}
                  accounts={snapshot.accounts}
                  profiles={profiles}
                  onImport={() => setDialog("import")}
                  onChromeWindow={
                    chromeSignIn.available
                      ? () => chromeSignIn.start({ id: DEFAULT_BROWSER_PROFILE_ID, name: "Main" })
                      : undefined
                  }
                />
              ) : null
            }
          />
        )}
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
            if (dialog !== "passwords" && dialog !== "api-keys") setDialog(null);
          }}
        />
      ) : null}
      {chromeSignIn.dialog}
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
      {dialog === "api-keys" ? (
        <ApiKeysDialog
          rows={keys}
          roots={projectRoots}
          environmentId={environmentId}
          canWrite={canWrite}
          onEdit={setEditing}
          onActivity={setActivity}
          onKept={(file, name) =>
            setPlainKeys((current) =>
              current.map((item) =>
                item.file === file && item.name === name ? { ...item, kept: true } : item,
              ),
            )
          }
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
      {dialog === "apps" ? (
        <ListDialog title="Apps and connectors" onClose={() => setDialog(null)}>
          {githubRows.map((identity) => (
            <GitHubIdentityRow key={identity.id} identity={identity} />
          ))}
          {managedRows.map((row) => (
            <ManagedAccountRow
              key={`${row.kind}:${row.id}`}
              row={row}
              environmentId={environmentId}
            />
          ))}
        </ListDialog>
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
