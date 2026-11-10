import type { EnvironmentId, ScientSourcesExportRequest } from "@t3tools/contracts";
import { LoaderCircle, Upload } from "lucide-react";
import { useState } from "react";

import { Button } from "../../components/ui/button";
import {
  Menu,
  MenuCheckboxItem,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuItemDetail,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from "../../components/ui/menu";
import { downloadBlob } from "../../components/preview/staticImageActions";
import { toastManager } from "../../components/ui/toast";
import { ScientTooltip } from "../presentation/ScientTooltip";
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

/** Exports the shown sources (all of them unless a search narrows the list) to a reference file. */
export function SourcesExportMenu(props: {
  readonly environmentId: EnvironmentId;
  readonly root: string;
  readonly totalCount: number;
  /** The shown sources when a search narrows the list; null exports everything. */
  readonly shownSourceIds: ReadonlyArray<string> | null;
}) {
  const [includeNotes, setIncludeNotes] = useState(false);
  const [exporting, setExporting] = useState(false);
  const count = props.shownSourceIds?.length ?? props.totalCount;
  if (props.totalCount === 0) return null;

  const exportAs = async (option: (typeof FORMATS)[number]) => {
    setExporting(true);
    try {
      const result = await exportScientSources(props.environmentId, {
        root: props.root,
        format: option.format,
        ...(props.shownSourceIds ? { sourceIds: [...props.shownSourceIds] } : {}),
        includeNotes,
      });
      downloadBlob(new Blob([result.content], { type: option.mediaType }), result.fileName);
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

  return (
    <Menu>
      <ScientTooltip content="Export">
        <MenuTrigger
          render={
            <Button size="icon-xs" variant="ghost" aria-label="Export sources" disabled={exporting}>
              {exporting ? <LoaderCircle className="animate-spin" /> : <Upload />}
            </Button>
          }
        />
      </ScientTooltip>
      <MenuPopup align="end" side="bottom" className="min-w-52">
        <MenuGroup>
          <MenuGroupLabel>
            {props.shownSourceIds
              ? `Export ${count.toLocaleString()} shown`
              : `Export ${count === 1 ? "1 source" : `all ${count.toLocaleString()} sources`}`}
          </MenuGroupLabel>
          {FORMATS.map((option) => (
            <MenuItem key={option.format} onClick={() => void exportAs(option)}>
              {option.label}
              <MenuItemDetail>{option.extension}</MenuItemDetail>
            </MenuItem>
          ))}
        </MenuGroup>
        <MenuSeparator />
        <MenuCheckboxItem checked={includeNotes} onCheckedChange={setIncludeNotes}>
          Include notes
        </MenuCheckboxItem>
      </MenuPopup>
    </Menu>
  );
}
