import {
  scientSourceCategoryCounts,
  scientSourceCollectionMemberIds,
  scientSourceTagCounts,
  scientSourceTagKey,
  scientSourceTopicKey,
} from "@scientfactory/scient-sources";
import type { ScientSourcesOverviewResult } from "@t3tools/contracts";
import {
  FileTextIcon,
  FlaskConicalIcon,
  FolderIcon,
  HashIcon,
  LayersIcon,
  ListFilterIcon,
  SearchIcon,
  ShapesIcon,
  StarIcon,
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
import { ScientTooltip } from "../presentation/ScientTooltip";
import { orderedCollections } from "./collectionTree";
import { LIBRARY_LABELS } from "./libraryLabels";
import { SCIENT_SOURCE_STUDY_DESIGN_LABELS, SCIENT_SOURCE_TYPE_LABELS } from "./sourceLabels";
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

function TopicChoices(props: {
  readonly organize: SourcesOrganize;
  readonly topics: ReadonlyArray<{ readonly topic: string; readonly count: number }>;
}) {
  const [query, setQuery] = useState("");
  const { filter } = props.organize;
  const needle = query.trim().toLocaleLowerCase();
  const visible = props.topics
    .filter((entry) => !needle || entry.topic.toLocaleLowerCase().includes(needle))
    .slice(0, 50);
  const selected = filter.topic === undefined ? ALL : scientSourceTopicKey(filter.topic);
  return (
    <>
      {props.topics.length > 8 ? (
        <MenuSearchInput
          autoFocus
          value={query}
          onChange={(event) => setQuery(event.currentTarget.value)}
          placeholder="Search topics"
          aria-label="Search topics"
        />
      ) : null}
      <MenuRadioGroup
        value={selected}
        onValueChange={(value) =>
          props.organize.setFilter({
            ...filter,
            topic: props.topics.find((entry) => scientSourceTopicKey(entry.topic) === value)?.topic,
          })
        }
      >
        <MenuRadioItem value={ALL}>Any topic</MenuRadioItem>
        {visible.length === 0 ? <MenuItem disabled>No matching topics</MenuItem> : null}
        {visible.map((entry) => (
          <MenuRadioItem
            key={scientSourceTopicKey(entry.topic)}
            value={scientSourceTopicKey(entry.topic)}
          >
            <span className="flex min-w-0 items-center gap-2">
              <span className="min-w-0 flex-1 truncate">{entry.topic}</span>
              <Count value={entry.count} />
            </span>
          </MenuRadioItem>
        ))}
      </MenuRadioGroup>
    </>
  );
}

/** One menu for every way of narrowing the list: collection, tags, type, PDF and saved searches. */
export function SourcesFilterMenu(props: {
  readonly organize: SourcesOrganize;
  readonly records: ReadonlyArray<SourceSummary>;
  readonly query: string;
  readonly onRequestName: (request: SourcesNameRequest) => void;
  /** Present when reading-state filters are available. */
  readonly scopes?: ScientSourcesOverviewResult["scopes"];
}) {
  const { organize, scopes } = props;
  const { filter, organization } = organize;
  const tags = scientSourceTagCounts(props.records);
  const types = [...new Set(props.records.map((record) => record.type))];
  const categories = scientSourceCategoryCounts(props.records);
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
            <SubmenuValue>{organize.collection?.name ?? "All sources"}</SubmenuValue>
          </MenuSubTrigger>
          {/* A long name would stretch the submenu over its parent menu; it truncates instead. */}
          <MenuSubPopup className="max-w-64">
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
              {orderedCollections(organization.collections).map(({ collection, child }) => (
                // On the item, which keyboard navigation focuses, so the full name shows there too.
                <ScientTooltip key={collection.collectionId} content={collection.name}>
                  <MenuRadioItem value={collection.collectionId}>
                    <span
                      className={
                        child
                          ? "flex min-w-0 items-center gap-2 ps-4"
                          : "flex min-w-0 items-center gap-2"
                      }
                    >
                      <span className="min-w-0 flex-1 truncate">{collection.name}</span>
                      <Count
                        value={
                          scientSourceCollectionMemberIds(organization, collection.collectionId)
                            .size
                        }
                      />
                    </span>
                  </MenuRadioItem>
                </ScientTooltip>
              ))}
            </MenuRadioGroup>
            <MenuSeparator />
            <MenuItem disabled={!organize.canChange} onClick={newCollection}>
              New collection…
            </MenuItem>
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
        {categories.studyDesigns.length > 0 ? (
          <MenuSub>
            <MenuSubTrigger>
              <FlaskConicalIcon aria-hidden className="size-3.5" />
              <span className="flex-1">Study design</span>
              <SubmenuValue>
                {filter.studyDesign ? SCIENT_SOURCE_STUDY_DESIGN_LABELS[filter.studyDesign] : "Any"}
              </SubmenuValue>
            </MenuSubTrigger>
            <MenuSubPopup>
              <MenuRadioGroup
                value={filter.studyDesign ?? ALL}
                onValueChange={(value) =>
                  organize.setFilter({
                    ...filter,
                    studyDesign: categories.studyDesigns.find(
                      (entry) => entry.studyDesign === value,
                    )?.studyDesign,
                  })
                }
              >
                <MenuRadioItem value={ALL}>Any design</MenuRadioItem>
                {categories.studyDesigns.map((entry) => (
                  <MenuRadioItem key={entry.studyDesign} value={entry.studyDesign}>
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="min-w-0 flex-1 truncate">
                        {SCIENT_SOURCE_STUDY_DESIGN_LABELS[entry.studyDesign]}
                      </span>
                      <Count value={entry.count} />
                    </span>
                  </MenuRadioItem>
                ))}
              </MenuRadioGroup>
            </MenuSubPopup>
          </MenuSub>
        ) : null}
        {categories.topics.length > 0 ? (
          <MenuSub>
            <MenuSubTrigger>
              <HashIcon aria-hidden className="size-3.5" />
              <span className="flex-1">Topic</span>
              <SubmenuValue>{filter.topic ?? "Any"}</SubmenuValue>
            </MenuSubTrigger>
            <MenuSubPopup>
              <TopicChoices organize={organize} topics={categories.topics} />
            </MenuSubPopup>
          </MenuSub>
        ) : null}
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
        {scopes ? (
          <>
            <MenuSeparator />
            <MenuCheckboxItem
              checked={organize.reading.unread === true}
              onCheckedChange={(checked) =>
                organize.setReading({
                  ...organize.reading,
                  unread: checked ? true : undefined,
                })
              }
            >
              <span className="flex min-w-0 items-center gap-2">
                <span aria-hidden className="size-1.5 rounded-full bg-sky-500" />
                {LIBRARY_LABELS.unread}
              </span>
            </MenuCheckboxItem>
            <MenuCheckboxItem
              checked={organize.reading.starred === true}
              onCheckedChange={(checked) =>
                organize.setReading({
                  ...organize.reading,
                  starred: checked ? true : undefined,
                })
              }
            >
              <span className="flex min-w-0 items-center gap-2">
                <StarIcon aria-hidden className="size-3.5" />
                {LIBRARY_LABELS.starred}
              </span>
            </MenuCheckboxItem>
          </>
        ) : null}
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
            <MenuItem disabled={!canSave || !organize.canChange} onClick={saveSearch}>
              Save this search…
            </MenuItem>
          </MenuSubPopup>
        </MenuSub>
        {organization.issue ? <MenuItem disabled>{organization.issue}</MenuItem> : null}
      </MenuPopup>
    </Menu>
  );
}
