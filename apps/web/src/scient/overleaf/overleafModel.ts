// SCIENT-OWNED: what the Overleaf screens say, decided from the server's fixed
// categories. Pure functions, so every line a person sees is tested here.
import { overleafFilesystemRefusalText, overleafNameProblem } from "@t3tools/contracts";

import type {
  ScientOverleafChange,
  ScientOverleafConnectionSummary,
  ScientOverleafRefusal,
  ScientOverleafReview,
  ScientOverleafStatus,
  ScientOverleafSyncResult,
  ScientOverleafDiffFile,
  ScientOverleafUndoResult,
} from "@t3tools/contracts";

/** Overleaf's own page for a project. */
export function overleafProjectUrl(projectId: string): string {
  return `https://www.overleaf.com/project/${projectId}`;
}

/** Where Overleaf issues Git tokens (Account settings ▸ Git integration). */
export const OVERLEAF_TOKEN_PAGE_URL = "https://www.overleaf.com/user/settings#git-integration";

const PROJECT_ID = /^[0-9a-f]{24}$/u;

/**
 * The project ID in a pasted link or ID, or null. Mirrors the server's rule:
 * an ID of 24 hexadecimal digits, or an `https://(www.)overleaf.com/project/<id>`
 * link. A Git URL (`git.overleaf.com/<id>`) is accepted too, since that is what
 * Overleaf's Git panel shows.
 */
export function parseOverleafProjectInput(input: string): string | null {
  const trimmed = input.trim();
  if (PROJECT_ID.test(trimmed)) return trimmed;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "") return null;
  if (/^(?:www\.)?overleaf\.com$/u.test(url.hostname)) {
    return /^\/project\/([0-9a-f]{24})\/?$/u.exec(url.pathname)?.[1] ?? null;
  }
  if (url.hostname === "git.overleaf.com") {
    return /^\/([0-9a-f]{24})\/?$/u.exec(url.pathname)?.[1] ?? null;
  }
  return null;
}

/** The connection whose folder holds `relativePath`, if any. Folders never nest. */
export function connectionForPath<C extends Pick<ScientOverleafConnectionSummary, "folder">>(
  connections: ReadonlyArray<C>,
  relativePath: string,
): C | null {
  const path = relativePath.replace(/^\/+|\/+$/gu, "");
  for (const connection of connections) {
    const folder = connection.folder.replace(/^\/+|\/+$/gu, "");
    if (folder === "" || path === folder || path.startsWith(`${folder}/`)) return connection;
  }
  return null;
}

/** A path inside the folder, as the file tree and editors name it from the workspace. */
export function workspacePathOf(folder: string, manuscriptPath: string): string {
  const base = folder.replace(/^\/+|\/+$/gu, "");
  return base === "" ? manuscriptPath : `${base}/${manuscriptPath}`;
}

/** The folder a new Overleaf project is brought into: `<parent>/<name>`. */
export function newFolderPath(parent: string, name: string): string {
  const base = parent.replace(/^\/+|\/+$/gu, "");
  const leaf = name;
  return base === "" ? leaf : `${base}/${leaf}`;
}

/** A folder name a person typed: one plain name, no separators or dot names. */
export function folderNameProblem(name: string): string | null {
  const trimmed = name.trim();
  if (trimmed.length === 0) return "Name the folder.";
  if (/[/\\]/u.test(trimmed)) return "Use a name without slashes.";
  if (trimmed === "." || trimmed === ".." || trimmed.startsWith(".")) {
    return "Use a name that doesn't start with a dot.";
  }
  const problem = overleafNameProblem(name);
  if (problem === "component-too-long") return "Use a shorter folder name.";
  if (problem !== null)
    return "Use a name without reserved words, trailing spaces or special characters.";
  return null;
}

/** A folder of the workspace a person picked or typed: empty for its top folder. */
export function workspaceFolderPath(path: string): string {
  return path.trim().replace(/^\/+|\/+$/gu, "");
}

/** Why a picked or typed folder can't be used, or null: it must stay inside the project. */
export function workspaceFolderProblem(path: string): string | null {
  const trimmed = path.trim();
  if (trimmed === "") return null;
  if (trimmed.startsWith("/") || /^[A-Za-z]:[\\/]/u.test(trimmed) || trimmed.includes("\\")) {
    return "Choose a folder inside this project.";
  }
  const parts = workspaceFolderPath(trimmed).split("/");
  if (parts.some((part) => part === "" || part.startsWith("."))) {
    return "Choose a folder inside this project.";
  }
  return null;
}

/**
 * A person's per-file decision: keep a new file only here, send one anyway, or
 * send a file held back for its conflict marks as it is ("Send it anyway").
 */
