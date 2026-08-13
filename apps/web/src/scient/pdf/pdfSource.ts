import {
  ArtifactAuthority,
  LogicalDocumentKey,
  PdfSourceDescriptor,
  type PdfSourceActions,
  type PdfSourceDescriptor as PdfSourceDescriptorType,
  type PdfSourceResolver,
} from "@scientfactory/document-artifacts";
import { EnvironmentId, ThreadId, type AssetResource } from "@t3tools/contracts";
import { isWorkspacePdfPreviewPath } from "@t3tools/shared/filePreview";

import { useAssetUrlState, type AssetUrlState } from "~/assets/assetUrls";

export function workspacePdfSource(input: {
  readonly absolutePath: string;
  readonly environmentId: EnvironmentId;
  readonly fileName: string;
  readonly threadId: string;
}): PdfSourceDescriptorType {
  return PdfSourceDescriptor.make({
    _tag: "workspace-pdf",
    authority: ArtifactAuthority.make(input.environmentId),
    logicalDocumentKey: LogicalDocumentKey.make(
      `workspace:${input.threadId}:${input.absolutePath}`,
    ),
    title: input.fileName,
    fileName: input.fileName,
    capabilities: { canSaveCopy: true, canRevealSource: false },
    threadId: input.threadId,
    absolutePath: input.absolutePath,
  });
}

/** Only file-panel paths classified as PDFs may enter the strict PDF descriptor contract. */
export function workspacePdfSourceForPreview(input: {
  readonly absolutePath: string | null;
  readonly environmentId: EnvironmentId;
  readonly relativePath: string | null;
  readonly threadId: string;
}): PdfSourceDescriptorType | null {
  if (
    input.absolutePath === null ||
    input.relativePath === null ||
    !isWorkspacePdfPreviewPath(input.relativePath)
  ) {
    return null;
  }

  const browserSuffixIndex = input.relativePath.search(/[?#]/u);
  const browserSuffix =
    browserSuffixIndex === -1 ? "" : input.relativePath.slice(browserSuffixIndex);
  const sourcePath =
    browserSuffix.length > 0 && input.absolutePath.endsWith(browserSuffix)
      ? input.absolutePath.slice(0, -browserSuffix.length)
      : input.absolutePath;
  const relativeSourcePath = input.relativePath.split(/[?#]/, 1)[0] ?? input.relativePath;
  const fileName = relativeSourcePath.split(/[\\/]/).at(-1) ?? relativeSourcePath;

  return workspacePdfSource({
    absolutePath: sourcePath,
    environmentId: input.environmentId,
    fileName,
    threadId: input.threadId,
  });
}

export function usePdfSourceState(source: PdfSourceDescriptorType): AssetUrlState {
  return useAssetUrlState(EnvironmentId.make(source.authority), pdfSourceAssetResource(source));
}

export const webPdfSourceResolver: PdfSourceResolver = {
  useResolve: usePdfSourceState,
};

export function pdfSourceAssetResource(source: PdfSourceDescriptorType): AssetResource {
  return source._tag === "workspace-pdf"
    ? {
        _tag: "workspace-file",
        threadId: ThreadId.make(source.threadId),
        path: source.absolutePath,
      }
    : {
        _tag: "generated-document",
        authority: source.authority,
        artifactId: source.artifactId,
        revisionId: source.revisionId,
      };
}

export const webPdfSourceActions: PdfSourceActions = {
  saveCopy: (source, resolved) => {
    const anchor = document.createElement("a");
    anchor.href = resolved.url;
    anchor.download = source.fileName;
    anchor.click();
  },
};
