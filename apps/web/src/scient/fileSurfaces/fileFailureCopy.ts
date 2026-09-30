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
 * Plain-language copy for a failed workspace or host file read. The operating
 * system's reason wins when the server reports one; otherwise only failures the
 * server classifies distinctly get a specific message, and the fallback must
 * not claim a cause.
 */
export function fileReadFailureCopy(input: {
  readonly failure: ProjectFileFailure | null;
  readonly reason?: ProjectFileErrorReason | null;
  readonly message: string | null;
}): FileFailureCopy {
  const details = input.message?.trim() || null;
  switch (input.reason) {
    case "not_found":
      return {
        title: "File not found",
        description:
          "Nothing exists at this location. It may have been moved, renamed, or deleted.",
        details,
        retryable: true,
      };
    case "permission_denied":
      return {
        title: "Access denied",
        description:
          "This file's permissions, or your system's privacy settings, don't let Scient read it.",
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
