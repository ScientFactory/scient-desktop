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
import { useActionLock } from "./extensionActions";
import { ActionFeedback } from "./ExtensionItems";
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
  const { environmentId } = useExtensionsEnvironment();
  const allowed = useAtomValue(actOnProviderPlugin.permissionAtom(environmentId));
  const act = useAtomCommand(actOnProviderPlugin);
  const lock = useActionLock(JSON.stringify(["store", provider.instanceId, entry.id]));
  return (
    <>
      <Button
        size="sm"
        variant="ghost-primary"
        disabled={!allowed || lock.locked || entry.installed || Boolean(entry.disabledReason)}
        onClick={() =>
          void lock.run("install", async () => {
            const result = await act({
              environmentId,
              input: {
                instanceId: provider.instanceId,
                action: { type: "install", entryId: entry.id },
              },
            });
            refresh();
            return result;
          })
        }
      >
        {lock.busy
          ? "Installing…"
          : entry.installed
            ? "Installed"
            : provider.driver === "claudeAgent"
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
        !(
          preview &&
          provider.driver === "scient" &&
          providers.some((item) => item.enabled && item.driver === "claudeAgent") &&
          entry.marketplace === "claude-plugins-official"
        ),
    ) ?? [];
  const hasClaude = providers.some((item) => item.enabled && item.driver === "claudeAgent");
  return (
    <>
      {page.error ? (
        <MutedLine>{page.error}</MutedLine>
      ) : page.data === null ? (
        <MutedLine>Loading plugins…</MutedLine>
      ) : (
        <>
          {page.data.message ? <MutedLine>{page.data.message}</MutedLine> : null}
          {page.data.canAddOfficialStore && !hasClaude ? (
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
                    ? { layer: "shared" }
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
    (provider) => provider.enabled && provider.driver === "claudeAgent",
  );
  const scient = providers.filter((provider) => provider.enabled && provider.driver === "scient");
  const targets = [...claude, ...scient];
  const primary = targets[0];
  return primary ? (
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
  ) : null;
}

function Store({ instanceId }: { readonly instanceId: string }) {
  const { providers } = useExtensionsEnvironment();
  const provider = providers.find((item) => item.instanceId === instanceId);
  const [query, setQuery] = useState("");
  return (
    <>
      <BackLink to="/settings/extensions">Discover</BackLink>
      <ExtensionsSection title="Plugins for Claude and Scient Agent">
        <Input
          aria-label="Search plugins"
          placeholder="Search plugins"
          value={query}
          onChange={(event) => setQuery(event.currentTarget.value)}
        />
        {provider ? (
          <StoreResults key={query} provider={provider} query={query} preview={false} />
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
                  ? { layer: "shared" }
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
