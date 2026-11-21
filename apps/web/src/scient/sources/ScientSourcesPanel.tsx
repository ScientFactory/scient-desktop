import { T, useGT, useMessages } from "gt-react";
import {
  scientSourcesMayBeVersions,
  type ScientSourceIdentifierAddItem,
} from "@scientfactory/scient-sources";
import type {
  EnvironmentId,
  ScientSourceDetailResult,
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
  LayoutGrid,
  Library,
  List as ListIcon,
  LoaderCircle,
  RefreshCw,
  Search,
  Users,
  X,
} from "lucide-react";
import * as Schema from "effect/Schema";
import {
  type ReactNode,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useSyncExternalStore,
  useRef,
  useState,
} from "react";

import { Toggle, ToggleGroup } from "../../components/ui/toggle-group";
import { Button } from "../../components/ui/button";
import { managedBibliographyActivity } from "./ManagedBibliographyNotice";
import { useManagedBibliography } from "./useManagedBibliography";
import { useLibrarySourceRequest, useLibraryVersionStore } from "./librarySourceRequest";
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
import { ProjectSourceUses } from "./SourceUses";
import { AddByIdentifier, identifierAddResult } from "./AddByIdentifier";
import { AskLibraryButton } from "./AskLibraryButton";
import { ImportReview } from "./ImportReview";
import { importResultContent, RunningImportBody } from "./ImportSummary";
import { CenteredState, PanelHeader, SOURCES_COLUMN } from "./PanelChrome";
import { SourceDetails } from "./SourceDetails";
import { SourceEditor } from "./SourceEditor";
import { SourceFullTextResults } from "./SourceFullTextResults";
import type { SourceRowContext } from "./SourceRow";
import { showSourceRowMenu } from "./sourceRowMenu";
import { libraryBackupActivity, libraryCopyEndingResult, useLibraryBackup } from "./LibraryBackup";
import { JoinDifferencesDialog } from "./JoinDifferences";
import { RecentChangesDialog } from "./RecentChanges";
import { RECENT_CHANGES_LABELS } from "./recentChangeLabels";
import { SourceCards } from "./SourceCards";
import { SourcesList } from "./SourcesList";
import { scientSourceSections } from "./sourceSections";
import { requestSourceTextReveal } from "./sourceTextReveal";
import { useLibraryFileImport } from "./libraryFileHandoff";
import { newlyObservedSourceIds } from "./sourceLabels";
import { NOTICE_CHANGES_SHOWN } from "./sourceLifecycleLabels";
import {
  filterScientSourceSearchIndex,
  indexScientSourceSummaries,
  sortScientSourceRecords,
  type ScientSourceSort,
} from "./filterSources";
import { SCIENT_SOURCE_SORT_OPTIONS } from "./filterSourcesCopy";
import {
  importedSourceIdToReveal,
  importedSourceIds,
  type ImportTarget,
  type ScientSourcesImportOutcome,
} from "./importOutcome";
import { SourceHistoryDialog } from "./SourceHistory";
import { sourceStoreActivity } from "./SourceStoreNotice";
import { LibraryDuplicatesView, type DuplicatesSection } from "./LibraryDuplicates";
import { libraryMoveActivity } from "./LibraryMoveNotice";
import { libraryNoticeChangesActivity } from "./LibraryNoticeChanges";
import { useLibraryMoveStatus } from "./useLibraryMoveStatus";
import { announceSourceMovedToTrash } from "./SourceTrash";
import { shownSourceRecord } from "./sourcesWorkflow";
import { useScientSources } from "./useScientSources";
import { SourceFiling } from "./SourceOrganizeSection";
import {
  SourcesActivityButton,
  SourcesResultSlot,
  sourcesStateActivity,
  useSourcesResult,
} from "./SourcesActivity";
import {
  selectSourcesActivity,
  type SourcesActivityItem,
  type SourcesResultContent,
} from "./sourcesFeedback";
import { SourcesActiveFilters } from "./SourcesActiveFilters";
import { announceSourcesMovedToTrash, SourcesBulkBar } from "./SourcesBulkBar";
import { SourcesFilterMenu } from "./SourcesFilterMenu";
import { SourcesNameDialog, type SourcesNameRequest } from "./SourcesNameDialog";
import { useSourcesOrganize } from "./useSourcesOrganize";
import { SystematicReviewsView } from "./SystematicReviews";
import { isReferenceFileName } from "./referenceFileSummary";
import { SourcesHeaderMenu } from "./SourcesHeaderMenu";
import { ImportPackageSubmenu } from "./ProjectPackageMenu";
import { sourcesCommands, useCanChangeLibrary, useCanRunSourcesCommand } from "./sourcesCommands";
import {
  organizeScientSources,
  readScientSource,
  updateScientSourceNote,
  updateScientSourcePersonalNote,
} from "./client";
import {
  emptySourcesLabel,
  inLibraryNotProjectLabel,
  LIBRARY_LABELS,
  matchesReadingFilter,
  type ReadingStateChange,
  libraryElsewhereLabel,
} from "./libraryLabels";
import { useEnvironment, usePrimaryEnvironmentId } from "../../state/environments";
import { SnapshotRemovalDialog, useLibraryProjectActions } from "./useLibraryProjectActions";
import { accountsState } from "../accounts/accountsState";
import { UniversityCrest } from "../accounts/University";
import { PaperQueueBand } from "../accounts/PaperRequests";
import { useStableCallback } from "~/hooks/useStableCallback";
import { readLocalStorageValue, writeLocalStorageValue } from "~/hooks/useLocalStorage";
import { ScientTooltip } from "../presentation/ScientTooltip";
import { useAccountCommand, useAccounts } from "../accounts/useAccounts";

type SourceRecord = ScientSourcesOverviewResult["records"][number];
const RECENT_SOURCE_ADD_TTL_MS = 10 * 60 * 1000;
/** Rows or cards: how this computer last showed the list. */
const SOURCE_VIEW_KEY = "scient:sources-view";
const SourceViewSchema = Schema.Literals(["list", "cards"]);
type SourceView = typeof SourceViewSchema.Type;

