import type {
  ScientSourceIdentityProblem,
  ScientSourceReadingStatus,
  ScientSourcesReadingStateResult,
  ScientSourcesScope,
} from "@t3tools/contracts";
import { msg } from "gt-react";

import { m, type MessageResolver } from "~/i18n/messages";

/**
 * Words the panel shows only on a personal Library. A source is "in this project", never pinned:
 * `libraryLabels.test.ts` keeps "pin" out of every one of them.
 */
export const LIBRARY_LABELS = {
  scopes: { project: msg("This project"), library: msg("My Library") } satisfies Record<
    ScientSourcesScope,
    string
  >,
  inThisProject: msg("In this project"),
  notInThisLibrary: msg("Not in this Library"),
  addToProject: msg("Add to project"),
  removeFromProject: msg("Remove from this project"),
  projectNote: msg("Note for this project"),
  myNote: msg("My note"),
  myNoteHelp: msg("Follows this paper into every project. It is not saved in any project folder."),
  unread: msg("Unread", { $context: "reading status of a source" }),
  starred: msg("Starred", { $context: "a source marked with a star" }),
  markRead: msg("Mark read"),
  markUnread: msg("Mark unread"),
  star: msg("Star", { $context: "verb, marks a source with a star" }),
  removeStar: msg("Remove star"),
  readingMenu: msg("Mark", { $context: "menu that marks sources read or unread" }),
  citedAs: msg("Cited as"),
  alsoCitedAs: msg("Also cited as"),
  noteForKey: msg("Note for"),
  addFailed: msg("Not added to this project"),
  removeFailed: msg("Not removed from this project"),
  readingFailed: msg("Reading status was not changed"),
  stayInLibrary: msg("They stay in your Library."),
  staysInLibrary: msg("It stays in your Library."),
  removeSnapshot: msg("Remove a source this Library does not have?"),
  removeSnapshotHelp: msg(
    "This computer's Library does not have it: it is only kept for this project. Removing it cannot be undone here, and it cannot be added back from this computer.",
  ),
  libraryCopy: msg("Library copy"),
  linkToCopy: msg("Link to this Library copy"),
  keepSeparate: msg("Keep separate"),
  askAgain: msg("Ask again"),
  keptSeparate: msg("You kept this separate from the Library copies below."),
  linked: msg("Linked to the Library copy"),
  linkedHelp: msg("Its citation key, project note and reviews stay as they were."),
  unlinked: msg("Link undone"),
  linkFailed: msg("Not linked"),
  separateFailed: msg("Not changed"),
  keptSeparateToast: msg("Kept separate"),
} as const;

const COPY_PROBLEM_WORDS: Readonly<Record<ScientSourceIdentityProblem, string>> = {
  "merge-undone": msg("A merge of the two was undone."),
  "merge-record-unreadable": msg("The details of an earlier merge could not be read."),
  "title-missing": msg("One of them has no title."),
  "titles-differ": msg("The titles differ."),
  "type-unknown": msg("The type of one is unknown."),
  "preprint-and-published": msg("One is a preprint and the other is not."),
  "types-differ": msg("The types differ."),
  "arxiv-versions-differ": msg("They name different arXiv versions."),
  "identifiers-conflict": msg("Other identifiers differ."),
};

/** Why this project's source uses its own details although the Library has similar ones. */
export function libraryCopyLabel(
  match: {
    readonly reason: "contradicted" | "ambiguous";
    readonly candidates: ReadonlyArray<unknown>;
  },
  resolve: MessageResolver = m,
): string {
  if (match.reason === "ambiguous") {
    return resolve(
      msg(
        "Your Library has several copies that match, so this project's own details are used until you choose one.",
      ),
    );
  }
  return match.candidates.length === 1
    ? resolve(
        msg(
          "Your Library has a similar copy, but it differs from what this project recorded, so this project's own details are used.",
        ),
      )
    : resolve(
        msg(
          "Your Library has similar copies, but they differ from what this project recorded, so this project's own details are used.",
        ),
      );
}

export function libraryCopyProblemLabel(
  problem: ScientSourceIdentityProblem | undefined,
  resolve: MessageResolver = m,
): string {
  return problem
    ? resolve(COPY_PROBLEM_WORDS[problem])
    : resolve(msg("It matches this project's details."));
}

/**
 * The empty list's title and how to fill it. `listed` is absent on a server without a personal
 * Library. When My Library has sources, the panel adds Choose from Library itself.
 */
