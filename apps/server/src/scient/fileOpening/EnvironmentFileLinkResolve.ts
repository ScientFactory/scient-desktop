// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalDate:off
/**
 * Resolves the file a chat link means, on the machine that owns the files.
 *
 * A link is opened exactly as written whenever its location exists. Agents
 * often write paths relative to the wrong directory, though, so when nothing
 * exists there the workspace is searched for files with the link's exact name,
 * and the one whose path ends most like the link is what the link meant.
 * Anything short of one provable best match is reported as a tie, as nothing
 * found, or as an incomplete search: never silently opened.
 *
 * @module EnvironmentFileLinkResolve
 */
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import {
  EnvironmentFilePath,
  EnvironmentFilePrepareError,
  type EnvironmentFileLinkResolution,
  type EnvironmentFileLinkResolveInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

/** Directories whose contents are never what a chat link means. */
const SKIPPED_DIRECTORY_NAMES = new Set([".git", "node_modules"]);
/** The search stops, and reports itself incomplete, past either bound. */
const MAX_SEARCHED_DIRECTORIES = 50_000;
const SEARCH_DEADLINE_MS = 2_000;
const MAX_REPORTED_PATHS = 20;

export interface LinkCandidateSearch {
  /** Absolute paths of regular files, or symlinks to regular files, with the name. */
  readonly paths: ReadonlyArray<string>;
  /** False when a bound was hit or a directory could not be read. */
  readonly complete: boolean;
}

export interface LinkCandidateSearchLimits {
  readonly maxDirectories: number;
  readonly deadlineMs: number;
  /** The clock the time bound is measured on; tests supply their own. */
  readonly now?: () => number;
}

function errorCode(error: unknown): unknown {
  return typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
}

function isMissing(error: unknown): boolean {
  const code = errorCode(error);
  return code === "ENOENT" || code === "ENOTDIR";
}

/** A link that only leads back to itself names no file. */
function isSymlinkLoop(error: unknown): boolean {
  return errorCode(error) === "ELOOP";
}

/**
 * Finds every file named `fileName` under `root`, including symlinks that lead
 * to regular files, which a file index does not list. Symlinked directories
 * are not entered, so the search cannot leave the workspace or loop.
 */
export async function findFilesNamed(
  root: string,
  fileName: string,
  limits: LinkCandidateSearchLimits = {
    maxDirectories: MAX_SEARCHED_DIRECTORIES,
    deadlineMs: SEARCH_DEADLINE_MS,
  },
): Promise<LinkCandidateSearch> {
  const paths: string[] = [];
  const pending = [root];
  const now = limits.now ?? Date.now;
  const deadline = now() + limits.deadlineMs;
  let searched = 0;
  // Cleared whenever something could not be examined: an unexamined place may
  // hold a better match or a tie, so nothing found elsewhere is provably unique.
  let complete = true;
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    // Checked before every directory, so empty and unreadable ones count too.
    if (searched >= limits.maxDirectories || now() > deadline) return { paths, complete: false };
    searched += 1;
    const directory = next;
    const entries = await NodeFSP.readdir(directory, { withFileTypes: true }).catch(() => null);
    if (entries === null) {
      complete = false;
      continue;
    }
    for (const entry of entries) {
      // Checked per entry, so one very large directory cannot outlast the bound.
      if (now() > deadline) return { paths, complete: false };
      const entryPath = NodePath.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORY_NAMES.has(entry.name)) pending.push(entryPath);
        continue;
      }
      if (entry.name !== fileName) continue;
      if (entry.isFile()) {
        paths.push(entryPath);
        continue;
      }
      if (!entry.isSymbolicLink()) continue;
      const target = await NodeFSP.stat(entryPath).catch((error: unknown) => error);
      if (target instanceof NodeFS.Stats) {
        // A link to a folder is not a file to open.
        if (target.isFile()) paths.push(entryPath);
      } else if (!isMissing(target) && !isSymlinkLoop(target)) {
        // A target that cannot be inspected may be a file, and so a tie.
        complete = false;
      }
    }
  }
  // Time can also run out while the last directory was being examined.
  return { paths, complete: complete && now() <= deadline };
}

