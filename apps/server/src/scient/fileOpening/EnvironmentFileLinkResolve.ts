// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalDate:off
// @effect-diagnostics globalTimers:off
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

export interface LinkCandidate {
  /** Absolute path of the entry inside the workspace. */
  readonly path: string;
  /** A regular file, or a symlink that led to one when it was examined. */
  readonly kind: "file" | "link";
}

export interface LinkCandidateSearch {
  readonly candidates: ReadonlyArray<LinkCandidate>;
  /** False when a bound was hit or something could not be examined. */
  readonly complete: boolean;
}

export interface LinkCandidateSearchLimits {
  readonly maxDirectories: number;
  readonly deadlineMs: number;
  /** The clock the time bound is measured on; tests supply their own. */
  readonly now?: () => number;
  /** Lists a directory; tests supply one that stalls. */
  readonly readDirectory?: (directory: string) => Promise<ReadonlyArray<NodeFS.Dirent>>;
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

const TIMED_OUT = Symbol("timed-out");

/**
 * Finds every file named `fileName` under `root`, including symlinks that lead
 * to regular files, which a file index does not list. `root` must be a real
 * path: every directory entered is checked to still be the real directory that
 * was queued, so the search neither enters symlinked directories nor follows
 * one swapped in while it runs, and cannot leave the workspace or loop.
 *
 * The result is a snapshot. Anything that could not be examined (a bound, an
 * unreadable or replaced directory, a link whose target cannot be inspected)
 * clears `complete`, because it may hide a better match or a tie.
 */
export async function findFilesNamed(
  root: string,
  fileName: string,
  limits: LinkCandidateSearchLimits = {
    maxDirectories: MAX_SEARCHED_DIRECTORIES,
    deadlineMs: SEARCH_DEADLINE_MS,
  },
): Promise<LinkCandidateSearch> {
  const now = limits.now ?? Date.now;
  const readDirectory =
    limits.readDirectory ??
    ((directory: string) => NodeFSP.readdir(directory, { withFileTypes: true }));
  const deadline = now() + limits.deadlineMs;
  // A filesystem call that never returns must not outlast the bound either.
  // The wall-clock timer only applies with the real clock; a supplied clock
  // decides the bound by itself.
  let stop: (() => void) | undefined;
  const timedOut = new Promise<typeof TIMED_OUT>((resolve) => {
    if (limits.now !== undefined) return;
    const timer = setTimeout(resolve, Math.max(0, limits.deadlineMs), TIMED_OUT);
    stop = () => clearTimeout(timer);
  });
  const bounded = <T>(work: Promise<T>): Promise<T | typeof TIMED_OUT> =>
    Promise.race([work, timedOut]);

  const candidates: LinkCandidate[] = [];
  const pending = [root];
  let searched = 0;
  let complete = true;
  try {
    for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
      // Checked before every directory, so empty and unreadable ones count too.
      if (searched >= limits.maxDirectories || now() > deadline) {
        return { candidates, complete: false };
      }
      searched += 1;
      const directory = next;
      const listed = await bounded(
        Promise.all([
          readDirectory(directory).catch(() => null),
          NodeFSP.realpath(directory).catch(() => null),
        ]),
      );
      if (listed === TIMED_OUT) return { candidates, complete: false };
      const [entries, realDirectory] = listed;
      if (entries === null || realDirectory !== directory) {
        // Unreadable, or no longer the directory that was queued (replaced by
        // a link while the search ran): its contents are not examined.
        complete = false;
        continue;
      }
      for (const entry of entries) {
        // Checked per entry, so one very large directory cannot outlast the bound.
        if (now() > deadline) return { candidates, complete: false };
        const entryPath = NodePath.join(directory, entry.name);
        if (entry.isDirectory()) {
          if (!SKIPPED_DIRECTORY_NAMES.has(entry.name)) pending.push(entryPath);
          continue;
        }
        if (entry.name !== fileName) continue;
        if (entry.isFile()) {
          candidates.push({ path: entryPath, kind: "file" });
          continue;
        }
        if (!entry.isSymbolicLink()) continue;
        const target = await bounded(NodeFSP.stat(entryPath).catch((error: unknown) => error));
        if (target === TIMED_OUT) return { candidates, complete: false };
        if (target instanceof NodeFS.Stats) {
          // A link to a folder is not a file to open.
          if (target.isFile()) candidates.push({ path: entryPath, kind: "link" });
        } else if (!isMissing(target) && !isSymlinkLoop(target)) {
          // A target that cannot be inspected may be a file, and so a tie.
          complete = false;
        }
      }
    }
    // Time can also run out while the last directory was being examined.
    return { candidates, complete: complete && now() <= deadline };
  } finally {
    stop?.();
  }
}

