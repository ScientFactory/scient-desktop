import { useRef, useState } from "react";
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
      <DialogPopup>
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
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const disconnect = useAccountCommand(accountsState.disconnectOnePassword, environmentId);
  const importPasswords = useAccountCommand(accountsState.importPasswords, environmentId);
  const status = snapshot.stores.onePassword;
  return (
    <SettingsSection
      title="Password stores"
      id="accounts-password-stores"
      headerAction={
        <Button
          size="xs"
          variant="outline"
          disabled={!canWrite || busy}
          onClick={() => fileRef.current?.click()}
        >
          Import passwords…
        </Button>
      }
    >
      {snapshot.stores.scient.protection === "file" ? (
        <SettingsRow title="Scient" status="Store key protected by a local file" />
      ) : null}
      <SettingsRow
        title="System keychain"
        status={snapshot.stores.keychain.available ? undefined : "Unavailable"}
      />
      <SettingsRow
        title="1Password"
        description={status.state === "connected" ? `Connected · ${status.label}` : undefined}
        status={status.state === "error" ? "Connection needs attention" : undefined}
        control={
          status.state === "connected" ? (
            <Button
              size="xs"
              variant="outline"
              disabled={!canWrite || busy}
              onClick={async () => {
                setBusy(true);
                await disconnect({});
                setBusy(false);
              }}
            >
              Disconnect
            </Button>
          ) : (
            <Button size="xs" variant="outline" disabled={!canWrite} onClick={onConnect}>
              Connect
            </Button>
          )
        }
      />
      <input
        ref={fileRef}
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
    </SettingsSection>
  );
}
