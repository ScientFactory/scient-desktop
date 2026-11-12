import { AlertCircle, CheckCircle2, Info, LoaderCircle, X } from "lucide-react";

import { Button } from "../../components/ui/button";
import { completedImportCounts, type ScientSourcesImportOutcome } from "./importOutcome";
import { inLibraryNotProjectLabel, LIBRARY_LABELS } from "./libraryLabels";
import type { useScientSources } from "./useScientSources";

function importedCount(operation: NonNullable<ReturnType<typeof useScientSources>["operation"]>) {
  return operation.items.filter((item) => item.state !== "pending").length;
}

export function ImportSummary(props: {
  readonly operation: NonNullable<ReturnType<typeof useScientSources>["operation"]>;
  readonly outcome: ScientSourcesImportOutcome | null;
  readonly onDismiss: () => void;
  readonly onCancel: () => void;
  readonly cancelling: boolean;
  readonly onRetryFailed?: () => void;
  /** On a personal Library, an import that added its sources to the Library only. */
  readonly libraryOnly?: { readonly onAddToProject?: (sourceIds: ReadonlyArray<string>) => void };
}) {
  const counts = props.outcome?.counts ?? completedImportCounts(props.operation);
  const imported = counts.imported;
  const alreadyPresent = counts.alreadyPresent;
  const reviewRequired = counts.reviewRequired;
  const failed = counts.failed;
  const unprocessed = props.operation.items.filter((item) => item.state === "pending").length;
  const running = props.operation.state === "running";
  const stopped = props.operation.state === "cancelled";
  const notes = [...new Set(props.operation.items.flatMap((item) => item.note ?? []))];
  const importedIds = props.operation.items.flatMap((item) =>
    item.state === "imported" && item.sourceId ? [item.sourceId] : [],
  );
  const libraryOnly = props.libraryOnly && !running && importedIds.length > 0;
  if (
    !libraryOnly &&
    !running &&
    !stopped &&
    failed === 0 &&
    unprocessed === 0 &&
    alreadyPresent === 0 &&
    reviewRequired === 0 &&
    notes.length === 0
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
        {notes.slice(0, 3).map((note) => (
          <div key={note} className="mt-1 text-xs text-muted-foreground">
            {note}
          </div>
        ))}
        {libraryOnly ? (
          <div className="mt-1 text-xs text-muted-foreground">
            {inLibraryNotProjectLabel(importedIds.length)}
          </div>
        ) : null}
        {libraryOnly && props.libraryOnly?.onAddToProject ? (
          <Button
            className="mt-2"
            size="xs"
            variant="outline"
            onClick={() => props.libraryOnly?.onAddToProject?.(importedIds)}
          >
            {LIBRARY_LABELS.addToProject}
          </Button>
        ) : null}
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

export function AlreadyPresentSummary(props: {
  readonly outcome: ScientSourcesImportOutcome;
  readonly onDismiss: () => void;
  readonly onViewExisting?: () => void;
}) {
  const count = props.outcome.counts.alreadyPresent;
  return (
    <div className="m-3 flex items-start gap-3 rounded-lg border border-border bg-muted/30 p-3">
      <Info className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium">Already in the Library</div>
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
