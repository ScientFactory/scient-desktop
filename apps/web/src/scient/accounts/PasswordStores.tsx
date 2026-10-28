import { CliPasswordStoreRow } from "./CliPasswordStores";
import { type RefObject, useState } from "react";
import type { AccountsSnapshot, EnvironmentId } from "@t3tools/contracts";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { NativeSelect } from "~/components/ui/select";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogPanel,
  DialogFooter,
} from "~/components/ui/dialog";
import { SettingsSection, SettingsRow } from "~/components/settings/settingsLayout";
import { toastManager } from "~/components/ui/toast";
import { accountsState } from "./accountsState";
import { useAccountCommand } from "./useAccounts";
import { ControlsMenu } from "./AccountControls";
import { MenuItem } from "~/components/ui/menu";
import { StoreTitle } from "./StoreTitle";
import { AccountField } from "./AccountDialog";

export function OnePasswordDialog({
  environmentId,
  canWrite,
  onClose,
}: {
  environmentId: EnvironmentId;
  canWrite: boolean;
  onClose: () => void;
}) {
  const [mode, setMode] = useState<"service-account" | "desktop">("service-account");
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const connect = useAccountCommand(accountsState.connectOnePassword, environmentId);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogPopup data-accounts-dialog>
        <DialogHeader>
          <DialogTitle>Connect 1Password</DialogTitle>
        </DialogHeader>
        <DialogPanel>
          <div className="grid gap-4">
            <AccountField label="Connect with">
              <NativeSelect
                value={mode}
                onChange={(event) => {
                  setMode(event.target.value === "desktop" ? "desktop" : "service-account");
                  setValue("");
                }}
              >
                <option value="service-account">Service account</option>
                <option value="desktop">Desktop app</option>
              </NativeSelect>
            </AccountField>
            <AccountField label={mode === "desktop" ? "Account name" : "Service-account token"}>
              <Input
                autoComplete="off"
                type={mode === "desktop" ? "text" : "password"}
                value={value}
                onChange={(event) => setValue(event.target.value)}
              />
            </AccountField>
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button
            disabled={!canWrite || busy || !value.trim()}
            onClick={async () => {
              if (!canWrite || busy) return;
              setBusy(true);
              const result = await connect(
                mode === "desktop" ? { mode, accountName: value.trim() } : { mode, token: value },
              );
              setBusy(false);
              if (result.ok) {
                setValue("");
                onClose();
              }
            }}
          >
            Connect
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

export function PasswordStores({
  environmentId,
  snapshot,
  canWrite,
  onConnect,
}: {
  environmentId: EnvironmentId;
  snapshot: AccountsSnapshot;
  canWrite: boolean;
  onConnect: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const disconnect = useAccountCommand(accountsState.disconnectOnePassword, environmentId);
  const status = snapshot.stores.onePassword;
  return (
    <SettingsSection title="Password stores" id="accounts-password-stores">
      {snapshot.stores.scient.protection === "file" ? (
        <SettingsRow title="Scient" status="Store key protected by a local file" />
      ) : null}
      <SettingsRow
        title={
          <StoreTitle
            name={
              {
                macos: "macOS Keychain",
                windows: "Windows Credential Manager",
                linux: "Secret Service",
              }[snapshot.stores.keychain.platform]
            }
            status={
              snapshot.stores.keychain.platform === "macos" || snapshot.stores.keychain.available
                ? undefined
                : "Unavailable"
            }
            domain={snapshot.stores.keychain.platform === "macos" ? "apple.com" : undefined}
          />
        }
      />
      <SettingsRow
        title={
          <StoreTitle
            name="1Password"
            domain="1password.com"
            status={
              status.state === "connected"
                ? `Connected · ${status.label}`
                : status.state === "error"
                  ? "Connection needs attention"
                  : undefined
            }
          />
        }
        control={
          status.state === "connected" ? (
            <ControlsMenu disabled={!canWrite || busy}>
              <MenuItem
                onClick={async () => {
                  setBusy(true);
                  await disconnect({});
                  setBusy(false);
                }}
              >
                Disconnect
              </MenuItem>
            </ControlsMenu>
          ) : (
            <Button size="xs" variant="outline" disabled={!canWrite} onClick={onConnect}>
              Connect
            </Button>
          )
        }
      />
      {(snapshot.stores.cli ? (["bitwarden", "proton-pass"] as const) : []).map((store) => (
        <CliPasswordStoreRow
          key={store}
          store={store}
          status={snapshot.stores.cli?.[store]}
          environmentId={environmentId}
          canWrite={canWrite}
        />
      ))}
    </SettingsSection>
  );
}

/** The hidden file picker behind Accounts ▸ + ▸ Import passwords…; CSV exports from any browser. */
export function PasswordFileInput({
  environmentId,
  canWrite,
  inputRef,
}: {
  environmentId: EnvironmentId;
  canWrite: boolean;
  inputRef: RefObject<HTMLInputElement | null>;
}) {
  const [busy, setBusy] = useState(false);
  const importPasswords = useAccountCommand(accountsState.importPasswords, environmentId);
  return (
    <input
      ref={inputRef}
      type="file"
      accept=".csv,text/csv"
      hidden
      onChange={async (event) => {
        const file = event.currentTarget.files?.[0];
        event.currentTarget.value = "";
        if (!file || !canWrite || busy) return;
        if (file.size > 10_000_000) {
          toastManager.add({ type: "error", title: "Password file is too large" });
          return;
        }
        setBusy(true);
        try {
          const result = await importPasswords({ format: "auto", content: await file.text() });
          if (result.ok)
            toastManager.add({
              type: "success",
              title:
                [
                  result.value.created ? `Added ${result.value.created}` : "",
                  result.value.updated ? `Updated ${result.value.updated}` : "",
                ]
                  .filter(Boolean)
                  .join(" · ") || "Nothing new to import",
            });
        } catch {
          toastManager.add({ type: "error", title: "Could not read password file" });
        }
        setBusy(false);
      }}
    />
  );
}
