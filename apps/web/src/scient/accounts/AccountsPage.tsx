import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { KeyRoundIcon } from "lucide-react";
import type {
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
import { AccessChip, ControlsMenu, ScopeDialog } from "./AccountControls";
import { AccountDialog } from "./AccountDialog";
import { BrowserProfiles, BrowserImportDialog } from "./BrowserProfiles";
import { PasswordStores, OnePasswordDialog } from "./PasswordStores";
import { AccountApprovals } from "./AccountApprovals";

function AccountRow({
  account,
  environmentId,
  canWrite,
  onEdit,
  onScope,
  onActivity,
}: {
  account: AccountSummary;
  environmentId: EnvironmentId;
  canWrite: boolean;
  onEdit: () => void;
  onScope: () => void;
  onActivity: (entries: ReadonlyArray<AccountActivityEntry>) => void;
}) {
  const controls = useAccountCommand(accountsState.setControls, environmentId);
  const test = useAccountCommand(accountsState.test, environmentId);
  const remove = useAccountCommand(accountsState.remove, environmentId);
  const activity = useAccountCommand(accountsState.activity, environmentId);
  const [busy, setBusy] = useState(false);
  const target = { type: "account", accountId: account.accountId } as const;
  const details = account.details;
  return (
    <SettingsRow
      title={
        <span className="flex items-center gap-2">
          <KeyRoundIcon className="size-4 text-muted-foreground" />
          {account.name}
          {account.status === "needs-attention" ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <span
                    role="img"
                    aria-label="Needs attention"
                    className="size-1.5 rounded-full bg-amber-500"
                  />
                }
              />
              <TooltipPopup>{account.statusMessage ?? "Needs attention"}</TooltipPopup>
            </Tooltip>
          ) : null}
        </span>
      }
      description={[
        details.kind.replaceAll("-", " "),
        "sites" in details
          ? details.sites.join(", ")
          : details.kind === "database"
            ? details.host
            : details.tool,
      ]
        .filter(Boolean)
        .join(" · ")}
      control={
        <div className="flex items-center gap-2">
          <AccessChip
            environmentId={environmentId}
            target={target}
            access={account.controls.access}
            disabled={!canWrite || busy}
          />
          <ControlsMenu disabled={!canWrite || busy}>
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
            <MenuCheckboxItem
              variant="switch"
              checked={account.controls.visibility === "readable"}
              onCheckedChange={(readable) =>
                void controls({ target, visibility: readable ? "readable" : "hidden" })
              }
            >
              Use in scripts
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
            <MenuItem onClick={onScope}>Available in…</MenuItem>
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
  const [scopeAccount, setScopeAccount] = useState<AccountSummary | null>(null);
  const [activity, setActivity] = useState<ReadonlyArray<AccountActivityEntry> | null>(null);
  const userProfiles = useClientSettings((settings) => settings.browserProfiles);
  const inventory = useEnvironmentQuery(extensionsInventory({ environmentId, input: {} }));
  const setAccess = useAccountCommand(accountsState.setAgentAccess, environmentId);
  const controls = useAccountCommand(accountsState.setControls, environmentId);
  const firstRun =
    snapshot.accounts.length === 0 &&
    !snapshot.profiles.some((profile) => profile.source) &&
    userProfiles.length === 0;
  const connectorRows = inventory.data?.connectors.map((connector) => (
    <SettingsRow
      key={connector.connectorId}
      title={connector.displayName}
      description="Extension"
      control={
        <Link to="/settings/extensions/installed" className="text-sm text-primary hover:underline">
          Extensions
        </Link>
      }
    />
  ));
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
      ) : (
        <>
          <BrowserProfiles
            environmentId={environmentId}
            snapshot={snapshot}
            canWrite={canWrite}
            onImport={() => setDialog("import")}
          />
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
                onScope={() => setScopeAccount(account)}
                onActivity={setActivity}
              />
            ))}

            {connectorRows}
          </SettingsSection>
        </>
      )}
      {firstRun && inventory.data?.connectors.length ? (
        <SettingsSection title="Accounts">{connectorRows}</SettingsSection>
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
      {scopeAccount ? (
        <ScopeDialog
          environmentId={environmentId}
          scope={scopeAccount.controls.scope}
          onClose={() => setScopeAccount(null)}
          onSave={async (scope) => {
            if (!canWrite) return;
            const result = await controls({
              target: { type: "account", accountId: scopeAccount.accountId },
              scope,
            });
            if (result.ok) setScopeAccount(null);
          }}
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
                  {entry.outcome ? ` · ${entry.outcome}` : ""}
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
  const { data, canWrite } = useAccounts(environmentId);
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
