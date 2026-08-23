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
  return baseSegments.length > 0 ? `${baseSegments.join("/")}${suffix}` : null;
}

export function resolveWikiLinkPath(markdownRelativePath: string, target: string): string | null {
  const withoutHeading = target.split("#", 1)[0]?.trim() ?? "";
  if (withoutHeading.length === 0) return null;
  const withExtension = /\.[a-z\d]+$/iu.test(withoutHeading)
    ? withoutHeading
    : `${withoutHeading}.md`;
  return resolveMarkdownSiblingPath(markdownRelativePath, withExtension);
}
