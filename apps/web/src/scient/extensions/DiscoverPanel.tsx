import type { DiscoverEntry, EnvironmentId } from "@t3tools/contracts";
import { useState } from "react";

import { SettingsRow, SettingsSearchTarget } from "../../components/settings/settingsLayout";
import { searchableSetting } from "../../components/settings/settingsSearch";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { useEnvironmentQuery } from "../../state/query";
import { useDebouncedValue } from "../../state/queries";
import { installableRemotes } from "./AddConnectorDialog";
import { extensionsDiscoverPage } from "./extensionsState";

function DiscoverResultsPage({
  environmentId,
  query,
  cursor,
  isLast,
  canWrite,
  onAdd,
  onMore,
}: {
  readonly environmentId: EnvironmentId;
  readonly query: string;
  readonly cursor: string | undefined;
  readonly isLast: boolean;
  readonly canWrite: boolean;
  readonly onAdd: (entry: DiscoverEntry) => void;
  readonly onMore: (cursor: string) => void;
}) {
  const page = useEnvironmentQuery(
    extensionsDiscoverPage({
      environmentId,
      input: { ...(query ? { query } : {}), ...(cursor ? { cursor } : {}) },
    }),
  );
  if (page.error) {
    return <SettingsRow title="Registry unavailable" description={page.error} />;
  }
  if (page.data === null) {
    return <SettingsRow title="Searching the MCP Registry" />;
  }
  if (page.data.entries.length === 0 && cursor === undefined) {
    return (
      <SettingsRow
        title="No servers found"
        description={query ? `Nothing matches “${query}”.` : undefined}
      />
    );
  }
  return (
    <>
      {page.data.entries.map((entry) => {
        const canInstall = entry.installable && installableRemotes(entry).length > 0;
        return (
          <SettingsRow
            key={`${entry.name}@${entry.version}`}
            data-discover-entry={entry.name}
            title={entry.title ?? entry.name}
            description={entry.description}
            status={
              <span className="flex flex-wrap items-center gap-1.5">
                <span className="font-mono">
                  {entry.name} {entry.version}
                </span>
                {entry.websiteUrl ? (
                  <a
                    href={entry.websiteUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="underline-offset-2 hover:underline"
                  >
                    Website
                  </a>
                ) : null}
                {!canInstall ? (
                  <span>· {entry.unsupportedReason ?? "Runs locally, not supported"}</span>
                ) : null}
              </span>
            }
            control={
              entry.installedConnectorId ? (
                <Badge variant="secondary">Added</Badge>
              ) : canInstall ? (
                <Button
                  size="xs"
                  variant="outline"
                  disabled={!canWrite}
                  onClick={() => onAdd(entry)}
                >
                  Add
                </Button>
              ) : undefined
            }
          />
        );
      })}
      {isLast && page.data.nextCursor ? (
        <div className="px-3 py-2 sm:px-4">
          <Button
            size="xs"
            variant="outline"
            onClick={() => page.data?.nextCursor && onMore(page.data.nextCursor)}
          >
            Load more
          </Button>
        </div>
      ) : null}
    </>
  );
}

/** Remote MCP servers from the official MCP Registry. Adding one creates a connector. */
export function DiscoverPanel({
  environmentId,
  canWrite,
  onAdd,
}: {
  readonly environmentId: EnvironmentId;
  readonly canWrite: boolean;
  readonly onAdd: (entry: DiscoverEntry) => void;
}) {
  const [search, setSearch] = useState("");
  const query = useDebouncedValue(search.trim(), 300);
  const [pages, setPages] = useState<{
    readonly query: string;
    readonly cursors: ReadonlyArray<string | undefined>;
  }>({ query, cursors: [undefined] });
  let cursors = pages.cursors;
  if (pages.query !== query) {
    cursors = [undefined];
    setPages({ query, cursors });
  }
  return (
    <SettingsSearchTarget
      id={searchableSetting("extensions-discover").id}
      className="grid gap-2 outline-none"
    >
      <div className="px-3 sm:px-4">
        <Input
          type="search"
          aria-label="Search MCP servers"
          placeholder="Search MCP servers"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
      </div>
      {cursors.map((cursor, index) => (
        <DiscoverResultsPage
          key={cursor ?? "first"}
          environmentId={environmentId}
          query={query}
          cursor={cursor}
          isLast={index === cursors.length - 1}
          canWrite={canWrite}
          onAdd={onAdd}
          onMore={(next) =>
            setPages((current) =>
              current.query === query && !current.cursors.includes(next)
                ? { query, cursors: [...current.cursors, next] }
                : current,
            )
          }
        />
      ))}
    </SettingsSearchTarget>
  );
}
