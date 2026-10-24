/**
 * The sentences an Overleaf result says (pr-c-design.md section 4.1), from the
 * same views the app reads. Never Git's text, a commit or the token: only
 * counts, manuscript paths and fixed categories.
 */
import type {
  ScientOverleafChange,
  ScientOverleafConnectionSummary,
  ScientOverleafPreviewResult,
  ScientOverleafPublication,
  ScientOverleafRefusal,
  ScientOverleafReview,
  ScientOverleafStatus,
  ScientOverleafSyncResult,
  ScientOverleafWarning,
} from "@t3tools/contracts";

/** Paths named in one sentence; the structured fields carry the rest. */
const NAMED_PATHS = 12;

const plural = (count: number, one: string, many = `${one}s`) =>
  `${count} ${count === 1 ? one : many}`;

const named = (paths: ReadonlyArray<string>) =>
  paths.length <= NAMED_PATHS
    ? paths.join(", ")
    : `${paths.slice(0, NAMED_PATHS).join(", ")} and ${paths.length - NAMED_PATHS} more`;

const changeText = (change: ScientOverleafChange) => {
  switch (change.kind) {
    case "added":
      return `${change.path} (new)`;
    case "deleted":
      return `${change.path} (deleted)`;
    case "modified":
      return change.path;
    case "renamed":
      return `${change.from} → ${change.to}`;
  }
};

const megabytes = (bytes: number | undefined) =>
  bytes === undefined ? "" : ` (${(bytes / 1_000_000).toFixed(1)} MB)`;

/** The link's copy, when the caller works in another one. */
export const linkedElsewhereLine = (checkoutRoot: string) =>
  `This link belongs to the copy of the project at ${checkoutRoot}, not this worktree, so that copy was used. Your edits in this worktree are not in it until they are merged there.`;

/**
 * How far a review's send went: `sent` only when Overleaf accepted it, `maybe`
 * when the send got no answer, `unsent` when nothing went, `would` for a preview.
 */
type SendTense = "would" | "sent" | "maybe" | "unsent";

const RENAME_VERB: Record<SendTense, string | null> = {
  would: "Would rename",
  sent: "Renamed",
  maybe: "May have renamed",
  unsent: null,
};
const OLDER_VERB: Record<SendTense, string | null> = {
  would: "Would send",
  sent: "Sent",
  maybe: "May have sent",
  unsent: null,
};

/**
 * One line per warning; renames and older versions are grouped, and said as done
 * only when the send was accepted. When nothing was sent the publication line says
 * so, and the next sync reports them again.
 */
const warningLines = (
  warnings: ReadonlyArray<ScientOverleafWarning>,
  tense: SendTense,
): string[] => {
  const lines: string[] = [];
  const renames = warnings.filter((warning) => warning.kind === "rename");
  const renameVerb = RENAME_VERB[tense];
  if (renames.length > 0 && renameVerb !== null)
    lines.push(
      `${renameVerb} ${named(renames.map((warning) => `${warning.from} → ${warning.to}`))} on Overleaf. Overleaf drops comments and tracked changes on renamed files.`,
    );
  const older = warnings.filter((warning) => warning.kind === "restores-older-version");
  const olderVerb = OLDER_VERB[tense];
  if (older.length > 0 && olderVerb !== null)
    lines.push(
      `${olderVerb} older versions of ${plural(older.length, "file")} (${named(older.map((warning) => warning.path ?? ""))}), for example after switching to an older branch or restoring a checkpoint. Collaborators' newer text in them ${tense === "would" ? "would be" : tense === "maybe" ? "may have been" : "was"} replaced.`,
    );
  for (const warning of warnings)
    switch (warning.kind) {
      case "first-sync":
        lines.push("This is the link's first sync.");
        break;
      case "no-sync-history":
        lines.push(
          "This link has no sync history yet, so files on only one side are added to the other; nothing is deleted.",
        );
        break;
      case "over-recommended-size":
        lines.push(`The project is bigger than Overleaf recommends${megabytes(warning.bytes)}.`);
        break;
      case "too-large-to-edit":
        lines.push(`${warning.path} is too big to edit in Overleaf${megabytes(warning.bytes)}.`);
        break;
      case "editable-total-exceeded":
        lines.push(
          `The editable files together are more than Overleaf can edit${megabytes(warning.bytes)}.`,
        );
        break;
      case "unresolved-publication":
        lines.push(
          `An earlier send (#${warning.attemptNumber}) never got an answer. Scient checks Overleaf for it and never sends it again; until that is known, this sync may carry some of the same changes again.`,
        );
        break;
    }
  return lines;
};

