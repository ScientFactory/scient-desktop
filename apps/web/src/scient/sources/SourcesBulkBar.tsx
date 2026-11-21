import { msg, T, useGT, useMessages } from "gt-react";
import { m as resolveMessage } from "~/i18n/messages";
import {
  SCIENT_SOURCES_BULK_SOURCE_LIMIT,
  scientSourceTagCounts,
  scientSourceTagKey,
  type ScientSourceType,
} from "@scientfactory/scient-sources";
import type {
  EnvironmentId,
  ScientSourcesOverviewResult,
  ScientSourcesScope,
} from "@t3tools/contracts";
import {
  BookmarkCheckIcon,
  Columns3Icon,
  FolderIcon,
  FolderMinus,
  FolderPlus,
  ShapesIcon,
  TagIcon,
  Trash2,
  X,
} from "lucide-react";
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
import { useComposerHandleContext } from "../../composerHandleContext";
import { ScientTooltip } from "../presentation/ScientTooltip";
import { restoreScientSource } from "./client";
import { collectionIndent, orderedCollections } from "./collectionTree";
import { compareSourcesInsertion } from "./compareSources";
import {
  LIBRARY_LABELS,
  someAlsoInOtherProjectsLabel,
  type ReadingStateChange,
} from "./libraryLabels";
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
  /** On a personal Library: how many of the moved sources other projects also have. */
  readonly alsoElsewhere?: number;
  readonly onRestored: () => Promise<unknown>;
}) {
  if (input.notRemoved > 0) {
    toastManager.add({
      type: "warning",
      title: resolveMessage(
        msg(
          "{count, plural, =1 {1 source was not moved to Trash} other {{count} sources were not moved to Trash}}",
          { count: input.notRemoved },
        ),
      ),
      description: resolveMessage(
        msg("They changed while you worked. Review them, then try again."),
      ),
    });
  }
  if (input.sourceIds.length === 0) return;
  const id = toastManager.add({
    type: "success",
    title: resolveMessage(
      msg("{count, plural, =1 {Moved 1 source to Trash} other {Moved {count} sources to Trash}}", {
        count: input.sourceIds.length,
      }),
    ),
    ...(input.alsoElsewhere
      ? { description: someAlsoInOtherProjectsLabel(input.alsoElsewhere) }
      : {}),
    actionProps: {
      children: resolveMessage(msg("Undo", { $context: "verb, button that undoes a change" })),
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
      title: resolveMessage(
        msg(
          "{count, plural, =1 {1 source was not restored} other {{count} sources were not restored}}",
          { count: failed },
        ),
      ),
      description: resolveMessage(msg("Open the Trash to restore it.")),
    });
  }
}

const READING_ACTIONS: ReadonlyArray<{
  readonly label: string;
  readonly change: ReadingStateChange;
}> = [
  { label: LIBRARY_LABELS.markRead, change: { readingStatus: "read" } },
  { label: LIBRARY_LABELS.markUnread, change: { readingStatus: "unread" } },
  { label: LIBRARY_LABELS.star, change: { starred: true } },
  { label: LIBRARY_LABELS.removeStar, change: { starred: false } },
];

/**
 * Puts a request to compare the selected sources at the start of the chat draft, with the caret
 * after `Question: `; it never sends.
 */
function CompareSourcesButton(props: { readonly records: ReadonlyArray<SourceSummary> }) {
  const gt = useGT();
  const composer = useComposerHandleContext();
  const label = gt("Compare", { $context: "verb, compares the selected sources" });
  const compare = () => {
    const handle = composer?.current;
    const draft = handle?.getSendContext();
    if (handle && draft && !draft.answeringPendingUserInput) {
      const insertion = compareSourcesInsertion(draft.prompt, props.records);
      if (insertion.kind === "present") return handle.focusAtEnd();
      if (insertion.kind === "other-request") {
        toastManager.add({
          type: "error",
          title: gt("Your draft already asks to compare other sources"),
          description: gt("Send or clear that request, then try again."),
        });
        return;
      }
      if (handle.insertTextAtStart?.(insertion.text)) {
        if (insertion.listed < props.records.length) {
          toastManager.add({
            type: "info",
            title: gt("Only the first {listed} sources are in the request", {
              listed: insertion.listed,
            }),
            description: gt("You selected {count}. Compare a few at a time.", {
              count: props.records.length,
            }),
          });
        }
        return;
      }
    }
    toastManager.add({
      type: "error",
      title: gt("Couldn't add to the chat"),
      description: draft?.answeringPendingUserInput
        ? gt("Answer the agent's question first, then try again.")
        : gt("The chat isn't ready for text right now."),
    });
  };
  return (
    <ScientTooltip
      content={composer === null ? gt("Open a chat to compare these sources.") : label}
    >
      {/* A disabled button gets no pointer events, so the tooltip hangs on its wrapper. */}
      <span className="inline-flex">
        <Button
          type="button"
          size="xs"
          variant="ghost"
          aria-label={gt("Compare {count} selected sources", { count: props.records.length })}
          disabled={composer === null}
          onClick={compare}
        >
          <Columns3Icon />
          <span className="@max-[24rem]/bulk:hidden">{label}</span>
        </Button>
      </span>
    </ScientTooltip>
  );
}

