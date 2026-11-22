import { PluginContents } from "./PluginContents";
import { RegistryContext, useAtomValue } from "@effect/atom-react";
import {
  ProviderInstanceId,
  type ProviderStoreEntry,
  type ServerProvider,
} from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { T, useGT } from "gt-react";
import { useContext, useState } from "react";
import { AsyncResult, Atom } from "effect/reactivity";
import * as Option from "effect/Option";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { useDebouncedValue } from "../../state/queries";
import { useActionLock } from "./extensionActions";
import { ActionFeedback } from "./ExtensionItems";
import { AboutCard, DetailHeader, DetailLayout } from "./ExtensionDetailPages";
import {
  BackLink,
  ExtensionsPage,
  ExtensionsSection,
  MutedLine,
  SECTION_TITLE_LINK_CLASS,
  SectionTitleChevron,
  useExtensionsEnvironment,
  useRememberListPage,
} from "./ExtensionsPage";
import { ExtensionGrid, ExtensionRow } from "./ExtensionRow";
import {
  actOnProviderPlugin,
  extensionsProviderStoreEntry,
  extensionsProviderStorePage,
} from "./extensionsState";
import { storeMatches } from "./extensionsView";
import { isAccountServiceStoreEntry, storeEntryAudience } from "./accountServices";
import { StoreEntryAgents } from "./ServiceAgents";
import { WorksWithValue } from "./WorksWith";
import { useWindowFocusRefresh } from "./useWindowFocusRefresh";
import {
  AntigravityConnectionSignIn,
  isThirdPartyPlugin,
  needsAntigravityConnectionSignIn,
  StoreInstall,
  storeProviders,
  ThirdPartyNotice,
} from "./StoreInstall";

/** One page of one agent's store; the store page refreshes the same first page. */
const storePageInput = (
  instanceId: ProviderInstanceId,
  query: string,
  preview: boolean,
  cursor?: string,
) => ({
  instanceId,
  query,
  preview,
  // A preview shelf shows six; spares replace entries a service row already lists.
  limit: preview ? 12 : 30,
  ...(cursor ? { cursor } : {}),
});

/**
 * One store's plugins merged across every agent instance that reads it, each plugin once. A
 * preview shelf with nothing to show and nothing to say is left out; the full list says once
 * that nothing matched.
 */
