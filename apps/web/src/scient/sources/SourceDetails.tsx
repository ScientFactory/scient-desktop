import type {
  ScientSourceDetailResult,
  ScientSourceNoteUpdateResult,
  ScientSourcesOverviewResult,
} from "@t3tools/contracts";
import {
  AlertCircle,
  AlertTriangle,
  Check,
  ChevronLeft,
  Copy,
  ExternalLink,
  FileText,
  LoaderCircle,
  MoreHorizontal,
  Pencil,
  RefreshCw,
} from "lucide-react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";

import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../../components/ui/menu";
import {
  Popover,
  PopoverDescription,
  PopoverPopup,
  PopoverTitle,
} from "../../components/ui/popover";
import { ScrollArea } from "../../components/ui/scroll-area";
import { toastManager } from "../../components/ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../components/ui/tooltip";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { readLocalApi } from "../../localApi";
import { scientSourcesErrorMessage } from "./errorMessage";
import { SourceReference } from "./SourceReference";
import { useSourceNoteControls } from "./SourceNote";
import {
  SourceRemovalConfirmation,
  type SourceRemovalAnchorPoint,
} from "./SourceRemovalConfirmation";

type SourceRecord = ScientSourceDetailResult;
type SourceDiagnostic =
  ScientSourcesOverviewResult["recordDiagnostics"][number]["diagnostics"][number];

const SOURCE_TYPE_LABELS: Readonly<Record<SourceRecord["type"], string>> = {
  article: "Article",
  preprint: "Preprint",
  book: "Book",
  "book-chapter": "Book chapter",
  "conference-paper": "Conference paper",
  thesis: "Thesis",
  report: "Report",
  dataset: "Dataset",
  web: "Web source",
  other: "Other source",
};

function creatorName(creator: SourceRecord["creators"][number]): string {
  if (creator.literalName) return creator.literalName;
  return [creator.givenName, creator.familyName].filter(Boolean).join(" ") || "Unknown creator";
}

function creatorsLabel(record: SourceRecord): string {
  if (record.creators.length === 0) return "Unknown creator";
  return record.creators.map(creatorName).join(", ");
}

function publicationLocation(record: SourceRecord): string | null {
  const volumeIssue = record.volume
    ? `${record.volume}${record.issue ? `(${record.issue})` : ""}`
    : record.issue
      ? `Issue ${record.issue}`
      : null;
  const parts = [record.containerTitle, volumeIssue, record.pages ? `pp. ${record.pages}` : null];
  const result = parts.filter(Boolean).join(" · ");
  return result || null;
}

function publicationContainerLabel(type: SourceRecord["type"]): string {
  if (type === "article") return "Journal";
  if (type === "book-chapter") return "Book";
  if (type === "conference-paper") return "Proceedings";
  if (type === "preprint") return "Repository";
  return "Publication";
}

function sourceTypeLabel(record: SourceRecord): string {
  return record.type === "other" && record.customType?.trim()
    ? record.customType.trim()
    : SOURCE_TYPE_LABELS[record.type];
}

function languageDisplayName(value: string): string {
  try {
    return new Intl.DisplayNames(undefined, { type: "language" }).of(value) ?? value;
  } catch {
    return value;
  }
}

export function safeSourceExternalUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.href : null;
  } catch {
    return null;
  }
}

function doiUrl(value: string): string {
  const doi = value
    .trim()
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//iu, "")
    .replace(/^doi:\s*/iu, "");
  const path = doi.split("/").map(encodeURIComponent).join("/");
  return `https://doi.org/${path}`;
}

function importedLabel(record: SourceRecord): string {
  const fromZotero = record.externalReferences.some((reference) => reference.system === "zotero");
  const date = new Date(record.importedAt);
  const formattedDate = Number.isNaN(date.getTime())
    ? null
    : new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(date);
  const sourceLabel =
    record.origin?.actor === "agent"
      ? "Added by agent"
      : fromZotero
        ? "Imported from Zotero"
        : "Added to Scient";
  const reviewLabel = record.origin?.review === "pending" ? " · Pending review" : "";
  return `${sourceLabel}${formattedDate ? ` · ${formattedDate}` : ""}${reviewLabel}`;
}

function openExternal(url: string): void {
  void readLocalApi()?.shell.openExternal(url);
}

