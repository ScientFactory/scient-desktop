import {
  isWorkspaceImagePreviewPath,
  isWorkspacePdfPreviewPath,
  isWorkspaceVideoPreviewPath,
} from "@t3tools/shared/filePreview";

export const isMarkdownPreviewFile = (path: string): boolean => /\.(?:md|mdx)$/i.test(path);

export const isLatexPreviewFile = (path: string): boolean => /\.(?:tex|latex|ltx)$/i.test(path);

export type FilePreviewKind = "empty" | "image" | "pdf" | "text" | "video";

export function resolveFilePreviewKind(path: string | null): FilePreviewKind {
  if (path === null) return "empty";
  if (isWorkspaceVideoPreviewPath(path)) return "video";
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

export function resolveMarkdownTaskPreviewUpdate(input: {
  readonly markdown: string;
  readonly markerOffset: number;
  readonly checked: boolean;
  readonly truncated: boolean;
}): string | null {
  if (input.truncated) return null;
  const nextMarkdown = setMarkdownTaskChecked(input.markdown, input.markerOffset, input.checked);
  return nextMarkdown === input.markdown ? null : nextMarkdown;
}
