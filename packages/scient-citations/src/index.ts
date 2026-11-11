import type { ScientSourceRecord } from "@scientfactory/scient-sources";
import { cslJsonItem, type CslJsonItem } from "@scientfactory/scient-sources/bibliography";

import { renderCslBibliographyEntry, type CslStyleSource } from "./cslEngine.ts";

export { bundledCslStyle, cslStyleRenders, type CslStyleSource } from "./cslEngine.ts";
export { readCslStyle, renderableCslStyle, type CslStyleInfo } from "./cslStyle.ts";

export { SCIENT_REFERENCE_STYLES } from "./styles.ts";
export type { ScientReferenceStyleId } from "./styles.ts";

/** CSL-JSON for citation rendering, from the shared writer; `id` is the source ID. */
export function scientSourceToCslJson(record: ScientSourceRecord): CslJsonItem {
  return cslJsonItem(
    { record, citationKey: record.citationKey ?? "" },
    { includeNotes: false, id: record.sourceId },
  );
}

export function formatSourceReference(record: ScientSourceRecord, style: CslStyleSource): string {
  const formatted = renderCslBibliographyEntry(scientSourceToCslJson(record), style)
    .replace(/\r\n?/gu, "\n")
    .trim();

  if (!formatted) throw new Error("The citation processor returned an empty reference.");
  return formatted;
}