function pathSegments(path: string): string[] {
  return path.split(NodePath.sep).filter((segment) => segment.length > 0);
}

function sharedSuffixLength(left: ReadonlyArray<string>, right: ReadonlyArray<string>): number {
  let length = 0;
  while (
    length < left.length &&
    length < right.length &&
    left[left.length - 1 - length] === right[right.length - 1 - length]
  ) {
    length += 1;
  }
  return length;
}

/**
 * The candidates whose paths share the longest run of trailing segments with
 * the link. One of them is the match; several are a tie, unless exactly one of
 * them is a file the link's own turn changed, which breaks the tie. A changed
 * file never beats a candidate that matches more of the path.
 *
 * @returns The best candidates: one entry for a match, several for a tie.
 */
export function rankLinkCandidates(
  linkPath: string,
  candidatePaths: ReadonlyArray<string>,
  changedPaths: ReadonlySet<string>,
): ReadonlyArray<string> {
  const linkSegments = pathSegments(linkPath);
  let best: string[] = [];
  let bestLength = 0;
  for (const candidatePath of candidatePaths) {
    const length = sharedSuffixLength(linkSegments, pathSegments(candidatePath));
    if (length === 0 || length < bestLength) continue;
    if (length > bestLength) {
      best = [];
      bestLength = length;
    }
    best.push(candidatePath);
  }
  if (best.length > 1) {
    const changed = best.filter((candidatePath) => changedPaths.has(candidatePath));
    if (changed.length === 1) return changed;
  }
  return best;
}

export const resolveEnvironmentFileLink = Effect.fn("EnvironmentFileLinkResolve.resolve")(
  function* (
    input: EnvironmentFileLinkResolveInput,
  ): Effect.fn.Return<EnvironmentFileLinkResolution, EnvironmentFilePrepareError> {
    if (!NodePath.isAbsolute(input.workspaceRoot)) {
      return yield* new EnvironmentFilePrepareError({
        path: input.workspaceRoot,
        failure: "path_not_absolute",
      });
    }
    // `..` applies to the path as written, as it does for the shell and the
    // path tools an agent built the link with.
    const workspaceRoot = NodePath.resolve(input.workspaceRoot);
    const linkPath = NodePath.resolve(workspaceRoot, input.path);
    const missing = yield* Effect.promise(() =>
      NodeFSP.stat(linkPath).then(
        () => false,
        // Only absence starts a search. A denied or failing location is still
        // the file the link names, and opening it reports the real reason.
        (error: unknown) => isMissing(error),
      ),
    );
    const literalPath = EnvironmentFilePath.make(linkPath);
    if (!missing) return { _tag: "literal", path: literalPath };

    const search = yield* Effect.promise(() =>
      findFilesNamed(workspaceRoot, NodePath.basename(linkPath)),
    );
    const changedPaths = new Set(
      (input.changedPaths ?? []).map((changedPath) => NodePath.resolve(workspaceRoot, changedPath)),
    );
    const best = rankLinkCandidates(linkPath, search.paths, changedPaths);
    const relativePaths = best
      .slice(0, MAX_REPORTED_PATHS)
      .map((candidatePath) =>
        EnvironmentFilePath.make(
          NodePath.relative(workspaceRoot, candidatePath).split(NodePath.sep).join("/"),
        ),
      );
    if (!search.complete) {
      return { _tag: "incomplete", paths: relativePaths, missingPath: literalPath };
    }
    const [only] = relativePaths;
    if (only === undefined) return { _tag: "none", missingPath: literalPath };
    return best.length === 1
      ? { _tag: "recovered", path: only, missingPath: literalPath }
      : { _tag: "tie", paths: relativePaths, missingPath: literalPath };
  },
);