const conflictLines = (review: ScientOverleafReview): string[] => {
  const open = review.conflicts.filter((conflict) => conflict.chosen === null);
  if (open.length === 0) return [];
  return [
    `${plural(open.length, "conflict")} to settle. Call again with one choice per key and reviewedRemote ${review.remoteTree}:`,
    ...open.map(
      (conflict) =>
        `- key ${conflict.key}: ${named(conflict.paths)}; allowed: ${conflict.allowed.join(", ")}`,
    ),
  ];
};

const SKIP_TEXT: Record<string, string> = {
  "build-output": "build output",
  hidden: "hidden",
  "scient-project-file": "Scient's own file",
};

/** New files the rule leaves out, files kept only here, and how to send them (design section 5). */
const fileLines = (review: ScientOverleafReview): string[] => {
  const lines: string[] = [];
  const skipped = review.additions.filter(
    (addition) => !addition.selected && addition.skippedBecause !== null,
  );
  const tooLarge = skipped.filter((addition) => addition.skippedBecause === "too-large");
  const sendable = skipped.filter((addition) => addition.skippedBecause !== "too-large");
  if (sendable.length > 0)
    lines.push(
      `New files not sent by the rule: ${named(sendable.map((addition) => `${addition.path} (${SKIP_TEXT[addition.skippedBecause!] ?? addition.skippedBecause})`))}. Send one with files.send.`,
    );
  if (tooLarge.length > 0)
    lines.push(
      `New files over Overleaf's 50 MB limit stay only on this computer: ${named(tooLarge.map((addition) => addition.path))}.`,
    );
  if (review.localOnly.length > 0)
    lines.push(`Kept only on this computer: ${named(review.localOnly)}. Send one with files.send.`);
  return lines;
};

const markerLine = (paths: ReadonlyArray<string>) =>
  `${plural(paths.length, "file")} still ${paths.length === 1 ? "has" : "have"} conflict marks: ${named(paths)}. Merge each marked block, remove every mark, then sync again; a file with marks is not sent.`;

/** What a review would do: the preview's lines. */
const reviewLines = (review: ScientOverleafReview): string[] => {
  if (review.upToDate && review.conflicts.length === 0)
    return ["Up to date: nothing would come in or be sent.", ...fileLines(review)];
  const lines: string[] = [];
  lines.push(
    review.incoming.length === 0
      ? "Nothing would come in from Overleaf."
      : `Would bring in ${plural(review.incoming.length, "file")}: ${named(review.incoming.map(changeText))}.`,
  );
  lines.push(
    review.outgoing.length === 0
      ? "Nothing would be sent to Overleaf."
      : `Would send ${plural(review.outgoing.length, "file")}: ${named(review.outgoing.map(changeText))}.`,
  );
  lines.push(...conflictLines(review));
  lines.push(...fileLines(review));
  lines.push(...warningLines(review.warnings, "would"));
  if (review.unresolvedMarkers.length > 0) lines.push(markerLine(review.unresolvedMarkers));
  return lines;
};

const publicationLines = (
  publication: ScientOverleafPublication,
  review: ScientOverleafReview,
  markerPaths: ReadonlyArray<string>,
): string[] => {
  switch (publication._tag) {
    case "none":
      return [];
    case "accepted":
      return [
        `Sent ${plural(review.outgoing.length, "file")} to Overleaf (send #${publication.attemptNumber}): ${named(review.outgoing.map(changeText))}.`,
      ];
    case "blocked":
      switch (publication.reason) {
        case "markers":
          return [
            `Nothing was sent: ${markerLine([...new Set([...markerPaths, ...review.unresolvedMarkers])])}`,
          ];
        case "kept-copy-changed":
          return [
            "Nothing was sent: a program wrote into a file this sync replaced. The next sync checks again.",
          ];
        case "staging":
        case "attention":
          return [
            "Nothing was sent: part of the folder needs attention first. Call scient_overleaf_status, then sync again.",
          ];
      }
      return [];
    case "not-verified":
      return [
        "Nothing was sent: the folder changed after the apply. Sync again; the new edit goes with the next sync.",
      ];
    case "not-sent":
      return [
        "Nothing was sent: the folder, the project's workspace or the Overleaf token changed before sending. Sync again.",
      ];
    case "out-of-date":
      return ["Overleaf changed again while sending, so nothing was sent. Sync again."];
    case "unknown":
      return [
        `Send #${publication.attemptNumber} got no answer from Overleaf, so it may or may not have arrived. Scient never sends it again; the next sync or a recover checks whether it arrived.`,
      ];
  }
};

