import type {
  EnvironmentId,
  ScientSourcesOverviewResult,
  ScientSourcesPreflightResult,
} from "@t3tools/contracts";
import {
  AlertCircle,
  BookOpen,
  CheckCircle2,
  ChevronLeft,
  Download,
  ExternalLink,
  FileUp,
  FileText,
  Library,
  LoaderCircle,
  Info,
  RefreshCw,
  Search,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { Button } from "../../components/ui/button";
import { Checkbox } from "../../components/ui/checkbox";
import { Input } from "../../components/ui/input";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../../components/ui/menu";
import { Popover, PopoverPopup, PopoverTrigger } from "../../components/ui/popover";
import { ScrollArea } from "../../components/ui/scroll-area";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../components/ui/tooltip";
import { initializeScientProjectForOpening } from "../../lib/scientProjectInitialization";
import { readLocalApi } from "../../localApi";
import { readPreparedConnection } from "../../state/session";
import { SourceDetails } from "./SourceDetails";
import { SourceEditor } from "./SourceEditor";
import { useScientSources } from "./useScientSources";

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

export function ScientSourcesPanel(props: {
  readonly environmentId: EnvironmentId;
  readonly root: string;
  readonly projectTitle: string;
  readonly onOpenPdf: (input: { readonly attachmentId: string; readonly fileName: string }) => void;
}) {
  const sources = useScientSources({ environmentId: props.environmentId, root: props.root });
  const [query, setQuery] = useState("");
  const [selectedKeys, setSelectedKeys] = useState<ReadonlySet<string>>(new Set());
  const [settingUpProject, setSettingUpProject] = useState(false);
  const [setupError, setSetupError] = useState<string | null>(null);
  const [selectedSourceId, setSelectedSourceId] = useState<string | null>(null);
  const [editingSource, setEditingSource] = useState(false);
  const localFileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setSelectedSourceId(null);
    setEditingSource(false);
  }, [props.environmentId, props.root]);

  useEffect(() => {
    if (sources.library) return;
    setQuery("");
    setSelectedKeys(new Set());
  }, [sources.library]);

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
  const selectedRecord =
    sources.overview?.records.find((record) => record.sourceId === selectedSourceId) ?? null;

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

  if (sources.preparingLocalFiles.length > 0) {
    const count = sources.preparingLocalFiles.length;
    return (
      <CenteredState
        icon={<LoaderCircle className="animate-spin" />}
        title="Reading PDF metadata…"
        description={
          count === 1
            ? (sources.preparingLocalFiles[0] ?? "Preparing the selected PDF for review.")
            : `Preparing ${count} PDFs for review.`
        }
      />
    );
  }

  if (sources.operation?.state === "running") {
    const completed = importedCount(sources.operation);
    const total = sources.operation.items.length;
    return (
      <CenteredState
        icon={<LoaderCircle className="animate-spin" />}
        title="Importing sources"
        description={`${completed} of ${total} items processed. Completed items are already safe in this project.`}
        action={
          <div className="flex gap-2">
            {!sources.busy ? (
              <Button onClick={() => void sources.resumeImport()}>Resume import</Button>
            ) : null}
            <Button
              variant="outline"
              disabled={sources.cancelling}
              onClick={() => void sources.cancelImport()}
            >
              {sources.cancelling ? <LoaderCircle className="animate-spin" /> : <X />}
              {sources.cancelling ? "Stopping…" : "Cancel after current item"}
            </Button>
          </div>
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
        onBack={sources.resetImport}
        onImport={(itemKeys, possibleMetadataMatchOverrides) =>
          void sources.runImport(itemKeys, possibleMetadataMatchOverrides)
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
        </div>
        {selectedKeys.size > 0 ? (
          <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border bg-muted/30 px-3 py-2">
            <span className="text-xs text-muted-foreground">
              {selectedKeys.size} reference{selectedKeys.size === 1 ? "" : "s"} selected
            </span>
            <Button
              size="xs"
              variant="ghost"
              disabled={sources.busy}
              onClick={() => void sources.previewImport([...selectedKeys])}
            >
              Review import
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
            {sources.library.items.length === 0 ? (
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
        record={selectedRecord}
        diagnostics={diagnosticsBySourceId.get(selectedRecord.sourceId) ?? []}
        onBack={() => {
          setEditingSource(false);
          setSelectedSourceId(null);
        }}
        onEdit={() => setEditingSource(true)}
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
        onOpenPdf={props.onOpenPdf}
      />
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
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
          void sources.uploadLocalFiles(files);
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
      {sources.error ? (
        <div className="m-3 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
          {sources.error}
        </div>
      ) : null}
      {sources.operation ? (
        <ImportSummary
          operation={sources.operation}
          onDismiss={sources.clearOperationSummary}
          {...(sources.operation.adapter === "zotero" &&
          sources.operation.items.some((item) => item.state === "failed")
            ? {
                onRetryFailed: () =>
                  void sources.previewImport(
                    sources.operation?.items.flatMap((item) =>
                      item.state === "failed" ? [item.itemKey] : [],
                    ) ?? [],
                  ),
              }
            : {})}
        />
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
            {sources.overview.records.map((record) => {
              const pdf = record.attachments.find((attachment) => attachment.kind === "pdf");
              const metadataDiagnostics = diagnosticsBySourceId.get(record.sourceId);
              return (
                <div
                  key={record.sourceId}
                  className="group flex w-full items-start gap-2 px-2 py-1.5 hover:bg-accent/40"
                >
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <button
                          type="button"
                          className="flex min-w-0 flex-1 cursor-pointer items-start gap-3 rounded-md px-1 py-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          onClick={() => setSelectedSourceId(record.sourceId)}
                        >
                          <BookOpen className="mt-0.5 size-4 shrink-0" />
                          <span className="min-w-0 flex-1">
                            <span className="block text-sm font-medium">
                              {record.title ?? "Untitled source"}
                            </span>
                            <span className="mt-0.5 block text-xs text-muted-foreground">
                              {creatorLabel(record)}
                              {record.issuedYear ? ` · ${record.issuedYear}` : ""}
                              {pdf ? " · PDF" : " · Metadata only"}
                              {metadataDiagnostics && metadataDiagnostics.length > 0
                                ? " · Metadata needs review"
                                : ""}
                            </span>
                          </span>
                        </button>
                      }
                    />
                    <TooltipPopup side="top">View source details</TooltipPopup>
                  </Tooltip>
                  {pdf ? (
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className="mt-0.5 mr-2"
                      aria-label={`Open PDF: ${pdf.fileName}`}
                      title="Open PDF"
                      onClick={() =>
                        props.onOpenPdf({
                          attachmentId: pdf.attachmentId,
                          fileName: pdf.fileName,
                        })
                      }
                    >
                      <FileText />
                    </Button>
                  ) : null}
                  {metadataDiagnostics && metadataDiagnostics.length > 0 ? (
                    <AlertCircle
                      className="mt-2 size-4 shrink-0 text-amber-600"
                      aria-label="Metadata needs review"
                    />
                  ) : null}
                </div>
              );
            })}
          </div>
        </ScrollArea>
      )}
    </div>
  );
}

function ImportReview(props: {
  readonly preflight: NonNullable<ReturnType<typeof useScientSources>["preflight"]>;
  readonly adapter: "zotero" | "local-files";
  readonly busy: boolean;
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
  readonly onDismiss: () => void;
  readonly onRetryFailed?: () => void;
}) {
  const imported = props.operation.items.filter((item) => item.state === "imported").length;
  const skipped = props.operation.items.filter((item) => item.state === "skipped").length;
  const failed = props.operation.items.filter((item) => item.state === "failed").length;
  const unprocessed = props.operation.items.filter((item) => item.state === "pending").length;
  const stopped = props.operation.state === "cancelled";
  const completedLocalImport =
    props.operation.adapter === "local-files" && !stopped && failed === 0 && unprocessed === 0;
  const details = [
    `${imported} imported`,
    skipped > 0 ? `${skipped} skipped` : null,
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
      {failed > 0 ? (
        <AlertCircle className="mt-0.5 size-4 shrink-0 text-amber-600" />
      ) : (
        <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-600" />
      )}
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium">
          {stopped
            ? "Import stopped"
            : completedLocalImport
              ? "Added to Sources"
              : "Import complete"}
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
      </div>
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label="Dismiss import summary"
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
