import { T, useGT } from "gt-react";
import type { EnvironmentId, ScientSourcesExportRequest } from "@t3tools/contracts";
import { Upload } from "lucide-react";
import { useState, type ReactNode } from "react";

import {
  MenuCheckboxItem,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuItemDetail,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
} from "../../components/ui/menu";
import { downloadBlob } from "../../components/preview/staticImageActions";
import { toastManager } from "../../components/ui/toast";
import { exportScientSources } from "./client";
import { sourcesErrorMessage } from "./errorMessage";
import { settleAfter } from "./settleAfter";

const FORMATS: ReadonlyArray<{
  readonly format: ScientSourcesExportRequest["format"];
  readonly label: string;
  readonly extension: string;
  readonly mediaType: string;
}> = [
  { format: "bibtex", label: "BibTeX", extension: ".bib", mediaType: "application/x-bibtex" },
  {
    format: "ris",
    label: "RIS",
    extension: ".ris",
    mediaType: "application/x-research-info-systems",
  },
  // oxlint-disable-next-line t3code/no-untranslated-copy -- a file format's name
  { format: "csl-json", label: "CSL-JSON", extension: ".json", mediaType: "application/json" },
  // oxlint-disable-next-line t3code/no-untranslated-copy -- a file format's name
  { format: "endnote-xml", label: "EndNote XML", extension: ".xml", mediaType: "application/xml" },
];

export type SourcesExportScope = {
  readonly kind: "selected" | "shown";
  readonly sourceIds: ReadonlyArray<string>;
};

/** Held above the menu, so a running export and "Include notes" survive the menu closing. */
export function useSourcesExport(props: {
  readonly environmentId: EnvironmentId;
  readonly root: string;
  /** The selected or shown sources; null exports everything. */
  readonly scope: SourcesExportScope | null;
}) {
  const gt = useGT();
  const [includeNotes, setIncludeNotes] = useState(false);
  const [exporting, setExporting] = useState(false);

  const exportAs = async (option: (typeof FORMATS)[number]) => {
    setExporting(true);
    await settleAfter(
      async () => {
        try {
          const result = await exportScientSources(props.environmentId, {
            root: props.root,
            format: option.format,
            ...(props.scope ? { sourceIds: [...props.scope.sourceIds] } : {}),
            includeNotes,
          });
          downloadBlob(new Blob([result.content], { type: option.mediaType }), result.fileName);
          // A selected source removed meanwhile (in another window): the file is not all of them.
          const missing = result.missingSourceIds.length;
          if (missing > 0) {
            toastManager.add({
              type: "warning",
              title:
                missing === 1
                  ? gt("1 selected source is not in this file")
                  : gt("{missing} selected sources are not in this file", { missing }),
              description: gt("They are no longer in the Library."),
            });
          }
          if (result.notKept.length > 0) {
            const lost = result.notKept
              .map(({ field, entryCount }) =>
                entryCount === 1 ? `${field} (1 source)` : `${field} (${entryCount} sources)`,
              )
              .join(", ");
            toastManager.add({
              type: "warning",
              title: gt("Some details are not in this file"),
              description: gt("{label} has no place for: {lost}.", { label: option.label, lost }),
            });
          }
        } catch (cause) {
          toastManager.add({
            type: "error",
            title: gt("Export failed"),
            description: sourcesErrorMessage(cause),
          });
        }
      },
      () => setExporting(false),
    );
  };

  return { includeNotes, setIncludeNotes, exporting, exportAs };
}

/**
 * Exports the selected sources, else the shown ones, else the whole Library, to a reference file;
 * then `projectPackage`, which always concerns the whole project.
 */
export function SourcesExportSubmenu(props: {
  readonly exporter: ReturnType<typeof useSourcesExport>;
  readonly totalCount: number;
  readonly scope: SourcesExportScope | null;
  readonly projectPackage?: ReactNode;
}) {
  const gt = useGT();
  const { exporter } = props;
  const count = props.scope?.sourceIds.length ?? props.totalCount;
  return (
    <MenuSub>
      <MenuSubTrigger disabled={exporter.exporting}>
        <Upload />
        <T context="verb, button">Export</T>
      </MenuSubTrigger>
      <MenuSubPopup className="min-w-52">
        {props.totalCount > 0 ? (
          <>
            <MenuGroup>
              <MenuGroupLabel>
                {props.scope
                  ? gt(
                      "{kind, select, selected {Export {count} selected} other {Export {count} shown}}",
                      { count: count.toLocaleString(), kind: props.scope.kind },
                    )
                  : gt("{count, plural, =1 {Export 1 source} other {Export all {shown} sources}}", {
                      count,
                      shown: count.toLocaleString(),
                    })}
              </MenuGroupLabel>
              {FORMATS.map((option) => (
                <MenuItem key={option.format} onClick={() => void exporter.exportAs(option)}>
                  {option.label}
                  <MenuItemDetail>{option.extension}</MenuItemDetail>
                </MenuItem>
              ))}
            </MenuGroup>
            <MenuSeparator />
            <MenuCheckboxItem
              checked={exporter.includeNotes}
              onCheckedChange={exporter.setIncludeNotes}
            >
              <T>Include notes</T>
            </MenuCheckboxItem>
          </>
        ) : null}
        {props.totalCount > 0 && props.projectPackage ? <MenuSeparator /> : null}
        {props.projectPackage}
      </MenuSubPopup>
    </MenuSub>
  );
}
