import { manualBibliography } from "./latexBibliographyModel";
import { latexWithoutComments } from "./latexPackages";

export interface CompiledBibliographyItem {
  label: string;
  displayLabel: string | null;
  body: string;
}

/** Read BibTeX's printed entries; generated preamble helpers are never executed or edited. */
export function compiledBibliographyItems(
  source: string | null,
): CompiledBibliographyItem[] | null {
  if (!source || source.length > 1_000_000) return null;
  const clean = latexWithoutComments(source);
  const parsed = manualBibliography(clean);
  if (parsed.error || parsed.containers.length !== 1 || parsed.entries.length > 1000) return null;
  return parsed.entries.map((entry) => ({
    label: entry.key,
    displayLabel: entry.label || null,
    body: entry.body
      .replace(/\\(?:newblock|BIBentrySTDinterwordspacing|BIBentryALTinterwordspacing)\b\s*/gu, " ")
      .trim(),
  }));
}