export type OverleafFileDecision = "keep" | "send" | "release";

export type OverleafChipState = "syncing" | "up-to-date" | "edits" | "decision" | "problem";

export interface OverleafChipView {
  readonly state: OverleafChipState;
  /** The chip's text. */
  readonly label: string;
  /** One line under the menu's title. */
  readonly detail: string;
}

const plural = (count: number, one: string, many: string = `${one}s`) =>
  `${count} ${count === 1 ? one : many}`;

/** The chip next to "Saved", from the offline status. */
export function overleafChipView(
  status: ScientOverleafStatus | null,
  syncing: boolean,
  /** This window's latest sync of the link, dropped when another sync changes it. */
  last: ScientOverleafSyncResult | null = null,
): OverleafChipView {
  if (syncing || status?.busy) {
    return { state: "syncing", label: "Syncing…", detail: "A sync is running." };
  }
  // The status reads only the folder: a sync that stopped at a conflict or was refused
  // says more than the edits waiting, until the next sync.
  if (last?._tag === "needs-decision")
    return {
      state: "decision",
      label: "Needs a decision",
      detail: "A conflict with Overleaf needs a choice.",
    };
  if (last?._tag === "refused")
    return { state: "problem", label: "Couldn't sync", detail: refusalText(last.refusal) };
  if (status === null) return { state: "up-to-date", label: "Overleaf", detail: "" };
  if (status.availability === "unavailable" || status.availability === "disconnected") {
    return {
      state: "problem",
      label: "Overleaf problem",
      detail:
        status.availability === "disconnected"
          ? "This folder is no longer linked."
          : "Scient can't reach this folder's sync state.",
    };
  }
  if (status.reasons.includes("conflict-marks") || status.reasons.includes("interrupted-files")) {
    const marked = status.markerPaths.length;
    return {
      state: "decision",
      label: "Needs a decision",
      detail:
        marked > 0
          ? `${plural(marked, "file")} still ${marked === 1 ? "has" : "have"} Overleaf conflicts to settle.`
          : "A file an earlier sync left half done needs a decision.",
    };
  }
  if (status.reasons.includes("folder-changed") || status.reasons.includes("staging")) {
    return {
      state: "problem",
      label: "Overleaf problem",
      detail: status.reasons.includes("folder-changed")
        ? "The folder moved, or its disk isn't connected."
        : "An earlier change left folders to tidy. Sync to finish it.",
    };
  }
  if (status.local?._tag === "unread") {
    return {
      state: "problem",
      label: "Overleaf problem",
      detail: `Scient couldn't read the folder (${refusalText({ reason: status.local.reason })})`,
    };
  }
  const local = status.local?._tag === "read" ? status.local : null;
  const edits = local === null ? 0 : local.changed + local.deleted + local.added;
  if (edits > 0 || status.availability === "recovery-required") {
    return {
      state: "edits",
      label: "Edits to send",
      detail:
        edits > 0
          ? `${plural(edits, "change")} to send.`
          : "An earlier sync didn't finish. The next sync finishes it.",
    };
  }
  return { state: "up-to-date", label: "Up to date", detail: "Nothing to send." };
}