function DoiRow(props: { readonly value: string }) {
  const url = doiUrl(props.value);
  const { copyToClipboard, isCopied } = useCopyToClipboard({ target: "DOI link" });
  const showActions = (event: ReactMouseEvent<HTMLElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const api = readLocalApi();
    if (!api) return;
    void api.contextMenu
      .show(
        [
          { id: "view", label: "View on doi.org", icon: "external-link" },
          { id: "copy-doi", label: "Copy DOI", icon: "copy" },
          { id: "copy-link", label: "Copy DOI link", icon: "copy" },
        ] as const,
        { x: event.clientX, y: event.clientY },
      )
      .then((action) => {
        if (action === "view") openExternal(url);
        else if (action === "copy-doi") copyToClipboard(props.value);
        else if (action === "copy-link") copyToClipboard(url);
      });
  };

  return (
    <div className="group/doi flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
      <div
        className="shrink-0 cursor-pointer text-muted-foreground"
        onDoubleClick={showActions}
        onContextMenu={showActions}
      >
        DOI
      </div>
      <div className="flex items-center gap-0.5">
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label="View DOI on doi.org"
                onClick={() => openExternal(url)}
              >
                <ExternalLink />
              </Button>
            }
          />
          <TooltipPopup side="top">View on doi.org</TooltipPopup>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label={isCopied ? "DOI link copied" : "Copy DOI link"}
                onClick={() => copyToClipboard(url)}
              >
                {isCopied ? <Check /> : <Copy />}
              </Button>
            }
          />
          <TooltipPopup side="top">{isCopied ? "Copied" : "Copy DOI link"}</TooltipPopup>
        </Tooltip>
      </div>
    </div>
  );
}

function SourceUrlRow(props: { readonly url: string }) {
  const { copyToClipboard, isCopied } = useCopyToClipboard({ target: "source link" });
  const showActions = (event: ReactMouseEvent<HTMLElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const api = readLocalApi();
    if (!api) return;
    void api.contextMenu
      .show(
        [
          { id: "view", label: "Open source link", icon: "external-link" },
          { id: "copy", label: "Copy source link", icon: "copy" },
        ] as const,
        { x: event.clientX, y: event.clientY },
      )
      .then((action) => {
        if (action === "view") openExternal(props.url);
        else if (action === "copy") copyToClipboard(props.url);
      });
  };

  return (
    <div className="group/source-link flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
      <div className="shrink-0 text-muted-foreground">Link</div>
      <div
        className="min-w-0 cursor-pointer break-all"
        onDoubleClick={showActions}
        onContextMenu={showActions}
      >
        {props.url}
      </div>
      <div className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover/source-link:opacity-100 group-focus-within/source-link:opacity-100 pointer-coarse:opacity-100">
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label="Open source link"
                onClick={() => openExternal(props.url)}
              >
                <ExternalLink />
              </Button>
            }
          />
          <TooltipPopup side="top">Open source link</TooltipPopup>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label={isCopied ? "Source link copied" : "Copy source link"}
                onClick={() => copyToClipboard(props.url)}
              >
                {isCopied ? <Check /> : <Copy />}
              </Button>
            }
          />
          <TooltipPopup side="top">{isCopied ? "Copied" : "Copy source link"}</TooltipPopup>
        </Tooltip>
      </div>
    </div>
  );
}

function DetailRow(props: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-2 text-sm">
      <dt className="text-muted-foreground">{props.label}:</dt>
      <dd className="min-w-0 break-words">{props.children}</dd>
    </div>
  );
}

function DetailsSection(props: { readonly title: string; readonly children: ReactNode }) {
  return (
    <section className="space-y-2">
      <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {props.title}
      </h3>
      {props.children}
    </section>
  );
}

function keyedValues<T>(values: ReadonlyArray<T>, identity: (value: T) => string) {
  const occurrences = new Map<string, number>();
  return values.map((value) => {
    const base = identity(value);
    const occurrence = occurrences.get(base) ?? 0;
    occurrences.set(base, occurrence + 1);
    return { key: `${base}:${occurrence}`, value };
  });
}

