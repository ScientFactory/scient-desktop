import { PlusIcon } from "lucide-react";
import { PluginContents } from "./PluginContents";
import { RegistryContext, useAtomValue } from "@effect/atom-react";
import {
  ProviderInstanceId,
  type ProviderStoreEntry,
  type ServerProvider,
  type ServerProviderPlugin,
} from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { T, useGT, Var } from "gt-react";
import { useContext, useState } from "react";
import { AsyncResult, Atom } from "effect/reactivity";
import * as Option from "effect/Option";
import { ensureLocalApi } from "../../localApi";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { useDebouncedValue } from "../../state/queries";
import { useActionLock, useProviderPluginActions } from "./extensionActions";
import { ActionFeedback } from "./ExtensionItems";
import { AboutCard, DetailHeader, DetailLayout, PrimaryAction } from "./ExtensionDetailPages";
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
import { providerAvailable } from "./extensionsView";
import { isAccountServiceStoreEntry, storeEntryAudience } from "./accountServices";
import { WorksWithValue } from "./WorksWith";
import { useWindowFocusRefresh } from "./useWindowFocusRefresh";

/**
 * Antigravity's partner catalog lists plugins other developers make; Google's own are not. An
 * entry known only by id (a service page's route) says which catalog listed it.
 */
function isThirdPartyPlugin(entry: Pick<ProviderStoreEntry, "kind" | "id" | "publisherType">) {
  return (
    entry.kind === "antigravity" &&
    (entry.publisherType === "third-party" || entry.id.endsWith("@antigravity-plugins-partners"))
  );
}

function useThirdPartyNoticeText(publisher: string | undefined) {
  const gt = useGT();
  return publisher
    ? gt(
        "{developer} makes this plugin, not Google. It can run its own code and connect to {developer}’s services. Add it only if you trust {developer}.",
        { developer: publisher },
      )
    : gt(
        "A third-party developer makes this plugin, not Google. It can run its own code and connect to that developer’s services. Add it only if you trust them.",
      );
}

function ThirdPartyNotice({ entry }: { readonly entry: ProviderStoreEntry }) {
  return <MutedLine>{useThirdPartyNoticeText(entry.publisher)}</MutedLine>;
}

/**
 * Installs a store entry into the agent that keeps it: a Claude plugin for Scient Agent goes into
 * a Claude instance, whose plugins Scient Agent loads. Every Add, from a list, a plugin page or a
 * service page, shows a third-party plugin's notice first.
 */
export function useStoreInstall(
  provider: ServerProvider,
  entry: Pick<ProviderStoreEntry, "kind" | "id"> &
    Partial<Pick<ProviderStoreEntry, "publisher" | "publisherType">>,
  refresh: () => void,
) {
  const { environmentId, providers } = useExtensionsEnvironment();
  const target =
    entry.kind === "shared" && provider.driver === "scient"
      ? (providers.find((item) => providerAvailable(item) && item.driver === "claudeAgent") ??
        provider)
      : provider;
  const plugin = target.plugins?.find(
    (plugin) => plugin.id === entry.id || plugin.name === entry.id,
  );
  const allowed = useAtomValue(actOnProviderPlugin.permissionAtom(environmentId));
  const act = useAtomCommand(actOnProviderPlugin);
  const lock = useActionLock(JSON.stringify(["store", provider.instanceId, entry.id]));
  const notice = useThirdPartyNoticeText(entry.publisher);
  return {
    target,
    plugin,
    allowed,
    lock,
    install: () =>
      void (async () => {
        if (isThirdPartyPlugin(entry) && !(await ensureLocalApi().dialogs.confirm(notice))) return;
        await lock.run("install", async () => {
          const result = await act({
            environmentId,
            input: {
              instanceId: target.instanceId,
              action: {
                type: "install",
                entryId: entry.id,
                ...(target.instanceId !== provider.instanceId
                  ? { sourceInstanceId: provider.instanceId }
                  : {}),
              },
            },
          });
          refresh();
          return result;
        });
      })(),
  };
}

/**
 * agy loads a plugin's MCP servers only once they are signed in through its own plugin manager,
 * which Scient can't drive; its chats here get the skills until then.
 */
export function needsAntigravityConnectionSignIn(entry: ProviderStoreEntry) {
  return entry.kind === "antigravity" && entry.installed && entry.includes.includes("MCP servers");
}

