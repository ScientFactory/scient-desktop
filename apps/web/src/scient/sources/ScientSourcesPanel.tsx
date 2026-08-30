import type {
  ContextMenuItem,
  EnvironmentId,
  ScientSourcesOverviewResult,
  ScientSourcesPreflightResult,
} from "@t3tools/contracts";
import { selectScientSourceMaterial } from "@scientfactory/scient-sources/material-selection";
import {
  AlertCircle,
  ArrowDownUp,
  BookOpen,
  CheckCircle2,
  ChevronLeft,
  Download,
  ExternalLink,
  FileUp,
  FileText,
  Folder,
  Library,
  LoaderCircle,
  Info,
  MoreVertical,
  RefreshCw,
  Search,
  X,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";

import { Button } from "../../components/ui/button";
import { Checkbox } from "../../components/ui/checkbox";
import { Input } from "../../components/ui/input";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../../components/ui/menu";
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
import { useLiveRefresh } from "../../hooks/useLiveRefresh";
import { initializeScientProjectForOpening } from "../../lib/scientProjectInitialization";
import { readLocalApi } from "../../localApi";
import { readPreparedConnection } from "../../state/session";
import { ScientTooltip } from "../presentation/ScientTooltip";
import { SourceDetails } from "./SourceDetails";
import { SourceEditor } from "./SourceEditor";
import { SourceJournalIcon } from "./SourceJournalIcon";
import { sourceAddedLabel } from "./sourceLabels";
import {
  filterScientSourceSearchIndex,
  indexScientSourceSummaries,
  SCIENT_SOURCE_SORT_OPTIONS,
  sortScientSourceRecords,
  type ScientSourceSort,
} from "./filterSources";
import {
  completedImportCounts,
  importedSourceIdToReveal,
  importedSourceIds,
  type ScientSourcesImportOutcome,
} from "./importOutcome";
import {
  SourceRemovalConfirmation,
  type SourceRemovalAnchorPoint,
} from "./SourceRemovalConfirmation";
import { useScientSources } from "./useScientSources";

type SourceRecord = ScientSourcesOverviewResult["records"][number];
type SourceContextAction = "view" | "edit" | "open-pdf" | "remove";
type PendingSourceRemoval = {
  readonly record: SourceRecord;
  readonly anchorPoint: SourceRemovalAnchorPoint;
};
type SourceDiagnostic =
  ScientSourcesOverviewResult["recordDiagnostics"][number]["diagnostics"][number];
const RECENT_SOURCE_ADD_TTL_MS = 10 * 60 * 1000;
const recentSourceAdds = new Map<string, Map<string, number>>();
const observedSourceIds = new Map<string, Set<string>>();

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

export function MetadataReviewIndicator(props: {
  readonly diagnostics: ReadonlyArray<SourceDiagnostic>;
  readonly onOpen: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            className="rounded-full text-amber-600 outline-none hover:text-amber-700 focus-visible:ring-2 focus-visible:ring-ring dark:text-amber-400 dark:hover:text-amber-300"
            aria-label="Metadata needs review"
            onClick={(event) => {
              event.stopPropagation();
              props.onOpen();
            }}
          >
            <AlertCircle className="size-4" />
          </button>
        }
      />
      <TooltipPopup side="top" align="end" className="max-w-72 p-0" variant="glass">
        <div className="space-y-1 px-3 py-2">
          <div className="font-medium">Metadata needs review</div>
          <div className="text-muted-foreground">
            {props.diagnostics.map((diagnostic) => diagnostic.message).join(" ")}
          </div>
          <div className="pt-1 text-muted-foreground">Click to view source details.</div>
        </div>
      </TooltipPopup>
    </Tooltip>
  );
}

export function SourceErrorBanner(props: {
  readonly message: string;
  readonly onDismiss: () => void;
}) {
  return (
    <div className="m-3 flex items-start gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
      <span className="min-w-0 flex-1">{props.message}</span>
      <Button
        size="icon-xs"
        variant="ghost"
        className="shrink-0 text-destructive hover:text-destructive"
        aria-label="Dismiss source notification"
        onClick={props.onDismiss}
      >
        <X />
      </Button>
    </div>
  );
}

function creatorLabel(record: ScientSourcesOverviewResult["records"][number]): string {
  const creator = record.creators[0];
  return creator?.familyName ?? creator?.literalName ?? creator?.givenName ?? "Unknown creator";
}