function AbstractPreview(props: {
  readonly text: string;
  readonly sections?: SourceRecord["abstractSections"];
}) {
  const contentRef = useRef<HTMLDivElement>(null);
  const [mode, setMode] = useState<"compact" | "more" | "full">("compact");
  const [canExpand, setCanExpand] = useState(false);

  useEffect(() => {
    setMode("compact");
    setCanExpand(false);
  }, [props.text]);

  useEffect(() => {
    const node = contentRef.current;
    if (!node || mode !== "compact") return;
    const measure = () => setCanExpand(node.scrollHeight > node.clientHeight + 1);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [mode, props.sections, props.text]);

  const normalizedSections = props.sections?.length
    ? props.sections
    : [{ title: null, paragraphs: props.text.split(/\n{2,}/u) }];
  const [firstSection, ...remainingSections] = normalizedSections;
  const sections =
    firstSection?.title?.trim().toLowerCase() === "abstract"
      ? firstSection.paragraphs.length > 0
        ? [{ title: null, paragraphs: firstSection.paragraphs }, ...remainingSections]
        : remainingSections
      : normalizedSections;

  const firstVisibleSection = sections[0]!;
  const secondVisibleSection = sections[1];
  const unstructuredSecondParagraph =
    sections.length === 1 && !firstVisibleSection?.title
      ? firstVisibleSection.paragraphs[1]
      : undefined;
  const hasIntermediatePreview =
    secondVisibleSection !== undefined || unstructuredSecondParagraph !== undefined;
  const intermediateSections = secondVisibleSection
    ? [
        firstVisibleSection,
        { ...secondVisibleSection, paragraphs: secondVisibleSection.paragraphs.slice(0, 1) },
      ]
    : unstructuredSecondParagraph
      ? [
          { ...firstVisibleSection, paragraphs: firstVisibleSection.paragraphs.slice(0, 1) },
          { title: null, paragraphs: [unstructuredSecondParagraph] },
        ]
      : sections;
  const visibleSections = mode === "more" ? intermediateSections : sections;

  return (
    <div className="min-w-0">
      <div
        ref={contentRef}
        className={`break-words text-sm ${mode === "compact" ? "max-h-24 overflow-hidden" : ""}`}
        style={
          mode === "compact"
            ? {
                WebkitMaskImage:
                  "linear-gradient(to bottom, black 0%, black 42%, rgb(0 0 0 / 58%) 72%, transparent 100%)",
                maskImage:
                  "linear-gradient(to bottom, black 0%, black 42%, rgb(0 0 0 / 58%) 72%, transparent 100%)",
              }
            : undefined
        }
      >
        {keyedValues(
          visibleSections,
          (section) => `${section.title ?? "abstract"}\u241e${section.paragraphs.join("\u241e")}`,
        ).map(({ key, value: section }, sectionIndex) => (
          <section key={key} className={sectionIndex === 0 ? "" : "mt-2.5"}>
            {section.title ? (
              <h4 className="font-semibold leading-5 text-foreground">{section.title}</h4>
            ) : null}
            <div
              className={`${section.title ? "mt-0.5 space-y-1.5" : "space-y-1.5"} ${
                mode === "more" && hasIntermediatePreview && sectionIndex === 1
                  ? "max-h-12 overflow-hidden"
                  : ""
              }`}
              style={
                mode === "more" && hasIntermediatePreview && sectionIndex === 1
                  ? {
                      WebkitMaskImage:
                        "linear-gradient(to bottom, black 0%, rgb(0 0 0 / 62%) 52%, transparent 100%)",
                      maskImage:
                        "linear-gradient(to bottom, black 0%, rgb(0 0 0 / 62%) 52%, transparent 100%)",
                    }
                  : undefined
              }
            >
              {keyedValues(section.paragraphs, (paragraph) => paragraph).map(
                ({ key: paragraphKey, value: paragraph }) => (
                  <p key={paragraphKey} className="whitespace-pre-wrap leading-6">
                    {paragraph}
                  </p>
                ),
              )}
            </div>
          </section>
        ))}
      </div>
      {canExpand ? (
        <div className="-ml-1 mt-1 flex items-center gap-1">
          {mode !== "compact" ? (
            <Button
              type="button"
              size="xs"
              variant="ghost"
              aria-expanded
              onClick={() => setMode("compact")}
              className="h-6 cursor-pointer rounded-md px-1.5 text-xs text-muted-foreground hover:bg-muted/55 hover:text-foreground"
            >
              Show less
            </Button>
          ) : null}
          {mode !== "full" ? (
            <Button
              type="button"
              size="xs"
              variant="ghost"
              aria-expanded={mode !== "compact"}
              onClick={() =>
                setMode(mode === "compact" && hasIntermediatePreview ? "more" : "full")
              }
              className="h-6 cursor-pointer rounded-md px-1.5 text-xs text-muted-foreground hover:bg-muted/55 hover:text-foreground"
            >
              {mode === "compact" ? "Show more" : "Show full abstract"}
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function SourceTags(props: { readonly tags: ReadonlyArray<string> }) {
  const rowRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const identity = props.tags.join("\u241e");

  useEffect(() => {
    setExpanded(false);
  }, [identity]);

  useEffect(() => {
    if (expanded) return;
    const row = rowRef.current;
    if (!row) return;
    const measure = () => setOverflows(row.scrollHeight > row.clientHeight + 1);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(row);
    return () => observer.disconnect();
  }, [expanded, identity]);

  return (
    <div className="min-w-0">
      <div
        ref={rowRef}
        className={
          expanded
            ? "flex min-w-0 w-full flex-wrap gap-1.5"
            : "flex h-6 min-w-0 w-full flex-wrap gap-1.5 overflow-hidden"
        }
      >
        {props.tags.map((tag) => (
          <Badge key={tag} variant="outline" className="shrink-0 whitespace-nowrap">
            {tag}
          </Badge>
        ))}
      </div>
      {expanded || overflows ? (
        <Button
          type="button"
          size="xs"
          variant="ghost"
          className="mt-1 h-6 cursor-pointer rounded-md px-1.5 text-xs text-muted-foreground hover:bg-muted/55 hover:text-foreground"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? "Show less" : "Show more"}
        </Button>
      ) : null}
    </div>
  );
}

function MetadataRefreshConfirmation(props: {
  readonly anchorPoint: SourceRemovalAnchorPoint;
  readonly onOpenChange: (open: boolean) => void;
  readonly onRefresh: () => Promise<void>;
}) {
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const anchor = useMemo(
    () => ({
      getBoundingClientRect: () => ({
        x: props.anchorPoint.x,
        y: props.anchorPoint.y,
        top: props.anchorPoint.y,
        right: props.anchorPoint.x,
        bottom: props.anchorPoint.y,
        left: props.anchorPoint.x,
        width: 0,
        height: 0,
      }),
    }),
    [props.anchorPoint.x, props.anchorPoint.y],
  );

  return (
    <Popover
      open
      modal
      onOpenChange={(open) => {
        if (!refreshing) props.onOpenChange(open);
      }}
    >
      <PopoverPopup
        anchor={anchor}
        side="right"
        align="start"
        sideOffset={8}
        className="w-[18rem] max-w-[calc(100vw-1rem)]"
        viewportClassName="p-0"
        role="alertdialog"
      >
        <div className="p-3">
          <div className="flex items-center gap-2">
            <AlertTriangle className="size-4 shrink-0 text-amber-600" />
            <PopoverTitle className="text-sm">Refresh metadata?</PopoverTitle>
          </div>
          <PopoverDescription className="mt-1.5 text-xs leading-5">
            Scient will replace matching metadata fields using this source’s PDF and identifiers.
            Manual edits to those fields may be lost. The PDF stays unchanged.
          </PopoverDescription>
          {error ? (
            <p className="mt-2 text-xs text-destructive" role="alert">
              {error}
            </p>
          ) : null}
          <div className="mt-3 flex justify-end gap-1.5">
            <Button
              size="xs"
              variant="ghost"
              disabled={refreshing}
              onClick={() => props.onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button
              size="xs"
              disabled={refreshing}
              onClick={() => {
                setRefreshing(true);
                setError(null);
                void props
                  .onRefresh()
                  .then(() => props.onOpenChange(false))
                  .catch((cause: unknown) => {
                    setError(
                      cause instanceof Error
                        ? cause.message
                        : "Metadata could not be refreshed. Please try again.",
                    );
                    setRefreshing(false);
                  });
              }}
            >
              {refreshing ? <LoaderCircle className="animate-spin" /> : <RefreshCw />}
              {refreshing ? "Refreshing…" : "Refresh"}
            </Button>
          </div>
        </div>
      </PopoverPopup>
    </Popover>
  );
}

export function SourceDetails(props: {
  readonly record: SourceRecord;
  readonly diagnostics: ReadonlyArray<SourceDiagnostic>;
  readonly onBack: () => void;
  readonly onEdit: () => void;
  readonly onSaveNote: (
    note: string | null,
    expectedRevision: number,
  ) => Promise<ScientSourceNoteUpdateResult>;
  readonly onRefreshMetadata: () => Promise<void>;
  readonly onApproveReview?: () => Promise<void>;
  readonly onRemove: () => Promise<void>;
  readonly onOpenPdf: (input: {
    readonly sourceId: string;
    readonly attachmentId: string;
    readonly fileName: string;
  }) => void;
}) {
  const [removeAnchorPoint, setRemoveAnchorPoint] = useState<SourceRemovalAnchorPoint | null>(null);
  const [refreshAnchorPoint, setRefreshAnchorPoint] = useState<SourceRemovalAnchorPoint | null>(
    null,
  );
  const [approvingReview, setApprovingReview] = useState(false);
  const record = props.record;
  const sourceNote = useSourceNoteControls({ record, onSave: props.onSaveNote });
  const publication = publicationLocation(record);
  const hasPublicationDetails = Boolean(
    record.issuedRaw || record.issuedYear || publication || record.publisher || record.language,
  );
  const externalUrl = safeSourceExternalUrl(record.url);
  const pdf = record.attachments[0] ?? null;
  const identifiers = [
    ...new Map(
      record.identifiers.map((identifier) => [
        `${identifier.scheme.toLowerCase()}:${identifier.value}`,
        identifier,
      ]),
    ).values(),
  ];
  const tags = [...new Set(record.tags)];
  const hasDoi = identifiers.some((identifier) => identifier.scheme.toLowerCase() === "doi");

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-3 border-b border-border p-3">
        <Button variant="ghost" size="xs" onClick={props.onBack} aria-label="Back to Sources">
          <ChevronLeft />
          Sources
        </Button>
        <div className="min-w-0 flex-1" />
        {sourceNote.button}
        {record.origin?.review === "pending" && props.onApproveReview ? (
          <>
            <Button
              size="xs"
              variant="outline"
              disabled={approvingReview}
              onClick={() => {
                setApprovingReview(true);
                void props
                  .onApproveReview?.()
                  .catch((cause: unknown) => {
                    toastManager.add({
                      type: "error",
                      title: "Review could not be approved",
                      description: scientSourcesErrorMessage(cause, import.meta.env.DEV),
                    });
                  })
                  .finally(() => setApprovingReview(false));
              }}
            >
              {approvingReview ? <LoaderCircle className="animate-spin" /> : null}
              {approvingReview ? "Approving…" : "Approve review"}
            </Button>
            <Button
              size="xs"
              variant="ghost"
              onClick={(event) => {
                const target = event.currentTarget.getBoundingClientRect();
                setRemoveAnchorPoint({
                  x: event.clientX || target.right,
                  y: event.clientY || target.top + target.height / 2,
                });
              }}
            >
              Reject
            </Button>
          </>
        ) : null}
        <Button size="xs" variant="ghost" onClick={props.onEdit}>
          <Pencil />
          Edit
        </Button>
        {pdf ? (
          <Button
            size="xs"
            variant="ghost"
            onClick={() =>
              props.onOpenPdf({
                sourceId: record.sourceId,
                attachmentId: pdf.attachmentId,
                fileName: pdf.fileName,
              })
            }
          >
            <FileText />
            Open PDF
          </Button>
        ) : null}
        <Menu>
          <MenuTrigger
            render={
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label="More source actions"
                title="More source actions"
              >
                <MoreHorizontal />
              </Button>
            }
          />
          <MenuPopup align="end" side="bottom" className="min-w-44">
            <MenuItem
              onClick={(event) => {
                const target = event.currentTarget.getBoundingClientRect();
                setRefreshAnchorPoint({
                  x: event.clientX || target.right,
                  y: event.clientY || target.top + target.height / 2,
                });
              }}
            >
              <RefreshCw />
              Refresh metadata
            </MenuItem>
            <MenuSeparator />
            <MenuItem
              variant="destructive"
              onClick={(event) => {
                const target = event.currentTarget.getBoundingClientRect();
                setRemoveAnchorPoint({
                  x: event.clientX || target.right,
                  y: event.clientY || target.top + target.height / 2,
                });
              }}
            >
              {record.origin?.review === "pending" ? "Reject agent source" : "Remove from Sources"}
            </MenuItem>
          </MenuPopup>
        </Menu>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <article className="space-y-6 p-4">
          <header className="space-y-2">
            <Badge variant="secondary">{sourceTypeLabel(record)}</Badge>
            <h2 className="text-lg font-semibold leading-snug">
              {record.title ?? "Untitled source"}
            </h2>
            <p className="text-sm text-muted-foreground">{creatorsLabel(record)}</p>
          </header>

          {props.diagnostics.length > 0 ? (
            <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-sm">
              <AlertCircle className="mt-0.5 size-4 shrink-0 text-amber-600" />
              <div>
                <div className="font-medium">Metadata needs review</div>
                <div className="mt-0.5 text-xs text-muted-foreground">
                  {props.diagnostics.map((diagnostic) => diagnostic.message).join(" ")}
                </div>
              </div>
            </div>
          ) : null}

          {record.abstract ? (
            <DetailsSection title="Abstract">
              <AbstractPreview text={record.abstract} sections={record.abstractSections} />
            </DetailsSection>
          ) : null}

          {hasPublicationDetails ? (
            <section className="space-y-2">
              <h3 className="text-sm font-medium text-foreground">Publication details</h3>
              <dl className="space-y-2">
                {publication ? (
                  <div className="space-y-0.5 text-sm">
                    <dt className="text-muted-foreground">
                      {publicationContainerLabel(record.type)}:
                    </dt>
                    <dd className="min-w-0 break-words">{publication}</dd>
                  </div>
                ) : null}
                {record.publisher ? (
                  <div className="flex flex-wrap items-baseline gap-x-2 text-sm">
                    <dt className="text-muted-foreground">Publisher</dt>
                    <dd className="min-w-0 break-words">{record.publisher}</dd>
                  </div>
                ) : null}
                <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1 text-sm">
                  {record.issuedRaw || record.issuedYear ? (
                    <div className="flex items-baseline gap-2">
                      <dt className="text-muted-foreground">Date:</dt>
                      <dd>{record.issuedRaw ?? record.issuedYear}</dd>
                    </div>
                  ) : null}
                  {record.language ? (
                    <div className="flex items-baseline gap-2">
                      <dt className="text-muted-foreground">Language:</dt>
                      <dd>{languageDisplayName(record.language)}</dd>
                    </div>
                  ) : null}
                </div>
              </dl>
            </section>
          ) : null}

          {identifiers.length > 0 || (externalUrl && !hasDoi) ? (
            <DetailsSection title="Identifiers and links">
              <div className="space-y-2">
                {identifiers.map((identifier) => {
                  return identifier.scheme.toLowerCase() === "doi" ? (
                    <DoiRow
                      key={`${identifier.scheme}:${identifier.value}`}
                      value={identifier.value}
                    />
                  ) : (
                    <DetailRow
                      key={`${identifier.scheme}:${identifier.value}`}
                      label={identifier.scheme.toUpperCase()}
                    >
                      {identifier.value}
                    </DetailRow>
                  );
                })}
                {externalUrl && !hasDoi ? <SourceUrlRow url={externalUrl} /> : null}
              </div>
            </DetailsSection>
          ) : null}

          {tags.length > 0 ? (
            <DetailsSection title="Tags">
              <SourceTags tags={tags} />
            </DetailsSection>
          ) : null}

          <SourceReference record={record} />

          {sourceNote.section}

          <p className="border-t border-border pt-3 text-xs text-muted-foreground">
            {importedLabel(record)}
          </p>
        </article>
      </ScrollArea>

      {refreshAnchorPoint ? (
        <MetadataRefreshConfirmation
          anchorPoint={refreshAnchorPoint}
          onOpenChange={(open) => {
            if (!open) setRefreshAnchorPoint(null);
          }}
          onRefresh={props.onRefreshMetadata}
        />
      ) : null}

      {removeAnchorPoint ? (
        <SourceRemovalConfirmation
          key={record.sourceId}
          open
          record={record}
          anchorPoint={removeAnchorPoint}
          onOpenChange={(open) => {
            if (!open) setRemoveAnchorPoint(null);
          }}
          onRemove={props.onRemove}
        />
      ) : null}
    </div>
  );
}
