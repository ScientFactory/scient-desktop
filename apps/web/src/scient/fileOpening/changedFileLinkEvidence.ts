import { collapseAbsoluteFilePath } from "@t3tools/client-runtime/markdown-links";

import { isAbsolutePath, resolvePathLinkTarget } from "~/terminal-links";

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
