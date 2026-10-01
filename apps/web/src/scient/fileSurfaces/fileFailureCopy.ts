import type { ProjectFileErrorReason, ProjectFileFailure } from "@t3tools/contracts";

/** What a file surface says when it cannot show a file. */
export interface FileFailureCopy {
  readonly title: string;
  readonly description: string;
  /** The underlying error, shown only on request; null when it adds nothing. */
  readonly details: string | null;
  /** Whether reading again could plausibly succeed. */
  readonly retryable: boolean;
}

export const UNSUPPORTED_PREVIEW_TITLE = "Preview unavailable";

/**
 * A server that predates location-independent reads refused the path as
 * outside the project. Current servers read such files read-only instead, so
 * this only reaches older environments, where opening the absolute path works.
 */
export function isOutsideProjectFailure(failure: ProjectFileFailure | null): boolean {
  return failure === "workspace_path_outside_root" || failure === "resolved_path_outside_root";
}

/**
 * Whether a failed read already explains why nothing can be shown, so media
 * and document viewers should not try (and fail again with less to say).
 * Binary media never reads as text, so a plain `binary_file` failure does not
 * count; a missing file, a denied read, or a host path that is not a regular
 * file does. A workspace directory opens the explorer instead.
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
 * What the computer that holds a file said when it refused a read. The copy
 * states only that: `EACCES` is a permission on the file or one of its
 * folders; `EPERM` is the system itself declining, which on a Mac is usually,
 * but not provably, its privacy protection. An older server reports neither
 * code, so nothing more specific is claimed. The settings are on the host,
 * which for a paired or remote viewer is not the device in hand.
 */
export function readDeniedDescription(input: {
  readonly osErrorCode: string | null;
  /** Operating system of the environment that owns the file, e.g. `darwin`. */
  readonly hostOs: string | null;
}): string {
  if (input.osErrorCode === "EACCES") {
    return "The operating system denied access to this file. Check the permissions of the file and its folders on the computer that holds it.";
  }
  if (input.osErrorCode === "EPERM" && input.hostOs === "darwin") {
    return "macOS on the computer that holds this file didn't allow Scient to read it. If it is in a protected folder, allow access in System Settings → Privacy & Security there.";
  }
  return "The operating system denied access to this file.";
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
}): FileFailureCopy {
  const details = input.message?.trim() || null;
  switch (input.reason) {
    case "not_found":
      // With files to choose from, the choice is the point, not the failure.
      return (input.candidateCount ?? 0) > 0
        ? {
            title: "Which file did you mean?",
            description: "Nothing exists at this location.",
            details,
            retryable: true,
          }
        : {
            title: "File not found",
            description:
              "Nothing exists at this location. It may have been moved, renamed, or deleted.",
            details,
            retryable: true,
          };
    case "permission_denied":
      // No settings shortcut: even `EPERM` on a Mac does not prove a privacy
      // setting denied the read, and the setting lives on the host.
      return {
        title: "Access denied",
        description: readDeniedDescription({
          osErrorCode: input.osErrorCode ?? null,
          hostOs: input.hostOs ?? null,
        }),
        details,
        retryable: true,
      };
    default:
      break;
  }
  switch (input.failure) {
    case "binary_file":
      return {
        title: UNSUPPORTED_PREVIEW_TITLE,
        description: "Scient can't preview this type of file yet.",
        details: null,
        retryable: false,
      };
    case "workspace_path_outside_root":
    case "resolved_path_outside_root":
      return {
        title: "Outside this project",
        description: "This file is outside the project folder. You can still open it read-only.",
        details,
        retryable: false,
      };
    case "path_not_file":
      return {
        title: "Not a file",
        description: "This path points to a folder or another item that isn't a regular file.",
        details,
        retryable: true,
      };
    default:
      return {
        title: "Couldn't open this file",
        description: "It may have been moved, renamed, or deleted, or it can't be read right now.",
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
export function staleCopyNotice(reason: ProjectFileErrorReason | null): string {
  switch (reason) {
    case "not_found":
      return "This file is no longer at this location. Showing the last available copy.";
    case "permission_denied":
      return "This file can no longer be read. Showing the last available copy.";
    default:
      return "The latest version could not be loaded. Showing the last available copy.";
  }
}

export type MediaFailureKind = "image" | "audio" | "video" | "document";

/**
 * Copy for a preview whose media or document frame failed to load. The
 * browser does not say why, so the description names the likely causes.
 */
export const MEDIA_FAILURE_COPY: Readonly<
  Record<MediaFailureKind, Pick<FileFailureCopy, "title" | "description">>
> = {
  image: {
    title: "Couldn't display this image",
    description: "It may have been moved, or its format may not be supported here.",
  },
  audio: {
    title: "Couldn't play this audio",
    description: "It may have been moved, or its format may not be supported here.",
  },
  video: {
    title: "Couldn't play this video",
    description: "It may have been moved, or its format may not be supported here.",
  },
  document: {
    title: "Couldn't load this preview",
    description: "Scient couldn't prepare a preview of this file.",
  },
};
