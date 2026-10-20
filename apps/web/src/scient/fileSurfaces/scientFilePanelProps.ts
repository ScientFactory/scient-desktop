import type { ComponentProps } from "react";

import type FilePreviewPanel from "~/components/files/FilePreviewPanel";
import { resolveFileTabPath } from "~/components/files/filePath";
import type { RightPanelSurface } from "~/rightPanelStore";

type FilePreviewPanelProps = ComponentProps<typeof FilePreviewPanel>;

/** The file panel props Scient adds to a Files or File surface. */
export type ScientFilePanelProps = Pick<
  FilePreviewPanelProps,
  | "projectName"
  | "relativePath"
  | "onCiteFile"
  | "fileCitation"
  | "htmlPresentationRequest"
  | "latexPresentationRequest"
  | "latexRootRelativePath"
  | "latexSourceReveal"
  | "onFileRenamed"
  | "onFileMoved"
  | "onOpenFileSource"
  | "onHtmlPresentationRequestHandled"
  | "onLatexPresentationRequestHandled"
>;

/**
 * Citations, presentation requests, in-place renames and source links for a
 * file surface. A workspace file tab resolves its stored path against the
 * thread's workspace; an attachment keeps its own.
 */
export function scientFilePanelProps(
  surface: Extract<RightPanelSurface, { readonly kind: "files" | "file" }>,
  input: {
    readonly projectName: string | null;
    readonly workspaceRoot: string | undefined;
    readonly onCiteFile: NonNullable<FilePreviewPanelProps["onCiteFile"]>;
    readonly onFileRenamed: FilePreviewPanelProps["onFileRenamed"];
    readonly onFileMoved: NonNullable<FilePreviewPanelProps["onFileMoved"]>;
    readonly onOpenFileSource: FilePreviewPanelProps["onOpenFileSource"];
    readonly onHtmlPresentationRequestHandled: FilePreviewPanelProps["onHtmlPresentationRequestHandled"];
    readonly onLatexPresentationRequestHandled: FilePreviewPanelProps["onLatexPresentationRequestHandled"];
  },
): ScientFilePanelProps {
  const file = surface.kind === "file" ? surface : null;
  return {
    projectName: input.projectName ?? "Project",
    relativePath:
      file === null
        ? null
        : file.attachment
          ? file.relativePath
          : resolveFileTabPath(file.relativePath, input.workspaceRoot ?? ""),
    onCiteFile: input.onCiteFile,
    fileCitation: file?.fileCitation,
    htmlPresentationRequest: file?.htmlPresentationRequest ?? null,
    latexPresentationRequest: file?.latexPresentationRequest ?? null,
    latexRootRelativePath: file?.latexRootRelativePath ?? null,
    latexSourceReveal: file?.latexSourceReveal,
    onFileRenamed: input.onFileRenamed,
    onFileMoved: input.onFileMoved,
    onOpenFileSource: input.onOpenFileSource,
    onHtmlPresentationRequestHandled: input.onHtmlPresentationRequestHandled,
    onLatexPresentationRequestHandled: input.onLatexPresentationRequestHandled,
  };
}
