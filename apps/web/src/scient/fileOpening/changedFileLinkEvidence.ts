import { collapseAbsoluteFilePath, fileBasename } from "@t3tools/client-runtime/markdown-links";
import { isWindowsAbsolutePath } from "@t3tools/shared/path";

import { isAbsolutePath, resolvePathLinkTarget } from "~/terminal-links";

/**
 * Path segments for suffix comparison. Windows paths divide on either slash;
 * on POSIX a backslash is part of a file name, never a separator.
 */
function pathSegments(path: string): string[] {
  const separator = isWindowsAbsolutePath(path) ? /[\\/]+/ : /\/+/;
  return path.split(separator).filter((segment) => segment.length > 0 && segment !== ".");
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

function absoluteLinkPath(linkPath: string, workspaceRoot: string): string {
  return collapseAbsoluteFilePath(
    isAbsolutePath(linkPath) ? linkPath : resolvePathLinkTarget(linkPath, workspaceRoot),
  );
}

/**
 * The candidate a link most plausibly names when the link's own location does
 * not exist. Agents often write links relative to the directory their shell
 * was in, or to a folder they were thinking in, which Scient cannot see: the
 * link `reviews/notes.md` usually means the one project file ending in
 * `reviews/notes.md`.
 *
 * The file name must match exactly, and the candidate sharing the longest run
 * of trailing path segments with the link must be the only one at that length.
 * A tie returns null, so the user chooses instead of Scient guessing.
 *
 * @param linkPath The link target: absolute, or relative to `workspaceRoot`.
 * @param candidatePaths Existing files, relative to `workspaceRoot`.
 * @returns The best candidate's workspace-relative path, or null.
 */
export function pickClosestPathMatch(
  linkPath: string,
  candidatePaths: ReadonlyArray<string>,
  workspaceRoot: string,
): string | null {
  const targetPath = absoluteLinkPath(linkPath, workspaceRoot);
  const targetSegments = pathSegments(targetPath);
  let best: string | null = null;
  let bestLength = 0;
  let ambiguous = false;
  for (const candidatePath of candidatePaths) {
    const candidateTarget = absoluteLinkPath(candidatePath, workspaceRoot);
    // The link already names this file; its absence is not evidence of another.
    if (candidateTarget === targetPath) return null;
    const length = sharedSuffixLength(targetSegments, pathSegments(candidateTarget));
    if (length === 0) continue;
    if (length > bestLength) {
      best = candidatePath;
      bestLength = length;
      ambiguous = false;
    } else if (length === bestLength && candidatePath !== best) {
      ambiguous = true;
    }
  }
  return ambiguous ? null : best;
}

export interface ChatFileOpenInput {
  /** The link's path: workspace-relative or absolute. */
  readonly panelPath: string;
  readonly workspaceRoot: string | undefined;
  /** Files the link's turn changed, relative to `workspaceRoot`. */
  readonly changedPaths: ReadonlyArray<string>;
}

export interface ChatFileOpenResolution {
  /** The path to open. */
  readonly path: string;
  /** Set when the link's own location did not exist and a match was opened instead. */
  readonly missingLinkPath?: string;
}

/**
 * Whether opening a chat link needs to consult the host first. Any link inside
 * a workspace thread might have been written relative to the wrong directory,
 * so all of them are checked; without a workspace there is nothing to match.
 */
export function chatFileOpenNeedsLookup(input: ChatFileOpenInput): boolean {
  return Boolean(input.workspaceRoot);
}

/**
 * The file a chat link opens. The link as written always wins when it exists.
 * When it does not, the closest match opens instead (see pickClosestPathMatch):
 * first among the files the link's own turn changed, which is recorded
 * evidence, then among the project files with the same name. A tie opens the
 * link as written, so the file panel offers the choices.
 *
 * @param exists Whether an absolute host path exists. Implementations answer
 *   false only for a definite "not found", so a permission or connection
 *   problem surfaces on the linked file rather than redirecting to another.
 * @param findFilesNamed Workspace-relative paths of project files with exactly
 *   this file name.
 */
export async function resolveChatFileOpenPath(
  input: ChatFileOpenInput & {
    readonly exists: (absolutePath: string) => Promise<boolean>;
    readonly findFilesNamed: (fileName: string) => Promise<ReadonlyArray<string>>;
  },
): Promise<ChatFileOpenResolution> {
  const workspaceRoot = input.workspaceRoot;
  if (!workspaceRoot) return { path: input.panelPath };
  const linkPath = absoluteLinkPath(input.panelPath, workspaceRoot);
  if (await input.exists(linkPath)) return { path: input.panelPath };

  const changedFileMatch = pickClosestPathMatch(input.panelPath, input.changedPaths, workspaceRoot);
  if (changedFileMatch !== null) {
    return { path: changedFileMatch, missingLinkPath: linkPath };
  }
  const projectMatch = pickClosestPathMatch(
    input.panelPath,
    await input.findFilesNamed(fileBasename(linkPath)),
    workspaceRoot,
  );
  return projectMatch !== null
    ? { path: projectMatch, missingLinkPath: linkPath }
    : { path: input.panelPath };
}
