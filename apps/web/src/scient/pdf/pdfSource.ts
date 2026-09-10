import {
  ArtifactAuthority,
  LogicalDocumentKey,
  PdfSourceDescriptor,
  type PdfSourceActions,
  type PdfSourceDescriptor as PdfSourceDescriptorType,
  type PdfSourceResolver,
  type ResolvedPdfSource,
} from "@scientfactory/document-artifacts";
import { sha256 } from "@noble/hashes/sha2";
import {
  EnvironmentFilePath,
  EnvironmentId,
  ThreadId,
  type AssetResource,
} from "@t3tools/contracts";
import { isWorkspacePdfPreviewPath } from "@t3tools/shared/filePreview";
import { isWindowsAbsolutePath } from "@t3tools/shared/path";

import { useAssetUrlState, type AssetUrlState } from "~/assets/assetUrls";
import { ensureLocalApi } from "~/localApi";

function sha256Hex(value: string): string {
  return [...sha256(new TextEncoder().encode(value))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function environmentPdfFileName(fileName: string): string {
  const suffix = /\.pdf$/iu.test(fileName) ? "" : ".pdf";
  return `${fileName.slice(0, 255 - suffix.length)}${suffix}`;
}

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

export function environmentPdfSource(input: {
  readonly environmentId: EnvironmentId;
  readonly canonicalPath: string;
  readonly fileName: string;
}): PdfSourceDescriptorType {
  const identityPath = isWindowsAbsolutePath(input.canonicalPath)
    ? input.canonicalPath.replaceAll("/", "\\").toLowerCase()
    : input.canonicalPath;
  return PdfSourceDescriptor.make({
    _tag: "environment-pdf",
    authority: ArtifactAuthority.make(input.environmentId),
    logicalDocumentKey: LogicalDocumentKey.make(`environment:${sha256Hex(identityPath)}`),
    title: input.fileName.slice(0, 512),
    fileName: environmentPdfFileName(input.fileName),
    capabilities: { canSaveCopy: true, canRevealSource: false },
    path: input.canonicalPath,
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

  if (workspacePdfRelativePath(input.workspaceRoot, sourcePath) === null) {
    return environmentPdfSource({
      environmentId: input.environmentId,
      canonicalPath: sourcePath,
      fileName,
    });
  }

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
  switch (source._tag) {
    case "workspace-pdf":
      return {
        _tag: "workspace-file",
        cwd: source.workspaceRoot,
        relativePath: source.relativePath,
        ...(source.legacyLocator
          ? {
              threadId: ThreadId.make(source.legacyLocator.threadId),
              path: source.legacyLocator.absolutePath,
            }
          : {}),
      };
    case "generated-pdf":
      return {
        _tag: "generated-document",
        authority: source.authority,
        artifactId: source.artifactId,
        revisionId: source.revisionId,
      };
    case "environment-pdf":
      return {
        _tag: "environment-file",
        path: EnvironmentFilePath.make(source.path),
        access: "exact",
      };
  }
}

export const webPdfSourceActions: PdfSourceActions = {
  saveCopy: saveResolvedPdfCopy,
};

export function saveResolvedPdfCopy(source: PdfSourceDescriptorType, resolved: ResolvedPdfSource) {
  return ensureLocalApi().documents.saveAssetCopy({
    url: resolved.url,
    suggestedFileName: source.fileName,
  });
}
