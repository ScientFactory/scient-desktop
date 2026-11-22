import { msg } from "gt-react";

import type { ScientSourceSort } from "./filterSources";

// Kept apart from filterSources.ts, which the server's scale script imports without the web's GT runtime.
export const SCIENT_SOURCE_SORT_OPTIONS = [
  { value: "last-added", label: msg("Last added") },
  { value: "publication-year", label: msg("Publication year") },
  { value: "journal", label: msg("Journal", { $context: "sort order" }) },
  { value: "title", label: msg("Title", { $context: "sort order" }) },
  { value: "author", label: msg("Author", { $context: "sort order" }) },
] as const satisfies ReadonlyArray<{ readonly value: ScientSourceSort; readonly label: string }>;
