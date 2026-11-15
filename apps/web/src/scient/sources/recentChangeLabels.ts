import type { ScientSourcesRecentChange } from "@t3tools/contracts";

import { mergeStateLabel } from "./libraryDuplicateLabels";

export const RECENT_CHANGES_LABELS = {
  menuItem: "Recent changes",
  title: "Recent changes",
  // Said always: the list is what can be taken back, not everything that happened.
  coverage:
    "Changes to your whole Library that are still on record: bulk edits (the latest 250 requests), merges, imports and the Trash. Edits to one paper are in that paper's History. Reading status and removals from a project are not recorded.",
  none: "No recorded changes yet.",
  loading: "Reading changes…",
  loadFailed: "The changes could not be read. Close and open this again to retry.",
  undo: "Undo",
  restore: "Restore",
  showSources: "Show sources",
  showOlder: "Show older changes",
  undone: "Undone",
  importedSources: "Sources from this import",
} as const;

const sources = (count: number) => (count === 1 ? "1 source" : `${count.toLocaleString()} sources`);
const quoted = (title: string | null) => `“${title?.trim() || "Untitled source"}”`;

const INTAKE_WORDS: Record<
  Extract<ScientSourcesRecentChange, { kind: "import" }>["intake"],
  string
> = {
  zotero: "Zotero",
  "local-pdf": "PDF files",
  identifier: "identifiers",
  file: "a reference file",
};

/** Who made the change, as the record says; an automatic merge keeps the name of who ran it. */
export function recentChangeBy(change: ScientSourcesRecentChange): string {
  const who = change.by === "agent" ? "Agent" : "You";
  return change.kind === "merge" && change.automatic ? `${who} · automatic merge` : who;
}

function bulkEditSentence(change: Extract<ScientSourcesRecentChange, { kind: "bulk-edit" }>) {
  const tags = (verb: string, names: ReadonlyArray<string>) =>
    names.length === 0
      ? []
      : [names.length === 1 ? `${verb} the tag ${names[0]}` : `${verb} ${names.length} tags`];
  const collection = (name: string | null) =>
    name ? `the collection ${name}` : "a deleted collection";
  const parts = [
    ...tags("added", change.tagsAdded),
    ...tags("removed", change.tagsRemoved),
    ...(change.typeChanged > 0 ? ["changed the type"] : []),
    ...change.collections.flatMap((entry) => [
      ...(entry.added > 0 ? [`added to ${collection(entry.name)}`] : []),
      ...(entry.removed > 0 ? [`removed from ${collection(entry.name)}`] : []),
    ]),
  ];
  const what = parts.length > 0 ? parts.join(", ") : "edited";
  return `${what[0]!.toUpperCase()}${what.slice(1)}: ${sources(change.sourceCount)}`;
}

/** One sentence for the change. */
export function recentChangeSentence(change: ScientSourcesRecentChange): string {
  switch (change.kind) {
    case "bulk-edit":
      return bulkEditSentence(change);
    case "merge":
      return `Merged ${quoted(change.mergedTitle)} into ${quoted(change.keptTitle)}`;
    case "import": {
      const here = change.available;
      return [
        `${change.outcome === "cancelled" ? "Import stopped: imported" : "Imported"} ${sources(change.imported)} from ${INTAKE_WORDS[change.intake]}`,
        ...(change.failed > 0 ? [`${change.failed.toLocaleString()} failed`] : []),
        // Merged or removed since: the count a person sees after Show would otherwise look wrong.
        ...(here < change.imported ? [`${here.toLocaleString()} in the Library now`] : []),
      ].join(" · ");
    }
    case "trash":
      return `Moved ${quoted(change.title)} to the Trash`;
  }
}

/** What stands instead of an action, when the change has none to offer now. */
export function recentChangeState(change: ScientSourcesRecentChange): string | null {
  switch (change.kind) {
    case "bulk-edit":
      if (!change.undone) return null;
      return change.left > 0
        ? `Undone; ${change.left.toLocaleString()} changed since and ${change.left === 1 ? "was" : "were"} left`
        : RECENT_CHANGES_LABELS.undone;
    case "merge":
      return mergeStateLabel(change.undo);
    // An import or a Trash entry always has its action.
    case "import":
    case "trash":
      return null;
  }
}
