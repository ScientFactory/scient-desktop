import {
  collapseAbsoluteFilePath,
  fileBasename,
  workspaceRelativeFilePath,
} from "@t3tools/shared/path";
import {
  parseMarkdownFileLink,
  inlineCodeFilePathCandidate,
  normalizeMarkdownLinkDestination,
  safeDecodeURIComponent,
  resolveMarkdownFileLinkTarget,
} from "@t3tools/shared/markdownLinks";
import {
  formatFilePathPosition,
  parseFileUrlHref,
  splitFilePathPosition,
} from "@t3tools/shared/fileLinks";

import { formatWorkspaceRelativePath } from "./filePathDisplay";
import { isTerminalLinkActivation } from "./terminal-links";

export interface MarkdownFileLinkMeta {
  filePath: string;
  targetPath: string;
  displayPath: string;
  workspaceRelativePath: string | null;
  basename: string;
  line?: number;
  column?: number;
  /**
   * The link as authored when it is written from the home folder
   * (`~/notes.md`). `filePath` holds only the client's guess at where that
   * is; the environment that owns the files is asked with this spelling.
   */
  homeRelativePath?: string;
}

export function shouldOpenMarkdownFileLinkInEditor(
  event: Pick<MouseEvent, "metaKey" | "ctrlKey">,
  platform?: string,
): boolean {
  return isTerminalLinkActivation(event, platform);
}

/** Canonical key for matching React Markdown's encoded href to authored source. */
export function markdownLinkLookupKey(href: string): string {
  const normalized = normalizeMarkdownLinkDestination(href);
  return safeDecodeURIComponent(rewriteMarkdownFileUriHref(normalized) ?? normalized);
}

export function rewriteMarkdownFileUriHref(href: string | undefined): string | null {
  if (!href) return null;
  const target = parseFileUrlHref(normalizeMarkdownLinkDestination(href));
  return target ? `${target.path}${target.hash}` : null;
}

/**
 * Inline code spans mostly hold identifiers, commands, and refs (`node.meta`,
 * `origin/main`) rather than deliberate link destinations, so auto-linking
 * them demands stronger path evidence than an explicit markdown link does.
 */
export function resolveInlineCodeFileLinkMeta(
  codeText: string,
  cwd?: string,
  workspaceRoot: string | null | undefined = cwd,
  baseDir: string | undefined = cwd,
): MarkdownFileLinkMeta | null {
  const candidate = inlineCodeFilePathCandidate(codeText);
  if (candidate === null) return null;

  return resolveMarkdownFileLinkMeta(candidate, cwd, workspaceRoot, baseDir);
}

export function resolveMarkdownFileLinkMeta(
  href: string | undefined,
  cwd?: string,
  workspaceRoot: string | null | undefined = cwd,
  baseDir: string | undefined = cwd,
): MarkdownFileLinkMeta | null {
  const targetPath = resolveMarkdownFileLinkTarget(href, cwd, baseDir);
  if (!targetPath) return null;
  const meta = buildFileLinkMetaFromTarget(targetPath, cwd, workspaceRoot);
  const authoredPath = href ? parseMarkdownFileLink(href)?.path : undefined;
  return authoredPath !== undefined && /^~[\\/]/.test(authoredPath)
    ? { ...meta, homeRelativePath: authoredPath }
    : meta;
}

/**
 * The path a chat file link copies as "relative": workspace-relative with the
 * link's line position, or null for a file outside the workspace. The display
 * path is not usable here because it is prefixed with the workspace name.
 */
export function markdownFileLinkRelativeCopyPath(meta: MarkdownFileLinkMeta): string | null {
  if (meta.workspaceRelativePath === null) return null;
  return formatFilePathPosition({
    path: meta.workspaceRelativePath,
    ...(meta.line !== undefined ? { line: meta.line } : {}),
    ...(meta.column !== undefined ? { column: meta.column } : {}),
  });
}

function buildFileLinkMetaFromTarget(
  targetPath: string,
  cwd?: string,
  workspaceRoot: string | null | undefined = cwd,
): MarkdownFileLinkMeta {
  const split = splitFilePathPosition(targetPath);
  // Resolve `..` once, here, so every consumer agrees on which file this is
  // and whether it is inside the workspace. A link that climbs out of the
  // workspace becomes the absolute host path it names.
  const path = collapseAbsoluteFilePath(split.path);
  const { line, column } = split;
  const resolvedTargetPath = formatFilePathPosition({
    path,
    ...(line !== undefined ? { line } : {}),
    ...(column !== undefined ? { column } : {}),
  });
  return {
    filePath: path,
    targetPath: resolvedTargetPath,
    displayPath: formatWorkspaceRelativePath(resolvedTargetPath, cwd),
    workspaceRelativePath: workspaceRelativeFilePath(path, workspaceRoot),
    basename: fileBasename(path),
    ...(line !== undefined ? { line } : {}),
    ...(column !== undefined ? { column } : {}),
  };
}