function StoreList({
  providers,
  query,
  preview,
  title,
}: {
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly query: string;
  readonly preview: boolean;
  /** A preview shelf's heading, linking to the full store. */
  readonly title?: string;
}) {
  const gt = useGT();
  const { environmentId, providers: allProviders, catalog } = useExtensionsEnvironment();
  const connectors = catalog?.sections.flatMap((section) => section.entries) ?? [];
  const registry = useContext(RegistryContext);
  const act = useAtomCommand(actOnProviderPlugin);
  const allowed = useAtomValue(actOnProviderPlugin.permissionAtom(environmentId));
  const lock = useActionLock(
    JSON.stringify(["store-source", ...providers.map((provider) => provider.instanceId)]),
  );
  const [more, setMore] = useState<Readonly<Record<string, readonly string[]>>>({});
  const pages = useAtomValue(
    Atom.make((get) =>
      providers.flatMap((provider) =>
        [undefined, ...(more[provider.instanceId] ?? [])].map((cursor) => {
          const atom = extensionsProviderStorePage({
            environmentId,
            input: storePageInput(provider.instanceId, query, preview, cursor),
          });
          return { provider, atom, result: get(atom) };
        }),
      ),
    ),
  );
  useWindowFocusRefresh(() => pages.forEach(({ atom }) => registry.refresh(atom)));
  const seen = new Set<string>();
  const rows: Array<{ provider: ServerProvider; entry: ProviderStoreEntry }> = [];
  for (const { provider, result } of pages) {
    for (const entry of Option.getOrNull(AsyncResult.value(result))?.entries ?? []) {
      const key = `${entry.kind}:${entry.id}`;
      // A shelf leaves out what Discover lists as a service or a Scient connector of its own.
      if (
        seen.has(key) ||
        (preview &&
          ((entry.kind === "codex" && entry.installed) ||
            isAccountServiceStoreEntry(entry) ||
            connectors.some((connector) => storeMatches(entry, connector))))
      )
        continue;
      seen.add(key);
      rows.push({ provider, entry });
    }
  }
  const messages = [
    ...new Set(
      pages.flatMap(({ provider, result }) => {
        if (AsyncResult.isInitial(result)) return [];
        const name = provider.displayName ?? provider.driver;
        if (result._tag === "Failure") return [gt("Could not read {name}’s store.", { name })];
        const data = Option.getOrNull(AsyncResult.value(result));
        return [
          ...(data?.message ? [data.message] : []),
          ...(data?.sourceFailures?.length ? [gt("Some plugin stores could not be read.")] : []),
        ];
      }),
    ),
  ];
  // Scient Agent without Claude reads Claude Code's store only once it is added.
  const addStoreTo = providers.some((provider) => provider.driver === "claudeAgent")
    ? undefined
    : pages.find(
        ({ result }) => Option.getOrNull(AsyncResult.value(result))?.canAddOfficialStore === true,
      );
  // Each instance's latest page says whether it has more; one button asks them all.
  const next = preview
    ? []
    : providers.flatMap((provider): Array<readonly [string, string]> => {
        const latest = pages.filter((page) => page.provider === provider).at(-1);
        const cursor = latest
          ? Option.getOrNull(AsyncResult.value(latest.result))?.nextCursor
          : null;
        return cursor && !(more[provider.instanceId] ?? []).includes(cursor)
          ? [[provider.instanceId, cursor]]
          : [];
      });
  const loading = pages.some(({ result }) => AsyncResult.isInitial(result));
  const empty = !loading && rows.length === 0 && messages.length === 0;
  if (preview && empty && addStoreTo === undefined) return null;
  const contents = (
    <>
      {loading && rows.length === 0 ? (
        <MutedLine>
          <T>Loading plugins…</T>
        </MutedLine>
      ) : null}
      {messages.map((message) => (
        <MutedLine key={message}>{message}</MutedLine>
      ))}
      {addStoreTo ? (
        <Button
          size="sm"
          variant="ghost-primary"
          disabled={!allowed || lock.locked}
          onClick={() =>
            void lock.run("add-store", async () => {
              const result = await act({
                environmentId,
                input: {
                  instanceId: addStoreTo.provider.instanceId,
                  action: { type: "add-official-store" },
                },
              });
              registry.refresh(addStoreTo.atom);
              return result;
            })
          }
        >
          {lock.busy ? gt("Adding store…") : gt("Add Claude Code's store")}
        </Button>
      ) : null}
      <ActionFeedback feedback={lock.feedback} />
      <ExtensionGrid label={title ?? gt("Plugins")}>
        {(preview ? rows.slice(0, 6) : rows).map(({ provider, entry }) => (
          <ExtensionRow
            key={`${entry.kind}:${entry.id}`}
            target={{ kind: "provider-store", instanceId: provider.instanceId, entryId: entry.id }}
            audience={storeEntryAudience(provider, entry, allProviders)}
            name={entry.displayName}
            iconUrl={entry.iconUrl}
            tagline={entry.description}
            status={entry.installed ? gt("Added") : null}
          />
        ))}
      </ExtensionGrid>
      {empty ? (
        <MutedLine>
          <T>No plugins found.</T>
        </MutedLine>
      ) : null}
      {next.length > 0 ? (
        <Button
          size="sm"
          variant="ghost-muted"
          onClick={() =>
            setMore((current) => {
              const updated = { ...current };
              for (const [instanceId, cursor] of next)
                updated[instanceId] = [...(updated[instanceId] ?? []), cursor];
              return updated;
            })
          }
        >
          <T>Load more</T>
        </Button>
      ) : null}
    </>
  );
  if (title === undefined) return contents;
  return (
    <ExtensionsSection
      title={
        <Link
          to="/settings/extensions/store/$instanceId"
          params={{ instanceId: providers[0]!.instanceId }}
          className={SECTION_TITLE_LINK_CLASS}
        >
          {title}
          <SectionTitleChevron />
        </Link>
      }
    >
      {contents}
    </ExtensionsSection>
  );
}

export function ProviderStoreShelves({ query = "" }: { readonly query?: string }) {
  const gt = useGT();
  const { providers } = useExtensionsEnvironment();
  const shared = storeProviders(providers, "shared");
  const codex = storeProviders(providers, "codex");
  const antigravity = storeProviders(providers, "antigravity");
  return (
    <>
      {shared.length ? (
        <StoreList
          key={`shared:${query}`}
          title={gt("Plugins for Claude and Scient Agent")}
          providers={shared}
          query={query}
          preview
        />
      ) : null}
      {codex.length ? (
        <StoreList
          key={`codex:${query}`}
          title={gt("From the Codex store")}
          providers={codex}
          query={query}
          preview
        />
      ) : null}
      {antigravity.length ? (
        <StoreList
          key={`antigravity:${query}`}
          title={gt("From the Antigravity Marketplace")}
          providers={antigravity}
          query={query}
          preview
        />
      ) : null}
    </>
  );
}

