import { useState } from "react";
import {
  AccountSaveInput,
  type AccountDetails,
  type AccountSecretInput,
  type AccountWriteStore,
  type AccountSecretSummary,
  type AccountSummary,
  type AccountsSnapshot,
  type EnvironmentId,
  type KeychainCandidatesResult,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { NativeSelect } from "~/components/ui/select";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogPanel,
  DialogFooter,
} from "~/components/ui/dialog";
import { accountsState } from "./accountsState";
import { useAccountCommand } from "./useAccounts";
import {
  accountCatalogue,
  catalogueDetails,
  secretFields,
  type CatalogueEntry,
} from "./accountsView";

import { SaveStores } from "./SaveStores";

const decodeSave = Schema.decodeOption(AccountSaveInput);

export function AccountField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="grid gap-1.5 text-sm">
      <Label render={<span />}>{label}</Label>
      {children}
    </label>
  );
}

function SecretField({
  field,
  saved,
  snapshot,
  environmentId,
  onChange,
}: {
  field: string;
  saved?: AccountSecretSummary | undefined;
  snapshot: AccountsSnapshot;
  environmentId: EnvironmentId;
  onChange: (input: AccountSecretInput | undefined) => void;
}) {
  const [source, setSource] = useState(saved?.source.type ?? "scient");
  const [value, setValue] = useState("");
  const [saveTo, setSaveTo] = useState<ReadonlyArray<AccountWriteStore>>([{ type: "scient" }]);
  const [service, setService] = useState(
    saved?.source.type === "keychain" ? saved.source.service : "",
  );
  const [account, setAccount] = useState(
    saved?.source.type === "keychain" ? saved.source.account : "",
  );
  const [reference, setReference] = useState(
    saved?.source.type === "1password" ? saved.source.reference : "",
  );
  const [connection, setConnection] = useState(
    saved?.source.type === "custom-model" ? saved.source.connectionId : "",
  );
  const [candidates, setCandidates] = useState<KeychainCandidatesResult | null>(null);
  const load = useAccountCommand(accountsState.keychainCandidates, environmentId);
  const changed = (next: typeof source) => {
    setSource(next);
    setValue("");
    onChange(
      next === saved?.source.type
        ? undefined
        : next === "scient"
          ? undefined
          : next === "keychain"
            ? { type: next, service, account }
            : next === "1password"
              ? { type: next, reference }
              : { type: next, connectionId: connection },
    );
    if (next === "keychain")
      void load({}).then((result) => {
        if (result.ok) setCandidates(result.value);
      });
  };
  return (
    <div className="grid gap-2">
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm">
          {field}
          {saved ? <span className="ml-2 text-xs text-muted-foreground">Saved</span> : null}
        </span>
        <div className="w-40">
          <NativeSelect
            aria-label={`${field} source`}
            size="sm"
            value={source}
            onChange={(event) => changed(event.target.value as typeof source)}
          >
            <option value="scient">Scient</option>
            {snapshot.stores.keychain.available || source === "keychain" ? (
              <option value="keychain">Keychain</option>
            ) : null}
            {snapshot.stores.onePassword.state === "connected" || source === "1password" ? (
              <option value="1password">1Password</option>
            ) : null}
            {field === "token" && snapshot.customModelKeys.length > 0 ? (
              <option value="custom-model">Custom models key</option>
            ) : null}
          </NativeSelect>
        </div>
      </div>
      {source === "scient" ? (
        <>
          <Input
            aria-label={field}
            type="password"
            autoComplete="off"
            value={value}
            placeholder={saved ? "Saved" : field}
            onChange={(event) => {
              setValue(event.target.value);
              onChange(
                event.target.value
                  ? { type: "scient", value: event.target.value, saveTo }
                  : undefined,
              );
            }}
          />
          <SaveStores
            kept={saved}
            stores={snapshot.stores}
            selected={saveTo}
            onChange={(stores) => {
              setSaveTo(stores);
              if (value) onChange({ type: "scient", value, saveTo: stores });
            }}
          />
        </>
      ) : source === "keychain" ? (
        <div className="grid gap-2">
          {candidates?.listed ? (
            <NativeSelect
              aria-label="Keychain item"
              value=""
              onChange={(event) => {
                const item = candidates.candidates[Number(event.target.value)];
                if (item) {
                  setService(item.service);
                  setAccount(item.account);
                  onChange({ type: "keychain", service: item.service, account: item.account });
                }
              }}
            >
              <option value="" disabled>
                Choose an item
              </option>
              {candidates.candidates.map((item, index) => (
                <option key={`${item.service}:${item.account}`} value={index}>
                  {item.label ?? `${item.service} · ${item.account}`}
                </option>
              ))}
            </NativeSelect>
          ) : null}
          <Input
            aria-label="Keychain service"
            placeholder="Service"
            value={service}
            onChange={(event) => {
              setService(event.target.value);
              onChange({ type: "keychain", service: event.target.value, account });
            }}
          />
          <Input
            aria-label="Keychain account"
            placeholder="Account"
            value={account}
            onChange={(event) => {
              setAccount(event.target.value);
              onChange({ type: "keychain", service, account: event.target.value });
            }}
          />
          <Button
            variant="ghost"
            size="xs"
            onClick={async () => {
              const result = await load({ query: service });
              if (result.ok) setCandidates(result.value);
            }}
          >
            Find items
          </Button>
        </div>
      ) : source === "1password" ? (
        <Input
          aria-label="1Password reference"
          placeholder="op://vault/item/field"
          value={reference}
          onChange={(event) => {
            setReference(event.target.value);
            onChange({ type: "1password", reference: event.target.value });
          }}
        />
      ) : (
        <NativeSelect
          aria-label="Custom models key"
          value={connection}
          onChange={(event) => {
            setConnection(event.target.value);
            onChange({ type: "custom-model", connectionId: event.target.value });
          }}
        >
          <option value="" disabled>
            Choose a connection
          </option>
          {snapshot.customModelKeys.map((key) => (
            <option key={key.connectionId} value={key.connectionId}>
              {key.name}
            </option>
          ))}
        </NativeSelect>
      )}
    </div>
  );
}

