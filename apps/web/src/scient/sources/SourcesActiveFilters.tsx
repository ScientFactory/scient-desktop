import { MoreHorizontal, X } from "lucide-react";

import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../../components/ui/menu";
import { LIBRARY_LABELS } from "./libraryLabels";
import { SCIENT_SOURCE_STUDY_DESIGN_LABELS, SCIENT_SOURCE_TYPE_LABELS } from "./sourceLabels";
import type { SourcesNameRequest } from "./SourcesNameDialog";
import type { SourcesOrganize } from "./useSourcesOrganize";

function FilterChip(props: { readonly label: string; readonly onRemove: () => void }) {
  return (
    <Badge variant="outline">
      <span className="max-w-40 truncate">{props.label}</span>
      <Button
        type="button"
        size="icon-micro"
        variant="ghost-muted"
        aria-label={`Remove filter: ${props.label}`}
        onClick={props.onRemove}
      >
        <X />
      </Button>
    </Badge>
  );
}

/** The narrowing in force, shown only while something narrows the list. */
export function SourcesActiveFilters(props: {
  readonly organize: SourcesOrganize;
  readonly matchCount: number;
  readonly onRequestName: (request: SourcesNameRequest) => void;
}) {
  const { organize } = props;
  const { filter, collection, savedSearch } = organize;
  if (!organize.filterActive && !organize.readingFilterActive && !savedSearch) return null;
  const without = (key: keyof typeof filter) => organize.setFilter({ ...filter, [key]: undefined });
  const renameCollection = () => {
    if (!collection) return;
    props.onRequestName({
      title: "Rename collection",
      label: "Collection name",
      initialName: collection.name,
      action: "Rename",
      onSubmit: async (name) => {
        const result = await organize.organize(
          { action: "rename-collection", collectionId: collection.collectionId, name },
          "Collection was not renamed",
        );
        return result !== null && result.outcome !== "name-taken";
      },
    });
  };
  const newSubcollection = () => {
    if (!collection) return;
    props.onRequestName({
      title: `New collection in “${collection.name}”`,
      label: "Collection name",
      initialName: "",
      action: "Create",
      onSubmit: async (name) => {
        const created = await organize.createCollection(name, [], collection.collectionId);
        if (created) organize.showCollection(created.collectionId);
        return created !== null;
      },
    });
  };
  const saveSearch = () =>
    props.onRequestName({
      title: savedSearch ? "Update saved search" : "Save search",
      label: "Search name",
      initialName: savedSearch?.name ?? "",
      action: "Save",
      onSubmit: async (name) => (await organize.saveSearch(name, savedSearch?.searchId)) !== null,
    });

  return (
    <div className="mx-4 mb-1 flex shrink-0 flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
      {savedSearch ? <span className="max-w-40 truncate">{savedSearch.name}</span> : null}
      {collection ? (
        <FilterChip label={collection.name} onRemove={() => without("collectionId")} />
      ) : null}
      {(filter.tags ?? []).map((tag) => (
        <FilterChip key={tag} label={tag} onRemove={() => organize.toggleTag(tag)} />
      ))}
      {filter.type ? (
        <FilterChip
          label={SCIENT_SOURCE_TYPE_LABELS[filter.type]}
          onRemove={() => without("type")}
        />
      ) : null}
      {filter.studyDesign ? (
        <FilterChip
          label={SCIENT_SOURCE_STUDY_DESIGN_LABELS[filter.studyDesign]}
          onRemove={() => without("studyDesign")}
        />
      ) : null}
      {filter.topic ? <FilterChip label={filter.topic} onRemove={() => without("topic")} /> : null}
      {filter.hasPdf !== undefined ? (
        <FilterChip
          label={filter.hasPdf ? "With PDF" : "Without PDF"}
          onRemove={() => without("hasPdf")}
        />
      ) : null}
      {organize.reading.unread ? (
        <FilterChip
          label={LIBRARY_LABELS.unread}
          onRemove={() => organize.setReading({ ...organize.reading, unread: undefined })}
        />
      ) : null}
      {organize.reading.starred ? (
        <FilterChip
          label={LIBRARY_LABELS.starred}
          onRemove={() => organize.setReading({ ...organize.reading, starred: undefined })}
        />
      ) : null}
      <span className="ms-auto tabular-nums" aria-live="polite">
        {props.matchCount === 1 ? "1 source" : `${props.matchCount} sources`}
      </span>
      <Menu>
        <MenuTrigger
          render={
            <Button
              type="button"
              size="icon-micro"
              variant="ghost-muted"
              aria-label="Filter actions"
            />
          }
        >
          <MoreHorizontal />
        </MenuTrigger>
        <MenuPopup align="end" side="bottom">
          {collection ? (
            <>
              <MenuItem disabled={!organize.canChange} onClick={renameCollection}>
                Rename collection…
              </MenuItem>
              {collection.parentCollectionId ? null : (
                <MenuItem disabled={!organize.canChange} onClick={newSubcollection}>
                  New subcollection…
                </MenuItem>
              )}
              <MenuItem
                variant="destructive"
                disabled={!organize.canChange}
                onClick={() => void organize.deleteCollection(collection.collectionId)}
              >
                Delete collection
              </MenuItem>
              <MenuSeparator />
            </>
          ) : null}
          <MenuItem disabled={!organize.canChange} onClick={saveSearch}>
            {savedSearch ? "Update saved search…" : "Save search…"}
          </MenuItem>
          {savedSearch ? (
            <MenuItem
              variant="destructive"
              disabled={!organize.canChange}
              onClick={() => void organize.deleteSavedSearch(savedSearch.searchId)}
            >
              Delete saved search
            </MenuItem>
          ) : null}
          <MenuSeparator />
          <MenuItem onClick={organize.clearFilter}>Clear filters</MenuItem>
        </MenuPopup>
      </Menu>
    </div>
  );
}
