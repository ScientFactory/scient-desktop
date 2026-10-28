import type {
  DiscoverEntry,
  DiscoverSearchInput,
  ExtensionCategory,
  ProviderStoreEntry,
  ServerProvider,
} from "@t3tools/contracts";
import { Link, Navigate } from "@tanstack/react-router";
import { SearchIcon } from "lucide-react";
import { useContext, useState } from "react";

import {
  SettingsSearchTarget,
  useSettingsSearchTargetId,
} from "../../components/settings/settingsLayout";
import { searchableSetting } from "../../components/settings/settingsSearch";
import { Button } from "../../components/ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "../../components/ui/input-group";
import { useDebouncedValue } from "../../state/queries";
import { useEnvironmentQuery } from "../../state/query";
import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { AsyncResult, Atom } from "effect/reactivity";
import * as Option from "effect/Option";
import { ProviderStoreShelves, StoreInstall, storeAvailable } from "./ProviderStorePages";
import { ConnectorItem, EntryItem, PluginItem } from "./ExtensionItems";
import {
  BackLink,
  ExtensionsPage,
  ExtensionsSection,
  ExtensionsTopBar,
  MutedLine,
  SECTION_TITLE_LINK_CLASS,
  SectionTitleChevron,
  useExtensionsEnvironment,
} from "./ExtensionsPage";
import { ExtensionGrid, ExtensionRow } from "./ExtensionRow";
import { extensionsDiscoverPage, extensionsProviderStorePage } from "./extensionsState";
import {
  catalogEntries,
  type ExtensionKind,
  isExtensionCategory,
  matchesQuery,
  showsKind,
} from "./extensionsView";
import { AgentSkills } from "../skills/AgentSkills";
import { ScientSkillsLibrary, ScientSkillsTitle } from "../skills/ScientSkillsLibrary";

/** Search results that live on Installed; Discover forwards them there. */
const INSTALLED_SEARCH_TARGETS: Readonly<Record<string, true>> = {
  [searchableSetting("extensions-connected-services").id]: true,
  [searchableSetting("extensions-scient-plugins").id]: true,
  [searchableSetting("extensions-provider-plugins").id]: true,
};

function SearchField({
  label,
  value,
  onChange,
}: {
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
}) {
  return (
    // A pill: the control radius is a theme variable the input group reads.
    <div className="w-full [--control-radius:9999px] sm:w-72">
      <InputGroup>
        <InputGroupAddon>
          <SearchIcon aria-hidden />
        </InputGroupAddon>
        <InputGroupInput
          type="search"
          aria-label={label}
          placeholder={label}
          value={value}
          onChange={(event) => onChange(event.currentTarget.value)}
        />
      </InputGroup>
    </div>
  );
}

const NO_NAMES: ReadonlySet<string> = new Set();

/**
 * One Discover page, then the pages after it. Each page skips names an earlier
 * page (or `seen`) already listed, so an entry appears once.
 */
function DiscoverResultsPage({
  input,
  cursors,
  seen,
  hide,
  pendingLabel,
  onMore,
}: {
  readonly input: Omit<DiscoverSearchInput, "cursor">;
  /** This page's cursor first (undefined for the first page), then the later pages'. */
  readonly cursors: readonly [string | undefined, ...ReadonlyArray<string>];
  readonly seen: ReadonlySet<string>;
  readonly hide: ((entry: DiscoverEntry) => boolean) | undefined;
  readonly pendingLabel: string;
  readonly onMore: (cursor: string) => void;
}) {
  const { environmentId } = useExtensionsEnvironment();
  const [cursor, ...later] = cursors;
  const page = useEnvironmentQuery(
    extensionsDiscoverPage({ environmentId, input: { ...input, ...(cursor ? { cursor } : {}) } }),
  );
  if (page.error) {
    return (
      <li className="col-span-full px-2" data-discover-error={input.scope}>
        <MutedLine>{page.error}</MutedLine>
      </li>
    );
  }
  if (page.data === null) {
    return (
      <li className="col-span-full px-2" data-discover-pending={input.scope}>
        <MutedLine>{pendingLabel}</MutedLine>
      </li>
    );
  }
  const listed = new Set(seen);
  const shown: DiscoverEntry[] = [];
  for (const entry of page.data.entries) {
    if (listed.has(entry.name)) continue;
    listed.add(entry.name);
    if (hide?.(entry) !== true) shown.push(entry);
  }
  const nextCursor = page.data.nextCursor;
  const [nextPage, ...afterNext] = later;
  return (
    <>
      {page.data.message ? (
        <li className="col-span-full px-2">
          <MutedLine>{page.data.message}</MutedLine>
        </li>
      ) : null}
      {!shown.length && !nextCursor ? (
        <li className="col-span-full px-2">
          <MutedLine>No more matches.</MutedLine>
        </li>
      ) : null}
      {shown.map((entry) => (
        <EntryItem key={entry.name} entry={entry} />
      ))}
      {nextPage !== undefined ? (
        <DiscoverResultsPage
          key={nextPage}
          input={input}
          cursors={[nextPage, ...afterNext]}
          seen={listed}
          hide={hide}
          pendingLabel={pendingLabel}
          onMore={onMore}
        />
      ) : nextCursor ? (
        <li className="col-span-full px-2 pt-2">
          <Button
            size="xs"
            variant="ghost-muted"
            className="-ms-2"
            onClick={() => onMore(nextCursor)}
          >
            {input.category ? "Show more" : "Load more"}
          </Button>
        </li>
      ) : null}
    </>
  );
}