/** Plain words for a refusal or failure reason, from the engine's fixed categories. */
export function refusalText(refusal: ScientOverleafRefusal): string {
  const filesystem = overleafFilesystemRefusalText(refusal.reason);
  if (filesystem !== null) return filesystem;
  const at = refusal.path ? ` (${refusal.path})` : "";
  switch (refusal.reason) {
    case "volume-unavailable":
      return "The disk holding this project is not connected.";
    case "no-volume-identity":
      return "This disk does not report a stable identity, so Scient cannot keep replaced files safely on it.";
    case "unsupported-filesystem":
      return "This disk cannot replace files safely (for example exFAT or FAT). Use a disk formatted as APFS.";
    case "read-only-parent":
      return "Scient cannot create its folder for kept files beside this project, because that location is read-only.";
    case "shared-parent":
      return "The folder containing this project belongs to another user, so Scient will not keep files there.";
    case "disk-root-checkout":
      return "This project is the top folder of its disk, so there is no place beside it on the same disk for kept files.";
    case "unsafe-directory":
      return "The folder for kept files is not a private directory owned by Scient.";
    case "vault-missing":
      return "The folder holding this connection's kept files is missing. Reconnect the disk it was on.";
    case "vault-replaced":
      return "The folder for kept files is not the one this connection recorded.";
    case "token-missing":
      return "No Overleaf token is saved. Add one in Settings ▸ Synced folders ▸ Overleaf.";
    case "access-denied":
      return "Overleaf refused the token, or this account has no Git access to the project.";
    case "project-not-found":
      return "Overleaf has no such project.";
    case "project-invalid":
      return "That isn't an Overleaf project link or ID.";
    case "unreachable":
      return "Overleaf couldn't be reached. Check the connection and sync again.";
    case "git-unavailable":
      return "Overleaf sync needs Git 2.39 or newer on this project's server.";
    case "git-failed":
      return "Git failed while talking to Overleaf. Sync again.";
    case "no-branch":
      return "The Overleaf project has no single main branch.";
    case "relink-needed":
      return "This project's folder changed since it was linked. Relink it.";
    case "workspace-not-authorized":
      return "This Overleaf link belongs to another project.";
    case "folder-invalid":
      return "That folder name can't be used.";
    case "folder-missing":
    case "folder-unavailable":
      return "The folder isn't there, or its disk isn't connected.";
    case "folder-not-empty":
      return "A folder with that name already has files. Pick another name, or link it instead.";
    case "folder-outside-checkout":
      return "The folder is a link, or outside the project.";
    case "folder-overlaps":
      return "This folder, or one inside or around it, is linked already.";
    case "project-already-linked":
      return "This Overleaf project is linked to another folder of this project already.";
    case "local-work-pending":
    case "operation-active":
      return "Another Overleaf operation is running on this folder. Try again when it finishes.";
    case "authority-changed":
    case "connection-stale":
      return "The project changed while this ran. Try again.";
    case "checkout-suspended":
      return "A pull, branch switch or checkpoint restore is changing the project. Sync again after it.";
    case "checkout-recovery-required":
    case "recovery-required":
      return "An earlier sync didn't finish. Sync again to finish it.";
    case "state-locked":
      return "Another Scient process holds the Overleaf state. Close it and sync again.";
    case "walk-limit":
      return "The folder has more than 5,000 entries. Choose a narrower folder.";
    case "managed-limit":
    case "candidate-file-limit":
    case "remote-file-limit":
      return "More than 2,000 files to sync. Keep some only here, or choose a narrower folder.";
    case "total-too-large":
    case "candidate-too-large":
    case "remote-too-large":
      return "More than 250 MiB to sync. Keep some files only here, or choose a narrower folder.";
    case "file-too-large":
    case "candidate-file-too-large":
    case "remote-file-too-large":
      return `A file is over Overleaf's 50 MB limit${at}.`;
    case "local-only-limit":
      return "Too many files are kept only here. Choose a narrower folder.";
    case "unstable":
      return `A file changed while Scient read it${at}. Sync again.`;
    case "unreadable":
      return `Scient couldn't read a file${at}.`;
    case "not-a-file":
      return `A synced file is now a link or a folder${at}.`;
    case "lfs-pointer":
      return `A Git LFS pointer can't be synced${at}.`;
    case "managed-excluded":
      return `A synced file is now inside a nested repository${at}.`;
    case "release-held":
      return `${refusal.path ?? "A file"} can't be sent anyway: another file waiting for its conflicts keeps its place on Overleaf. Settle that file first.`;
    case "alias":
    case "path-alias":
    case "alias-rename":
      return `Two names differ only by letter case or accents${at}. Rename one and sync again.`;
    case "remote-forbidden":
      return `Overleaf sent something Scient won't write: a link, a repository or a Git LFS pointer${at}.`;
    case "unreviewed-path":
    case "remote-collides-with-excluded":
      return `Overleaf has a file where this folder keeps something unsynced${at}. Move or rename it.`;
    case "git-folder":
      return "The folder is inside Git's own folders.";
    case "retained-limit":
    case "retention-unavailable":
      return "Scient can't keep copies of replaced files on this disk right now.";
    case "connection-unavailable":
    case "connection-not-ready":
      return "This folder's link isn't ready. Sync again.";
    case "request-reused":
      return "This request was already used. Try again.";
    case "request-incomplete":
      return "An earlier attempt stopped before it finished, so it isn't run again. Try again.";
    case "records-unreadable":
      return "Scient can't read its Overleaf link records, so nothing was linked or changed.";
    case "editor-unsaved":
      return refusal.path
        ? `${refusal.path} has unsaved edits or a save that needs review. If the file was deleted, keep or discard its edits in the editor, then try again. Nothing was changed.`
        : "An open Scient window didn't answer the request to save its editors, so nothing was changed. Try again.";
    case "overleaf-moved":
      return "Overleaf kept changing while the conflicts were shown. Sync again.";
    case "folder-kept-changing":
      return "The folder kept changing during the sync. Sync again when edits pause.";
    case "recovery-repeated":
      return "An interrupted sync couldn't be finished. Sync again.";
    default:
      return `Sync stopped (${refusal.reason}).`;
  }
}

