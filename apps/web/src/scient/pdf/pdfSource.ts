import {
  ArtifactAuthority,
  LogicalDocumentKey,
  PdfSourceDescriptor,
  type PdfSourceActions,
  type PdfSourceDescriptor as PdfSourceDescriptorType,
  type PdfSourceResolver,
} from "@scientfactory/document-artifacts";
import { EnvironmentId, ThreadId, type AssetResource } from "@t3tools/contracts";

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
