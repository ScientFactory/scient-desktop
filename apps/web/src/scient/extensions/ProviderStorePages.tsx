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
import { isAccountServiceStoreEntry } from "./accountServices";
import { providerAvailable, providerStoreAudience } from "./extensionsView";
import { WorksWithValue } from "./WorksWith";
import { useWindowFocusRefresh } from "./useWindowFocusRefresh";

/** Antigravity's partner catalog lists plugins other developers make; Google's own are not. */
function isThirdPartyPlugin(entry: ProviderStoreEntry) {
  return entry.kind === "antigravity" && entry.publisherType === "third-party";
}

function useThirdPartyNoticeText(entry: ProviderStoreEntry) {
  const gt = useGT();
  return entry.publisher
    ? gt(
        "{developer} makes this plugin, not Google. It can run its own code and connect to {developer}’s services. Add it only if you trust {developer}.",
        { developer: entry.publisher },
      )
    : gt(
        "A third-party developer makes this plugin, not Google. It can run its own code and connect to that developer’s services. Add it only if you trust them.",
      );
}

function ThirdPartyNotice({ entry }: { readonly entry: ProviderStoreEntry }) {
  return <MutedLine>{useThirdPartyNoticeText(entry)}</MutedLine>;
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
  const { environmentId, providers } = useExtensionsEnvironment();
  const target =
    entry.kind === "shared" && provider.driver === "scient"
      ? (providers.find((item) => providerAvailable(item) && item.driver === "claudeAgent") ??
        provider)
      : provider;
  const plugin = target.plugins?.find(
    (plugin) => plugin.id === entry.id || plugin.name === entry.id,
  );
  const installed = entry.installed || plugin !== undefined;
  const allowed = useAtomValue(actOnProviderPlugin.permissionAtom(environmentId));
  const act = useAtomCommand(actOnProviderPlugin);
  const lock = useActionLock(JSON.stringify(["store", provider.instanceId, entry.id]));
  const notice = useThirdPartyNoticeText(entry);
  const add = async () => {
    // Every Add, in a list or on the detail page, shows a third-party notice first.
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
  };
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
        onClick={() => void add()}
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

function StoreResults({
  provider,
  query,
  preview,
  cursor,
}: {
  readonly provider: ServerProvider;
  readonly query: string;
  readonly preview: boolean;
  readonly cursor?: string;
}) {
  const gt = useGT();
  const { environmentId, providers } = useExtensionsEnvironment();
  const registry = useContext(RegistryContext);
  const atom = extensionsProviderStorePage({
    environmentId,
    input: {
      instanceId: provider.instanceId,
      query,
      preview,
      limit: preview ? 6 : 30,
      ...(cursor ? { cursor } : {}),
    },
  });
  const page = useEnvironmentQuery(atom);
  // Scient Agent's official entries repeat Claude's only when Claude's own home serves them.
  const claude = providers.find((item) => providerAvailable(item) && item.driver === "claudeAgent");
  const claudePage = useEnvironmentQuery(
    extensionsProviderStorePage({
      environmentId,
      input: {
        instanceId:
          provider.driver === "scient" && claude ? claude.instanceId : provider.instanceId,
        query,
        preview,
        limit: preview ? 6 : 30,
      },
    }),
  );
  const claudeServesOfficial =
    provider.driver === "scient" &&
    claude !== undefined &&
    claudePage.data?.officialStoreConfigured === true;
  const [next, setNext] = useState<string>();
  const act = useAtomCommand(actOnProviderPlugin);
  const allowed = useAtomValue(actOnProviderPlugin.permissionAtom(environmentId));
  const lock = useActionLock(JSON.stringify(["store-source", provider.instanceId]));
  const refresh = () => registry.refresh(atom);
  useWindowFocusRefresh(() => registry.refresh(atom));
  const entries =
    page.data?.entries.filter(
      (entry) =>
        (entry.kind !== "codex" || !preview || !entry.installed) &&
        // Gmail and the like are offered on their service pages; the full store keeps them.
        !(preview && entry.kind === "antigravity" && isAccountServiceStoreEntry(entry)) &&
        !(claudeServesOfficial && entry.marketplace === "claude-plugins-official"),
    ) ?? [];
  return (
    <>
      {page.error ? (
        <MutedLine>
          <T>
            <Var>
              {provider.displayName ??
                (provider.driver === "scient"
                  ? "Scient Agent"
                  : provider.driver === "claudeAgent"
                    ? "Claude Code"
                    : provider.driver === "antigravity"
                      ? "Antigravity"
                      : "Codex")}
            </Var>
            : <Var>{page.error}</Var>{" "}
            <Button size="sm" variant="ghost-muted" onClick={refresh}>
              Retry
            </Button>
          </T>
        </MutedLine>
      ) : page.data === null ? (
        <MutedLine>
          <T>Loading plugins…</T>
        </MutedLine>
      ) : (
        <>
          {page.data.sourceFailures?.length ? (
            <MutedLine>
              <T>
                Could not read <Var>{page.data.sourceFailures.join(", ")}</Var>.{" "}
                <Button size="sm" variant="ghost-muted" onClick={refresh}>
                  Retry
                </Button>
              </T>
            </MutedLine>
          ) : null}
          {page.data.message ? <MutedLine>{page.data.message}</MutedLine> : null}
          {page.data.canAddOfficialStore && !claudeServesOfficial ? (
            <Button
              size="sm"
              variant="ghost-primary"
              disabled={!allowed || lock.locked}
              onClick={() =>
                void lock.run("add-store", async () => {
                  const result = await act({
                    environmentId,
                    input: {
                      instanceId: provider.instanceId,
                      action: { type: "add-official-store" },
                    },
                  });
                  refresh();
                  return result;
                })
              }
            >
              {lock.busy ? gt("Adding store…") : gt("Add Claude Code's store")}
            </Button>
          ) : null}
          <ActionFeedback feedback={lock.feedback} />
          <ExtensionGrid label={gt("Plugins")}>
            {entries.map((entry) => (
              <ExtensionRow
                key={entry.id}
                target={{
                  kind: "provider-store",
                  instanceId: provider.instanceId,
                  entryId: entry.id,
                }}
                audience={providerStoreAudience(provider, entry.kind)}
                name={entry.displayName}
                iconUrl={entry.iconUrl}
                tagline={entry.description}
                status={entry.installed ? gt("Added") : null}
              />
            ))}
          </ExtensionGrid>
          {!entries.length && !page.data.message ? (
            <MutedLine>
              <T>No plugins found.</T>
            </MutedLine>
          ) : null}
          {!preview && page.data.nextCursor && !next ? (
            <Button size="sm" variant="ghost-muted" onClick={() => setNext(page.data!.nextCursor)}>
              <T>Load more</T>
            </Button>
          ) : null}
          {!preview && next ? (
            <StoreResults
              key={next}
              provider={provider}
              query={query}
              preview={false}
              cursor={next}
            />
          ) : null}
        </>
      )}
    </>
  );
}

export function ProviderStoreShelves({ query = "" }: { readonly query?: string }) {
  const { providers } = useExtensionsEnvironment();
  const claude = providers.filter(
    (provider) => providerAvailable(provider) && provider.driver === "claudeAgent",
  );
  const scient = providers.filter(
    (provider) => providerAvailable(provider) && provider.driver === "scient",
  );
  const targets = [...claude, ...scient];
  const primary = targets[0];
  const codex = providers.filter(
    (provider) => providerAvailable(provider) && provider.driver === "codex",
  );
  const antigravity = providers.filter(
    (provider) => providerAvailable(provider) && provider.driver === "antigravity",
  );
  return (
    <>
      {primary ? (
        <ExtensionsSection
          title={
            <Link
              to="/settings/extensions/store/$instanceId"
              params={{ instanceId: primary.instanceId }}
              className={SECTION_TITLE_LINK_CLASS}
            >
              <T>Plugins for Claude and Scient Agent</T>
              <SectionTitleChevron />
            </Link>
          }
        >
          {targets.map((provider) => (
            <StoreResults
              key={`${provider.instanceId}:${query}`}
              provider={provider}
              query={query}
              preview
            />
          ))}
        </ExtensionsSection>
      ) : null}
      {codex.map((provider) => (
        <ExtensionsSection
          key={provider.instanceId}
          title={
            <Link
              to="/settings/extensions/store/$instanceId"
              params={{ instanceId: provider.instanceId }}
              className={SECTION_TITLE_LINK_CLASS}
            >
              <T>From the Codex store</T>
              <SectionTitleChevron />
            </Link>
          }
        >
          <StoreResults
            key={`${provider.instanceId}:${query}`}
            provider={provider}
            query={query}
            preview
          />
        </ExtensionsSection>
      ))}
      {antigravity.map((provider) => (
        <ExtensionsSection
          key={provider.instanceId}
          title={
            <Link
              to="/settings/extensions/store/$instanceId"
              params={{ instanceId: provider.instanceId }}
              className={SECTION_TITLE_LINK_CLASS}
            >
              <T>From the Antigravity Marketplace</T>
              <SectionTitleChevron />
            </Link>
          }
        >
          <StoreResults
            key={`${provider.instanceId}:${query}`}
            provider={provider}
            query={query}
            preview
          />
        </ExtensionsSection>
      ))}
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
                registry.refresh(
                  extensionsProviderStorePage({
                    environmentId,
                    input: { instanceId: provider.instanceId, query, preview: false, limit: 30 },
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
          <>
            {(provider.driver === "codex" || provider.driver === "antigravity"
              ? [provider]
              : providers.filter(
                  (item) =>
                    providerAvailable(item) &&
                    (item.driver === "claudeAgent" || item.driver === "scient"),
                )
            ).map((target) => (
              <StoreResults
                key={`${target.instanceId}:${query}`}
                provider={target}
                query={query}
                preview={false}
              />
            ))}
          </>
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
              audience={providerStoreAudience(provider, entry.kind)}
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
