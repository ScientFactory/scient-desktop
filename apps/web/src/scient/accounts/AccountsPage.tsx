import { useAtomValue } from "@effect/atom-react";
import {
  DEFAULT_BROWSER_PROFILE_ID,
  ThreadId,
  resolveBrowserProfiles,
  type AccountActivityEntry,
  type AccountCodeSources,
  type AccountSummary,
  type AccountsSnapshot,
  type ConnectorSummary,
  type EnvironmentId,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import {
  ChevronRightIcon,
  GlobeIcon,
  KeyRoundIcon,
  LinkIcon,
  MessageSquareIcon,
  PlusIcon,
} from "lucide-react";
import { useRef, useState, type ReactNode } from "react";

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
import { usePrimaryEnvironmentId } from "~/state/environments";
import { useEnvironmentQuery } from "~/state/query";
import { providersIgnoringCheckedAtAtom } from "~/state/server";
import { environmentThreadShells } from "~/state/threads";
import { formatRelativeTimeLabel } from "~/timestampFormat";
import "./accounts.css";
import { AccountApprovals } from "./AccountApprovals";
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
  isBrowserSignIn,
  isSavedPassword,
  mergeProfiles,
  providerManagedAccounts,
} from "./accountsView";
import { AccountStoreMenuItems } from "./AccountStoreMenuItems";
import { BrowserImportDialog, BrowserProfiles } from "./BrowserProfiles";
import { clickableAccountRow } from "./clickableAccountRow";
import { OnePasswordDialog, PasswordFileInput, PasswordStores } from "./PasswordStores";
import { ProfilePicture } from "./ProfilePicture";
import { useAccountBrowser } from "./useAccountBrowser";
import { useAccountCommand, useAccounts } from "./useAccounts";
import { useWebsiteSessions } from "./useWebsiteSessions";

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
  const signInAgain =
    account.signedOut || ["signed-out", "needs-you"].includes(account.lastCheck?.state ?? "");
  const openSite = async (url = site) => {
    if (!url) return;
    await openBrowser(url, details.kind === "website" ? details.profileId : undefined);
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
              {details.kind === "website" && !account.secrets.password
                ? `Browser sign-in · ${profiles.find((profile) => profile.id === (details.profileId ?? newTabProfileId ?? DEFAULT_BROWSER_PROFILE_ID))?.name ?? "Browser profile"}`
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
              {account.lastCheck?.message ? (
                <TooltipPopup>{account.lastCheck.message}</TooltipPopup>
              ) : null}
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
          <AccessChip
            environmentId={environmentId}
            target={target}
            access={account.controls.access}
            disabled={!canWrite || busy}
          />
          <ControlsMenu disabled={!canWrite || busy}>
            {signInAgain && details.kind === "website" ? (
              <MenuItem onClick={() => void openSite(details.loginUrl ?? site)}>
                Sign in again
              </MenuItem>
            ) : null}
            {details.kind === "website" || details.kind === "library" ? (
              <MenuItem
                onClick={async () => {
                  setBusy(true);
                  await check({ accountId: account.accountId });
                  setBusy(false);
                }}
              >
                Check sign-in
              </MenuItem>
            ) : null}
            {site ? <MenuItem onClick={() => void openSite()}>Open {site}</MenuItem> : null}
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
            {details.kind !== "website" && details.kind !== "library" ? (
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

/** One site signed in from several browser profiles: the profiles' pictures, opening to each. */
function SignInGroupRow({
  accounts,
  profiles,
  onOpen,
}: {
  accounts: ReadonlyArray<AccountSummary>;
  profiles: ReturnType<typeof mergeProfiles>;
  onOpen: () => void;
}) {
  const first = accounts[0]!;
  const site = "sites" in first.details ? first.details.sites[0] : undefined;
  const iconUrl = accountIconUrl(site ? [site] : [], first.name);
  const signedIn = accounts.flatMap((account) => {
    const profileId = account.details.kind === "website" ? account.details.profileId : undefined;
    const profile = profiles.find((item) => item.id === profileId);
    return profile ? [profile] : [];
  });
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
              Browser sign-in · {signedIn.map((profile) => profile.name).join(", ")}
            </span>
          </span>
        </span>
      }
      control={
        <span className="flex items-center gap-2">
          <span className="flex -space-x-1.5">
            {signedIn.map((profile) => (
              <ProfilePicture
                key={profile.id}
                size="sm"
                name={profile.name}
                picture={profile.record.picture}
                color={profile.record.color}
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
  onOpen,
}: {
  icon: ReactNode;
  title: string;
  detail: string;
  onOpen: () => void;
}) {
  return (
    <SettingsRow
      {...clickableAccountRow(onOpen)}
      aria-label={`Show ${title.toLowerCase()}`}
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

const FULL_DISK_ACCESS_URL =
  "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_AllFiles";

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
  const [needsAccess, setNeedsAccess] = useState(false);
  const change = async (next: AccountCodeSources) => {
    const result = await set(next);
    if (result.ok) setNeedsAccess(result.value.messagesNeedAccess);
  };
  return (
    <ListDialog title="Sign-in codes" onClose={onClose}>
      {isMacPlatform(navigator.platform) ? (
        <SettingsRow
          title="Codes from Messages"
          description="Texts forwarded to this Mac. Needs Full Disk Access, which also lets Scient read your other files."
          control={
            <Switch
              aria-label="Codes from Messages"
              checked={sources.messages}
              disabled={!canWrite}
              onCheckedChange={(messages) => void change({ ...sources, messages })}
            />
          }
        />
      ) : null}
      {needsAccess ? (
        <SettingsRow
          title="macOS hasn't given Scient access"
          control={
            <Button
              size="xs"
              variant="outline"
              onClick={() =>
                void readLocalApi()
                  ?.shell.openExternal(FULL_DISK_ACCESS_URL)
                  .catch(() => undefined)
              }
            >
              Open Full Disk Access
            </Button>
          }
        />
      ) : null}
      <SettingsRow
        title="Codes from Gmail"
        description="Unread mail in the browser profile you sign in with. Nothing new to connect."
        control={
          <Switch
            aria-label="Codes from Gmail"
            checked={sources.mail}
            disabled={!canWrite}
            onCheckedChange={(mail) => void change({ ...sources, mail })}
          />
        }
      />
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
    | null
  >(null);
  const [editing, setEditing] = useState<AccountSummary | null>(null);
  const [signIns, setSignIns] = useState<ReadonlyArray<AccountSummary> | null>(null);
  const [checking, setChecking] = useState(false);
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
  const setAccess = useAccountCommand(accountsState.setAgentAccess, environmentId);
  // Lists that grow on their own (saved passwords, sign-ins recorded while browsing, sign-ins
  // managed elsewhere) are one row each, so the page shows what was added on purpose.
  const savedPasswords = snapshot.accounts.filter(isSavedPassword);
  const browserSignIns = accountListRows(snapshot.accounts.filter(isBrowserSignIn));
  const managedRows = [
    ...providerManagedAccounts(providerInventory.providers),
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
              const result = await checkAll({});
              setChecking(false);
              if (result.ok)
                toastManager.add({
                  type: "success",
                  title: result.value.checked
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
        {savedPasswords.length ? (
          <ListRow
            icon={<KeyRoundIcon />}
            title="Saved passwords"
            detail={savedPasswords.length === 1 ? "1 site" : `${savedPasswords.length} sites`}
            onOpen={() => setDialog("passwords")}
          />
        ) : null}
        {browserSignIns.length ? (
          <ListRow
            icon={<GlobeIcon />}
            title="Browser sign-ins"
            detail={browserSignIns.length === 1 ? "1 site" : `${browserSignIns.length} sites`}
            onOpen={() => setDialog("browser-sign-ins")}
          />
        ) : null}
        <ListRow
          icon={<MessageSquareIcon />}
          title="Sign-in codes"
          detail={
            [snapshot.codeSources?.messages && "Messages", snapshot.codeSources?.mail && "Gmail"]
              .filter(Boolean)
              .join(", ") || "You type them in"
          }
          onOpen={() => setDialog("sign-in-codes")}
        />
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
                accounts={row}
                profiles={profiles}
                onOpen={() => setSignIns(row)}
              />
            ),
          )}
        </ListDialog>
      ) : null}
      {dialog === "sign-in-codes" ? (
        <SignInCodesDialog
          sources={snapshot.codeSources ?? { messages: false, mail: false }}
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
