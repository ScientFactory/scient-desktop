import type { ScientSourcesPreflightResult } from "@t3tools/contracts";
import { AlertCircle, CheckCircle2, Download, FileText, LoaderCircle } from "lucide-react";
import { useState } from "react";

import { Button } from "../../components/ui/button";
import { Checkbox } from "../../components/ui/checkbox";
import { ScrollArea } from "../../components/ui/scroll-area";
import { PanelHeader, SourceErrorBanner } from "./PanelChrome";
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
  const [possibleMatchOverrides, setPossibleMatchOverrides] = useState<ReadonlySet<string>>(
    new Set(),
  );
  const itemKeys = props.preflight.items.flatMap((item) => {
    const itemKey = item.candidate.sourceKey;
    return item.duplicate.kind === "new" || possibleMatchOverrides.has(itemKey) ? [itemKey] : [];
  });
  const overrideKeys = props.preflight.items.flatMap((item) => {
    const itemKey = item.candidate.sourceKey;
    return item.duplicate.kind === "possible-metadata-match" && possibleMatchOverrides.has(itemKey)
      ? [itemKey]
      : [];
  });
  const importableKeys = new Set(itemKeys);
  const selectedCount = props.preflight.items.length;
  const localFiles = props.adapter === "local-files";
  const hasMetadataWarnings = props.preflight.items.some(
    (item) => importableKeys.has(item.candidate.sourceKey) && item.metadataDiagnostics.length > 0,
  );
  const localActionLabel = props.busy
    ? "Adding…"
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
              ? "Review PDF"
              : `Review ${selectedCount} PDFs`
            : "Review import"
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
              Import {itemKeys.length}
            </Button>
          ) : null
        }
      />
      {props.error ? (
        <SourceErrorBanner message={props.error} onDismiss={props.onDismissError} />
      ) : null}
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
        <span>
          {itemKeys.length > 0
            ? localFiles
              ? `${itemKeys.length} PDF${itemKeys.length === 1 ? "" : "s"} ready`
              : `${itemKeys.length} of ${selectedCount} selected ${selectedCount === 1 ? "reference is" : "references are"} ready to import`
            : localFiles
              ? "Nothing new to add"
              : "Nothing new to import"}
        </span>
        {localFiles && itemKeys.length > 0 ? (
          <Button
            size="xs"
            variant="ghost"
            disabled={props.busy || props.readOnly}
            aria-busy={props.busy}
            onClick={() => props.onImport(itemKeys, overrideKeys)}
          >
            {props.busy ? <LoaderCircle className="animate-spin" /> : <Download />}
            {localActionLabel}
          </Button>
        ) : null}
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="divide-y divide-border">
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
            return (
              <div key={itemKey} className={willImport ? "bg-accent/20 px-3 py-3" : "px-3 py-3"}>
                <div className="flex min-w-0 items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium">
                      {item.candidate.title ?? "Untitled source"}
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
                            ? "Ready to import"
                            : importingPossibleMatch
                              ? "Will import as a separate source"
                              : duplicateStatus}
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
                      Import separately
                    </label>
                  ) : null}
                </div>
                {willImport &&
                props.adapter === "zotero" &&
                item.candidate.pdfAttachmentCount > 1 ? (
                  <div className="mt-2 flex items-start gap-1.5 text-xs text-amber-700 dark:text-amber-300">
                    <FileText className="mt-px size-3.5 shrink-0" aria-hidden="true" />
                    <span>
                      {item.candidate.pdfAttachmentCount} PDFs in Zotero · importing{" "}
                      {item.candidate.pdfFileName ?? "one PDF"}
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
