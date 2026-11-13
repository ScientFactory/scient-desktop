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
import { agentVerificationLabel, sourceAddedLabel, sourcePinLabel } from "./sourceLabels";

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

function MetadataReviewIndicator(props: {
  readonly diagnostics: ReadonlyArray<SourceDiagnostic>;
  readonly onOpen: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            className="rounded-full text-amber-600 outline-none hover:text-amber-700 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring dark:text-amber-400 dark:hover:text-amber-300"
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
      <TooltipPopup side="top" align="end" className="max-w-72" variant="glass">
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

/** A personal Library's star on a row: shown when set, offered on hover to a session that may change it. */
function RowStar(props: {
  readonly title: string | null;
  readonly starred: boolean;
  readonly onToggle?: () => Promise<void>;
}) {
  const [pending, setPending] = useState(false);
  const onToggle = props.onToggle;
  if (!onToggle) {
    return (
      <span className="flex size-7 shrink-0 items-center justify-center text-muted-foreground">
        {props.starred ? (
          <Star role="img" aria-label={LIBRARY_LABELS.starred} className="size-3.5 fill-current" />
        ) : null}
      </span>
    );
  }
  const label = props.starred ? LIBRARY_LABELS.removeStar : LIBRARY_LABELS.star;
  return (
    <span
      className={
        props.starred
          ? "flex size-7 shrink-0 items-center justify-center"
          : "flex size-7 shrink-0 items-center justify-center opacity-0 focus-within:opacity-100 group-hover:opacity-100"
      }
    >
      <ScientTooltip content={label}>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={`${label}: ${props.title ?? "Untitled source"}`}
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

function creatorLabel(record: SourceRecord): string {
  const creator = record.creators[0];
  return creator?.familyName ?? creator?.literalName ?? creator?.givenName ?? "Unknown creator";
}

export function SourceRow(props: {
  readonly record: SourceRecord;
  readonly row: SourceRowContext;
}) {
  const { record, row } = props;
  const materialSelection = selectScientSourceMaterial({ materials: record.attachments });
  const pdf = materialSelection._tag === "Selected" ? materialSelection.material : null;
  const hasPdf =
    materialSelection._tag === "Selected" || materialSelection._tag === "SeveralMaterials";
  const metadataDiagnostics = row.diagnosticsBySourceId.get(record.sourceId);
  const justAdded = row.recentlyAddedSourceIds.has(record.sourceId) && !record.fromSnapshot;
  const onToggleStar = row.onToggleStar;
  return (
    <div
      className={`group flex w-full items-start gap-2 px-2 py-1.5 hover:bg-accent/40 ${row.selection.has(record.sourceId) ? "bg-accent/35" : ""}`}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
        row.onShowMenu(record, { x: event.clientX, y: event.clientY });
      }}
    >
      {row.selection.size > 0 ? (
        <span className="mt-2.5 ml-1 flex shrink-0">
          <Checkbox
            checked={row.selection.has(record.sourceId)}
            aria-label={`Select ${record.title ?? "Untitled source"}`}
            onCheckedChange={() => row.onToggleSelected(record.sourceId)}
          />
        </span>
      ) : null}
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              className="flex min-w-0 flex-1 cursor-pointer items-start gap-3 rounded-md px-1 py-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
              onClick={(event) =>
                row.selection.size > 0 || event.metaKey || event.ctrlKey || event.shiftKey
                  ? row.onToggleSelected(record.sourceId)
                  : row.onOpenDetails(record.sourceId)
              }
            >
              <SourceJournalIcon
                environmentId={row.environmentId}
                root={row.root}
                record={record}
              />
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium">
                  {record.readingStatus === "unread" ? (
                    <span
                      role="img"
                      aria-label={LIBRARY_LABELS.unread}
                      className="me-1.5 inline-block size-1.5 rounded-full bg-sky-500 align-middle"
                    />
                  ) : null}
                  {record.title ?? "Untitled source"}
                </span>
                <span className="mt-0.5 block text-xs text-muted-foreground">
                  {creatorLabel(record)}
                  {record.issuedYear ? ` · ${record.issuedYear}` : ""}
                  {hasPdf ? " · PDF" : " · Metadata only"}
                  {" · "}
                  <span
                    className={justAdded ? "font-medium text-sky-600 dark:text-sky-400" : undefined}
                  >
                    {sourceAddedLabel(
                      record.importedAt,
                      justAdded,
                      record.origin?.actor === "agent",
                    )}
                  </span>
                  {agentVerificationLabel(record)}
                  {sourceTrustLabel(record)}
                  {sourcePinLabel(record, row.listed)}
                </span>
              </span>
            </button>
          }
        />
        <TooltipPopup side="top">View source details</TooltipPopup>
      </Tooltip>
      <div className="mt-0.5 mr-1 flex shrink-0 items-center gap-1">
        {record.readingStatus !== undefined ? (
          <RowStar
            title={record.title}
            starred={record.starred === true}
            {...(onToggleStar ? { onToggle: () => onToggleStar(record) } : {})}
          />
        ) : null}
        <span className="flex size-7 shrink-0 items-center justify-center">
          {metadataDiagnostics && metadataDiagnostics.length > 0 ? (
            <MetadataReviewIndicator
              diagnostics={metadataDiagnostics}
              onOpen={() => row.onOpenDetails(record.sourceId)}
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
          ) : materialSelection._tag === "SeveralMaterials" ? (
            <ScientTooltip content="Choose a PDF in source details">
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`Choose a PDF to open: ${record.title ?? "Untitled source"}`}
                onClick={() => row.onOpenDetails(record.sourceId)}
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
              row.onShowMenu(record, { x: bounds.right, y: bounds.bottom });
            }}
          >
            <MoreVertical />
          </Button>
        </ScientTooltip>
      </div>
    </div>
  );
}
