import {
  SCIENT_SOURCE_FILES_DIRECTORY,
  SCIENT_SOURCES_DIRECTORY,
} from "@scientfactory/scient-sources/store";

function containsFolder(path: string, folder: string) {
  const wanted = folder.split("/");
  const segments = path.split(/[\\/]/u).map((segment) => segment.toLowerCase());
  return segments.some((_, start) =>
    wanted.every((segment, offset) => segments[start + offset] === segment),
  );
}

/** Any path inside a project's Sources folder. Matched case-insensitively, as on macOS. */
export const isInSourcesFolder = (path: string) => containsFolder(path, SCIENT_SOURCES_DIRECTORY);

/**
 * Sources keeps one content-addressed file per imported PDF, shared by every
 * attachment with those bytes. Only the Sources store writes there; the shared
 * file writer refuses, at the target it resolves itself.
 */
export const isInSourceFileStore = (path: string) =>
  containsFolder(path, SCIENT_SOURCE_FILES_DIRECTORY);
