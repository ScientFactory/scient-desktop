import {
  AccountSaveInput,
  resolveBrowserProfiles,
  type AccountDetails,
  type AccountId,
  type AccountSecretInput,
  type AccountSecretSummary,
  type AccountsSnapshot,
  type AccountSummary,
  type AccountWriteStore,
  type EnvironmentId,
  type KeychainCandidatesResult,
} from "@t3tools/contracts";
import { resolveAddressBarInput, resolveSearchUrlTemplate } from "@t3tools/shared/preview";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  ArrowUpRightIcon,
  ChevronDownIcon,
  GlobeIcon,
  KeyRoundIcon,
  SearchIcon,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";

import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { DiscoveryList, DiscoveryListRow } from "~/components/ui/discovery-list";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "~/components/ui/menu";
import { NativeSelect } from "~/components/ui/select";
import { useClientSettings } from "~/hooks/useSettings";
import { useStableCallback } from "~/hooks/useStableCallback";
import { readLocalApi } from "~/localApi";
import { ExtensionIcon } from "../extensions/ExtensionRow";
import { AccountLogo } from "./AccountLogo";
import { accountsState } from "./accountsState";
import {
  CLI_LOGIN_COMMANDS,
  KIND_LABELS,
  accountCatalogue,
  accountCatalogueGroups,
  accountIconUrl,
  accountManagePage,
  catalogueDetails,
  recognizeAccountKey,
  secretFields,
  type CatalogueEntry,
} from "./accountsView";
import { CliPasswordPicker } from "./CliPasswordStores";
import { SaveStores } from "./SaveStores";
import { useAccountBrowser } from "./useAccountBrowser";
import { useAccountCommand } from "./useAccounts";

const decodeSave = Schema.decodeOption(AccountSaveInput);