/**
 * Discover pages, one query per cursor, appended in order. Renders list items
 * so callers can put them in the same grid as their own rows. Names in `seen`
 * are listed elsewhere and skipped.
 */
function DiscoverPager({
  input,
  seen = NO_NAMES,
  hide,
  pendingLabel = "Loading…",
}: {
  readonly input: Omit<DiscoverSearchInput, "cursor">;
  readonly seen?: ReadonlySet<string>;
  readonly hide?: (entry: DiscoverEntry) => boolean;
  readonly pendingLabel?: string;
}) {
  const inputKey = JSON.stringify(input);
  const [pages, setPages] = useState<{
    readonly inputKey: string;
    readonly cursors: ReadonlyArray<string>;
  }>({ inputKey, cursors: [] });
  let cursors = pages.cursors;
  if (pages.inputKey !== inputKey) {
    cursors = [];
    setPages({ inputKey, cursors });
  }
  return (
    <DiscoverResultsPage
      key={inputKey}
      input={input}
      cursors={[undefined, ...cursors]}
      seen={seen}
      hide={hide}
      pendingLabel={pendingLabel}
      onMore={(next) =>
        setPages((current) =>
          current.inputKey === inputKey && !current.cursors.includes(next)
            ? { inputKey, cursors: [...current.cursors, next] }
            : current,
        )
      }
    />
  );
}

function DiscoverHome({ kind }: { readonly kind: ExtensionKind | undefined }) {
  const { environmentId, catalog, catalogError, inventory, providers } = useExtensionsEnvironment();
  const builtIns = inventory?.plugins.filter((plugin) => plugin.origin === "built-in") ?? [];
  return (
    <SettingsSearchTarget
      id={searchableSetting("extensions-discover").id}
      className="grid gap-10 outline-none"
    >
      {!showsKind(kind, "plugins") ? null : catalogError ? (
        <MutedLine>{catalogError}</MutedLine>
      ) : catalog === null ? (
        <MutedLine>Loading…</MutedLine>
      ) : (
        catalog.sections.map((section) => (
          <ExtensionsSection
            key={section.category}
            title={
              <Link
                to="/settings/extensions/category/$category"
                params={{ category: section.category }}
                className={SECTION_TITLE_LINK_CLASS}
              >
                {section.title}
                <SectionTitleChevron />
              </Link>
            }
          >
            <ExtensionGrid label={section.title}>
              {section.entries.map((entry) => (
                <EntryItem key={entry.name} entry={entry} />
              ))}
            </ExtensionGrid>
          </ExtensionsSection>
        ))
      )}
      {showsKind(kind, "plugins") && builtIns.length > 0 ? (
        <ExtensionsSection title="Built into Scient">
          <ExtensionGrid label="Built into Scient">
            {builtIns.map((plugin) => (
              <PluginItem key={plugin.pluginId} plugin={plugin} />
            ))}
          </ExtensionGrid>
        </ExtensionsSection>
      ) : null}
      {showsKind(kind, "plugins") ? <ProviderStoreShelves /> : null}
      {showsKind(kind, "skills") ? (
        <>
          <ExtensionsSection title={<ScientSkillsTitle />}>
            <ScientSkillsLibrary environmentId={environmentId} providers={providers} />
          </ExtensionsSection>
          <ExtensionsSection title="Agent skills">
            <AgentSkills environmentId={environmentId} providers={providers} />
          </ExtensionsSection>
        </>
      ) : null}
    </SettingsSearchTarget>
  );
}

/**
 * Installed, built-in and catalog matches at once; the registry's, which can
 * be slow or unreachable, follow when they arrive and never move the others.
 * The registry also lists catalog servers (in catalog shape, same name); the
 * catalog's rows win.
 */
