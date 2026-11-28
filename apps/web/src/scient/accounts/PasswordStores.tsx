import { msg, T, useGT } from "gt-react";
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
import { useHasSecretProvidersEnvironment } from "~/components/settings/useAvailableSettingsSearchItems";
import { Link } from "@tanstack/react-router";
import { toastManager } from "~/components/ui/toast";
import { accountsState } from "./accountsState";
import { useAccountCommand } from "./useAccounts";
import { readImageQr } from "./imageQr";
import { ControlsMenu } from "./AccountControls";
import { MenuItem } from "~/components/ui/menu";
import { StoreTitle } from "./StoreTitle";
import { AccountField } from "./AccountDialog";
import { m } from "~/i18n/messages";

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
  const gt = useGT();
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogPopup data-accounts-dialog>
        <DialogHeader>
          <DialogTitle>
            <T>Connect 1Password</T>
          </DialogTitle>
        </DialogHeader>
        <DialogPanel>
          <div className="grid gap-4">
            <AccountField label={gt("Connect with")}>
              <NativeSelect
                value={mode}
                onChange={(event) => {
                  setMode(event.target.value === "desktop" ? "desktop" : "service-account");
                  setValue("");
                }}
              >
                <option value="service-account">{gt("Service account")}</option>
                <option value="desktop">{gt("Desktop app")}</option>
              </NativeSelect>
            </AccountField>
            <AccountField
              label={mode === "desktop" ? gt("Account name") : gt("Service-account token")}
            >
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
            <T>Connect</T>
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
  const secretProviders = useHasSecretProvidersEnvironment();
  const gt = useGT();
  return (
    <SettingsSection title={gt("Password stores")} id="accounts-password-stores">
      {snapshot.stores.scient.protection === "file" ? (
        <SettingsRow title="Scient" status={gt("Store key protected by a local file")} />
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
                : gt("Unavailable")
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
                ? gt("Connected · {label}", { label: status.label })
                : status.state === "error"
                  ? gt("Connection needs attention")
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
                <T>Disconnect</T>
              </MenuItem>
            </ControlsMenu>
          ) : (
            <Button size="xs" variant="outline" disabled={!canWrite} onClick={onConnect}>
              <T>Connect</T>
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
      {secretProviders ? (
        <SettingsRow
          title={gt("Secrets")}
          control={
            <Button size="xs" variant="outline" render={<Link to="/settings/secrets" />}>
              <T>Open</T>
            </Button>
          }
        />
      ) : null}
    </SettingsSection>
  );
}

/**
 * The hidden file picker behind Accounts ▸ + ▸ Import passwords…: CSV exports from any browser, or
 * photos or screenshots of Google Authenticator's export QR codes, read on this device.
 */
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
  const readFiles = async (files: ReadonlyArray<File>) => {
    const images = files.filter((file) => file.type.startsWith("image/"));
    if (images.length === 0) return files[0] ? await files[0].text() : "";
    const texts = await Promise.all(
      images.map((image) => readImageQr(image).catch(() => undefined)),
    );
    return texts.filter((text) => text?.startsWith("otpauth-migration://")).join("\n");
  };
  return (
    <input
      ref={inputRef}
      type="file"
      accept=".csv,text/csv,image/*"
      multiple
      hidden
      onChange={async (event) => {
        const files = Array.from(event.currentTarget.files ?? []);
        event.currentTarget.value = "";
        if (files.length === 0 || !canWrite || busy) return;
        if (files.some((file) => file.size > 10_000_000)) {
          toastManager.add({ type: "error", title: m(msg("Password file is too large")) });
          return;
        }
        setBusy(true);
        const content = await readFiles(files).catch(() => "");
        if (!content) {
          toastManager.add({ type: "error", title: m(msg("Could not read password file")) });
          setBusy(false);
          return;
        }
        const result = await importPasswords({ format: "auto", content }).catch(() => undefined);
        if (!result)
          toastManager.add({ type: "error", title: m(msg("Could not read password file")) });
        else if (result.ok)
          toastManager.add({
            type: "success",
            title:
              [
                result.value.created
                  ? m(msg("Added {count}", { count: result.value.created }))
                  : "",
                result.value.updated
                  ? m(msg("Updated {count}", { count: result.value.updated }))
                  : "",
              ]
                .filter(Boolean)
                .join(" · ") || m(msg("Nothing new to import")),
            ...(result.value.unmatched?.length
              ? {
                  description: m(
                    msg("No login for {names}", { names: result.value.unmatched.join(", ") }),
                  ),
                }
              : {}),
          });
        setBusy(false);
      }}
    />
  );
}