/** What an operation's thrown error says: the server's fixed reason when it gave one. */
/** What any other failure says: no address, status or serialized error reaches the screen. */
export const OVERLEAF_REQUEST_FAILED = "The Overleaf request didn't go through. Try again.";

const REASON = /^[a-z][a-z-]{0,63}$/u;

/**
 * What an operation's thrown error says. The server's typed refusal
 * (`ScientOverleafOperationError`) and the app's own reasoned errors carry a
 * fixed reason, mapped to its words; anything else gets one fixed line.
 */
export function operationErrorText(error: unknown): string {
  if (typeof error === "object" && error !== null && "reason" in error) {
    const { reason, paths } = error as { readonly reason: unknown; readonly paths?: unknown };
    // An editor that couldn't save is named by the first of the files the server lists.
    const path = Array.isArray(paths) && typeof paths[0] === "string" ? paths[0] : undefined;
    if (typeof reason === "string" && REASON.test(reason))
      return refusalText({ reason, ...(path === undefined ? {} : { path }) });
  }
  return OVERLEAF_REQUEST_FAILED;
}

export interface OverleafResultView {
  /** The headline: "3 files came in, 2 were sent". */
  readonly title: string;
  /** The further lines of section 4.1, in order. */
  readonly lines: ReadonlyArray<string>;
  readonly tone: "success" | "info" | "warning" | "error";
  /** Whether "See changes" has something to show. */
  readonly hasChanges: boolean;
  /** A conflict waits: the review tab opens. */
  readonly needsDecision: boolean;
}

const fileCount = (count: number) => plural(count, "file");

/** The files a review holds back for their conflict marks, and those an apply left marked. */
function heldPaths(
  review: ScientOverleafReview,
  markerPaths: ReadonlyArray<string> = [],
): string[] {
  return [...new Set([...markerPaths, ...review.unresolvedMarkers])].sort();
}

/** Held files wait while everything else syncs; they are always named (design section 4.2). */
function heldLine(held: ReadonlyArray<string>): string {
  const named =
    held.length <= 3
      ? held.join(", ")
      : `${held.slice(0, 3).join(", ")} and ${held.length - 3} more`;
  return `Waiting for conflict marks to be settled: ${named}.`;
}

/**
 * What a read of the changes says when there is nothing to do, so the tab never shows an
 * empty page; null when the read lists changes, conflicts or held files.
 */
export function readNothingToDoLine(review: ScientOverleafReview): string | null {
  return review.upToDate && review.unresolvedMarkers.length === 0
    ? "Up to date with Overleaf: nothing to bring in or send."
    : null;
}

/**
 * What a review still to run will send, with the pending per-file decisions applied: a new
 * file kept only here is not sent, though the review was read before that choice.
 */
export function outgoingAfterDecisions<T extends ScientOverleafChange | ScientOverleafDiffFile>(
  outgoing: ReadonlyArray<T>,
  decisions: ReadonlyMap<string, OverleafFileDecision>,
): ReadonlyArray<T> {
  return outgoing.filter((change) => !("path" in change && decisions.get(change.path) === "keep"));
}

/** The headline counts for a review that was applied, and whether its send reached Overleaf. */
function countsTitle(review: ScientOverleafReview, sent: boolean, held: number): string {
  const incoming = review.incoming.length;
  const outgoing = sent ? review.outgoing.length : 0;
  if (incoming === 0 && outgoing === 0)
    return held > 0
      ? `${fileCount(held)} ${held === 1 ? "waits" : "wait"} for conflicts`
      : "Up to date with Overleaf";
  const parts: string[] = [];
  if (incoming > 0) parts.push(`${fileCount(incoming)} came in`);
  if (outgoing > 0)
    parts.push(
      incoming > 0
        ? `${outgoing} ${outgoing === 1 ? "was" : "were"} sent`
        : `${fileCount(outgoing)} ${outgoing === 1 ? "was" : "were"} sent`,
    );
  return parts.join(", ");
}

