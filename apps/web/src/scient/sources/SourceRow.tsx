import { msg, T, useGT, useMessages } from "gt-react";

import type { MessageResolver } from "~/i18n/messages";
import type { EnvironmentId, ScientSourcesOverviewResult } from "@t3tools/contracts";
import { selectScientSourceMaterial } from "@scientfactory/scient-sources/material-selection";
import { AlertCircle, FileText, MoreVertical, Star } from "lucide-react";
import { useState } from "react";

import { Button } from "../../components/ui/button";
import { Checkbox } from "../../components/ui/checkbox";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../components/ui/tooltip";
import { ScientTooltip } from "../presentation/ScientTooltip";
import { LIBRARY_LABELS } from "./libraryLabels";
import { SourceJournalIcon } from "./SourceJournalIcon";
import { sourceTrustLabel } from "./sourceLifecycleLabels";
import { sourceAddedLabel, sourcePinLabel } from "./sourceLabels";

type SourceRecord = ScientSourcesOverviewResult["records"][number];
type SourceDiagnostic =
  ScientSourcesOverviewResult["recordDiagnostics"][number]["diagnostics"][number];

/** What every row of the sources list shares: the panel's state and its handlers. */
export interface SourceRowContext {
  readonly environmentId: EnvironmentId;
  readonly root: string;
  readonly listed: NonNullable<ScientSourcesOverviewResult["scopes"]>["listed"] | undefined;
  readonly selection: ReadonlySet<string>;
  readonly recentlyAddedSourceIds: ReadonlySet<string>;
  readonly diagnosticsBySourceId: ReadonlyMap<string, ReadonlyArray<SourceDiagnostic>>;
  readonly onToggleSelected: (sourceId: string) => void;
  readonly onOpenDetails: (sourceId: string) => void;
  readonly onOpenPdf: (input: {
    readonly sourceId: string;
    readonly attachmentId: string;
    readonly fileName: string;
  }) => void;
  readonly onShowMenu: (
    record: SourceRecord,
    anchorPoint: { readonly x: number; readonly y: number },
  ) => void;
  /** Present only for a session that may change reading state. */
  readonly onToggleStar?: (record: SourceRecord) => Promise<void>;
}

export function MetadataReviewIndicator(props: {
  readonly diagnostics: ReadonlyArray<SourceDiagnostic>;
  readonly onOpen: () => void;
}) {
  const gt = useGT();
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            className="rounded-full text-amber-600 outline-none hover:text-amber-700 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring dark:text-amber-400 dark:hover:text-amber-300"
            aria-label={gt("Metadata needs review")}
            onClick={(event) => {
              event.stopPropagation();
              props.onOpen();
            }}
          >
            <AlertCircle className="size-4" />
          </button>
        }
      />
      <TooltipPopup side="top" align="end" className="max-w-72" variant="glass">
        <div className="space-y-1 px-3 py-2">
          <div className="font-medium">
            <T>Metadata needs review</T>
          </div>
          <div className="text-muted-foreground">
            {props.diagnostics.map((diagnostic) => diagnostic.message).join(" ")}
          </div>
          <div className="pt-1 text-muted-foreground">
            <T>Click to view source details.</T>
          </div>
        </div>
      </TooltipPopup>
    </Tooltip>
  );
}

/** A personal Library's star on a row: shown when set, offered on hover to a session that may change it. */
export function RowStar(props: {
  readonly title: string | null;
  readonly starred: boolean;
  readonly onToggle?: () => Promise<void>;
}) {
  const m = useMessages();
  const [pending, setPending] = useState(false);
  const onToggle = props.onToggle;
  if (!onToggle) {
    return (
      <span
        className={`flex size-7 shrink-0 items-center justify-center text-muted-foreground ${props.starred ? "" : "@max-[20rem]/row:hidden"}`}
      >
        {props.starred ? (
          <Star
            role="img"
            aria-label={m(LIBRARY_LABELS.starred)}
            className="size-3.5 fill-current"
          />
        ) : null}
      </span>
    );
  }
  const label = props.starred ? m(LIBRARY_LABELS.removeStar) : m(LIBRARY_LABELS.star);
  return (
    <span
      className={
        props.starred
          ? "flex size-7 shrink-0 items-center justify-center"
          : "flex size-7 shrink-0 items-center justify-center opacity-0 focus-within:opacity-100 group-hover:opacity-100 @max-[20rem]/row:hidden"
      }
    >
      <ScientTooltip content={label}>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={`${label}: ${props.title ?? m(msg("Untitled source"))}`}
          aria-pressed={props.starred}
          disabled={pending}
          onClick={() => {
            setPending(true);
            void onToggle().finally(() => setPending(false));
          }}
        >
          <Star className={props.starred ? "fill-current" : undefined} />
        </Button>
      </ScientTooltip>
    </span>
  );
}

function creatorLabel(record: SourceRecord, resolve: MessageResolver): string {
  const creator = record.creators[0];
  return (
    creator?.familyName ??
    creator?.literalName ??
    creator?.givenName ??
    resolve(msg("Unknown creator"))
  );
}

/** A click opens the source, or picks it while picking or with a modifier key held. */
export function activateSource(
  event: { readonly metaKey: boolean; readonly ctrlKey: boolean; readonly shiftKey: boolean },
  record: SourceRecord,
  row: SourceRowContext,
) {
  if (row.selection.size > 0 || event.metaKey || event.ctrlKey || event.shiftKey) {
    row.onToggleSelected(record.sourceId);
  } else {
    row.onOpenDetails(record.sourceId);
  }
}