/**
 * Whether a candidate is still the entry the search saw: the same kind of
 * entry, and still a regular file or a link to one. A file deleted, or swapped
 * for a folder, a pipe or a link since then, is no longer that candidate.
 */
async function isStillCandidate(candidate: LinkCandidate): Promise<boolean> {
  const entry = await NodeFSP.lstat(candidate.path).catch(() => null);
  if (entry === null) return false;
  if (candidate.kind === "file") return entry.isFile();
  if (!entry.isSymbolicLink()) return false;
  const target = await NodeFSP.stat(candidate.path).catch(() => null);
  return target?.isFile() === true;
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
    limits?: LinkCandidateSearchLimits,
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
      // Whatever is at the link's own location is what it names, including a
      // link whose target is gone. Only absence starts a search; a denied or
      // failing location is opened as written and reports its real reason.
      NodeFSP.lstat(linkPath).then(
        () => false,
        (error: unknown) => isMissing(error),
      ),
    );
    const literalPath = EnvironmentFilePath.make(linkPath);
    if (!missing) return { _tag: "literal", path: literalPath };

    // The search runs on the real root, so every directory can be checked
    // against its own real path.
    const realRoot = yield* Effect.promise(() => NodeFSP.realpath(workspaceRoot).catch(() => null));
    if (realRoot === null) return { _tag: "incomplete", paths: [], missingPath: literalPath };
    const search = yield* Effect.promise(() =>
      findFilesNamed(realRoot, NodePath.basename(linkPath), limits),
    );
    // Changed files are named relative to the workspace as the client knows
    // it; candidates are under its real path.
    const changedPaths = new Set(
      (input.changedPaths ?? []).map((changedPath) => {
        const lexical = NodePath.resolve(workspaceRoot, changedPath);
        const relative = NodePath.relative(workspaceRoot, lexical);
        return relative.startsWith("..") || NodePath.isAbsolute(relative)
          ? lexical
          : NodePath.join(realRoot, relative);
      }),
    );
    const best = rankLinkCandidates(
      linkPath,
      search.candidates.map((candidate) => candidate.path),
      changedPaths,
    ).slice(0, MAX_REPORTED_PATHS);
    // The workspace may have changed since each candidate was seen. A best
    // candidate that is no longer the entry that was found is dropped, and
    // the search no longer counts as a complete picture.
    const kinds = new Map(search.candidates.map((candidate) => [candidate.path, candidate.kind]));
    const stillThere = yield* Effect.promise(() =>
      Promise.all(
        best.map((candidatePath) =>
          isStillCandidate({ path: candidatePath, kind: kinds.get(candidatePath) ?? "file" }),
        ),
      ),
    );
    const confirmed = best.filter((_, index) => stillThere[index] === true);
    const complete = search.complete && confirmed.length === best.length;
    const relativePaths = confirmed.map((candidatePath) =>
      EnvironmentFilePath.make(
        NodePath.relative(realRoot, candidatePath).split(NodePath.sep).join("/"),
      ),
    );
    if (!complete) {
      return { _tag: "incomplete", paths: relativePaths, missingPath: literalPath };
    }
    const [only] = relativePaths;
    if (only === undefined) return { _tag: "none", missingPath: literalPath };
    return relativePaths.length === 1
      ? { _tag: "recovered", path: only, missingPath: literalPath }
      : { _tag: "tie", paths: relativePaths, missingPath: literalPath };
  },
);