function SitesField({
  sites,
  onChange,
}: {
  sites: ReadonlyArray<string>;
  onChange: (sites: ReadonlyArray<string>) => void;
}) {
  const [draft, setDraft] = useState(sites.join(", "));
  return (
    <AccountField label="Sites">
      <Input
        value={draft}
        onChange={(event) => {
          setDraft(event.target.value);
          onChange(
            event.target.value
              .split(",")
              .map((site) => site.trim().toLowerCase())
              .filter(Boolean),
          );
        }}
        placeholder="example.com"
      />
    </AccountField>
  );
}

function DetailsFields({
  details,
  onChange,
}: {
  details: AccountDetails;
  onChange: (details: AccountDetails) => void;
}) {
  return (
    <>
      {"sites" in details ? (
        <SitesField sites={details.sites} onChange={(sites) => onChange({ ...details, sites })} />
      ) : null}
      {details.kind === "website" || details.kind === "library" ? (
        <>
          <AccountField label="Username">
            <Input
              value={details.username ?? ""}
              autoComplete="off"
              onChange={(event) => onChange({ ...details, username: event.target.value })}
            />
          </AccountField>
          <AccountField label="Sign-in address">
            <Input
              value={details.loginUrl ?? ""}
              onChange={(event) => {
                const { loginUrl: _, ...rest } = details;
                onChange(event.target.value ? { ...details, loginUrl: event.target.value } : rest);
              }}
              placeholder="https://…"
            />
          </AccountField>
          {details.kind === "library" ? (
            <AccountField label="Library proxy">
              <Input
                value={details.proxyUrl}
                onChange={(event) => onChange({ ...details, proxyUrl: event.target.value })}
                placeholder="https://…/{url}"
              />
            </AccountField>
          ) : null}
        </>
      ) : null}
      {details.kind === "api-key" ? (
        <>
          <AccountField label="Environment variable">
            <Input
              value={details.envName ?? ""}
              onChange={(event) => {
                const { envName: _, ...rest } = details;
                onChange(event.target.value ? { ...details, envName: event.target.value } : rest);
              }}
            />
          </AccountField>
          <AccountField label="Authentication">
            <NativeSelect
              value={details.auth.type}
              onChange={(event) => {
                const type = event.target.value as typeof details.auth.type;
                onChange({
                  ...details,
                  auth:
                    type === "bearer"
                      ? { type }
                      : type === "basic"
                        ? { type, username: "" }
                        : { type, name: "" },
                });
              }}
            >
              <option value="bearer">Bearer</option>
              <option value="header">Header</option>
              <option value="basic">Basic</option>
              <option value="query">Query</option>
            </NativeSelect>
          </AccountField>
          {details.auth.type !== "bearer" ? (
            <AccountField label={details.auth.type === "basic" ? "Username" : "Parameter name"}>
              <Input
                value={"name" in details.auth ? details.auth.name : details.auth.username}
                onChange={(event) =>
                  onChange({
                    ...details,
                    auth:
                      details.auth.type === "basic"
                        ? { ...details.auth, username: event.target.value }
                        : {
                            type: details.auth.type === "query" ? "query" : "header",
                            name: event.target.value,
                          },
                  })
                }
              />
            </AccountField>
          ) : null}
        </>
      ) : null}
      {details.kind === "database" ? (
        <>
          {(["host", "database", "user"] as const).map((field) => (
            <AccountField key={field} label={field}>
              <Input
                value={details[field]}
                onChange={(event) => onChange({ ...details, [field]: event.target.value })}
              />
            </AccountField>
          ))}
          <AccountField label="Port">
            <Input
              type="number"
              value={details.port}
              onChange={(event) => onChange({ ...details, port: Number(event.target.value) })}
            />
          </AccountField>
          <AccountField label="SSL">
            <NativeSelect
              value={details.sslmode ?? "prefer"}
              onChange={(event) =>
                onChange({ ...details, sslmode: event.target.value as typeof details.sslmode })
              }
            >
              {["disable", "prefer", "require", "verify-ca", "verify-full"].map((mode) => (
                <option key={mode}>{mode}</option>
              ))}
            </NativeSelect>
          </AccountField>
        </>
      ) : null}
    </>
  );
}

