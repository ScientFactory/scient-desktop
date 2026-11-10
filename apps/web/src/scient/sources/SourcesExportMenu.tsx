import type { EnvironmentId, ScientSourcesExportRequest } from "@t3tools/contracts";
import { Upload } from "lucide-react";
import { useState } from "react";

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
import { scientSourcesErrorMessage } from "./errorMessage";

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
  { format: "csl-json", label: "CSL-JSON", extension: ".json", mediaType: "application/json" },
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
  const [includeNotes, setIncludeNotes] = useState(false);
  const [exporting, setExporting] = useState(false);

  const exportAs = async (option: (typeof FORMATS)[number]) => {
    setExporting(true);
    try {
      const result = await exportScientSources(props.environmentId, {
        root: props.root,
        format: option.format,
        ...(props.scope ? { sourceIds: [...props.scope.sourceIds] } : {}),
        includeNotes,
      });
      downloadBlob(new Blob([result.content], { type: option.mediaType }), result.fileName);
      if (result.notKept.length > 0) {
        const lost = result.notKept
          .map(({ field, entryCount }) =>
            entryCount === 1 ? `${field} (1 source)` : `${field} (${entryCount} sources)`,
          )
          .join(", ");
        toastManager.add({
          type: "warning",
          title: "Some details are not in this file",
          description: `${option.label} has no place for: ${lost}.`,
        });
      }
    } catch (cause) {
      toastManager.add({
        type: "error",
        title: "Export failed",
        description: scientSourcesErrorMessage(cause, import.meta.env.DEV),
      });
    } finally {
      setExporting(false);
    }
  };

  return { includeNotes, setIncludeNotes, exporting, exportAs };
}

/** Exports the selected sources, else the shown ones, else the whole Library, to a reference file. */
export function SourcesExportSubmenu(props: {
  readonly exporter: ReturnType<typeof useSourcesExport>;
  readonly totalCount: number;
  readonly scope: SourcesExportScope | null;
}) {
  const { exporter } = props;
  const count = props.scope?.sourceIds.length ?? props.totalCount;
  return (
    <MenuSub>
      <MenuSubTrigger disabled={exporter.exporting}>
        <Upload />
        Export
      </MenuSubTrigger>
      <MenuSubPopup className="min-w-52">
        <MenuGroup>
          <MenuGroupLabel>
            {props.scope
              ? `Export ${count.toLocaleString()} ${props.scope.kind}`
              : `Export ${count === 1 ? "1 source" : `all ${count.toLocaleString()} sources`}`}
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
          Include notes
        </MenuCheckboxItem>
      </MenuSubPopup>
    </MenuSub>
  );
}
