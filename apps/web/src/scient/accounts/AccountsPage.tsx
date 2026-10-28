import { useAtomValue } from "@effect/atom-react";
import {
  DEFAULT_BROWSER_PROFILE_ID,
  resolveBrowserProfiles,
  type AccountActivityEntry,
  type AccountSummary,
  type AccountsSnapshot,
  type ConnectorSummary,
  type EnvironmentId,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { ChevronRightIcon, KeyRoundIcon, PlusIcon } from "lucide-react";
import { useRef, useState } from "react";

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
import { readLocalApi } from "~/localApi";
import { ExtensionIcon } from "~/scient/extensions/ExtensionRow";
import { extensionsInventory } from "~/scient/extensions/extensionsState";
import { useProviderInventory } from "~/scient/extensions/useProviderInventory";
import { usePrimaryEnvironmentId } from "~/state/environments";
import { useEnvironmentQuery } from "~/state/query";
import { providersIgnoringCheckedAtAtom } from "~/state/server";
import "./accounts.css";
import { AccountApprovals } from "./AccountApprovals";
import { AccessChip, ControlsMenu, ScopeSubmenu } from "./AccountControls";
import { AccountDialog } from "./AccountDialog";
import { AccountLogo } from "./AccountLogo";
import { accountsState } from "./accountsState";
import {
  KIND_LABELS,
  accountIconUrl,
  accountManagePage,
  isSavedPassword,
  providerManagedAccounts,
} from "./accountsView";
import { AccountStoreMenuItems } from "./AccountStoreMenuItems";
import { BrowserImportDialog, BrowserProfiles } from "./BrowserProfiles";
import { clickableAccountRow } from "./clickableAccountRow";
import { OnePasswordDialog, PasswordFileInput, PasswordStores } from "./PasswordStores";
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
  const rejection =
    account.lastSignInOutcome === "password-rejected"
      ? "Password rejected"
      : account.lastSignInOutcome === "code-rejected"
        ? "Code rejected"
        : account.signedOut
          ? "Signed out"
          : null;
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
          {rejection ? <span className="text-xs text-muted-foreground">{rejection}</span> : null}
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
            {account.signedOut && details.kind === "website" ? (
              <MenuItem onClick={() => void openSite(details.loginUrl ?? site)}>
                Sign in again
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

function AccountsContent({
  environmentId,
  snapshot,
  canWrite,
}: {
  environmentId: EnvironmentId;
  snapshot: AccountsSnapshot;
  canWrite: boolean;
}) {
  const [dialog, setDialog] = useState<"add" | "import" | "1password" | "passwords" | null>(null);
  const [editing, setEditing] = useState<AccountSummary | null>(null);
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
  // Saved passwords, often hundreds from a browser, get one row so the page stays short.
  const savedPasswords = snapshot.accounts.filter(isSavedPassword);
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
          .filter((account) => !isSavedPassword(account))
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
          <SettingsRow
            {...clickableAccountRow(() => setDialog("passwords"))}
            aria-label="Show saved passwords"
            title={
              <span className="flex min-w-0 items-center gap-3">
                <span className="flex size-10 shrink-0 items-center justify-center rounded-[25%] bg-muted">
                  <KeyRoundIcon className="size-4 text-muted-foreground" />
                </span>
                <span className="grid min-w-0 gap-1">
                  <span className="truncate text-left">Saved passwords</span>
                  <span className="truncate text-xs text-muted-foreground">
                    {savedPasswords.length === 1 ? "1 site" : `${savedPasswords.length} sites`}
                  </span>
                </span>
              </span>
            }
            control={<ChevronRightIcon className="size-4 text-muted-foreground" />}
          />
        ) : null}
      </SettingsSection>
      <BrowserProfiles
        environmentId={environmentId}
        snapshot={snapshot}
        canWrite={canWrite}
        onImport={() => setDialog("import")}
      />
      {managedRows.length ? (
        <SettingsSection title="Other sign-ins">
          {managedRows.map((row) => (
            <ManagedAccountRow
              key={`${row.kind}:${row.id}`}
              row={row}
              environmentId={environmentId}
            />
          ))}
        </SettingsSection>
      ) : null}
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
            setDialog(null);
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
                  <time>{new Date(entry.at).toLocaleString()}</time> · {entry.action} ·{" "}
                  {entry.decision}
                  {entry.signInOutcome
                    ? ` · ${entry.signInOutcome}`
                    : entry.outcome
                      ? ` · ${entry.outcome}`
                      : ""}
                </div>
              ))}
            </DialogPanel>
          </DialogPopup>
        </Dialog>
      ) : null}
    </div>
  );
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
