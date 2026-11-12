import type {
  EnvironmentId,
  ScientSourcesFileImportResult,
  ScientSourcesOverviewResult,
  ThreadId,
} from "@t3tools/contracts";
import {
  AlertCircle,
  ArrowDownUp,
  BookOpen,
  ChevronLeft,
  Download,
  ExternalLink,
  FileUp,
  FileText,
  Folder,
  Hash,
  Library,
  LoaderCircle,
  RefreshCw,
  Search,
  Users,
  X,
} from "lucide-react";
import { useEffect, useLayoutEffect, useSyncExternalStore, useRef, useState } from "react";

import { Button } from "../../components/ui/button";
import { ManagedBibliographyNotice } from "./ManagedBibliographyNotice";
import { useManagedBibliography } from "./useManagedBibliography";
import { useLibrarySourceRequest } from "./librarySourceRequest";
import { Checkbox } from "../../components/ui/checkbox";
import { Input } from "../../components/ui/input";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../../components/ui/menu";
import { Popover, PopoverPopup, PopoverTrigger } from "../../components/ui/popover";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select";
import { ScrollArea } from "../../components/ui/scroll-area";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../components/ui/tooltip";
import { toastManager } from "../../components/ui/toast";
import { scientSourcesErrorMessage } from "./errorMessage";
import { useZoteroSync, ZoteroRefreshDialog } from "./ZoteroSync";
import { useLiveRefresh } from "../../hooks/useLiveRefresh";
import { initializeScientProjectForOpening } from "../../lib/scientProjectInitialization";
import { readLocalApi } from "../../localApi";
import { readPreparedConnection } from "../../state/session";
import { SourceAnnotations } from "../annotations/SourceAnnotations";
import { AddByIdentifier } from "./AddByIdentifier";
import { ImportReview } from "./ImportReview";
import { AlreadyPresentSummary, ImportSummary } from "./ImportSummary";
import { CenteredState, PanelHeader, SourceErrorBanner } from "./PanelChrome";
import { SourceDetails } from "./SourceDetails";
import { SourceEditor } from "./SourceEditor";
import { SourceFullTextResults } from "./SourceFullTextResults";
import type { SourceRowContext } from "./SourceRow";
import { showSourceRowMenu } from "./sourceRowMenu";
import { SourcesList } from "./SourcesList";
import { requestSourceTextReveal } from "./sourceTextReveal";
import { useLibraryFileImport } from "./libraryFileHandoff";
import { newlyObservedSourceIds } from "./sourceLabels";
import {
  filterScientSourceSearchIndex,
  indexScientSourceSummaries,
  SCIENT_SOURCE_SORT_OPTIONS,
  sortScientSourceRecords,
  type ScientSourceSort,
} from "./filterSources";
import {
  importedSourceIdToReveal,
  importedSourceIds,
  type ScientSourcesImportOutcome,
} from "./importOutcome";
import { SourceHistoryDialog } from "./SourceHistory";
import { SourceStoreNotice } from "./SourceStoreNotice";
import { LibraryDuplicatesView, type DuplicatesSection } from "./LibraryDuplicates";
import { LibraryMoveNotice } from "./LibraryMoveNotice";
import { useLibraryMoveStatus } from "./useLibraryMoveStatus";
import { announceSourceMovedToTrash } from "./SourceTrash";
import { shownSourceRecord } from "./sourcesWorkflow";
import { useScientSources } from "./useScientSources";
import { SourceOrganizeSection } from "./SourceOrganizeSection";
import { SourcesActiveFilters } from "./SourcesActiveFilters";
import { announceSourcesMovedToTrash, SourcesBulkBar } from "./SourcesBulkBar";
import { SourcesFilterMenu } from "./SourcesFilterMenu";
import { SourcesNameDialog, type SourcesNameRequest } from "./SourcesNameDialog";
import { useSourcesOrganize } from "./useSourcesOrganize";
import { SystematicReviewsView } from "./SystematicReviews";
import { ReferenceFileReport } from "./ReferenceFileReport";
import { isReferenceFileName } from "./referenceFileSummary";
import { SourcesHeaderMenu } from "./SourcesHeaderMenu";
import { sourcesCommands, useCanChangeLibrary, useCanRunSourcesCommand } from "./sourcesCommands";
import { updateScientSourcePersonalNote } from "./client";
import {
  inLibraryNotProjectLabel,
  matchesReadingFilter,
  type ReadingStateChange,
} from "./libraryLabels";
import { SnapshotRemovalDialog, useLibraryProjectActions } from "./useLibraryProjectActions";
import { accountsState } from "../accounts/accountsState";
import { UniversityCrest, UniversityRow } from "../accounts/University";
import { PaperQueueBand } from "../accounts/PaperRequests";
import { useStableCallback } from "~/hooks/useStableCallback";
import { useAccountCommand, useAccounts } from "../accounts/useAccounts";

type SourceRecord = ScientSourcesOverviewResult["records"][number];
const RECENT_SOURCE_ADD_TTL_MS = 10 * 60 * 1000;
const recentSourceAdds = new Map<string, Map<string, number>>();
function createRecentSourcesStore(initial: ReadonlySet<string>) {
  let snapshot = initial;
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    publish: (sourceIds: ReadonlySet<string>) => {
      snapshot = sourceIds;
      for (const listener of listeners) listener();
    },
  };
}

function readRecentSourceAdds(contextKey: string): ReadonlySet<string> {
  const now = Date.now();
  const entries = recentSourceAdds.get(contextKey);
  if (!entries) return new Set();
  for (const [sourceId, expiresAt] of entries) {
    if (expiresAt <= now) entries.delete(sourceId);
  }
  if (entries.size === 0) recentSourceAdds.delete(contextKey);
  return new Set(entries.keys());
}

function rememberRecentSourceAdds(
  contextKey: string,
  sourceIds: ReadonlyArray<string>,
): ReadonlySet<string> {
  const entries = recentSourceAdds.get(contextKey) ?? new Map<string, number>();
  const expiresAt = Date.now() + RECENT_SOURCE_ADD_TTL_MS;
  for (const sourceId of sourceIds) entries.set(sourceId, expiresAt);
  if (entries.size > 0) recentSourceAdds.set(contextKey, entries);
  return readRecentSourceAdds(contextKey);
}

function ZoteroMark() {
  return (
    <svg aria-hidden className="size-4" viewBox="0 0 24 24">
      <rect width="24" height="24" rx="5" fill="#CC2936" />
      <path d="M6 6h12v2.1L9.6 16H18v2H6v-2.1L14.4 8H6V6Z" fill="white" />
    </svg>
  );
}

function zoteroCollectionLabels(
  collections: ReadonlyArray<ReturnType<typeof useScientSources>["zoteroCollections"][number]>,
): ReadonlyArray<{ readonly key: string; readonly label: string }> {
  const byKey = new Map(collections.map((collection) => [collection.key, collection]));
  const labelFor = (key: string): string => {
    const names: string[] = [];
    const visited = new Set<string>();
    let current = byKey.get(key);
    while (current && !visited.has(current.key)) {
      visited.add(current.key);
      names.unshift(current.name);
      current = current.parentCollectionKey ? byKey.get(current.parentCollectionKey) : undefined;
    }
    return names.join(" / ");
  };
  return collections
    .map((collection) => ({ key: collection.key, label: labelFor(collection.key) }))
    .sort((left, right) => left.label.localeCompare(right.label));
}

