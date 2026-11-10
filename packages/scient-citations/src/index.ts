import type { ScientSourceRecord } from "@scientfactory/scient-sources";
import { cslJsonItem, type CslJsonItem } from "@scientfactory/scient-sources/bibliography";

import { renderCslBibliographyEntry } from "./cslEngine.ts";

export { bundledCslStyle } from "./cslEngine.ts";

export { SCIENT_REFERENCE_STYLES } from "./styles.ts";
export type { ScientReferenceStyleId } from "./styles.ts";

import type { ScientReferenceStyleId } from "./styles.ts";

/** CSL-JSON for citation rendering, from the shared writer; `id` is the source ID. */
export function scientSourceToCslJson(record: ScientSourceRecord): CslJsonItem {
  return cslJsonItem(
    { record, citationKey: record.citationKey ?? "" },
    { includeNotes: false, id: record.sourceId },
  );
}

export function formatSourceReference(
  record: ScientSourceRecord,
  style: ScientReferenceStyleId,
): string {
  const formatted = renderCslBibliographyEntry(scientSourceToCslJson(record), style)
    .replace(/\r\n?/gu, "\n")
    .trim();

  if (!formatted) throw new Error("The citation processor returned an empty reference.");
  return formatted;
}