function AntigravityConnectionSignIn({ entry }: { readonly entry: ProviderStoreEntry }) {
  return (
    <MutedLine>
      <T>
        Its connection to <Var>{entry.displayName}</Var> signs in only in Antigravity’s own plugin
        manager (run <code>agy</code>, open <code>/plugin</code>), which Scient can’t open yet, so
        Scient chats use its skills.
      </T>
    </MutedLine>
  );
}

export function StoreInstall({
  provider,
  entry,
  refresh,
  compact = false,
}: {
  readonly provider: ServerProvider;
  readonly entry: ProviderStoreEntry;
  readonly refresh: () => void;
  /** In a list under the store's own heading: "Add" and "Remove", the agent goes without saying. */
  readonly compact?: boolean;
}) {
  const gt = useGT();
  const { target, plugin, allowed, lock, install } = useStoreInstall(provider, entry, refresh);
  const installed = entry.installed || plugin !== undefined;
  if (installed && plugin?.canUninstall)
    return <StoreRemove provider={target} plugin={plugin} refresh={refresh} compact={compact} />;
  if (compact && installed)
    return (
      <span className="text-sm text-muted-foreground">
        <T>Added</T>
      </span>
    );
  return (
    <>
      <PrimaryAction
        icon={PlusIcon}
        disabled={!allowed || lock.locked || installed || Boolean(entry.disabledReason)}
        onClick={install}
      >
        {lock.busy
          ? gt("Adding…")
          : compact
            ? gt("Add", { $context: "verb, adds an extension" })
            : installed
              ? gt("Added")
              : target.driver === "codex"
                ? gt("Add to Codex")
                : target.driver === "antigravity"
                  ? gt("Add to Antigravity")
                  : target.driver === "claudeAgent"
                    ? gt("Add to Claude Code")
                    : gt("Add to Scient Agent")}
      </PrimaryAction>
      {installed ? (
        <MutedLine>
          {target.displayName === undefined ? (
            <T>Remove this plugin in the agent’s plugin manager.</T>
          ) : (
            <T>
              Remove this plugin in <Var>{target.displayName}</Var>’s plugin manager.
            </T>
          )}
        </MutedLine>
      ) : null}
      <ActionFeedback feedback={lock.feedback} />
    </>
  );
}

function StoreRemove({
  provider,
  plugin,
  refresh,
  compact,
}: {
  readonly provider: ServerProvider;
  readonly plugin: ServerProviderPlugin;
  readonly refresh: () => void;
  readonly compact: boolean;
}) {
  const gt = useGT();
  const actions = useProviderPluginActions(
    provider,
    provider.displayName ?? gt("this agent"),
    plugin,
    undefined,
  );
  return (
    <>
      <Button
        variant="destructive-outline"
        {...(compact ? { size: "sm" as const } : {})}
        disabled={actions.locked}
        onClick={() => void actions.uninstall().then(refresh)}
      >
        {actions.busy
          ? gt("Removing…")
          : compact
            ? gt("Remove")
            : provider.displayName === undefined
              ? gt("Remove from this agent")
              : gt("Remove from {agent}", { agent: provider.displayName })}
      </Button>
      <ActionFeedback feedback={actions.feedback} />
    </>
  );
}

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
 * The agents reading one store; Claude's marketplaces serve Claude and Scient Agent alike, while
 * Codex's store and the Antigravity Marketplace each serve their own agent.
 */
function storeProviders(
  providers: ReadonlyArray<ServerProvider>,
  store: ProviderStoreEntry["kind"],
): ReadonlyArray<ServerProvider> {
  const available = providers.filter(providerAvailable);
  // Claude first: its instance installs a shared plugin for Scient Agent too.
  return store === "shared"
    ? [
        ...available.filter((provider) => provider.driver === "claudeAgent"),
        ...available.filter((provider) => provider.driver === "scient"),
      ]
    : available.filter((provider) => provider.driver === store);
}

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
  const { environmentId, providers: allProviders } = useExtensionsEnvironment();
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
      // A shelf leaves out what Discover lists as a service of its own.
      if (
        seen.has(key) ||
        (preview &&
          ((entry.kind === "codex" && entry.installed) || isAccountServiceStoreEntry(entry)))
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
  const connector = catalog?.sections
    .flatMap((section) => section.entries)
    .find((item) =>
      entry.kind === "antigravity"
        ? item.agentStores?.antigravity === entry.id
        : item.agentStores?.codex === entry.name,
    );
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
