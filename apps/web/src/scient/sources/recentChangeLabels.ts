import type { ScientSourcesRecentChange } from "@t3tools/contracts";
import { msg } from "gt-react";

import { m, type MessageResolver } from "~/i18n/messages";

import { mergeStateLabel } from "./libraryDuplicateLabels";
import { byLine, dayLabel } from "./dayLabel";

export const RECENT_CHANGES_LABELS = {
  menuItem: msg("Recent changes"),
  title: msg("Recent changes"),
  none: msg("No recorded changes yet."),
  loading: msg("Reading changes…"),
  loadFailed: msg("The changes could not be read. Close and open this again."),
  reloadFailed: msg("The list could not be read again, so it may be out of date."),
  tryAgain: msg("Try again"),
  noOlder: msg("Showing the newest 400."),
  undo: msg("Undo", { $context: "verb, button that undoes a change" }),
  restore: msg("Restore", { $context: "verb, button" }),
  showSources: msg("Show sources"),
  showOlder: msg("Show older changes"),
  undone: msg("Undone", { $context: "state of a change that was undone" }),
  restored: msg("No earlier Library is kept"),
  nothingAdded: msg("Nothing was new"),
  addKept: msg("Add its sources"),
  putBack: msg("Put it back"),
  importRest: msg("Import the rest"),
  importedSources: msg("Sources from this import"),
  notBrought: msg("Not brought", { $context: "items not imported" }),
  notBroughtNone: msg("The record of what was not brought is no longer there."),
  showThese: msg("Show", { $context: "verb, shows the sources a line lists" }),
  packageImports: msg("Package imports"),
  openPackageImports: msg("Show package imports"),
} as const;

const count = (value: number) => value.toLocaleString();
const quoted = (title: string | null, resolve: MessageResolver) =>
  resolve(msg("“{title}”", { title: title?.trim() || resolve(msg("Untitled source")) }));

const INTAKE_WORDS: Record<
  Extract<ScientSourcesRecentChange, { kind: "import" }>["intake"],
  string
> = {
  zotero: "Zotero",
  "local-pdf": msg("PDF files"),
  identifier: msg("identifiers"),
  file: msg("a reference file"),
};

/**
 * Who made the change and when: the person's own changes show only the time, an agent's say so,
 * and an automatic merge keeps the word.
 */
export function recentChangeBy(
  change: ScientSourcesRecentChange,
  resolve: MessageResolver = m,
  now = new Date(),
): string {
  const when = byLine(change.by, change.at, resolve, now);
  return change.kind === "merge" && change.automatic
    ? resolve(msg("Automatic merge · {when}", { when }))
    : when;
}

function bulkEditSentence(
  change: Extract<ScientSourcesRecentChange, { kind: "bulk-edit" }>,
  resolve: MessageResolver,
) {
  const collection = (name: string | null) =>
    name ? resolve(msg("the collection {name}", { name })) : resolve(msg("a deleted collection"));
  const parts = [
    ...(change.tagsAdded.length === 0
      ? []
      : [
          change.tagsAdded.length === 1
            ? resolve(msg("added the tag {name}", { name: change.tagsAdded[0]! }))
            : resolve(msg("added {count} tags", { count: change.tagsAdded.length })),
        ]),
    ...(change.tagsRemoved.length === 0
      ? []
      : [
          change.tagsRemoved.length === 1
            ? resolve(msg("removed the tag {name}", { name: change.tagsRemoved[0]! }))
            : resolve(msg("removed {count} tags", { count: change.tagsRemoved.length })),
        ]),
    ...(change.typeChanged > 0 ? [resolve(msg("changed the type"))] : []),
    ...change.collections.flatMap((entry) => [
      ...(entry.added > 0
        ? [resolve(msg("added to {collection}", { collection: collection(entry.name) }))]
        : []),
      ...(entry.removed > 0
        ? [resolve(msg("removed from {collection}", { collection: collection(entry.name) }))]
        : []),
    ]),
  ];
  const what =
    parts.length > 0
      ? parts.join(", ")
      : resolve(msg("edited", { $context: "what a bulk edit did to sources" }));
  const sentence = resolve(
    msg("{what}: {count, plural, one {{shown} source} other {{shown} sources}}", {
      what: `${what[0]!.toUpperCase()}${what.slice(1)}`,
      count: change.sourceCount,
      shown: count(change.sourceCount),
    }),
  );
  // Only the latest 250 requests are kept, so an old, large edit can have lost its first ones.
  return change.partsMissing
    ? resolve(
        msg("{sentence} (the rest of a larger edit; its earlier part is no longer on record)", {
          sentence,
        }),
      )
    : sentence;
}