export function AccountDialog({
  environmentId,
  snapshot,
  account,
  canWrite,
  onClose,
}: {
  environmentId: EnvironmentId;
  snapshot: AccountsSnapshot;
  account: AccountSummary | null;
  canWrite: boolean;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [details, setDetails] = useState<AccountDetails | null>(account?.details ?? null);
  const [name, setName] = useState(account?.name ?? "");
  const [secrets, setSecrets] = useState<Record<string, AccountSecretInput>>({});
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const save = useAccountCommand(accountsState.save, environmentId);
  const choose = (entry: CatalogueEntry | null) => {
    setDetails(
      catalogueDetails(
        entry,
        entry
          ? ""
          : query
              .trim()
              .replace(/^https?:\/\//, "")
              .split("/")[0],
      ),
    );
    setName(entry?.name ?? query.trim());
  };
  const submit = async () => {
    if (!canWrite || !details || busy) return;
    const input = decodeSave({
      ...(account ? { accountId: account.accountId } : {}),
      name,
      details,
      secrets,
    });
    if (Option.isNone(input)) {
      setError(true);
      return;
    }
    setBusy(true);
    setError(false);
    const result = await save(input.value);
    setBusy(false);
    if (result.ok) {
      setSecrets({});
      onClose();
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>{account ? "Edit account" : "Add an account"}</DialogTitle>
        </DialogHeader>
        <DialogPanel>
          <div className="grid gap-4">
            {details === null ? (
              <>
                <Input
                  autoFocus
                  type="search"
                  aria-label="Find an account"
                  placeholder="Search or enter a website address"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                />
                <div className="grid gap-1">
                  {accountCatalogue
                    .filter((entry) => entry.name.toLowerCase().includes(query.toLowerCase()))
                    .map((entry) => (
                      <Button key={entry.name} variant="ghost" onClick={() => choose(entry)}>
                        {entry.name}
                      </Button>
                    ))}
                  <Button variant="ghost" onClick={() => choose(null)}>
                    Any website address
                  </Button>
                </div>
              </>
            ) : (
              <>
                <AccountField label="Name">
                  <Input
                    autoFocus
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    maxLength={80}
                  />
                </AccountField>
                <DetailsFields details={details} onChange={setDetails} />
                {secretFields(details).map((field) => (
                  <SecretField
                    key={field}
                    field={field}
                    saved={account?.secrets[field]}
                    environmentId={environmentId}
                    snapshot={snapshot}
                    onChange={(input) =>
                      setSecrets((current) => {
                        const next = { ...current };
                        if (input) next[field] = input;
                        else delete next[field];
                        return next;
                      })
                    }
                  />
                ))}
              </>
            )}
            {error ? (
              <p role="alert" className="text-sm text-destructive-foreground">
                Check the account fields.
              </p>
            ) : null}
          </div>
        </DialogPanel>
        {details ? (
          <DialogFooter>
            <Button disabled={!canWrite || busy} onClick={() => void submit()}>
              Save
            </Button>
          </DialogFooter>
        ) : null}
      </DialogPopup>
    </Dialog>
  );
}
