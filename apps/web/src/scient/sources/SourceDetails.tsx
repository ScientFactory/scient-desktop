import type {
  ScientSourceDetailResult,
  ScientSourceNoteUpdateResult,
  ScientSourcesOverviewResult,
} from "@t3tools/contracts";
import { selectScientSourceMaterial } from "@scientfactory/scient-sources/material-selection";
import {
  AlertCircle,
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronLeft,
  Copy,
  Download,
  ExternalLink,
  FileText,
  FolderMinus,
  FolderPlus,
  History,
  LoaderCircle,
  MoreHorizontal,
  Pencil,
  RefreshCw,
  Star,
  Trash2,
  Upload,
} from "lucide-react";
import {
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";

import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "../../components/ui/menu";
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
import { observeResize } from "../../lib/observeResize";
import { ScientTooltip } from "../presentation/ScientTooltip";
import { scientSourcesErrorMessage } from "./errorMessage";
import {
  LIBRARY_LABELS,
  libraryCopyLabel,
  libraryCopyProblemLabel,
  type ReadingStateChange,
} from "./libraryLabels";
import { agentVerificationLabel, fileNameTitleLabel } from "./sourceLabels";
import { pdfVersionLabel } from "./sourcePdfVersion";
import { SourceEditorialStatus } from "./SourceEditorialStatus";
import { verificationProblemLabel } from "./sourceLifecycleLabels";
import { SourceReference } from "./SourceReference";
import type { CitationStyleProject } from "./useProjectCitationStyle";
import { useSourceNoteControls, type SourceNoteSaveContext } from "./SourceNote";
import type { SourceAnchorPoint } from "./sourceAnchor";

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
  const editedLabel = record.updatedBy === "agent" ? " · Edited by agent" : "";
  return `${sourceLabel}${formattedDate ? ` · ${formattedDate}` : ""}${agentVerificationLabel(record)}${verificationProblemLabel(record.verification)}${editedLabel}${pdfVersionLabel(record.attachments)}`;
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

  const [previousText, setPreviousText] = useState({ text: props.text });
  if (previousText.text !== props.text) {
    setPreviousText({ text: props.text });
    setMode("compact");
    setCanExpand(false);
  }

  const measurement = { mode, text: props.text, sections: props.sections };
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- measures the content DOM node via ResizeObserver to detect expandability
  useEffect(() => {
    const node = contentRef.current;
    if (!node || measurement.mode !== "compact") return;
    const measure = () => setCanExpand(node.scrollHeight > node.clientHeight + 1);
    measure();
    return observeResize(node, measure);
  }, [measurement]);

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
              size="compact"
              variant="ghost-muted"
              aria-expanded
              onClick={() => setMode("compact")}
            >
              Show less
            </Button>
          ) : null}
          {mode !== "full" ? (
            <Button
              type="button"
              size="compact"
              variant="ghost-muted"
              aria-expanded={mode !== "compact"}
              onClick={() =>
                setMode(mode === "compact" && hasIntermediatePreview ? "more" : "full")
              }
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

  const [previousTagIdentity, setPreviousTagIdentity] = useState({ identity: identity });
  if (previousTagIdentity.identity !== identity) {
    setPreviousTagIdentity({ identity: identity });
    setExpanded(false);
  }

  const tagMeasurement = { expanded, identity };
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- measures the tag row DOM node via ResizeObserver to detect overflow
  useEffect(() => {
    if (tagMeasurement.expanded) return;
    const row = rowRef.current;
    if (!row) return;
    const measure = () => setOverflows(row.scrollHeight > row.clientHeight + 1);
    measure();
    return observeResize(row, measure);
  }, [tagMeasurement]);

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
          size="compact"
          variant="ghost-muted"
          className="mt-1"
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
  readonly anchorPoint: SourceAnchorPoint;
  readonly onOpenChange: (open: boolean) => void;
  readonly onRefresh: () => Promise<void>;
}) {
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const anchor = {
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
  };

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
        padding="none"
        role="alertdialog"
      >
        <div className="p-3">
          <div className="flex items-center gap-2">
            <AlertTriangle className="size-4 shrink-0 text-amber-600" />
            <PopoverTitle>Refresh metadata?</PopoverTitle>
          </div>
          <PopoverDescription className="mt-1.5" size="compact">
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

/** What a personal Library adds to the details; a project server never passes it. */
export interface SourceDetailsLibrary {
  readonly onSavePersonalNote: (
    note: string | null,
    expectedRevision: number,
  ) => Promise<{ readonly outcome: string; readonly record: SourceRecord }>;
  readonly canSavePersonalNote: boolean;
  /** Absent when this connection may not change reading state: the markers stay, the controls go. */
  readonly onSetReadingState?: (change: ReadingStateChange) => Promise<void>;
  readonly onAddToProject?: () => Promise<void>;
  readonly onRemoveFromProject?: () => Promise<unknown>;
  /** A source kept from this project's details although the Library has similar copies. */
  readonly onLinkToCopy?: (librarySourceId: string) => Promise<void>;
  readonly onKeepSeparate?: (separate: boolean) => Promise<void>;
}

function LibraryCopySection(props: {
  readonly match: NonNullable<SourceRecord["libraryMatch"]>;
  readonly library: SourceDetailsLibrary | undefined;
}) {
  const [pending, setPending] = useState(false);
  const { match, library } = props;
  const act = (run: (() => Promise<void>) | undefined) =>
    run
      ? () => {
          setPending(true);
          void run().finally(() => setPending(false));
        }
      : undefined;
  const keep = library?.onKeepSeparate;
  const toggleSeparate = act(keep ? () => keep(!match.keptSeparate) : undefined);
  return (
    <DetailsSection title={LIBRARY_LABELS.libraryCopy}>
      <p className="text-xs text-muted-foreground">
        {match.keptSeparate ? LIBRARY_LABELS.keptSeparate : libraryCopyLabel(match)}
      </p>
      <ul className="space-y-2">
        {match.candidates.map((candidate) => {
          const link = act(
            library?.onLinkToCopy ? () => library.onLinkToCopy!(candidate.sourceId) : undefined,
          );
          return (
            <li key={candidate.sourceId} className="flex items-start gap-2 text-xs">
              <div className="min-w-0 flex-1">
                <p className="break-words text-sm">
                  {candidate.title ?? "Untitled"}
                  {candidate.issuedYear ? ` (${candidate.issuedYear})` : ""}
                </p>
                {candidate.containerTitle ? (
                  <p className="break-words text-muted-foreground">{candidate.containerTitle}</p>
                ) : null}
                <p className="text-muted-foreground">
                  {libraryCopyProblemLabel(candidate.problem)}
                </p>
              </div>
              {link ? (
                <Button size="xs" variant="ghost" disabled={pending} onClick={link}>
                  {LIBRARY_LABELS.linkToCopy}
                </Button>
              ) : null}
            </li>
          );
        })}
      </ul>
      {toggleSeparate ? (
        <Button size="xs" variant="ghost" disabled={pending} onClick={toggleSeparate}>
          {match.keptSeparate ? LIBRARY_LABELS.askAgain : LIBRARY_LABELS.keepSeparate}
        </Button>
      ) : null}
    </DetailsSection>
  );
}

function ReadingControls(props: {
  readonly record: SourceRecord;
  readonly onSetReadingState: SourceDetailsLibrary["onSetReadingState"];
}) {
  const [pending, setPending] = useState(false);
  const { readingStatus, starred } = props.record;
  if (readingStatus === undefined) return null;
  const onSet = props.onSetReadingState;
  if (!onSet) {
    return readingStatus === "unread" || starred ? (
      <p className="flex items-center gap-2 text-xs text-muted-foreground">
        {readingStatus === "unread" ? <span>{LIBRARY_LABELS.unread}</span> : null}
        {starred ? (
          <span className="inline-flex items-center gap-1">
            <Star className="size-3 fill-current" aria-hidden />
            {LIBRARY_LABELS.starred}
          </span>
        ) : null}
      </p>
    ) : null;
  }
  const set = (change: ReadingStateChange) => {
    setPending(true);
    void onSet(change).finally(() => setPending(false));
  };
  return (
    <div className="flex items-center gap-1">
      <Button
        size="xs"
        variant="ghost"
        disabled={pending}
        onClick={() => set({ readingStatus: readingStatus === "unread" ? "read" : "unread" })}
      >
        {readingStatus === "unread" ? LIBRARY_LABELS.markRead : LIBRARY_LABELS.markUnread}
      </Button>
      <ScientTooltip content={starred ? LIBRARY_LABELS.removeStar : LIBRARY_LABELS.star}>
        <Button
          size="icon-xs"
          variant="ghost"
          disabled={pending}
          aria-label={starred ? LIBRARY_LABELS.removeStar : LIBRARY_LABELS.star}
          aria-pressed={starred === true}
          onClick={() => set({ starred: !starred })}
        >
          <Star className={starred ? "fill-current" : undefined} />
        </Button>
      </ScientTooltip>
    </div>
  );
}

export function SourceDetails(props: {
  readonly record: SourceRecord;
  /** Present only on a personal Library: two notes, reading state and this project's sources. */
  readonly library?: SourceDetailsLibrary;
  /** The connection can read this Library but not change it. */
  readonly readOnly?: boolean;
  readonly diagnostics: ReadonlyArray<SourceDiagnostic>;
  /** Editable tags and collections; without it the tags are shown read-only. */
  readonly organize?: ReactNode;
  /** The project whose citation style the reference uses. */
  readonly citationProject?: CitationStyleProject;
  readonly onBack: () => void;
  readonly onEdit: () => void;
  readonly onSaveNote: (
    note: string | null,
    expectedRevision: number,
    context: SourceNoteSaveContext,
  ) => Promise<ScientSourceNoteUpdateResult>;
  readonly onRefreshMetadata: () => Promise<void>;
  readonly onRemove: () => Promise<void>;
  readonly onOpenHistory?: () => void;
  /** Without a group ID, the source goes to My Library. */
  readonly onSendToZotero?: (groupId: string | null) => void;
  /** Zotero groups the key in Accounts can write to; with any, Send to Zotero asks where. */
  readonly zoteroWritableGroups?: ReadonlyArray<{
    readonly groupId: string;
    readonly name: string;
  }>;
  readonly onSourceActionsOpen?: () => void;
  readonly onGetPdf?: () => Promise<void>;
  readonly onOpenPdf: (input: {
    readonly sourceId: string;
    readonly attachmentId: string;
    readonly fileName: string;
  }) => void;
  /** The Source's highlights and notes, shown after its reference. */
  readonly annotations?: ReactNode;
}) {
  const [refreshAnchorPoint, setRefreshAnchorPoint] = useState<SourceAnchorPoint | null>(null);
  const [gettingPdf, setGettingPdf] = useState(false);
  const record = props.record;
  const readOnly = props.readOnly ?? false;
  const library = props.library;
  // A library server's note is this project's note on the pin, so a source not pinned here has none.
  const inProject = record.pinned !== false;
  const sourceNote = useSourceNoteControls({
    record,
    readOnly: readOnly || !inProject,
    onSave: props.onSaveNote,
    ...(library ? { heading: LIBRARY_LABELS.projectNote, history: record.projectNoteHistory } : {}),
  });
  const personalNote = useSourceNoteControls({
    record,
    field: "personalNote",
    readOnly: readOnly || !library?.canSavePersonalNote,
    heading: LIBRARY_LABELS.myNote,
    help: LIBRARY_LABELS.myNoteHelp,
    onSave: library?.onSavePersonalNote ?? props.onSaveNote,
  });
  // A session without the Library write grant never gets the key, so it never sees "My note".
  const showsPersonalNote = library !== undefined && "personalNote" in record;
  const publication = publicationLocation(record);
  const fileNameTitle = fileNameTitleLabel(record);
  const hasPublicationDetails = Boolean(
    record.issuedRaw || record.issuedYear || publication || record.publisher || record.language,
  );
  const externalUrl = safeSourceExternalUrl(record.url);
  const pdfSelection = selectScientSourceMaterial({ materials: record.attachments });
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
  // A source this project cites under two keys, after merging two sources it used.
  const otherKeys = record.alsoCitedAs ?? [];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-border p-3">
        <Button variant="ghost" size="xs" onClick={props.onBack} aria-label="Back to Library">
          <ChevronLeft />
          Library
        </Button>
        <div className="min-w-0 flex-1" />
        {library && !inProject ? (
          library.onAddToProject ? (
            <Button size="xs" variant="ghost" onClick={() => void library.onAddToProject?.()}>
              <FolderPlus />
              {LIBRARY_LABELS.addToProject}
            </Button>
          ) : null
        ) : (
          sourceNote.button
        )}
        <Button size="xs" variant="ghost" disabled={readOnly} onClick={props.onEdit}>
          <Pencil />
          Edit
        </Button>
        {pdfSelection._tag === "Selected" ? (
          <Button
            size="xs"
            variant="ghost"
            onClick={() =>
              props.onOpenPdf({
                sourceId: record.sourceId,
                attachmentId: pdfSelection.material.attachmentId,
                fileName: pdfSelection.material.fileName,
              })
            }
          >
            <FileText />
            Open PDF
          </Button>
        ) : pdfSelection._tag === "SeveralMaterials" ? (
          <Menu>
            <MenuTrigger
              render={
                <Button size="xs" variant="ghost" aria-label="Choose a PDF to open">
                  <FileText />
                  Open PDF
                  <ChevronDown />
                </Button>
              }
            />
            <MenuPopup align="end" side="bottom" className="max-w-80 min-w-52">
              {pdfSelection.materials.map((material) => (
                <MenuItem
                  key={material.attachmentId}
                  onClick={() =>
                    props.onOpenPdf({
                      sourceId: record.sourceId,
                      attachmentId: material.attachmentId,
                      fileName: material.fileName,
                    })
                  }
                >
                  <FileText />
                  <span className="truncate">{material.fileName}</span>
                </MenuItem>
              ))}
            </MenuPopup>
          </Menu>
        ) : props.onGetPdf && (hasDoi || record.url) ? (
          <Button
            size="xs"
            variant="ghost"
            disabled={gettingPdf || readOnly}
            onClick={() => {
              setGettingPdf(true);
              void Promise.resolve(props.onGetPdf?.()).finally(() => setGettingPdf(false));
            }}
          >
            {gettingPdf ? <LoaderCircle className="animate-spin" /> : <Download />}
            Get PDF
          </Button>
        ) : null}
        <Menu
          onOpenChange={(open) => {
            if (open) props.onSourceActionsOpen?.();
          }}
        >
          <ScientTooltip content="More source actions">
            <MenuTrigger
              render={
                <Button size="icon-xs" variant="ghost" aria-label="More source actions">
                  <MoreHorizontal />
                </Button>
              }
            />
          </ScientTooltip>
          <MenuPopup align="end" side="bottom" className="min-w-44">
            <MenuItem
              disabled={readOnly}
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
            {props.onOpenHistory ? (
              <MenuItem onClick={props.onOpenHistory}>
                <History />
                History
              </MenuItem>
            ) : null}
            {props.onSendToZotero && (props.zoteroWritableGroups ?? []).length > 0 ? (
              <MenuSub>
                <MenuSubTrigger disabled={readOnly}>
                  <Upload />
                  Send to Zotero
                </MenuSubTrigger>
                <MenuSubPopup className="max-h-80 overflow-y-auto">
                  <MenuItem onClick={() => props.onSendToZotero?.(null)}>My Library</MenuItem>
                  {(props.zoteroWritableGroups ?? []).map((group) => (
                    <MenuItem
                      key={group.groupId}
                      title={group.name}
                      onClick={() => props.onSendToZotero?.(group.groupId)}
                    >
                      <span className="min-w-0 truncate">{group.name}</span>
                    </MenuItem>
                  ))}
                </MenuSubPopup>
              </MenuSub>
            ) : props.onSendToZotero ? (
              <MenuItem disabled={readOnly} onClick={() => props.onSendToZotero?.(null)}>
                <Upload />
                Send to Zotero
              </MenuItem>
            ) : null}
            <MenuSeparator />
            {library?.onRemoveFromProject && inProject ? (
              <MenuItem onClick={() => void library.onRemoveFromProject?.()}>
                <FolderMinus />
                {LIBRARY_LABELS.removeFromProject}
              </MenuItem>
            ) : null}
            {/* A pin's snapshot is not in this Library, so there is nothing to move to Trash. */}
            {library && record.fromSnapshot ? null : (
              <MenuItem
                variant="destructive"
                disabled={readOnly}
                onClick={() => {
                  void props.onRemove().catch((cause: unknown) => {
                    toastManager.add({
                      type: "error",
                      title: "Source could not be moved to Trash",
                      description: scientSourcesErrorMessage(cause, import.meta.env.DEV),
                    });
                  });
                }}
              >
                <Trash2 />
                Move to Trash
              </MenuItem>
            )}
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
            {fileNameTitle ? (
              <p className="text-xs text-muted-foreground">{fileNameTitle}</p>
            ) : null}
            <SourceEditorialStatus status={record.editorialStatus} />
            {library ? (
              <ReadingControls record={record} onSetReadingState={library.onSetReadingState} />
            ) : null}
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

          {identifiers.length > 0 || (externalUrl && !hasDoi) || otherKeys.length > 0 ? (
            <DetailsSection title="Identifiers and links">
              <div className="space-y-2">
                {otherKeys.length > 0 && record.citationKey ? (
                  <>
                    <DetailRow label={LIBRARY_LABELS.citedAs}>{record.citationKey}</DetailRow>
                    <DetailRow label={LIBRARY_LABELS.alsoCitedAs}>{otherKeys.join(", ")}</DetailRow>
                  </>
                ) : null}
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

          {props.organize ??
            (tags.length > 0 ? (
              <DetailsSection title="Tags">
                <SourceTags tags={tags} />
              </DetailsSection>
            ) : null)}

          {record.libraryMatch ? (
            <LibraryCopySection
              match={record.libraryMatch}
              library={readOnly ? undefined : library}
            />
          ) : null}

          <SourceReference
            record={record}
            {...(props.citationProject ? { project: props.citationProject } : {})}
          />

          {props.annotations}

          {showsPersonalNote ? (
            <div className="@container/source-notes">
              <div className="grid gap-6 @[32rem]/source-notes:grid-cols-2">
                {inProject ? sourceNote.section : null}
                {personalNote.section}
              </div>
            </div>
          ) : library && !inProject ? null : (
            sourceNote.section
          )}

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
    </div>
  );
}
