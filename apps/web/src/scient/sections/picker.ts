import type { ThreadSection } from "@t3tools/contracts";

import { GENERAL_SECTION_GROUP_ID, normalizeSectionName } from "./logic";

/** Recent sections lead the list only when the rest would not fit at a glance. */
const RECENT_SECTION_LIMIT = 5;

export interface SectionPickerEntry {
  /** A section id, or `GENERAL_SECTION_GROUP_ID`. */
  readonly id: string;
  readonly name: string;
}

export interface SectionPickerList {
  readonly recent: readonly SectionPickerEntry[];
  /** General first, then the listed sections by name. */
  readonly sections: readonly SectionPickerEntry[];
  /** Sections outside the selected project, offered only to a search. */
  readonly otherProjects: readonly SectionPickerEntry[];
  /** The typed name when no section has it yet. */
  readonly createName: string | null;
}

const GENERAL: SectionPickerEntry = { id: GENERAL_SECTION_GROUP_ID, name: "General" };

function fold(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLocaleLowerCase();
}

const byName = (left: SectionPickerEntry, right: SectionPickerEntry) =>
  left.name.localeCompare(right.name);

/**
 * The Move to section list for one catalog. `inScope` holds the section ids
 * the sidebar's selected project lists (null under All projects);
 * `lastActivity` the newest thread activity per section id.
 */
export function sectionPickerList(input: {
  readonly sections: readonly ThreadSection[];
  readonly inScope: ReadonlySet<string> | null;
  readonly lastActivity: ReadonlyMap<string, number>;
  readonly query: string;
}): SectionPickerList {
  const entries = input.sections.map((section) => ({ id: section.id, name: section.name }));
  const listed = entries.filter((entry) => input.inScope?.has(entry.id) ?? true);
  const query = fold(input.query.trim());

  if (query.length === 0) {
    const recent =
      listed.length > RECENT_SECTION_LIMIT
        ? listed
            .filter((entry) => input.lastActivity.has(entry.id))
            .toSorted(
              (left, right) => input.lastActivity.get(right.id)! - input.lastActivity.get(left.id)!,
            )
            .slice(0, RECENT_SECTION_LIMIT)
        : [];
    const rest = listed.filter((entry) => !recent.includes(entry)).toSorted(byName);
    return { recent, sections: [GENERAL, ...rest], otherProjects: [], createName: null };
  }

  const matches = (entry: SectionPickerEntry) => fold(entry.name).includes(query);
  const exists = [GENERAL, ...entries].some((entry) => fold(entry.name) === query);
  return {
    recent: [],
    sections: [GENERAL, ...listed.toSorted(byName)].filter(matches),
    otherProjects: entries
      .filter((entry) => !listed.includes(entry) && matches(entry))
      .toSorted(byName),
    createName: exists ? null : normalizeSectionName(input.query),
  };
}