export function AccountField({
  label,
  action,
  children,
}: {
  label: string;
  /** A small trailing control on the label line, outside the label element. */
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return action ? (
    <div className="grid gap-1.5 text-sm">
      <div className="flex items-center justify-between gap-3">
        <Label render={<span aria-hidden />}>{label}</Label>
        {action}
      </div>
      <label className="grid">
        <span className="sr-only">{label}</span>
        {children}
      </label>
    </div>
  ) : (
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
  bitwarden: "Bitwarden item",
  "proton-pass": "Proton Pass item",
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
  inputRef,
  onKeyPaste,
}: {
  inputRef?: (node: HTMLInputElement | null) => void;
  onKeyPaste?: ((value: string) => boolean) | undefined;
  field: string;
  saved?: AccountSecretSummary | undefined;
  snapshot: AccountsSnapshot;
  environmentId: EnvironmentId;
  onChange: (input: AccountSecretInput | undefined) => void;
}) {
  const [source, setSource] = useState<ValueSource>(saved?.source.type ?? "scient");
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
    ...(snapshot.stores.cli ? (["bitwarden", "proton-pass"] as const) : []),
    ...(snapshot.stores.keychain.available ? (["keychain"] as const) : []),
    ...(snapshot.stores.onePassword.state === "connected" ? (["1password"] as const) : []),
    ...(field === "token" && snapshot.customModelKeys.length > 0
      ? (["custom-model"] as const)
      : []),
  ];
  const changed = (next: ValueSource) => {
    setSource(next);
    onChange(
      next === saved?.source.type ||
        next === "scient" ||
        next === "bitwarden" ||
        next === "proton-pass"
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
          ref={inputRef}
          onPaste={(event) => {
            if (onKeyPaste?.(event.clipboardData.getData("text"))) event.preventDefault();
          }}
          aria-label={label}
          type="password"
          autoComplete="off"
          placeholder={saved ? "Saved" : OPTIONAL_FIELDS.has(field) ? "Optional" : undefined}
          onChange={() => {
            onChange(undefined);
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
      ) : source === "bitwarden" || source === "proton-pass" ? (
        <CliPasswordPicker
          key={source}
          store={source}
          environmentId={environmentId}
          onChange={onChange}
        />
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
    <AccountField label="Site">
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
        <AccountField label="Username">
          <Input
            value={details.username ?? ""}
            autoComplete="off"
            onChange={(event) => onChange({ ...details, username: event.target.value })}
          />
        </AccountField>
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

function MoreOptionsFields({
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
      {details.kind === "website" || details.kind === "library" ? (
        <details className="grid gap-3">
          <summary className="cursor-pointer text-sm text-muted-foreground">More options</summary>
          <div className="grid gap-4 pt-3">
            <AccountField label="Sign-in address">
              <Input
                value={details.loginUrl ?? ""}
                onChange={(event) => {
                  const { loginUrl: _, ...rest } = details;
                  onChange(
                    event.target.value ? { ...details, loginUrl: event.target.value } : rest,
                  );
                }}
                placeholder="Optional"
              />
            </AccountField>
            <AccountField label="Browser profile">
              <NativeSelect
                value={details.profileId ?? ""}
                onChange={(event) => {
                  const { profileId: _, ...rest } = details;
                  onChange(
                    event.target.value ? { ...details, profileId: event.target.value } : rest,
                  );
                }}
              >
                <option value="">New tabs profile</option>
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
          </div>
        </details>
      ) : null}
      {details.kind === "api-key" ? (
        <details>
          <summary className="cursor-pointer text-sm text-muted-foreground">More options</summary>
          <div className="grid gap-4 pt-3">
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
          </div>
        </details>
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
  initialApiKey,
  onSaved,
}: {
  environmentId: EnvironmentId;
  snapshot: AccountsSnapshot;
  account: AccountSummary | null;
  canWrite: boolean;
  onClose: () => void;
  initialApiKey?: {
    readonly name: string;
    readonly envName: string;
    readonly sites?: ReadonlyArray<string>;
  };
  onSaved?: (accountId: AccountId) => void;
}) {
  const openBrowser = useAccountBrowser(environmentId);
  const configuredProfiles = useClientSettings((settings) => settings.browserProfiles);
  const searchUrlTemplate = useClientSettings(resolveSearchUrlTemplate);
  const profiles = resolveBrowserProfiles(configuredProfiles);
  const [signedSites, setSignedSites] = useState<
    ReadonlyArray<{ domain: string; profileId: string; profileName: string }>
  >([]);
  const [keychain, setKeychain] = useState<KeychainCandidatesResult | null>(null);
  const loadKeychain = useAccountCommand(accountsState.keychainCandidates, environmentId);
  const loadKeychainStable = useStableCallback(loadKeychain);
  const secretInputs = useRef(new Map<string, HTMLInputElement>());
  const profileKey = JSON.stringify(
    profiles.filter((profile) => profile.kind !== "incognito").map(({ id, name }) => [id, name]),
  );
  // Keyed on profile ids and names, so a rebuilt profile list doesn't refetch in a loop.
  // oxlint-disable-next-line t3code/react-effect-budget -- Read only domain metadata from native browser profiles when the picker opens.
  useEffect(() => {
    let active = true;
    void Promise.all(
      (JSON.parse(profileKey) as Array<[string, string]>)
        .map(([id, name]) => ({ id, name }))
        .map(async (profile) => {
          const sites = await window.desktopBridge?.accounts
            ?.signedInSites(profile.id, environmentId)
            .catch(() => []);
          return (sites ?? []).map(({ domain }) => ({
            domain,
            profileId: profile.id,
            profileName: profile.name,
          }));
        }),
    ).then((sites) => {
      if (active) setSignedSites(sites.flat());
    });
    return () => {
      active = false;
    };
  }, [environmentId, profileKey]);
  const focusEmptyField = useStableCallback((node: HTMLDivElement | null) => {
    const inputs = node?.querySelectorAll<HTMLInputElement>("input");
    const first = [...(inputs ?? [])].find(
      (input) => !input.value && !input.closest("details:not([open])"),
    );
    first?.focus();
  });
  const [query, setQuery] = useState("");
  const [details, setDetails] = useState<AccountDetails | null>(
    account?.details ??
      (initialApiKey
        ? {
            kind: "api-key",
            sites: initialApiKey.sites ?? [],
            auth: { type: "bearer" },
            envName: initialApiKey.envName,
          }
        : null),
  );
  const [name, setName] = useState(account?.name ?? initialApiKey?.name ?? "");
  const [secrets, setSecrets] = useState<Record<string, AccountSecretInput>>({});
  const [saveTo, setSaveTo] = useState<ReadonlyArray<AccountWriteStore>>([{ type: "scient" }]);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const save = useAccountCommand(accountsState.save, environmentId);
  // oxlint-disable-next-line t3code/react-effect-budget -- Debounce local keychain metadata discovery and discard stale responses.
  useEffect(() => {
    if (details || !query.trim() || !snapshot.stores.keychain.available) return;
    let active = true;
    const timer = setTimeout(() => {
      void loadKeychainStable({ query: query.trim().slice(0, 128) }).then((result) => {
        if (active && result.ok) setKeychain(result.value);
      });
    }, 250);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [details, query, snapshot.stores.keychain.available, loadKeychainStable]);
  const recognizePaste = (value: string) => {
    const entry = recognizeAccountKey(value);
    if (!entry) return false;
    const nextDetails = catalogueDetails(entry);
    flushSync(() => {
      setSecrets({});
      setQuery("");
      setName(entry.name);
      setDetails(nextDetails);
    });
    const field = secretFields(nextDetails)[0];
    const input = field ? secretInputs.current.get(field) : undefined;
    if (input) input.value = value.trim();
    return true;
  };
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
    const fieldSecrets = { ...secrets };
    for (const [field, input] of secretInputs.current) {
      if (input.value) fieldSecrets[field] = { type: "scient", value: input.value };
    }
    const input = decodeSave({
      ...(account ? { accountId: account.accountId } : {}),
      name,
      details,
      secrets: Object.fromEntries(
        Object.entries(fieldSecrets).map(([field, input]) => [
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
      onSaved?.(result.value.accountId);
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
      <DialogPopup data-accounts-dialog>
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
                  onPaste={(event) => {
                    if (recognizePaste(event.clipboardData.getData("text"))) event.preventDefault();
                  }}
                  onChange={(event) => {
                    setKeychain(null);
                    setQuery(event.target.value);
                  }}
                />
                <DiscoveryList>
                  {accountCatalogueGroups.map((group) => {
                    const entries = accountCatalogue.filter(
                      (entry) =>
                        group.entries.some((name) => name === entry.name) &&
                        `${entry.name} ${entry.site}`
                          .toLowerCase()
                          .includes(query.trim().toLowerCase()),
                    );
                    return entries.length ? (
                      <div key={group.name}>
                        <div className="px-3 pb-1 pt-3 text-xs text-muted-foreground">
                          {group.name}
                        </div>
                        {entries.map((entry) => (
                          <DiscoveryListRow
                            key={entry.name}
                            icon={
                              <CatalogueIcon
                                name={entry.name}
                                site={entry.site}
                                environmentId={environmentId}
                              />
                            }
                            title={entry.name}
                            description={KIND_LABELS[entry.kind]}
                            onClick={() => choose(entry)}
                          />
                        ))}
                      </div>
                    ) : null;
                  })}
                  {query.trim() &&
                  !accountCatalogue.some(
                    (entry) =>
                      entry.name.toLowerCase() === query.trim().toLowerCase() ||
                      entry.site === typedSite,
                  ) ? (
                    <>
                      {signedSites
                        .filter((site) => site.domain.includes(typedSite))
                        .map((site) => (
                          <DiscoveryListRow
                            key={`${site.profileId}:${site.domain}`}
                            icon={
                              <CatalogueIcon
                                name={site.domain}
                                site={site.domain}
                                environmentId={environmentId}
                                fallback={GlobeIcon}
                              />
                            }
                            title={site.domain}
                            description={`Signed in on ${site.profileName}`}
                            onClick={() => {
                              setName(site.domain);
                              setDetails({
                                kind: "website",
                                sites: [site.domain],
                                profileId: site.profileId,
                              });
                            }}
                          />
                        ))}
                      {(keychain?.candidates ?? []).map((item) => {
                        const site = item.service.replace(/^https?:\/\//, "").split("/")[0]!;
                        if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(site)) return null;
                        return (
                          <DiscoveryListRow
                            key={`${item.service}:${item.account}`}
                            icon={
                              <CatalogueIcon
                                name={site}
                                site={site}
                                environmentId={environmentId}
                                fallback={GlobeIcon}
                              />
                            }
                            title={item.label ?? site}
                            description="In your Keychain"
                            onClick={() => {
                              setName(site);
                              setDetails({
                                kind: "website",
                                sites: [site],
                                username: item.account,
                              });
                              setSecrets({
                                password: {
                                  type: "keychain",
                                  service: item.service,
                                  account: item.account,
                                },
                              });
                            }}
                          />
                        );
                      })}
                    </>
                  ) : null}
                  <DiscoveryListRow
                    icon={
                      <ExtensionIcon
                        name="Website"
                        glyph={GlobeIcon}
                        environmentId={environmentId}
                      />
                    }
                    title={query.trim() || "Any website"}
                    description={KIND_LABELS.website}
                    onClick={() => choose(null)}
                  />
                  <DiscoveryListRow
                    icon={
                      <ExtensionIcon
                        name="API key"
                        glyph={KeyRoundIcon}
                        environmentId={environmentId}
                      />
                    }
                    title={query.trim() || "Any API key"}
                    description={KIND_LABELS["api-key"]}
                    onClick={() => choose(null, "api-key")}
                  />
                  {query.trim() ? (
                    <DiscoveryListRow
                      icon={
                        <ExtensionIcon
                          name="Search"
                          glyph={SearchIcon}
                          environmentId={environmentId}
                        />
                      }
                      description="Open in Scient browser"
                      title={`Search the web for '${query.trim()}'`}
                      onClick={() => {
                        // Searched like the browser's address bar, with its search engine.
                        let url: string;
                        try {
                          url = resolveAddressBarInput(query, searchUrlTemplate);
                        } catch {
                          return;
                        }
                        void openBrowser(url).then((opened) => {
                          if (opened) onClose();
                        });
                      }}
                    />
                  ) : null}
                </DiscoveryList>
              </>
            ) : (
              <div className="grid gap-4" ref={focusEmptyField}>
                {!account && details.kind === "cli-login" && CLI_LOGIN_COMMANDS[details.tool] ? (
                  <div className="flex items-center justify-between gap-3 text-sm">
                    <code className="text-xs text-muted-foreground">
                      {CLI_LOGIN_COMMANDS[details.tool]}
                    </code>
                    <Button
                      variant="ghost-muted"
                      size="xs"
                      onClick={() => {
                        void navigator.clipboard.writeText(CLI_LOGIN_COMMANDS[details.tool]!);
                      }}
                    >
                      Copy
                    </Button>
                  </div>
                ) : null}
                <AccountField
                  label="Name"
                  action={
                    !account && details.kind === "website" ? (
                      <Button
                        size="xs"
                        variant="ghost-muted"
                        disabled={
                          !canWrite ||
                          !details.sites[0] ||
                          details.profileId === "incognito" ||
                          busy
                        }
                        onClick={() => {
                          setBusy(true);
                          void openBrowser(
                            details.loginUrl || details.sites[0]!,
                            details.profileId,
                            { name, site: details.sites[0]! },
                          ).then((opened) => {
                            setBusy(false);
                            if (opened) {
                              onClose();
                            }
                          });
                        }}
                      >
                        Sign in with the browser
                        <ArrowUpRightIcon aria-hidden className="-me-1 size-3 opacity-60" />
                      </Button>
                    ) : !account &&
                      details.kind === "api-key" &&
                      accountManagePage(details.sites) ? (
                      <Button
                        size="xs"
                        variant="ghost-muted"
                        onClick={() => {
                          void readLocalApi()?.shell.openExternal(
                            accountManagePage(details.sites)!.url,
                          );
                        }}
                      >
                        Get a key
                        <ArrowUpRightIcon aria-hidden className="-me-1 size-3 opacity-60" />
                      </Button>
                    ) : null
                  }
                >
                  <Input
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    maxLength={80}
                  />
                </AccountField>
                <DetailsFields details={details} onChange={setDetails} />
                {secretFields(details).map((field) => (
                  <SecretField
                    key={`${details.kind}:${details.kind === "cli-login" ? details.tool : ""}:${field}`}
                    field={field}
                    saved={
                      account?.secrets[field] ??
                      (secrets[field]?.type === "keychain" ? { source: secrets[field] } : undefined)
                    }
                    inputRef={(node) => {
                      if (!node) {
                        secretInputs.current.delete(field);
                        return;
                      }
                      secretInputs.current.set(field, node);
                    }}
                    onKeyPaste={
                      details.kind === "api-key" || details.kind === "cli-login"
                        ? recognizePaste
                        : undefined
                    }
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
                <MoreOptionsFields details={details} onChange={setDetails} />
                {secretFields(details).length > 0 ? (
                  <SaveStores
                    kept={account ? Object.values(account.secrets)[0] : undefined}
                    stores={snapshot.stores}
                    selected={saveTo}
                    onChange={setSaveTo}
                  />
                ) : null}
              </div>
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
            {!account && !initialApiKey ? (
              <div className="mr-auto">
                <Button
                  variant="ghost"
                  disabled={busy}
                  onClick={() => {
                    setDetails(null);
                    setSecrets({});
                    setError(false);
                  }}
                >
                  Back
                </Button>
              </div>
            ) : null}
            <Button variant="outline" disabled={busy} onClick={onClose}>
              Cancel
            </Button>
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
  environmentId,
  fallback,
}: {
  readonly name: string;
  readonly site?: string | undefined;
  readonly environmentId: EnvironmentId;
  /** Arbitrary sites have no brand entry; a plain glyph beats the extension placeholder. */
  readonly fallback?: LucideIcon;
}) {
  const iconUrl = accountIconUrl(site ? [site] : [], name);
  return iconUrl ? (
    <AccountLogo src={iconUrl} className="size-10 rounded-[25%]" />
  ) : (
    <ExtensionIcon name={name} glyph={fallback} environmentId={environmentId} />
  );
}
