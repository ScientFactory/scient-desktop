import {
  isWorkspaceImagePreviewPath,
  isWorkspacePdfPreviewPath,
} from "@t3tools/shared/filePreview";

export const isMarkdownPreviewFile = (path: string): boolean => /\.(?:md|mdx)$/i.test(path);

export type FilePreviewKind = "empty" | "image" | "pdf" | "text";

export function resolveFilePreviewKind(path: string | null): FilePreviewKind {
  if (path === null) return "empty";
  if (isWorkspaceImagePreviewPath(path)) return "image";
  if (isWorkspacePdfPreviewPath(path)) return "pdf";
  return "text";
}

export function shouldLoadFileAsText(path: string | null): boolean {
  return resolveFilePreviewKind(path) === "text";
}

export function setMarkdownTaskChecked(
  markdown: string,
  markerOffset: number,
  checked: boolean,
): string {
  if (
    markerOffset < 0 ||
    markdown[markerOffset] !== "[" ||
    !/[ xX]/.test(markdown[markerOffset + 1] ?? "") ||
    markdown[markerOffset + 2] !== "]"
  ) {
    return markdown;
  }

  return `${markdown.slice(0, markerOffset + 1)}${checked ? "x" : " "}${markdown.slice(markerOffset + 2)}`;
}