function candidateMetadataSummary(
  candidate: ScientSourcesPreflightResult["items"][number]["candidate"],
): string | null {
  const leadCreator = candidate.creators[0];
  const creatorName =
    leadCreator?.familyName ?? leadCreator?.literalName ?? leadCreator?.givenName ?? null;
  const creator = creatorName
    ? `${creatorName}${candidate.creators.length > 1 ? " et al." : ""}`
    : null;
  const hasDoi = candidate.identifiers.some(
    (identifier) => identifier.scheme.toLowerCase() === "doi",
  );
  const values = [
    creator,
    candidate.issuedYear === null ? null : String(candidate.issuedYear),
    candidate.containerTitle,
    hasDoi ? "DOI" : null,
  ].filter((value): value is string => Boolean(value));
  return values.length > 0 ? values.join(" · ") : null;
}

function importedCount(operation: NonNullable<ReturnType<typeof useScientSources>["operation"]>) {
  return operation.items.filter((item) => item.state !== "pending").length;
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
  readonly root: string;
  readonly projectTitle: string;
  readonly onOpenPdf: (input: {
    readonly sourceId: string;
    readonly attachmentId: string;
    readonly fileName: string;
  }) => void;
}) {
  const sources = useScientSources({ environmentId: props.environmentId, root: props.root });
  const [query, setQuery] = useState("");
  const [sourceQuery, setSourceQuery] = useState("");
  const [sourceSort, setSourceSort] = useState<ScientSourceSort>("last-added");
  const [selectedKeys, setSelectedKeys] = useState<ReadonlySet<string>>(new Set());
  const [settingUpProject, setSettingUpProject] = useState(false);
  const [setupError, setSetupError] = useState<string | null>(null);
  const [selectedSourceId, setSelectedSourceId] = useState<string | null>(null);
  const [editingSource, setEditingSource] = useState(false);
  const [importOutcome, setImportOutcome] = useState<ScientSourcesImportOutcome | null>(null);
  const panelContext = `${props.environmentId}\0${props.root}`;
  const [recentlyAddedSourceIds, setRecentlyAddedSourceIds] = useState<ReadonlySet<string>>(() =>
    readRecentSourceAdds(panelContext),
  );
  const [sourcePendingRemoval, setSourcePendingRemoval] = useState<PendingSourceRemoval | null>(
    null,
  );
  const [dragActive, setDragActive] = useState(false);
  const localFileInput = useRef<HTMLInputElement>(null);
  const panelMounted = useRef(true);
  const importRevealRequest = useRef(0);
  const panelContextRef = useRef(panelContext);
  panelContextRef.current = panelContext;

  useEffect(() => {
    panelMounted.current = true;
    return () => {
      panelMounted.current = false;
    };
  }, []);

  const revealImportedSource = useCallback(
    (work: ReturnType<typeof sources.uploadLocalFiles>, revealSingleSource = true) => {
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
    },
    [panelContext],
  );

  useEffect(() => {
    importRevealRequest.current += 1;
    setSelectedSourceId(null);
    setEditingSource(false);
    setImportOutcome(null);
    setRecentlyAddedSourceIds(readRecentSourceAdds(panelContext));
    setSourcePendingRemoval(null);
    setSourceQuery("");
  }, [panelContext, props.environmentId, props.root]);

  useEffect(() => {
    return () => {
      observedSourceIds.delete(panelContext);
    };
  }, [panelContext]);

  useEffect(() => {
    const entries = recentSourceAdds.get(panelContext);
    if (!entries || entries.size === 0) return;
    const expiresAt = Math.min(...entries.values());
    const timeout = window.setTimeout(
      () => setRecentlyAddedSourceIds(readRecentSourceAdds(panelContext)),
      Math.max(0, expiresAt - Date.now()) + 1,
    );
    return () => window.clearTimeout(timeout);
  }, [panelContext, recentlyAddedSourceIds]);

  const openSourceDetails = useCallback((sourceId: string) => {
    setSelectedSourceId(sourceId);
  }, []);

  useEffect(() => {
    if (sources.library) return;
    setQuery("");
    setSelectedKeys(new Set());
  }, [sources.library]);

  useLiveRefresh(
    () => {
      void sources.refreshOverview().catch(() => undefined);
    },
    { key: `scient-sources:${panelContext}` },
  );

  useEffect(() => {
    const records = sources.overview?.records;
    if (!records) return;
    const currentIds = new Set(records.map((record) => record.sourceId));
    const previousIds = observedSourceIds.get(panelContext);
    observedSourceIds.set(panelContext, currentIds);
    const cutoff = Date.now() - RECENT_SOURCE_ADD_TTL_MS;
    const newlyObserved = records
      .filter((record) =>
        previousIds ? !previousIds.has(record.sourceId) : Date.parse(record.importedAt) >= cutoff,
      )
      .map((record) => record.sourceId);
    if (newlyObserved.length === 0) return;

    setRecentlyAddedSourceIds(rememberRecentSourceAdds(panelContext, newlyObserved));
  }, [panelContext, sources.overview?.records]);

  const toggleSelected = useCallback((itemKey: string) => {
    setSelectedKeys((current) => {
      const next = new Set(current);
      if (next.has(itemKey)) next.delete(itemKey);
      else next.add(itemKey);
      return next;
    });
  }, []);

  const diagnosticsBySourceId = useMemo(
    () =>
      new Map(
        sources.overview?.recordDiagnostics.map((entry) => [entry.sourceId, entry.diagnostics]) ??
          [],
      ),
    [sources.overview?.recordDiagnostics],
  );
  const sourceSearchIndex = useMemo(
    () => indexScientSourceSummaries(sources.overview?.records ?? []),
    [sources.overview?.records],
  );
  const filteredSourceRecords = useMemo(
    () =>
      sortScientSourceRecords(
        filterScientSourceSearchIndex(sourceSearchIndex, sourceQuery),
        sourceSort,
      ),
    [sourceQuery, sourceSearchIndex, sourceSort],
  );
  const selectedSummary = selectedSourceId
    ? (sources.overview?.records.find((record) => record.sourceId === selectedSourceId) ?? null)
    : null;
  const selectedDetail = selectedSourceId
    ? (sources.sourceDetails[selectedSourceId] ?? null)
    : null;
  const selectedRecord =
    selectedDetail && selectedDetail.revision === selectedSummary?.revision ? selectedDetail : null;

  useEffect(() => {
    if (!selectedSourceId || selectedRecord) return;
    if (!selectedSummary) {
      setSelectedSourceId(null);
      return;
    }
    void sources.loadSource(selectedSourceId).catch(() => undefined);
  }, [selectedRecord, selectedSourceId, selectedSummary, sources.loadSource]);
  const zoteroCollectionChoices = useMemo(
    () => zoteroCollectionLabels(sources.zoteroCollections),
    [sources.zoteroCollections],
  );
  const selectedZoteroCollectionKey =
    sources.zoteroScope.kind === "collection" ? sources.zoteroScope.collectionKey : null;
  const selectedZoteroCollection = selectedZoteroCollectionKey
    ? sources.zoteroCollections.find((collection) => collection.key === selectedZoteroCollectionKey)
    : null;

  const showSourceContextMenuAt = useCallback(
    async (record: SourceRecord, anchorPoint: { readonly x: number; readonly y: number }) => {
      const api = readLocalApi();
      if (!api) return;
      const materialSelection = selectScientSourceMaterial({ materials: record.attachments });
      const pdf = materialSelection._tag === "Selected" ? materialSelection.material : null;
      const items: ContextMenuItem<SourceContextAction>[] = [
        { id: "view", label: "View source details" },
        { id: "edit", label: "Edit source details", icon: "pencil" },
        ...(pdf ? ([{ id: "open-pdf", label: "Open PDF" }] as const) : []),
        {
          id: "remove",
          label: "Remove from Sources",
          destructive: true,
          disabled: sources.busy,
          icon: "trash",
        },
      ];
      const action = await api.contextMenu.show(items, {
        x: anchorPoint.x,
        y: anchorPoint.y,
      });
      if (!panelMounted.current || panelContextRef.current !== panelContext) return;
      switch (action) {
        case "view":
          setEditingSource(false);
          openSourceDetails(record.sourceId);
          break;
        case "edit":
          openSourceDetails(record.sourceId);
          setEditingSource(true);
          break;
        case "open-pdf":
          if (pdf) {
            props.onOpenPdf({
              sourceId: record.sourceId,
              attachmentId: pdf.attachmentId,
              fileName: pdf.fileName,
            });
          }
          break;
        case "remove":
          setSourcePendingRemoval({ record, anchorPoint });
          break;
        case null:
          break;
      }
    },
    [openSourceDetails, panelContext, props.onOpenPdf, sources.busy],
  );
  const showSourceContextMenu = useCallback(
    (event: ReactMouseEvent<HTMLElement>, record: SourceRecord) => {
      event.preventDefault();
      event.stopPropagation();
      void showSourceContextMenuAt(record, { x: event.clientX, y: event.clientY });
    },
    [showSourceContextMenuAt],
  );

  if (sources.overview === null) {
    if (sources.error) {
      return (
        <CenteredState
          icon={<AlertCircle />}
          title="Sources could not be loaded"
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
              "Sources are kept in this project so they remain portable and reviewable.")
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
                  {sources.zoteroScope.kind === "library" ? <Library /> : <Folder />}
                  <span className="truncate">{selectedZoteroCollection?.name ?? "My Library"}</span>
                </Button>
              }
            />
            <MenuPopup align="start" side="bottom" className="max-h-80 min-w-56 overflow-y-auto">
              <MenuItem
                onClick={() => {
                  setQuery("");
                  setSelectedKeys(new Set());
                  void sources.selectZoteroScope({ kind: "library" });
                }}
              >
                <Library />
                My Library
              </MenuItem>
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
                className="min-w-0 flex-1 [&_[data-slot=input]]:h-auto [&_[data-slot=input]]:p-0 [&_[data-slot=input]]:leading-normal [&_[data-slot=input]]:text-sm [&_[data-slot=input]]:font-medium [&_[data-slot=input]]:text-foreground [&_[data-slot=input]]:placeholder:text-muted-foreground"
              />
              {query ? (
                <Button
                  type="button"
                  size="icon-xs"
                  variant="ghost"
                  className="size-5 shrink-0 rounded-sm text-muted-foreground hover:bg-muted"
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
                  disabled={sources.busy || sources.library.total === 0}
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
                : `Import all ${sources.library.total} references in My Library`}
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
              disabled={sources.busy}
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
                    className="size-4 border-border bg-transparent shadow-none [&_[data-slot=checkbox-indicator]]:bg-accent [&_[data-slot=checkbox-indicator]]:text-foreground"
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
      status.state === "unreachable"
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
        <div className="flex min-h-0 flex-1 items-center justify-center p-6">
          <div className="w-full max-w-md">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Info className="size-4 shrink-0" aria-hidden="true" />
              <span className="min-w-0 flex-1">{connectionMessage}</span>
              <Popover>
                <PopoverTrigger
                  render={
                    <Button type="button" size="xs" variant="ghost" className="shrink-0">
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
                  </div>
                </PopoverPopup>
              </Popover>
            </div>
            <div className="mt-4 flex flex-wrap items-center gap-2">
              <Button
                variant="outline"
                disabled={sources.checkingZotero}
                aria-busy={sources.checkingZotero}
                onClick={() => void sources.openZoteroLibrary(true)}
              >
                {sources.checkingZotero ? <LoaderCircle className="animate-spin" /> : <RefreshCw />}
                Check again
              </Button>
              {status.state === "unreachable" ? (
                <Button
                  variant="ghost"
                  onClick={() =>
                    void readLocalApi()?.shell.openExternal("https://www.zotero.org/download/")
                  }
                >
                  <ExternalLink />
                  Download Zotero
                </Button>
              ) : null}
            </div>
            <div
              className="min-h-4 pt-2 text-xs text-muted-foreground"
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
      <SourceDetails
        key={selectedRecord.sourceId}
        record={selectedRecord}
        diagnostics={diagnosticsBySourceId.get(selectedRecord.sourceId) ?? []}
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
        onRemove={async () => {
          const result = await sources.removeSource(
            selectedRecord.sourceId,
            selectedRecord.revision,
          );
          if (result.outcome === "stale") {
            throw new Error(
              "This source changed after you opened it. Review the latest version, then try again.",
            );
          }
          setEditingSource(false);
          setSelectedSourceId(null);
        }}
        onApproveReview={async () => {
          const result = await sources.approveSource(
            selectedRecord.sourceId,
            selectedRecord.revision,
          );
          if (result.outcome === "stale") {
            throw new Error(
              "This source changed after you opened it. Review the latest version, then try again.",
            );
          }
        }}
        onOpenPdf={props.onOpenPdf}
      />
    );
  }

  return (
    <div
      className="flex min-h-0 flex-1 flex-col"
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes("Files")) return;
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
        if (!event.dataTransfer.files.length) return;
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
      <PanelHeader
        title="Sources"
        action={
          <Menu>
            <MenuTrigger
              render={
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={sources.busy || sources.checkingZotero}
                  aria-label="Import sources"
                >
                  {sources.busy || sources.checkingZotero ? (
                    <LoaderCircle className="animate-spin" />
                  ) : (
                    <Download />
                  )}
                  Import sources
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
            </MenuPopup>
          </Menu>
        }
      />
      {dragActive ? (
        <div className="mx-3 mt-2 rounded-md border border-dashed border-foreground/30 bg-muted/35 px-3 py-2 text-center text-xs text-muted-foreground">
          Drop PDF files to add them to Sources
        </div>
      ) : null}
      {sources.importPreparation ? (
        <div className="mx-3 mt-3 flex items-center gap-2 rounded-md bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          <LoaderCircle className="size-4 shrink-0 animate-spin" />
          <span className="truncate">
            Reading article metadata…
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
      {sources.operation ? (
        <ImportSummary
          operation={sources.operation}
          outcome={
            importOutcome?.operation?.operationId === sources.operation.operationId
              ? importOutcome
              : null
          }
          onDismiss={sources.clearOperationSummary}
          onCancel={() => void sources.cancelImport()}
          cancelling={sources.cancelling}
          {...(sources.operation.state !== "cancelled" &&
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
      {sources.overview.records.length > 0 ? (
        <div className="mt-2 mb-1 ml-3 mr-4 flex min-h-8 shrink-0 items-center gap-1 rounded-md text-sm text-muted-foreground">
          <div className="flex min-w-0 flex-1 cursor-text items-center gap-2 rounded-md px-2 transition-colors hover:bg-accent hover:text-accent-foreground focus-within:bg-accent focus-within:text-accent-foreground">
            <Search className="size-4 shrink-0 text-muted-foreground/80" aria-hidden="true" />
            <Input
              nativeInput
              unstyled
              type="search"
              aria-label="Search project sources"
              placeholder="Search title, author, DOI, year, or keyword"
              value={sourceQuery}
              onChange={(event) => setSourceQuery(event.currentTarget.value)}
              className="min-w-0 flex-1 [&_[data-slot=input]]:h-8 [&_[data-slot=input]]:p-0 [&_[data-slot=input]]:leading-normal [&_[data-slot=input]]:text-sm [&_[data-slot=input]]:font-medium [&_[data-slot=input]]:text-foreground [&_[data-slot=input]]:placeholder:text-muted-foreground"
            />
            {sourceQuery ? (
              <Button
                type="button"
                size="icon-xs"
                variant="ghost"
                className="size-5 shrink-0 rounded-sm text-muted-foreground hover:bg-muted"
                aria-label="Clear source search"
                onClick={() => setSourceQuery("")}
              >
                <X />
              </Button>
            ) : null}
          </div>
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
              size="sm"
              variant="ghost"
              className="w-auto shrink-0 cursor-pointer gap-1 px-1.5"
              aria-label="Sort sources"
            >
              <ArrowDownUp className="size-3.5" aria-hidden="true" />
              <SelectValue className="max-w-20 truncate text-xs" />
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
      {sources.overview.records.length === 0 ? (
        <CenteredState
          icon={<BookOpen />}
          title="No sources yet"
          description="Import PDFs from this computer or references from Zotero. Scient keeps a portable project copy."
        />
      ) : (
        <ScrollArea className="min-h-0 flex-1">
          <div className="divide-y divide-border">
            {filteredSourceRecords.map((record) => {
              const materialSelection = selectScientSourceMaterial({
                materials: record.attachments,
              });
              const pdf = materialSelection._tag === "Selected" ? materialSelection.material : null;
              const hasPdf =
                materialSelection._tag === "Selected" ||
                materialSelection._tag === "SeveralMaterials";
              const metadataDiagnostics = diagnosticsBySourceId.get(record.sourceId);
              return (
                <div
                  key={record.sourceId}
                  className="group flex w-full items-start gap-2 px-2 py-1.5 hover:bg-accent/40"
                  onContextMenu={(event) => void showSourceContextMenu(event, record)}
                >
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <button
                          type="button"
                          className="flex min-w-0 flex-1 cursor-pointer items-start gap-3 rounded-md px-1 py-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          onClick={() => openSourceDetails(record.sourceId)}
                        >
                          <SourceJournalIcon
                            environmentId={props.environmentId}
                            root={props.root}
                            record={record}
                          />
                          <span className="min-w-0 flex-1">
                            <span className="block text-sm font-medium">
                              {record.title ?? "Untitled source"}
                            </span>
                            <span className="mt-0.5 block text-xs text-muted-foreground">
                              {creatorLabel(record)}
                              {record.issuedYear ? ` · ${record.issuedYear}` : ""}
                              {hasPdf ? " · PDF" : " · Metadata only"}
                              {" · "}
                              <span
                                className={
                                  recentlyAddedSourceIds.has(record.sourceId)
                                    ? "font-medium text-sky-600 dark:text-sky-400"
                                    : undefined
                                }
                              >
                                {sourceAddedLabel(
                                  record.importedAt,
                                  recentlyAddedSourceIds.has(record.sourceId),
                                  record.origin?.actor === "agent",
                                )}
                              </span>
                              {record.origin?.review === "pending" ? " · Pending review" : ""}
                            </span>
                          </span>
                        </button>
                      }
                    />
                    <TooltipPopup side="top">View source details</TooltipPopup>
                  </Tooltip>
                  <div className="mt-0.5 mr-1 flex shrink-0 items-center gap-1">
                    <span className="flex size-7 shrink-0 items-center justify-center">
                      {metadataDiagnostics && metadataDiagnostics.length > 0 ? (
                        <MetadataReviewIndicator
                          diagnostics={metadataDiagnostics}
                          onOpen={() => openSourceDetails(record.sourceId)}
                        />
                      ) : null}
                    </span>
                    <span className="flex size-7 shrink-0 items-center justify-center">
                      {pdf ? (
                        <ScientTooltip content="Open PDF">
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            aria-label={`Open PDF: ${pdf.fileName}`}
                            onClick={() => {
                              props.onOpenPdf({
                                sourceId: record.sourceId,
                                attachmentId: pdf.attachmentId,
                                fileName: pdf.fileName,
                              });
                            }}
                          >
                            <FileText />
                          </Button>
                        </ScientTooltip>
                      ) : materialSelection._tag === "SeveralMaterials" ? (
                        <ScientTooltip content="Choose a PDF in source details">
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            aria-label={`Choose a PDF to open: ${record.title ?? "Untitled source"}`}
                            onClick={() => openSourceDetails(record.sourceId)}
                          >
                            <FileText />
                          </Button>
                        </ScientTooltip>
                      ) : null}
                    </span>
                    <ScientTooltip content="More source actions">
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        aria-label="More source actions"
                        onClick={(event) => {
                          event.stopPropagation();
                          const bounds = event.currentTarget.getBoundingClientRect();
                          void showSourceContextMenuAt(record, {
                            x: bounds.right,
                            y: bounds.bottom,
                          });
                        }}
                      >
                        <MoreVertical />
                      </Button>
                    </ScientTooltip>
                  </div>
                </div>
              );
            })}
            {filteredSourceRecords.length === 0 ? (
              <div className="p-8 text-center text-sm text-muted-foreground">
                No matching sources were found.
              </div>
            ) : null}
          </div>
        </ScrollArea>
      )}
      {sourcePendingRemoval ? (
        <SourceRemovalConfirmation
          key={sourcePendingRemoval.record.sourceId}
          open
          record={sourcePendingRemoval.record}
          anchorPoint={sourcePendingRemoval.anchorPoint}
          onOpenChange={(open) => {
            if (!open) setSourcePendingRemoval(null);
          }}
          onRemove={async () => {
            const result = await sources.removeSource(
              sourcePendingRemoval.record.sourceId,
              sourcePendingRemoval.record.revision,
            );
            if (result.outcome === "stale") {
              throw new Error(
                "This source changed after you opened it. Review the latest version, then try again.",
              );
            }
            if (selectedSourceId === sourcePendingRemoval.record.sourceId) {
              setEditingSource(false);
              setSelectedSourceId(null);
            }
          }}
        />
      ) : null}
    </div>
  );
}

function ImportReview(props: {
  readonly preflight: NonNullable<ReturnType<typeof useScientSources>["preflight"]>;
  readonly adapter: "zotero" | "local-files";
  readonly busy: boolean;
  readonly error: string | null;
  readonly onDismissError: () => void;
  readonly onBack: () => void;
  readonly onImport: (
    itemKeys: ReadonlyArray<string>,
    possibleMetadataMatchOverrides: ReadonlyArray<string>,
  ) => void;
}) {
  const [possibleMatchOverrides, setPossibleMatchOverrides] = useState<ReadonlySet<string>>(
    new Set(),
  );
  const itemKeys = props.preflight.items.flatMap((item) => {
    const itemKey = item.candidate.sourceKey;
    return item.duplicate.kind === "new" || possibleMatchOverrides.has(itemKey) ? [itemKey] : [];
  });
  const overrideKeys = props.preflight.items.flatMap((item) => {
    const itemKey = item.candidate.sourceKey;
    return item.duplicate.kind === "possible-metadata-match" && possibleMatchOverrides.has(itemKey)
      ? [itemKey]
      : [];
  });
  const importableKeys = new Set(itemKeys);
  const selectedCount = props.preflight.items.length;
  const localFiles = props.adapter === "local-files";
  const hasMetadataWarnings = props.preflight.items.some(
    (item) => importableKeys.has(item.candidate.sourceKey) && item.metadataDiagnostics.length > 0,
  );
  const localActionLabel = props.busy
    ? "Adding…"
    : hasMetadataWarnings
      ? itemKeys.length > 1
        ? `Add ${itemKeys.length} anyway`
        : "Add anyway"
      : "Add to Sources";

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PanelHeader
        title={
          localFiles
            ? selectedCount === 1
              ? "Review PDF"
              : `Review ${selectedCount} PDFs`
            : "Review import"
        }
        onBack={props.onBack}
        action={
          !localFiles && itemKeys.length > 0 ? (
            <Button
              size="xs"
              variant="ghost"
              disabled={props.busy}
              onClick={() => props.onImport(itemKeys, overrideKeys)}
            >
              <Download />
              Import {itemKeys.length}
            </Button>
          ) : null
        }
      />
      {props.error ? (
        <SourceErrorBanner message={props.error} onDismiss={props.onDismissError} />
      ) : null}
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
        <span>
          {itemKeys.length > 0
            ? localFiles
              ? `${itemKeys.length} PDF${itemKeys.length === 1 ? "" : "s"} ready`
              : `${itemKeys.length} of ${selectedCount} selected ${selectedCount === 1 ? "reference is" : "references are"} ready to import`
            : localFiles
              ? "Nothing new to add"
              : "Nothing new to import"}
        </span>
        {localFiles && itemKeys.length > 0 ? (
          <Button
            size="xs"
            variant="ghost"
            disabled={props.busy}
            aria-busy={props.busy}
            onClick={() => props.onImport(itemKeys, overrideKeys)}
          >
            {props.busy ? <LoaderCircle className="animate-spin" /> : <Download />}
            {localActionLabel}
          </Button>
        ) : null}
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="divide-y divide-border">
          {props.preflight.items.map((item) => {
            const itemKey = item.candidate.sourceKey;
            const possibleMatch = item.duplicate.kind === "possible-metadata-match";
            const importingPossibleMatch = possibleMatchOverrides.has(itemKey);
            const willImport = item.duplicate.kind === "new" || importingPossibleMatch;
            const metadataSummary = candidateMetadataSummary(item.candidate);
            const duplicateStatus =
              item.duplicate.kind === "same-origin"
                ? "Already in Sources"
                : item.duplicate.kind === "same-identifier"
                  ? "A source with this identifier is already in Sources"
                  : item.duplicate.kind === "same-pdf"
                    ? "This PDF is already in Sources"
                    : item.duplicate.reason;
            return (
              <div key={itemKey} className={willImport ? "bg-accent/20 px-3 py-3" : "px-3 py-3"}>
                <div className="flex min-w-0 items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium">
                      {item.candidate.title ?? "Untitled source"}
                    </div>
                    {localFiles && item.duplicate.kind === "new" ? (
                      metadataSummary ? (
                        <div className="mt-1 text-xs text-muted-foreground">{metadataSummary}</div>
                      ) : null
                    ) : (
                      <div className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
                        {item.duplicate.kind === "new" || importingPossibleMatch ? (
                          <CheckCircle2 className="size-3.5 shrink-0" aria-hidden="true" />
                        ) : possibleMatch ? (
                          <AlertCircle
                            className="size-3.5 shrink-0 text-amber-600"
                            aria-hidden="true"
                          />
                        ) : (
                          <CheckCircle2 className="size-3.5 shrink-0" aria-hidden="true" />
                        )}
                        <span>
                          {item.duplicate.kind === "new"
                            ? "Ready to import"
                            : importingPossibleMatch
                              ? "Will import as a separate source"
                              : duplicateStatus}
                        </span>
                      </div>
                    )}
                  </div>
                  {possibleMatch ? (
                    <label className="flex shrink-0 cursor-pointer items-center gap-2 text-xs text-muted-foreground">
                      <Checkbox
                        checked={importingPossibleMatch}
                        className="size-4 border-border bg-transparent shadow-none [&_[data-slot=checkbox-indicator]]:bg-accent [&_[data-slot=checkbox-indicator]]:text-foreground"
                        onCheckedChange={() => {
                          setPossibleMatchOverrides((current) => {
                            const next = new Set(current);
                            if (next.has(itemKey)) next.delete(itemKey);
                            else next.add(itemKey);
                            return next;
                          });
                        }}
                      />
                      Import separately
                    </label>
                  ) : null}
                </div>
                {willImport &&
                props.adapter === "zotero" &&
                item.candidate.pdfAttachmentCount > 1 ? (
                  <div className="mt-2 flex items-start gap-1.5 text-xs text-amber-700 dark:text-amber-300">
                    <FileText className="mt-px size-3.5 shrink-0" aria-hidden="true" />
                    <span>
                      {item.candidate.pdfAttachmentCount} PDFs in Zotero · importing{" "}
                      {item.candidate.pdfFileName ?? "one PDF"}
                    </span>
                  </div>
                ) : null}
                {willImport && item.metadataDiagnostics.length > 0 ? (
                  <div className="mt-2 flex items-start gap-1.5 text-xs text-amber-700 dark:text-amber-300">
                    <AlertCircle className="mt-px size-3.5 shrink-0" aria-hidden="true" />
                    <span>
                      {item.metadataDiagnostics.map((diagnostic) => diagnostic.message).join(" ")}
                    </span>
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      </ScrollArea>
    </div>
  );
}

function PanelHeader(props: {
  readonly title: ReactNode;
  readonly description?: string;
  readonly action?: ReactNode;
  readonly onBack?: () => void;
}) {
  return (
    <div className="flex shrink-0 items-center gap-3 border-b border-border p-3">
      {props.onBack ? (
        <Button variant="ghost" size="icon-sm" onClick={props.onBack} aria-label="Go back">
          <ChevronLeft />
        </Button>
      ) : (
        <Library className="size-4 shrink-0" />
      )}
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium">{props.title}</div>
        {props.description ? (
          <div className="truncate text-xs text-muted-foreground">{props.description}</div>
        ) : null}
      </div>
      {props.action}
    </div>
  );
}

function ImportSummary(props: {
  readonly operation: NonNullable<ReturnType<typeof useScientSources>["operation"]>;
  readonly outcome: ScientSourcesImportOutcome | null;
  readonly onDismiss: () => void;
  readonly onCancel: () => void;
  readonly cancelling: boolean;
  readonly onRetryFailed?: () => void;
}) {
  const counts = props.outcome?.counts ?? completedImportCounts(props.operation);
  const imported = counts.imported;
  const alreadyPresent = counts.alreadyPresent;
  const reviewRequired = counts.reviewRequired;
  const failed = counts.failed;
  const unprocessed = props.operation.items.filter((item) => item.state === "pending").length;
  const running = props.operation.state === "running";
  const stopped = props.operation.state === "cancelled";
  if (
    !running &&
    !stopped &&
    failed === 0 &&
    unprocessed === 0 &&
    alreadyPresent === 0 &&
    reviewRequired === 0
  )
    return null;
  const details = running
    ? [`${importedCount(props.operation)} of ${props.operation.items.length} items processed`]
    : [
        `${imported} imported`,
        alreadyPresent > 0 ? `${alreadyPresent} already present` : null,
        reviewRequired > 0 ? `${reviewRequired} need review` : null,
        failed > 0 ? `${failed} failed` : null,
        unprocessed > 0 ? `${unprocessed} not processed` : null,
      ].filter((value): value is string => value !== null);
  return (
    <div
      className={
        failed > 0
          ? "m-3 flex items-start gap-3 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3"
          : "m-3 flex items-start gap-3 rounded-lg border border-border bg-muted/30 p-3"
      }
    >
      {running ? (
        <LoaderCircle className="mt-0.5 size-4 shrink-0 animate-spin text-muted-foreground" />
      ) : failed > 0 ? (
        <AlertCircle className="mt-0.5 size-4 shrink-0 text-amber-600" />
      ) : (
        <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-600" />
      )}
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium">
          {stopped ? "Import stopped" : running ? "Importing sources" : "Import complete"}
        </div>
        <div className="mt-0.5 text-xs text-muted-foreground">{details.join(" · ")}</div>
        {failed > 0 ? (
          <div className="mt-1 space-y-0.5 text-xs text-muted-foreground">
            {props.operation.items
              .filter((item) => item.state === "failed")
              .slice(0, 3)
              .map((item) => (
                <div key={item.itemKey} className="truncate">
                  {item.itemKey}: {item.message ?? "Import failed."}
                </div>
              ))}
          </div>
        ) : null}
        {failed > 0 && props.onRetryFailed ? (
          <Button className="mt-2" size="xs" variant="outline" onClick={props.onRetryFailed}>
            Try failed items again
          </Button>
        ) : null}
        {running ? (
          <Button
            className="mt-2"
            size="xs"
            variant="ghost"
            disabled={props.cancelling}
            onClick={props.onCancel}
          >
            {props.cancelling ? <LoaderCircle className="animate-spin" /> : <X />}
            {props.cancelling ? "Stopping…" : "Cancel after current item"}
          </Button>
        ) : null}
      </div>
      {running ? null : (
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Dismiss import summary"
          onClick={props.onDismiss}
        >
          <X />
        </Button>
      )}
    </div>
  );
}

function AlreadyPresentSummary(props: {
  readonly outcome: ScientSourcesImportOutcome;
  readonly onDismiss: () => void;
  readonly onViewExisting?: () => void;
}) {
  const count = props.outcome.counts.alreadyPresent;
  return (
    <div className="m-3 flex items-start gap-3 rounded-lg border border-border bg-muted/30 p-3">
      <Info className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium">Already in Sources</div>
        <div className="mt-0.5 text-xs text-muted-foreground">
          {count === 1
            ? "This source is already in this project."
            : `${count} selected sources are already in this project.`}
        </div>
        {props.onViewExisting ? (
          <Button className="mt-2" size="xs" variant="ghost" onClick={props.onViewExisting}>
            View existing source
          </Button>
        ) : null}
      </div>
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label="Dismiss import result"
        onClick={props.onDismiss}
      >
        <X />
      </Button>
    </div>
  );
}

function CenteredState(props: {
  readonly icon: ReactNode;
  readonly title: string;
  readonly description?: string;
  readonly action?: ReactNode;
}) {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center p-6">
      <div className="flex max-w-sm flex-col items-center text-center">
        <div className="mb-3 text-muted-foreground [&_svg]:size-6">{props.icon}</div>
        <h2 className="text-base font-medium">{props.title}</h2>
        {props.description ? (
          <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{props.description}</p>
        ) : null}
        {props.action ? <div className="mt-4">{props.action}</div> : null}
      </div>
    </div>
  );
}
