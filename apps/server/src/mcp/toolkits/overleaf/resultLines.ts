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

/** One line per warning; renames and older versions are grouped. */
const warningLines = (
  warnings: ReadonlyArray<ScientOverleafWarning>,
  tense: "done" | "would",
): string[] => {
  const lines: string[] = [];
  const renames = warnings.filter((warning) => warning.kind === "rename");
  if (renames.length > 0)
    lines.push(
      `${tense === "done" ? "Renamed" : "Would rename"} ${named(renames.map((warning) => `${warning.from} → ${warning.to}`))}. Overleaf drops comments and tracked changes on renamed files.`,
    );
  const older = warnings.filter((warning) => warning.kind === "restores-older-version");
  if (older.length > 0)
    lines.push(
      `${tense === "done" ? "Sent" : "Would send"} older versions of ${plural(older.length, "file")} (${named(older.map((warning) => warning.path ?? ""))}), for example after switching to an older branch or restoring a checkpoint. Collaborators' newer text in them is replaced.`,
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
        "Nothing was sent: the folder changed after Overleaf's changes came in. Sync again; the new edit goes with the next sync.",
      ];
    case "not-sent":
      return ["Nothing was sent: the Overleaf token changed during the sync. Sync again."];
    case "out-of-date":
      return ["Overleaf changed again while sending, so nothing was sent. Sync again."];
    case "unknown":
      return [
        `Send #${publication.attemptNumber} got no answer from Overleaf. Scient never sends it again; the next sync or a recover checks whether it arrived.`,
      ];
  }
};

/** Why a review could not be built (pr-c-design.md section 4.4). */
const refusalLine = (refusal: ScientOverleafRefusal): string => {
  const at = refusal.path === undefined ? "" : ` (${refusal.path})`;
  switch (refusal.reason) {
    case "remote-file-limit":
    case "candidate-file-limit":
      return "Nothing changed: more than 2,000 files to sync. Choose a narrower folder.";
    case "remote-too-large":
    case "candidate-too-large":
      return "Nothing changed: more than 250 MiB to sync. Choose a narrower folder.";
    case "remote-file-too-large":
    case "candidate-file-too-large":
      return `Nothing changed: a file is over 50,000,000 bytes, which Overleaf refuses${at}.`;
    case "remote-forbidden":
      return `Nothing changed: Overleaf has content Scient will not write (a link, Git LFS pointer, repository or reserved name)${at}.`;
    case "path-alias":
    case "alias-rename":
      return "Nothing changed: two names differ only by letter case or Unicode spelling, which this Mac or Overleaf cannot hold apart. Rename one of them.";
    case "unreviewed-path":
    case "remote-collides-with-excluded":
      return `Nothing changed: Overleaf has a file where this folder has something that is not synced${at}. Move or rename it here or on Overleaf.`;
    case "local-only-limit":
      return "Nothing changed: too many files are kept only on this computer. Choose a narrower folder.";
    case "folder-unavailable":
      return "Nothing changed: the linked folder is missing or is not a folder. Relink it if it moved.";
    case "walk-limit":
      return "Nothing changed: the folder has more than 5,000 entries. Choose a narrower folder.";
    case "managed-limit":
      return "Nothing changed: more than 2,000 files to sync. Choose a narrower folder.";
    case "total-too-large":
      return "Nothing changed: more than 250 MiB to sync. Choose a narrower folder.";
    case "file-too-large":
      return `Nothing changed: a synced file is over 50,000,000 bytes${at}.`;
    case "unstable":
      return `Nothing changed: a file changed while it was read${at}. Sync again.`;
    case "unreadable":
    case "not-a-file":
      return `Nothing changed: a synced file could not be read as a file${at}.`;
    case "lfs-pointer":
      return `Nothing changed: a Git LFS pointer cannot be synced${at}.`;
    case "alias":
      return `Nothing changed: a synced file is on disk under a name that differs only by letter case or Unicode spelling${at}. Rename it back.`;
    default:
      return `Nothing changed: the sync was refused (${refusal.reason})${at}.`;
  }
};

/** A sync's result lines, in the order a person reads them. */
export const syncLines = (result: ScientOverleafSyncResult): string[] => {
  switch (result._tag) {
    case "synced": {
      const lines: string[] = [];
      const incoming = result.review.incoming;
      if (incoming.length > 0)
        lines.push(
          `${plural(incoming.length, "file")} came in from Overleaf: ${named(incoming.map(changeText))}.`,
        );
      lines.push(...publicationLines(result.publication, result.review, result.markerPaths));
      if (lines.length === 0) lines.push("Up to date: nothing came in and nothing needed sending.");
      if (result.retried) lines.push("Overleaf changed while sending, so one new sync ran.");
      lines.push(...fileLines(result.review));
      lines.push(...warningLines(result.review.warnings, "done"));
      if (result.interrupted > 0)
        lines.push(
          `${plural(result.interrupted, "file group")} an interrupted earlier sync left half done ${result.interrupted === 1 ? "was" : "were"} settled.`,
        );
      if (result.publication._tag !== "blocked" || result.publication.reason !== "markers") {
        const marked = [...new Set([...result.markerPaths, ...result.review.unresolvedMarkers])];
        if (marked.length > 0) lines.push(markerLine(marked));
      }
      lines.push(...activityLines(result.activity));
      return lines;
    }
    case "needs-decision":
      return [
        "Nothing was applied or sent.",
        ...conflictLines(result.review),
        ...activityLines(result.activity),
      ];
    case "refused":
      return [refusalLine(result.refusal)];
    case "duplicate":
      return ["This request already ran; nothing ran again."];
    case "unsettled":
      return [
        result.reason === "folder-kept-changing"
          ? "The folder kept changing while the sync read it, so nothing more was done. Sync again when the edits settle."
          : "The sync could not settle on one review, so nothing more was done. Sync again.",
      ];
    case "cancelled":
      return [
        result.stage === "before-prepare"
          ? "The sync stopped on request before reading the folder again; nothing more was applied or sent."
          : "The sync stopped on request before applying; nothing more was applied or sent.",
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
      return reviewLines(preview.review);
    case "refused":
      return [refusalLine(preview.refusal)];
    case "recovered":
      return [
        "An interrupted earlier sync was finished. Preview again to see what a sync would do.",
      ];
  }
};

export const connectionLine = (
  connection: ScientOverleafConnectionSummary & {
    readonly linkedHere?: boolean;
  },
) =>
  `${connection.folder === "" ? "The project's top folder" : `${connection.folder}/`} is linked to Overleaf project ${connection.projectId} (connectionId ${connection.connectionId}${connection.state === "archived" ? ", disconnected" : ""}; ${plural(connection.completedSyncCount, "completed sync")})${connection.linkedHere === false ? `, in the copy at ${connection.checkoutRoot}` : ""}.`;

const REASON_TEXT: Record<string, string> = {
  "apply-pending": "an interrupted sync will be finished by the next sync or a recover",
  "interrupted-files": "files an interrupted sync left half done are a conflict to settle",
  "conflict-marks": "files have conflict marks to merge",
  staging: "folders an interrupted change left in place; the next sync finishes it",
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
