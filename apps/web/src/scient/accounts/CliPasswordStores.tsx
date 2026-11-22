import { msg, T, useGT, useMessages } from "gt-react";
import { StoreTitle } from "./StoreTitle";
import { ControlsMenu } from "./AccountControls";
import { MenuItem } from "~/components/ui/menu";
import { readLocalApi } from "~/localApi";
import { useState } from "react";
import type {
  CliPasswordStore,
  CliPasswordStatus,
  CliPasswordItem,
  CliPasswordSource,
  EnvironmentId,
} from "@t3tools/contracts";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { NativeSelect } from "~/components/ui/select";
import { SettingsRow } from "~/components/settings/settingsLayout";
import { accountsState } from "./accountsState";
import { useAccountCommand, usePasswordStorePermission } from "./useAccounts";

const cliStoreNames = { bitwarden: "Bitwarden", "proton-pass": "Proton Pass" };
const STATUS_WORDS: Readonly<Record<CliPasswordStatus["state"], string | undefined>> = {
  "not-connected": undefined,
  "not-installed": msg("Not installed"),
  unauthenticated: msg("Signed out in its app"),
  locked: undefined,
  unlocked: undefined,
  unavailable: msg("Needs attention"),
};
export function CliPasswordStoreRow({
  store,
  status,
  environmentId,
  canWrite,
}: {
  store: CliPasswordStore;
  status: CliPasswordStatus | undefined;
  environmentId: EnvironmentId;
  canWrite: boolean;
}) {
  const command = useAccountCommand(accountsState.passwordStore, environmentId);
  const permitted = usePasswordStorePermission(environmentId);
  const [current, setCurrent] = useState(status);
  const [password, setPassword] = useState("");
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  const gt = useGT();
  const messages = useMessages();
  const act = async (action: "connect" | "status" | "disconnect") => {
    if (!canWrite || !permitted || busy) return;
    setBusy(true);
    const pending = command({
      store,
      action,
      ...(action === "connect" && password ? { password } : {}),
    });
    setPassword("");
    const result = await pending;
    if (result.ok) setCurrent(result.value.status);
    setBusy(false);
  };
  const state = current?.state ?? "not-connected";
  const connected = state === "unlocked";
  return (
    <>
      <SettingsRow
        title={
          <StoreTitle
            name={cliStoreNames[store]}
            domain={store === "bitwarden" ? "bitwarden.com" : "proton.me"}
            status={
              connected
                ? [gt("Connected"), current?.email].filter(Boolean).join(" · ")
                : state === "locked"
                  ? [gt("Locked"), current?.email].filter(Boolean).join(" · ")
                  : STATUS_WORDS[state] && messages(STATUS_WORDS[state])
            }
          />
        }
        control={
          state === "not-installed" ? (
            <Button
              size="xs"
              variant="ghost"
              onClick={() =>
                void readLocalApi()?.shell.openExternal(
                  store === "bitwarden"
                    ? "https://bitwarden.com/help/cli/"
                    : "https://protonpass.github.io/pass-cli/",
                )
              }
            >
              <T>Install</T>
            </Button>
          ) : connected ? (
            <ControlsMenu disabled={!canWrite || !permitted || busy}>
              <MenuItem
                onClick={() => {
                  setExpanded(false);
                  setPassword("");
                  void act("disconnect");
                }}
              >
                <T>Disconnect</T>
              </MenuItem>
            </ControlsMenu>
          ) : expanded ? null : (
            <Button
              size="xs"
              variant="outline"
              disabled={!canWrite || !permitted || busy}
              onClick={() => {
                setExpanded(true);
                void act("status");
              }}
            >
              <T>Connect</T>
            </Button>
          )
        }
      />
      {expanded ? (
        <div className="grid gap-3 px-4 pb-4 text-sm">
          <p>
            {store === "bitwarden"
              ? gt(
                  "Install {cli}, then run {login} in your terminal. For Vaultwarden, run {config} with your server URL before logging in. Unlock here with your master password once.",
                  { cli: "bw", login: "bw login", config: "bw config server" },
                )
              : gt(
                  "Install {cli} and run {login} (and {unlock}, if needed) in your terminal, then connect.",
                  { cli: "pass-cli", login: "pass-cli login", unlock: "session unlock" },
                )}
          </p>
          {store === "bitwarden" ? (
            <Input
              aria-label={gt("Bitwarden master password")}
              type="password"
              autoComplete="off"
              placeholder={gt("Master password (once)")}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          ) : null}
          <div className="flex gap-2">
            <Button
              size="xs"
              variant="outline"
              disabled={!canWrite || !permitted || busy}
              onClick={() => void act("connect")}
            >
              {store === "bitwarden" ? gt("Unlock") : gt("Connect")}
            </Button>
            <Button
              size="xs"
              variant="ghost"
              disabled={busy}
              onClick={() => {
                setExpanded(false);
                setPassword("");
              }}
            >
              <T>Cancel</T>
            </Button>
          </div>
        </div>
      ) : null}
    </>
  );
}