export function ScientSourcesPanel(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly root: string;
  readonly projectTitle: string;
  readonly onOpenPdf: (input: {
    readonly sourceId: string;
    readonly attachmentId: string;
    readonly fileName: string;
  }) => void;
  readonly onOpenFile?: (path: string, line: number) => void;
}) {
  const sources = useScientSources({ environmentId: props.environmentId, root: props.root });
  const canChange = useCanChangeLibrary(props.environmentId);
  const canSetReading = useCanRunSourcesCommand(
    sourcesCommands.setReadingState,
    props.environmentId,
  );
  const canChangeProject = useCanRunSourcesCommand(sourcesCommands.organize, props.environmentId);
  const canSavePersonalNote = useCanRunSourcesCommand(
    sourcesCommands.updatePersonalNote,
    props.environmentId,
  );
  const zoteroSync = useZoteroSync({
    environmentId: props.environmentId,
    root: props.root,
    onChanged: async () => {
      await sources.refreshOverview();
    },
  });
  const hasZoteroSources = (sources.overview?.records ?? []).some((record) =>
    record.externalReferences.some((reference) => reference.system === "zotero"),
  );
  const bibliography = useManagedBibliography({
    environmentId: props.environmentId,
    root: props.root,
    records: sources.overview?.records ?? null,
    onImported: () => void sources.refreshOverview(),
  });
  const move = useLibraryMoveStatus({
    environmentId: props.environmentId,
    root: props.root,
    overview: sources.overview,
    onStoreChanged: () => void sources.refreshOverview().catch(() => undefined),
  });
  const getPaper = useAccountCommand(accountsState.paperForSource, props.environmentId);
  const requestPapers = useAccountCommand(accountsState.requestPapers, props.environmentId);
  const listPapers = useStableCallback(
    useAccountCommand(accountsState.listPapers, props.environmentId),
  );
  const { data: accounts } = useAccounts(props.environmentId);
  const papersSaved = accounts?.paperQueues?.find((item) => item.root === props.root)?.saved;
  const refreshOverview = sources.refreshOverview;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- opening a project's Sources picks up the paper list on the server that a restart interrupted
  useEffect(() => {
    void listPapers({ root: props.root });
  }, [listPapers, props.root]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the server attaches queued papers to sources; this keeps the loaded list in step with it
  useEffect(() => {
    if (papersSaved) void refreshOverview();
  }, [papersSaved, refreshOverview]);
  const missingPdfs = (sources.overview?.records ?? []).flatMap((record) => {
    const doi = record.identifiers.find(({ scheme }) => scheme.toLowerCase() === "doi")?.value;
    return record.attachments.length === 0 && (doi || record.url)
      ? [
          {
            ...(doi ? { doi } : {}),
            ...(record.url ? { url: record.url } : {}),
            ...(record.title ? { title: record.title } : {}),
            source: { sourceId: record.sourceId, expectedRevision: record.revision },
          },
        ]
      : [];
  });
  const [query, setQuery] = useState("");
  const [sourceQuery, setSourceQuery] = useState("");
  const [sourceSort, setSourceSort] = useState<ScientSourceSort>("last-added");
  const organize = useSourcesOrganize({
    environmentId: props.environmentId,
    root: props.root,
    organization: sources.overview?.organization,
    query: sourceQuery,
    setQuery: setSourceQuery,
    refreshOverview: sources.refreshOverview,
  });
  const [nameRequest, setNameRequest] = useState<SourcesNameRequest | null>(null);
  const [showingReviews, setShowingReviews] = useState(false);
  const [showingDuplicates, setShowingDuplicates] = useState<DuplicatesSection | null>(null);
  const [selectedKeys, setSelectedKeys] = useState<ReadonlySet<string>>(new Set());
  const [settingUpProject, setSettingUpProject] = useState(false);
  const [setupError, setSetupError] = useState<string | null>(null);
  const [selectedSourceId, setSelectedSourceId] = useState<string | null>(null);
  useLibrarySourceRequest(props.root, sources.overview !== null, setSelectedSourceId);
  const [editingSource, setEditingSource] = useState(false);
  const [importOutcome, setImportOutcome] = useState<ScientSourcesImportOutcome | null>(null);
  const [addingByIdentifier, setAddingByIdentifier] = useState(false);
  const [referenceFileImport, setReferenceFileImport] = useState<{
    readonly file: File;
    readonly report: ScientSourcesFileImportResult["report"];
  } | null>(null);
  const panelContext = `${props.environmentId}\0${props.root}`;
  const [recentSourcesStore] = useState(() =>
    createRecentSourcesStore(readRecentSourceAdds(panelContext)),
  );
  const recentlyAddedSourceIds = useSyncExternalStore(
    recentSourcesStore.subscribe,
    recentSourcesStore.getSnapshot,
    recentSourcesStore.getSnapshot,
  );
  const setRecentlyAddedSourceIds = recentSourcesStore.publish;
  const [historySourceId, setHistorySourceId] = useState<string | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const localFileInput = useRef<HTMLInputElement>(null);
  const referenceFileInput = useRef<HTMLInputElement>(null);
  const panelMounted = useRef(true);
  const importRevealRequest = useRef(0);
  const observedSourceIds = useRef<{
    readonly contextKey: string;
    readonly sourceIds: ReadonlySet<string>;
  } | null>(null);
  const panelContextRef = useRef(panelContext);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- keeps panelContextRef holding the current panel context
  useLayoutEffect(() => {
    panelContextRef.current = panelContext;
  }, [panelContext]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- tracks mounted state in panelMounted for async callbacks
  useEffect(() => {
    panelMounted.current = true;
    return () => {
      panelMounted.current = false;
    };
  }, []);

  const revealImportedSource = (
    work: ReturnType<typeof sources.uploadLocalFiles>,
    revealSingleSource = true,
  ) => {
    const requestedContext = panelContext;
    const request = ++importRevealRequest.current;
    setImportOutcome(null);
    void work.then((outcome) => {
      if (
        outcome &&
        panelMounted.current &&
        panelContextRef.current === requestedContext &&
        importRevealRequest.current === request
      ) {
        setImportOutcome(outcome);
        setRecentlyAddedSourceIds(
          rememberRecentSourceAdds(requestedContext, importedSourceIds(outcome)),
        );
        const sourceId = revealSingleSource ? importedSourceIdToReveal(outcome) : null;
        if (sourceId) {
          setEditingSource(false);
          setSelectedSourceId(sourceId);
        }
      }
    });
  };
  useLibraryFileImport(props.root, sources.overview !== null, (files) =>
    revealImportedSource(sources.uploadLocalFiles(files), files.length === 1),
  );

  const importReferenceFile = (file: File) => {
    setSelectedSourceId(null);
    setReferenceFileImport(null);
    const requestedContext = panelContext;
    revealImportedSource(
      sources.importReferenceFile(file).then((result) => {
        if (result && panelContextRef.current === requestedContext) {
          setReferenceFileImport({ file, report: result.report });
        }
        return result?.outcome ?? null;
      }),
      false,
    );
  };

  const [previousPanelContext, setPreviousPanelContext] = useState({ context: panelContext });
  if (previousPanelContext.context !== panelContext) {
    setPreviousPanelContext({ context: panelContext });
    setShowingReviews(false);
    setShowingDuplicates(null);
    setSelectedSourceId(null);
    setEditingSource(false);
    setImportOutcome(null);
    setReferenceFileImport(null);
    setHistorySourceId(null);
    setSourceQuery("");
  }

  const expirySchedule = { context: panelContext, sourceIds: recentlyAddedSourceIds };
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- expires recent-add highlights on a timer
  useEffect(() => {
    const panelContext = expirySchedule.context;
    const entries = recentSourceAdds.get(panelContext);
    if (!entries || entries.size === 0) return;
    const expiresAt = Math.min(...entries.values());
    const timeout = window.setTimeout(
      () => setRecentlyAddedSourceIds(readRecentSourceAdds(panelContext)),
      Math.max(0, expiresAt - Date.now()) + 1,
    );
    return () => window.clearTimeout(timeout);
  }, [expirySchedule, setRecentlyAddedSourceIds]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reloads recent-add state from the recent-adds store when the panel context changes
  useEffect(() => {
    importRevealRequest.current += 1;
    setRecentlyAddedSourceIds(readRecentSourceAdds(panelContext));
  }, [panelContext, setRecentlyAddedSourceIds]);

  const openSourceDetails = (sourceId: string) => {
    setSelectedSourceId(sourceId);
  };

  const [previousLibrary, setPreviousLibrary] = useState({ library: sources.library });
  if (previousLibrary.library !== sources.library) {
    setPreviousLibrary({ library: sources.library });
    if (!sources.library) {
      setQuery("");
      setSelectedKeys(new Set());
    }
  }

  useLiveRefresh(
    () => {
      void sources.refreshOverview().catch(() => undefined);
    },
    { key: `scient-sources:${panelContext}` },
  );

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- records newly added sources in the recent-adds store and mirrors them into state
  useEffect(() => {
    const records = sources.overview?.records;
    if (!records) return;
    const currentIds = new Set(records.map((record) => record.sourceId));
    const previousObservation = observedSourceIds.current;
    const previousIds =
      previousObservation?.contextKey === panelContext ? previousObservation.sourceIds : null;
    observedSourceIds.current = { contextKey: panelContext, sourceIds: currentIds };
    const cutoff = Date.now() - RECENT_SOURCE_ADD_TTL_MS;
    const newlyObserved = newlyObservedSourceIds(records, previousIds, cutoff);
    setRecentlyAddedSourceIds(
      newlyObserved.length > 0
        ? rememberRecentSourceAdds(panelContext, newlyObserved)
        : readRecentSourceAdds(panelContext),
    );
  }, [panelContext, sources.overview?.records, setRecentlyAddedSourceIds]);

  const toggleSelected = (itemKey: string) => {
    setSelectedKeys((current) => {
      const next = new Set(current);
      if (next.has(itemKey)) next.delete(itemKey);
      else next.add(itemKey);
      return next;
    });
  };

  const diagnosticsBySourceId = new Map(
    sources.overview?.recordDiagnostics.map((entry) => [entry.sourceId, entry.diagnostics]) ?? [],
  );
  // This project's sources are in the personal Library only when the overview has scopes.
  const scopes = sources.overview?.scopes;
  const readingFilter = scopes ? organize.reading : {};
  const sourceSearchIndex = indexScientSourceSummaries(sources.overview?.records ?? []);
  const filteredSourceRecords = sortScientSourceRecords(
    filterScientSourceSearchIndex(
      sourceSearchIndex,
      sourceQuery,
      organize.filter,
      organize.organization,
    ).filter((record) => matchesReadingFilter(record, readingFilter)),
    sourceSort,
  );
  const listFilterActive = organize.filterActive || (scopes ? organize.readingFilterActive : false);
  const selectedSummary = selectedSourceId
    ? (sources.overview?.records.find((record) => record.sourceId === selectedSourceId) ?? null)
    : null;
  const selectedRecord = selectedSourceId ? shownSourceRecord(sources, selectedSourceId) : null;

  if (selectedSourceId && !selectedRecord && !selectedSummary) setSelectedSourceId(null);
  const loadSource = sources.loadSource;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- loads the selected source record from the server when missing
  useEffect(() => {
    if (!selectedSourceId || selectedRecord || !selectedSummary) return;
    void loadSource(selectedSourceId).catch(() => undefined);
  }, [selectedSourceId, selectedRecord, selectedSummary, loadSource]);
  const zoteroCollectionChoices = zoteroCollectionLabels(sources.zoteroCollections);
  const selectedZoteroCollectionKey =
    sources.zoteroScope.kind === "collection" ? sources.zoteroScope.collectionKey : null;
  const selectedZoteroCollection = selectedZoteroCollectionKey
    ? sources.zoteroCollections.find((collection) => collection.key === selectedZoteroCollectionKey)
    : null;
  const zoteroLibraryName =
    sources.zoteroGroups.find((group) => group.groupId === sources.zoteroGroupId)?.name ??
    "My Library";

  const libraryActions = useLibraryProjectActions({
    environmentId: props.environmentId,
    root: props.root,
    refreshOverview: sources.refreshOverview,
    applyReadingState: sources.applyReadingState,
  });
  const { addToProject, removeFromProject, setReadingState } = libraryActions;
  // A merged-away source has left the Library, so it leaves the selection too.
  const leaveSelection = useStableCallback((sourceId: string) => {
    if (organize.selection.has(sourceId)) {
      organize.setSelection([...organize.selection].filter((selected) => selected !== sourceId));
    }
  });

  const moveToTrash = async (record: {
    readonly sourceId: string;
    readonly revision: number;
    readonly title: string | null;
  }) => {
    const result = await sources.removeSource(record.sourceId, record.revision);
    if (result.outcome === "stale") {
      throw new Error(
        "This source changed after you opened it. Review the latest version, then try again.",
      );
    }
    if (selectedSourceId === record.sourceId) {
      setEditingSource(false);
      setSelectedSourceId(null);
    }
    if (result.outcome === "removed") {
      announceSourceMovedToTrash({
        environmentId: props.environmentId,
        root: props.root,
        sourceId: record.sourceId,
        title: record.title,
        ...(result.alsoPinnedIn ? { alsoPinnedIn: result.alsoPinnedIn } : {}),
        onRestored: sources.refreshOverview,
      });
    }
  };

  const showSourceContextMenuAt = (
    record: SourceRecord,
    anchorPoint: { readonly x: number; readonly y: number },
  ) =>
    void showSourceRowMenu({
      record,
      anchorPoint,
      listed: scopes?.listed,
      selected: organize.selection.has(record.sourceId),
      busy: sources.busy,
      canChange,
      canSetReading,
      canChangeProject,
      isCurrent: () => panelMounted.current && panelContextRef.current === panelContext,
      onView: () => {
        setEditingSource(false);
        openSourceDetails(record.sourceId);
      },
      onEdit: () => {
        openSourceDetails(record.sourceId);
        setEditingSource(true);
      },
      onOpenPdf: props.onOpenPdf,
      onToggleSelected: () => organize.toggleSelected(record.sourceId),
      onSetReadingStatus: (readingStatus) =>
        void setReadingState([record.sourceId], { readingStatus }, false),
      onAddToProject: () => void addToProject([record]),
      onRemoveFromProject: () => void removeFromProject([record]),
      onMoveToTrash: () =>
        void moveToTrash(record).catch((cause: unknown) => {
          toastManager.add({
            type: "error",
            title: "Source could not be moved to Trash",
            description: scientSourcesErrorMessage(cause, import.meta.env.DEV),
          });
        }),
    });
  const sourceRow: SourceRowContext = {
    environmentId: props.environmentId,
    root: props.root,
    listed: scopes?.listed,
    selection: organize.selection,
    recentlyAddedSourceIds,
    diagnosticsBySourceId,
    onToggleSelected: organize.toggleSelected,
    onOpenDetails: openSourceDetails,
    onOpenPdf: props.onOpenPdf,
    onShowMenu: showSourceContextMenuAt,
    ...(canSetReading
      ? {
          onToggleStar: (record: SourceRecord) =>
            setReadingState([record.sourceId], { starred: record.starred !== true }, false),
        }
      : {}),
  };

  if (sources.overview === null) {
    if (sources.error) {
      return (
        <CenteredState
          icon={<AlertCircle />}
          title="The Library could not be loaded"
          description={sources.error}
          action={
            <Button
              variant="outline"
              disabled={sources.busy}
              onClick={() => void sources.reloadOverview()}
            >
              <RefreshCw />
              Try again
            </Button>
          }
        />
      );
    }
    return (
      <CenteredState icon={<LoaderCircle className="animate-spin" />} title="Loading sources…" />
    );
  }

  if (sources.overview.projectState !== "initialized") {
    const conflicting = sources.overview.projectState === "conflicting";
    return (
      <CenteredState
        icon={conflicting ? <AlertCircle /> : <Library />}
        title={conflicting ? "Scient project setup needs attention" : "Set up this Scient project"}
        description={
          conflicting
            ? (sources.overview.issues[0]?.message ?? "Scient will not change conflicting files.")
            : (setupError ??
              "The Library is kept in this project so it stays portable and reviewable.")
        }
        action={
          conflicting ? null : (
            <Button
              disabled={settingUpProject}
              onClick={() => {
                const prepared = readPreparedConnection(props.environmentId);
                if (!prepared) {
                  setSetupError("This environment is not connected.");
                  return;
                }
                setSetupError(null);
                setSettingUpProject(true);
                void initializeScientProjectForOpening({
                  prepared,
                  root: props.root,
                  title: props.projectTitle,
                })
                  .then(() => sources.refreshOverview())
                  .catch((cause: unknown) => {
                    setSetupError(
                      cause instanceof Error ? cause.message : "Scient project setup failed.",
                    );
                  })
                  .finally(() => setSettingUpProject(false));
              }}
            >
              {settingUpProject ? <LoaderCircle className="animate-spin" /> : null}
              Set up Scient project
            </Button>
          )
        }
      />
    );
  }

  if (sources.preflight) {
    return (
      <ImportReview
        key={sources.preflight.items.map((item) => item.candidate.sourceKey).join("\0")}
        preflight={sources.preflight}
        adapter={sources.preflightAdapter ?? "zotero"}
        busy={sources.busy}
        readOnly={!canChange}
        error={sources.error}
        onDismissError={sources.clearError}
        onBack={sources.resetImport}
        onImport={(itemKeys, possibleMetadataMatchOverrides) =>
          revealImportedSource(sources.runImport(itemKeys, possibleMetadataMatchOverrides))
        }
      />
    );
  }

  if (sources.library) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-border p-3">
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={sources.closeLibrary}
            aria-label="Go back"
          >
            <ChevronLeft />
          </Button>
          <div className="flex min-w-0 items-center gap-2">
            <ZoteroMark />
            <div className="truncate text-sm font-medium">Import from Zotero</div>
          </div>
          <Menu>
            <MenuTrigger
              render={
                <Button variant="ghost" size="xs" className="max-w-48">
                  {sources.zoteroScope.kind === "collection" ? (
                    <Folder />
                  ) : sources.zoteroGroupId ? (
                    <Users />
                  ) : (
                    <Library />
                  )}
                  <span className="truncate">
                    {selectedZoteroCollection?.name ?? zoteroLibraryName}
                  </span>
                </Button>
              }
            />
            <MenuPopup align="start" side="bottom" className="max-h-80 min-w-56 overflow-y-auto">
              {sources.zoteroMyLibrary ? (
                <MenuItem
                  onClick={() => {
                    setQuery("");
                    setSelectedKeys(new Set());
                    void (sources.zoteroGroupId
                      ? sources.selectZoteroLibrary(null)
                      : sources.selectZoteroScope({ kind: "library" }));
                  }}
                >
                  <Library />
                  My Library
                </MenuItem>
              ) : null}
              {sources.zoteroGroups.map((group) => (
                <MenuItem
                  key={group.groupId}
                  title={group.name}
                  onClick={() => {
                    setQuery("");
                    setSelectedKeys(new Set());
                    void (sources.zoteroGroupId === group.groupId
                      ? sources.selectZoteroScope({ kind: "library" })
                      : sources.selectZoteroLibrary(group.groupId));
                  }}
                >
                  <Users />
                  <span className="min-w-0 truncate">{group.name}</span>
                </MenuItem>
              ))}
              {sources.zoteroGroups.length > 0 && zoteroCollectionChoices.length > 0 ? (
                <MenuSeparator />
              ) : null}
              {zoteroCollectionChoices.map((collection) => (
                <MenuItem
                  key={collection.key}
                  title={collection.label}
                  onClick={() => {
                    setQuery("");
                    setSelectedKeys(new Set());
                    void sources.selectZoteroScope({
                      kind: "collection",
                      collectionKey: collection.key,
                      includeSubcollections: false,
                    });
                  }}
                >
                  <Folder />
                  <span className="min-w-0 truncate">{collection.label}</span>
                </MenuItem>
              ))}
            </MenuPopup>
          </Menu>
          <form
            className="min-w-[12rem] flex-[1_1_14rem]"
            onSubmit={(event) => {
              event.preventDefault();
              void sources.searchZotero(query);
            }}
          >
            <div className="flex h-8 min-w-0 cursor-text items-center gap-2 rounded-md px-2 py-1.5 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-within:bg-accent focus-within:text-accent-foreground">
              <Search className="size-4 shrink-0 text-muted-foreground/80" aria-hidden="true" />
              <Input
                nativeInput
                unstyled
                type="search"
                aria-label="Search Zotero library"
                placeholder="Search title, creator, or year"
                value={query}
                onChange={(event) => setQuery(event.currentTarget.value)}
                size="inline"
                className="min-w-0 flex-1"
              />
              {query ? (
                <Button
                  type="button"
                  size="icon-micro"
                  variant="ghost-muted"
                  className="shrink-0"
                  aria-label="Clear Zotero search"
                  onClick={() => {
                    setQuery("");
                    void sources.searchZotero("");
                  }}
                >
                  <X />
                </Button>
              ) : null}
            </div>
          </form>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={!canChange || sources.busy || sources.library.total === 0}
                  onClick={() => revealImportedSource(sources.importZoteroScope())}
                >
                  <Download />
                  {sources.zoteroScope.kind === "collection" ? "Import collection" : "Import all"}
                </Button>
              }
            />
            <TooltipPopup side="bottom">
              {sources.zoteroScope.kind === "collection"
                ? `Import ${sources.library.total} references in this collection`
                : `Import all ${sources.library.total} references in ${zoteroLibraryName}`}
            </TooltipPopup>
          </Tooltip>
        </div>
        {sources.error ? (
          <div className="flex shrink-0 items-center justify-between gap-3 border-b border-destructive/20 bg-destructive/5 px-3 py-2 text-xs text-destructive">
            <span className="min-w-0 truncate">{sources.error}</span>
            <Button
              size="xs"
              variant="ghost"
              disabled={sources.busy}
              onClick={() => void sources.searchZotero(query, 0)}
            >
              Try again
            </Button>
          </div>
        ) : null}
        {selectedKeys.size > 0 ? (
          <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border bg-muted/30 px-3 py-2">
            <span className="text-xs text-muted-foreground">
              {selectedKeys.size} reference{selectedKeys.size === 1 ? "" : "s"} selected
            </span>
            <Button
              size="xs"
              variant="ghost"
              disabled={!canChange || sources.busy}
              onClick={() => revealImportedSource(sources.previewImport([...selectedKeys]))}
            >
              <Download />
              {selectedKeys.size === 1 ? "Import" : `Import ${selectedKeys.size}`}
            </Button>
          </div>
        ) : null}
        <ScrollArea className="min-h-0 flex-1">
          <div className="divide-y divide-border">
            {sources.library.items.map((item) => {
              const key = item.sourceKey;
              const checked = selectedKeys.has(key);
              const creator = item.creators[0];
              return (
                <label
                  key={key}
                  className={`flex cursor-pointer items-start gap-3 px-3 py-3 transition-colors hover:bg-accent/40 ${checked ? "bg-accent/35" : ""}`}
                >
                  <Checkbox
                    checked={checked}
                    className="size-4"
                    onCheckedChange={() => toggleSelected(key)}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium">
                      {item.title ?? "Untitled source"}
                    </span>
                    <span className="mt-0.5 block text-xs text-muted-foreground">
                      {creator?.familyName ?? creator?.literalName ?? "Unknown creator"}
                      {item.issuedYear ? ` · ${item.issuedYear}` : ""}
                      {item.pdfAvailable ? " · PDF" : ""}
                    </span>
                  </span>
                </label>
              );
            })}
            {sources.library.items.length === 0 && sources.busy ? (
              <div className="flex items-center justify-center gap-2 p-8 text-sm text-muted-foreground">
                <LoaderCircle className="size-4 animate-spin" />
                Loading Zotero…
              </div>
            ) : sources.library.items.length === 0 ? (
              <div className="p-8 text-center text-sm text-muted-foreground">
                {query.trim()
                  ? "No matching Zotero references were found."
                  : sources.library.total === 0
                    ? "Your Zotero library is empty. Add references in Zotero, then refresh."
                    : "No importable references were found in this part of your Zotero library."}
              </div>
            ) : null}
            {sources.library.hasMore ? (
              <div className="flex justify-center p-3">
                <Button
                  variant="outline"
                  disabled={sources.busy}
                  onClick={() => void sources.searchZotero(query, sources.library?.nextStart ?? 0)}
                >
                  {sources.busy ? <LoaderCircle className="animate-spin" /> : null}
                  Load more
                </Button>
              </div>
            ) : null}
          </div>
        </ScrollArea>
      </div>
    );
  }

  if (sources.zoteroStatus && sources.zoteroStatus.state !== "ready") {
    const status = sources.zoteroStatus;
    const connectionMessage =
      status.connection === "web"
        ? status.message
        : status.state === "unreachable"
          ? "Open Zotero on this computer to continue."
          : status.state === "access-disabled"
            ? "Allow local Zotero access to continue."
            : status.state === "incompatible"
              ? "This Zotero version is not supported."
              : "Scient could not verify Zotero.";
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <PanelHeader
          title={
            <span className="flex min-w-0 items-center gap-2">
              <ZoteroMark />
              <span className="truncate">Import from Zotero</span>
            </span>
          }
          onBack={sources.closeZoteroStatus}
        />
        <div className="scrollbar-gutter-both flex min-h-0 flex-1 items-start justify-center overflow-y-auto px-6 pt-[clamp(2rem,7vh,4.5rem)] pb-6">
          <div className="w-full max-w-md">
            <p className="text-base leading-relaxed text-foreground">{connectionMessage}</p>
            <div className="mt-6 flex w-44 flex-col items-stretch gap-1">
              <Button
                size="sm"
                variant="ghost-muted"
                className="w-full justify-start"
                disabled={sources.checkingZotero}
                aria-busy={sources.checkingZotero}
                onClick={() => void sources.openZoteroLibrary(true)}
              >
                {sources.checkingZotero ? <LoaderCircle className="animate-spin" /> : <RefreshCw />}
                Check again
              </Button>
              {status.state === "unreachable" ? (
                <Button
                  size="sm"
                  variant="ghost-muted"
                  className="w-full justify-start"
                  onClick={() =>
                    void readLocalApi()?.shell.openExternal("https://www.zotero.org/download/")
                  }
                >
                  <ExternalLink />
                  Download Zotero
                </Button>
              ) : null}
              <Popover>
                <PopoverTrigger
                  render={
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost-muted"
                      className="w-full justify-start"
                    >
                      <BookOpen />
                      How to connect
                    </Button>
                  }
                />
                <PopoverPopup
                  side="bottom"
                  align="end"
                  className="w-[min(20rem,calc(100vw-1.5rem))] [--popup-width:min(20rem,calc(100vw-1.5rem))]"
                >
                  <div className="grid gap-2 text-xs leading-relaxed">
                    <p className="text-sm font-medium text-foreground">Connect Zotero</p>
                    <ol className="list-decimal space-y-1 pl-4 text-muted-foreground">
                      <li>Open Zotero on this computer.</li>
                      <li>
                        In Zotero, open Settings → Advanced and enable “Allow other applications on
                        this computer to communicate with Zotero.”
                      </li>
                      <li>Return here and choose Check again.</li>
                    </ol>
                    <p className="text-muted-foreground">
                      Without Zotero on this computer, add a Zotero API key in Accounts to use your
                      library on zotero.org.
                    </p>
                  </div>
                </PopoverPopup>
              </Popover>
            </div>
            <div
              className="mt-5 min-h-4 text-xs text-muted-foreground"
              role="status"
              aria-live="polite"
            >
              {sources.zoteroCheckFeedback}
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (selectedRecord) {
    if (editingSource) {
      return (
        <SourceEditor
          key={selectedRecord.sourceId}
          environmentId={props.environmentId}
          root={props.root}
          record={selectedRecord}
          onCancel={() => setEditingSource(false)}
          onRefreshed={sources.acceptSourceRecord}
          onSaved={(record) => {
            sources.acceptSourceRecord(record);
            setEditingSource(false);
            void sources.reloadOverview();
          }}
        />
      );
    }
    return (
      <>
        <SourcesNameDialog request={nameRequest} onClose={() => setNameRequest(null)} />
        <SourceDetails
          key={selectedRecord.sourceId}
          record={selectedRecord}
          readOnly={!canChange}
          {...(scopes
            ? {
                library: {
                  canSavePersonalNote,
                  onSavePersonalNote: async (note: string | null, expectedRevision: number) => {
                    const result = await updateScientSourcePersonalNote(props.environmentId, {
                      root: props.root,
                      sourceId: selectedRecord.sourceId,
                      expectedRevision,
                      note,
                    });
                    if (panelMounted.current && panelContextRef.current === panelContext) {
                      sources.acceptSourceRecord(result.record);
                    }
                    return result;
                  },
                  ...(canSetReading
                    ? {
                        onSetReadingState: (change: ReadingStateChange) =>
                          setReadingState([selectedRecord.sourceId], change, false),
                      }
                    : {}),
                  ...(canChangeProject
                    ? {
                        onAddToProject: () => addToProject([selectedRecord]),
                        onRemoveFromProject: () => removeFromProject([selectedRecord]),
                      }
                    : {}),
                },
              }
            : {})}
          citationProject={{ environmentId: props.environmentId, root: props.root }}
          diagnostics={diagnosticsBySourceId.get(selectedRecord.sourceId) ?? []}
          organize={
            <SourceOrganizeSection
              organize={organize}
              sourceId={selectedRecord.sourceId}
              tags={selectedRecord.tags}
              records={sources.overview.records}
              onRequestName={setNameRequest}
              onShowTag={(tag) => {
                setEditingSource(false);
                setSelectedSourceId(null);
                organize.showTag(tag);
              }}
              onShowCollection={(collectionId) => {
                setEditingSource(false);
                setSelectedSourceId(null);
                organize.showCollection(collectionId);
              }}
              onShowCategory={(category) => {
                setEditingSource(false);
                setSelectedSourceId(null);
                organize.showOnly(category);
              }}
            />
          }
          onBack={() => {
            setEditingSource(false);
            setSelectedSourceId(null);
          }}
          onEdit={() => setEditingSource(true)}
          onSaveNote={(note, expectedRevision) =>
            sources.saveSourceNote(selectedRecord.sourceId, expectedRevision, note)
          }
          onRefreshMetadata={async () => {
            const result = await sources.refreshSourceMetadata(
              selectedRecord.sourceId,
              selectedRecord.revision,
            );
            if (!panelMounted.current || panelContextRef.current !== panelContext) return;
            sources.acceptSourceRecord(result.record);
            if (result.outcome === "refreshed") void sources.reloadOverview();
            toastManager.add({
              type:
                result.outcome === "refreshed" || result.outcome === "unchanged"
                  ? "success"
                  : "warning",
              title:
                result.outcome === "refreshed"
                  ? "Metadata refreshed"
                  : result.outcome === "unchanged"
                    ? "Metadata is already up to date"
                    : result.outcome === "stale"
                      ? "Source changed while metadata was refreshed"
                      : result.outcome === "duplicate"
                        ? "Metadata refresh stopped"
                        : "Metadata cannot be refreshed yet",
              description: result.message ?? undefined,
            });
          }}
          onRemove={() => moveToTrash(selectedRecord)}
          onSendToZotero={(groupId) =>
            void zoteroSync.sendToZotero(selectedRecord.sourceId, groupId)
          }
          zoteroWritableGroups={zoteroSync.writableGroups}
          onSourceActionsOpen={zoteroSync.loadWritableGroups}
          onOpenHistory={() => setHistorySourceId(selectedRecord.sourceId)}
          onGetPdf={async () => {
            const doi = selectedRecord.identifiers.find(
              (identifier) => identifier.scheme.toLowerCase() === "doi",
            )?.value;
            const result = await getPaper({
              root: props.root,
              sourceId: selectedRecord.sourceId,
              expectedRevision: selectedRecord.revision,
              ...(doi ? { doi } : {}),
              ...(selectedRecord.url ? { url: selectedRecord.url } : {}),
            });
            if (!result.ok) return;
            if (result.value.status === "attached") {
              await sources.refreshOverview();
              toastManager.add({
                type: "success",
                title: result.value.published
                  ? "PDF attached"
                  : "PDF attached: an accepted manuscript or preprint",
              });
              return;
            }
            // Anything waiting for the user is on the band above Sources, with its action.
            toastManager.add({
              type: result.value.status === "needs-you" ? "info" : "error",
              title: result.value.message,
            });
          }}
          onOpenPdf={props.onOpenPdf}
          annotations={
            <SourceAnnotations
              environmentId={props.environmentId}
              root={props.root}
              record={selectedRecord}
              onOpenPdf={props.onOpenPdf}
            />
          }
        />
        {historySourceId === selectedRecord.sourceId ? (
          <SourceHistoryDialog
            key={`${selectedRecord.sourceId}:${selectedRecord.revision}`}
            environmentId={props.environmentId}
            root={props.root}
            sourceId={selectedRecord.sourceId}
            revision={selectedRecord.revision}
            onClose={() => setHistorySourceId(null)}
            onReverted={(record) => {
              sources.acceptSourceRecord(record);
              void sources.reloadOverview();
            }}
          />
        ) : null}
      </>
    );
  }

  if (showingDuplicates && scopes) {
    return (
      <LibraryDuplicatesView
        environmentId={props.environmentId}
        root={props.root}
        organize={organize}
        canChange={canChangeProject}
        initialSection={showingDuplicates}
        onBack={() => setShowingDuplicates(null)}
        onMerged={leaveSelection}
      />
    );
  }

  if (showingReviews) {
    return (
      <SystematicReviewsView
        environmentId={props.environmentId}
        root={props.root}
        records={sources.overview.records}
        organization={organize.organization}
        selectedSourceIds={[...organize.selection]}
        sourceDetails={sources.sourceDetails}
        loadSource={sources.loadSource}
        onOpenSource={openSourceDetails}
        onBack={() => setShowingReviews(false)}
      />
    );
  }

  return (
    <div
      className="flex min-h-0 flex-1 flex-col"
      onDragOver={(event) => {
        if (!canChange || !event.dataTransfer.types.includes("Files")) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
        setDragActive(true);
      }}
      onDragLeave={(event) => {
        if (event.currentTarget === event.target) setDragActive(false);
      }}
      onDrop={(event) => {
        event.preventDefault();
        setDragActive(false);
        if (!canChange || !event.dataTransfer.files.length) return;
        const [dropped] = event.dataTransfer.files;
        if (event.dataTransfer.files.length === 1 && dropped && isReferenceFileName(dropped.name)) {
          importReferenceFile(dropped);
          return;
        }
        setSelectedSourceId(null);
        setImportOutcome(null);
        revealImportedSource(sources.uploadLocalFiles([...event.dataTransfer.files]), false);
      }}
    >
      <input
        ref={localFileInput}
        className="sr-only"
        type="file"
        accept="application/pdf,.pdf"
        multiple
        tabIndex={-1}
        aria-hidden="true"
        onChange={(event) => {
          const files = [...(event.currentTarget.files ?? [])];
          event.currentTarget.value = "";
          revealImportedSource(sources.uploadLocalFiles(files), files.length === 1);
        }}
      />
      <input
        ref={referenceFileInput}
        className="sr-only"
        type="file"
        accept=".bib,.bibtex,.biblatex,.ris,.json,.xml,.txt"
        tabIndex={-1}
        aria-hidden="true"
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = "";
          if (file) importReferenceFile(file);
        }}
      />
      <PaperQueueBand
        environmentId={props.environmentId}
        root={props.root}
        threadId={props.threadId}
      />
      <PanelHeader
        title="Library"
        action={
          <div className="flex shrink-0 items-center gap-1">
            <UniversityCrest environmentId={props.environmentId} threadId={props.threadId} />
            <Menu>
              <MenuTrigger
                render={
                  <Button
                    size="xs"
                    variant="ghost"
                    disabled={!canChange || sources.busy || sources.checkingZotero}
                    aria-label="Import sources"
                  >
                    {sources.busy || sources.checkingZotero ? (
                      <LoaderCircle className="animate-spin" />
                    ) : (
                      <Download />
                    )}
                    <span className="@max-[20rem]:hidden">Import sources</span>
                  </Button>
                }
              />
              <MenuPopup align="end" side="bottom" className="min-w-44">
                <MenuItem onClick={() => localFileInput.current?.click()}>
                  <FileUp />
                  Import PDF files
                </MenuItem>
                <MenuItem
                  onClick={() => {
                    setSelectedSourceId(null);
                    setImportOutcome(null);
                    sources.clearOperationSummary();
                    void sources.openZoteroLibrary();
                  }}
                >
                  <ZoteroMark />
                  Import from Zotero
                </MenuItem>
                {hasZoteroSources ? (
                  <MenuItem onClick={() => void zoteroSync.startRefresh()}>
                    <RefreshCw />
                    Refresh from Zotero
                  </MenuItem>
                ) : null}
                <MenuItem onClick={() => setAddingByIdentifier(true)}>
                  <Hash />
                  Add by identifier
                </MenuItem>
                <MenuItem onClick={() => referenceFileInput.current?.click()}>
                  <FileText />
                  Import a reference file
                </MenuItem>
              </MenuPopup>
            </Menu>
            <SourcesHeaderMenu
              environmentId={props.environmentId}
              root={props.root}
              totalCount={sources.overview?.records.length ?? 0}
              exportScope={
                organize.selection.size > 0
                  ? { kind: "selected", sourceIds: [...organize.selection] }
                  : sourceQuery.trim() || listFilterActive
                    ? {
                        kind: "shown",
                        sourceIds: filteredSourceRecords.map((record) => record.sourceId),
                      }
                    : null
              }
              trashedCount={sources.overview.trashedCount ?? 0}
              onTrashChanged={sources.refreshOverview}
              missingPdfCount={canChange ? missingPdfs.length : 0}
              onGetMissingPdfs={() => void requestPapers({ root: props.root, papers: missingPdfs })}
              onOpenReviews={() => setShowingReviews(true)}
              {...(scopes ? { onOpenDuplicates: () => setShowingDuplicates("pairs") } : {})}
              onOpenSource={setSelectedSourceId}
              {...(props.onOpenFile ? { onOpenFile: props.onOpenFile } : {})}
              {...(move.canMoveBack ? { onMoveBack: () => void move.moveBack() } : {})}
            />
          </div>
        }
      />
      {dragActive ? (
        <div className="mx-3 mt-2 rounded-md border border-dashed border-foreground/30 bg-muted/35 px-3 py-2 text-center text-xs text-muted-foreground">
          Drop PDFs or a reference file to add them to the Library
        </div>
      ) : null}
      {sources.importPreparation ? (
        <div className="mx-3 mt-3 flex items-center gap-2 rounded-md bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          <LoaderCircle className="size-4 shrink-0 animate-spin" />
          <span className="truncate">
            {sources.importPreparation.kind === "file"
              ? `Reading references… ${sources.importPreparation.name}`
              : "Reading article metadata…"}
            {sources.importPreparation.kind === "local-files" &&
            sources.importPreparation.names.length === 1
              ? ` ${sources.importPreparation.names[0]}`
              : ""}
          </span>
        </div>
      ) : null}
      {sources.error ? (
        <SourceErrorBanner message={sources.error} onDismiss={sources.clearError} />
      ) : null}
      <LibraryMoveNotice
        move={move}
        {...(scopes ? { onReview: () => setShowingDuplicates("merged") } : {})}
      />
      <SourceStoreNotice unreadable={sources.overview.unreadableRecords ?? []} />
      <ZoteroRefreshDialog
        state={zoteroSync.refresh}
        resolving={zoteroSync.resolving}
        onClose={zoteroSync.closeRefresh}
        onResolve={(sourceId, field, side) =>
          void zoteroSync.resolveConflict(sourceId, field, side)
        }
      />
      {bibliography.status ? (
        <ManagedBibliographyNotice
          files={bibliography.status.files}
          replacing={bibliography.replacing || !bibliography.canChange}
          onResolve={(name, action) => void bibliography.resolve(name, action)}
        />
      ) : null}
      {addingByIdentifier ? (
        <AddByIdentifier
          environmentId={props.environmentId}
          root={props.root}
          {...(sources.overview?.scopes?.listed === "library" ? { pin: false as const } : {})}
          onClose={() => setAddingByIdentifier(false)}
          onAdded={(results) => {
            const added = results.flatMap((item) =>
              item.outcome === "imported" && item.sourceId ? [item.sourceId] : [],
            );
            if (added.length > 0) {
              setRecentlyAddedSourceIds(rememberRecentSourceAdds(panelContext, added));
              toastManager.add({
                type: "success",
                title: added.length === 1 ? "Added 1 source" : `Added ${added.length} sources`,
                ...(sources.overview?.scopes?.listed === "library"
                  ? { description: inLibraryNotProjectLabel(added.length) }
                  : {}),
              });
            }
            void sources.refreshOverview();
          }}
          onOpenSource={(sourceId) => {
            setEditingSource(false);
            setSelectedSourceId(sourceId);
          }}
        />
      ) : null}
      {sources.operation ? (
        <ImportSummary
          operation={sources.operation}
          outcome={
            importOutcome?.operation?.operationId === sources.operation.operationId
              ? importOutcome
              : null
          }
          onDismiss={() => {
            setImportOutcome(null);
            sources.clearOperationSummary();
          }}
          onCancel={() => void sources.cancelImport()}
          cancelling={sources.cancelling}
          {...(scopes && !sources.operation.pinInstanceId
            ? {
                libraryOnly: canChangeProject
                  ? {
                      onAddToProject: (sourceIds: ReadonlyArray<string>) =>
                        void addToProject(sourceIds.map((sourceId) => ({ sourceId }))).then(() => {
                          setImportOutcome(null);
                          sources.clearOperationSummary();
                        }),
                    }
                  : {},
              }
            : {})}
          {...(canChange &&
          sources.operation.state !== "cancelled" &&
          sources.operation.items.some((item) => item.state === "failed")
            ? {
                onRetryFailed: () => {
                  setImportOutcome(null);
                  void sources.retryFailedImport();
                },
              }
            : {})}
        />
      ) : importOutcome?.kind === "already-present" ? (
        <AlreadyPresentSummary
          outcome={importOutcome}
          onDismiss={() => setImportOutcome(null)}
          {...(importOutcome.existingSourceId
            ? {
                onViewExisting: () => {
                  setEditingSource(false);
                  setSelectedSourceId(importOutcome.existingSourceId);
                },
              }
            : {})}
        />
      ) : null}
      {referenceFileImport ? (
        <ReferenceFileReport
          fileName={referenceFileImport.file.name}
          report={referenceFileImport.report}
          busy={sources.busy || !canChange}
          onContinue={() => importReferenceFile(referenceFileImport.file)}
          onDismiss={() => setReferenceFileImport(null)}
        />
      ) : null}
      {sources.overview.records.length > 0 && (organize.selection.size > 0 || organize.progress) ? (
        <SourcesBulkBar
          organize={organize}
          records={sources.overview.records}
          visibleSourceIds={filteredSourceRecords.map((record) => record.sourceId)}
          onRequestName={setNameRequest}
          onRemove={async (records) => {
            const removed: string[] = [];
            let alsoElsewhere = 0;
            // Each removal is its own request; the list is read again once, after the last.
            for (const record of records) {
              const result = await sources
                .removeSource(record.sourceId, record.revision, { refresh: false })
                .catch(() => null);
              if (result?.outcome === "removed") removed.push(record.sourceId);
              if (result?.outcome === "removed" && result.alsoPinnedIn) alsoElsewhere += 1;
            }
            await sources.reloadOverview();
            announceSourcesMovedToTrash({
              environmentId: props.environmentId,
              root: props.root,
              sourceIds: removed,
              notRemoved: records.length - removed.length,
              ...(alsoElsewhere > 0 ? { alsoElsewhere } : {}),
              onRestored: sources.refreshOverview,
            });
          }}
          {...(scopes
            ? {
                library: {
                  listed: scopes.listed,
                  ...(canSetReading
                    ? {
                        onSetReadingState: (
                          sourceIds: ReadonlyArray<string>,
                          change: ReadingStateChange,
                        ) => setReadingState(sourceIds, change, true),
                      }
                    : {}),
                  onAddToProject: addToProject,
                  onRemoveFromProject: removeFromProject,
                },
              }
            : {})}
        />
      ) : sources.overview.records.length > 0 ? (
        <div className="mt-2 mb-1 ml-3 mr-4 flex min-h-8 shrink-0 items-center gap-1 rounded-md text-sm text-muted-foreground">
          <div className="flex min-w-0 flex-1 cursor-text items-center gap-2 rounded-md px-2 transition-colors hover:bg-accent hover:text-accent-foreground focus-within:bg-accent focus-within:text-accent-foreground">
            <Search className="size-4 shrink-0 text-muted-foreground/80" aria-hidden="true" />
            <Input
              nativeInput
              unstyled
              type="search"
              aria-label="Search project sources"
              placeholder="Search sources"
              value={sourceQuery}
              onChange={(event) => setSourceQuery(event.currentTarget.value)}
              size="inline"
              className="min-w-0 flex-1"
            />
            {sourceQuery ? (
              <Button
                type="button"
                size="icon-micro"
                variant="ghost-muted"
                className="shrink-0"
                aria-label="Clear source search"
                onClick={() => setSourceQuery("")}
              >
                <X />
              </Button>
            ) : null}
          </div>
          <SourcesFilterMenu
            organize={organize}
            records={sources.overview.records}
            query={sourceQuery}
            onRequestName={setNameRequest}
            {...(sources.overview.scopes
              ? {
                  scopes: sources.overview.scopes,
                  onSelectScope: (scope) => void sources.selectScope(scope),
                }
              : {})}
          />
          <Select
            value={sourceSort}
            items={SCIENT_SOURCE_SORT_OPTIONS}
            onValueChange={(value) => {
              if (SCIENT_SOURCE_SORT_OPTIONS.some((option) => option.value === value)) {
                setSourceSort(value as ScientSourceSort);
              }
            }}
          >
            <SelectTrigger
              size="compact"
              variant="ghost"
              className="w-auto shrink-0 cursor-pointer"
              aria-label="Sort sources"
            >
              <ArrowDownUp className="size-3.5" aria-hidden="true" />
              <SelectValue className="max-w-20" />
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {SCIENT_SOURCE_SORT_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </div>
      ) : null}
      {sources.overview.records.length > 0 &&
      organize.selection.size === 0 &&
      !organize.progress ? (
        <SourcesActiveFilters
          organize={organize}
          matchCount={filteredSourceRecords.length}
          onRequestName={setNameRequest}
        />
      ) : null}
      <SourcesNameDialog request={nameRequest} onClose={() => setNameRequest(null)} />
      <SnapshotRemovalDialog actions={libraryActions} />
      {sources.overview.records.length === 0 ? (
        <>
          <UniversityRow environmentId={props.environmentId} threadId={props.threadId} />
          <CenteredState
            icon={<BookOpen />}
            title="No sources yet"
            description="Import PDFs, a reference file (.bib, RIS, CSL-JSON, EndNote XML) or Zotero. Scient keeps a portable project copy."
          />
        </>
      ) : (
        <SourcesList
          records={filteredSourceRecords}
          row={sourceRow}
          virtualized={scopes !== undefined}
          header={
            sourceQuery ? null : (
              <UniversityRow environmentId={props.environmentId} threadId={props.threadId} />
            )
          }
          footer={
            <SourceFullTextResults
              environmentId={props.environmentId}
              root={props.root}
              query={sourceQuery}
              metadataMatchCount={filteredSourceRecords.length}
              sourceIds={
                listFilterActive
                  ? filterScientSourceSearchIndex(
                      sourceSearchIndex,
                      "",
                      organize.filter,
                      organize.organization,
                    )
                      .filter((record) => matchesReadingFilter(record, readingFilter))
                      .map((record) => record.sourceId)
                  : undefined
              }
              onOpenHit={(hit) => {
                requestSourceTextReveal(props.root, hit);
                props.onOpenPdf(hit);
              }}
            />
          }
        />
      )}
    </div>
  );
}