/** The lines every review adds: renames, older versions, earlier sends, sizes. */
function warningLines(review: ScientOverleafReview): string[] {
  const lines: string[] = [];
  const renames = review.warnings.filter((warning) => warning.kind === "rename");
  if (renames.length > 0) {
    lines.push(
      renames.length === 1 && renames[0]?.from && renames[0].to
        ? `Renamed ${renames[0].from} to ${renames[0].to}. Overleaf drops comments and tracked changes on renamed files.`
        : `Renamed ${fileCount(renames.length)}. Overleaf drops comments and tracked changes on renamed files.`,
    );
  }
  const older = review.warnings.filter((warning) => warning.kind === "restores-older-version");
  // Said with the files: an older version replaces collaborators' newer text on Overleaf.
  if (older.length === 1 && older[0]?.path)
    lines.push(`Sent a version of ${older[0].path} that Overleaf had before.`);
  else if (older.length > 0)
    lines.push(`Sent versions of ${fileCount(older.length)} that Overleaf had before.`);
  for (const warning of review.warnings) {
    if (warning.kind === "unresolved-publication") {
      lines.push(
        "An earlier send never got an answer. Scient never retries it, and Overleaf still doesn't show whether it arrived; this sync may carry some of the same changes again.",
      );
    }
  }
  if (
    review.warnings.some(
      (warning) =>
        warning.kind === "over-recommended-size" || warning.kind === "editable-total-exceeded",
    )
  ) {
    lines.push("The project is bigger than Overleaf recommends.");
  }
  for (const warning of review.warnings) {
    if (warning.kind === "too-large-to-edit" && warning.path) {
      lines.push(`${warning.path} is too big to edit on Overleaf.`);
    }
  }
  return lines;
}

/** What the sync's send did, when it didn't simply arrive. */
function publicationLine(
  publication: Extract<ScientOverleafSyncResult, { _tag: "synced" }>["publication"],
  held: ReadonlyArray<string>,
): { readonly line: string | null; readonly tone: OverleafResultView["tone"] } {
  switch (publication._tag) {
    case "none":
    case "accepted":
      return { line: null, tone: "success" };
    case "blocked":
      switch (publication.reason) {
        case "markers":
          return {
            line: `Nothing was sent: ${fileCount(held.length || 1)} still ${held.length === 1 ? "has" : "have"} conflict marks. Settle them and sync again.`,
            tone: "warning",
          };
        case "kept-copy-changed":
          return {
            line: "Nothing was sent: a kept copy changed during this sync. The next sync checks again.",
            tone: "warning",
          };
        case "staging":
          return {
            line: "Nothing was sent: an earlier change left folders to tidy. Sync again.",
            tone: "warning",
          };
        default:
          return {
            line: "Nothing was sent: a file needs a decision first.",
            tone: "warning",
          };
      }
    case "not-verified":
      return {
        line: "Nothing was sent: the folder changed during the sync. That edit goes with the next sync.",
        tone: "warning",
      };
    case "not-sent":
      return {
        line: "Nothing was sent: the Overleaf token changed during the sync. Sync again.",
        tone: "warning",
      };
    case "out-of-date":
      return {
        line: "Overleaf changed again while this sync was sending. Sync again.",
        tone: "warning",
      };
    case "unknown":
      return {
        line: "Scient couldn't tell whether Overleaf received this send. It never sends it twice; the next sync checks.",
        tone: "warning",
      };
  }
}

/** The lines every finished or waiting sync adds about other agents and worktrees. */
function contextLines(
  activity: ReadonlyArray<{ readonly title: string }> | null,
  linkedElsewhere: boolean,
): string[] {
  const lines: string[] = [];
  if (linkedElsewhere) {
    lines.push(
      "Synced the main copy. Your edits in this worktree aren't in it until they're merged there.",
    );
  }
  if (activity === null) {
    lines.push("Scient couldn't check whether other agents are working in this copy.");
  } else if (activity.length === 1) {
    lines.push(`Another agent is working in this copy: ${activity[0]!.title}.`);
  } else if (activity.length > 1) {
    lines.push(`${activity.length} other agents are working in this copy.`);
  }
  return lines;
}

/**
 * An interrupted earlier sync an operation (a sync, or a read of the changes)
 * settled before its own work, which wrote the folder.
 */
export function settledText(settled: { readonly outcome: string }): string {
  return settled.outcome === "complete"
    ? "It first finished an interrupted sync, which wrote the folder."
    : "It first settled an interrupted sync without finishing it; sync again.";
}

/** What a sync did before its outcome: an interrupted sync it finished, and a retry. */
function progressLines(result: ScientOverleafSyncResult): string[] {
  if (result._tag === "duplicate") return [];
  return [
    ...(!result.settled ? [] : [settledText(result.settled)]),
    ...(result.retried
      ? [
          "Overleaf changed while sending, so it ran again; the first run's changes are in the folder.",
        ]
      : []),
  ];
}

