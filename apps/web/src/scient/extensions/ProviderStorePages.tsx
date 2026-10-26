import { RegistryContext, useAtomValue } from "@effect/atom-react";
import {
  ProviderInstanceId,
  type ProviderStoreEntry,
  type ServerProvider,
} from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { useContext, useEffect, useState } from "react";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { useDebouncedValue } from "../../state/queries";
import { useActionLock } from "./extensionActions";
import { ActionFeedback, ProviderAppConnect } from "./ExtensionItems";
import {
  AboutCard,
  DetailHeader,
  DetailLayout,
  DetailSection,
  GroupsCard,
} from "./ExtensionDetailPages";
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
      ? (providers.find((item) => item.enabled && item.driver === "claudeAgent") ?? provider)
      : provider;
  const installed =
    entry.installed || target.plugins?.some((plugin) => plugin.name === entry.id) === true;
  const allowed = useAtomValue(actOnProviderPlugin.permissionAtom(environmentId));
  const act = useAtomCommand(actOnProviderPlugin);
  const lock = useActionLock(JSON.stringify(["store", provider.instanceId, entry.id]));
  return (
    <>
      <Button
        size="sm"
        variant="ghost-primary"
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
          ? "Installing…"
          : installed
            ? "Installed"
            : target.driver === "codex"
              ? "Install in Codex"
              : target.driver === "claudeAgent"
                ? "Install in Claude Code"
                : "Install in Scient Agent"}
      </Button>
      <ActionFeedback feedback={lock.feedback} />
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
  const { environmentId, catalog, providers } = useExtensionsEnvironment();
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
  const claude = providers.find((item) => item.enabled && item.driver === "claudeAgent");
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
  useEffect(() => {
    const onFocus = () => registry.refresh(atom);
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [atom, registry]);
  const curatedIds = new Set(
    catalog?.sections.flatMap((section) =>
      section.entries.flatMap((entry) =>
        entry.agentStores?.codex ? [entry.agentStores.codex] : [],
      ),
    ),
  );
  const entries =
    page.data?.entries.filter(
      (entry) =>
        (entry.kind !== "codex" || !preview || !curatedIds.has(entry.name)) &&
        !(claudeServesOfficial && entry.marketplace === "claude-plugins-official"),
    ) ?? [];
  return (
    <>
      {page.error ? (
        <MutedLine>{page.error}</MutedLine>
      ) : page.data === null ? (
        <MutedLine>Loading plugins…</MutedLine>
      ) : (
        <>
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
                status={entry.installed ? "Installed" : null}
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
    (provider) =>
      provider.enabled &&
      provider.installed &&
      provider.status !== "error" &&
      provider.driver === "claudeAgent",
  );
  const scient = providers.filter(
    (provider) =>
      provider.enabled &&
      provider.installed &&
      provider.status !== "error" &&
      provider.driver === "scient",
  );
  const targets = [...claude, ...scient];
  const primary = targets[0];
  const codex = providers.filter(
    (provider) =>
      provider.enabled &&
      provider.installed &&
      provider.status !== "error" &&
      provider.driver === "codex",
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
                    item.enabled && (item.driver === "claudeAgent" || item.driver === "scient"),
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
  const { environmentId, providers } = useExtensionsEnvironment();
  const registry = useContext(RegistryContext);
  const atom = extensionsProviderStoreEntry({
    environmentId,
    input: { instanceId: ProviderInstanceId.make(instanceId), entryId },
  });
  const result = useEnvironmentQuery(atom);
  useEffect(() => {
    const refresh = () => registry.refresh(atom);
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [atom, registry]);
  const provider = providers.find((item) => item.instanceId === instanceId);
  if (!provider || !result.data) return <MutedLine>{result.error ?? "Loading plugin…"}</MutedLine>;
  const entry = result.data;
  return (
    <DetailLayout
      back="discover"
      header={
        <DetailHeader
          name={entry.displayName}
          iconUrl={entry.iconUrl}
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
      {entry.kind === "codex" ? (
        <DetailSection title="Connection">
          {entry.authPolicy === "ON_USE" ? (
            <MutedLine>Connects the first time Codex uses it</MutedLine>
          ) : null}
          <GroupsCard
            label="Apps"
            groups={[
              {
                label: "Apps",
                rows: entry.apps.map((app) => ({
                  key: app.name,
                  name: app.name,
                  detail: app.connected ? (
                    "Connected"
                  ) : !app.enabled ? (
                    "Disabled in Codex"
                  ) : entry.installed && app.installUrl ? (
                    <ProviderAppConnect
                      provider={provider}
                      pluginId={entry.id}
                      app={app}
                      disabled={Boolean(entry.disabledReason)}
                    />
                  ) : (
                    "Not connected"
                  ),
                })),
              },
            ]}
          />
        </DetailSection>
      ) : null}
      <DetailSection title="Includes">
        <GroupsCard
          label="Parts"
          groups={entry.includes.map((name) => ({ label: name, rows: [{ key: name, name }] }))}
        />
        {!entry.includes.length ? (
          <MutedLine>Contents are available after the plugin is cloned.</MutedLine>
        ) : null}
      </DetailSection>
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
    <ExtensionsPage>
      <StoreDetail key={JSON.stringify(props)} {...props} />
    </ExtensionsPage>
  );
}