export function CliPasswordPicker({
  store,
  environmentId,
  onChange,
}: {
  store: CliPasswordStore;
  environmentId: EnvironmentId;
  onChange: (source: CliPasswordSource | undefined) => void;
}) {
  const command = useAccountCommand(accountsState.passwordStore, environmentId);
  const permitted = usePasswordStorePermission(environmentId);
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<ReadonlyArray<CliPasswordItem>>([]);
  const [selected, setSelected] = useState("");
  const [field, setField] = useState("password");
  const [connection, setConnection] = useState("");
  const [busy, setBusy] = useState(false);
  const gt = useGT();
  const pick = (index: string, nextField: string) => {
    setSelected(index);
    setField(nextField);
    const item = items[Number(index)];
    onChange(
      index && item && connection
        ? {
            type: store,
            connection,
            itemId: item.itemId,
            ...(item.vaultId ? { vaultId: item.vaultId } : {}),
            field: nextField,
          }
        : undefined,
    );
  };
  return (
    <div className="grid gap-2">
      <div className="flex gap-2">
        <Input
          aria-label={gt("{store} search", { store: cliStoreNames[store] })}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <Button
          size="sm"
          variant="outline"
          disabled={!permitted || busy}
          onClick={async () => {
            if (!permitted || busy) return;
            setBusy(true);
            setSelected("");
            onChange(undefined);
            const result = await command({ store, action: "list", query });
            setItems(result.ok ? result.value.items : []);
            setConnection(result.ok ? (result.value.status.connection ?? "") : "");
            setBusy(false);
          }}
        >
          <T>Search items</T>
        </Button>
      </div>
      <NativeSelect
        aria-label={gt("{store} item", { store: cliStoreNames[store] })}
        value={selected}
        onChange={(event) => pick(event.target.value, field)}
      >
        <option value="">{gt("Choose an item…")}</option>
        {items.map((item, index) => (
          <option key={`${item.vaultId ?? ""}:${item.itemId}`} value={String(index)}>
            {item.name}
          </option>
        ))}
      </NativeSelect>
      <NativeSelect
        aria-label={gt("{store} field", { store: cliStoreNames[store] })}
        value={field}
        onChange={(event) => pick(selected, event.target.value)}
      >
        {[
          ...new Set([
            field,
            ...(selected
              ? (items[Number(selected)]?.fields ?? [])
              : ["username", "password", "totp"]),
          ]),
        ].map((name) => (
          <option key={name} value={name}>
            {name}
          </option>
        ))}
      </NativeSelect>
      {store === "proton-pass" ? (
        <Input
          aria-label={gt("Proton Pass custom field")}
          placeholder={gt("Custom field name")}
          value={field}
          onChange={(event) => pick(selected, event.target.value)}
        />
      ) : null}
    </div>
  );
}