function DiscoverSearchResults({
  query,
  kind,
}: {
  readonly query: string;
  readonly kind: ExtensionKind | undefined;
}) {
  const { environmentId, catalog, inventory } = useExtensionsEnvironment();
  const curated = useEnvironmentQuery(
    extensionsDiscoverPage({ environmentId, input: { scope: "curated", query } }),
  );
  const connectors = (showsKind(kind, "plugins") ? (inventory?.connectors ?? []) : []).filter(
    (connector) =>
      matchesQuery(query, [
        connector.displayName,
        connector.serverName,
        connector.description,
        connector.url,
      ]),
  );
  const plugins = (showsKind(kind, "plugins") ? (inventory?.plugins ?? []) : []).filter((plugin) =>
    matchesQuery(query, [plugin.displayName, plugin.description, plugin.publisher]),
  );
  const shownConnectorIds = new Set(connectors.map((connector) => connector.connectorId));
  const installedHere = (entry: DiscoverEntry) =>
    entry.installedConnectorId !== undefined && shownConnectorIds.has(entry.installedConnectorId);
  // Until the catalog answers, which registry rows repeat it is unknown.
  const curatedPending = curated.data === null && !curated.error;
  const curatedNames = new Set(curated.data?.entries.map((entry) => entry.name));
  return (
    <ExtensionGrid label="Search results">
      {connectors.map((connector) => (
        <ConnectorItem
          key={connector.connectorId}
          connector={connector}
          entry={catalogEntries(catalog).find(
            (entry) => entry.installedConnectorId === connector.connectorId,
          )}
        />
      ))}
      {plugins.map((plugin) => (
        <PluginItem key={plugin.pluginId} plugin={plugin} />
      ))}
      {showsKind(kind, "plugins") ? (
        <>
          <DiscoverPager input={{ scope: "curated", query }} hide={installedHere} />
          <DiscoverPager
            input={{ scope: "registry", query }}
            seen={curatedNames}
            hide={curatedPending ? () => true : installedHere}
            pendingLabel="Searching the MCP Registry…"
          />
        </>
      ) : null}
    </ExtensionGrid>
  );
}

function SkillSearchResults({ query }: { readonly query: string }) {
  const { environmentId, providers } = useExtensionsEnvironment();
  return (
    <>
      <ExtensionsSection title={<ScientSkillsTitle />}>
        <ScientSkillsLibrary environmentId={environmentId} providers={providers} query={query} />
      </ExtensionsSection>
      <ExtensionsSection title="Agent skills">
        <AgentSkills environmentId={environmentId} providers={providers} query={query} />
      </ExtensionsSection>
    </>
  );
}

function Discover({ kind }: { readonly kind: ExtensionKind | undefined }) {
  const searchTargetId = useSettingsSearchTargetId();
  const [search, setSearch] = useState("");
  const query = useDebouncedValue(search.trim(), 300);
  if (searchTargetId !== null && INSTALLED_SEARCH_TARGETS[searchTargetId] === true) {
    return <Navigate to="/settings/extensions/installed" hash={searchTargetId} replace />;
  }
  return (
    <>
      <SettingsSearchTarget id={searchableSetting("extensions").id} className="outline-none">
        <ExtensionsTopBar tab="discover" kind={kind}>
          <SearchField
            label={kind === "skills" ? "Search skills" : "Search plugins"}
            value={search}
            onChange={setSearch}
          />
        </ExtensionsTopBar>
      </SettingsSearchTarget>
      {query ? (
        <>
          {kind === "skills" ? null : <DiscoverSearchResults query={query} kind={kind} />}
          {showsKind(kind, "plugins") ? <ProviderStoreShelves query={query} /> : null}
          {showsKind(kind, "skills") ? <SkillSearchResults query={query} /> : null}
        </>
      ) : (
        <DiscoverHome kind={kind} />
      )}
    </>
  );
}

/** Settings ▸ Extensions: curated sections, built-ins, and search across everything. */
export function DiscoverPage({ kind }: { readonly kind?: ExtensionKind | undefined }) {
  return (
    <ExtensionsPage>
      <Discover kind={kind} />
    </ExtensionsPage>
  );
}

function canonicalUrl(value: string): string {
  try {
    const url = new URL(value);
    url.hash = "";
    return url.href.replace(/\/$/u, "");
  } catch {
    return value;
  }
}
function storeMatches(entry: ProviderStoreEntry, curated: DiscoverEntry) {
  return (
    curated.agentStores?.codex === entry.name ||
    curated.name === entry.id ||
    curated.name === entry.name ||
    curated.title?.toLowerCase() === entry.displayName.toLowerCase() ||
    (entry.website !== undefined &&
      [curated.websiteUrl, ...curated.remotes.map((remote) => remote.url)].some(
        (url) => url !== undefined && canonicalUrl(url) === canonicalUrl(entry.website!),
      ))
  );
}

