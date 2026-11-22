import { T, useGT, Var } from "gt-react";
import type { ScientSourcesPreflightResult } from "@t3tools/contracts";
import { AlertCircle, CheckCircle2, Download, FileText, LoaderCircle } from "lucide-react";
import { useState } from "react";

import { Button } from "../../components/ui/button";
import { Checkbox } from "../../components/ui/checkbox";
import { ScrollArea } from "../../components/ui/scroll-area";
import { isExactSourceDuplicate } from "./importOutcome";
import { SOURCES_COLUMN, PanelHeader, SourceErrorBanner } from "./PanelChrome";
import type { useScientSources } from "./useScientSources";

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

export function ImportReview(props: {
  readonly preflight: NonNullable<ReturnType<typeof useScientSources>["preflight"]>;
  readonly adapter: "zotero" | "local-files";
  readonly busy: boolean;
  readonly readOnly: boolean;
  readonly error: string | null;
  readonly onDismissError: () => void;
  readonly onBack: () => void;
  readonly onImport: (
    itemKeys: ReadonlyArray<string>,
    possibleMetadataMatchOverrides: ReadonlyArray<string>,
  ) => void;
}) {
  const gt = useGT();
  const [possibleMatchOverrides, setPossibleMatchOverrides] = useState<ReadonlySet<string>>(
    new Set(),
  );
  const localFiles = props.adapter === "local-files";
  const itemKeys = props.preflight.items.flatMap((item) => {
    const itemKey = item.candidate.sourceKey;
    return item.duplicate.kind === "new" || possibleMatchOverrides.has(itemKey) ? [itemKey] : [];
  });
  // A PDF of a paper already here goes in too, and is added to that source if it has no copy.
  const alreadyHereKeys = localFiles
    ? props.preflight.items.flatMap((item) =>
        isExactSourceDuplicate(item.duplicate.kind) ? [item.candidate.sourceKey] : [],
      )
    : [];
  const overrideKeys = props.preflight.items.flatMap((item) => {
    const itemKey = item.candidate.sourceKey;
    return item.duplicate.kind === "possible-metadata-match" && possibleMatchOverrides.has(itemKey)
      ? [itemKey]
      : [];
  });
  const importableKeys = new Set(itemKeys);
  const selectedCount = props.preflight.items.length;
  const hasMetadataWarnings = props.preflight.items.some(
    (item) => importableKeys.has(item.candidate.sourceKey) && item.metadataDiagnostics.length > 0,
  );
  const localActionLabel = props.busy
    ? "Adding…"
    : itemKeys.length === 0
      ? "Continue"
      : hasMetadataWarnings
        ? itemKeys.length > 1
          ? `Add ${itemKeys.length} anyway`
          : "Add anyway"
        : "Add to Library";

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PanelHeader
        title={
          localFiles
            ? selectedCount === 1
              ? gt("Review PDF")
              : gt("Review {selectedCount} PDFs", { selectedCount })
            : gt("Review import")
        }
        onBack={props.onBack}
        action={
          !localFiles && itemKeys.length > 0 ? (
            <Button
              size="xs"
              variant="ghost"
              disabled={props.busy || props.readOnly}
              onClick={() => props.onImport(itemKeys, overrideKeys)}
            >
              <Download />
              <T>
                Import <Var>{itemKeys.length}</Var>
              </T>
            </Button>
          ) : null
        }
      />
      {props.error ? (
        <SourceErrorBanner message={props.error} onDismiss={props.onDismissError} />
      ) : null}
      <div className="shrink-0 border-b border-border bg-muted/30">
        <div
          className={`${SOURCES_COLUMN} flex items-center justify-between gap-3 px-3 py-2 text-xs text-muted-foreground`}
        >
          <span>
            {itemKeys.length > 0
              ? localFiles
                ? gt("{count, plural, one {{count} PDF ready} other {{count} PDFs ready}}", {
                    count: itemKeys.length,
                  })
                : gt(
                    "{selected, plural, one {{count} of {selected} selected reference is ready to import} other {{count} of {selected} selected references are ready to import}}",
                    { count: itemKeys.length, selected: selectedCount },
                  )
              : localFiles
                ? gt("Nothing new to add")
                : gt("Nothing new to import")}
          </span>
          {localFiles && itemKeys.length + alreadyHereKeys.length > 0 ? (
            <Button
              size="xs"
              variant="ghost"
              disabled={props.busy || props.readOnly}
              aria-busy={props.busy}
              onClick={() => props.onImport([...itemKeys, ...alreadyHereKeys], overrideKeys)}
            >
              {props.busy ? <LoaderCircle className="animate-spin" /> : <Download />}
              {localActionLabel}
            </Button>
          ) : null}
        </div>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className={`${SOURCES_COLUMN} divide-y divide-border`}>
          {props.preflight.items.map((item) => {
            const itemKey = item.candidate.sourceKey;
            const possibleMatch = item.duplicate.kind === "possible-metadata-match";
            const importingPossibleMatch = possibleMatchOverrides.has(itemKey);
            const willImport = item.duplicate.kind === "new" || importingPossibleMatch;
            const metadataSummary = candidateMetadataSummary(item.candidate);
            const duplicateStatus =
              item.duplicate.kind === "same-origin"
                ? "Already in the Library"
                : item.duplicate.kind === "same-identifier"
                  ? "A source with this identifier is already in the Library"
                  : item.duplicate.kind === "same-pdf"
                    ? "This PDF is already in the Library"
                    : item.duplicate.reason;
            const status =
              localFiles &&
              item.duplicate.kind !== "same-pdf" &&
              isExactSourceDuplicate(item.duplicate.kind)
                ? "Already in the Library: this PDF is added to it"
                : duplicateStatus;
            return (
              <div key={itemKey} className={willImport ? "bg-accent/20 px-3 py-3" : "px-3 py-3"}>
                <div className="flex min-w-0 items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium">
                      {item.candidate.title ?? gt("Untitled source")}
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
                            ? gt("Ready to import")
                            : importingPossibleMatch
                              ? gt("Will import as a separate source")
                              : status}
                        </span>
                      </div>
                    )}
                  </div>
                  {possibleMatch ? (
                    <label className="flex shrink-0 cursor-pointer items-center gap-2 text-xs text-muted-foreground">
                      <Checkbox
                        checked={importingPossibleMatch}
                        className="size-4"
                        onCheckedChange={() => {
                          setPossibleMatchOverrides((current) => {
                            const next = new Set(current);
                            if (next.has(itemKey)) next.delete(itemKey);
                            else next.add(itemKey);
                            return next;
                          });
                        }}
                      />
                      <T>Import separately</T>
                    </label>
                  ) : null}
                </div>
                {willImport &&
                props.adapter === "zotero" &&
                item.candidate.pdfAttachmentCount > 1 ? (
                  <div className="mt-2 flex items-start gap-1.5 text-xs text-amber-700 dark:text-amber-300">
                    <FileText className="mt-px size-3.5 shrink-0" aria-hidden="true" />
                    <span>
                      <T>
                        <Var>{item.candidate.pdfAttachmentCount}</Var> PDFs in Zotero · importing{" "}
                        <Var>{item.candidate.pdfFileName ?? gt("one PDF")}</Var>
                      </T>
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
