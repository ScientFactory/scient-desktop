import {
  EMPTY_SCIENT_SOURCES_ORGANIZATION,
  SCIENT_SOURCES_BULK_SOURCE_LIMIT,
  scientSourceFilterIsEmpty,
  scientSourceTagKey,
  type ScientSourceFilter,
  type ScientSourcesBulkChange,
  type ScientSourcesOrganization,
  type ScientSourcesOrganizeAction,
} from "@scientfactory/scient-sources";
import type { EnvironmentId, ScientSourcesBulkResult } from "@t3tools/contracts";
import { useRef, useState } from "react";

import { toastManager } from "../../components/ui/toast";
import {
  bulkChangeParts,
  bulkPartsAnnouncement,
  collectionPartsAnnouncement,
  runParts,
  splitIntoParts,
  sumBulkResults,
  undoBulkParts,
  undoPartsAnnouncement,
  type BulkUndoPart,
} from "./bulkParts";
import { bulkUpdateScientSources, organizeScientSources } from "./client";
import { isLostAnswerError, scientSourcesErrorMessage } from "./errorMessage";
import type { ReadingStateFilter } from "./libraryLabels";
import { useCanChangeLibrary } from "./sourcesCommands";

/** The panel's narrowing besides the typed query, which the panel keeps itself. */
type SourcesListFilter = {
  readonly [Key in Exclude<keyof ScientSourceFilter, "text">]?: ScientSourceFilter[Key] | undefined;
};

const message = (error: unknown) => scientSourcesErrorMessage(error, import.meta.env.DEV);

/** A selection larger than one request, sent in parts; only changing parts can be stopped. */
interface SourcesBulkProgress {
  readonly kind: "changing" | "undoing";
  readonly done: number;
  readonly total: number;
  readonly stopping: boolean;
}

function bulkResultSummary(result: ScientSourcesBulkResult): string | null {
  const failed = result.sources.filter((entry) => entry.outcome === "failed");
  const missing = result.sources.filter((entry) => entry.outcome === "not-found");
  const note = [...result.sources, ...result.collections].find((entry) => entry.message)?.message;
  if (failed.length === 0 && missing.length === 0 && !note) return null;
  const parts = [
    failed.length > 0 ? `${failed.length} could not be changed` : null,
    missing.length > 0 ? `${missing.length} no longer in the Library` : null,
  ].filter(Boolean);
  return [parts.length > 0 ? `${parts.join(", ")}.` : null, note].filter(Boolean).join(" ");
}

// Outside the hook: the React Compiler does not compile try/finally.
async function runOrganizeWork<A>(input: {
  readonly work: () => Promise<A>;
  readonly failureTitle: string;
  readonly refresh: () => Promise<unknown>;
  readonly setPending: (pending: boolean) => void;
}): Promise<A | null> {
  input.setPending(true);
  try {
    const result = await input.work();
    await input.refresh().catch(() => undefined);
    return result;
  } catch (cause) {
    toastManager.add({ type: "error", title: input.failureTitle, description: message(cause) });
    return null;
  } finally {
    input.setPending(false);
  }
}