function Store({ instanceId }: { readonly instanceId: string }) {
  const gt = useGT();
  const { providers } = useExtensionsEnvironment();
  const provider = providers.find((item) => item.instanceId === instanceId);
  const [search, setSearch] = useState("");
  const query = useDebouncedValue(search.trim(), 300);
  const { environmentId } = useExtensionsEnvironment();
  const registry = useContext(RegistryContext);
  const act = useAtomCommand(actOnProviderPlugin);
  const allowed = useAtomValue(actOnProviderPlugin.permissionAtom(environmentId));
  const lock = useActionLock(JSON.stringify(["refresh-store", instanceId]));
  const targets =
    provider === undefined
      ? []
      : provider.driver === "codex" || provider.driver === "antigravity"
        ? [provider]
        : storeProviders(providers, "shared");
  const title =
    provider?.driver === "codex"
      ? gt("From the Codex store")
      : provider?.driver === "antigravity"
        ? gt("From the Antigravity Marketplace")
        : gt("Plugins for Claude and Scient Agent");
  useRememberListPage(title);
  return (
    <>
      <BackLink to="/settings/extensions">{gt("Discover")}</BackLink>
      <ExtensionsSection title={title}>
        <Input
          aria-label={gt("Search plugins")}
          placeholder={gt("Search plugins")}
          value={search}
          onChange={(event) => setSearch(event.currentTarget.value)}
        />
        {provider ? (
          <Button
            size="sm"
            variant="ghost-muted"
            disabled={!allowed || lock.locked}
            onClick={() =>
              void lock.run("refresh", async () => {
                const result = await act({
                  environmentId,
                  input: { instanceId: provider.instanceId, action: { type: "refresh-inventory" } },
                });
                for (const target of targets)
                  registry.refresh(
                    extensionsProviderStorePage({
                      environmentId,
                      input: storePageInput(target.instanceId, query, false),
                    }),
                  );
                return result;
              })
            }
          >
            {lock.busy ? gt("Refreshing…") : gt("Refresh")}
          </Button>
        ) : null}
        <ActionFeedback feedback={lock.feedback} />
        {provider ? (
          <StoreList key={query} providers={targets} query={query} preview={false} />
        ) : (
          <MutedLine>
            <T>This agent is no longer available.</T>
          </MutedLine>
        )}
      </ExtensionsSection>
    </>
  );
}
export function ProviderStorePage({ instanceId }: { readonly instanceId: string }) {
  return (
    <ExtensionsPage>
      <Store instanceId={instanceId} />
    </ExtensionsPage>
  );
}
function StoreDetail({
  instanceId,
  entryId,
}: {
  readonly instanceId: string;
  readonly entryId: string;
}) {
  const gt = useGT();
  const { environmentId, providers, catalog } = useExtensionsEnvironment();
  const registry = useContext(RegistryContext);
  const atom = extensionsProviderStoreEntry({
    environmentId,
    input: { instanceId: ProviderInstanceId.make(instanceId), entryId },
  });
  const result = useEnvironmentQuery(atom);
  useWindowFocusRefresh(() => registry.refresh(atom));
  const provider = providers.find((item) => item.instanceId === instanceId);
  if (!provider || !result.data)
    return <MutedLine>{result.error ?? gt("Loading plugin…")}</MutedLine>;
  const entry = result.data;
  // The Scient connector for the same service, which every agent gets from one Add.
  const connector = catalog?.sections
    .flatMap((section) => section.entries)
    .find((item) => storeMatches(entry, item));
  return (
    <DetailLayout
      back="discover"
      header={
        <DetailHeader
          name={entry.displayName}
          iconUrl={entry.iconUrl}
          developer={entry.publisher}
          tagline={entry.tagline}
          actions={
            <StoreInstall
              provider={provider}
              entry={entry}
              refresh={() => registry.refresh(atom)}
            />
          }
        />
      }
      description={entry.description}
    >
      {entry.disabledReason ? <MutedLine>{entry.disabledReason}</MutedLine> : null}
      {isThirdPartyPlugin(entry) && !entry.installed ? <ThirdPartyNotice entry={entry} /> : null}
      {needsAntigravityConnectionSignIn(entry) ? (
        <AntigravityConnectionSignIn entry={entry} />
      ) : null}
      <StoreEntryAgents entry={entry} />
      <PluginContents
        key={JSON.stringify([provider.instanceId, entry.id])}
        provider={provider}
        pluginName={entry.displayName}
        canConnectApps={entry.installed}
        iconUrl={entry.iconUrl}
        input={{ instanceId: provider.instanceId, entryId: entry.id }}
      />
      <AboutCard
        rows={[
          [
            gt("Works with"),
            <WorksWithValue
              key="works-with"
              audience={storeEntryAudience(provider, entry, providers)}
            />,
          ],
          connector
            ? [
                gt("Also available"),
                <Link
                  key="connector"
                  to="/settings/extensions/item/server/$"
                  params={{ _splat: connector.name }}
                >
                  <T>Connect with Scient for all your agents</T>
                </Link>,
              ]
            : null,
          [gt("Marketplace"), entry.marketplace],
          entry.version ? [gt("Version"), entry.version] : null,
          entry.publisher ? [gt("Publisher"), entry.publisher] : null,
          entry.publisherType
            ? [
                gt("Catalog", { $context: "which list of plugins this one comes from" }),
                entry.publisherType === "google"
                  ? gt("Google’s own plugins")
                  : gt("Partner plugins from other developers"),
              ]
            : null,
          entry.review
            ? [
                gt("Review", { $context: "noun, who reviewed a plugin" }),
                entry.review === "anthropic"
                  ? gt("Reviewed by Anthropic")
                  : gt("Reviewed by a partner"),
              ]
            : null,
        ]}
      />
    </DetailLayout>
  );
}
export function ProviderStoreDetailPage(props: {
  readonly instanceId: string;
  readonly entryId: string;
}) {
  return (
    <ExtensionsPage loadProviderInventory>
      <StoreDetail key={JSON.stringify(props)} {...props} />
    </ExtensionsPage>
  );
}