/**
 * Why a review could not be built (pr-c-design.md section 4.4): a clause about that
 * review only. The caller says whose review it was; nothing here describes what an
 * earlier attempt of the same sync did.
 */
const refusalReason = (refusal: ScientOverleafRefusal): string => {
  const at = refusal.path === undefined ? "" : ` (${refusal.path})`;
  switch (refusal.reason) {
    case "remote-file-limit":
    case "candidate-file-limit":
      return "more than 2,000 files to sync. Choose a narrower folder.";
    case "remote-too-large":
    case "candidate-too-large":
      return "more than 250 MiB to sync. Choose a narrower folder.";
    case "remote-file-too-large":
    case "candidate-file-too-large":
      return `a file is over 50,000,000 bytes, which Overleaf refuses${at}.`;
    case "remote-forbidden":
      return `Overleaf has content Scient will not write (a link, Git LFS pointer, repository or reserved name)${at}.`;
    case "path-alias":
    case "alias-rename":
      return "two names differ only by letter case or Unicode spelling, which this Mac or Overleaf cannot hold apart. Rename one of them.";
    case "unreviewed-path":
    case "remote-collides-with-excluded":
      return `Overleaf has a file where this folder has something that is not synced${at}. Move or rename it here or on Overleaf.`;
    case "local-only-limit":
      return "too many files are kept only on this computer. Choose a narrower folder.";
    case "folder-unavailable":
      return "the linked folder is missing or is not a folder. Relink it if it moved.";
    case "walk-limit":
      return "the folder has more than 5,000 entries. Choose a narrower folder.";
    case "managed-limit":
      return "more than 2,000 files to sync. Choose a narrower folder.";
    case "total-too-large":
      return "more than 250 MiB to sync. Choose a narrower folder.";
    case "file-too-large":
      return `a synced file is over 50,000,000 bytes${at}.`;
    case "unstable":
      return `a file changed while it was read${at}. Sync again.`;
    case "unreadable":
    case "not-a-file":
      return `a synced file could not be read as a file${at}.`;
    case "lfs-pointer":
      return `a Git LFS pointer cannot be synced${at}.`;
    case "alias":
      return `a synced file is on disk under a name that differs only by letter case or Unicode spelling${at}. Rename it back.`;
    default:
      return `the review was refused (${refusal.reason})${at}.`;
  }
};

/** An interrupted earlier sync an operation finished first, as the result reports it. */
type Settled = {
  readonly outcome: string;
  readonly interrupted: number;
  readonly markerPaths: ReadonlyArray<string>;
};

/**
 * How finishing an interrupted sync ended, from its own apply outcome: only
 * `complete` puts what it was applying into the folder, and `replan` wrote nothing.
 * `first` when it ran before the operation's own work.
 */
const settledLine = (settled: Settled, first: boolean): string => {
  const sentence = (verb: string, rest: string) =>
    first ? `First ${verb} ${rest}` : `${verb.charAt(0).toUpperCase()}${verb.slice(1)} ${rest}`;
  switch (settled.outcome) {
    case "complete":
      return sentence(
        "finished",
        "an interrupted sync: what it was applying is now in the folder.",
      );
    case "replan":
      return sentence(
        "recovered",
        first
          ? "an interrupted sync without writing anything."
          : "an interrupted sync without writing anything; a fresh review is needed. Sync again.",
      );
    default:
      return sentence(
        "settled",
        `an interrupted sync, but part of the folder needs attention: ${[
          ...(settled.interrupted > 0
            ? [
                `applying stopped partway in ${plural(settled.interrupted, "file group")}, which the next sync shows as conflicts to settle`,
              ]
            : []),
          ...(settled.markerPaths.length > 0 ? ["files have conflict marks"] : []),
          ...(settled.interrupted === 0 && settled.markerPaths.length === 0
            ? ["a file or a kept copy changed while it was written"]
            : []),
        ].join("; ")}. Check scient_overleaf_status, then sync again.`,
      );
  }
};

