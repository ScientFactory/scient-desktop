// SCIENT-OWNED: what the Overleaf screens say, decided from the server's fixed
// categories. Pure functions, so every line a person sees is tested here.
import { overleafFilesystemRefusalText, overleafNameProblem } from "@t3tools/contracts";
import { msg } from "gt-react";

import { m, type MessageResolver } from "~/i18n/messages";

import type {
  ScientOverleafChange,
  ScientOverleafConnectionSummary,
  ScientOverleafRefusal,
  ScientOverleafRemoteState,
  ScientOverleafReview,
  ScientOverleafStatus,
  ScientOverleafSyncResult,
  ScientOverleafDiffFile,
  ScientOverleafUndoResult,
  ScientOverleafUnreadableRecord,
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
export function folderNameProblem(name: string, resolve: MessageResolver = m): string | null {
  const trimmed = name.trim();
  if (trimmed.length === 0) return resolve(msg("Name the folder."));
  if (/[/\\]/u.test(trimmed)) return resolve(msg("Use a name without slashes."));
  if (trimmed === "." || trimmed === ".." || trimmed.startsWith(".")) {
    return resolve(msg("Use a name that doesn't start with a dot."));
  }
  const problem = overleafNameProblem(name);
  if (problem === "component-too-long") return resolve(msg("Use a shorter folder name."));
  if (problem !== null)
    return resolve(
      msg("Use a name without reserved words, trailing spaces or special characters."),
    );
  return null;
}

/** A folder of the workspace a person picked or typed: empty for its top folder. */
export function workspaceFolderPath(path: string): string {
  return path.trim().replace(/^\/+|\/+$/gu, "");
}

/** Why a picked or typed folder can't be used, or null: it must stay inside the project. */
export function workspaceFolderProblem(path: string, resolve: MessageResolver = m): string | null {
  const trimmed = path.trim();
  if (trimmed === "") return null;
  if (trimmed.startsWith("/") || /^[A-Za-z]:[\\/]/u.test(trimmed) || trimmed.includes("\\")) {
    return resolve(msg("Choose a folder inside this project."));
  }
  const parts = workspaceFolderPath(trimmed).split("/");
  if (parts.some((part) => part === "" || part.startsWith("."))) {
    return resolve(msg("Choose a folder inside this project."));
  }
  return null;
}

/**
 * A person's per-file decision: keep a new file only here, send one anyway, or
 * send a file held back for its conflict marks as it is ("Send it anyway").
 */
export type OverleafFileDecision = "keep" | "send" | "release";

export type OverleafChipState =
  | "syncing"
  | "up-to-date"
  | "edits"
  | "incoming"
  | "decision"
  | "problem";

export interface OverleafChipView {
  readonly state: OverleafChipState;
  /** The chip's text. */
  readonly label: string;
  /** One line under the menu's title. */
  readonly detail: string;
}

/** The chip next to "Saved", from the offline status. */
export function overleafChipView(
  status: ScientOverleafStatus | null,
  syncing: boolean,
  /** This window's latest sync of the link, dropped when another sync changes it. */
  last: ScientOverleafSyncResult | null = null,
  /** What Overleaf itself last said; null until it was asked. */
  remote: ScientOverleafRemoteState["state"] | null = null,
  resolve: MessageResolver = m,
): OverleafChipView {
  if (syncing || status?.busy) {
    return {
      state: "syncing",
      label: resolve(msg("Syncing…")),
      detail: resolve(msg("A sync is running.")),
    };
  }
  // The status reads only the folder: a sync that stopped at a conflict or was refused
  // says more than the edits waiting, until the next sync.
  if (last?._tag === "needs-decision")
    return {
      state: "decision",
      label: resolve(msg("Needs a decision")),
      detail: resolve(msg("A conflict with Overleaf needs a choice.")),
    };
  if (last?._tag === "refused")
    return {
      state: "problem",
      label: resolve(msg("Couldn't sync")),
      detail: refusalText(last.refusal, "sync", last.settled !== null || last.retried, resolve),
    };
  if (status === null)
    // oxlint-disable-next-line t3code/no-untranslated-copy -- product name
    return { state: "up-to-date", label: "Overleaf", detail: "" };
  if (status.availability === "unavailable" || status.availability === "disconnected") {
    return {
      state: "problem",
      label: resolve(msg("Overleaf problem")),
      detail:
        status.availability === "disconnected"
          ? status.reasons.length === 0
            ? resolve(msg("This folder is no longer linked."))
            : resolve(
                msg(
                  "This folder was unlinked before a sync finished. Link it to the same project again to finish it.",
                ),
              )
          : resolve(
              msg(
                "The linked folder was moved, renamed, replaced or deleted. Link it again at its new place, or unlink it.",
              ),
            ),
    };
  }
  if (status.reasons.includes("conflict-marks") || status.reasons.includes("interrupted-files")) {
    const marked = status.markerPaths.length;
    return {
      state: "decision",
      label: resolve(msg("Needs a decision")),
      detail:
        marked > 0
          ? resolve(
              msg(
                "{count, plural, one {{count} file still has Overleaf conflicts to settle.} other {{count} files still have Overleaf conflicts to settle.}}",
                { count: marked },
              ),
            )
          : resolve(msg("A file an earlier sync left half done needs a decision.")),
    };
  }
  if (status.reasons.includes("folder-changed") || status.reasons.includes("staging")) {
    return {
      state: "problem",
      label: resolve(msg("Overleaf problem")),
      detail: status.reasons.includes("folder-changed")
        ? resolve(msg("The folder moved or was replaced, or its disk isn't connected."))
        : resolve(msg("An earlier change left folders to tidy. Sync to finish it.")),
    };
  }
  if (status.local?._tag === "unread") {
    return {
      state: "problem",
      label: resolve(msg("Overleaf problem")),
      detail: resolve(
        msg("Scient couldn't read the folder ({reason})", {
          reason: refusalText({ reason: status.local.reason }, "sync", false, resolve),
        }),
      ),
    };
  }
  const local = status.local?._tag === "read" ? status.local : null;
  const edits = local === null ? 0 : local.changed + local.deleted + local.added;
  if (edits > 0 || status.availability === "recovery-required") {
    return {
      state: "edits",
      label: resolve(msg("Edits to send")),
      detail:
        edits > 0
          ? remote === "changed"
            ? resolve(
                msg(
                  "{count, plural, one {{count} change to send. Overleaf changed too.} other {{count} changes to send. Overleaf changed too.}}",
                  { count: edits },
                ),
              )
            : resolve(
                msg(
                  "{count, plural, one {{count} change to send.} other {{count} changes to send.}}",
                  { count: edits },
                ),
              )
          : resolve(msg("An earlier sync didn't finish. The next sync finishes it.")),
    };
  }
  if (status.connection.completedSyncCount === 0)
    return {
      state: "incoming",
      label: resolve(msg("Not synced yet")),
      detail: resolve(msg("Sync to bring the project here.")),
    };
  if (remote === "changed")
    return {
      state: "incoming",
      label: resolve(msg("Changes in Overleaf")),
      detail: resolve(msg("Sync to bring them here.")),
    };
  // "Up to date" is said only after asking Overleaf: the status reads the folder alone.
  if (remote === "same")
    return {
      state: "up-to-date",
      label: resolve(msg("Up to date")),
      detail: resolve(msg("Same as Overleaf.")),
    };
  return {
    state: "up-to-date",
    label: resolve(msg("No edits to send")),
    detail:
      remote === "unknown"
        ? resolve(msg("Scient couldn't check Overleaf just now."))
        : resolve(msg("Nothing to send.")),
  };
}

/**
 * Plain words for a refusal or failure reason, from the engine's fixed categories; for a
 * reason this release doesn't know, the server's own sentence when the refusal carries one.
 */
export function refusalText(
  refusal: ScientOverleafRefusal,
  action: "sync" | "connect" = "sync",
  /** The sync had already changed the folder, so the refusal can't say nothing changed. */
  afterProgress = false,
  resolve: MessageResolver = m,
): string {
  return (
    knownRefusalText(refusal, action, afterProgress, resolve) ??
    refusal.message ??
    resolve(msg("Sync stopped ({reason}).", { reason: refusal.reason }))
  );
}

function knownRefusalText(
  refusal: ScientOverleafRefusal,
  action: "sync" | "connect",
  afterProgress: boolean,
  resolve: MessageResolver,
): string | null {
  const filesystem = overleafFilesystemRefusalText(refusal.reason);
  if (filesystem !== null) return filesystem;
  const names = refusal.paths ?? (refusal.path ? [refusal.path] : []);
  // Sentences that name the files have a variant without them, chosen by hasPaths.
  const at = { hasPaths: names.length > 0 ? "yes" : "no", paths: names.join(", ") };
  switch (refusal.reason) {
    case "volume-unavailable":
      return resolve(msg("The disk holding this project is not connected."));
    case "no-volume-identity":
      return resolve(
        msg(
          "This disk does not report a stable identity, so Scient cannot keep replaced files safely on it.",
        ),
      );
    case "sync-managed-folder":
      return resolve(
        msg(
          "Scient can't keep copies of replaced files in a folder a cloud service syncs. Move the project out of the cloud folder, then link it again.",
        ),
      );
    case "read-only-parent":
      return resolve(
        msg(
          "Scient cannot create its folder for kept files beside this project, because that location is read-only.",
        ),
      );
    case "shared-parent":
      return resolve(
        msg(
          "The folder containing this project belongs to another user, so Scient will not keep files there.",
        ),
      );
    case "disk-root-checkout":
      return resolve(
        msg(
          "This project is the top folder of its disk, so there is no place beside it on the same disk for kept files.",
        ),
      );
    case "unsafe-directory":
      return resolve(msg("The folder for kept files is not a private directory owned by Scient."));
    case "vault-missing":
      return resolve(
        msg(
          "The folder holding this connection's kept files is missing. Reconnect the disk it was on.",
        ),
      );
    case "vault-replaced":
      return resolve(msg("The folder for kept files is not the one this connection recorded."));
    case "token-missing":
      return resolve(
        msg("No Overleaf token is saved. Add one in Settings ▸ Synced folders ▸ Overleaf."),
      );
    case "token-invalid":
      return resolve(msg("That isn't an Overleaf Git token. Copy it again from Overleaf."));
    case "access-denied":
      return resolve(
        msg(
          "Overleaf refused this project. Check the link, that the project is shared with your account, and your Overleaf token in Settings ▸ Synced folders.",
        ),
      );
    case "project-not-found":
      return resolve(
        msg(
          "Overleaf has no Git access to a project at this link. Check the link, that the project is shared with you, and that your Overleaf plan includes Git.",
        ),
      );
    case "project-invalid":
      return resolve(msg("That isn't an Overleaf project link or ID."));
    case "rate-limited":
      return action === "connect"
        ? resolve(
            msg(
              "Overleaf is limiting Git requests right now. Nothing was lost. Try connecting again in a minute.",
            ),
          )
        : resolve(
            msg(
              "Overleaf is limiting Git requests right now. Nothing was lost. Sync again in a minute.",
            ),
          );
    case "unreachable":
      return action === "connect"
        ? resolve(msg("Overleaf couldn't be reached. Check the connection. Try connecting again."))
        : resolve(msg("Overleaf couldn't be reached. Check the connection and sync again."));
    case "git-unavailable":
      return resolve(msg("Overleaf sync needs Git 2.39 or newer on this project's server."));
    case "git-failed":
      return action === "connect"
        ? resolve(msg("Git failed while talking to Overleaf. Try connecting again."))
        : resolve(msg("Git failed while talking to Overleaf. Sync again."));
    case "no-branch":
      return resolve(msg("The Overleaf project has no single main branch."));
    case "would-empty-overleaf":
      return resolve(
        msg(
          "This folder has none of the project's files, so a sync would delete everything on Overleaf. Nothing was sent. Put the files back, or unlink the folder.",
        ),
      );
    case "workspace-not-authorized":
      return resolve(msg("This Overleaf link belongs to another project."));
    case "folder-invalid":
      return resolve(msg("That folder name can't be used."));
    case "folder-missing":
      return resolve(msg("The folder isn't there, or its disk isn't connected."));
    case "folder-changed":
    case "folder-unavailable":
      return resolve(
        msg(
          "The linked folder was moved, renamed, replaced or deleted. Link it again at its new place, or unlink it.",
        ),
      );
    case "archived":
      return resolve(msg("This folder was unlinked from Overleaf. Link it again to sync."));
    case "missing":
      return resolve(msg("This folder's Overleaf link is gone. Link the folder again."));
    case "corrupt":
    case "unsupported":
      return resolve(
        msg(
          "Scient can't read this folder's Overleaf link record. See Settings › Synced folders › Overleaf.",
        ),
      );
    case "folder-not-empty":
      return resolve(
        msg("A folder with that name already has files. Pick another name, or link it instead."),
      );
    case "folder-outside-checkout":
      return resolve(msg("The folder is a link, or outside the project."));
    case "folder-overlaps":
      return resolve(msg("This folder, or one inside or around it, is linked already."));
    case "project-already-linked":
      return resolve(
        msg(
          "This Overleaf project is linked to another folder of this project already. Unlink that folder first.",
        ),
      );
    case "local-work-pending":
      return resolve(msg("An earlier sync didn't finish here. Sync again to finish it."));
    case "operation-active":
      return resolve(
        msg("A sync is running on this folder. Cancel it, or try again when it finishes."),
      );
    case "authority-changed":
    case "connection-stale":
      return resolve(msg("The project changed while this ran. Try again."));
    case "checkout-suspended":
      return resolve(
        msg(
          "A pull, branch switch or checkpoint restore is changing the project. Sync again after it.",
        ),
      );
    case "checkout-recovery-required":
    case "recovery-required":
      return resolve(msg("An earlier sync didn't finish. Sync again to finish it."));
    case "unreadable-record":
      return resolve(
        msg(
          "Scient can't read one of its Overleaf link records. See Settings › Synced folders › Overleaf.",
        ),
      );
    case "newer-unfinished-record":
      return resolve(
        msg(
          "A newer version of Scient left an Overleaf sync unfinished. Finish it in that version, then try again.",
        ),
      );
    case "state-locked":
      return resolve(
        msg("Another Scient process holds the Overleaf state. Close it and sync again."),
      );
    case "walk-limit":
      return resolve(msg("The folder has more than 5,000 entries. Choose a narrower folder."));
    case "managed-limit":
    case "candidate-file-limit":
    case "remote-file-limit":
      return resolve(
        msg("More than 2,000 files to sync. Keep some only here, or choose a narrower folder."),
      );
    case "total-too-large":
    case "candidate-too-large":
    case "remote-too-large":
      return resolve(
        msg("More than 250 MiB to sync. Keep some files only here, or choose a narrower folder."),
      );
    case "file-too-large":
    case "candidate-file-too-large":
    case "remote-file-too-large":
      return resolve(
        msg(
          "{hasPaths, select, yes {A file is over Overleaf's 50 MB limit ({paths}).} other {A file is over Overleaf's 50 MB limit.}}",
          at,
        ),
      );
    case "local-only-limit":
      return resolve(msg("Too many files are kept only here. Choose a narrower folder."));
    case "unstable":
      return resolve(
        msg(
          "{hasPaths, select, yes {A file changed while Scient read it ({paths}). Sync again.} other {A file changed while Scient read it. Sync again.}}",
          at,
        ),
      );
    case "unreadable":
      return resolve(
        msg(
          "{hasPaths, select, yes {Scient couldn't read a file ({paths}).} other {Scient couldn't read a file.}}",
          at,
        ),
      );
    case "not-a-file":
      return resolve(
        msg(
          "{hasPaths, select, yes {A synced file is now a link or a folder ({paths}).} other {A synced file is now a link or a folder.}}",
          at,
        ),
      );
    case "lfs-pointer":
      return resolve(
        msg(
          "{hasPaths, select, yes {A Git LFS pointer can't be synced ({paths}).} other {A Git LFS pointer can't be synced.}}",
          at,
        ),
      );
    case "managed-excluded":
      return resolve(
        msg(
          "{hasPaths, select, yes {A synced file is now inside a nested repository ({paths}).} other {A synced file is now inside a nested repository.}}",
          at,
        ),
      );
    case "release-held":
      return refusal.path
        ? resolve(
            msg(
              "{path} can't be sent anyway: another file waiting for its conflicts keeps its place on Overleaf. Settle that file first.",
              { path: refusal.path },
            ),
          )
        : resolve(
            msg(
              "A file can't be sent anyway: another file waiting for its conflicts keeps its place on Overleaf. Settle that file first.",
            ),
          );
    case "alias":
    case "path-alias":
    case "alias-rename":
      return resolve(
        msg(
          "{hasPaths, select, yes {Two names differ only by letter case or accents ({paths}). Rename one and sync again.} other {Two names differ only by letter case or accents. Rename one and sync again.}}",
          at,
        ),
      );
    case "held-file-clash":
      return resolve(
        msg(
          "{hasPaths, select, yes {A file waiting for its conflict marks keeps its place on Overleaf, where this sync puts another file or folder ({paths}). Settle its marks, or move the other one.} other {A file waiting for its conflict marks keeps its place on Overleaf, where this sync puts another file or folder. Settle its marks, or move the other one.}}",
          at,
        ),
      );
    case "not-selectable":
    case "not-local-only":
      return resolve(
        msg(
          "{hasPaths, select, yes {A file chosen for this sync changed or is gone ({paths}). Check the changes again, then sync.} other {A file chosen for this sync changed or is gone. Check the changes again, then sync.}}",
          at,
        ),
      );
    case "remote-forbidden":
      return resolve(
        msg(
          "{hasPaths, select, yes {Overleaf sent something Scient won't write: a link, a repository or a Git LFS pointer ({paths}).} other {Overleaf sent something Scient won't write: a link, a repository or a Git LFS pointer.}}",
          at,
        ),
      );
    case "unreviewed-path":
    case "remote-collides-with-excluded":
      return resolve(
        msg(
          "{hasPaths, select, yes {Overleaf has a file where this folder keeps something unsynced ({paths}). Move or rename it.} other {Overleaf has a file where this folder keeps something unsynced. Move or rename it.}}",
          at,
        ),
      );
    case "git-folder":
      return resolve(msg("The folder is inside Git's own folders."));
    case "retained-limit":
      return resolve(
        msg(
          "This would record more than Scient can track for one link. Settle conflict marks, kept copies or earlier sends first.",
        ),
      );
    case "retention-unavailable":
      return resolve(msg("Scient can't keep copies of replaced files on this disk right now."));
    case "connection-unavailable":
      return resolve(msg("This folder's link isn't ready. Sync again."));
    case "request-reused":
      return resolve(msg("This request was already used. Try again."));
    case "request-incomplete":
      return resolve(
        msg("An earlier attempt stopped before it finished, so it isn't run again. Try again."),
      );
    case "records-unreadable":
      return afterProgress
        ? resolve(
            msg(
              "Scient can't read one of its Overleaf link records, so the sync stopped there. See Settings › Synced folders › Overleaf.",
            ),
          )
        : resolve(
            msg(
              "Scient can't read one of its Overleaf link records, so nothing was linked or changed. See Settings › Synced folders › Overleaf.",
            ),
          );
    case "editor-unsaved":
      if (refusal.path) {
        return afterProgress
          ? resolve(
              msg(
                "{path} has unsaved edits or a save that needs review. If the file was deleted, keep or discard its edits in the editor, then try again.",
                { path: refusal.path },
              ),
            )
          : resolve(
              msg(
                "{path} has unsaved edits or a save that needs review. If the file was deleted, keep or discard its edits in the editor, then try again. Nothing was changed.",
                { path: refusal.path },
              ),
            );
      }
      return afterProgress
        ? resolve(
            msg(
              "An open Scient window didn't answer the request to save its editors, so the sync stopped there. Try again.",
            ),
          )
        : resolve(
            msg(
              "An open Scient window didn't answer the request to save its editors, so nothing was changed. Try again.",
            ),
          );
    case "overleaf-moved":
      return resolve(msg("Overleaf kept changing while the conflicts were shown. Sync again."));
    case "folder-kept-changing":
      return resolve(msg("The folder kept changing during the sync. Sync again when edits pause."));
    case "recovery-repeated":
      return resolve(msg("An interrupted sync couldn't be finished. Sync again."));
    default:
      return null;
  }
}

/** What any other failure says: no address, status or serialized error reaches the screen. */
export const OVERLEAF_REQUEST_FAILED = msg("The Overleaf request didn't go through. Try again.");

const REASON = /^[a-z][a-z-]{0,63}$/u;

/** Reasons whose server sentence says more than the app's line: which files, which limit. */
const SERVER_EXPLAINS: ReadonlySet<string> = new Set(["editor-unsaved", "retained-limit"]);

/**
 * What an operation's thrown error says: its fixed reason in the app's words, or the
 * server's fixed sentence for a reason this release doesn't know. Anything else gets one
 * fixed line, so no address, status or serialized error reaches the screen.
 */
export function operationErrorText(
  error: unknown,
  action: "sync" | "connect" = "sync",
  resolve: MessageResolver = m,
): string {
  if (typeof error === "object" && error !== null && "reason" in error) {
    const { reason, paths } = error as { readonly reason: unknown; readonly paths?: unknown };
    const message =
      "_tag" in error &&
      error._tag === "ScientOverleafOperationError" &&
      "message" in error &&
      typeof error.message === "string" &&
      error.message.trim().length > 0
        ? error.message
        : undefined;
    if (typeof reason === "string" && REASON.test(reason)) {
      if (message !== undefined && SERVER_EXPLAINS.has(reason)) return message;
      // An editor that couldn't save is named by the first of the files the server lists.
      const path = Array.isArray(paths) && typeof paths[0] === "string" ? paths[0] : undefined;
      return refusalText(
        {
          reason,
          ...(path === undefined ? {} : { path }),
          ...(message === undefined ? {} : { message }),
        },
        action,
        false,
        resolve,
      );
    }
  }
  return resolve(OVERLEAF_REQUEST_FAILED);
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

/** The files a review holds back for their conflict marks, and those an apply left marked. */
function heldPaths(
  review: ScientOverleafReview,
  markerPaths: ReadonlyArray<string> = [],
): string[] {
  return [
    ...new Set([
      ...markerPaths,
      ...review.unresolvedMarkers,
      ...review.heldWithMarked.map((file) => file.path),
    ]),
  ].sort();
}

/** Held files wait while everything else syncs; they are always named (design section 4.2). */
function heldLine(held: ReadonlyArray<string>, resolve: MessageResolver): string {
  return resolve(
    msg("Waiting for conflict marks to be settled: {paths}.", { paths: held.join(", ") }),
  );
}

/** Every held folder file is named, including clean files waiting on ambiguous identities. */
export function reviewHeldLines(
  review: ScientOverleafReview,
  markerPaths: ReadonlyArray<string> = [],
  resolve: MessageResolver = m,
): string[] {
  const marked = [...new Set([...markerPaths, ...review.unresolvedMarkers])].sort();
  return [
    ...(marked.length > 0 ? [heldLine(marked, resolve)] : []),
    ...review.heldWithMarked.map(({ path, markedPaths }) =>
      markedPaths.length > 0
        ? resolve(
            msg(
              "{count, plural, one {{path} waits with {marked}, which still has conflict marks: Scient can't tell whether the file moved. Settle {marked}, then sync again.} other {{path} waits with {marked}, which still have conflict marks: Scient can't tell whether the file moved. Settle {marked}, then sync again.}}",
              { count: markedPaths.length, path, marked: markedPaths.join(", ") },
            ),
          )
        : resolve(
            msg(
              "{path} is held because Scient can't tell whether marked work moved to it. Settle the conflict marks, then sync again.",
              { path },
            ),
          ),
    ),
  ];
}

/**
 * What a read of the changes says when there is nothing to do, so the tab never shows an
 * empty page; null when the read lists changes, conflicts or held files.
 */
export function readNothingToDoLine(
  review: ScientOverleafReview,
  resolve: MessageResolver = m,
): string | null {
  return review.upToDate && heldPaths(review).length === 0
    ? resolve(msg("Up to date with Overleaf: nothing to bring in or send."))
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
function countsTitle(
  review: ScientOverleafReview,
  sent: boolean,
  held: number,
  resolve: MessageResolver,
): string {
  const incoming = review.incoming.length;
  const outgoing = sent ? review.outgoing.length : 0;
  if (incoming === 0 && outgoing === 0)
    return held > 0
      ? resolve(
          msg(
            "{count, plural, one {{count} file waits for conflicts} other {{count} files wait for conflicts}}",
            { count: held },
          ),
        )
      : resolve(msg("Up to date with Overleaf"));
  if (incoming > 0 && outgoing > 0)
    return resolve(
      msg(
        "{incoming, plural, one {{incoming} file came in} other {{incoming} files came in}}, {outgoing, plural, one {{outgoing} was sent} other {{outgoing} were sent}}",
        { incoming, outgoing },
      ),
    );
  if (incoming > 0)
    return resolve(
      msg("{count, plural, one {{count} file came in} other {{count} files came in}}", {
        count: incoming,
      }),
    );
  return resolve(
    msg("{count, plural, one {{count} file was sent} other {{count} files were sent}}", {
      count: outgoing,
    }),
  );
}

/** The lines every review adds: renames and older versions once sent, earlier sends, sizes. */
function warningLines(
  review: ScientOverleafReview,
  sent: boolean,
  resolve: MessageResolver,
): string[] {
  const lines: string[] = [];
  const renames = sent ? review.warnings.filter((warning) => warning.kind === "rename") : [];
  if (renames.length > 0) {
    lines.push(
      renames.length === 1 && renames[0]?.from && renames[0].to
        ? resolve(
            msg(
              "Renamed {from} to {to}. Overleaf drops comments and tracked changes on renamed files.",
              { from: renames[0].from, to: renames[0].to },
            ),
          )
        : resolve(
            msg(
              "{count, plural, one {Renamed {count} file. Overleaf drops comments and tracked changes on renamed files.} other {Renamed {count} files. Overleaf drops comments and tracked changes on renamed files.}}",
              { count: renames.length },
            ),
          ),
    );
  }
  const older = sent
    ? review.warnings.filter((warning) => warning.kind === "restores-older-version")
    : [];
  // Said with the files: an older version replaces collaborators' newer text on Overleaf.
  if (older.length === 1 && older[0]?.path)
    lines.push(
      resolve(msg("Sent a version of {path} that Overleaf had before.", { path: older[0].path })),
    );
  else if (older.length > 0)
    lines.push(
      resolve(
        msg(
          "{count, plural, one {Sent versions of {count} file that Overleaf had before.} other {Sent versions of {count} files that Overleaf had before.}}",
          { count: older.length },
        ),
      ),
    );
  for (const warning of review.warnings) {
    if (warning.kind === "unresolved-publication") {
      lines.push(
        resolve(
          msg(
            "An earlier send never got an answer. Scient never retries it, and Overleaf still doesn't show whether it arrived; this sync may carry some of the same changes again.",
          ),
        ),
      );
    }
  }
  if (
    review.warnings.some(
      (warning) =>
        warning.kind === "over-recommended-size" || warning.kind === "editable-total-exceeded",
    )
  ) {
    lines.push(resolve(msg("The project is bigger than Overleaf recommends.")));
  }
  for (const warning of review.warnings) {
    if (warning.kind === "too-large-to-edit" && warning.path) {
      lines.push(resolve(msg("{path} is too big to edit on Overleaf.", { path: warning.path })));
    }
  }
  return lines;
}

type SyncedResult = Extract<ScientOverleafSyncResult, { _tag: "synced" }>;

/**
 * Whether all of Overleaf's changes are in the folder: the apply completed, or it stopped
 * only at conflict marks in held files, which is the one unfinished apply the server still
 * sends from. A replanned apply wrote nothing; any other may have stopped partway.
 */
export function overleafChangesCameIn(result: SyncedResult): boolean {
  return (
    result.outcome === "complete" ||
    (result.outcome === "attention" &&
      !(result.publication._tag === "blocked" && result.publication.reason === "attention"))
  );
}

/** What the sync's send did, when it didn't simply arrive. */
function publicationLine(
  publication: SyncedResult["publication"],
  held: ReadonlyArray<string>,
  resolve: MessageResolver,
): { readonly line: string | null; readonly tone: OverleafResultView["tone"] } {
  switch (publication._tag) {
    case "none":
    case "accepted":
      return { line: null, tone: "success" };
    case "blocked":
      switch (publication.reason) {
        case "markers":
          return {
            line: resolve(
              msg(
                "{count, plural, one {Nothing was sent: {count} file still has conflict marks. Settle them and sync again.} other {Nothing was sent: {count} files still have conflict marks. Settle them and sync again.}}",
                { count: held.length || 1 },
              ),
            ),
            tone: "warning",
          };
        case "kept-copy-changed":
          return {
            line: resolve(
              msg(
                "Nothing was sent: a kept copy changed during this sync. The next sync checks again.",
              ),
            ),
            tone: "warning",
          };
        case "staging":
          return {
            line: resolve(
              msg("Nothing was sent: an earlier change left folders to tidy. Sync again."),
            ),
            tone: "warning",
          };
        default:
          return {
            line: resolve(
              msg(
                "Nothing was sent: part of the folder needs attention first. Settle it, then sync again.",
              ),
            ),
            tone: "warning",
          };
      }
    case "not-verified":
      return {
        line: resolve(
          msg(
            "Nothing was sent: the folder changed during the sync. That edit goes with the next sync.",
          ),
        ),
        tone: "warning",
      };
    case "not-sent":
      return {
        line:
          publication.reason === undefined
            ? resolve(
                msg("Nothing was sent: the Overleaf token changed during the sync. Sync again."),
              )
            : publication.reason === "rate-limited"
              ? resolve(
                  msg(
                    "Nothing was sent: Overleaf is limiting Git requests right now. Sync again in a minute.",
                  ),
                )
              : resolve(
                  msg("Nothing was sent. {reason}", {
                    reason: refusalText({ reason: publication.reason }, "sync", false, resolve),
                  }),
                ),
        tone: "warning",
      };
    case "out-of-date":
      return {
        line: resolve(msg("Overleaf changed again while this sync was sending. Sync again.")),
        tone: "warning",
      };
    case "unknown":
      return {
        line: resolve(
          msg(
            "Scient couldn't tell whether Overleaf received this send. It never sends it twice; the next sync checks.",
          ),
        ),
        tone: "warning",
      };
  }
}

/** The lines every finished or waiting sync adds about other agents and worktrees. */
function contextLines(
  activity: ReadonlyArray<{ readonly title: string }> | null,
  linkedElsewhere: boolean,
  resolve: MessageResolver,
): string[] {
  const lines: string[] = [];
  if (linkedElsewhere) {
    lines.push(
      resolve(
        msg(
          "Synced the main copy. Your edits in this worktree aren't in it until they're merged there.",
        ),
      ),
    );
  }
  if (activity === null) {
    lines.push(
      resolve(msg("Scient couldn't check whether other agents are working in this copy.")),
    );
  } else if (activity.length === 1) {
    lines.push(
      resolve(
        msg("Another agent is working in this copy: {title}.", { title: activity[0]!.title }),
      ),
    );
  } else if (activity.length > 1) {
    lines.push(
      resolve(
        msg(
          "{count, plural, one {{count} other agent is working in this copy.} other {{count} other agents are working in this copy.}}",
          { count: activity.length },
        ),
      ),
    );
  }
  return lines;
}

/**
 * An interrupted earlier sync an operation (a sync, or a read of the changes)
 * settled before its own work, which wrote the folder.
 */
export function settledText(
  settled: { readonly outcome: string },
  resolve: MessageResolver = m,
): string {
  return settled.outcome === "complete"
    ? resolve(msg("It first finished an interrupted sync, which wrote the folder."))
    : resolve(msg("It first settled an interrupted sync without finishing it; sync again."));
}

/** What a sync did before its outcome: an interrupted sync it finished, and a retry. */
function progressLines(result: ScientOverleafSyncResult, resolve: MessageResolver): string[] {
  if (result._tag === "duplicate") return [];
  return [
    ...(!result.settled ? [] : [settledText(result.settled, resolve)]),
    ...(result.retried
      ? [
          resolve(
            msg(
              "Overleaf changed while sending, so it ran again; the first run's changes are in the folder.",
            ),
          ),
        ]
      : []),
  ];
}

/** A sync whose apply didn't bring all of Overleaf's changes in; nothing was sent. */
function unfinishedApplyView(
  result: SyncedResult,
  progress: string[],
  resolve: MessageResolver,
): OverleafResultView {
  const context = contextLines(result.activity, result.linkedElsewhere, resolve);
  if (result.outcome === "replan")
    return {
      title: resolve(msg("Nothing came in")),
      lines: [
        ...progress,
        resolve(
          msg(
            "The folder changed while Overleaf's changes were being written, so nothing was written or sent. Sync again.",
          ),
        ),
        ...context,
      ],
      tone: "warning",
      hasChanges: false,
      needsDecision: false,
    };
  return {
    title:
      result.review.incoming.length > 0
        ? resolve(msg("Overleaf's changes were applied as far as the folder allowed"))
        : resolve(msg("Part of the folder needs attention")),
    lines: [
      ...progress,
      ...(result.interrupted > 0
        ? [
            resolve(
              msg(
                "{count, plural, one {Writing stopped partway in {count} file. The next sync shows them as conflicts to settle.} other {Writing stopped partway in {count} files. The next sync shows them as conflicts to settle.}}",
                { count: result.interrupted },
              ),
            ),
          ]
        : result.markerPaths.length === 0
          ? [
              resolve(
                msg(
                  "A file or a kept copy changed while Overleaf's changes were written. Check it.",
                ),
              ),
            ]
          : []),
      ...reviewHeldLines(result.review, result.markerPaths, resolve),
      resolve(msg("Nothing was sent. Sync again once the folder is settled.")),
      ...context,
    ],
    tone: "warning",
    hasChanges: false,
    needsDecision: false,
  };
}

export function overleafResultView(
  result: ScientOverleafSyncResult,
  resolve: MessageResolver = m,
): OverleafResultView {
  const progress = progressLines(result, resolve);
  switch (result._tag) {
    case "synced": {
      if (!overleafChangesCameIn(result)) return unfinishedApplyView(result, progress, resolve);
      const sent = result.publication._tag === "accepted";
      const held = heldPaths(result.review, result.markerPaths);
      const publication = publicationLine(result.publication, held, resolve);
      const lines = [
        ...progress,
        ...(publication.line ? [publication.line] : []),
        ...warningLines(result.review, sent, resolve),
        ...reviewHeldLines(result.review, result.markerPaths, resolve),
        ...(result.interrupted > 0
          ? [
              resolve(
                msg(
                  "{count, plural, one {An interrupted sync left {count} file to settle.} other {An interrupted sync left {count} files to settle.}}",
                  { count: result.interrupted },
                ),
              ),
            ]
          : []),
        ...contextLines(result.activity, result.linkedElsewhere, resolve),
      ];
      return {
        title: countsTitle(result.review, sent, held.length, resolve),
        lines,
        tone: publication.tone,
        hasChanges: result.review.incoming.length > 0 || result.review.outgoing.length > 0,
        needsDecision: false,
      };
    }
    case "needs-decision": {
      const count = result.review.conflicts.length;
      return {
        title: resolve(
          msg(
            "{count, plural, one {{count} conflict with Overleaf} other {{count} conflicts with Overleaf}}",
            { count },
          ),
        ),
        lines: [
          ...progress,
          progress.length === 0
            ? resolve(
                msg("Nothing was changed yet. Choose how to settle each one, then sync again."),
              )
            : resolve(
                msg(
                  "None of these was changed yet. Choose how to settle each one, then sync again.",
                ),
              ),
          ...reviewHeldLines(result.review, [], resolve),
          ...contextLines(result.activity, result.linkedElsewhere, resolve),
        ],
        tone: "warning",
        hasChanges: true,
        needsDecision: true,
      };
    }
    case "refused":
      return {
        title: resolve(msg("Couldn't sync with Overleaf")),
        lines: [...progress, refusalText(result.refusal, "sync", progress.length > 0, resolve)],
        tone: "error",
        hasChanges: false,
        needsDecision: false,
      };
    case "unsettled":
      return {
        title: resolve(msg("Couldn't sync with Overleaf")),
        lines: [
          ...progress,
          refusalText({ reason: result.reason }, "sync", progress.length > 0, resolve),
        ],
        tone: "error",
        hasChanges: false,
        needsDecision: false,
      };
    case "duplicate":
      return {
        title: resolve(msg("That sync already ran")),
        lines: [],
        tone: "info",
        hasChanges: false,
        needsDecision: false,
      };
    case "cancelled":
      return {
        title: resolve(msg("Sync cancelled")),
        lines: progress.length === 0 ? [resolve(msg("Nothing was changed."))] : progress,
        tone: "info",
        hasChanges: false,
        needsDecision: false,
      };
  }
}

/** What one unreadable record holds back, and what the user can do about it. */
export function unreadableRecordLines(
  record: ScientOverleafUnreadableRecord,
  resolve: MessageResolver = m,
): {
  readonly state: string;
  readonly holds: string;
} {
  const state =
    record.kind === "newer"
      ? record.unfinished === true
        ? resolve(
            msg(
              "A newer version of Scient made this link, and its last sync didn't finish. Open that version to finish it; Scient keeps the record until then.",
            ),
          )
        : record.unfinished === null
          ? resolve(
              msg(
                "A newer version of Scient made this link, and this version can't tell whether its last sync finished. Open that version to check; Scient keeps the record until then.",
              ),
            )
          : resolve(
              msg(
                "A newer version of Scient made this link. As far as this version can tell, its last sync finished.",
              ),
            )
      : record.setAside === "confirm"
        ? resolve(
            msg(
              "This record is damaged, and its last sync stopped part-way. Setting it aside stops Scient guarding the files that sync left in the folder.",
            ),
          )
        : record.unfinished === false
          ? resolve(msg("This record is damaged. No sync is waiting on it."))
          : resolve(
              msg("This record is damaged, and it doesn't say whether a sync stopped part-way."),
            );
  const until = record.setAside === "held" ? "held" : "other";
  const holds =
    record.holds === "linking"
      ? resolve(
          msg(
            "{until, select, held {Until then, Scient won't link folders.} other {Until it's set aside, Scient won't link folders.}}",
            { until },
          ),
        )
      : record.holds === "every-checkout"
        ? resolve(
            msg(
              "{until, select, held {Until then, Scient won't link folders or change any project's files in bulk, for example when switching branches.} other {Until it's set aside, Scient won't link folders or change any project's files in bulk, for example when switching branches.}}",
              { until },
            ),
          )
        : resolve(
            msg(
              "{until, select, held {Until then, Scient won't link folders or change this project's files in bulk, for example when switching branches.} other {Until it's set aside, Scient won't link folders or change this project's files in bulk, for example when switching branches.}}",
              { until },
            ),
          );
  return { state, holds };
}

/** The button that sets an unreadable record aside, if it can be: knowingly, when its unfinished sync loses its protection. */
export function setAsideAction(
  record: Pick<ScientOverleafUnreadableRecord, "setAside">,
  resolve: MessageResolver = m,
): { readonly label: string; readonly acceptUnfinished: boolean } | null {
  switch (record.setAside) {
    case "held":
      return null;
    case "confirm":
      return { label: resolve(msg("Set aside anyway")), acceptUnfinished: true };
    case "allowed":
      return { label: resolve(msg("Set aside")), acceptUnfinished: false };
  }
}

/** What Undo will do to a file a send changed, as one short verb: the reverse of the send. */
export function undoChangeLabel(
  change: ScientOverleafChange,
  resolve: MessageResolver = m,
): string {
  switch (change.kind) {
    case "modified":
      return resolve(msg("Restore", { $context: "undo action for a file a send modified" }));
    case "added":
      return resolve(msg("Remove", { $context: "undo action for a file a send added" }));
    case "deleted":
      return resolve(msg("Recreate", { $context: "undo action for a file a send deleted" }));
    case "renamed":
      return resolve(msg("Rename back", { $context: "undo action for a file a send renamed" }));
  }
}

const UNDO_SKIPPED: Record<
  Extract<ScientOverleafUndoResult, { _tag: "undone" }>["skipped"][number]["reason"],
  string
> = {
  changed: msg("edited since", { $context: "why undo left a file as it is" }),
  "already-undone": msg("already back", { $context: "why undo left a file as it is" }),
  "name-clash": msg("name in use", { $context: "why undo left a file as it is" }),
  "too-large": msg("too large", { $context: "why undo left a file as it is" }),
  "kept-only-here": msg("kept only here", { $context: "why undo left a file as it is" }),
};

const UNDO_NOT_ELIGIBLE: Record<
  Extract<ScientOverleafUndoResult, { _tag: "not-eligible" }>["reason"],
  string
> = {
  "not-recorded": msg("Scient no longer records this send."),
  unresolved: msg("Overleaf never answered this send."),
  "not-sent": msg("This send never went out."),
  "out-of-date": msg("Overleaf refused this send, so it changed nothing."),
  "history-unavailable": msg("Scient no longer holds what this send replaced."),
};

/** Only a finished apply with an answered send can be dismissed as successful. */
export function overleafSyncSucceeded(result: ScientOverleafSyncResult): boolean {
  return (
    result._tag === "synced" &&
    result.outcome === "complete" &&
    (result.publication._tag === "none" || result.publication._tag === "accepted") &&
    result.markerPaths.length === 0 &&
    heldPaths(result.review).length === 0
  );
}

export function overleafUndoSucceeded(result: ScientOverleafUndoResult): boolean {
  return (
    result._tag === "undone" &&
    result.outcome === "complete" &&
    result.skipped.length === 0 &&
    result.sync._tag !== "not-synced" &&
    overleafSyncSucceeded(result.sync)
  );
}

/** What an undo did (design section 4.3): what it put back, what it left and why, then its sync. */
export function overleafUndoView(
  result: ScientOverleafUndoResult,
  resolve: MessageResolver = m,
): Pick<OverleafResultView, "title" | "lines" | "tone" | "needsDecision"> {
  switch (result._tag) {
    case "undone": {
      const skipped =
        result.skipped.length === 0
          ? []
          : [
              resolve(
                msg("Left as it is: {files}.", {
                  files: result.skipped
                    .map((skip) => `${skip.path} (${resolve(UNDO_SKIPPED[skip.reason])})`)
                    .join(", "),
                }),
              ),
            ];
      const effects = [
        ...(result.removed.length > 0
          ? [resolve(msg("Removed locally: {paths}.", { paths: result.removed.join(", ") }))]
          : []),
        ...(result.restored.length > 0
          ? [
              resolve(
                msg("Put back an earlier version locally: {paths}.", {
                  paths: result.restored.join(", "),
                }),
              ),
            ]
          : []),
        ...(result.recreated.length > 0
          ? [resolve(msg("Recreated locally: {paths}.", { paths: result.recreated.join(", ") }))]
          : []),
      ];
      // The sync after the undo: what it sent and any conflict it stopped at, or that
      // none ran because the undo stopped partway.
      const synced =
        result.sync._tag === "not-synced" ? null : overleafResultView(result.sync, resolve);
      const syncLines =
        synced === null
          ? [resolve(msg("Undo stopped partway; nothing was sent. Check the files, then sync."))]
          : [`${synced.title}.`, ...synced.lines];
      const needsDecision = synced?.needsDecision ?? false;
      switch (result.outcome) {
        case null:
          return {
            title: resolve(msg("Nothing was put back")),
            lines: [...skipped, ...syncLines],
            tone: "info",
            needsDecision,
          };
        case "replan":
          return {
            title: resolve(msg("Nothing was put back")),
            lines: [resolve(msg("The folder changed during the undo.")), ...syncLines],
            tone: "warning",
            needsDecision,
          };
        case "attention":
          return {
            title: resolve(msg("Undo needs attention")),
            lines: [...skipped, ...syncLines],
            tone: "warning",
            needsDecision,
          };
        default:
          return {
            title: resolve(msg("Undo complete")),
            lines: [...effects, ...skipped, ...syncLines],
            tone: synced?.tone ?? "success",
            needsDecision,
          };
      }
    }
    case "not-eligible":
      return {
        title: resolve(msg("Can't undo this send")),
        lines: [resolve(UNDO_NOT_ELIGIBLE[result.reason])],
        tone: "error",
        needsDecision: false,
      };
    case "refused":
      return {
        title: resolve(msg("Couldn't undo")),
        lines: [refusalText(result.refusal, "sync", false, resolve)],
        tone: "error",
        needsDecision: false,
      };
    case "duplicate":
      return {
        title: resolve(msg("That undo already ran")),
        lines: [],
        tone: "info",
        needsDecision: false,
      };
    case "cancelled":
      return {
        title: resolve(msg("Undo cancelled")),
        lines: [resolve(msg("Nothing was changed."))],
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
