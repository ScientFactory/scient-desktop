import { collapseAbsoluteFilePath } from "@t3tools/client-runtime/markdown-links";

import { isAbsolutePath, resolvePathLinkTarget } from "~/terminal-links";
import { needsWorkspaceBasenameLookup } from "~/workspaceBasenameLookup";

function pathSegments(path: string): string[] {
  return path.split(/[\\/]+/).filter((segment) => segment.length > 0 && segment !== ".");
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
 * The file a turn changed that a link in that turn's answer names, for when the
 * link's own location does not exist. Agents often write links relative to the
 * directory their shell was in, which Scient cannot see; the files the same
 * turn changed are recorded evidence of what the link meant.
 *
 * Only those files are considered, the file name must match exactly, and the
 * longest shared path suffix must belong to exactly one of them. Anything
 * weaker returns null, so a link never silently opens a different document.
 *
 * @param linkPath The link target: absolute, or relative to `workspaceRoot`.
 * @param changedPaths The turn's changed files, relative to `workspaceRoot`.
 * @returns The matching changed file's workspace-relative path, or null.
 */
export function pickChangedFileForLink(
  linkPath: string,
  changedPaths: ReadonlyArray<string>,
  workspaceRoot: string,
): string | null {
  const targetPath = collapseAbsoluteFilePath(
    isAbsolutePath(linkPath) ? linkPath : resolvePathLinkTarget(linkPath, workspaceRoot),
  );
  const targetSegments = pathSegments(targetPath);
  let best: string | null = null;
  let bestLength = 0;
  let ambiguous = false;
  for (const changedPath of changedPaths) {
    const changedTarget = collapseAbsoluteFilePath(
      resolvePathLinkTarget(changedPath, workspaceRoot),
    );
    // The link already names this file; its absence is not evidence of another.
    if (changedTarget === targetPath) return null;
    const length = sharedSuffixLength(targetSegments, pathSegments(changedTarget));
    if (length === 0) continue;
    if (length > bestLength) {
      best = changedPath;
      bestLength = length;
      ambiguous = false;
    } else if (length === bestLength && changedPath !== best) {
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

/**
 * Whether opening a chat link needs to consult the host before choosing a
 * file. Only a link that could be redirected does: one sharing a name with a
 * file its turn changed, or a bare file name. Everything else opens as written.
 */
export function chatFileOpenNeedsLookup(input: ChatFileOpenInput): boolean {
  if (!input.workspaceRoot) return false;
  return (
    needsWorkspaceBasenameLookup(input.panelPath) ||
    pickChangedFileForLink(input.panelPath, input.changedPaths, input.workspaceRoot) !== null
  );
}

/**
 * The file a chat link opens. The link as written always wins when it exists;
 * a link whose location does not exist falls back first to the unique file its
 * turn changed with that name, then, for a bare file name, to a unique
 * same-named workspace file. It never chooses between equally good matches.
 *
 * @param exists Whether an absolute host path exists. Implementations answer
 *   false only for a definite "not found", so a permission or connection
 *   problem surfaces on the linked file rather than redirecting to another.
 * @param findBasenameMatch The unique workspace file with this bare name, or null.
 */
export async function resolveChatFileOpenPath(
  input: ChatFileOpenInput & {
    readonly exists: (absolutePath: string) => Promise<boolean>;
    readonly findBasenameMatch: (fileName: string) => Promise<string | null>;
  },
): Promise<string> {
  const workspaceRoot = input.workspaceRoot;
  if (!workspaceRoot) return input.panelPath;
  const linkPath = collapseAbsoluteFilePath(
    isAbsolutePath(input.panelPath)
      ? input.panelPath
      : resolvePathLinkTarget(input.panelPath, workspaceRoot),
  );
  if (await input.exists(linkPath)) return input.panelPath;
  const changedFileMatch = pickChangedFileForLink(
    input.panelPath,
    input.changedPaths,
    workspaceRoot,
  );
  if (changedFileMatch !== null) return changedFileMatch;
  if (needsWorkspaceBasenameLookup(input.panelPath)) {
    return (await input.findBasenameMatch(input.panelPath)) ?? input.panelPath;
  }
  return input.panelPath;
}
