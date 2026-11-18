import type { ProjectFileErrorReason, ProjectFileFailure } from "@t3tools/contracts";
import { msg } from "gt-react";

import { m, type MessageResolver } from "~/i18n/messages";

/** What a file surface says when it cannot show a file. */
export interface FileFailureCopy {
  readonly title: string;
  readonly description: string;
  /** The underlying error, shown only on request; null when it adds nothing. */
  readonly details: string | null;
  /** Whether reading again could plausibly succeed. */
  readonly retryable: boolean;
}

/** A `msg()` string: resolve it where it shows. */
export const UNSUPPORTED_PREVIEW_TITLE = msg("Preview unavailable");

/**
 * A server that predates location-independent reads refused the path as
 * outside the project. Current servers read such files read-only instead, so
 * this only reaches older environments, where opening the absolute path works.
 */
export function isOutsideProjectFailure(failure: ProjectFileFailure | null): boolean {
  return failure === "workspace_path_outside_root" || failure === "resolved_path_outside_root";
}

/**
 * A binary_file text-read failure does not prove media is unreadable. Missing/denied/nonregular
 * host paths do; avoid retrying those through a less informative viewer. Workspace directories
 * belong in the explorer.
 */
export function readFailureBlocksPreview(input: {
  readonly hasData: boolean;
  readonly failure: ProjectFileFailure | null;
  readonly reason: ProjectFileErrorReason | null;
  readonly isHostFile: boolean;
}): boolean {
  if (input.hasData) return false;
  return input.reason !== null || (input.failure === "path_not_file" && input.isHostFile);
}

/**
 * Report only host-proven causes: EACCES is file/ancestor permission; EPERM is system refusal, not
 * proof of macOS privacy denial. Settings belong to the file's host, which may differ from the
 * viewing device.
 */
function readDeniedDescription(input: {
  readonly osErrorCode: string | null;
  /** Operating system of the environment that owns the file, e.g. `darwin`. */
  readonly hostOs: string | null;
}): string {
  if (input.osErrorCode === "EACCES") {
    return msg(
      "The operating system denied access to this file. Check the permissions of the file and its folders on the computer that holds it.",
    );
  }
  if (input.osErrorCode === "EPERM" && input.hostOs === "darwin") {
    return msg(
      "macOS on the computer that holds this file didn't allow Scient to read it. If it is in a protected folder, allow access in System Settings → Privacy & Security there.",
    );
  }
  return msg("The operating system denied access to this file.");
}

/**
 * Plain-language copy for a failed workspace or host file read. The operating
 * system's reason wins when the server reports one; otherwise only failures the
 * server classifies distinctly get a specific message, and the fallback must
 * not claim a cause.
 */
export function fileReadFailureCopy(input: {
  readonly failure: ProjectFileFailure | null;
  readonly reason?: ProjectFileErrorReason | null;
  readonly osErrorCode?: string | null;
  readonly hostOs?: string | null;
  readonly message: string | null;
  /** How many workspace files the missing path may have meant. */
  readonly candidateCount?: number;
  readonly resolve?: MessageResolver;
}): FileFailureCopy {
  const resolve = input.resolve ?? m;
  const details = input.message?.trim() || null;
  switch (input.reason) {
    case "not_found":
      // With files to choose from, the choice is the point, not the failure.
      return (input.candidateCount ?? 0) > 0
        ? {
            title: resolve(msg("Which file did you mean?")),
            description: resolve(msg("Nothing exists at this location.")),
            details,
            retryable: true,
          }
        : {
            title: resolve(msg("File not found")),
            description: resolve(
              msg("Nothing exists at this location. It may have been moved, renamed, or deleted."),
            ),
            details,
            retryable: true,
          };
    case "permission_denied":
      // No settings shortcut: even `EPERM` on a Mac does not prove a privacy
      // setting denied the read, and the setting lives on the host.
      return {
        title: resolve(msg("Access denied")),
        description: resolve(
          readDeniedDescription({
            osErrorCode: input.osErrorCode ?? null,
            hostOs: input.hostOs ?? null,
          }),
        ),
        details,
        retryable: true,
      };
    default:
      break;
  }
  switch (input.failure) {
    case "binary_file":
      return {
        title: resolve(UNSUPPORTED_PREVIEW_TITLE),
        description: resolve(msg("Scient can't preview this type of file yet.")),
        details: null,
        retryable: false,
      };
    case "workspace_path_outside_root":
    case "resolved_path_outside_root":
      return {
        title: resolve(msg("Outside this project")),
        description: resolve(
          msg("This file is outside the project folder. You can still open it read-only."),
        ),
        details,
        retryable: false,
      };
    case "path_not_file":
      return {
        title: resolve(msg("Not a file")),
        description: resolve(
          msg("This path points to a folder or another item that isn't a regular file."),
        ),
        details,
        retryable: true,
      };
    default:
      return {
        title: resolve(msg("Couldn't open this file")),
        description: resolve(
          msg("It may have been moved, renamed, or deleted, or it can't be read right now."),
        ),
        details,
        retryable: true,
      };
  }
}

