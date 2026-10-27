import { useState } from "react";
import { useClientSettings } from "~/hooks/useSettings";
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
  resolveBrowserProfiles,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { ChevronDownIcon } from "lucide-react";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "~/components/ui/menu";
import { NativeSelect } from "~/components/ui/select";
import { DiscoveryList, DiscoveryListRow } from "~/components/ui/discovery-list";
import { ExtensionIcon } from "../extensions/ExtensionRow";
import { AccountLogo } from "./AccountLogo";
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
  accountIconUrl,
  catalogueDetails,
  KIND_LABELS,
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

const FIELD_LABELS: Readonly<Record<string, string>> = {
  password: "Password",
  totp: "2FA key",
  token: "Key",
  clientCert: "Client certificate",
  clientKey: "Client key",
  caCert: "CA certificate",
};
const OPTIONAL_FIELDS = new Set(["totp", "clientCert", "clientKey", "caCert"]);

type ValueSource = AccountSecretSummary["source"]["type"];
const LINK_LABELS: Readonly<Record<Exclude<ValueSource, "scient">, string>> = {
  keychain: "Keychain item",
  "1password": "1Password item",
  "custom-model": "Custom models key",
};

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
  const [source, setSource] = useState<ValueSource>(saved?.source.type ?? "scient");
  const [value, setValue] = useState("");
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
  const label = FIELD_LABELS[field] ?? field;
  const links: ReadonlyArray<Exclude<ValueSource, "scient">> = [
    ...(snapshot.stores.keychain.available ? (["keychain"] as const) : []),
    ...(snapshot.stores.onePassword.state === "connected" ? (["1password"] as const) : []),
    ...(field === "token" && snapshot.customModelKeys.length > 0
      ? (["custom-model"] as const)
      : []),
  ];
  const changed = (next: ValueSource) => {
    setSource(next);
    setValue("");
    onChange(
      next === saved?.source.type || next === "scient"
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
    <div className="grid gap-1.5 text-sm">
      <div className="flex items-center justify-between gap-3">
        <Label render={<span />}>
          {label}
          {source !== "scient" ? (
            <span className="font-normal text-muted-foreground"> · {LINK_LABELS[source]}</span>
          ) : null}
        </Label>
        {links.length > 0 ? (
          <Menu>
            <MenuTrigger render={<Button size="xs" variant="ghost-muted" />}>
              {source === "scient" ? "Use existing" : "Change"}
              <ChevronDownIcon aria-hidden className="-me-1 size-3 shrink-0 opacity-50" />
            </MenuTrigger>
            <MenuPopup align="end">
              {source !== "scient" ? (
                <MenuItem onClick={() => changed("scient")}>Enter a value</MenuItem>
              ) : null}
              {links
                .filter((link) => link !== source)
                .map((link) => (
                  <MenuItem key={link} onClick={() => changed(link)}>
                    {LINK_LABELS[link]}
                  </MenuItem>
                ))}
            </MenuPopup>
          </Menu>
        ) : null}
      </div>
      {source === "scient" ? (
        <Input
          aria-label={label}
          type="password"
          autoComplete="off"
          value={value}
          placeholder={saved ? "Saved" : OPTIONAL_FIELDS.has(field) ? "Optional" : undefined}
          onChange={(event) => {
            setValue(event.target.value);
            onChange(
              event.target.value ? { type: "scient", value: event.target.value } : undefined,
            );
          }}
        />
      ) : source === "keychain" ? (
        candidates?.listed ? (
          <div className="grid gap-2">
            <Input
              type="search"
              aria-label="Search keychain"
              placeholder="Search keychain"
              onChange={(event) => {
                const query = event.target.value.trim();
                void load(query ? { query } : {}).then((result) => {
                  if (result.ok) setCandidates(result.value);
                });
              }}
            />
            <NativeSelect
              aria-label="Keychain item"
              value={String(
                candidates.candidates.findIndex(
                  (item) => item.service === service && item.account === account,
                ),
              )}
              onChange={(event) => {
                const item = candidates.candidates[Number(event.target.value)];
                if (item) {
                  setService(item.service);
                  setAccount(item.account);
                  onChange({ type: "keychain", service: item.service, account: item.account });
                }
              }}
            >
              <option value="-1" disabled>
                Choose an item
              </option>
              {candidates.candidates.map((item, index) => (
                <option key={`${item.service}:${item.account}`} value={index}>
                  {item.label ?? `${item.service} · ${item.account}`}
                </option>
              ))}
            </NativeSelect>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-2">
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
          </div>
        )
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
  const profiles = resolveBrowserProfiles(
    useClientSettings((settings) => settings.browserProfiles),
  );
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
              placeholder="Optional"
            />
          </AccountField>
          <AccountField label="Browser profile">
            <NativeSelect
              value={details.profileId ?? ""}
              onChange={(event) => {
                const { profileId: _, ...rest } = details;
                onChange(event.target.value ? { ...details, profileId: event.target.value } : rest);
              }}
            >
              <option value="">Default</option>
              {profiles
                .filter((profile) => profile.kind !== "incognito" && profile.id !== "default")
                .map((profile) => (
                  <option key={profile.id} value={profile.id}>
                    {profile.name}
                  </option>
                ))}
            </NativeSelect>
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
          {(
            [
              ["host", "Host"],
              ["database", "Database"],
              ["user", "User"],
            ] as const
          ).map(([field, label]) => (
            <AccountField key={field} label={label}>
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
  const [saveTo, setSaveTo] = useState<ReadonlyArray<AccountWriteStore>>([{ type: "scient" }]);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const save = useAccountCommand(accountsState.save, environmentId);
  const typedSite = query
    .trim()
    .replace(/^https?:\/\//, "")
    .split("/")[0]!
    .toLowerCase();
  const choose = (entry: CatalogueEntry | null, kind: "website" | "api-key" = "website") => {
    const details = catalogueDetails(entry, entry ? "" : typedSite);
    setDetails(
      !entry && kind === "api-key"
        ? { kind: "api-key", sites: typedSite ? [typedSite] : [], auth: { type: "bearer" } }
        : details,
    );
    setName(entry?.name ?? query.trim());
  };
  const submit = async () => {
    if (!canWrite || !details || busy) return;
    const input = decodeSave({
      ...(account ? { accountId: account.accountId } : {}),
      name,
      details,
      secrets: Object.fromEntries(
        Object.entries(secrets).map(([field, input]) => [
          field,
          input.type === "scient" ? { ...input, saveTo } : input,
        ]),
      ),
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
                <DiscoveryList>
                  {accountCatalogue
                    .filter((entry) => entry.name.toLowerCase().includes(query.toLowerCase()))
                    .map((entry) => (
                      <DiscoveryListRow
                        key={entry.name}
                        icon={<CatalogueIcon name={entry.name} site={entry.site} />}
                        title={entry.name}
                        description={KIND_LABELS[entry.kind]}
                        onClick={() => choose(entry)}
                      />
                    ))}
                  <DiscoveryListRow
                    icon={<ExtensionIcon name={query.trim() || "Website"} />}
                    title={query.trim() || "Any website"}
                    description={KIND_LABELS.website}
                    onClick={() => choose(null)}
                  />
                  <DiscoveryListRow
                    icon={<ExtensionIcon name={query.trim() || "API key"} />}
                    title={query.trim() || "Any API key"}
                    description={KIND_LABELS["api-key"]}
                    onClick={() => choose(null, "api-key")}
                  />
                </DiscoveryList>
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
                {Object.values(secrets).some((input) => input.type === "scient") ? (
                  <SaveStores
                    kept={account ? Object.values(account.secrets)[0] : undefined}
                    stores={snapshot.stores}
                    selected={saveTo}
                    onChange={setSaveTo}
                  />
                ) : null}
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

function CatalogueIcon({
  name,
  site,
}: {
  readonly name: string;
  readonly site?: string | undefined;
}) {
  const iconUrl = accountIconUrl(site ? [site] : [], name);
  return iconUrl ? (
    <AccountLogo src={iconUrl} className="size-10 rounded-[25%]" />
  ) : (
    <ExtensionIcon name={name} />
  );
}
