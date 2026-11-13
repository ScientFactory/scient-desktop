import type {
  ScientSourceIdentityProblem,
  ScientSourceReadingStatus,
  ScientSourcesReadingStateResult,
  ScientSourcesScope,
} from "@t3tools/contracts";

/**
 * Words the panel shows only on a personal Library. A source is "in this project", never pinned:
 * `libraryLabels.test.ts` keeps "pin" out of every one of them.
 */
export const LIBRARY_LABELS = {
  scopes: { project: "This project", library: "All" } satisfies Record<ScientSourcesScope, string>,
  inThisProject: "In this project",
  notInThisLibrary: "Not in this Library",
  addToProject: "Add to project",
  removeFromProject: "Remove from this project",
  projectNote: "Note for this project",
  myNote: "My note",
  myNoteHelp: "Follows this paper into every project. It is not saved in any project folder.",
  unread: "Unread",
  starred: "Starred",
  markRead: "Mark read",
  markUnread: "Mark unread",
  star: "Star",
  removeStar: "Remove star",
  readingMenu: "Mark",
  citedAs: "Cited as",
  alsoCitedAs: "Also cited as",
  addFailed: "Not added to this project",
  removeFailed: "Not removed from this project",
  readingFailed: "Reading status was not changed",
  stayInLibrary: "They stay in your Library.",
  staysInLibrary: "It stays in your Library.",
  removeSnapshot: "Remove a source this Library does not have?",
  removeSnapshotHelp:
    "This computer's Library does not have it: it is only kept for this project. Removing it cannot be undone here, and it cannot be added back from this computer.",
  libraryCopy: "Library copy",
  linkToCopy: "Link to this Library copy",
  keepSeparate: "Keep separate",
  askAgain: "Ask again",
  keptSeparate: "You kept this separate from the Library copies below.",
  linked: "Linked to the Library copy",
  linkedHelp: "Its citation key, project note and reviews stay as they were.",
  unlinked: "Link undone",
  linkFailed: "Not linked",
  separateFailed: "Not changed",
  keptSeparateToast: "Kept separate",
} as const;

const COPY_PROBLEM_WORDS: Readonly<Record<ScientSourceIdentityProblem, string>> = {
  "merge-undone": "A merge of the two was undone.",
  "merge-record-unreadable": "The details of an earlier merge could not be read.",
  "title-missing": "One of them has no title.",
  "titles-differ": "The titles differ.",
  "type-unknown": "The type of one is unknown.",
  "preprint-and-published": "One is a preprint and the other is not.",
  "types-differ": "The types differ.",
  "arxiv-versions-differ": "They name different arXiv versions.",
  "identifiers-conflict": "Other identifiers differ.",
};

/** Why this project's source uses its own details although the Library has similar ones. */
export function libraryCopyLabel(match: {
  readonly reason: "contradicted" | "ambiguous";
  readonly candidates: ReadonlyArray<unknown>;
}): string {
  if (match.reason === "ambiguous") {
    return "Your Library has several copies that match, so this project's own details are used until you choose one.";
  }
  return match.candidates.length === 1
    ? "Your Library has a similar copy, but it differs from what this project recorded, so this project's own details are used."
    : "Your Library has similar copies, but they differ from what this project recorded, so this project's own details are used.";
}

export function libraryCopyProblemLabel(problem: ScientSourceIdentityProblem | undefined): string {
  return problem ? COPY_PROBLEM_WORDS[problem] : "It matches this project's details.";
}

const sources = (count: number) => (count === 1 ? "1 source" : `${count} sources`);

/** An import or add started from "All" brings sources into the Library only. */
export function inLibraryNotProjectLabel(count: number): string {
  return count === 1
    ? "It is in your Library, not in this project."
    : "They are in your Library, not in this project.";
}

export function addedToProjectLabel(count: number): string {
  return `Added ${sources(count)} to this project`;
}

export function removedFromProjectLabel(count: number): string {
  return `Removed ${sources(count)} from this project`;
}

export function removeSnapshotsLabel(count: number): string {
  return count === 1
    ? LIBRARY_LABELS.removeSnapshot
    : `Remove ${sources(count)} this Library does not have?`;
}

export function removeSnapshotsHelp(count: number): string {
  return count === 1
    ? LIBRARY_LABELS.removeSnapshotHelp
    : "This computer's Library does not have them: they are only kept for this project. Removing them cannot be undone here, and they cannot be added back from this computer.";
}

/** Toast line when removed sources were only kept for this project; any others stay in the Library. */
export function goneFromComputerLabel(count: number): string {
  return count === 1
    ? "It is gone from this computer: this Library does not have it."
    : `${count} of them are gone from this computer: this Library does not have them.`;
}

/** After a move to Trash: other projects keep the source as their saved citation details. */
export function alsoInOtherProjectsLabel(projects: number | undefined): string | null {
  if (!projects) return null;
  return projects === 1
    ? "Also in 1 other project, which keeps its citation details."
    : `Also in ${projects} other projects, which keep its citation details.`;
}

/** Before deleting for good: the projects that keep citing the sources from their own copy. */
export function stillCitedInLabel(projects: ReadonlyArray<string>): string | null {
  if (projects.length === 0) return null;
  const names = new Intl.ListFormat("en", { type: "conjunction" }).format(projects);
  return projects.length === 1
    ? `Still cited in ${names}: it keeps the citation details from its own copy.`
    : `Still cited in ${names}: they keep the citation details from their own copies.`;
}

export function someAlsoInOtherProjectsLabel(sourceCount: number): string {
  return sourceCount === 1
    ? "1 of them is also in other projects, which keep its citation details."
    : `${sourceCount} of them are also in other projects, which keep their citation details.`;
}

export interface ReadingStateChange {
  readonly readingStatus?: ScientSourceReadingStatus;
  readonly starred?: boolean;
}

export interface ReadingStateFilter {
  readonly unread?: true | undefined;
  readonly starred?: true | undefined;
}

/** A source with no reading state (a pin's snapshot, or any source on a project server) never matches. */
export function matchesReadingFilter(
  record: { readonly readingStatus?: ScientSourceReadingStatus; readonly starred?: boolean },
  filter: ReadingStateFilter,
): boolean {
  if (filter.unread && record.readingStatus !== "unread") return false;
  if (filter.starred && record.starred !== true) return false;
  return true;
}

/** The toast after a bulk reading change; sources no longer in the Library are counted, not failed. */
export function readingResultLabel(
  change: ReadingStateChange,
  result: ScientSourcesReadingStateResult,
): { readonly title: string; readonly description?: string } {
  const missing = result.sources.filter((entry) => entry.outcome === "not-found").length;
  const changed = result.sources.length - missing;
  const title =
    change.starred !== undefined
      ? change.starred
        ? `Starred ${sources(changed)}`
        : `Removed the star from ${sources(changed)}`
      : `Marked ${sources(changed)} ${change.readingStatus === "read" ? "read" : "unread"}`;
  return {
    title,
    ...(missing > 0
      ? {
          description:
            missing === 1
              ? "1 source is no longer in the Library."
              : `${missing} sources are no longer in the Library.`,
        }
      : {}),
  };
}