/** One sentence for the change. */
export function recentChangeSentence(
  change: ScientSourcesRecentChange,
  resolve: MessageResolver = m,
): string {
  switch (change.kind) {
    case "bulk-edit":
      return bulkEditSentence(change, resolve);
    case "merge":
      return resolve(
        msg("Merged {merged} into {kept}", {
          merged: quoted(change.mergedTitle, resolve),
          kept: quoted(change.keptTitle, resolve),
        }),
      );
    case "import": {
      const here = change.available;
      const from = resolve(INTAKE_WORDS[change.intake]);
      return [
        change.outcome === "cancelled"
          ? resolve(
              msg(
                "{count, plural, one {Import stopped: imported {shown} source from {from}} other {Import stopped: imported {shown} sources from {from}}}",
                { count: change.imported, shown: count(change.imported), from },
              ),
            )
          : resolve(
              msg(
                "{count, plural, one {Imported {shown} source from {from}} other {Imported {shown} sources from {from}}}",
                { count: change.imported, shown: count(change.imported), from },
              ),
            ),
        ...(change.failed > 0
          ? [resolve(msg("{count} failed", { count: count(change.failed) }))]
          : []),
        ...(change.remaining
          ? [resolve(msg("{count} still to import", { count: count(change.remaining) }))]
          : []),
        // Merged or removed since: the count a person sees after Show would otherwise look wrong.
        ...(here < change.imported
          ? [resolve(msg("{count} in the Library now", { count: count(here) }))]
          : []),
      ].join(" · ");
    }
    case "trash":
      return resolve(msg("Moved {title} to the Trash", { title: quoted(change.title, resolve) }));
    case "restore":
      return change.putBack
        ? resolve(
            msg(
              "{count, plural, one {Put back the Library that was replaced on {day}: {shown} source} other {Put back the Library that was replaced on {day}: {shown} sources}}",
              {
                day: dayLabel(change.backupCreatedAt),
                count: change.sources,
                shown: count(change.sources),
              },
            ),
          )
        : resolve(
            msg(
              "{count, plural, one {Restored the Library from the backup of {day}: {shown} source} other {Restored the Library from the backup of {day}: {shown} sources}}",
              {
                day: dayLabel(change.backupCreatedAt),
                count: change.sources,
                shown: count(change.sources),
              },
            ),
          );
    case "join": {
      const from =
        change.from === "backup" && change.backupCreatedAt
          ? resolve(msg("the backup of {day}", { day: dayLabel(change.backupCreatedAt) }))
          : change.from === "backup"
            ? resolve(msg("a backup"))
            : resolve(msg("the Library a restore replaced"));
      return [
        change.state === "stopped"
          ? resolve(
              msg(
                "{count, plural, one {Stopped part way: added {shown} source from {from}} other {Stopped part way: added {shown} sources from {from}}}",
                { count: change.added, shown: count(change.added), from },
              ),
            )
          : resolve(
              msg(
                "{count, plural, one {Added {shown} source from {from}} other {Added {shown} sources from {from}}}",
                { count: change.added, shown: count(change.added), from },
              ),
            ),
        ...(change.different > 0
          ? [
              resolve(
                msg("{count} that both hold left as here", { count: count(change.different) }),
              ),
            ]
          : []),
        ...(change.removedHere > 0
          ? [
              resolve(
                msg("{count} removed here not brought back", {
                  count: count(change.removedHere),
                }),
              ),
            ]
          : []),
      ].join(" · ");
    }
  }
}

const undoneLeft = (left: number, resolve: MessageResolver) =>
  resolve(
    msg(
      "{count, plural, one {Undone; {shown} changed since and was left} other {Undone; {shown} changed since and were left}}",
      { count: left, shown: count(left) },
    ),
  );

/** What stands instead of an action, when the change has none to offer now. */
export function recentChangeState(
  change: ScientSourcesRecentChange,
  resolve: MessageResolver = m,
): string | null {
  switch (change.kind) {
    case "bulk-edit":
      if (!change.undone) return null;
      return change.left > 0
        ? undoneLeft(change.left, resolve)
        : resolve(RECENT_CHANGES_LABELS.undone);
    case "merge":
      return mergeStateLabel(change.undo, resolve);
    // An import or a Trash entry always has its action.
    case "import":
    case "trash":
      return null;
    // A restore has no Undo. While the Library it replaced is kept, its sources can be added.
    case "restore":
      return change.kept ? null : resolve(RECENT_CHANGES_LABELS.restored);
    case "join":
      if (change.state !== "undone")
        return change.added > 0 ? null : resolve(RECENT_CHANGES_LABELS.nothingAdded);
      return change.left > 0
        ? undoneLeft(change.left, resolve)
        : resolve(RECENT_CHANGES_LABELS.undone);
  }
}

/** Under a restore's line while the Library it replaced is kept: where that is. */
export function recentChangeDetail(
  change: ScientSourcesRecentChange,
  resolve: MessageResolver = m,
): string | null {
  return change.kind === "restore" && change.kept
    ? resolve(
        msg(
          "{count, plural, one {The Library that was here ({shown} source) is kept in {path}} other {The Library that was here ({shown} sources) is kept in {path}}}",
          { count: change.kept.sources, shown: count(change.kept.sources), path: change.kept.path },
        ),
      )
    : null;
}
