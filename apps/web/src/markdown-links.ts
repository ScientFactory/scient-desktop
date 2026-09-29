import {
  fileBasename,
  formatFilePathPosition,
  inlineCodeFilePathCandidate,
  isRelativeFilePath,
  normalizeMarkdownLinkDestination,
  parseFileUrlHref,
  parseMarkdownFileLink,
  safeDecodeURIComponent,
  splitFilePathPosition,
  stripSlashPrefixedWindowsDrive,
  workspaceRelativeFilePath,
} from "@t3tools/client-runtime/markdown-links";

import { formatWorkspaceRelativePath } from "./filePathDisplay";
import { isTerminalLinkActivation, resolvePathLinkTarget } from "./terminal-links";

export { normalizeMarkdownLinkDestination };

const MARKDOWN_LINK_HREF_PATTERN =
  /\[[^\]]*]\(\s*(?:<([^>\n]+)>|([^\s)]+))(?:\s+["'][^"']*["'])?\s*\)/g;

export interface MarkdownFileLinkMeta {
  filePath: string;
  targetPath: string;
  displayPath: string;
  workspaceRelativePath: string | null;
  basename: string;
  line?: number;
  column?: number;
}

export function extractMarkdownLinkHrefs(markdown: string): string[] {
  const hrefs: string[] = [];
  for (const match of markdown.matchAll(MARKDOWN_LINK_HREF_PATTERN)) {
    const href = (match[1] ?? match[2])?.trim();
    if (href) hrefs.push(href);
  }
  return hrefs;
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

export function isWindowsDrivePathHref(href: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(safeDecodeURIComponent(href));
}

export function rewriteMarkdownFileUriHref(href: string | undefined): string | null {
  if (!href) return null;
  const target = parseFileUrlHref(normalizeMarkdownLinkDestination(href));
  return target ? `${target.path}${target.hash}` : null;
}

/**
 * `baseDir` anchors relative links; it defaults to the workspace root and is the
 * file's own directory when rendering a markdown file. `cwd` stays the workspace
 * root so the result still knows whether the target is inside it.
 */
export function resolveMarkdownFileLinkTarget(
  href: string | undefined,
  cwd?: string,
  baseDir: string | undefined = cwd,
): string | null {
  if (!href) return null;
  const target = parseMarkdownFileLink(href);
  if (!target) return null;

  const pathWithPosition = formatFilePathPosition(target);
  if (!isRelativeFilePath(pathWithPosition)) return pathWithPosition;
  if (!baseDir) return null;
  return resolvePathLinkTarget(pathWithPosition, baseDir);
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
  return buildFileLinkMetaFromTarget(targetPath, cwd, workspaceRoot);
}

/**
 * The path a chat file link copies as "relative": workspace-relative with the
 * link's line position, or null for a file outside the workspace. The display
 * path is not usable here because it is prefixed with the workspace name.
 */
export function markdownFileLinkRelativeCopyPath(meta: MarkdownFileLinkMeta): string | null {
  const lexicalRelativePath = meta.workspaceRelativePath;
  if (lexicalRelativePath === null) return null;
  // The link target is joined lexically, so `../outside.md` still starts with
  // the workspace root. Recover that root from the lexical split, then decide
  // containment on both paths with their dot segments resolved.
  const lexicalPath = stripSlashPrefixedWindowsDrive(meta.filePath.replaceAll("\\", "/"));
  const lexicalRoot = lexicalPath.slice(0, lexicalPath.length - lexicalRelativePath.length - 1);
  const path = workspaceRelativeFilePath(
    collapseDotSegments(lexicalPath),
    collapseDotSegments(lexicalRoot),
  );
  if (path === null) return null;
  return formatFilePathPosition({
    path,
    ...(meta.line !== undefined ? { line: meta.line } : {}),
    ...(meta.column !== undefined ? { column: meta.column } : {}),
  });
}

/** Resolves `.` and `..` in an absolute `/`-separated path without climbing above its root. */
function collapseDotSegments(path: string): string {
  const [head = "", ...rest] = path.split("/");
  const segments: string[] = [];
  for (const segment of rest) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") segments.pop();
    else segments.push(segment);
  }
  return `${head}/${segments.join("/")}`;
}

function buildFileLinkMetaFromTarget(
  targetPath: string,
  cwd?: string,
  workspaceRoot: string | null | undefined = cwd,
): MarkdownFileLinkMeta {
  const { path, line, column } = splitFilePathPosition(targetPath);
  return {
    filePath: path,
    targetPath,
    displayPath: formatWorkspaceRelativePath(targetPath, cwd),
    workspaceRelativePath: workspaceRelativeFilePath(path, workspaceRoot),
    basename: fileBasename(path),
    ...(line !== undefined ? { line } : {}),
    ...(column !== undefined ? { column } : {}),
  };
}
