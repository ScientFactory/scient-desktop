import type { ScientSourcesFileImportResult } from "@t3tools/contracts";

type Report = ScientSourcesFileImportResult["report"];

const NOT_KEPT_SHOWN = 4;

export interface ReferenceFileReportSummary {
  readonly title: string;
  readonly lines: ReadonlyArray<string>;
  readonly hasDetails: boolean;
  readonly canContinue: boolean;
}

const plural = (count: number, one: string, many: string) =>
  `${count.toLocaleString()} ${count === 1 ? one : many}`;

/** What the person needs to know after a reference file import; null when nothing was lost. */
export function summarizeReferenceFileReport(
  fileName: string,
  report: Report,
): ReferenceFileReportSummary | null {
  if (report.entryCount === 0) {
    return {
      title: `No references found in ${fileName}`,
      lines: [],
      hasDetails: false,
      canContinue: false,
    };
  }
  const lines: string[] = [];
  if (report.remaining > 0) {
    lines.push(
      `${report.importCount.toLocaleString()} of ${(report.importCount + report.remaining).toLocaleString()} new references were imported. Import the file again for the rest.`,
    );
  }
  if (report.unreadableCount > 0) {
    lines.push(`${plural(report.unreadableCount, "entry", "entries")} could not be read.`);
  }
  if (report.notKept.length > 0) {
    // A linked-file field can be listed once per reason; the summary counts it once.
    const counts = new Map<string, number>();
    for (const field of report.notKept) {
      counts.set(field.field, (counts.get(field.field) ?? 0) + field.entryCount);
    }
    const shown = [...counts]
      .slice(0, NOT_KEPT_SHOWN)
      .map(([field, count]) => `${field} (${count.toLocaleString()})`);
    const more = counts.size - shown.length;
    lines.push(`Fields not kept: ${shown.join(", ")}${more > 0 ? `, and ${more} more` : ""}.`);
  }
  if (lines.length === 0) return null;
  return {
    title:
      report.remaining > 0 && report.unreadableCount === 0 && report.notKept.length === 0
        ? `More references in ${fileName}`
        : `Not everything in ${fileName} came in`,
    lines,
    hasDetails: report.unreadable.length > 0 || report.notKept.length > 0,
    canContinue: report.remaining > 0,
  };
}

export function unreadableEntryLabel(entry: Report["unreadable"][number]): string {
  const where = [entry.line ? `Line ${entry.line}` : null, entry.citationKey]
    .filter(Boolean)
    .join(" · ");
  return where ? `${where}: ${entry.reason}` : entry.reason;
}

const REFERENCE_FILE_EXTENSIONS = /\.(?:bib|bibtex|biblatex|ris|json|xml)$/iu;

export function isReferenceFileName(fileName: string): boolean {
  return REFERENCE_FILE_EXTENSIONS.test(fileName.trim());
}
