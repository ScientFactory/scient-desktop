import type { ScientSourcesOverviewResult } from "@t3tools/contracts";

import {
  sameScientSourceText,
  scientSourceAddedTime,
  scientSourceJournal,
  type ScientSourceSort,
} from "./filterSources";

type SourceSummary = ScientSourcesOverviewResult["records"][number];

/** A run of the sorted sources under one heading. */
export interface ScientSourceSection {
  readonly label: string;
  /** Index of the section's first source in the sorted list. */
  readonly start: number;
  readonly count: number;
}

const ADDED_SECTION_LABELS = {
  today: "Today",
  week: "This week",
  month: "This month",
  earlier: "Earlier",
  unknown: "Date added unknown",
} as const;

/** Local-calendar bounds; the week starts on Monday. A bucket never repeats an earlier one. */
function addedSectionLabel(now: number): (source: SourceSummary) => string {
  const today = new Date(now);
  const startOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  const startOfWeek = new Date(
    today.getFullYear(),
    today.getMonth(),
    today.getDate() - ((today.getDay() + 6) % 7),
  ).getTime();
  const startOfMonth = new Date(today.getFullYear(), today.getMonth(), 1).getTime();
  return (source) => {
    const time = scientSourceAddedTime(source);
    if (time === null) return ADDED_SECTION_LABELS.unknown;
    if (time >= startOfDay) return ADDED_SECTION_LABELS.today;
    if (time >= startOfWeek) return ADDED_SECTION_LABELS.week;
    if (time >= startOfMonth) return ADDED_SECTION_LABELS.month;
    return ADDED_SECTION_LABELS.earlier;
  };
}

/**
 * The headings a sort gives the list, read off the already sorted sources: each change of
 * heading starts a section. Title and Author have none. `now` places Last added's buckets.
 */
export function scientSourceSections(
  sources: ReadonlyArray<SourceSummary>,
  sort: ScientSourceSort,
  now: number,
): ReadonlyArray<ScientSourceSection> {
  let headingOf: (source: SourceSummary) => string;
  // Journals the sort counts as equal (case, accents) share the first one's heading.
  let same = (left: string, right: string) => left === right;
  switch (sort) {
    case "title":
    case "author":
      return [];
    case "last-added":
      headingOf = addedSectionLabel(now);
      break;
    case "publication-year":
      headingOf = (source) => (source.issuedYear === null ? "No year" : String(source.issuedYear));
      break;
    case "journal":
      headingOf = (source) => scientSourceJournal(source) ?? "";
      same = sameScientSourceText;
      break;
  }
  const sections: ScientSourceSection[] = [];
  let heading = "";
  let start = 0;
  const close = (end: number) =>
    sections.push({ label: heading || "No journal or proceedings", start, count: end - start });
  for (let index = 0; index < sources.length; index += 1) {
    const next = headingOf(sources[index]!);
    if (index > 0 && same(heading, next)) continue;
    if (index > 0) close(index);
    heading = next;
    start = index;
  }
  if (sources.length > 0) close(sources.length);
  return sections;
}

/** A card's heading: the section's name where it starts, dimmed where a new row continues it. */
export interface SourceCardLabel {
  readonly section: ScientSourceSection;
  readonly continued: boolean;
}

export interface SourceCardRow {
  readonly key: string;
  readonly cards: ReadonlyArray<{
    readonly record: SourceSummary;
    readonly label: SourceCardLabel | null;
  }>;
}

/**
 * The one ordered flow cut into rows of `columns` cards. Sections never break a row: a section
 * that starts mid-row labels its first card there, and each row it continues on labels its first.
 */
export function scientSourceCardRows(
  sources: ReadonlyArray<SourceSummary>,
  sections: ReadonlyArray<ScientSourceSection>,
  columns: number,
): ReadonlyArray<SourceCardRow> {
  const width = Math.max(1, Math.floor(columns));
  const rows: SourceCardRow[] = [];
  let sectionIndex = 0;
  for (let rowStart = 0; rowStart < sources.length; rowStart += width) {
    const cards = sources.slice(rowStart, rowStart + width).map((record, offset) => {
      const index = rowStart + offset;
      while (sectionIndex + 1 < sections.length && sections[sectionIndex + 1]!.start <= index) {
        sectionIndex += 1;
      }
      const section = sections[sectionIndex];
      if (!section) return { record, label: null };
      if (section.start === index) return { record, label: { section, continued: false } };
      return { record, label: offset === 0 ? { section, continued: true } : null };
    });
    rows.push({ key: sources[rowStart]!.sourceId, cards });
  }
  return rows;
}
