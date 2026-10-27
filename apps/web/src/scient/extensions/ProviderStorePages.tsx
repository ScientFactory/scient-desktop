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
import { useContext, useState } from "react";
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
} from "./ExtensionsPage";
import { ExtensionGrid, ExtensionRow } from "./ExtensionRow";
import {
  actOnProviderPlugin,
  extensionsProviderStoreEntry,
  extensionsProviderStorePage,
} from "./extensionsState";
import { WorksWithValue } from "./WorksWith";
import { useWindowFocusRefresh } from "./useWindowFocusRefresh";

function storeAvailable(provider: ServerProvider) {
  return (
    provider.enabled &&
    provider.installed &&
    (provider.status === "ready" || provider.status === "warning") &&
    provider.availability !== "unavailable"
  );
}

function StoreInstall({
  provider,
  entry,
  refresh,
}: {
  readonly provider: ServerProvider;
  readonly entry: ProviderStoreEntry;
  readonly refresh: () => void;
}) {
  const { environmentId, providers } = useExtensionsEnvironment();
  const target =
    entry.kind === "shared" && provider.driver === "scient"
      ? (providers.find((item) => storeAvailable(item) && item.driver === "claudeAgent") ??
        provider)
      : provider;
  const plugin = target.plugins?.find(
    (plugin) => plugin.id === entry.id || plugin.name === entry.id,
  );
  const installed = entry.installed || plugin !== undefined;
  const allowed = useAtomValue(actOnProviderPlugin.permissionAtom(environmentId));
  const act = useAtomCommand(actOnProviderPlugin);
  const lock = useActionLock(JSON.stringify(["store", provider.instanceId, entry.id]));
  if (installed && plugin?.canUninstall)
    return <StoreRemove provider={target} plugin={plugin} refresh={refresh} />;
  return (
    <>
      <PrimaryAction
        icon={PlusIcon}
        disabled={!allowed || lock.locked || installed || Boolean(entry.disabledReason)}
        onClick={() =>
          void lock.run("install", async () => {
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
          })
        }
      >
        {lock.busy
          ? "Adding…"
          : installed
            ? "Added"
            : target.driver === "codex"
              ? "Add to Codex"
              : target.driver === "claudeAgent"
                ? "Add to Claude Code"
                : "Add to Scient Agent"}
      </PrimaryAction>
      {installed ? (
        <MutedLine>
          Remove this plugin in {target.displayName ?? "the agent"}’s plugin manager.
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
}: {
  readonly provider: ServerProvider;
  readonly plugin: ServerProviderPlugin;
  readonly refresh: () => void;
}) {
  const actions = useProviderPluginActions(
    provider,
    provider.displayName ?? "this agent",
    plugin,
    undefined,
  );
  return (
    <>
      <span className="text-sm text-muted-foreground">Added</span>
      <Button
        variant="destructive-outline"
        disabled={actions.locked}
        onClick={() => void actions.uninstall().then(refresh)}
      >
        {actions.busy ? "Removing…" : "Remove"}
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
  const claude = providers.find((item) => storeAvailable(item) && item.driver === "claudeAgent");
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
        !(claudeServesOfficial && entry.marketplace === "claude-plugins-official"),
    ) ?? [];
  return (
    <>
      {page.error ? (
        <MutedLine>
          {provider.displayName ??
            (provider.driver === "scient"
              ? "Scient Agent"
              : provider.driver === "claudeAgent"
                ? "Claude Code"
                : "Codex")}
          : {page.error}{" "}
          <Button size="sm" variant="ghost-muted" onClick={refresh}>
            Retry
          </Button>
        </MutedLine>
      ) : page.data === null ? (
        <MutedLine>Loading plugins…</MutedLine>
      ) : (
        <>
          {page.data.sourceFailures?.length ? (
            <MutedLine>
              Could not read {page.data.sourceFailures.join(", ")}.{" "}
              <Button size="sm" variant="ghost-muted" onClick={refresh}>
                Retry
              </Button>
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
              {lock.busy ? "Adding store…" : "Add Claude Code's store"}
            </Button>
          ) : null}
          <ActionFeedback feedback={lock.feedback} />
          <ExtensionGrid label="Plugins">
            {entries.map((entry) => (
              <ExtensionRow
                key={entry.id}
                target={{
                  kind: "provider-store",
                  instanceId: provider.instanceId,
                  entryId: entry.id,
                }}
                audience={
                  entry.kind === "shared"
                    ? { layer: "shared", ownerInstanceId: provider.instanceId }
                    : {
                        layer: "agent",
                        driver: provider.driver,
                        instanceId: provider.instanceId,
                        label: "Codex",
                        reason: "Uses Codex's own ChatGPT account",
                      }
                }
                name={entry.displayName}
                iconUrl={entry.iconUrl}
                tagline={entry.description}
                status={entry.installed ? "Added" : null}
              />
            ))}
          </ExtensionGrid>
          {!entries.length && !page.data.message ? <MutedLine>No plugins found.</MutedLine> : null}
          {!preview && page.data.nextCursor && !next ? (
            <Button size="sm" variant="ghost-muted" onClick={() => setNext(page.data!.nextCursor)}>
              Load more
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
    (provider) => storeAvailable(provider) && provider.driver === "claudeAgent",
  );
  const scient = providers.filter(
    (provider) => storeAvailable(provider) && provider.driver === "scient",
  );
  const targets = [...claude, ...scient];
  const primary = targets[0];
  const codex = providers.filter(
    (provider) => storeAvailable(provider) && provider.driver === "codex",
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
              Plugins for Claude and Scient Agent
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
              From the Codex store
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
  const { providers } = useExtensionsEnvironment();
  const provider = providers.find((item) => item.instanceId === instanceId);
  const [search, setSearch] = useState("");
  const query = useDebouncedValue(search.trim(), 300);
  const { environmentId } = useExtensionsEnvironment();
  const registry = useContext(RegistryContext);
  const act = useAtomCommand(actOnProviderPlugin);
  const allowed = useAtomValue(actOnProviderPlugin.permissionAtom(environmentId));
  const lock = useActionLock(JSON.stringify(["refresh-store", instanceId]));
  return (
    <>
      <BackLink to="/settings/extensions">Discover</BackLink>
      <ExtensionsSection
        title={
          provider?.driver === "codex"
            ? "From the Codex store"
            : "Plugins for Claude and Scient Agent"
        }
      >
        <Input
          aria-label="Search plugins"
          placeholder="Search plugins"
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
            {lock.busy ? "Refreshing…" : "Refresh"}
          </Button>
        ) : null}
        <ActionFeedback feedback={lock.feedback} />
        {provider ? (
          <>
            {(provider.driver === "codex"
              ? [provider]
              : providers.filter(
                  (item) =>
                    storeAvailable(item) &&
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
          <MutedLine>This agent is no longer available.</MutedLine>
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
  const { environmentId, providers, catalog } = useExtensionsEnvironment();
  const registry = useContext(RegistryContext);
  const atom = extensionsProviderStoreEntry({
    environmentId,
    input: { instanceId: ProviderInstanceId.make(instanceId), entryId },
  });
  const result = useEnvironmentQuery(atom);
  useWindowFocusRefresh(() => registry.refresh(atom));
  const provider = providers.find((item) => item.instanceId === instanceId);
  if (!provider || !result.data) return <MutedLine>{result.error ?? "Loading plugin…"}</MutedLine>;
  const entry = result.data;
  const connector = catalog?.sections
    .flatMap((section) => section.entries)
    .find((item) => item.agentStores?.codex === entry.name);
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
      <PluginContents
        key={JSON.stringify([provider.instanceId, entry.id])}
        provider={provider}
        canConnectApps={entry.installed}
        iconUrl={entry.iconUrl}
        input={{ instanceId: provider.instanceId, entryId: entry.id }}
      />
      <AboutCard
        rows={[
          [
            "Works with",
            <WorksWithValue
              key="works-with"
              audience={
                entry.kind === "shared"
                  ? { layer: "shared", ownerInstanceId: provider.instanceId }
                  : {
                      layer: "agent",
                      driver: provider.driver,
                      instanceId: provider.instanceId,
                      label: "Codex",
                      reason: "Uses Codex's own ChatGPT account",
                    }
              }
            />,
          ],
          connector
            ? [
                "Also available",
                <Link
                  key="connector"
                  to="/settings/extensions/item/server/$"
                  params={{ _splat: connector.name }}
                >
                  Connect with Scient for all your agents
                </Link>,
              ]
            : null,
          ["Marketplace", entry.marketplace],
          entry.version ? ["Version", entry.version] : null,
          entry.publisher ? ["Publisher", entry.publisher] : null,
          entry.review
            ? [
                "Review",
                entry.review === "anthropic" ? "Reviewed by Anthropic" : "Reviewed by a partner",
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
