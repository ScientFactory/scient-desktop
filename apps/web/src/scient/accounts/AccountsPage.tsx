import "./accounts.css";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { BrowserProfileId } from "@t3tools/contracts";
import { openUrlInPreview } from "~/browser/openFileInPreview";
import { useScratchProject } from "~/hooks/useScratchProject";
import { useNewThreadHandler } from "~/hooks/useHandleNewThread";
import { useRightPanelStore } from "~/rightPanelStore";
import { previewEnvironment } from "~/state/preview";
import { useAtomCommand } from "~/state/use-atom-command";
import { useRef, useState } from "react";
import { useAtomValue } from "@effect/atom-react";
import { providersIgnoringCheckedAtAtom } from "~/state/server";
import { useProviderInventory } from "~/scient/extensions/useProviderInventory";
import { Link } from "@tanstack/react-router";
import { ExtensionIcon } from "~/scient/extensions/ExtensionRow";
import { KeyRoundIcon, PlusIcon } from "lucide-react";
import type {
  ConnectorSummary,
  AccountActivityEntry,
  AccountSummary,
  AccountsSnapshot,
  EnvironmentId,
  ProviderInstanceId,
} from "@t3tools/contracts";
import {
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "~/components/settings/settingsLayout";
import { useOptionalSettingsScope } from "~/components/settings/SettingsScopeContext";
import { Tooltip, TooltipTrigger, TooltipPopup } from "~/components/ui/tooltip";
import { Button } from "~/components/ui/button";
import { Switch } from "~/components/ui/switch";
import { Menu, MenuTrigger, MenuPopup, MenuItem, MenuCheckboxItem } from "~/components/ui/menu";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogPanel,
} from "~/components/ui/dialog";
import { usePrimaryEnvironmentId } from "~/state/environments";
import { useEnvironmentQuery } from "~/state/query";
import { toastManager } from "~/components/ui/toast";
import { extensionsInventory } from "~/scient/extensions/extensionsState";
import { useAccountCommand, useAccounts } from "./useAccounts";
import { accountsState } from "./accountsState";
import { AccessChip, ControlsMenu, ScopeSubmenu } from "./AccountControls";
import { AccountDialog } from "./AccountDialog";
import { BrowserProfiles, BrowserImportDialog } from "./BrowserProfiles";
import { PasswordStores, OnePasswordDialog } from "./PasswordStores";
import { AccountApprovals } from "./AccountApprovals";
import { AccountLogo } from "./AccountLogo";
import {
  KIND_LABELS,
  accountIconUrl,
  accountManagePage,
  providerManagedAccounts,
} from "./accountsView";
import { useWebsiteSessions } from "./useWebsiteSessions";
import { AccountStoreMenuItems } from "./AccountStoreMenuItems";
import { readLocalApi } from "~/localApi";

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
  const { openScratchProject } = useScratchProject();
  const openThread = useNewThreadHandler();
  const openPreview = useAtomCommand(previewEnvironment.open, { reportFailure: false });
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
    const project = await openScratchProject(environmentId, "Could not open the site");
    if (!project) return;
    const opened = await openThread(scopeProjectRef(project.environmentId, project.id));
    if (!opened) return;
    const threadRef = scopeThreadRef(project.environmentId, opened.threadId);
    useRightPanelStore.getState().requestMaximize(threadRef);
    const result = await openUrlInPreview({
      threadRef,
      url: /^https?:\/\//.test(url) ? url : `https://${url}`,
      openPreview,
      ...(details.kind === "website" && details.profileId
        ? { profileId: BrowserProfileId.make(details.profileId) }
        : {}),
    });
    if (result._tag === "Failure")
      toastManager.add({ type: "error", title: "Could not open the site" });
  };
  const iconUrl = accountIconUrl("sites" in details ? details.sites : [], account.name);
  const managePage = accountManagePage("sites" in details ? details.sites : []);
  return (
    <SettingsRow
      title={
        <span className="flex min-w-0 items-center gap-3">
          {iconUrl ? (
            <AccountLogo src={iconUrl} className="size-9 self-center rounded-lg" />
          ) : (
            <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted">
              <KeyRoundIcon className="size-4 text-muted-foreground" />
            </span>
          )}
          <span className="grid min-w-0 gap-1">
            <button
              type="button"
              className="truncate text-left outline-none focus-visible:underline"
              onClick={onEdit}
            >
              {account.name}
            </button>
            <span className="truncate text-xs text-muted-foreground">
              {[
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
  const name = row.name.replace(/^claude\.ai[ :·-]*/i, "");
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
    name,
  );
  const content = (
    <>
      {logo ? (
        <AccountLogo src={logo} className="size-9 shrink-0 rounded-lg" />
      ) : (
        <ExtensionIcon name={name} environmentId={environmentId} />
      )}
      <span className="grid min-w-0 flex-1 gap-1">
        <span className="truncate text-sm font-medium">{name}</span>
        {domain ? <span className="truncate text-xs text-muted-foreground">{domain}</span> : null}
      </span>
      <span className="shrink-0 text-xs text-muted-foreground">
        {row.kind === "github"
          ? "Source Control"
          : row.kind === "custom-model"
            ? "Custom models"
            : row.kind === "claude"
              ? "Claude"
              : row.kind === "codex"
                ? "Codex"
                : "Extensions"}{" "}
        ›
      </span>
    </>
  );
  const className =
    "flex min-h-15 items-center gap-3 rounded-lg px-4 py-2 text-foreground hover:bg-accent/40 focus-visible:outline focus-visible:outline-1 focus-visible:outline-muted-foreground";
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

function AccountsContent({
  environmentId,
  snapshot,
  canWrite,
}: {
  environmentId: EnvironmentId;
  snapshot: AccountsSnapshot;
  canWrite: boolean;
}) {
  const [dialog, setDialog] = useState<"add" | "import" | "1password" | null>(null);
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
      <SettingsSection title="Agent access" hideTitle>
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
      </SettingsSection>
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
        {snapshot.accounts.map((account) => (
          <AccountRow
            key={account.accountId}
            account={account}
            environmentId={environmentId}
            canWrite={canWrite}
            onEdit={() => setEditing(account)}
            onActivity={setActivity}
          />
        ))}
      </SettingsSection>
      {managedRows.length ? (
        <SettingsSection title="Signed in elsewhere">
          {managedRows.map((row) => (
            <ManagedAccountRow
              key={`${row.kind}:${row.id}`}
              row={row}
              environmentId={environmentId}
            />
          ))}
        </SettingsSection>
      ) : null}
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
        fileRef={passwordFileRef}
        onConnect={() => setDialog("1password")}
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
