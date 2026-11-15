import type { ScientSourceImportOperation } from "@t3tools/contracts";
import { LoaderCircle, X } from "lucide-react";
import { useState } from "react";

import { Button } from "../../components/ui/button";
import { describeImport, type ImportReceiptInput } from "./importOutcome";
import { LIBRARY_LABELS } from "./libraryLabels";
import {
  NOT_BROUGHT_LABELS,
  notBroughtAmount,
  notBroughtLines,
  notBroughtName,
} from "./notBroughtLabels";
import { countOf } from "./referenceFileSummary";
import { importProgressLabel, type SourcesResultContent } from "./sourcesFeedback";

/** How many kinds of things not brought are listed before "Show all". */
const NOT_BROUGHT_FIRST = 5;

export interface ImportReceiptActions {
  /** Goes on with what the import left for later: a large file's or Zotero scope's rest. */
  readonly rest?: { readonly count: number; readonly onImport: () => void } | undefined;
  readonly onRetryFailed?: (() => void) | undefined;
  /** Offered when the import put its sources in My Library only. */
  readonly onAddToProject?: ((sourceIds: ReadonlyArray<string>) => void) | undefined;
  /** Shows the references one thing Zotero holds was not brought for. */
  readonly onShowSources?: ((sourceIds: ReadonlyArray<string>, label: string) => void) | undefined;
  /** Opens the one source that was already present. */
  readonly onViewSource?: ((sourceId: string) => void) | undefined;
}

/**
 * A finished import's result: what came in first, then its exceptions. With details, the summary
 * only counts them and the details list each once; a lone exception goes in the summary. Call it
 * at render, so its actions see the current state.
 */
export function importResultContent(
  input: ImportReceiptInput & ImportReceiptActions,
): SourcesResultContent {
  const receipt = describeImport(input);
  const notBrought =
    input.operation && input.operation.state !== "running" ? notBroughtLines(input.operation) : [];
  const notes = [
    ...receipt.notes,
    ...(notBrought.length > 0 ? ["Zotero holds more for some references than was brought"] : []),
    ...(input.rest && !input.referenceFile
      ? [
          `${input.rest.count.toLocaleString()} more ${input.rest.count === 1 ? "is" : "are"} not imported yet`,
        ]
      : []),
  ];
  const { onAddToProject, onRetryFailed, onViewSource, rest } = input;
  const libraryOnly = receipt.libraryOnlySourceIds;
  const actions = [
    rest ? (
      <Button key="rest" size="xs" variant="outline" onClick={rest.onImport}>
        Import the rest ({rest.count.toLocaleString()})
      </Button>
    ) : null,
    onAddToProject && libraryOnly.length > 0 ? (
      <Button key="add" size="xs" variant="outline" onClick={() => onAddToProject(libraryOnly)}>
        {LIBRARY_LABELS.addToProject}
      </Button>
    ) : null,
    onRetryFailed && receipt.failed > 0 && input.operation?.state !== "cancelled" ? (
      <Button key="retry" size="xs" variant="outline" onClick={onRetryFailed}>
        Try again
      </Button>
    ) : null,
    onViewSource && receipt.existingSourceId ? (
      <Button
        key="view"
        size="xs"
        variant="ghost"
        onClick={() => onViewSource(receipt.existingSourceId!)}
      >
        View
      </Button>
    ) : null,
  ].filter((action) => action !== null);
  const hasDetails =
    notes.length > 1 ||
    receipt.fileDetails.length > 0 ||
    receipt.failures.length > 0 ||
    notBrought.length > 0;
  const exceptions = hasDetails
    ? notes.length > 0
      ? ` ${countOf(notes.length, "exception", "exceptions")}.`
      : ""
    : notes[0]
      ? ` ${notes[0]}.`
      : "";
  return {
    tone: receipt.tone,
    summary: `${receipt.headline}.${exceptions}`,
    ...(hasDetails
      ? {
          details: (
            <ImportReceiptDetails
              notes={notes}
              fileDetails={receipt.fileDetails}
              failures={receipt.failures}
              operation={input.operation}
              onShowSources={input.onShowSources}
            />
          ),
        }
      : {}),
    ...(actions.length > 0 ? { actions } : {}),
  };
}

