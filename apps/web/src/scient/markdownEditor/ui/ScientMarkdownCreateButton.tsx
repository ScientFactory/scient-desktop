import {
  ensureScientMarkdownDocumentPath,
  isScientMarkdownDocumentPath,
} from "../markdownDocumentPaths";

export function normalizeMarkdownCreatePath(input: string): string | null {
  let path = input.trim().replaceAll("\\", "/").replace(/^\.\//u, "");
  if (path.length === 0 || path.length > 512 || path.startsWith("/")) return null;
  const segments = path.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    return null;
  }
  if (/\.[^./]+$/u.test(path) && !isScientMarkdownDocumentPath(path)) return null;
  path = ensureScientMarkdownDocumentPath(path);
  return path.length <= 512 ? path : null;
}

export function untitledMarkdownPath(selectedPath: string | null, collision = 1): string {
  const parent = selectedPath?.includes("/")
    ? selectedPath.slice(0, selectedPath.lastIndexOf("/"))
    : "";
  const fileName = collision === 1 ? "untitled.md" : `untitled-${collision}.md`;
  return parent ? `${parent}/${fileName}` : fileName;
}
