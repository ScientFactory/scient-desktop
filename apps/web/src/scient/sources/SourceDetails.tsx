import type { ScientSourcesOverviewResult } from "@t3tools/contracts";
import {
  AlertCircle,
  Check,
  ChevronLeft,
  Copy,
  ExternalLink,
  FileText,
  LoaderCircle,
  MoreHorizontal,
  Pencil,
  Trash2,
} from "lucide-react";
import { useState, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";

import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../../components/ui/alert-dialog";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../../components/ui/menu";
import { ScrollArea } from "../../components/ui/scroll-area";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../components/ui/tooltip";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { readLocalApi } from "../../localApi";
import { SourceReference } from "./SourceReference";

type SourceRecord = ScientSourcesOverviewResult["records"][number];
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
  return `${fromZotero ? "Imported from Zotero" : "Added to Scient"}${formattedDate ? ` · ${formattedDate}` : ""}`;
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

export function SourceDetails(props: {
  readonly record: SourceRecord;
  readonly diagnostics: ReadonlyArray<SourceDiagnostic>;
  readonly onBack: () => void;
  readonly onEdit: () => void;
  readonly onRemove: () => Promise<void>;
  readonly onOpenPdf: (input: { readonly attachmentId: string; readonly fileName: string }) => void;
}) {
  const [removeConfirmOpen, setRemoveConfirmOpen] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const record = props.record;
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
                disabled={removing}
              >
                <MoreHorizontal />
              </Button>
            }
          />
          <MenuPopup align="end" side="bottom" className="min-w-44">
            <MenuItem
              variant="destructive"
              onClick={() => {
                setRemoveError(null);
                setRemoveConfirmOpen(true);
              }}
            >
              <Trash2 />
              Remove from Sources
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
              <p className="whitespace-pre-wrap text-sm leading-relaxed">{record.abstract}</p>
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
              <div className="flex flex-wrap gap-1.5">
                {tags.map((tag) => (
                  <Badge key={tag} variant="outline">
                    {tag}
                  </Badge>
                ))}
              </div>
            </DetailsSection>
          ) : null}

          <SourceReference record={record} />

          <p className="border-t border-border pt-3 text-xs text-muted-foreground">
            {importedLabel(record)}
          </p>
        </article>
      </ScrollArea>

      <AlertDialog
        open={removeConfirmOpen}
        onOpenChange={(open) => {
          if (removing) return;
          setRemoveConfirmOpen(open);
          if (!open) setRemoveError(null);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove this source?</AlertDialogTitle>
            <AlertDialogDescription>
              “{record.title ?? "Untitled source"}” will be removed from this Scient project.
              {pdf
                ? " Its imported PDF will also be removed unless another source uses the same file."
                : ""}
              {record.externalReferences.some((reference) => reference.system === "zotero")
                ? " Your Zotero library will not be changed."
                : " The original source will not be changed."}
            </AlertDialogDescription>
            {removeError ? (
              <p className="text-sm text-destructive" role="alert">
                {removeError}
              </p>
            ) : null}
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" disabled={removing} />}>
              Cancel
            </AlertDialogClose>
            <Button
              variant="destructive"
              disabled={removing}
              onClick={() => {
                setRemoving(true);
                setRemoveError(null);
                void props
                  .onRemove()
                  .then(() => setRemoveConfirmOpen(false))
                  .catch((cause: unknown) => {
                    setRemoveError(
                      cause instanceof Error
                        ? cause.message
                        : "The source could not be removed. Please try again.",
                    );
                  })
                  .finally(() => setRemoving(false));
              }}
            >
              {removing ? <LoaderCircle className="animate-spin" /> : <Trash2 />}
              {removing ? "Removing…" : "Remove source"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </div>
  );
}