/** Opens the source's PDF, or its details when it has several to choose from. */
export function SourcePdfAction(props: {
  readonly record: SourceRecord;
  readonly row: SourceRowContext;
  readonly size: "icon-sm" | "icon-xs";
}) {
  const gt = useGT();
  const { record, row } = props;
  const materialSelection = selectScientSourceMaterial({ materials: record.attachments });
  if (materialSelection._tag === "Selected") {
    const pdf = materialSelection.material;
    return (
      <ScientTooltip content={gt("Open PDF")}>
        <Button
          variant="ghost"
          size={props.size}
          aria-label={gt("Open PDF: {fileName}", { fileName: pdf.fileName })}
          onClick={() => {
            row.onOpenPdf({
              sourceId: record.sourceId,
              attachmentId: pdf.attachmentId,
              fileName: pdf.fileName,
            });
          }}
        >
          <FileText />
        </Button>
      </ScientTooltip>
    );
  }
  if (materialSelection._tag !== "SeveralMaterials") return null;
  return (
    <ScientTooltip content={gt("Choose a PDF in source details")}>
      <Button
        variant="ghost"
        size={props.size}
        aria-label={gt("Choose a PDF to open: {title}", {
          title: record.title ?? gt("Untitled source"),
        })}
        onClick={() => row.onOpenDetails(record.sourceId)}
      >
        <FileText />
      </Button>
    </ScientTooltip>
  );
}

export function SourceMenuButton(props: {
  readonly record: SourceRecord;
  readonly row: SourceRowContext;
}) {
  const gt = useGT();
  return (
    <ScientTooltip content={gt("More source actions")}>
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label={gt("More source actions")}
        onClick={(event) => {
          event.stopPropagation();
          const bounds = event.currentTarget.getBoundingClientRect();
          props.row.onShowMenu(props.record, { x: bounds.right, y: bounds.bottom });
        }}
      >
        <MoreVertical />
      </Button>
    </ScientTooltip>
  );
}

export function SourceProvenance(props: {
  readonly record: SourceRecord;
  readonly row: SourceRowContext;
}) {
  const m = useMessages();
  const { record, row } = props;
  const justAdded = row.recentlyAddedSourceIds.has(record.sourceId) && !record.fromSnapshot;
  const membership = row.listed === "library" ? sourcePinLabel(record, row.listed, m) : "";
  return `${sourceAddedLabel(record.importedAt, justAdded, false, m)}${membership}`;
}

export function SourceRow(props: {
  readonly record: SourceRecord;
  readonly row: SourceRowContext;
}) {
  const m = useMessages();
  const gt = useGT();
  const { record, row } = props;
  const metadataDiagnostics = row.diagnosticsBySourceId.get(record.sourceId);
  const onToggleStar = row.onToggleStar;
  const material = selectScientSourceMaterial({ materials: record.attachments })._tag;
  const hasPdf = material === "Selected" || material === "SeveralMaterials";
  return (
    <div
      className={`group @container/row flex w-full items-center gap-2 rounded-xl px-2 py-1.5 transition-colors hover:bg-foreground/[0.045] ${row.selection.has(record.sourceId) ? "bg-accent/35" : ""}`}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
        row.onShowMenu(record, { x: event.clientX, y: event.clientY });
      }}
    >
      {row.selection.size > 0 ? (
        <span className="ml-1 flex shrink-0">
          <Checkbox
            checked={row.selection.has(record.sourceId)}
            aria-label={gt("Select {title}", { title: record.title ?? gt("Untitled source") })}
            onCheckedChange={() => row.onToggleSelected(record.sourceId)}
          />
        </span>
      ) : null}
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              className="flex min-w-0 flex-1 cursor-pointer items-center gap-3 rounded-md px-1 py-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
              onClick={(event) => activateSource(event, record, row)}
            >
              <SourceJournalIcon record={record} />
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium wrap-break-word">
                  {record.title ?? gt("Untitled source")}
                </span>
                <span className="mt-0.5 block text-xs text-muted-foreground">
                  {creatorLabel(record, m)}
                  {record.issuedYear ? ` · ${record.issuedYear}` : ""}
                  {sourceTrustLabel(record, m)}
                  {record.fromSnapshot ? sourcePinLabel(record, row.listed, m) : null}
                </span>
              </span>
            </button>
          }
        />
        <TooltipPopup side="top">
          <SourceProvenance record={record} row={row} />
        </TooltipPopup>
      </Tooltip>
      <div className="mr-1 flex shrink-0 items-center gap-1">
        {metadataDiagnostics && metadataDiagnostics.length > 0 ? (
          <span className="flex size-7 shrink-0 items-center justify-center">
            <MetadataReviewIndicator
              diagnostics={metadataDiagnostics}
              onOpen={() => row.onOpenDetails(record.sourceId)}
            />
          </span>
        ) : null}
        <span className="flex w-3 shrink-0 items-center justify-center">
          {record.readingStatus === "unread" ? (
            <ScientTooltip content={m(LIBRARY_LABELS.unread)}>
              <span
                role="img"
                aria-label={m(LIBRARY_LABELS.unread)}
                className="size-1.5 rounded-full bg-sky-500"
              />
            </ScientTooltip>
          ) : null}
        </span>
        {/* An empty slot keeps PDF icons in line, except where the title needs the room. */}
        <span
          className={`flex size-7 shrink-0 items-center justify-center ${hasPdf ? "" : "@max-[20rem]/row:hidden"}`}
        >
          <SourcePdfAction record={record} row={row} size="icon-sm" />
        </span>
        {/* The star sits beside the menu, so it lines up from row to row. */}
        {record.readingStatus !== undefined ? (
          <RowStar
            title={record.title}
            starred={record.starred === true}
            {...(onToggleStar ? { onToggle: () => onToggleStar(record) } : {})}
          />
        ) : null}
        <SourceMenuButton record={record} row={row} />
      </div>
    </div>
  );
}
