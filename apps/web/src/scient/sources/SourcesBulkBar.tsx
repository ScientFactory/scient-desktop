import {
  scientSourceTagCounts,
  scientSourceTagKey,
  type ScientSourceType,
} from "@scientfactory/scient-sources";
import type { ScientSourcesOverviewResult } from "@t3tools/contracts";
import { FolderIcon, ShapesIcon, TagIcon, Trash2, X } from "lucide-react";
import { useState } from "react";

import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../../components/ui/alert-dialog";
import { Button } from "../../components/ui/button";
import { Checkbox } from "../../components/ui/checkbox";
import {
  Menu,
  MenuCheckboxItem,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from "../../components/ui/menu";
import { SCIENT_SOURCE_TYPE_LABELS } from "./sourceLabels";
import type { SourcesNameRequest } from "./SourcesNameDialog";
import type { SourcesOrganize } from "./useSourcesOrganize";

type SourceSummary = ScientSourcesOverviewResult["records"][number];

// "Other" needs its own wording per source, so it stays an edit of one source.
const BULK_TYPES = (Object.keys(SCIENT_SOURCE_TYPE_LABELS) as ScientSourceType[]).filter(
  (type) => type !== "other",
);

/** Replaces the search row while sources are selected. */
export function SourcesBulkBar(props: {
  readonly organize: SourcesOrganize;
  readonly records: ReadonlyArray<SourceSummary>;
  readonly visibleSourceIds: ReadonlyArray<string>;
  readonly onRequestName: (request: SourcesNameRequest) => void;
  readonly onRemove: (records: ReadonlyArray<SourceSummary>) => Promise<void>;
}) {
  const { organize } = props;
  const [confirmingRemoval, setConfirmingRemoval] = useState(false);
  const [removing, setRemoving] = useState(false);
  const selected = props.records.filter((record) => organize.selection.has(record.sourceId));
  const sourceIds = selected.map((record) => record.sourceId);
  const count = sourceIds.length;
  const allVisibleSelected =
    props.visibleSourceIds.length > 0 &&
    props.visibleSourceIds.every((sourceId) => organize.selection.has(sourceId));
  const tags = scientSourceTagCounts(props.records).slice(0, 40);
  const tagCoverage = new Map(
    scientSourceTagCounts(selected).map((entry) => [scientSourceTagKey(entry.tag), entry.count]),
  );
  const busy = organize.pending || removing;

  const addTag = () =>
    props.onRequestName({
      title: count === 1 ? "Add a tag" : `Add a tag to ${count} sources`,
      label: "Tag",
      initialName: "",
      action: "Add",
      onSubmit: async (tag) =>
        (await organize.bulk({ sourceIds, addTags: [tag] }, "Tag was not added")) !== null,
    });
  const newCollection = () =>
    props.onRequestName({
      title: "New collection",
      label: "Collection name",
      initialName: "",
      action: "Create",
      onSubmit: async (name) => (await organize.createCollection(name, sourceIds)) !== null,
    });

  return (
    <div className="mt-2 mb-1 ml-3 mr-4 flex min-h-8 shrink-0 items-center gap-1 text-sm">
      <Checkbox
        aria-label={allVisibleSelected ? "Clear selection" : "Select all shown sources"}
        checked={allVisibleSelected}
        indeterminate={!allVisibleSelected && count > 0}
        onCheckedChange={() =>
          allVisibleSelected
            ? organize.clearSelection()
            : organize.setSelection([...organize.selection, ...props.visibleSourceIds])
        }
      />
      <span className="ms-2 min-w-0 flex-1 truncate text-muted-foreground tabular-nums">
        {count} selected
      </span>
      <Menu>
        <MenuTrigger
          render={<Button type="button" size="xs" variant="ghost" disabled={busy || count === 0} />}
        >
          <TagIcon />
          Tag
        </MenuTrigger>
        <MenuPopup align="end" side="bottom" className="min-w-48">
          {tags.map((entry) => {
            const covered = tagCoverage.get(scientSourceTagKey(entry.tag)) ?? 0;
            return (
              <MenuCheckboxItem
                key={scientSourceTagKey(entry.tag)}
                checked={covered === count}
                onCheckedChange={() =>
                  void organize.bulk(
                    covered === count
                      ? { sourceIds, removeTags: [entry.tag] }
                      : { sourceIds, addTags: [entry.tag] },
                    "Tags were not changed",
                  )
                }
              >
                <span className="min-w-0 truncate">{entry.tag}</span>
              </MenuCheckboxItem>
            );
          })}
          {tags.length > 0 ? <MenuSeparator /> : null}
          <MenuItem onClick={addTag}>New tag…</MenuItem>
        </MenuPopup>
      </Menu>
      <Menu>
        <MenuTrigger
          render={<Button type="button" size="xs" variant="ghost" disabled={busy || count === 0} />}
        >
          <FolderIcon />
          Collection
        </MenuTrigger>
        <MenuPopup align="end" side="bottom" className="min-w-48">
          {organize.organization.collections.map((collection) => {
            const members = new Set(collection.sourceIds);
            const inAll = sourceIds.every((sourceId) => members.has(sourceId));
            return (
              <MenuCheckboxItem
                key={collection.collectionId}
                checked={inAll}
                onCheckedChange={() =>
                  void organize.bulk(
                    inAll
                      ? { sourceIds, removeFromCollectionIds: [collection.collectionId] }
                      : { sourceIds, addToCollectionIds: [collection.collectionId] },
                    "Collection was not changed",
                  )
                }
              >
                <span className="min-w-0 truncate">{collection.name}</span>
              </MenuCheckboxItem>
            );
          })}
          {organize.organization.collections.length > 0 ? <MenuSeparator /> : null}
          <MenuItem onClick={newCollection}>New collection…</MenuItem>
        </MenuPopup>
      </Menu>
      <Menu>
        <MenuTrigger
          render={<Button type="button" size="xs" variant="ghost" disabled={busy || count === 0} />}
        >
          <ShapesIcon />
          Type
        </MenuTrigger>
        <MenuPopup align="end" side="bottom">
          {BULK_TYPES.map((type) => (
            <MenuItem
              key={type}
              onClick={() => void organize.bulk({ sourceIds, type }, "Type was not changed")}
            >
              {SCIENT_SOURCE_TYPE_LABELS[type]}
            </MenuItem>
          ))}
        </MenuPopup>
      </Menu>
      <Button
        type="button"
        size="icon-xs"
        variant="ghost-destructive"
        aria-label={`Remove ${count} selected sources`}
        disabled={busy || count === 0}
        onClick={() => setConfirmingRemoval(true)}
      >
        <Trash2 />
      </Button>
      <Button
        type="button"
        size="icon-xs"
        variant="ghost"
        aria-label="Done selecting"
        onClick={organize.clearSelection}
      >
        <X />
      </Button>
      <AlertDialog
        open={confirmingRemoval}
        onOpenChange={(open) => (!removing ? setConfirmingRemoval(open) : undefined)}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {count === 1 ? "Remove 1 source?" : `Remove ${count} sources?`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              They are removed from Sources and from every collection.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" disabled={removing} />}>
              Cancel
            </AlertDialogClose>
            <Button
              variant="destructive"
              disabled={removing}
              onClick={() => {
                setRemoving(true);
                void props.onRemove(selected).finally(() => {
                  setRemoving(false);
                  setConfirmingRemoval(false);
                  organize.clearSelection();
                });
              }}
            >
              Remove
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </div>
  );
}