/** What a personal Library adds to the bar; a project server never passes it. */
export interface SourcesBulkLibrary {
  readonly listed: ScientSourcesScope;
  /** Absent when this connection may not change reading state. */
  readonly onSetReadingState?: (
    sourceIds: ReadonlyArray<string>,
    change: ReadingStateChange,
  ) => Promise<void>;
  readonly onAddToProject: (records: ReadonlyArray<SourceSummary>) => Promise<void>;
  /** Resolves false when the person cancelled a confirmation; the selection then stays. */
  readonly onRemoveFromProject: (records: ReadonlyArray<SourceSummary>) => Promise<boolean>;
}

/** Replaces the search row while sources are selected. */
export function SourcesBulkBar(props: {
  readonly organize: SourcesOrganize;
  readonly records: ReadonlyArray<SourceSummary>;
  readonly visibleSourceIds: ReadonlyArray<string>;
  readonly onRequestName: (request: SourcesNameRequest) => void;
  readonly onRemove: (records: ReadonlyArray<SourceSummary>) => Promise<void>;
  readonly library?: SourcesBulkLibrary;
}) {
  const m = useMessages();
  const gt = useGT();
  const { organize, library } = props;
  const { progress } = organize;
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
  const runOnSelection = (
    work: (records: ReadonlyArray<SourceSummary>) => Promise<void>,
    keepSelection = false,
  ) => {
    setRemoving(true);
    void work(selected).finally(() => {
      setRemoving(false);
      if (!keepSelection) organize.clearSelection();
    });
  };
  const notInProject = selected.filter((record) => record.pinned === false);
  // A change in parts reports in this bar, where Stop is, and in its toast: the naming dialog
  // closes as it starts. A smaller change keeps the dialog open until it is answered.
  const named = async (change: Promise<unknown>) => {
    if (count > SCIENT_SOURCES_BULK_SOURCE_LIMIT) {
      void change.catch(() => undefined);
      return true;
    }
    return (await change) !== null;
  };

  const addTag = () =>
    props.onRequestName({
      title: count === 1 ? gt("Add a tag") : gt("Add a tag to {count} sources", { count }),
      label: gt("Tag", { $context: "noun" }),
      initialName: "",
      action: "Add",
      onSubmit: (tag) => named(organize.bulk({ sourceIds, addTags: [tag] }, "Tag was not added")),
    });
  const newCollection = () =>
    props.onRequestName({
      title: gt("New collection"),
      label: gt("Collection name"),
      initialName: "",
      action: "Create",
      onSubmit: (name) => named(organize.createCollection(name, sourceIds)),
    });

  return (
    // Narrower than one row of actions, they take a line of their own (wrapping again if they
    // must), so the count and Done selecting stay on the first. Progress has a line of its own.
    <div className="@container/bulk mt-2 mb-1 ml-3 mr-4 shrink-0 text-sm">
      <div className="flex min-h-8 flex-wrap items-center gap-1">
        <Checkbox
          aria-label={allVisibleSelected ? gt("Clear selection") : gt("Select all shown sources")}
          checked={allVisibleSelected}
          indeterminate={!allVisibleSelected && count > 0}
          onCheckedChange={() =>
            allVisibleSelected
              ? organize.clearSelection()
              : organize.setSelection([...organize.selection, ...props.visibleSourceIds])
          }
        />
        <span className="ms-2 me-auto whitespace-nowrap text-muted-foreground tabular-nums">
          {count > 0 || !progress
            ? gt("{count} selected", { count: count.toLocaleString() })
            : null}
        </span>
        <div className="flex flex-wrap items-center gap-1 @max-[30rem]/bulk:order-1 @max-[30rem]/bulk:basis-full">
          {library?.listed === "library" && notInProject.length > 0 ? (
            <Button
              type="button"
              size="xs"
              variant="ghost"
              disabled={busy}
              onClick={() => runOnSelection(() => library.onAddToProject(notInProject))}
            >
              <FolderPlus />
              {m(LIBRARY_LABELS.addToProject)}
            </Button>
          ) : null}
          {count >= 2 ? <CompareSourcesButton records={selected} /> : null}
          <Menu>
            <MenuTrigger
              render={
                <Button type="button" size="xs" variant="ghost" disabled={busy || count === 0} />
              }
            >
              <TagIcon />
              <T context="noun">Tag</T>
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
              <MenuItem onClick={addTag}>
                <T>New tag…</T>
              </MenuItem>
            </MenuPopup>
          </Menu>
          <Menu>
            <MenuTrigger
              render={
                <Button type="button" size="xs" variant="ghost" disabled={busy || count === 0} />
              }
            >
              <FolderIcon />
              <T context="noun, a collection of sources">Collection</T>
            </MenuTrigger>
            <MenuPopup align="end" side="bottom" className="min-w-48">
              {orderedCollections(organize.organization.collections).map(
                ({ collection, aboveIds }) => {
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
                      <span
                        className="block min-w-0 truncate"
                        style={collectionIndent(aboveIds.length)}
                      >
                        {collection.name}
                      </span>
                    </MenuCheckboxItem>
                  );
                },
              )}
              {organize.organization.collections.length > 0 ? <MenuSeparator /> : null}
              <MenuItem onClick={newCollection}>
                <T>New collection…</T>
              </MenuItem>
            </MenuPopup>
          </Menu>
          <Menu>
            <MenuTrigger
              render={
                <Button type="button" size="xs" variant="ghost" disabled={busy || count === 0} />
              }
            >
              <ShapesIcon />
              <T context="a source's type">Type</T>
            </MenuTrigger>
            <MenuPopup align="end" side="bottom">
              {BULK_TYPES.map((type) => (
                <MenuItem
                  key={type}
                  onClick={() => void organize.bulk({ sourceIds, type }, "Type was not changed")}
                >
                  {m(SCIENT_SOURCE_TYPE_LABELS[type])}
                </MenuItem>
              ))}
            </MenuPopup>
          </Menu>
          {library?.onSetReadingState ? (
            <Menu>
              <MenuTrigger
                render={
                  <Button type="button" size="xs" variant="ghost" disabled={busy || count === 0} />
                }
              >
                <BookmarkCheckIcon />
                {m(LIBRARY_LABELS.readingMenu)}
              </MenuTrigger>
              <MenuPopup align="end" side="bottom">
                {READING_ACTIONS.map((action) => (
                  <MenuItem
                    key={action.label}
                    onClick={() => {
                      const onSet = library.onSetReadingState;
                      if (onSet) runOnSelection(() => onSet(sourceIds, action.change), true);
                    }}
                  >
                    {m(action.label)}
                  </MenuItem>
                ))}
              </MenuPopup>
            </Menu>
          ) : null}
          {library?.listed === "project" ? (
            <ScientTooltip content={m(LIBRARY_LABELS.removeFromProject)}>
              <Button
                type="button"
                size="icon-xs"
                variant="ghost"
                aria-label={gt("Remove from this project: {count} selected", { count })}
                disabled={busy || count === 0}
                onClick={() => {
                  setRemoving(true);
                  void library.onRemoveFromProject(selected).then((ran) => {
                    setRemoving(false);
                    if (ran) organize.clearSelection();
                  });
                }}
              >
                <FolderMinus />
              </Button>
            </ScientTooltip>
          ) : (
            <Button
              type="button"
              size="icon-xs"
              variant="ghost-destructive"
              aria-label={gt("Move {count} selected sources to Trash", { count })}
              disabled={busy || count === 0}
              onClick={() => runOnSelection(props.onRemove)}
            >
              <Trash2 />
            </Button>
          )}
        </div>
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          aria-label={gt("Done selecting")}
          onClick={organize.clearSelection}
        >
          <X />
        </Button>
      </div>
      {progress ? (
        <div className="flex min-h-8 items-center gap-2 ps-6">
          <span className="min-w-0 flex-1 text-muted-foreground tabular-nums">
            {progress.kind === "changing"
              ? gt("Changing {done} of {total} sources", {
                  done: progress.done.toLocaleString(),
                  total: progress.total.toLocaleString(),
                })
              : gt("Undoing {done} of {total} sources", {
                  done: progress.done.toLocaleString(),
                  total: progress.total.toLocaleString(),
                })}
          </span>
          {progress.kind === "changing" ? (
            <Button
              type="button"
              size="xs"
              variant="ghost"
              disabled={progress.stopping}
              onClick={organize.stopProgress}
            >
              {progress.stopping
                ? gt("Stopping…")
                : gt("Stop", { $context: "verb, stops a bulk edit" })}
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