export function emptySourcesLabel(
  listed: ScientSourcesScope | undefined,
  resolve: MessageResolver = m,
): {
  readonly title: string;
  readonly description: string;
} {
  if (listed === "library") {
    return {
      title: resolve(msg("No sources in My Library")),
      description: resolve(
        msg("Import PDFs, a reference file or sources from Zotero to build your Library."),
      ),
    };
  }
  return {
    title:
      listed === "project"
        ? resolve(msg("No sources in this project"))
        : resolve(msg("No sources yet")),
    description: resolve(
      msg("Import PDFs, a reference file or sources from Zotero to add them to this project."),
    ),
  };
}

/** Under the panel's title when the Library shown is another computer's, named as the app names it. */
export function libraryElsewhereLabel(computer: string, resolve: MessageResolver = m): string {
  return resolve(msg("On {computer}", { computer, $context: "the computer a Library is on" }));
}

/** An import or add started from My Library brings sources into the Library only. */
export function inLibraryNotProjectLabel(count: number, resolve: MessageResolver = m): string {
  return count === 1
    ? resolve(msg("It is in your Library, not in this project."))
    : resolve(msg("They are in your Library, not in this project."));
}

export function addedToProjectLabel(count: number, resolve: MessageResolver = m): string {
  return resolve(
    msg(
      "{count, plural, one {Added {count} source to this project} other {Added {count} sources to this project}}",
      { count },
    ),
  );
}

export function removedFromProjectLabel(count: number, resolve: MessageResolver = m): string {
  return resolve(
    msg(
      "{count, plural, one {Removed {count} source from this project} other {Removed {count} sources from this project}}",
      { count },
    ),
  );
}

export function removeSnapshotsLabel(count: number, resolve: MessageResolver = m): string {
  return count === 1
    ? resolve(LIBRARY_LABELS.removeSnapshot)
    : resolve(msg("Remove {count} sources this Library does not have?", { count }));
}

export function removeSnapshotsHelp(count: number, resolve: MessageResolver = m): string {
  return count === 1
    ? resolve(LIBRARY_LABELS.removeSnapshotHelp)
    : resolve(
        msg(
          "This computer's Library does not have them: they are only kept for this project. Removing them cannot be undone here, and they cannot be added back from this computer.",
        ),
      );
}

/** Toast line when removed sources were only kept for this project; any others stay in the Library. */
export function goneFromComputerLabel(count: number, resolve: MessageResolver = m): string {
  return count === 1
    ? resolve(msg("It is gone from this computer: this Library does not have it."))
    : resolve(
        msg("{count} of them are gone from this computer: this Library does not have them.", {
          count,
        }),
      );
}

/** After a move to Trash: other projects keep the source as their saved citation details. */
export function alsoInOtherProjectsLabel(
  projects: number | undefined,
  resolve: MessageResolver = m,
): string | null {
  if (!projects) return null;
  return resolve(
    msg(
      "{count, plural, =1 {Also in 1 other project, which keeps its citation details.} other {Also in {count} other projects, which keep its citation details.}}",
      { count: projects },
    ),
  );
}

/** Before deleting for good: the projects that keep citing the sources from their own copy. */
export function stillCitedInLabel(
  projects: ReadonlyArray<string>,
  resolve: MessageResolver = m,
): string | null {
  if (projects.length === 0) return null;
  const names = new Intl.ListFormat("en", { type: "conjunction" }).format(projects);
  return projects.length === 1
    ? resolve(
        msg("Still cited in {names}: it keeps the citation details from its own copy.", { names }),
      )
    : resolve(
        msg("Still cited in {names}: they keep the citation details from their own copies.", {
          names,
        }),
      );
}

export function someAlsoInOtherProjectsLabel(
  sourceCount: number,
  resolve: MessageResolver = m,
): string {
  return resolve(
    msg(
      "{count, plural, =1 {1 of them is also in other projects, which keep its citation details.} other {{count} of them are also in other projects, which keep their citation details.}}",
      { count: sourceCount },
    ),
  );
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
        ? m(
            msg("{count, plural, one {Starred {count} source} other {Starred {count} sources}}", {
              count: changed,
            }),
          )
        : m(
            msg(
              "{count, plural, one {Removed the star from {count} source} other {Removed the star from {count} sources}}",
              { count: changed },
            ),
          )
      : change.readingStatus === "read"
        ? m(
            msg(
              "{count, plural, one {Marked {count} source read} other {Marked {count} sources read}}",
              { count: changed },
            ),
          )
        : m(
            msg(
              "{count, plural, one {Marked {count} source unread} other {Marked {count} sources unread}}",
              { count: changed },
            ),
          );
  return {
    title,
    ...(missing > 0
      ? {
          description: m(
            msg(
              "{count, plural, =1 {1 source is no longer in the Library.} other {{count} sources are no longer in the Library.}}",
              { count: missing },
            ),
          ),
        }
      : {}),
  };
}