/** What the service reports a sync did before the outcome it ends with. */
const progressLines = (progress: {
  readonly retried: boolean;
  readonly settled: Settled | null;
}): string[] => [
  ...(progress.settled === null ? [] : [settledLine(progress.settled, true)]),
  ...(progress.retried
    ? [
        "The first attempt applied a review to the folder, then Overleaf changed while it was sending, so nothing was sent and the sync ran again; the lines below describe the last attempt.",
      ]
    : []),
];

const sendTense = (publication: ScientOverleafPublication): SendTense =>
  publication._tag === "accepted" ? "sent" : publication._tag === "unknown" ? "maybe" : "unsent";

/**
 * What came in, as far as the apply's outcome establishes it. Only a complete apply
 * proves Overleaf's changes are in the folder; a replanned one wrote nothing (which
 * says neither why nor whether the folder already holds that content); one
 * that needs attention may have stopped partway.
 */
const incomingLines = (result: Extract<ScientOverleafSyncResult, { _tag: "synced" }>): string[] => {
  const incoming = result.review.incoming;
  const changes = `${plural(incoming.length, "file")} (${named(incoming.map(changeText))})`;
  // After a retry these describe the last attempt only; the retry line says so.
  const lead = (body: string) =>
    result.retried ? `In the last attempt, ${body}` : body.charAt(0).toUpperCase() + body.slice(1);
  switch (result.outcome) {
    case "complete":
      return incoming.length === 0
        ? []
        : [
            lead(
              `${plural(incoming.length, "file")} came in from Overleaf: ${named(incoming.map(changeText))}.`,
            ),
          ];
    case "replan":
      return [
        incoming.length === 0
          ? lead(
              "this apply wrote nothing to the folder, and a fresh review is needed. Sync again.",
            )
          : lead(
              `the apply of Overleaf's changes to ${changes} wrote nothing to the folder, and a fresh review is needed. Sync again.`,
            ),
      ];
    default: {
      const reasons = [
        ...(result.interrupted > 0
          ? [
              `applying stopped partway in ${plural(result.interrupted, "file group")}, which the next sync shows as conflicts to settle`,
            ]
          : []),
        ...(result.markerPaths.length > 0 ? ["files have conflict marks"] : []),
        ...(result.interrupted === 0 && result.markerPaths.length === 0
          ? ["a file or a kept copy changed while the changes were written"]
          : []),
      ].join("; ");
      return [
        incoming.length === 0
          ? lead(
              `part of the folder needs attention: ${reasons}. Check scient_overleaf_status before syncing again.`,
            )
          : lead(
              `Overleaf's changes to ${changes} were applied as far as the folder allowed, and part of it needs attention: ${reasons}. Check scient_overleaf_status before syncing again.`,
            ),
      ];
    }
  }
};

/** A sync's result lines, in the order a person reads them. */
export const syncLines = (result: ScientOverleafSyncResult): string[] => {
  switch (result._tag) {
    case "synced": {
      const lines = [
        ...incomingLines(result),
        ...publicationLines(result.publication, result.review, result.markerPaths),
      ];
      if (lines.length === 0)
        lines.push(
          result.retried
            ? "In the last attempt, nothing came in and nothing needed sending."
            : "Up to date: nothing came in and nothing needed sending.",
        );
      lines.push(...fileLines(result.review));
      lines.push(...warningLines(result.review.warnings, sendTense(result.publication)));
      if (result.publication._tag !== "blocked" || result.publication.reason !== "markers") {
        const marked = [...new Set([...result.markerPaths, ...result.review.unresolvedMarkers])];
        if (marked.length > 0) lines.push(markerLine(marked));
      }
      return [...progressLines(result), ...lines, ...activityLines(result.activity)];
    }
    case "needs-decision":
      return [
        ...progressLines(result),
        "Stopped at a conflict before applying this review: none of its changes were applied or sent.",
        ...conflictLines(result.review),
        ...activityLines(result.activity),
      ];
    case "refused":
      return [...progressLines(result), `This sync stopped: ${refusalReason(result.refusal)}`];
    case "duplicate":
      return ["This request already ran; nothing ran again."];
    case "unsettled":
      return [
        ...progressLines(result),
        result.reason === "folder-kept-changing"
          ? "The folder kept changing while the sync read it, so it stopped there. Sync again when the edits settle."
          : "The sync could not settle on one review, so it stopped there. Sync again.",
      ];
    case "cancelled":
      return [
        ...progressLines(result),
        result.stage === "before-prepare"
          ? "The sync stopped on request before reading the folder again."
          : "The sync stopped on request before applying the review it had built.",
      ];
  }
};

