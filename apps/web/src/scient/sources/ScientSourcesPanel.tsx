import type {
  EnvironmentId,
  ScientSourcesOverviewResult,
  ScopedThreadRef,
} from "@t3tools/contracts";
import {
  AlertCircle,
  BookOpen,
  CheckCircle2,
  ChevronLeft,
  Download,
  ExternalLink,
  FileText,
  Library,
  LoaderCircle,
  RefreshCw,
  Search,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";

import { Button } from "../../components/ui/button";
import { Checkbox } from "../../components/ui/checkbox";
import { Input } from "../../components/ui/input";
import { ScrollArea } from "../../components/ui/scroll-area";
import { initializeScientProjectForOpening } from "../../lib/scientProjectInitialization";
import { readLocalApi } from "../../localApi";
import { readPreparedConnection } from "../../state/session";
import { SourcePdfPreview } from "./SourcePdfPreview";
import { useScientSources } from "./useScientSources";

function creatorLabel(record: ScientSourcesOverviewResult["records"][number]): string {
  const creator = record.creators[0];
  return creator?.familyName ?? creator?.literalName ?? creator?.givenName ?? "Unknown creator";
}

function importedCount(operation: NonNullable<ReturnType<typeof useScientSources>["operation"]>) {
  return operation.items.filter((item) => item.state !== "pending").length;
}

export function ScientSourcesPanel(props: {
  readonly environmentId: EnvironmentId;
  readonly root: string;
  readonly projectTitle: string;
  readonly threadRef: ScopedThreadRef;
}) {
  const sources = useScientSources({ environmentId: props.environmentId, root: props.root });
  const [query, setQuery] = useState("");
  const [selectedKeys, setSelectedKeys] = useState<ReadonlySet<string>>(new Set());
  const [selectedSourceId, setSelectedSourceId] = useState<string | null>(null);
  const [selectedAttachmentId, setSelectedAttachmentId] = useState<string | null>(null);
  const [settingUpProject, setSettingUpProject] = useState(false);
  const [setupError, setSetupError] = useState<string | null>(null);

  useEffect(() => {
    if (sources.library) return;
    setQuery("");
    setSelectedKeys(new Set());
  }, [sources.library]);

  const selectedSource =
    sources.overview?.records.find((record) => record.sourceId === selectedSourceId) ?? null;
  const selectedAttachment = selectedSource?.attachments.find(
    (attachment) => attachment.attachmentId === selectedAttachmentId,
  );
  const selectedAttachmentPath = sources.overview?.attachmentLocations.find(
    (location) => location.attachmentId === selectedAttachmentId,
  )?.absolutePath;

  const toggleSelected = useCallback((itemKey: string) => {
    setSelectedKeys((current) => {
      const next = new Set(current);
      if (next.has(itemKey)) next.delete(itemKey);
      else next.add(itemKey);
      return next;
    });
  }, []);

  const importableKeys = useMemo(
    () =>
      sources.preflight?.items.flatMap((item) =>
        item.duplicate.kind === "new" ? [item.candidate.externalReference.itemKey] : [],
      ) ?? [],
    [sources.preflight],
  );
  const diagnosticsBySourceId = useMemo(
    () =>
      new Map(
        sources.overview?.recordDiagnostics.map((entry) => [entry.sourceId, entry.diagnostics]) ??
          [],
      ),
    [sources.overview?.recordDiagnostics],
  );

  if (selectedSource && selectedAttachment && selectedAttachmentPath) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-3">
          <Button
            variant="ghost"
            size="xs"
            onClick={() => {
              setSelectedAttachmentId(null);
              setSelectedSourceId(null);
            }}
          >
            <ChevronLeft />
            Sources
          </Button>
          <span className="min-w-0 truncate text-sm font-medium">
            {selectedSource.title ?? selectedAttachment.fileName}
          </span>
        </div>
        <div className="min-h-0 flex-1">
          <SourcePdfPreview
            absolutePath={selectedAttachmentPath}
            environmentId={props.environmentId}
            fileName={selectedAttachment.fileName}
            threadRef={props.threadRef}
          />
        </div>
      </div>
    );
  }

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
      <div className="flex min-h-0 flex-1 flex-col">
        <PanelHeader
          title="Review import"
          description={`${sources.preflight.items.length} selected item${sources.preflight.items.length === 1 ? "" : "s"}`}
          onBack={sources.resetImport}
        />
        <ScrollArea className="min-h-0 flex-1">
          <div className="space-y-2 p-3">
            {sources.preflight.items.map((item) => (
              <div
                key={item.candidate.externalReference.itemKey}
                className="rounded-lg border border-border p-3"
              >
                <div className="font-medium text-sm">
                  {item.candidate.title ?? "Untitled source"}
                </div>
                <div className="mt-1 text-xs text-muted-foreground">
                  {item.duplicate.kind === "new" ? "Ready to import" : item.duplicate.reason}
                </div>
                {item.metadataDiagnostics.length > 0 ? (
                  <div className="mt-2 text-xs text-amber-700 dark:text-amber-300">
                    {item.metadataDiagnostics.map((diagnostic) => diagnostic.message).join(" ")}
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        </ScrollArea>
        <div className="flex shrink-0 items-center justify-end gap-2 border-t border-border p-3">
          <Button variant="outline" onClick={sources.resetImport}>
            Back
          </Button>
          <Button
            disabled={importableKeys.length === 0 || sources.busy}
            onClick={() => void sources.runImport(importableKeys)}
          >
            <Download />
            Import {importableKeys.length}
          </Button>
        </div>
      </div>
    );
  }

  if (sources.library) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <PanelHeader
          title="Import from Zotero"
          description="Choose references from your local library. Zotero remains unchanged."
          onBack={sources.closeLibrary}
        />
        <form
          className="flex shrink-0 gap-2 border-b border-border p-3"
          onSubmit={(event) => {
            event.preventDefault();
            void sources.searchZotero(query);
          }}
        >
          <Input
            nativeInput
            type="search"
            aria-label="Search Zotero library"
            placeholder="Search title, creator, or year"
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
          />
          <Button
            type="submit"
            variant="outline"
            aria-label="Search Zotero"
            disabled={sources.busy}
          >
            <Search />
          </Button>
        </form>
        <ScrollArea className="min-h-0 flex-1">
          <div className="divide-y divide-border">
            {sources.library.items.map((item) => {
              const key = item.externalReference.itemKey;
              const checked = selectedKeys.has(key);
              const creator = item.creators[0];
              return (
                <label
                  key={key}
                  className="flex cursor-pointer items-start gap-3 px-3 py-3 hover:bg-accent/40"
                >
                  <Checkbox checked={checked} onCheckedChange={() => toggleSelected(key)} />
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
                No matching Zotero references were found.
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
        <div className="flex shrink-0 items-center justify-between border-t border-border p-3">
          <span className="text-xs text-muted-foreground">{sources.library.total} references</span>
          <Button
            disabled={selectedKeys.size === 0 || sources.busy}
            onClick={() => void sources.previewImport([...selectedKeys])}
          >
            Review {selectedKeys.size}
          </Button>
        </div>
      </div>
    );
  }

  if (sources.zoteroStatus && sources.zoteroStatus.state !== "ready") {
    return (
      <CenteredState
        icon={<AlertCircle />}
        title="Zotero is not ready"
        description={sources.zoteroStatus.message}
        action={
          <div className="flex flex-wrap justify-center gap-2">
            <Button variant="ghost" onClick={sources.closeZoteroStatus}>
              <ChevronLeft />
              Back to Sources
            </Button>
            <Button variant="outline" onClick={() => void sources.checkZotero()}>
              <RefreshCw />
              Check again
            </Button>
            {sources.zoteroStatus.state === "unreachable" ? (
              <Button
                variant="ghost"
                onClick={() =>
                  void readLocalApi()?.shell.openExternal("https://www.zotero.org/download/")
                }
              >
                <ExternalLink />
                Get Zotero
              </Button>
            ) : null}
          </div>
        }
      />
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PanelHeader
        title="Sources"
        description="Project-owned references and PDFs"
        action={
          <Button
            size="sm"
            onClick={() => {
              void sources.checkZotero().then((status) => {
                if (status?.state === "ready") void sources.searchZotero("");
              });
            }}
            disabled={sources.busy}
          >
            {sources.busy ? <LoaderCircle className="animate-spin" /> : <Download />}
            Import from Zotero
          </Button>
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
          {...(sources.operation.items.some((item) => item.state === "failed")
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
          description="Import selected references from Zotero. Scient stores its own portable copy in this project."
        />
      ) : (
        <ScrollArea className="min-h-0 flex-1">
          <div className="divide-y divide-border">
            {sources.overview.records.map((record) => {
              const pdf = record.attachments.find((attachment) => attachment.kind === "pdf");
              const metadataDiagnostics = diagnosticsBySourceId.get(record.sourceId);
              return (
                <button
                  key={record.sourceId}
                  type="button"
                  className="flex w-full items-start gap-3 px-3 py-3 text-left enabled:cursor-pointer enabled:hover:bg-accent/40 disabled:cursor-default"
                  onClick={() => {
                    setSelectedSourceId(record.sourceId);
                    setSelectedAttachmentId(pdf?.attachmentId ?? null);
                  }}
                  disabled={!pdf}
                >
                  {pdf ? (
                    <FileText className="mt-0.5 size-4 shrink-0" />
                  ) : (
                    <BookOpen className="mt-0.5 size-4 shrink-0" />
                  )}
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
                  {metadataDiagnostics && metadataDiagnostics.length > 0 ? (
                    <AlertCircle
                      className="mt-0.5 size-4 shrink-0 text-amber-600"
                      aria-label="Metadata needs review"
                    />
                  ) : (
                    <CheckCircle2
                      className="mt-0.5 size-4 shrink-0 text-emerald-600"
                      aria-label="Metadata complete"
                    />
                  )}
                </button>
              );
            })}
          </div>
        </ScrollArea>
      )}
    </div>
  );
}

function PanelHeader(props: {
  readonly title: string;
  readonly description: string;
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
        <div className="truncate text-xs text-muted-foreground">{props.description}</div>
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
        <div className="text-sm font-medium">{stopped ? "Import stopped" : "Import complete"}</div>
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
