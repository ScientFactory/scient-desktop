import {
  scientSourceTagCounts,
  scientSourceTagKey,
  type ScientSourceType,
} from "@scientfactory/scient-sources";
import type { EnvironmentId, ScientSourcesOverviewResult } from "@t3tools/contracts";
import { FolderIcon, ShapesIcon, TagIcon, Trash2, X } from "lucide-react";
import { useState } from "react";

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
import { toastManager } from "../../components/ui/toast";
import { restoreScientSource } from "./client";
import { orderedCollections } from "./collectionTree";
import { SCIENT_SOURCE_TYPE_LABELS } from "./sourceLabels";
import type { SourcesNameRequest } from "./SourcesNameDialog";
import type { SourcesOrganize } from "./useSourcesOrganize";

type SourceSummary = ScientSourcesOverviewResult["records"][number];

// "Other" needs its own wording per source, so it stays an edit of one source.
const BULK_TYPES = (Object.keys(SCIENT_SOURCE_TYPE_LABELS) as ScientSourceType[]).filter(
  (type) => type !== "other",
);

/** One toast for a bulk move to Trash; Undo restores every source it moved. */
export function announceSourcesMovedToTrash(input: {
  readonly environmentId: EnvironmentId;
  readonly root: string;
  readonly sourceIds: ReadonlyArray<string>;
  readonly notRemoved: number;
  readonly onRestored: () => Promise<unknown>;
}) {
  if (input.notRemoved > 0) {
    toastManager.add({
      type: "warning",
      title:
        input.notRemoved === 1
          ? "1 source was not moved to Trash"
          : `${input.notRemoved} sources were not moved to Trash`,
      description: "They changed while you worked. Review them, then try again.",
    });
  }
  if (input.sourceIds.length === 0) return;
  const id = toastManager.add({
    type: "success",
    title:
      input.sourceIds.length === 1
        ? "Moved 1 source to Trash"
        : `Moved ${input.sourceIds.length} sources to Trash`,
    actionProps: {
      children: "Undo",
      onClick: () => {
        toastManager.close(id);
        void restoreAll(input).then(input.onRestored);
      },
    },
  });
}

async function restoreAll(input: {
  readonly environmentId: EnvironmentId;
  readonly root: string;
  readonly sourceIds: ReadonlyArray<string>;
}) {
  let failed = 0;
  for (const sourceId of input.sourceIds) {
    const restored = await restoreScientSource(input.environmentId, {
      root: input.root,
      sourceId,
    }).catch(() => null);
    if (restored?.outcome !== "restored") failed += 1;
  }
  if (failed > 0) {
    toastManager.add({
      type: "error",
      title: failed === 1 ? "1 source was not restored" : `${failed} sources were not restored`,
      description: "Open the Trash to restore it.",
    });
  }
}

/** Replaces the search row while sources are selected. */
export function SourcesBulkBar(props: {
  readonly organize: SourcesOrganize;
  readonly records: ReadonlyArray<SourceSummary>;
  readonly visibleSourceIds: ReadonlyArray<string>;
  readonly onRequestName: (request: SourcesNameRequest) => void;
  readonly onRemove: (records: ReadonlyArray<SourceSummary>) => Promise<void>;
}) {
  const { organize } = props;
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
  const busy = organize.pending || removing || !organize.canChange;

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
          {orderedCollections(organize.organization.collections).map(({ collection, label }) => {
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
                <span className="min-w-0 truncate">{label}</span>
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
        aria-label={`Move ${count} selected sources to Trash`}
        disabled={busy || count === 0}
        onClick={() => {
          setRemoving(true);
          void props.onRemove(selected).finally(() => {
            setRemoving(false);
            organize.clearSelection();
          });
        }}
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
    </div>
  );
}