const activityLines = (
  activity: ReadonlyArray<{ readonly threadId: string; readonly title: string }> | null,
): string[] =>
  activity === null
    ? ["Scient could not tell whether other agents are working in this copy of the project."]
    : activity.length === 0
      ? []
      : [
          `Other agents are working in this copy of the project: ${named(activity.map((thread) => thread.title || thread.threadId))}.`,
        ];

export const previewLines = (preview: ScientOverleafPreviewResult): string[] => {
  switch (preview._tag) {
    case "review":
      return [
        ...(preview.settled === null ? [] : [settledLine(preview.settled, true)]),
        ...reviewLines(preview.review),
      ];
    case "refused":
      return [
        ...(preview.settled === null ? [] : [settledLine(preview.settled, true)]),
        `A sync can't run now: ${refusalReason(preview.refusal)}`,
      ];
    case "recovered":
      return [
        "An interrupted earlier sync was settled first. Preview again to see what a sync would do; scient_overleaf_status shows the folder now.",
      ];
  }
};

/** An interrupted sync an operation finished before its own work, when its result can't carry it. */
export const firstSettledLine = (settled: Settled): string => settledLine(settled, true);

/** How a recovery ended, from its own apply outcome (null: there was none). */
export const recoveryLines = (settled: Settled | null): string[] => [
  settled === null ? "No interrupted sync to settle." : settledLine(settled, false),
];

export const connectionLine = (
  connection: ScientOverleafConnectionSummary & {
    readonly linkedHere?: boolean;
  },
) =>
  `${connection.folder === "" ? "The project's top folder" : `${connection.folder}/`} is linked to Overleaf project ${connection.projectId} (connectionId ${connection.connectionId}${connection.state === "archived" ? ", disconnected" : ""}; ${plural(connection.completedSyncCount, "completed sync")})${connection.linkedHere === false ? `, in the copy at ${connection.checkoutRoot}` : ""}.`;

const REASON_TEXT: Record<string, string> = {
  "apply-pending": "an interrupted sync is waiting; the next sync or a recover settles it",
  "interrupted-files": "files an interrupted sync left half done are a conflict to settle",
  "conflict-marks": "files have conflict marks to merge",
  staging: "folders an interrupted change left in place; the next sync settles them",
  "folder-changed":
    "the folder moved, its disk is away, or the project's link to this checkout changed; relink it",
  "unresolved-sends": "earlier sends have no answer yet; a sync or recover checks them",
};

export const statusLines = (status: ScientOverleafStatus): string[] => {
  const lines = [connectionLine(status.connection)];
  const reasons = status.reasons.map((reason) => REASON_TEXT[reason] ?? reason);
  switch (status.availability) {
    case "ready":
      lines.push("Ready to sync.");
      break;
    case "disconnected":
      lines.push("Disconnected. Connect the folder again to keep its history.");
      break;
    default:
      lines.push(`Needs attention: ${reasons.join("; ")}.`);
  }
  if (status.local?._tag === "read") {
    const { changed, deleted, added } = status.local;
    lines.push(
      changed + deleted + added === 0
        ? "No edits to send since the last sync."
        : `Edits to send: ${changed} changed, ${deleted} deleted, ${added} new.`,
    );
  } else if (status.local?._tag === "unread")
    lines.push(`The folder could not be read (${status.local.reason}).`);
  if (status.markerPaths.length > 0) lines.push(markerLine(status.markerPaths));
  if (status.keptCopies > 0)
    lines.push(
      `${plural(status.keptCopies, "kept copy", "kept copies")} (scient_overleaf_kept_copies).`,
    );
  if (status.unresolvedSends > 0)
    lines.push(`${plural(status.unresolvedSends, "earlier send")} without an answer yet.`);
  if (status.busy) lines.push("Another Overleaf operation is running for this link right now.");
  if (status.linkedElsewhere) lines.push(linkedElsewhereLine(status.connection.checkoutRoot));
  return lines;
};
