import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { BrowserProfileId } from "@t3tools/contracts";
import { openUrlInPreview } from "~/browser/openFileInPreview";
import { useScratchProject } from "~/hooks/useScratchProject";
import { useNewThreadHandler } from "~/hooks/useHandleNewThread";
import { useRightPanelStore } from "~/rightPanelStore";
import { previewEnvironment } from "~/state/preview";
import { useAtomCommand } from "~/state/use-atom-command";
import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { KeyRoundIcon } from "lucide-react";
import type {
  ConnectorSummary,
  AccountActivityEntry,
  AccountSummary,
  AccountsSnapshot,
  EnvironmentId,
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
import { MenuItem, MenuCheckboxItem } from "~/components/ui/menu";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogPanel,
} from "~/components/ui/dialog";
import { useClientSettings } from "~/hooks/useSettings";
import { usePrimaryEnvironmentId } from "~/state/environments";
import { useEnvironmentQuery } from "~/state/query";
import { previewBridge } from "~/components/preview/previewBridge";
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
import { KIND_LABELS, accountIconUrl, accountManagePage } from "./accountsView";
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
        <span className="flex min-w-0 items-baseline gap-2">
          {iconUrl ? (
            <AccountLogo src={iconUrl} className="size-6 self-center rounded-md" />
          ) : (
            <KeyRoundIcon className="size-4 shrink-0 self-center text-muted-foreground" />
          )}
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
}: {
  row: {
    kind: "github" | "custom-model" | "extension";
    name: string;
    detail?: string | undefined;
    href: "/settings/source-control" | "/settings/custom-models" | "/settings/extensions/installed";
  };
}) {
  const iconUrl = accountIconUrl(
    row.kind === "github" ? ["github.com"] : row.detail ? [row.detail] : [],
    row.name,
  );
  return (
    <SettingsRow
      title={
        <span className="flex min-w-0 items-baseline gap-2">
          {iconUrl ? (
            <AccountLogo src={iconUrl} className="size-6 self-center rounded-md" />
          ) : (
            <KeyRoundIcon className="size-4 shrink-0 self-center text-muted-foreground" />
          )}
          <span className="truncate">{row.name}</span>
          {row.detail ? (
            <span className="truncate text-xs text-muted-foreground">{row.detail}</span>
          ) : null}
          <Link to={row.href} className="shrink-0 text-xs text-muted-foreground hover:underline">
            Managed in{" "}
            {row.kind === "github"
              ? "Source Control"
              : row.kind === "custom-model"
                ? "Custom models"
                : "Extensions"}
          </Link>
        </span>
      }
    />
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
  const [dialog, setDialog] = useState<"add" | "import" | "1password" | null>(null);
  const [editing, setEditing] = useState<AccountSummary | null>(null);
  const [activity, setActivity] = useState<ReadonlyArray<AccountActivityEntry> | null>(null);
  const userProfiles = useClientSettings((settings) => settings.browserProfiles);
  const inventory = useEnvironmentQuery(extensionsInventory({ environmentId, input: {} }));
  const setAccess = useAccountCommand(accountsState.setAgentAccess, environmentId);
  const firstRun = snapshot.accounts.length === 0 && userProfiles.length === 0;
  const managedRows = [
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
    <div className="grid gap-8">
      <SettingsSection title="Accounts" hideTitle>
        <SettingsRow
          id="accounts-agent-access"
          title="Agent access"
          control={
            <Switch
              aria-label="Agent access"
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
      {firstRun ? (
        <div className="flex flex-wrap gap-3">
          {previewBridge ? (
            <Button variant="outline" disabled={!canWrite} onClick={() => setDialog("import")}>
              Import from your browser
            </Button>
          ) : null}
          <Button variant="outline" disabled={!canWrite} onClick={() => setDialog("1password")}>
            Connect 1Password
          </Button>
          <Button disabled={!canWrite} onClick={() => setDialog("add")}>
            Add an account
          </Button>
        </div>
      ) : null}
      <BrowserProfiles
        environmentId={environmentId}
        snapshot={snapshot}
        canWrite={canWrite}
        onImport={() => setDialog("import")}
      />
      {!firstRun || snapshot.accounts.length > 0 || managedRows.length ? (
        <SettingsSection
          id="accounts-list"
          title="Accounts"
          headerAction={
            <Button
              size="xs"
              variant="outline"
              disabled={!canWrite}
              onClick={() => setDialog("add")}
            >
              Add
            </Button>
          }
        >
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
          {managedRows.map((row) => (
            <ManagedAccountRow key={`${row.kind}:${row.id}`} row={row} />
          ))}
        </SettingsSection>
      ) : null}
      <PasswordStores
        environmentId={environmentId}
        snapshot={snapshot}
        canWrite={canWrite}
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