/**
 * The caution shown above the last good copy of a file whose latest read
 * failed. It names the cause when the system gave one: a file renamed or
 * moved while it was open is the common case.
 */
export function staleCopyNotice(
  reason: ProjectFileErrorReason | null,
  resolve: MessageResolver = m,
): string {
  switch (reason) {
    case "not_found":
      return resolve(
        msg("This file is no longer at this location. Showing the last available copy."),
      );
    case "permission_denied":
      return resolve(msg("This file can no longer be read. Showing the last available copy."));
    default:
      return resolve(
        msg("The latest version could not be loaded. Showing the last available copy."),
      );
  }
}

/**
 * What an editor that keeps its last confirmed version on screen says when
 * that document could not be re-read from disk. The operating system's reason
 * names the cause; without one there is nothing specific to claim, and the
 * editor keeps its own generic notice.
 */
export function refreshFailureNoticeCopy(
  failure: { readonly reason: ProjectFileErrorReason; readonly osErrorCode: string | null } | null,
  hostOs: string | null,
  resolve: MessageResolver = m,
): { readonly title: string; readonly description: string } | null {
  switch (failure?.reason) {
    case "not_found":
      return {
        title: resolve(msg("This file is no longer at this location")),
        description: resolve(
          msg(
            "It may have been moved, renamed, or deleted. The last confirmed version is still open.",
          ),
        ),
      };
    case "permission_denied":
      return {
        title: resolve(msg("This file can no longer be read")),
        description: `${resolve(readDeniedDescription({ osErrorCode: failure.osErrorCode, hostOs }))} ${resolve(msg("The last confirmed version is still open."))}`,
      };
    default:
      return null;
  }
}

/**
 * The one line shown above a file that can be viewed but not edited. It names
 * the reason when the environment gave it: the file lives outside the project.
 */
export function readOnlyNotice(outsideWorkspace: boolean, resolve: MessageResolver = m): string {
  return outsideWorkspace
    ? resolve(msg("This file is read-only because it is outside this project."))
    : resolve(msg("This file is read-only in Files."));
}

export type MediaFailureKind = "image" | "audio" | "video" | "document";

/**
 * Copy for a preview whose media or document frame failed to load. The
 * browser does not say why, so the description names the likely causes.
 * The texts are `msg()` strings: resolve them where they show.
 */
export const MEDIA_FAILURE_COPY: Readonly<
  Record<MediaFailureKind, Pick<FileFailureCopy, "title" | "description">>
> = {
  image: {
    title: msg("Couldn't display this image"),
    description: msg("It may have been moved, or its format may not be supported here."),
  },
  audio: {
    title: msg("Couldn't play this audio"),
    description: msg("It may have been moved, or its format may not be supported here."),
  },
  video: {
    title: msg("Couldn't play this video"),
    description: msg("It may have been moved, or its format may not be supported here."),
  },
  document: {
    title: msg("Couldn't load this preview"),
    description: msg("Scient couldn't prepare a preview of this file."),
  },
};

/** `MEDIA_FAILURE_COPY[kind]` resolved; components pass `useMessages()`. */
export function mediaFailureCopy(
  kind: MediaFailureKind,
  resolve: MessageResolver = m,
): Pick<FileFailureCopy, "title" | "description"> {
  const copy = MEDIA_FAILURE_COPY[kind];
  return { title: resolve(copy.title), description: resolve(copy.description) };
}