function ImportReceiptDetails(props: {
  readonly notes: ReadonlyArray<string>;
  readonly fileDetails: ReadonlyArray<string>;
  readonly failures: ReadonlyArray<string>;
  readonly operation: ScientSourceImportOperation | null;
  readonly onShowSources: ImportReceiptActions["onShowSources"];
}) {
  const [allNotBrought, setAllNotBrought] = useState(false);
  const notBrought = props.operation ? notBroughtLines(props.operation) : [];
  return (
    <div className="space-y-2">
      <ul className="list-disc space-y-0.5 ps-4">
        {props.notes.map((note) => (
          <li key={note}>{note}.</li>
        ))}
      </ul>
      {props.fileDetails.length > 0 ? (
        <div className="max-h-48 space-y-0.5 overflow-y-auto text-muted-foreground">
          {props.fileDetails.map((line) => (
            <div key={line}>{line}</div>
          ))}
        </div>
      ) : null}
      {props.failures.length > 0 ? (
        <div className="max-h-32 space-y-0.5 overflow-y-auto text-muted-foreground">
          {[...new Set(props.failures)].map((failure) => (
            <div key={failure}>{failure}</div>
          ))}
        </div>
      ) : null}
      {notBrought.length > 0 ? (
        <div>
          <div className="font-medium">{NOT_BROUGHT_LABELS.heading}</div>
          <div className="text-muted-foreground">{NOT_BROUGHT_LABELS.about}</div>
          <ul className="mt-1 space-y-0.5">
            {(allNotBrought ? notBrought : notBrought.slice(0, NOT_BROUGHT_FIRST)).map((line) => {
              const name = notBroughtName(line);
              return (
                <li
                  key={`${line.kind}:${line.name ?? ""}`}
                  className="flex items-center justify-between gap-2"
                >
                  <span className="min-w-0 break-words">
                    {name}: <span className="text-muted-foreground">{notBroughtAmount(line)}</span>
                  </span>
                  {props.onShowSources && line.sourceIds.length > 0 ? (
                    <Button
                      className="shrink-0"
                      size="xs"
                      variant="ghost"
                      aria-label={`${NOT_BROUGHT_LABELS.show}: ${name}`}
                      onClick={() =>
                        props.onShowSources?.(
                          line.sourceIds,
                          `${NOT_BROUGHT_LABELS.shownSources}: ${name}`,
                        )
                      }
                    >
                      {NOT_BROUGHT_LABELS.show}
                    </Button>
                  ) : null}
                </li>
              );
            })}
          </ul>
          {notBrought.length > NOT_BROUGHT_FIRST ? (
            <Button
              className="mt-1"
              size="xs"
              variant="ghost"
              onClick={() => setAllNotBrought((value) => !value)}
            >
              {allNotBrought
                ? NOT_BROUGHT_LABELS.showFewer
                : `${NOT_BROUGHT_LABELS.showAll} (${notBrought.length})`}
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** A running import in Activity: how far it is, what later parts bring, and its Cancel. */
export function RunningImportBody(props: {
  readonly operation: ScientSourceImportOperation;
  readonly cancelling: boolean;
  readonly onCancel: () => void;
}) {
  const toFollow = props.operation.run?.remaining ?? 0;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <p className="min-w-0 flex-1">
        {importProgressLabel(props.operation)}
        {toFollow > 0 ? ` · ${toFollow.toLocaleString()} more to follow` : ""}
      </p>
      <Button size="xs" variant="ghost" disabled={props.cancelling} onClick={props.onCancel}>
        {props.cancelling ? <LoaderCircle className="animate-spin" /> : <X />}
        {props.cancelling ? "Stopping…" : "Cancel after current item"}
      </Button>
    </div>
  );
}