export function overleafResultView(result: ScientOverleafSyncResult): OverleafResultView {
  const progress = progressLines(result);
  switch (result._tag) {
    case "synced": {
      const sent = result.publication._tag === "accepted";
      const held = heldPaths(result.review, result.markerPaths);
      const publication = publicationLine(result.publication, held);
      const lines = [
        ...progress,
        ...(publication.line ? [publication.line] : []),
        ...warningLines(result.review),
        ...(held.length > 0 ? [heldLine(held)] : []),
        ...(result.interrupted > 0
          ? [`An interrupted sync left ${fileCount(result.interrupted)} to settle.`]
          : []),
        ...contextLines(result.activity, result.linkedElsewhere),
      ];
      return {
        title: countsTitle(result.review, sent, held.length),
        lines,
        tone: publication.tone,
        hasChanges: result.review.incoming.length > 0 || result.review.outgoing.length > 0,
        needsDecision: false,
      };
    }
    case "needs-decision": {
      const count = result.review.conflicts.length;
      return {
        title: `${plural(count, "conflict")} with Overleaf`,
        lines: [
          ...progress,
          progress.length === 0
            ? "Nothing was changed yet. Choose how to settle each one, then sync again."
            : "None of these was changed yet. Choose how to settle each one, then sync again.",
          ...(result.review.unresolvedMarkers.length > 0
            ? [heldLine(heldPaths(result.review))]
            : []),
          ...contextLines(result.activity, result.linkedElsewhere),
        ],
        tone: "warning",
        hasChanges: true,
        needsDecision: true,
      };
    }
    case "refused":
      return {
        title: "Couldn't sync with Overleaf",
        lines: [...progress, refusalText(result.refusal)],
        tone: "error",
        hasChanges: false,
        needsDecision: false,
      };
    case "unsettled":
      return {
        title: "Couldn't sync with Overleaf",
        lines: [...progress, refusalText({ reason: result.reason })],
        tone: "error",
        hasChanges: false,
        needsDecision: false,
      };
    case "duplicate":
      return {
        title: "That sync already ran",
        lines: [],
        tone: "info",
        hasChanges: false,
        needsDecision: false,
      };
    case "cancelled":
      return {
        title: "Sync cancelled",
        lines: progress.length === 0 ? ["Nothing was changed."] : progress,
        tone: "info",
        hasChanges: false,
        needsDecision: false,
      };
  }
}

/** What Undo does to a file a send changed: the reverse of the send. */
export function undoChangeLabel(change: ScientOverleafChange): string {
  switch (change.kind) {
    case "modified":
      return "Earlier version";
    case "added":
      return "Removed";
    case "deleted":
      return "Back";
    case "renamed":
      return "Old name back";
  }
}

const UNDO_SKIPPED: Record<
  Extract<ScientOverleafUndoResult, { _tag: "undone" }>["skipped"][number]["reason"],
  string
> = {
  changed: "edited since",
  "already-undone": "already back",
  "name-clash": "name in use",
  "too-large": "too large",
  "kept-only-here": "kept only here",
};

const UNDO_NOT_ELIGIBLE: Record<
  Extract<ScientOverleafUndoResult, { _tag: "not-eligible" }>["reason"],
  string
> = {
  "not-recorded": "Scient no longer records this send.",
  unresolved: "Overleaf never answered this send.",
  "not-sent": "This send never went out.",
  "out-of-date": "Overleaf refused this send, so it changed nothing.",
  "history-unavailable": "Scient no longer holds what this send replaced.",
};

/** What an undo did (design section 4.3): what it put back, what it left and why, then its sync. */
export function overleafUndoView(
  result: ScientOverleafUndoResult,
): Pick<OverleafResultView, "title" | "lines" | "tone" | "needsDecision"> {
  switch (result._tag) {
    case "undone": {
      const skipped =
        result.skipped.length === 0
          ? []
          : [
              `Left as it is: ${result.skipped.map((skip) => `${skip.path} (${UNDO_SKIPPED[skip.reason]})`).join(", ")}.`,
            ];
      const put = result.restored.length + result.removed.length + result.recreated.length;
      // The sync after the undo: what it sent and any conflict it stopped at, or that
      // none ran because the undo stopped partway.
      const synced = result.sync._tag === "not-synced" ? null : overleafResultView(result.sync);
      const syncLines =
        synced === null
          ? ["Undo stopped partway; nothing was sent. Check the files, then sync."]
          : [`${synced.title}.`, ...synced.lines];
      const needsDecision = synced?.needsDecision ?? false;
      switch (result.outcome) {
        case null:
          return {
            title: "Nothing was put back",
            lines: [...skipped, ...syncLines],
            tone: "info",
            needsDecision,
          };
        case "replan":
          return {
            title: "Nothing was put back",
            lines: ["The folder changed during the undo.", ...syncLines],
            tone: "warning",
            needsDecision,
          };
        case "attention":
          return {
            title: "Undo needs attention",
            lines: [...skipped, ...syncLines],
            tone: "warning",
            needsDecision,
          };
        default:
          return {
            title: `Put back ${fileCount(put)}`,
            lines: [...skipped, ...syncLines],
            tone: synced?.tone ?? "success",
            needsDecision,
          };
      }
    }
    case "not-eligible":
      return {
        title: "Can't undo this send",
        lines: [UNDO_NOT_ELIGIBLE[result.reason]],
        tone: "error",
        needsDecision: false,
      };
    case "refused":
      return {
        title: "Couldn't undo",
        lines: [refusalText(result.refusal)],
        tone: "error",
        needsDecision: false,
      };
    case "duplicate":
      return { title: "That undo already ran", lines: [], tone: "info", needsDecision: false };
    case "cancelled":
      return {
        title: "Undo cancelled",
        lines: ["Nothing was changed."],
        tone: "info",
        needsDecision: false,
      };
  }
}

