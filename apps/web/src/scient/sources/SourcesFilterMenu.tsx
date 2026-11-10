import { scientSourceTagCounts, scientSourceTagKey } from "@scientfactory/scient-sources";
import type { ScientSourcesOverviewResult } from "@t3tools/contracts";
import {
  FileTextIcon,
  FolderIcon,
  LayersIcon,
  ListFilterIcon,
  SearchIcon,
  ShapesIcon,
  TagIcon,
} from "lucide-react";
import { useState } from "react";

import { Button } from "../../components/ui/button";
import {
  Menu,
  MenuCheckboxItem,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSearchInput,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "../../components/ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../components/ui/tooltip";
import { SCIENT_SOURCE_TYPE_LABELS } from "./sourceLabels";
import type { SourcesNameRequest } from "./SourcesNameDialog";
import type { SourcesOrganize } from "./useSourcesOrganize";

type SourceSummary = ScientSourcesOverviewResult["records"][number];

const ALL = "all";

function Count(props: { readonly value: number }) {
  return (
    <span className="ms-auto shrink-0 ps-3 text-xs text-muted-foreground tabular-nums">
      {props.value}
    </span>
  );
}

function SubmenuValue(props: { readonly children: string }) {
  return (
    <span className="min-w-0 max-w-32 truncate text-xs text-muted-foreground">
      {props.children}
    </span>
  );
}

function TagChoices(props: {
  readonly organize: SourcesOrganize;
  readonly tags: ReadonlyArray<{ readonly tag: string; readonly count: number }>;
}) {
  const [query, setQuery] = useState("");
  const selected = new Set((props.organize.filter.tags ?? []).map(scientSourceTagKey));
  const needle = query.trim().toLocaleLowerCase();
  const visible = props.tags
    .filter((entry) => !needle || entry.tag.toLocaleLowerCase().includes(needle))
    .slice(0, 50);
  return (
    <>
      {props.tags.length > 8 ? (
        <MenuSearchInput
          autoFocus
          value={query}
          onChange={(event) => setQuery(event.currentTarget.value)}
          placeholder="Search tags"
          aria-label="Search tags"
        />
      ) : null}
      {visible.length === 0 ? (
        <MenuItem disabled>{props.tags.length === 0 ? "No tags yet" : "No matching tags"}</MenuItem>
      ) : null}
      {visible.map((entry) => (
        <MenuCheckboxItem
          key={scientSourceTagKey(entry.tag)}
          checked={selected.has(scientSourceTagKey(entry.tag))}
          onCheckedChange={() => props.organize.toggleTag(entry.tag)}
        >
          <span className="flex min-w-0 items-center gap-2">
            <span className="min-w-0 flex-1 truncate">{entry.tag}</span>
            <Count value={entry.count} />
          </span>
        </MenuCheckboxItem>
      ))}
    </>
  );
}

/** One menu for every way of narrowing the list: collection, tags, type, PDF and saved searches. */
export function SourcesFilterMenu(props: {
  readonly organize: SourcesOrganize;
  readonly records: ReadonlyArray<SourceSummary>;
  readonly query: string;
  readonly onRequestName: (request: SourcesNameRequest) => void;
}) {
  const { organize } = props;
  const { filter, organization } = organize;
  const tags = scientSourceTagCounts(props.records);
  const types = [...new Set(props.records.map((record) => record.type))];
  const selectedTagCount = filter.tags?.length ?? 0;
  const canSave = organize.filterActive || props.query.trim().length > 0;
  const newCollection = () =>
    props.onRequestName({
      title: "New collection",
      label: "Collection name",
      initialName: "",
      action: "Create",
      onSubmit: async (name) => {
        const collection = await organize.createCollection(name);
        if (collection) organize.showCollection(collection.collectionId);
        return collection !== null;
      },
    });
  const saveSearch = () =>
    props.onRequestName({
      title: "Save search",
      label: "Search name",
      initialName: organize.savedSearch?.name ?? "",
      action: "Save",
      onSubmit: async (name) => (await organize.saveSearch(name)) !== null,
    });

  return (
    <Menu>
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger
              render={
                <Button
                  type="button"
                  size="icon-xs"
                  variant="ghost"
                  className="shrink-0"
                  aria-label="Filter sources"
                />
              }
            />
          }
        >
          <ListFilterIcon />
        </TooltipTrigger>
        <TooltipPopup>Filter sources</TooltipPopup>
      </Tooltip>
      <MenuPopup align="end" side="bottom" className="min-w-52">
        <MenuSub>
          <MenuSubTrigger>
            <FolderIcon aria-hidden className="size-3.5" />
            <span className="flex-1">Collection</span>
            <SubmenuValue>{organize.collection?.name ?? "All"}</SubmenuValue>
          </MenuSubTrigger>
          <MenuSubPopup>
            <MenuRadioGroup
              value={organize.collection?.collectionId ?? ALL}
              onValueChange={(value) =>
                organize.showCollection(value === ALL ? undefined : String(value))
              }
            >
              <MenuRadioItem value={ALL}>
                <span className="flex min-w-0 items-center gap-2">
                  <LayersIcon aria-hidden className="size-3.5" />
                  All sources
                  <Count value={props.records.length} />
                </span>
              </MenuRadioItem>
              {organization.collections
                .toSorted((left, right) =>
                  left.name.localeCompare(right.name, undefined, { sensitivity: "base" }),
                )
                .map((collection) => (
                  <MenuRadioItem key={collection.collectionId} value={collection.collectionId}>
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="min-w-0 flex-1 truncate">{collection.name}</span>
                      <Count value={collection.sourceIds.length} />
                    </span>
                  </MenuRadioItem>
                ))}
            </MenuRadioGroup>
            <MenuSeparator />
            <MenuItem onClick={newCollection}>New collection…</MenuItem>
          </MenuSubPopup>
        </MenuSub>
        <MenuSub>
          <MenuSubTrigger>
            <TagIcon aria-hidden className="size-3.5" />
            <span className="flex-1">Tags</span>
            <SubmenuValue>
              {selectedTagCount === 0 ? "Any" : `${selectedTagCount} selected`}
            </SubmenuValue>
          </MenuSubTrigger>
          <MenuSubPopup>
            <TagChoices organize={organize} tags={tags} />
          </MenuSubPopup>
        </MenuSub>
        <MenuSub>
          <MenuSubTrigger>
            <ShapesIcon aria-hidden className="size-3.5" />
            <span className="flex-1">Type</span>
            <SubmenuValue>
              {filter.type ? SCIENT_SOURCE_TYPE_LABELS[filter.type] : "Any"}
            </SubmenuValue>
          </MenuSubTrigger>
          <MenuSubPopup>
            <MenuRadioGroup
              value={filter.type ?? ALL}
              onValueChange={(value) => {
                const type = types.find((entry) => entry === value);
                organize.setFilter({ ...filter, type });
              }}
            >
              <MenuRadioItem value={ALL}>Any type</MenuRadioItem>
              {types.map((type) => (
                <MenuRadioItem key={type} value={type}>
                  {SCIENT_SOURCE_TYPE_LABELS[type]}
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
          </MenuSubPopup>
        </MenuSub>
        <MenuSub>
          <MenuSubTrigger>
            <FileTextIcon aria-hidden className="size-3.5" />
            <span className="flex-1">PDF</span>
            <SubmenuValue>
              {filter.hasPdf === undefined ? "Any" : filter.hasPdf ? "With PDF" : "Without PDF"}
            </SubmenuValue>
          </MenuSubTrigger>
          <MenuSubPopup>
            <MenuRadioGroup
              value={filter.hasPdf === undefined ? ALL : filter.hasPdf ? "yes" : "no"}
              onValueChange={(value) =>
                organize.setFilter({
                  ...filter,
                  hasPdf: value === "yes" ? true : value === "no" ? false : undefined,
                })
              }
            >
              <MenuRadioItem value={ALL}>Any</MenuRadioItem>
              <MenuRadioItem value="yes">With PDF</MenuRadioItem>
              <MenuRadioItem value="no">Without PDF</MenuRadioItem>
            </MenuRadioGroup>
          </MenuSubPopup>
        </MenuSub>
        <MenuSeparator />
        <MenuSub>
          <MenuSubTrigger>
            <SearchIcon aria-hidden className="size-3.5" />
            <span className="flex-1">Saved searches</span>
          </MenuSubTrigger>
          <MenuSubPopup>
            {organization.savedSearches.length === 0 ? (
              <MenuItem disabled>No saved searches</MenuItem>
            ) : (
              organization.savedSearches
                .toSorted((left, right) =>
                  left.name.localeCompare(right.name, undefined, { sensitivity: "base" }),
                )
                .map((search) => (
                  <MenuItem
                    key={search.searchId}
                    variant={
                      organize.savedSearch?.searchId === search.searchId ? "selected" : "default"
                    }
                    onClick={() => organize.applySavedSearch(search.searchId)}
                  >
                    <span className="min-w-0 truncate">{search.name}</span>
                  </MenuItem>
                ))
            )}
            <MenuSeparator />
            <MenuItem disabled={!canSave} onClick={saveSearch}>
              Save this search…
            </MenuItem>
          </MenuSubPopup>
        </MenuSub>
        {organization.issue ? <MenuItem disabled>{organization.issue}</MenuItem> : null}
      </MenuPopup>
    </Menu>
  );
}
