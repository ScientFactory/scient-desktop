import type { DiscoverEntry, DiscoverSearchInput } from "@t3tools/contracts";
import { Link, Navigate } from "@tanstack/react-router";
import { SearchIcon } from "lucide-react";
import { useState } from "react";

import {
  SettingsSearchTarget,
  useSettingsSearchTargetId,
} from "../../components/settings/settingsLayout";
import { searchableSetting } from "../../components/settings/settingsSearch";
import { InlineButton } from "../../components/ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "../../components/ui/input-group";
import { useDebouncedValue } from "../../state/queries";
import { useEnvironmentQuery } from "../../state/query";
import { ConnectorItem, EntryItem, PluginItem } from "./ExtensionItems";
import {
  BackLink,
  ExtensionsPage,
  ExtensionsSection,
  ExtensionsTopBar,
  MutedLine,
  SECTION_HEADING_CLASS,
  SECTION_TITLE_LINK_CLASS,
  SectionTitleChevron,
  useExtensionsEnvironment,
} from "./ExtensionsPage";
import { ExtensionGrid } from "./ExtensionRow";
import { extensionsDiscoverPage } from "./extensionsState";
import { catalogEntries, isExtensionCategory, matchesQuery } from "./extensionsView";

/** Search results that live on Installed; Discover forwards them there. */
const INSTALLED_SEARCH_TARGETS: Readonly<Record<string, true>> = {
  [searchableSetting("extensions-connected-services").id]: true,
  [searchableSetting("extensions-scient-plugins").id]: true,
  [searchableSetting("extensions-provider-plugins").id]: true,
};