/** A review's choices that the next sync sends: one per conflict a person chose. */
export function choicesFor(
  review: ScientOverleafReview,
  chosen: ReadonlyMap<string, "mine" | "theirs" | "markers">,
): ReadonlyArray<{ readonly key: string; readonly choice: "mine" | "theirs" | "markers" }> {
  return review.conflicts.flatMap((conflict) => {
    const choice = chosen.get(conflict.key) ?? conflict.chosen;
    return choice !== null && choice !== undefined && conflict.allowed.includes(choice)
      ? [{ key: conflict.key, choice }]
      : [];
  });
}

/**
 * The message "Ask the agent" puts in the chat. The marks are already in the
 * files; the agent merges them and explains.
 */
export function askAgentMessage(paths: ReadonlyArray<string>): string {
  const list = paths.map((path) => `- ${path}`).join("\n");
  return [
    "Overleaf sync found conflicts. Scient wrote both versions into these files between conflict marks (<<<<<<< Scient, =======, >>>>>>> Overleaf):",
    list,
    "Please merge each block, keeping what both sides meant, remove the marks, and explain your choices. Then sync with Overleaf again.",
  ].join("\n\n");
}

/** The labels Scient's Overleaf merge writes on its conflict marks (OverleafRepository). */
const OURS_MARK = "<<<<<<< Scient";
const THEIRS_MARK = ">>>>>>> Overleaf";
const BASE_MARK = "|||||||";
const SEPARATOR = "=======";

/** One block of Scient's conflict marks, by zero-based line. */
export interface OverleafConflictBlock {
  /** The `<<<<<<< Scient` line. */
  readonly startLine: number;
  /** The `>>>>>>> Overleaf` line. */
  readonly endLine: number;
  /** This computer's lines, before `|||||||` or `=======`. */
  readonly mine: ReadonlyArray<string>;
  /** Overleaf's lines, after `=======`. */
  readonly theirs: ReadonlyArray<string>;
}

/** Git adds ":<path>" to a label after a rename on one side. */
const marks = (line: string, label: string) => {
  const trimmed = line.trimEnd();
  return trimmed === label || trimmed.startsWith(`${label}:`);
};

/**
 * Scient's Overleaf conflict blocks in a file: a `<<<<<<< Scient` line, an
 * optional `|||||||` base section, `=======`, and a `>>>>>>> Overleaf` line.
 * A Markdown `=======` alone, or another tool's marks, is not one.
 */
export function overleafConflictBlocks(contents: string): ReadonlyArray<OverleafConflictBlock> {
  if (!contents.includes(OURS_MARK)) return [];
  const lines = contents.split(/\r?\n/u);
  const blocks: OverleafConflictBlock[] = [];
  let open: { start: number; base: number | null; separator: number | null } | null = null;
  for (const [index, line] of lines.entries()) {
    if (marks(line, OURS_MARK)) {
      open = { start: index, base: null, separator: null };
    } else if (open === null) {
      continue;
    } else if (open.separator === null && open.base === null && line.startsWith(BASE_MARK)) {
      open.base = index;
    } else if (open.separator === null && line.trimEnd() === SEPARATOR) {
      open.separator = index;
    } else if (open.separator !== null && marks(line, THEIRS_MARK)) {
      blocks.push({
        startLine: open.start,
        endLine: index,
        mine: lines.slice(open.start + 1, open.base ?? open.separator),
        theirs: lines.slice(open.separator + 1, index),
      });
      open = null;
    }
  }
  return blocks;
}

export function countOverleafConflictBlocks(contents: string): number {
  return overleafConflictBlocks(contents).length;
}

export type OverleafConflictResolution = "mine" | "theirs" | "both";