interface ReferenceFileImport {
  readonly file: File;
  readonly report: ScientSourcesFileImportResult["report"];
}

type ImportIntake = "zotero" | "local-pdf" | "file";

interface ImportReceipt {
  /** The result-slot operation the import began. */
  readonly resultId: string;
  readonly outcome: ScientSourcesImportOutcome | null;
  readonly referenceFile: ReferenceFileImport | null;
  readonly target: ImportTarget;
  readonly intake: ImportIntake;
}

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
  const m = useMessages();
  const gt = useGT();
  const sources = useScientSources({ environmentId: props.environmentId, root: props.root });
  const libraryVersion = useLibraryVersionStore((state) => state.byRoot[props.root] ?? "");
  const canChange = useCanChangeLibrary(props.environmentId);
  const canSetReading = useCanRunSourcesCommand(
    sourcesCommands.setReadingState,
    props.environmentId,
  );
  const canChangeProject = useCanRunSourcesCommand(sourcesCommands.organize, props.environmentId);
  // Each computer has its own Library: one that is not this computer's is named.
  const environment = useEnvironment(props.environmentId);
  const thisComputer = usePrimaryEnvironmentId();
  const panelContext = `${props.environmentId}\0${props.root}`;
  const result = useSourcesResult(panelContext);
  const [activityOpen, setActivityOpen] = useState(false);
  const backup = useLibraryBackup({
    environmentId: props.environmentId,
    root: props.root,
    enabled: sources.overview?.libraryBackend === true,
    onAdded: () => void sources.refreshOverview(),
    onEnded: (ending) =>
      ending.operationId !== null &&
      result.settle(ending.operationId, libraryCopyEndingResult(ending)),
  });
  // A folder is chosen with this computer's own dialog, so only for a Library that is here.
  const pickBackupFolder =
    props.environmentId === thisComputer && window.desktopBridge
      ? readLocalApi()?.dialogs.pickFolder
      : undefined;
  const elsewhere = environment && props.environmentId !== thisComputer ? environment.label : null;
  const canSavePersonalNote = useCanRunSourcesCommand(
    sourcesCommands.updatePersonalNote,
    props.environmentId,
  );
  const zoteroSync = useZoteroSync({
    environmentId: props.environmentId,
    root: props.root,
    allLibrary: sources.overview?.scopes?.listed === "library",
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
  const paperQueue = accounts?.paperQueues?.find((item) => item.root === props.root);
  const papersSaved = paperQueue?.saved;
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
  const [packageSources, setPackageSources] = useState<ReadonlySet<string> | null>(null);
  const [shownSourcesLabel, setShownSourcesLabel] = useState("Papers kept after Undo");
  const [sourceSort, setSourceSort] = useState<ScientSourceSort>("last-added");
  const [sourceView, setSourceView] = useState<SourceView>(() =>
    readLocalStorageValue(SOURCE_VIEW_KEY, "list", SourceViewSchema),
  );
  // The source at the top of the list, so switching views or coming Back keeps the place.
  const topSourceId = useRef<string | null>(null);
  const [viewAnchor, setViewAnchor] = useState<string | null>(null);
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
  const [showingRecentChanges, setShowingRecentChanges] = useState(false);
  /** The join whose differences are shown, over Recent changes. */
  const [showingJoinDifferences, setShowingJoinDifferences] = useState<string | null>(null);
  const [selectedKeys, setSelectedKeys] = useState<ReadonlySet<string>>(new Set());
  const [settingUpProject, setSettingUpProject] = useState(false);
  const [setupError, setSetupError] = useState<string | null>(null);
  const [selectedSourceId, setSelectedSourceId] = useState<string | null>(null);
  const [editingSource, setEditingSource] = useState(false);
  /** The import started here last: the result-slot operation it began, and what it did. */
  const [importReceipt, setImportReceipt] = useState<ImportReceipt | null>(null);
  /** The open Add by identifier dialog, with the result-slot operation it began. */
  const [addingByIdentifier, setAddingByIdentifier] = useState<string | null>(null);
  const panelContextRef = useRef(panelContext);
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

  const [previousPanelContext, setPreviousPanelContext] = useState({ context: panelContext });
  if (previousPanelContext.context !== panelContext) {
    setPreviousPanelContext({ context: panelContext });
    setShowingReviews(false);
    setShowingDuplicates(null);
    setSelectedSourceId(null);
    setEditingSource(false);
    setImportReceipt(null);
    setHistorySourceId(null);
    setSourceQuery("");
    setPackageSources(null);
    setAddingByIdentifier(null);
    setActivityOpen(false);
    setViewAnchor(null);
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
  // Filtering 20,000 rows takes longer than a keystroke should wait: the box shows the letter at
  // once and the list follows.
  const listQuery = useDeferredValue(sourceQuery);
  const filteredSourceRecords = sortScientSourceRecords(
    filterScientSourceSearchIndex(
      sourceSearchIndex,
      listQuery,
      organize.filter,
      organize.organization,
    ).filter(
      (record) =>
        matchesReadingFilter(record, readingFilter) &&
        (!packageSources || packageSources.has(record.sourceId)),
    ),
    sourceSort,
  );
  // oxlint-disable-next-line react/purity -- Last added's headings read the clock whenever the list is derived; one that lags past midnight until the next render is harmless
  const sourceSections = scientSourceSections(filteredSourceRecords, sourceSort, Date.now(), m);
  const listFilterActive =
    packageSources !== null ||
    organize.filterActive ||
    (scopes ? organize.readingFilterActive : false);
  const selectScope = (scope: "project" | "library") => {
    setPackageSources(null);
    organize.clearFilter();
    organize.clearSelection();
    void sources.selectScope(scope);
  };
  // Selecting reloads the list, which also picks up a folder set up just before the request. A
  // project server ignores the scope and keeps listing its project.
  const showWholeLibrary = useStableCallback(() => selectScope("library"));
  useLibrarySourceRequest(
    props.root,
    sources.overview !== null,
    setSelectedSourceId,
    showWholeLibrary,
  );
  // Stable: Activity items built during render hold it, and it reads the panel's refs.
  const showPackageSources = useStableCallback(
    (sourceIds: ReadonlyArray<string>, label?: string) => {
      if (!panelMounted.current || panelContextRef.current !== panelContext) return;
      setShownSourcesLabel(label ?? gt("Papers kept after Undo"));
      setSelectedSourceId(null);
      setShowingReviews(false);
      setShowingDuplicates(null);
      setActivityOpen(false);
      organize.clearFilter();
      organize.clearSelection();
      setPackageSources(new Set(sourceIds));
      void sources.selectScope("library");
    },
  );
  const dismissNoticeChanges = () =>
    void organizeScientSources(props.environmentId, {
      root: props.root,
      change: { action: "dismiss-notice-changes" },
    })
      .then(() => sources.refreshOverview())
      .catch((cause: unknown) => {
        toastManager.add({
          type: "error",
          title: gt("The line was not dismissed"),
          description: scientSourcesErrorMessage(cause, import.meta.env.DEV),
        });
      });
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
  // Stable: the result's actions, built during render, hold it, and it reads the panel's refs.
  const revealImportedSource = useStableCallback(
    (
      work: Promise<ScientSourcesImportOutcome | null>,
      options: {
        readonly intake: ImportIntake;
        /** Opens the one source an import brought. */
        readonly reveal?: boolean;
        readonly referenceFile?: () => ReferenceFileImport | null;
      },
    ) => {
      const requestedContext = panelContext;
      const request = ++importRevealRequest.current;
      const resultId = result.begin();
      const target: ImportTarget = scopes
        ? scopes.listed === "library"
          ? "library"
          : "project"
        : "project-folder";
      void work.then((outcome) => {
        if (!panelMounted.current || panelContextRef.current !== requestedContext) return;
        const referenceFile = options.referenceFile?.() ?? null;
        const receipt = { resultId, outcome, referenceFile, target, intake: options.intake };
        // A later start owns the slot; this import's receipt is then not shown. The panel
        // reads the receipt again at render, with its actions.
        const content = importResultContent({
          operation: outcome?.operation ?? null,
          outcome,
          referenceFile: referenceFile
            ? { name: referenceFile.file.name, report: referenceFile.report }
            : null,
          target,
          intake: options.intake,
        });
        if ((outcome || referenceFile) && result.settle(resultId, content)) {
          setImportReceipt(receipt);
        }
        if (!outcome || importRevealRequest.current !== request) return;
        setRecentlyAddedSourceIds(
          rememberRecentSourceAdds(requestedContext, importedSourceIds(outcome)),
        );
        const sourceId = options.reveal ? importedSourceIdToReveal(outcome) : null;
        if (sourceId) {
          setEditingSource(false);
          setSelectedSourceId(sourceId);
        }
      });
    },
  );
  useLibraryFileImport(props.root, sources.overview !== null, (files) =>
    revealImportedSource(sources.uploadLocalFiles(files), {
      intake: "local-pdf",
      reveal: files.length === 1,
    }),
  );

  const importReferenceFile = (file: File) => {
    setSelectedSourceId(null);
    let report: ScientSourcesFileImportResult["report"] | null = null;
    revealImportedSource(
      sources.importReferenceFile(file).then((imported) => {
        report = imported?.report ?? null;
        return imported?.outcome ?? null;
      }),
      { intake: "file", referenceFile: () => (report ? { file, report } : null) },
    );
  };

  /** A finished import's result, read at render so its actions see the import as it is now. */
  const importReceiptContent = (receipt: ImportReceipt): SourcesResultContent => {
    const { outcome, referenceFile } = receipt;
    const operation =
      outcome?.operation && sources.operation?.operationId === outcome.operation.operationId
        ? sources.operation
        : (outcome?.operation ?? null);
    const fileRest = referenceFile && canChange ? referenceFile.report.remaining : 0;
    const zoteroRest = receipt.intake === "zotero" && canChange ? sources.zoteroRunRemaining : 0;
    return importResultContent(
      {
        operation,
        outcome,
        referenceFile: referenceFile
          ? { name: referenceFile.file.name, report: referenceFile.report }
          : null,
        target: receipt.target,
        intake: receipt.intake,
        sourceTitle: (sourceId) =>
          sources.overview?.records.find((record) => record.sourceId === sourceId)?.title ?? null,
        detailsMissing: (sourceId) => (diagnosticsBySourceId.get(sourceId)?.length ?? 0) > 0,
        hasOtherVersion: (sourceId) => {
          const records = sources.overview?.records ?? [];
          const imported = records.find((record) => record.sourceId === sourceId);
          return (
            imported !== undefined &&
            records.some(
              (record) =>
                record.sourceId !== sourceId && scientSourcesMayBeVersions(imported, record),
            )
          );
        },
        ...(referenceFile && fileRest > 0
          ? { rest: { count: fileRest, onImport: () => importReferenceFile(referenceFile.file) } }
          : zoteroRest > 0
            ? {
                rest: {
                  count: zoteroRest,
                  onImport: () =>
                    revealImportedSource(sources.importZoteroRest(), { intake: "zotero" }),
                },
              }
            : {}),
        ...(canChange ? { onRetryFailed: () => void sources.retryFailedImport() } : {}),
        ...(canChangeProject
          ? {
              onAddToProject: (sourceIds: ReadonlyArray<string>) =>
                void addToProject(sourceIds.map((sourceId) => ({ sourceId }))).then(result.dismiss),
            }
          : {}),
        ...(scopes ? { onShowSources: showPackageSources } : {}),
        onViewSource: (sourceId) => {
          setEditingSource(false);
          setSelectedSourceId(sourceId);
        },
      },
      m,
    );
  };
  // A source this project keeps from its own details: link it to a Library copy, or keep it apart.
  const linkToCopy = async (projectSourceId: string, librarySourceId: string) => {
    const result = await organize.organize(
      { action: "link-pin", sourceId: projectSourceId, librarySourceId },
      m(LIBRARY_LABELS.linkFailed),
    );
    if (result?.outcome !== "linked") return;
    setSelectedSourceId(librarySourceId);
    toastManager.add({
      type: "success",
      title: m(LIBRARY_LABELS.linked),
      description: m(LIBRARY_LABELS.linkedHelp),
      actionProps: {
        children: gt("Undo", { $context: "verb, button that undoes a change" }),
        onClick: organize.whenFree(() => {
          void organize
            .organize(
              { action: "unlink-pin", sourceId: projectSourceId },
              m(LIBRARY_LABELS.linkFailed),
            )
            .then((undone) => {
              if (undone?.outcome === "unlinked") setSelectedSourceId(projectSourceId);
            });
        }),
      },
    });
  };
  const keepSeparate = async (record: ScientSourceDetailResult, separate: boolean) => {
    const result = await organize.organize(
      { action: separate ? "keep-pin-separate" : "clear-pin-separate", sourceId: record.sourceId },
      m(LIBRARY_LABELS.separateFailed),
    );
    if (!result || !record.libraryMatch) return;
    sources.acceptSourceRecord({
      ...record,
      libraryMatch: { ...record.libraryMatch, keptSeparate: separate },
    });
  };
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
            title: gt("Source could not be moved to Trash"),
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
    onOpenDetails: (sourceId: string) => {
      setViewAnchor(sourceId);
      openSourceDetails(sourceId);
    },
    onOpenPdf: props.onOpenPdf,
    onShowMenu: showSourceContextMenuAt,
    ...(canSetReading
      ? {
          onToggleStar: (record: SourceRecord) =>
            setReadingState([record.sourceId], { starred: record.starred !== true }, false),
        }
      : {}),
  };

  const paperQueueActivity: SourcesActivityItem | null =
    paperQueue &&
    (paperQueue.waiting > 0 || paperQueue.requests.length > 0 || paperQueue.failed > 0)
      ? {
          key: "paper-queue",
          tone:
            paperQueue.requests.length > 0
              ? "decision"
              : paperQueue.waiting > 0
                ? "running"
                : "advisory",
          label:
            paperQueue.requests.length > 0
              ? gt("Getting papers needs you")
              : paperQueue.waiting > 0
                ? gt(
                    "{count, plural, one {Getting {count} paper} other {Getting {count} papers}}",
                    {
                      count: paperQueue.waiting,
                    },
                  )
                : gt("Some papers could not be reached"),
          body: (
            <PaperQueueBand
              environmentId={props.environmentId}
              root={props.root}
              threadId={props.threadId}
            />
          ),
        }
      : null;
  const activity = selectSourcesActivity([
    ...sourcesStateActivity(
      {
        importPreparation: sources.importPreparation,
        operation: sources.operation,
        ...(sources.operation
          ? {
              operationBody: (
                <RunningImportBody
                  operation={sources.operation}
                  cancelling={sources.cancelling}
                  onCancel={() => void sources.cancelImport()}
                />
              ),
            }
          : {}),
        error: sources.error,
        onDismissError: sources.clearError,
        overviewError: sources.overview ? sources.overviewError : null,
        onRetryOverview: () => void sources.reloadOverview(),
      },
      m,
    ),
    paperQueueActivity,
    ...libraryBackupActivity(backup, m),
    libraryMoveActivity(
      move,
      scopes
        ? () => {
            setActivityOpen(false);
            setShowingDuplicates("merged");
          }
        : undefined,
      m,
    ),
    sources.overview &&
      libraryNoticeChangesActivity(
        {
          changes: sources.overview.noticeChanges ?? [],
          onShow: (sourceIds) => showPackageSources(sourceIds, m(NOTICE_CHANGES_SHOWN)),
          onDismiss: canChange ? dismissNoticeChanges : undefined,
        },
        m,
      ),
    sources.overview && sourceStoreActivity(sources.overview.unreadableRecords ?? []),
    bibliography.status &&
      managedBibliographyActivity(
        {
          files: bibliography.status.files,
          replacing: bibliography.replacing || !bibliography.canChange,
          onResolve: (name, action) => void bibliography.resolve(name, action),
        },
        m,
      ),
  ]);
  const shownResult =
    result.result && importReceipt?.resultId === result.result.operationId
      ? { ...importReceiptContent(importReceipt), operationId: result.result.operationId }
      : result.result;
  const activityButton = (
    <SourcesActivityButton
      activity={activity}
      result={shownResult}
      open={activityOpen}
      onOpenChange={setActivityOpen}
      onDismissResult={result.dismiss}
    />
  );
  const resultSlot = (
    <SourcesResultSlot
      result={shownResult}
      onDetails={() => setActivityOpen(true)}
      onDismiss={result.dismiss}
    />
  );
  // Pages other than the list keep their own header: Activity and the result sit above it. The
  // wrapper always renders, so the page keeps its state when Activity comes and goes.
  const withActivity = (view: ReactNode) => (
    <div className="flex min-h-0 flex-1 flex-col">
      {activity.count > 0 || shownResult || activityOpen ? (
        <div className="shrink-0 border-b border-border">
          <div className={`${SOURCES_COLUMN} flex items-start gap-2 px-3 py-1.5`}>
            <div className="min-w-0 flex-1">{resultSlot}</div>
            {activityButton}
          </div>
        </div>
      ) : null}
      {view}
    </div>
  );

  if (sources.overview === null) {
    if (sources.overviewError) {
      return (
        <CenteredState
          icon={<AlertCircle />}
          title={gt("The Library could not be loaded")}
          description={sources.overviewError}
          action={
            <Button
              variant="outline"
              disabled={sources.overviewLoading}
              onClick={() => void sources.reloadOverview()}
            >
              <RefreshCw />
              <T>Try again</T>
            </Button>
          }
        />
      );
    }
    return (
      <CenteredState
        icon={<LoaderCircle className="animate-spin" />}
        title={gt("Loading sources…")}
      />
    );
  }

  if (sources.overview.projectState !== "initialized") {
    const conflicting = sources.overview.projectState === "conflicting";
    return (
      <CenteredState
        icon={conflicting ? <AlertCircle /> : <Library />}
        title={
          conflicting
            ? gt("Scient project setup needs attention")
            : gt("Set up this Scient project")
        }
        description={
          conflicting
            ? (sources.overview.issues[0]?.message ??
              gt("Scient will not change conflicting files."))
            : (setupError ??
              gt("Use Project package to carry this project’s sources, PDFs and highlights."))
        }
        action={
          conflicting ? null : (
            <Button
              disabled={settingUpProject}
              onClick={() => {
                const prepared = readPreparedConnection(props.environmentId);
                if (!prepared) {
                  setSetupError(gt("This environment is not connected."));
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
                      cause instanceof Error ? cause.message : gt("Scient project setup failed."),
                    );
                  })
                  .finally(() => setSettingUpProject(false));
              }}
            >
              {settingUpProject ? <LoaderCircle className="animate-spin" /> : null}
              <T>Set up Scient project</T>
            </Button>
          )
        }
      />
    );
  }

  if (sources.preflight) {
    return withActivity(
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
          revealImportedSource(sources.runImport(itemKeys, possibleMetadataMatchOverrides), {
            intake: sources.preflightAdapter === "local-files" ? "local-pdf" : "zotero",
            reveal: true,
          })
        }
      />,
    );
  }

  if (sources.library) {
    return withActivity(
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-border p-3">
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={sources.closeLibrary}
            aria-label={gt("Go back")}
          >
            <ChevronLeft />
          </Button>
          <div className="flex min-w-0 items-center gap-2">
            <ZoteroMark />
            <div className="truncate text-sm font-medium">
              <T>Import from Zotero</T>
            </div>
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
                  <T>My Library</T>
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
            className="min-w-[12rem] max-w-[24rem] flex-[1_1_14rem]"
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
                aria-label={gt("Search Zotero library")}
                placeholder={gt("Search title, creator, or year")}
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
                  aria-label={gt("Clear Zotero search")}
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
                  onClick={() =>
                    revealImportedSource(sources.importZoteroScope(), {
                      intake: "zotero",
                      reveal: true,
                    })
                  }
                >
                  <Download />
                  {sources.zoteroScope.kind === "collection"
                    ? gt("Import collection")
                    : gt("Import all")}
                </Button>
              }
            />
            <TooltipPopup side="bottom">
              {sources.zoteroScope.kind === "collection"
                ? gt("Import {total} references in this collection", {
                    total: sources.library.total,
                  })
                : gt("Import all {total} references in {zoteroLibraryName}", {
                    total: sources.library.total,
                    zoteroLibraryName,
                  })}
            </TooltipPopup>
          </Tooltip>
        </div>
        {sources.error ? (
          <div className="shrink-0 border-b border-destructive/20 bg-destructive/5">
            <div
              className={`${SOURCES_COLUMN} flex items-center justify-between gap-3 px-3 py-2 text-xs text-destructive`}
            >
              <span className="min-w-0 truncate">{sources.error}</span>
              <Button
                size="xs"
                variant="ghost"
                disabled={sources.busy}
                onClick={() => void sources.searchZotero(query, 0)}
              >
                <T>Try again</T>
              </Button>
            </div>
          </div>
        ) : null}
        {selectedKeys.size > 0 ? (
          <div className="shrink-0 border-b border-border bg-muted/30">
            <div className={`${SOURCES_COLUMN} flex items-center justify-between gap-3 px-3 py-2`}>
              <span className="text-xs text-muted-foreground">
                {selectedKeys.size} reference{selectedKeys.size === 1 ? "" : "s"} selected
              </span>
              <Button
                size="xs"
                variant="ghost"
                disabled={!canChange || sources.busy}
                onClick={() =>
                  revealImportedSource(sources.previewImport([...selectedKeys]), {
                    intake: "zotero",
                    reveal: true,
                  })
                }
              >
                <Download />
                {selectedKeys.size === 1
                  ? gt("Import", { $context: "verb, button" })
                  : gt("Import {size}", { size: selectedKeys.size })}
              </Button>
            </div>
          </div>
        ) : null}
        <ScrollArea className="min-h-0 flex-1">
          <div className={`${SOURCES_COLUMN} divide-y divide-border`}>
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
                      {item.title ?? gt("Untitled source")}
                    </span>
                    <span className="mt-0.5 block text-xs text-muted-foreground">
                      {creator?.familyName ?? creator?.literalName ?? gt("Unknown creator")}
                      {item.issuedYear ? ` · ${item.issuedYear}` : ""}
                      {item.pdfAvailable ? gt(" · PDF") : ""}
                    </span>
                  </span>
                </label>
              );
            })}
            {sources.library.items.length === 0 && sources.busy ? (
              <div className="flex items-center justify-center gap-2 p-8 text-sm text-muted-foreground">
                <LoaderCircle className="size-4 animate-spin" />
                <T>Loading Zotero…</T>
              </div>
            ) : sources.library.items.length === 0 ? (
              <div className="p-8 text-center text-sm text-muted-foreground">
                {query.trim()
                  ? gt("No matching Zotero references were found.")
                  : sources.library.total === 0
                    ? gt("Your Zotero library is empty. Add references in Zotero, then refresh.")
                    : gt(
                        "No importable references were found in this part of your Zotero library.",
                      )}
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
                  <T>Load more</T>
                </Button>
              </div>
            ) : null}
          </div>
        </ScrollArea>
      </div>,
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
    return withActivity(
      <div className="flex min-h-0 flex-1 flex-col">
        <PanelHeader
          title={
            <span className="flex min-w-0 items-center gap-2">
              <ZoteroMark />
              <span className="truncate">
                <T>Import from Zotero</T>
              </span>
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
                <T>Check again</T>
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
                  <T>Download Zotero</T>
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
                      <T>How to connect</T>
                    </Button>
                  }
                />
                <PopoverPopup
                  side="bottom"
                  align="end"
                  className="w-[min(20rem,calc(100vw-1.5rem))] [--popup-width:min(20rem,calc(100vw-1.5rem))]"
                >
                  <div className="grid gap-2 text-xs leading-relaxed">
                    <p className="text-sm font-medium text-foreground">
                      <T>Connect Zotero</T>
                    </p>
                    <ol className="list-decimal space-y-1 pl-4 text-muted-foreground">
                      <li>
                        <T>Open Zotero on this computer.</T>
                      </li>
                      <li>
                        <T>
                          In Zotero, open Settings → Advanced and enable “Allow other applications
                          on this computer to communicate with Zotero.”
                        </T>
                      </li>
                      <li>
                        <T>Return here and choose Check again.</T>
                      </li>
                    </ol>
                    <p className="text-muted-foreground">
                      <T>
                        Without Zotero on this computer, add a Zotero API key in Accounts to use
                        your library on zotero.org.
                      </T>
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
      </div>,
    );
  }

  if (selectedRecord) {
    if (editingSource) {
      return withActivity(
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
        />,
      );
    }
    return withActivity(
      <>
        <SourcesNameDialog request={nameRequest} onClose={() => setNameRequest(null)} />
        {/* Each view that can remove a source this Library lacks mounts its question. */}
        <SnapshotRemovalDialog actions={libraryActions} />
        <SourceDetails
          key={selectedRecord.sourceId}
          record={selectedRecord}
          readOnly={!canChange}
          {...(scopes
            ? {
                library: {
                  canSavePersonalNote,
                  onSavePersonalNote: async (note, expectedRevision, context) => {
                    const result = await updateScientSourcePersonalNote(props.environmentId, {
                      root: props.root,
                      sourceId: selectedRecord.sourceId,
                      expectedRevision,
                      note,
                      expectedNote: context.base,
                    });
                    if (panelMounted.current && panelContextRef.current === panelContext) {
                      sources.acceptSourceRecord(result.record);
                    }
                    return result;
                  },
                  // Another key's note is shown beside the cached detail, never cached as it.
                  onLoadKeyNote: (citationKey: string) =>
                    readScientSource(props.environmentId, {
                      root: props.root,
                      sourceId: selectedRecord.sourceId,
                      citationKey,
                    }),
                  onSaveKeyNote: (citationKey, note, expectedRevision, context) =>
                    updateScientSourceNote(props.environmentId, {
                      root: props.root,
                      sourceId: selectedRecord.sourceId,
                      expectedRevision,
                      note,
                      expectedNote: context.base,
                      noteSession: context.session,
                      citationKey,
                    }),
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
                        onLinkToCopy: (librarySourceId: string) =>
                          linkToCopy(selectedRecord.sourceId, librarySourceId),
                        onKeepSeparate: (separate: boolean) =>
                          keepSeparate(selectedRecord, separate),
                      }
                    : {}),
                },
              }
            : {})}
          citationProject={{ environmentId: props.environmentId, root: props.root }}
          diagnostics={diagnosticsBySourceId.get(selectedRecord.sourceId) ?? []}
          filing={
            <SourceFiling
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
            />
          }
          categories={selectedSummary?.categories}
          onShowCategory={(category) => {
            setEditingSource(false);
            setSelectedSourceId(null);
            organize.showOnly(category);
          }}
          onBack={() => {
            setEditingSource(false);
            setSelectedSourceId(null);
          }}
          onEdit={() => setEditingSource(true)}
          onSaveNote={(note, expectedRevision, context) =>
            sources.saveSourceNote(selectedRecord.sourceId, expectedRevision, note, context)
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
                  ? gt("Metadata refreshed")
                  : result.outcome === "unchanged"
                    ? gt("Metadata is already up to date")
                    : result.outcome === "stale"
                      ? gt("Source changed while metadata was refreshed")
                      : result.outcome === "duplicate"
                        ? gt("Metadata refresh stopped")
                        : gt("Metadata cannot be refreshed yet"),
              description: result.message ?? undefined,
            });
          }}
          onRemove={() => moveToTrash(selectedRecord)}
          onSendToZotero={(groupId) =>
            void zoteroSync.sendToZotero(selectedRecord.sourceId, groupId)
          }
          zoteroSendPdfs={{ include: zoteroSync.sendPdfs, change: zoteroSync.setSendPdfs }}
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
                  ? gt("PDF attached")
                  : gt("PDF attached: an accepted manuscript or preprint"),
              });
              return;
            }
            // Anything waiting for the user is in Activity, with its action.
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
          uses={
            // A source not pinned here has no place in this project's documents.
            selectedRecord.pinned === false ? undefined : (
              <ProjectSourceUses
                environmentId={props.environmentId}
                root={props.root}
                sourceId={selectedRecord.sourceId}
                version={libraryVersion}
                {...(props.onOpenFile ? { onOpenFile: props.onOpenFile } : {})}
              />
            )
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
      </>,
    );
  }

  if (showingDuplicates && scopes) {
    return withActivity(
      <LibraryDuplicatesView
        environmentId={props.environmentId}
        root={props.root}
        organize={organize}
        canChange={canChangeProject}
        initialSection={showingDuplicates}
        onBack={() => setShowingDuplicates(null)}
        onMerged={leaveSelection}
      />,
    );
  }

  if (showingReviews) {
    return withActivity(
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
      />,
    );
  }

  /** What Add by identifier added, in the result slot of the operation its dialog began. */
  const identifiersAdded = (
    operationId: string,
    results: ReadonlyArray<ScientSourceIdentifierAddItem>,
  ) => {
    const added = results.flatMap((item) =>
      item.outcome === "imported" && item.sourceId ? [item.sourceId] : [],
    );
    if (added.length > 0) {
      setRecentlyAddedSourceIds(rememberRecentSourceAdds(panelContext, added));
    }
    const addAction = canChangeProject ? (
      <Button
        size="xs"
        variant="ghost"
        onClick={() =>
          void addToProject(added.map((sourceId) => ({ sourceId }))).then(result.dismiss)
        }
      >
        {m(LIBRARY_LABELS.addToProject)}
      </Button>
    ) : null;
    result.settle(
      operationId,
      identifierAddResult(
        results,
        scopes?.listed === "library"
          ? {
              detail: inLibraryNotProjectLabel(added.length),
              ...(addAction ? { actions: addAction } : {}),
            }
          : {},
      ),
    );
    void sources.refreshOverview();
  };
  const empty = emptySourcesLabel(scopes?.listed, m);
  const fullTextFooter = (
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
              .filter(
                (record) =>
                  matchesReadingFilter(record, readingFilter) &&
                  (!packageSources || packageSources.has(record.sourceId)),
              )
              .map((record) => record.sourceId)
          : undefined
      }
      onOpenHit={(hit) => {
        requestSourceTextReveal(props.root, hit);
        props.onOpenPdf(hit);
      }}
    />
  );
  const viewProps = {
    records: filteredSourceRecords,
    sections: sourceSections,
    row: sourceRow,
    footer: fullTextFooter,
    anchorSourceId: viewAnchor,
    onTopSourceChange: (sourceId: string) => {
      topSourceId.current = sourceId;
    },
  };
  const nextView: SourceView = sourceView === "list" ? "cards" : "list";
  const viewLabel = nextView === "cards" ? "Show as cards" : "Show as a list";

  return (
    <div
      className="relative flex min-h-0 flex-1 flex-col"
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
        revealImportedSource(sources.uploadLocalFiles([...event.dataTransfer.files]), {
          intake: "local-pdf",
        });
      }}
    >
      {dragActive ? (
        <div className="pointer-events-none absolute inset-2 z-10 flex items-center justify-center rounded-md border border-dashed border-foreground/30 bg-background/85 px-3 text-center text-xs text-muted-foreground">
          <T>Drop PDFs or a reference file to add them to the Library</T>
        </div>
      ) : null}
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
          revealImportedSource(sources.uploadLocalFiles(files), {
            intake: "local-pdf",
            reveal: files.length === 1,
          });
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
      <PanelHeader
        title={gt("Library", { $context: "the personal Library of sources" })}
        {...(elsewhere ? { description: libraryElsewhereLabel(elsewhere, m) } : {})}
        action={
          <div className="flex shrink-0 items-center gap-1">
            <UniversityCrest environmentId={props.environmentId} threadId={props.threadId} />
            <Menu>
              <MenuTrigger
                render={
                  <Button
                    size="xs"
                    variant="ghost"
                    disabled={!canChange || sources.importing || sources.checkingZotero}
                    aria-label={gt("Import sources")}
                  >
                    {sources.importing || sources.checkingZotero ? (
                      <LoaderCircle className="animate-spin" />
                    ) : (
                      <Download />
                    )}
                    <span className="@max-[20rem]:hidden">
                      <T>Import sources</T>
                    </span>
                  </Button>
                }
              />
              <MenuPopup align="end" side="bottom" className="min-w-44">
                <MenuItem onClick={() => localFileInput.current?.click()}>
                  <FileUp />
                  <T>Import PDF files</T>
                </MenuItem>
                <MenuItem onClick={() => referenceFileInput.current?.click()}>
                  <FileText />
                  <T>Import a reference file</T>
                </MenuItem>
                <MenuItem
                  onClick={() => {
                    setSelectedSourceId(null);
                    sources.clearOperationSummary();
                    void sources.openZoteroLibrary();
                  }}
                >
                  <ZoteroMark />
                  <T>Import from Zotero</T>
                </MenuItem>
                <MenuItem onClick={() => setAddingByIdentifier(result.begin())}>
                  <Hash />
                  <T>Add by identifier</T>
                </MenuItem>
                {scopes && canChange ? (
                  <ImportPackageSubmenu
                    environmentId={props.environmentId}
                    root={props.root}
                    onImported={sources.refreshOverview}
                    onShowSources={showPackageSources}
                  />
                ) : null}
              </MenuPopup>
            </Menu>
            {activityButton}
            <SourcesHeaderMenu
              environmentId={props.environmentId}
              root={props.root}
              totalCount={sources.overview?.records.length ?? 0}
              exportScope={
                organize.selection.size > 0
                  ? { kind: "selected", sourceIds: [...organize.selection] }
                  : listQuery.trim() || listFilterActive
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
              {...(scopes
                ? {
                    onOpenDuplicates: () => setShowingDuplicates("pairs"),
                    onOpenRecentChanges: () => setShowingRecentChanges(true),
                  }
                : {})}
              {...(scopes && canChange && pickBackupFolder
                ? {
                    onBackUp: () =>
                      void pickBackupFolder()
                        .catch(() => null)
                        .then((folder) =>
                          folder ? backup.start(folder, result.begin()) : undefined,
                        ),
                    onRestore: () =>
                      void pickBackupFolder()
                        .catch(() => null)
                        .then((folder) =>
                          folder ? backup.restoreFrom(folder, result.begin()) : undefined,
                        ),
                    onAddFromLibrary: () =>
                      void pickBackupFolder()
                        .catch(() => null)
                        .then((folder) =>
                          folder ? backup.addFrom(folder, result.begin()) : undefined,
                        ),
                  }
                : {})}
              onOpenSource={setSelectedSourceId}
              {...(props.onOpenFile ? { onOpenFile: props.onOpenFile } : {})}
              {...(move.canMoveBack ? { onMoveBack: () => void move.moveBack() } : {})}
              canChangeProject={Boolean(scopes && canChange)}
              {...(hasZoteroSources && canChange
                ? { onRefreshZotero: () => void zoteroSync.startRefresh() }
                : {})}
            />
          </div>
        }
      />
      {showingRecentChanges ? (
        <RecentChangesDialog
          environmentId={props.environmentId}
          root={props.root}
          canChange={canChange}
          onUndoBulkEdit={organize.undoBulkEdit}
          onShowSources={(sourceIds) =>
            showPackageSources(sourceIds, m(RECENT_CHANGES_LABELS.importedSources))
          }
          onShowPackageSources={(sourceIds) => showPackageSources(sourceIds)}
          onChanged={sources.refreshOverview}
          onImportRest={sources.importZoteroRun}
          onAddFromLibrary={(folder) => backup.addFrom(folder, result.begin())}
          onPutBackLibrary={(folder) => backup.putBack(folder, result.begin())}
          onShowDifferences={setShowingJoinDifferences}
          onClose={() => setShowingRecentChanges(false)}
        />
      ) : null}
      {showingJoinDifferences ? (
        <JoinDifferencesDialog
          environmentId={props.environmentId}
          root={props.root}
          joinId={showingJoinDifferences}
          canChange={canChange}
          onChanged={sources.refreshOverview}
          onClose={() => setShowingJoinDifferences(null)}
        />
      ) : null}
      <ZoteroRefreshDialog
        state={zoteroSync.refresh}
        resolving={zoteroSync.resolving}
        onClose={zoteroSync.closeRefresh}
        onCheckAgain={() => void zoteroSync.startRefresh()}
        onResolve={(sourceId, field, side) =>
          void zoteroSync.resolveConflict(sourceId, field, side)
        }
      />
      {addingByIdentifier !== null ? (
        <AddByIdentifier
          environmentId={props.environmentId}
          root={props.root}
          {...(scopes?.listed === "library" ? { pin: false as const } : {})}
          onClose={() => setAddingByIdentifier(null)}
          onAdded={(results) => identifiersAdded(addingByIdentifier, results)}
          onOpenSource={(sourceId) => {
            setEditingSource(false);
            setSelectedSourceId(sourceId);
          }}
        />
      ) : null}
      <div className={`${SOURCES_COLUMN} flex shrink-0 flex-col`}>
        {scopes ? (
          <div className="@container mx-3 mt-2 flex flex-wrap items-center gap-2">
            <ToggleGroup
              aria-label={gt("Source scope")}
              value={[scopes.listed]}
              onValueChange={(values) => {
                const scope = values[0];
                if (scope === "project" || scope === "library") selectScope(scope);
              }}
            >
              <Toggle value="project">{m(LIBRARY_LABELS.scopes.project)}</Toggle>
              <Toggle value="library">{m(LIBRARY_LABELS.scopes.library)}</Toggle>
            </ToggleGroup>
            {packageSources ? (
              <>
                <span className="text-xs text-muted-foreground">{shownSourcesLabel}</span>
                <Button variant="ghost" size="xs" onClick={() => setPackageSources(null)}>
                  <T>Show all</T>
                </Button>
              </>
            ) : null}
            {sources.overview.records.length > 0 ? (
              <div className="ml-auto">
                <AskLibraryButton />
              </div>
            ) : null}
          </div>
        ) : null}
        {shownResult ? <div className="mx-3 mt-2">{resultSlot}</div> : null}
        {sources.overview.records.length > 0 &&
        (organize.selection.size > 0 || organize.progress) ? (
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
          <div className="mx-3 mt-2 mb-1 flex min-h-8 items-center gap-1 rounded-md text-sm text-muted-foreground">
            <div className="flex min-w-0 flex-1 cursor-text items-center gap-2 rounded-md px-2 transition-colors hover:bg-accent hover:text-accent-foreground focus-within:bg-accent focus-within:text-accent-foreground">
              <Search className="size-4 shrink-0 text-muted-foreground/80" aria-hidden="true" />
              <Input
                nativeInput
                unstyled
                type="search"
                aria-label={
                  scopes?.listed === "library" ? gt("Search Library") : gt("Search project sources")
                }
                placeholder={gt("Search sources")}
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
                  aria-label={gt("Clear source search")}
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
                aria-label={gt("Sort sources")}
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
            <ScientTooltip content={viewLabel}>
              <Button
                variant="ghost"
                size="icon-xs"
                className="shrink-0"
                aria-label={viewLabel}
                onClick={() => {
                  setViewAnchor(topSourceId.current);
                  setSourceView(nextView);
                  writeLocalStorageValue(SOURCE_VIEW_KEY, nextView, "list", SourceViewSchema);
                }}
              >
                {nextView === "cards" ? <LayoutGrid /> : <ListIcon />}
              </Button>
            </ScientTooltip>
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
      </div>
      <SourcesNameDialog request={nameRequest} onClose={() => setNameRequest(null)} />
      <SnapshotRemovalDialog actions={libraryActions} />
      {sources.overview.records.length === 0 ? (
        <CenteredState
          icon={<BookOpen />}
          title={empty.title}
          description={empty.description}
          {...(scopes?.listed === "project" && scopes.library > 0
            ? {
                action: (
                  <Button size="sm" variant="outline" onClick={() => selectScope("library")}>
                    <T>Choose from Library</T>
                  </Button>
                ),
              }
            : {})}
        />
      ) : sourceView === "cards" ? (
        <SourceCards {...viewProps} />
      ) : (
        <SourcesList {...viewProps} virtualized={scopes !== undefined} />
      )}
    </div>
  );
}
