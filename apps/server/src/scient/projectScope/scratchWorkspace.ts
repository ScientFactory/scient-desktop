import {
  GitManagerError,
  VcsExecutableUnavailableError,
  VcsProcessSpawnError,
} from "@t3tools/contracts";
import { SCIENT_DESKTOP_IDENTITY } from "@t3tools/shared/scientDesktopIdentity";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../../config.ts";

const isGitManagerError = Schema.is(GitManagerError);
const isExecutableUnavailable = Schema.is(VcsExecutableUnavailableError);
const isSpawnError = Schema.is(VcsProcessSpawnError);

/** Recognizes missing Git without treating a failed repository probe as absence. */
export function isGitMissing(error: unknown): boolean {
  const cause = isGitManagerError(error) ? error.cause : error;
  return (
    (isExecutableUnavailable(cause) && cause.kind === "git" && cause.command === "git") ||
    (isSpawnError(cause) &&
      cause.command === "git" &&
      PlatformError.isPlatformError(cause.cause) &&
      cause.cause.reason._tag === "NotFound")
  );
}

/** Checks canonical ancestry, including dangling or unreadable .git entries. */
const isOutsideGitAncestry = Effect.fn("ScratchWorkspace.isOutsideGitAncestry")(function* (
  directory: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  let current = yield* fs.realPath(directory);
  while (true) {
    if ((yield* fs.readDirectory(current)).some((entry) => entry.toLowerCase() === ".git"))
      return false;
    const parent = path.dirname(current);
    if (parent === current) return true;
    current = parent;
  }
});

/** Missing-Git authority is limited to the configured Scratch root and direct children. */
export const isPlainHostScratchDirectory = Effect.fn(
  "ScratchWorkspace.isPlainHostScratchDirectory",
)(function* (config: ServerConfig.ServerConfig["Service"], canonicalDirectory: string) {
  if (!SCIENT_DESKTOP_IDENTITY.projectlessThreadsEnabled) return false;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = ServerConfig.scratchWorkspaceRoot(config, path);
  const canonicalParent = yield* fs.realPath(path.dirname(root));
  const expectedRoot = path.join(canonicalParent, path.basename(root));
  const canonicalRoot = yield* fs.realPath(root);
  if (canonicalRoot !== expectedRoot) return false;
  if (canonicalDirectory !== canonicalRoot && path.dirname(canonicalDirectory) !== canonicalRoot) {
    return false;
  }
  return yield* isOutsideGitAncestry(canonicalDirectory);
});

/** Advertisement and allocation reject redirected roots before the first folder exists. */
export const isConfiguredScratchRootOutsideGit = Effect.fn(
  "ScratchWorkspace.isConfiguredScratchRootOutsideGit",
)(function* (config: ServerConfig.ServerConfig["Service"]) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = ServerConfig.scratchWorkspaceRoot(config, path);
  const parent = yield* fs.realPath(path.dirname(root));
  if ((yield* fs.readDirectory(parent)).includes(path.basename(root))) {
    return yield* isPlainHostScratchDirectory(config, yield* fs.realPath(root));
  }
  return yield* isOutsideGitAncestry(parent);
});
