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
import { isWindowsAbsolutePath } from "@t3tools/shared/path";

import { useAssetUrlState, type AssetUrlState } from "~/assets/assetUrls";

function workspacePdfIdentityPath(workspaceRoot: string, relativePath: string): string {
  const joined = `${workspaceRoot.replace(/[\\/]+$/u, "")}/${relativePath.replace(/^[\\/]+/u, "")}`;
  return isWindowsAbsolutePath(workspaceRoot) ? joined.replaceAll("/", "\\").toLowerCase() : joined;
}

export function workspacePdfRelativePath(
  workspaceRoot: string,
  absolutePath: string,
): string | null {
  const normalizedRoot = workspaceRoot.replaceAll("\\", "/").replace(/\/+$/u, "");
  const normalizedPath = absolutePath.replaceAll("\\", "/");
  const rootPrefix = normalizedRoot.length === 0 ? "/" : `${normalizedRoot}/`;
  const caseInsensitive = isWindowsAbsolutePath(workspaceRoot);
  const comparableRoot = caseInsensitive ? rootPrefix.toLowerCase() : rootPrefix;
  const comparablePath = caseInsensitive ? normalizedPath.toLowerCase() : normalizedPath;
  if (!comparablePath.startsWith(comparableRoot)) return null;
  const relativePath = normalizedPath.slice(rootPrefix.length);
  return relativePath.length > 0 ? relativePath : null;
}

export function workspacePdfSource(input: {
  readonly environmentId: EnvironmentId;
  readonly fileName: string;
  readonly workspaceRoot: string;
  readonly relativePath: string;
  readonly legacyLocator?: {
    readonly absolutePath: string;
    readonly threadId: string;
  };
}): PdfSourceDescriptorType {
  return PdfSourceDescriptor.make({
    _tag: "workspace-pdf",
    authority: ArtifactAuthority.make(input.environmentId),
    logicalDocumentKey: LogicalDocumentKey.make(
      `workspace:${workspacePdfIdentityPath(input.workspaceRoot, input.relativePath)}`,
    ),
    title: input.fileName,
    fileName: input.fileName,
    capabilities: { canSaveCopy: true, canRevealSource: false },
    workspaceRoot: input.workspaceRoot,
    relativePath: input.relativePath,
    ...(input.legacyLocator ? { legacyLocator: input.legacyLocator } : {}),
  });
}

/** Only file-panel paths classified as PDFs may enter the strict PDF descriptor contract. */
export function workspacePdfSourceForPreview(input: {
  readonly absolutePath: string | null;
  readonly environmentId: EnvironmentId;
  readonly relativePath: string | null;
  readonly threadId: string;
  readonly workspaceRoot: string;
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
    environmentId: input.environmentId,
    fileName,
    workspaceRoot: input.workspaceRoot,
    relativePath: relativeSourcePath,
    legacyLocator: { absolutePath: sourcePath, threadId: input.threadId },
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
        cwd: source.workspaceRoot,
        relativePath: source.relativePath,
        ...(source.legacyLocator
          ? {
              threadId: ThreadId.make(source.legacyLocator.threadId),
              path: source.legacyLocator.absolutePath,
            }
          : {}),
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
