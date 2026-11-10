import type { ScientSourcesFileImportResult } from "@t3tools/contracts";
import { Info, X } from "lucide-react";
import { useState } from "react";

import { Button } from "../../components/ui/button";
import { summarizeReferenceFileReport, unreadableEntryLabel } from "./referenceFileSummary";

export function ReferenceFileReport(props: {
  readonly fileName: string;
  readonly report: ScientSourcesFileImportResult["report"];
  readonly busy: boolean;
  readonly onContinue: () => void;
  readonly onDismiss: () => void;
}) {
  const [showDetails, setShowDetails] = useState(false);
  const summary = summarizeReferenceFileReport(props.fileName, props.report);
  if (!summary) return null;
  return (
    <div className="m-3 flex items-start gap-3 rounded-lg border border-border bg-muted/30 p-3">
      <Info className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{summary.title}</div>
        {summary.lines.map((line) => (
          <div key={line} className="mt-0.5 text-xs text-muted-foreground">
            {line}
          </div>
        ))}
        {showDetails ? (
          <div className="mt-2 max-h-48 space-y-1 overflow-y-auto text-xs text-muted-foreground">
            {[...new Set(props.report.unreadable.map(unreadableEntryLabel))].map((label) => (
              <div key={label} className="break-words">
                {label}
              </div>
            ))}
            {props.report.notKept.map((field) => (
              <div key={field.field} className="break-words">
                {field.field}: {field.citationKeys.join(", ")}
                {field.entryCount > field.citationKeys.length
                  ? ` and ${(field.entryCount - field.citationKeys.length).toLocaleString()} more`
                  : ""}
              </div>
            ))}
          </div>
        ) : null}
        {summary.hasDetails || summary.canContinue ? (
          <div className="mt-2 flex flex-wrap gap-1">
            {summary.canContinue ? (
              <Button size="xs" variant="outline" disabled={props.busy} onClick={props.onContinue}>
                Import the rest
              </Button>
            ) : null}
            {summary.hasDetails ? (
              <Button
                size="xs"
                variant="ghost"
                aria-expanded={showDetails}
                onClick={() => setShowDetails((current) => !current)}
              >
                {showDetails ? "Hide details" : "Show details"}
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label="Dismiss file import notes"
        onClick={props.onDismiss}
      >
        <X />
      </Button>
    </div>
  );
}