function CategoryContents({
  category,
  query,
}: {
  readonly category: ExtensionCategory;
  readonly query: string;
}) {
  const { environmentId, providers } = useExtensionsEnvironment();
  const registry = useContext(RegistryContext);
  const picks = useEnvironmentQuery(
    extensionsDiscoverPage({ environmentId, input: { scope: "curated", category } }),
  );
  const targets = providers.filter(
    (provider) =>
      category !== "featured" &&
      storeAvailable(provider) &&
      ["codex", "claudeAgent", "scient"].includes(provider.driver),
  );
  const [more, setMore] = useState<Readonly<Record<string, readonly string[]>>>({});
  const storeAtom = Atom.make((get) =>
    targets.flatMap((provider) =>
      [undefined, ...(more[provider.instanceId] ?? [])].map((cursor) => {
        const atom = extensionsProviderStorePage({
          environmentId,
          input: {
            instanceId: provider.instanceId,
            category,
            ...(query ? { query } : {}),
            limit: 50,
            ...(cursor ? { cursor } : {}),
          },
        });
        return { provider, atom, cursor, result: get(atom) };
      }),
    ),
  );
  const pages = useAtomValue(storeAtom);
  const stores: Array<{
    provider: ServerProvider;
    entry: ProviderStoreEntry;
    refresh: () => void;
  }> = [];
  const seen = new Set<string>();
  for (const { provider, atom, result } of pages) {
    const data = Option.getOrNull(AsyncResult.value(result));
    for (const entry of data?.entries ?? []) {
      const key = `${entry.kind}:${entry.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      stores.push({ provider, entry, refresh: () => registry.refresh(atom) });
    }
  }
  const curated = picks.data?.entries ?? [];
  const visiblePicks = curated.filter((entry) =>
    matchesQuery(query, [entry.title, entry.description, entry.name]),
  );
  const ready = picks.data !== null || picks.error !== null;
  const storeReady = pages.every(({ result }) => !AsyncResult.isInitial(result));
  return (
    <>
      <ExtensionsSection
        title="Scient’s picks"
        action={
          ready ? (
            <span className="text-xs text-muted-foreground">
              {visiblePicks.length} of {curated.length}
            </span>
          ) : undefined
        }
      >
        {picks.error ? (
          <MutedLine>{picks.error}</MutedLine>
        ) : !ready ? (
          <MutedLine>Loading picks…</MutedLine>
        ) : null}
        <ExtensionGrid label="Scient’s picks">
          {visiblePicks.map((entry) => {
            const equivalents = stores.filter((store) => storeMatches(store.entry, entry));
            return equivalents.length ? (
              <li key={entry.name}>
                <ul>
                  <EntryItem entry={entry} />
                </ul>
                <div className="flex flex-wrap gap-2 px-2 ps-15">
                  {equivalents.map((store) => (
                    <Link
                      key={store.entry.id}
                      to="/settings/extensions/item/store/$instanceId/$entryId"
                      params={{ instanceId: store.provider.instanceId, entryId: store.entry.id }}
                      className="text-xs text-muted-foreground underline"
                    >
                      Also add from{" "}
                      {store.entry.kind === "codex" ? "Codex" : "Claude / Scient Agent"}’s store
                    </Link>
                  ))}
                </div>
              </li>
            ) : (
              <EntryItem key={entry.name} entry={entry} />
            );
          })}
        </ExtensionGrid>
        {ready && !visiblePicks.length ? <MutedLine>No picks match this search.</MutedLine> : null}
      </ExtensionsSection>
      {category !== "featured" ? (
        <>
          <ExtensionsSection title="From your agents’ stores">
            <ExtensionGrid label="From your agents’ stores">
              {ready
                ? stores
                    .filter(
                      ({ entry }) =>
                        !curated.some((pick) => storeMatches(entry, pick)) &&
                        matchesQuery(query, [entry.name, entry.displayName, entry.description]),
                    )
                    .map(({ provider, entry, refresh }) => (
                      <ExtensionRow
                        key={`${entry.kind}:${entry.id}`}
                        target={{
                          kind: "provider-store",
                          instanceId: provider.instanceId,
                          entryId: entry.id,
                        }}
                        name={entry.displayName}
                        iconUrl={entry.iconUrl}
                        tagline={entry.description}
                        audience={
                          entry.kind === "shared"
                            ? { layer: "shared", ownerInstanceId: provider.instanceId }
                            : {
                                layer: "agent",
                                driver: provider.driver,
                                instanceId: provider.instanceId,
                                label: "Codex",
                                reason: "Uses Codex’s own ChatGPT account",
                              }
                        }
                        trailing={
                          <StoreInstall provider={provider} entry={entry} refresh={refresh} />
                        }
                      />
                    ))
                : null}
            </ExtensionGrid>
            {!targets.length ? <MutedLine>No agent stores are available.</MutedLine> : null}
            {pages.map(({ provider, cursor, result }) => {
              const data = Option.getOrNull(AsyncResult.value(result));
              return (
                <div key={`${provider.instanceId}:${cursor ?? "first"}`}>
                  {AsyncResult.isInitial(result) ? (
                    <MutedLine>
                      Checking {provider.displayName ?? provider.driver}’s store…
                    </MutedLine>
                  ) : result._tag === "Failure" ? (
                    <MutedLine>
                      Could not read {provider.displayName ?? provider.driver}’s store.
                    </MutedLine>
                  ) : null}
                  {data?.message ? <MutedLine>{data.message}</MutedLine> : null}
                  {data?.sourceFailures?.length ? (
                    <MutedLine>Some plugin stores could not be read.</MutedLine>
                  ) : null}
                  {data && !data.total ? (
                    <MutedLine>
                      No matching plugins in {provider.displayName ?? provider.driver}’s store.
                    </MutedLine>
                  ) : null}
                  {data?.nextCursor &&
                  !(more[provider.instanceId] ?? []).includes(data.nextCursor) ? (
                    <Button
                      size="xs"
                      variant="ghost-muted"
                      onClick={() =>
                        setMore((current) => ({
                          ...current,
                          [provider.instanceId]: [
                            ...(current[provider.instanceId] ?? []),
                            data.nextCursor!,
                          ],
                        }))
                      }
                    >
                      Show more plugins
                    </Button>
                  ) : null}
                </div>
              );
            })}
          </ExtensionsSection>
          <ExtensionsSection title="More from the MCP Registry">
            <MutedLine>Not checked by Scient</MutedLine>
            <ExtensionGrid label="More from the MCP Registry">
              {ready && storeReady ? (
                <DiscoverPager
                  input={{ scope: "registry", category, ...(query ? { query } : {}) }}
                  seen={new Set(curated.map((entry) => entry.name))}
                  hide={(entry) => stores.some((store) => storeMatches(store.entry, entry))}
                  pendingLabel="Searching the MCP Registry…"
                />
              ) : null}
            </ExtensionGrid>
          </ExtensionsSection>
        </>
      ) : null}
    </>
  );
}

function Category({ category }: { readonly category: string }) {
  const { catalog } = useExtensionsEnvironment();
  const [search, setSearch] = useState("");
  const query = useDebouncedValue(search.trim(), 300);
  if (!isExtensionCategory(category))
    return (
      <>
        <BackLink to="/settings/extensions">Discover</BackLink>
        <MutedLine>This category does not exist.</MutedLine>
      </>
    );
  const section = catalog?.sections.find((candidate) => candidate.category === category);
  const title = section?.title ?? category.charAt(0).toUpperCase() + category.slice(1);
  return (
    <>
      <BackLink to="/settings/extensions">Discover</BackLink>
      <ExtensionsSection
        title={title}
        action={<SearchField label="Search this category" value={search} onChange={setSearch} />}
      >
        {section?.description ? <MutedLine>{section.description}</MutedLine> : null}
      </ExtensionsSection>
      <CategoryContents key={`${category}:${query}`} category={category} query={query} />
    </>
  );
}

export function CategoryPage({ category }: { readonly category: string }) {
  return (
    <ExtensionsPage>
      <Category category={category} />
    </ExtensionsPage>
  );
}

function AllServers() {
  const [search, setSearch] = useState("");
  const query = useDebouncedValue(search.trim(), 300);
  return (
    <>
      <BackLink to="/settings/extensions">Discover</BackLink>
      <ExtensionsSection
        title="All MCP servers"
        action={<SearchField label="Search MCP servers" value={search} onChange={setSearch} />}
      >
        <MutedLine>Remote servers from the MCP Registry.</MutedLine>
        <ExtensionGrid label="All MCP servers">
          <DiscoverPager input={query ? { scope: "registry", query } : { scope: "registry" }} />
        </ExtensionGrid>
      </ExtensionsSection>
    </>
  );
}

export function AllServersPage() {
  return (
    <ExtensionsPage>
      <AllServers />
    </ExtensionsPage>
  );
}