export function SearchField({
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

function DiscoverResultsPage({
  input,
  cursor,
  isLast,
  hide,
  pendingLabel,
  onMore,
}: {
  readonly input: Omit<DiscoverSearchInput, "cursor">;
  readonly cursor: string | undefined;
  readonly isLast: boolean;
  readonly hide: ((entry: DiscoverEntry) => boolean) | undefined;
  readonly pendingLabel: string;
  readonly onMore: (cursor: string) => void;
}) {
  const { environmentId } = useExtensionsEnvironment();
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
  const nextCursor = page.data.nextCursor;
  return (
    <>
      {page.data.entries
        .filter((entry) => hide?.(entry) !== true)
        .map((entry) => (
          <EntryItem key={`${entry.name}@${entry.version}`} entry={entry} />
        ))}
      {isLast && nextCursor ? (
        <li className="col-span-full px-2 pt-2 text-sm">
          <InlineButton tone="muted" onClick={() => onMore(nextCursor)}>
            Load more
          </InlineButton>
        </li>
      ) : null}
    </>
  );
}

/**
 * Discover pages, one query per cursor, appended in order. Renders list items
 * so callers can put them in the same grid as their own rows.
 */
function DiscoverPager({
  input,
  hide,
  pendingLabel = "Loading…",
}: {
  readonly input: Omit<DiscoverSearchInput, "cursor">;
  readonly hide?: (entry: DiscoverEntry) => boolean;
  readonly pendingLabel?: string;
}) {
  const inputKey = JSON.stringify(input);
  const [pages, setPages] = useState<{
    readonly inputKey: string;
    readonly cursors: ReadonlyArray<string | undefined>;
  }>({ inputKey, cursors: [undefined] });
  let cursors = pages.cursors;
  if (pages.inputKey !== inputKey) {
    cursors = [undefined];
    setPages({ inputKey, cursors });
  }
  return cursors.map((cursor, index) => (
    <DiscoverResultsPage
      key={cursor ?? "first"}
      input={input}
      cursor={cursor}
      isLast={index === cursors.length - 1}
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
  ));
}

function DiscoverHome() {
  const { catalog, catalogError, inventory } = useExtensionsEnvironment();
  const builtIns = inventory?.plugins.filter((plugin) => plugin.origin === "built-in") ?? [];
  return (
    <SettingsSearchTarget
      id={searchableSetting("extensions-discover").id}
      className="grid gap-10 outline-none"
    >
      {catalogError ? (
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
      {builtIns.length > 0 ? (
        <ExtensionsSection title="Built into Scient">
          <ExtensionGrid label="Built into Scient">
            {builtIns.map((plugin) => (
              <PluginItem key={plugin.pluginId} plugin={plugin} />
            ))}
          </ExtensionGrid>
        </ExtensionsSection>
      ) : null}
      <h2 className={SECTION_HEADING_CLASS}>
        <Link to="/settings/extensions/all" className={SECTION_TITLE_LINK_CLASS}>
          Browse all MCP servers
          <SectionTitleChevron />
        </Link>
      </h2>
    </SettingsSearchTarget>
  );
}

/**
 * Installed, built-in and catalog matches at once; the registry's, which can
 * be slow or unreachable, follow when they arrive and never move the others.
 * The server leaves catalog servers out of the registry's list.
 */
function DiscoverSearchResults({ query }: { readonly query: string }) {
  const { catalog, inventory } = useExtensionsEnvironment();
  const connectors = (inventory?.connectors ?? []).filter((connector) =>
    matchesQuery(query, [
      connector.displayName,
      connector.serverName,
      connector.description,
      connector.url,
    ]),
  );
  const plugins = (inventory?.plugins ?? []).filter((plugin) =>
    matchesQuery(query, [plugin.displayName, plugin.description, plugin.publisher]),
  );
  const shownConnectorIds = new Set(connectors.map((connector) => connector.connectorId));
  const installedHere = (entry: DiscoverEntry) =>
    entry.installedConnectorId !== undefined && shownConnectorIds.has(entry.installedConnectorId);
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
      <DiscoverPager input={{ scope: "curated", query }} hide={installedHere} />
      <DiscoverPager
        input={{ scope: "registry", query }}
        hide={installedHere}
        pendingLabel="Searching the MCP Registry…"
      />
    </ExtensionGrid>
  );
}

function Discover() {
  const searchTargetId = useSettingsSearchTargetId();
  const [search, setSearch] = useState("");
  const query = useDebouncedValue(search.trim(), 300);
  if (searchTargetId !== null && INSTALLED_SEARCH_TARGETS[searchTargetId] === true) {
    return <Navigate to="/settings/extensions/installed" hash={searchTargetId} replace />;
  }
  return (
    <>
      <SettingsSearchTarget id={searchableSetting("extensions").id} className="outline-none">
        <ExtensionsTopBar tab="discover">
          <SearchField label="Search extensions" value={search} onChange={setSearch} />
        </ExtensionsTopBar>
      </SettingsSearchTarget>
      {query ? <DiscoverSearchResults query={query} /> : <DiscoverHome />}
    </>
  );
}

/** Settings ▸ Extensions: curated sections, built-ins, and search across everything. */
export function DiscoverPage() {
  return (
    <ExtensionsPage>
      <Discover />
    </ExtensionsPage>
  );
}

function Category({ category }: { readonly category: string }) {
  const { catalog } = useExtensionsEnvironment();
  if (!isExtensionCategory(category)) {
    return (
      <>
        <BackLink to="/settings/extensions">Discover</BackLink>
        <MutedLine>This category does not exist.</MutedLine>
      </>
    );
  }
  const section = catalog?.sections.find((candidate) => candidate.category === category);
  const title = section?.title ?? category.charAt(0).toUpperCase() + category.slice(1);
  return (
    <>
      <BackLink to="/settings/extensions">Discover</BackLink>
      <ExtensionsSection title={title}>
        {section?.description ? <MutedLine>{section.description}</MutedLine> : null}
        <ExtensionGrid label={title}>
          <DiscoverPager input={{ scope: "curated", category }} />
        </ExtensionGrid>
      </ExtensionsSection>
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
