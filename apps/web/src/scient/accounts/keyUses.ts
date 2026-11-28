import {
  ProviderInstanceId,
  type AccountSummary,
  type AccountsSnapshot,
  type ConnectorSummary,
  type EnvironmentId,
  type LibraryKeyUse,
  referencedAccountId,
} from "@t3tools/contracts";
import { msg } from "gt-react";
import type { KeyUse } from "./accountsView";
import { m, type MessageResolver } from "~/i18n/messages";

/**
 * Every holder of an Accounts key, the one list both the API keys list and the key editor show:
 * Custom models, Voice, agent variables, text generators, connectors and the Library.
 */
export interface KeyUseSources {
  readonly keyConsumers?: AccountsSnapshot["keyConsumers"] | undefined;
  readonly accounts?: ReadonlyArray<AccountSummary> | undefined;
  readonly keyLinks?: AccountsSnapshot["keyLinks"] | undefined;
  readonly instances?:
    | Readonly<
        Record<
          string,
          {
            readonly displayName?: string | undefined;
            readonly driver: string;
            readonly environment?:
              | ReadonlyArray<{ readonly name: string; readonly sensitive: boolean }>
              | undefined;
          }
        >
      >
    | undefined;
  readonly driverName?: ((driver: string) => string) | undefined;
  readonly textGenerators?:
    | Readonly<Record<string, { readonly label?: string | undefined; readonly apiKey: unknown }>>
    | undefined;
  readonly connectors?:
    | ReadonlyArray<Pick<ConnectorSummary, "connectorId" | "displayName" | "auth">>
    | undefined;
  readonly libraryKeys?: Readonly<Record<string, string>> | undefined;
  /** Uses whose provider refused the key; they say so. */
  readonly keyRefusals?: AccountsSnapshot["keyRefusals"] | undefined;
}

const LIBRARY_LABELS = {
  zotero: msg("Zotero"),
  openAlex: msg("OpenAlex"),
  semanticScholar: msg("Semantic Scholar"),
  ncbi: msg("NCBI / PubMed"),
  googleBooks: msg("Google Books"),
  unpaywallEmail: msg("Unpaywall"),
} satisfies Record<LibraryKeyUse, unknown>;

export function referencedKeyUses(
  sources: KeyUseSources,
  resolve: MessageResolver = m,
): ReadonlyMap<string, ReadonlyArray<KeyUse>> {
  const uses = new Map<string, KeyUse[]>();
  const refused = (accountId: string, kind: string, id: string) =>
    (sources.keyRefusals ?? []).some(
      (entry) => entry.accountId === accountId && entry.use.kind === kind && entry.use.id === id,
    );
  const used = (accountId: string, use: KeyUse, kind: string) =>
    uses.set(accountId, [
      ...(uses.get(accountId) ?? []),
      use.consumerId && refused(accountId, kind, use.consumerId) ? { ...use, refused: true } : use,
    ]);
  for (const consumer of sources.keyConsumers ?? [])
    used(
      consumer.accountId,
      {
        label:
          consumer.kind === "custom-model" ? resolve(msg("Custom models")) : resolve(msg("Voice")),
        href: consumer.kind === "custom-model" ? "/settings/custom-models" : "/settings/voice",
        consumerName: consumer.name,
        consumerId: consumer.id,
      },
      consumer.kind === "custom-model" ? "custom-model" : "voice",
    );
  for (const link of sources.keyLinks ?? []) {
    const instance = sources.instances?.[link.instanceId];
    if (!instance?.environment?.some((item) => item.name === link.variable && item.sensitive))
      continue;
    used(
      link.accountId,
      {
        label: instance.displayName ?? sources.driverName?.(instance.driver) ?? instance.driver,
        href: "/settings/providers",
        consumerName: link.variable,
        link: { instanceId: link.instanceId, variable: link.variable },
      },
      "variable",
    );
  }
  // A typed key kept for its generator is that generator's, whatever its settings hold.
  const keptFor = new Map(
    (sources.accounts ?? []).flatMap((account) =>
      account.details.kind === "api-key" && account.details.privateTo?.kind === "text-generator"
        ? [[account.details.privateTo.id, account.accountId] as const]
        : [],
    ),
  );
  for (const [id, generator] of Object.entries(sources.textGenerators ?? {})) {
    const accountId = referencedAccountId(generator.apiKey) ?? keptFor.get(id);
    if (accountId)
      used(
        accountId,
        {
          label: resolve(msg("Text generation")),
          href: "/settings/providers",
          consumerName: generator.label ?? id,
          consumerId: id,
        },
        "text-generator",
      );
  }
  for (const connector of sources.connectors ?? [])
    if (connector.auth.type === "credential" && connector.auth.accountId)
      used(
        connector.auth.accountId,
        {
          label: resolve(msg("Extensions")),
          href: "/settings/extensions/installed",
          consumerName: connector.displayName,
          consumerId: connector.connectorId,
          connectorId: connector.connectorId,
        },
        "connector",
      );
  for (const [use, accountId] of Object.entries(sources.libraryKeys ?? {}))
    if (use in LIBRARY_LABELS)
      used(
        accountId,
        {
          label: resolve(msg("Library")),
          href: "/settings/documents",
          consumerName: resolve(LIBRARY_LABELS[use as LibraryKeyUse]),
          consumerId: use,
        },
        "library",
      );
  return uses;
}

/** The elements that one Custom models connection, Voice engine and Library key are scrolled to by. */
export const customModelTarget = (id: string) => `custom-model-${id}`;
export const voiceEngineTarget = (id: string) => `voice-engine-${id}`;
export const libraryKeyTarget = (use: LibraryKeyUse) => `library-key-${use}`;

/**
 * The link to the exact place that uses the key, on the computer that holds it: its connector,
 * agent, connection, engine or Library key.
 */
export function keyUseLink(use: KeyUse, machine: EnvironmentId) {
  if (use.connectorId)
    return {
      to: "/settings/extensions/item/connector/$connectorId",
      params: { connectorId: use.connectorId },
      search: { machine },
    } as const;
  const instanceId =
    use.link?.instanceId ?? (use.href === "/settings/providers" ? use.consumerId : undefined);
  if (instanceId)
    return {
      to: "/settings/providers",
      search: { machine, instanceId: ProviderInstanceId.make(instanceId) },
    } as const;
  const hash = !use.consumerId
    ? undefined
    : use.href === "/settings/custom-models"
      ? customModelTarget(use.consumerId)
      : use.href === "/settings/voice"
        ? voiceEngineTarget(use.consumerId)
        : use.href === "/settings/documents"
          ? libraryKeyTarget(use.consumerId as LibraryKeyUse)
          : undefined;
  return { to: use.href, search: { machine }, ...(hash ? { hash } : {}) } as const;
}

/** One use as a short line, e.g. "Voice · Meeting notes · refused". */
export const keyUseLabel = (use: KeyUse, resolve: MessageResolver = m) =>
  [
    use.label,
    use.consumerName,
    use.refused ? resolve(msg("refused", { $context: "a service refused this key" })) : undefined,
  ]
    .filter(Boolean)
    .join(" · ");