/** The lines that replace a block: this folder's, Overleaf's, or both in that order. */
export function resolvedConflictLines(
  block: OverleafConflictBlock,
  resolution: OverleafConflictResolution,
): ReadonlyArray<string> {
  return resolution === "mine"
    ? block.mine
    : resolution === "theirs"
      ? block.theirs
      : [...block.mine, ...block.theirs];
}

/** Overleaf refuses these new files whatever anyone decides. */
export const UNSENDABLE_REASONS: ReadonlySet<string> = new Set(["too-large", "lfs-pointer"]);

const NO_DECISIONS: ReadonlyMap<string, OverleafFileDecision> = new Map();

/** One review: the engine's ID and the Overleaf tree its conflicts were found against. */
export function reviewIdentity(review: Pick<ScientOverleafReview, "reviewId" | "remoteTree">) {
  return `${review.reviewId}\u0000${review.remoteTree}`;
}

/** The decisions still applicable to the review shown: "keep" for a new file the rule would
 * send, "send" for a skipped-but-sendable or local-only file, "release" for a held file. A
 * decision for an unlisted or now-impossible file is dropped, so it is neither shown nor sent. */
export function actionableDecisions(
  review: Pick<ScientOverleafReview, "additions" | "localOnly" | "unresolvedMarkers"> | null,
  decisions: ReadonlyMap<string, OverleafFileDecision>,
): ReadonlyMap<string, OverleafFileDecision> {
  if (review === null || decisions.size === 0) return NO_DECISIONS;
  const additions = new Map(review.additions.map((addition) => [addition.path, addition]));
  const localOnly = new Set(review.localOnly);
  const held = new Set(review.unresolvedMarkers);
  const kept = new Map<string, OverleafFileDecision>();
  for (const [path, decision] of decisions) {
    const addition = additions.get(path);
    const applies =
      decision === "release"
        ? held.has(path)
        : decision === "keep"
          ? addition !== undefined && addition.skippedBecause === null
          : localOnly.has(path) ||
            (addition !== undefined &&
              addition.skippedBecause !== null &&
              !UNSENDABLE_REASONS.has(addition.skippedBecause));
    if (applies) kept.set(path, decision);
  }
  return kept.size === decisions.size ? decisions : kept;
}

/** Files decidable in the review shown: after a sync applied, no additions (local-only and
 * held files stay decidable). A local-only file that sync was asked to send counts as
 * local-only again; a `released` file counts as held, so both decisions stay. */
export function decidableFiles(
  shown: { readonly review: ScientOverleafReview; readonly applied: boolean } | null,
  carried: {
    readonly review: string;
    readonly decisions: ReadonlyMap<string, OverleafFileDecision>;
  } | null,
): Pick<ScientOverleafReview, "additions" | "localOnly" | "unresolvedMarkers"> | null {
  if (shown === null) return null;
  const { review } = shown;
  if (shown.applied)
    return {
      additions: [],
      localOnly: review.localOnly,
      unresolvedMarkers: review.unresolvedMarkers,
    };
  const sentLocalOnly =
    carried !== null && carried.review === reviewIdentity(review)
      ? [...carried.decisions]
          .filter(
            ([path, decision]) =>
              decision === "send" &&
              !review.localOnly.includes(path) &&
              !review.additions.some((addition) => addition.path === path),
          )
          .map(([path]) => path)
      : [];
  return {
    additions: review.additions,
    localOnly: [...review.localOnly, ...sentLocalOnly],
    unresolvedMarkers: [...new Set([...review.unresolvedMarkers, ...review.released])],
  };
}

/** The decisions as a sync request carries them. */
export function fileDecisionsRequest(decisions: ReadonlyMap<string, OverleafFileDecision>): {
  readonly keepOnlyHere: ReadonlyArray<string>;
  readonly send: ReadonlyArray<string>;
  readonly release: ReadonlyArray<string>;
} {
  const keepOnlyHere: string[] = [];
  const send: string[] = [];
  const release: string[] = [];
  for (const [path, decision] of decisions)
    (decision === "keep" ? keepOnlyHere : decision === "send" ? send : release).push(path);
  return { keepOnlyHere, send, release };
}

/** How many new files the next sync sends, with the decisions made so far. */
export function newFilesToSend(
  review: Pick<ScientOverleafReview, "additions">,
  decisions: ReadonlyMap<string, OverleafFileDecision>,
): number {
  // Without a decision a file goes by the rule: sent unless the rule skips it. A review's
  // `selected` may encode the decision of the sync that produced it, which may since be undone.
  return review.additions.filter((addition) =>
    decisions.has(addition.path)
      ? decisions.get(addition.path) === "send"
      : addition.skippedBecause === null,
  ).length;
}