export function useSourcesOrganize(input: {
  readonly environmentId: EnvironmentId;
  readonly root: string;
  readonly organization: ScientSourcesOrganization | undefined;
  readonly query: string;
  readonly setQuery: (query: string) => void;
  readonly refreshOverview: () => Promise<unknown>;
}) {
  const organization = input.organization ?? EMPTY_SCIENT_SOURCES_ORGANIZATION;
  const canChange = useCanChangeLibrary(input.environmentId);
  const context = `${input.environmentId}\0${input.root}`;
  const [state, setState] = useState({
    context,
    filter: {} as SourcesListFilter,
    // A personal Library's reading state; saved searches and agents' filters do not carry it.
    reading: {} as ReadingStateFilter,
    savedSearchId: null as string | null,
    selection: new Set<string>() as ReadonlySet<string>,
  });
  const [pending, setPending] = useState(false);
  const [progress, setProgress] = useState<SourcesBulkProgress | null>(null);
  const stopRequested = useRef(false);
  const startProgress = (kind: SourcesBulkProgress["kind"], total: number) => {
    stopRequested.current = false;
    setProgress({ kind, done: 0, total, stopping: false });
  };
  const showDone = (done: number) =>
    setProgress((current) => (current ? { ...current, done } : current));
  const current =
    state.context === context
      ? state
      : { context, filter: {}, reading: {}, savedSearchId: null, selection: new Set<string>() };
  if (current !== state) setState(current);

  // A filter can outlive what it points at when someone else deletes it.
  const collection =
    current.filter.collectionId === undefined
      ? null
      : (organization.collections.find(
          (entry) => entry.collectionId === current.filter.collectionId,
        ) ?? null);
  const savedSearch = current.savedSearchId
    ? (organization.savedSearches.find((entry) => entry.searchId === current.savedSearchId) ?? null)
    : null;
  const filter: SourcesListFilter =
    current.filter.collectionId !== undefined && !collection
      ? { ...current.filter, collectionId: undefined }
      : current.filter;
  const listFilter = Object.fromEntries(
    Object.entries(filter).filter(([, value]) => value !== undefined),
  ) as Omit<ScientSourceFilter, "text">;
  const fullFilter: ScientSourceFilter = {
    ...listFilter,
    ...(input.query.trim() ? { text: input.query.trim() } : {}),
  };

  const update = (next: Partial<typeof current>) => setState({ ...current, ...next });
  const setFilter = (next: SourcesListFilter) => update({ filter: next, savedSearchId: null });

  const run = <A>(work: () => Promise<A>, failureTitle: string) =>
    runOrganizeWork({ work, failureTitle, refresh: input.refreshOverview, setPending });

  const organize = (change: ScientSourcesOrganizeAction, failureTitle: string) =>
    run(
      () => organizeScientSources(input.environmentId, { root: input.root, change }),
      failureTitle,
    );

  const undoBulk = async (batchId: string) => {
    const result = await run(
      () =>
        bulkUpdateScientSources(input.environmentId, {
          root: input.root,
          change: { undoBatchId: batchId },
        }),
      "Changes were not undone",
    );
    if (!result) return;
    const failed = [...result.sources, ...result.collections].filter(
      (entry) => entry.outcome === "failed",
    );
    if (failed.length > 0) {
      const id = toastManager.add({
        type: "warning",
        title: "Some changes were not undone",
        description:
          failed.length === 1
            ? "1 change could not be undone."
            : `${failed.length} changes could not be undone.`,
        actionProps: {
          children: "Try again",
          onClick: () => {
            toastManager.close(id);
            void undoBulk(batchId);
          },
        },
      });
      return;
    }
    const conflicts = result.conflicts ?? [];
    if (conflicts.length === 0) return;
    const undidNothing = result.sources.length === 0 && result.collections.length === 0;
    toastManager.add({
      type: "warning",
      title: undidNothing ? "Changes were not undone" : "Some later changes were kept",
      description:
        conflicts.length === 1
          ? conflicts[0]!.message
          : `${conflicts[0]!.message} ${conflicts.length - 1} more were kept as well.`,
    });
  };

  const undoInParts = async (parts: ReadonlyArray<BulkUndoPart>) => {
    startProgress(
      "undoing",
      parts.reduce((sum, part) => sum + part.sourceCount, 0),
    );
    let undone = 0;
    const outcome = await run(
      () =>
        undoBulkParts({
          parts,
          send: (batchId) =>
            bulkUpdateScientSources(input.environmentId, {
              root: input.root,
              change: { undoBatchId: batchId },
            }),
          isLost: isLostAnswerError,
          onPartDone: (part) => {
            undone += part.sourceCount;
            showDone(undone);
          },
        }),
      "Changes were not undone",
    );
    setProgress(null);
    if (!outcome) return;
    const announcement = undoPartsAnnouncement(outcome, message);
    if (!announcement) return;
    const { retry } = outcome;
    const id = toastManager.add({
      ...announcement,
      ...(retry.length > 0
        ? {
            actionProps: {
              children: "Try again",
              onClick: () => {
                toastManager.close(id);
                void undoInParts(retry);
              },
            },
          }
        : {}),
    });
  };

  const bulkInParts = async (change: ScientSourcesBulkChange, failureTitle: string) => {
    const parts = bulkChangeParts(change);
    startProgress(
      "changing",
      parts.reduce((sum, part) => sum + part.sourceIds.length, 0),
    );
    const outcome = await run(
      () =>
        runParts({
          parts: parts.map((part) => part.sourceIds),
          send: (sourceIds) =>
            bulkUpdateScientSources(input.environmentId, {
              root: input.root,
              change: { ...change, sourceIds },
            }),
          isLost: isLostAnswerError,
          onProgress: showDone,
          stopRequested: () => stopRequested.current,
        }),
      failureTitle,
    );
    setProgress(null);
    if (!outcome) return null;
    const sum = sumBulkResults(outcome.results);
    const problem = bulkResultSummary(sum.result);
    if (problem) toastManager.add({ type: "warning", title: failureTitle, description: problem });
    const announcement = bulkPartsAnnouncement({
      outcome,
      changed: sum.changed,
      failureTitle,
      message,
    });
    if (announcement) {
      const undo = sum.undo;
      const id = toastManager.add({
        ...announcement,
        ...(undo.length > 0
          ? {
              actionProps: {
                children: "Undo",
                onClick: () => {
                  toastManager.close(id);
                  void undoInParts(undo);
                },
              },
            }
          : {}),
      });
    }
    return outcome.answered === 0 && outcome.end.kind === "failed" ? null : sum.result;
  };

  const createCollectionInParts = async (
    name: string,
    sourceIds: ReadonlyArray<string>,
    parentCollectionId?: string,
  ) => {
    const [first = [], ...rest] = splitIntoParts(
      [...new Set(sourceIds)],
      SCIENT_SOURCES_BULK_SOURCE_LIMIT,
    );
    const total = first.length + rest.reduce((sum, part) => sum + part.length, 0);
    startProgress("changing", total);
    const outcome = await run(async () => {
      const created = await organizeScientSources(input.environmentId, {
        root: input.root,
        change: {
          action: "create-collection",
          name,
          sourceIds: first,
          ...(parentCollectionId ? { parentCollectionId } : {}),
        },
      });
      const collectionId = created.collection?.collectionId;
      if (!collectionId) return { created, filled: null };
      showDone(first.length);
      const filled = await runParts({
        parts: rest,
        send: (members) =>
          organizeScientSources(input.environmentId, {
            root: input.root,
            change: { action: "add-to-collection", collectionId, sourceIds: members },
          }),
        isLost: isLostAnswerError,
        onProgress: showDone,
        stopRequested: () => stopRequested.current,
        answeredBefore: first.length,
        totalBefore: first.length,
      });
      return { created, filled };
    }, "Collection was not created");
    setProgress(null);
    if (!outcome) return null;
    const announcement = outcome.filled
      ? collectionPartsAnnouncement({ outcome: outcome.filled, name, message })
      : null;
    if (announcement) toastManager.add(announcement);
    return outcome.created.collection ?? null;
  };

  const bulk = async (change: ScientSourcesBulkChange, failureTitle: string) => {
    if (change.sourceIds.length > SCIENT_SOURCES_BULK_SOURCE_LIMIT) {
      return bulkInParts(change, failureTitle);
    }
    const result = await run(
      () => bulkUpdateScientSources(input.environmentId, { root: input.root, change }),
      failureTitle,
    );
    const problem = result ? bulkResultSummary(result) : null;
    if (problem) toastManager.add({ type: "warning", title: failureTitle, description: problem });
    const undo = result?.undo;
    if (undo) {
      const id = toastManager.add({
        type: "success",
        title: undo.sourceCount === 1 ? "Changed 1 source" : `Changed ${undo.sourceCount} sources`,
        actionProps: {
          children: "Undo",
          onClick: () => {
            toastManager.close(id);
            void undoBulk(undo.batchId);
          },
        },
      });
    }
    return result;
  };

  return {
    organization,
    pending,
    progress,
    stopProgress: () => {
      stopRequested.current = true;
      setProgress((current) =>
        current?.kind === "changing" ? { ...current, stopping: true } : current,
      );
    },
    canChange,
    filter: listFilter,
    fullFilter,
    filterActive: !scientSourceFilterIsEmpty(listFilter),
    reading: current.reading,
    readingFilterActive: Boolean(current.reading.unread || current.reading.starred),
    setReading: (reading: ReadingStateFilter) => update({ reading }),
    collection,
    savedSearch,
    selection: current.selection,
    setFilter,
    showCollection: (collectionId: string | undefined) =>
      setFilter({ ...listFilter, collectionId }),
    toggleTag: (tag: string) => {
      const tags = listFilter.tags ?? [];
      const key = scientSourceTagKey(tag);
      const next = tags.some((entry) => scientSourceTagKey(entry) === key)
        ? tags.filter((entry) => scientSourceTagKey(entry) !== key)
        : [...tags, tag];
      setFilter({ ...listFilter, tags: next.length > 0 ? next : undefined });
    },
    showTag: (tag: string) => {
      update({ filter: { tags: [tag] }, savedSearchId: null, selection: new Set() });
      input.setQuery("");
    },
    showOnly: (only: Pick<SourcesListFilter, "studyDesign" | "topic">) => {
      update({ filter: only, savedSearchId: null, selection: new Set() });
      input.setQuery("");
    },
    clearFilter: () => {
      update({ filter: {}, reading: {}, savedSearchId: null });
      input.setQuery("");
    },
    applySavedSearch: (searchId: string) => {
      const search = organization.savedSearches.find((entry) => entry.searchId === searchId);
      if (!search) return;
      const { text, ...rest } = search.filter;
      update({ filter: rest, savedSearchId: search.searchId });
      input.setQuery(text ?? "");
    },
    toggleSelected: (sourceId: string) => {
      const next = new Set(current.selection);
      if (next.has(sourceId)) next.delete(sourceId);
      else next.add(sourceId);
      update({ selection: next });
    },
    setSelection: (sourceIds: Iterable<string>) => update({ selection: new Set(sourceIds) }),
    clearSelection: () => update({ selection: new Set() }),
    organize,
    bulk,
    createCollection: async (
      name: string,
      sourceIds?: ReadonlyArray<string>,
      parentCollectionId?: string,
    ) => {
      if (sourceIds && sourceIds.length > SCIENT_SOURCES_BULK_SOURCE_LIMIT) {
        return createCollectionInParts(name, sourceIds, parentCollectionId);
      }
      const result = await organize(
        {
          action: "create-collection",
          name,
          ...(sourceIds && sourceIds.length > 0 ? { sourceIds } : {}),
          ...(parentCollectionId ? { parentCollectionId } : {}),
        },
        "Collection was not created",
      );
      return result?.collection ?? null;
    },
    deleteCollection: async (collectionId: string) => {
      const result = await organize(
        { action: "delete-collection", collectionId },
        "Collection was not deleted",
      );
      if (result?.outcome !== "deleted" || !result.collection) return;
      const { name } = result.collection;
      if (current.filter.collectionId === collectionId) {
        setFilter({ ...listFilter, collectionId: undefined });
      }
      toastManager.add({
        type: "success",
        title: `Deleted collection “${name}”`,
        description: "Its sources stay in the Library.",
        actionProps: {
          children: "Undo",
          onClick: () => {
            void organize(
              { action: "restore-collection", collectionId },
              "Collection was not restored",
            );
          },
        },
      });
    },
    saveSearch: async (name: string, searchId?: string) => {
      const result = await organize(
        { action: "save-search", name, filter: fullFilter, ...(searchId ? { searchId } : {}) },
        "Search was not saved",
      );
      if (result?.savedSearch) update({ savedSearchId: result.savedSearch.searchId });
      return result;
    },
    deleteSavedSearch: async (searchId: string) => {
      const search = organization.savedSearches.find((entry) => entry.searchId === searchId);
      const result = await organize(
        { action: "delete-search", searchId },
        "Search was not deleted",
      );
      if (result?.outcome !== "deleted" || !search) return;
      if (current.savedSearchId === searchId) update({ savedSearchId: null });
      toastManager.add({
        type: "success",
        title: `Deleted saved search “${search.name}”`,
        actionProps: {
          children: "Undo",
          onClick: () => {
            void organize(
              { action: "save-search", name: search.name, filter: search.filter },
              "Search was not restored",
            );
          },
        },
      });
    },
  };
}

export type SourcesOrganize = ReturnType<typeof useSourcesOrganize>;
