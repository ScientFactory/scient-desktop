import { isRelativeFilePath, parseMarkdownFileLink } from "@t3tools/shared/markdownLinks";

import { collapseAbsoluteFilePath, isWindowsAbsolutePath } from "@t3tools/shared/path";

import { resolvePathLinkTarget } from "@t3tools/shared/fileLinks";

import { isScientMarkdownDocumentPath } from "./markdownDocumentPaths";

/** URL destinations are decoded once; wiki targets are already filesystem text. */
export function resolveMarkdownUrlPath(
  markdownRelativePath: string,
  destination: string,
): {
  readonly relativePath: string;
  readonly suffix: string;
} | null {
  const suffixStart = destination.search(/[?#]/u);
  const encoded = suffixStart < 0 ? destination : destination.slice(0, suffixStart);
  const suffix = suffixStart < 0 ? "" : destination.slice(suffixStart);
  try {
    const pathname = decodeURIComponent(encoded);
    const relativePath = resolveRelativePath(markdownRelativePath, pathname);
    return relativePath === null ? null : { relativePath, suffix };
  } catch {
    return null;
  }
}

export function resolveMarkdownSiblingPath(
  markdownRelativePath: string,
  authoredPath: string,
): string | null {
  const portable = authoredPath.replaceAll("\\", "/");
  if (portable.length === 0 || portable.startsWith("/") || /^[a-z][a-z\d+.-]*:/iu.test(portable)) {
    return null;
  }
  const suffixStart = portable.search(/[?#]/u);
  const pathname = suffixStart < 0 ? portable : portable.slice(0, suffixStart);
  const suffix = suffixStart < 0 ? "" : portable.slice(suffixStart);
  const relativePath = resolveRelativePath(markdownRelativePath, pathname);
  return relativePath === null ? null : `${relativePath}${suffix}`;
}

function resolveRelativePath(markdownRelativePath: string, authoredPath: string): string | null {
  const pathname = authoredPath.replaceAll("\\", "/");
  if (
    !pathname ||
    pathname.startsWith("/") ||
    pathname.includes("\0") ||
    /^[a-z][a-z\d+.-]*:/iu.test(pathname)
  )
    return null;
  const baseSegments = markdownRelativePath.replaceAll("\\", "/").split("/").slice(0, -1);
  for (const segment of pathname.split("/")) {
    if (segment.length === 0 || segment === ".") continue;
    if (segment === "..") {
      if (baseSegments.length === 0) return null;
      baseSegments.pop();
      continue;
    }
    baseSegments.push(segment);
  }
  return baseSegments.length > 0 ? baseSegments.join("/") : null;
}

export function resolveWikiLinkPath(markdownRelativePath: string, target: string): string | null {
  const withoutHeading = target.split("#", 1)[0]?.trim() ?? "";
  if (withoutHeading.length === 0) return null;
  const withExtension = /\.[a-z\d]+$/iu.test(withoutHeading)
    ? withoutHeading
    : `${withoutHeading}.md`;
  return resolveMarkdownSiblingPath(markdownRelativePath, withExtension);
}

export function markdownWikiTargetForPath(
  markdownRelativePath: string,
  targetRelativePath: string,
): string | null {
  const documentSegments = markdownRelativePath.replaceAll("\\", "/").split("/");
  const targetSegments = targetRelativePath.replaceAll("\\", "/").split("/");
  if (
    targetSegments.length === 0 ||
    targetSegments.some((segment) => segment.length === 0 || segment === "." || segment === "..") ||
    !isScientMarkdownDocumentPath(targetSegments.at(-1) ?? "")
  ) {
    return null;
  }
  documentSegments.pop();
  let common = 0;
  while (
    common < documentSegments.length &&
    common < targetSegments.length &&
    documentSegments[common] === targetSegments[common]
  ) {
    common += 1;
  }
  const relativeSegments = [
    ...Array.from({ length: documentSegments.length - common }, () => ".."),
    ...targetSegments.slice(common),
  ];
  const relative = relativeSegments.join("/").replace(/\.md$/iu, "");
  return relative.length > 0 ? relative : null;
}

/**
 * The absolute host path a Markdown link names when it leaves the workspace:
 * an absolute path, a `file:` URL, or a relative path that climbs above the
 * workspace root. Such a file opens read-only like any other host file.
 * Returns null for web and other URL schemes, fragments, and empty links.
 */
export function resolveMarkdownHostLinkPath(
  markdownRelativePath: string,
  workspaceRoot: string,
  destination: string,
): string | null {
  // The link as written comes first, which keeps absolute drive and UNC paths
  // exact. Failing that, in a Windows workspace a relative link written with
  // backslashes, encoded or not, uses them as separators; on POSIX they are
  // part of a file name.
  const target =
    parseMarkdownFileLink(destination) ??
    (isWindowsAbsolutePath(workspaceRoot)
      ? parseMarkdownFileLink(destination.replaceAll(/%5C/giu, "/").replaceAll("\\", "/"))
      : null);
  if (target === null) return null;
  if (!isRelativeFilePath(target.path)) return collapseAbsoluteFilePath(target.path);
  if (!workspaceRoot) return null;
  const markdownPath = resolvePathLinkTarget(markdownRelativePath, workspaceRoot);
  const separator = markdownPath.includes("\\") && !markdownPath.includes("/") ? "\\" : "/";
  // The trailing `..` drops the document's own name, leaving its directory.
  return collapseAbsoluteFilePath(`${markdownPath}${separator}..${separator}${target.path}`);
}
