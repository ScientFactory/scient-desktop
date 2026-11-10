import {
  addEnvironmentScientSourcesByIdentifier,
  advanceEnvironmentScientSourcesImport,
  beginEnvironmentLocalSourceImport,
  beginEnvironmentZoteroImport,
  beginEnvironmentZoteroScopedImport,
  bulkUpdateEnvironmentScientSources,
  cancelEnvironmentScientSourcesImport,
  retryEnvironmentScientSourcesImport,
  discardEnvironmentLocalSourcePdfs,
  getEnvironmentScientSourceAttachmentPreview,
  searchEnvironmentScientSourcesFullText,
  saveEnvironmentScientSourcePage,
  getEnvironmentScientSourceDetail,
  getEnvironmentScientSourceJournalIcon,
  getEnvironmentScientSourcesOverview,
  getEnvironmentZoteroStatus,
  listEnvironmentZoteroLibrary,
  listEnvironmentZoteroCollections,
  organizeEnvironmentScientSources,
  preflightEnvironmentZoteroImport,
  refreshEnvironmentScientSourceMetadata,
  removeEnvironmentScientSource,
  deleteEnvironmentScientSourcesPermanently,
  listEnvironmentScientSourceRevisions,
  listEnvironmentScientSourceTrash,
  restoreEnvironmentScientSource,
  revertEnvironmentScientSource,
  syncEnvironmentScientBibliography,
  updateEnvironmentScientSourceMetadata,
  updateEnvironmentScientSourceNote,
  uploadEnvironmentLocalSourcePdf,
  importEnvironmentScientSourcesFile,
  exportEnvironmentScientSources,
} from "@t3tools/client-runtime/state/scient-sources";
import { resolveAssetUrl } from "@t3tools/client-runtime/state/assets";
import type {
  EnvironmentId,
  ScientManagedBibliographyFileName,
  ScientSourceMetadataRefreshRequest,
  ScientSourceMetadataUpdateRequest,
  ScientSourceNoteUpdateRequest,
  ScientSourceRemovalRequest,
  ScientSourceSavePageRequest,
  ScientSourcesBulkUpdateRequest,
  ScientSourcesOrganizeRequest,
  ScientSourcesExportRequest,
  ScientSourceRestoreRequest,
  ScientSourceRevertRequest,
  ScientSourceRevisionsRequest,
  ScientSourcesPermanentDeletionRequest,
  ScientSourcesTrashRequest,
  ZoteroConnection,
  ZoteroImportScope,
} from "@t3tools/contracts";

import { runtime } from "../../lib/runtime";
import { readPreparedConnection } from "../../state/session";

function prepared(environmentId: EnvironmentId) {
  const connection = readPreparedConnection(environmentId);
  if (connection === null) throw new Error("The selected environment is not connected.");
  return connection;
}

export function readScientSources(environmentId: EnvironmentId, root: string) {
  return runtime.runPromise(
    getEnvironmentScientSourcesOverview({ prepared: prepared(environmentId), root }),
  );
}

export function readScientSource(
  environmentId: EnvironmentId,
  input: { readonly root: string; readonly sourceId: string },
) {
  return runtime.runPromise(
    getEnvironmentScientSourceDetail({ prepared: prepared(environmentId), ...input }),
  );
}

export function updateScientSourceMetadata(
  environmentId: EnvironmentId,
  input: ScientSourceMetadataUpdateRequest,
) {
  return runtime.runPromise(
    updateEnvironmentScientSourceMetadata({ prepared: prepared(environmentId), ...input }),
  );
}

export function refreshScientSourceMetadata(
  environmentId: EnvironmentId,
  input: ScientSourceMetadataRefreshRequest,
) {
  return runtime.runPromise(
    refreshEnvironmentScientSourceMetadata({ prepared: prepared(environmentId), ...input }),
  );
}

export function updateScientSourceNote(
  environmentId: EnvironmentId,
  input: ScientSourceNoteUpdateRequest,
) {
  return runtime.runPromise(
    updateEnvironmentScientSourceNote({ prepared: prepared(environmentId), ...input }),
  );
}

export function removeScientSource(
  environmentId: EnvironmentId,
  input: ScientSourceRemovalRequest,
) {
  return runtime.runPromise(
    removeEnvironmentScientSource({ prepared: prepared(environmentId), ...input }),
  );
}

export function organizeScientSources(
  environmentId: EnvironmentId,
  input: ScientSourcesOrganizeRequest,
) {
  return runtime.runPromise(
    organizeEnvironmentScientSources({ prepared: prepared(environmentId), ...input }),
  );
}

export function bulkUpdateScientSources(
  environmentId: EnvironmentId,
  input: ScientSourcesBulkUpdateRequest,
) {
  return runtime.runPromise(
    bulkUpdateEnvironmentScientSources({ prepared: prepared(environmentId), ...input }),
  );
}

export async function searchScientSourcesFullText(
  environmentId: EnvironmentId,
  input: { readonly root: string; readonly query: string },
) {
  return runtime.runPromise(
    searchEnvironmentScientSourcesFullText({ prepared: prepared(environmentId), ...input }),
  );
}

export async function saveScientSourcePage(
  environmentId: EnvironmentId,
  input: ScientSourceSavePageRequest,
) {
  return runtime.runPromise(
    saveEnvironmentScientSourcePage({ prepared: prepared(environmentId), ...input }),
  );
}

export function readScientSourceTrash(
  environmentId: EnvironmentId,
  input: ScientSourcesTrashRequest,
) {
  return runtime.runPromise(
    listEnvironmentScientSourceTrash({ prepared: prepared(environmentId), ...input }),
  );
}

export function restoreScientSource(
  environmentId: EnvironmentId,
  input: ScientSourceRestoreRequest,
) {
  return runtime.runPromise(
    restoreEnvironmentScientSource({ prepared: prepared(environmentId), ...input }),
  );
}

export function deleteScientSourcesPermanently(
  environmentId: EnvironmentId,
  input: ScientSourcesPermanentDeletionRequest,
) {
  return runtime.runPromise(
    deleteEnvironmentScientSourcesPermanently({ prepared: prepared(environmentId), ...input }),
  );
}

export function readScientSourceRevisions(
  environmentId: EnvironmentId,
  input: ScientSourceRevisionsRequest,
) {
  return runtime.runPromise(
    listEnvironmentScientSourceRevisions({ prepared: prepared(environmentId), ...input }),
  );
}

export function revertScientSource(environmentId: EnvironmentId, input: ScientSourceRevertRequest) {
  return runtime.runPromise(
    revertEnvironmentScientSource({ prepared: prepared(environmentId), ...input }),
  );
}

export async function readScientSourceAttachmentPreview(
  environmentId: EnvironmentId,
  input: { readonly root: string; readonly sourceId: string; readonly attachmentId: string },
) {
  const connection = prepared(environmentId);
  const result = await runtime.runPromise(
    getEnvironmentScientSourceAttachmentPreview({ prepared: connection, ...input }),
  );
  const url = resolveAssetUrl(connection.httpBaseUrl, result.relativeUrl);
  if (url === null) throw new Error("The selected environment returned an invalid preview URL.");
  return { ...result, url };
}

export async function readScientSourceJournalIcon(
  environmentId: EnvironmentId,
  input: { readonly root: string; readonly sourceId: string },
) {
  const connection = prepared(environmentId);
  const result = await runtime.runPromise(
    getEnvironmentScientSourceJournalIcon({ prepared: connection, ...input }),
  );
  if (!result.icon) return null;
  const url = resolveAssetUrl(connection.httpBaseUrl, result.icon.relativeUrl);
  return url ? { ...result.icon, url } : null;
}

export function addScientSourcesByIdentifier(
  environmentId: EnvironmentId,
  input: { readonly root: string; readonly entries: ReadonlyArray<string> },
) {
  return runtime.runPromise(
    addEnvironmentScientSourcesByIdentifier({ prepared: prepared(environmentId), ...input }),
  );
}

export function readZoteroStatus(environmentId: EnvironmentId, connection?: ZoteroConnection) {
  return runtime.runPromise(getEnvironmentZoteroStatus(prepared(environmentId), connection));
}

export function readZoteroLibrary(
  environmentId: EnvironmentId,
  input: {
    readonly scope: ZoteroImportScope;
    readonly query: string;
    readonly start: number;
    readonly limit: number;
    readonly connection?: ZoteroConnection;
  },
) {
  return runtime.runPromise(
    listEnvironmentZoteroLibrary({ prepared: prepared(environmentId), ...input }),
  );
}

export function readZoteroCollections(environmentId: EnvironmentId, connection?: ZoteroConnection) {
  return runtime.runPromise(listEnvironmentZoteroCollections(prepared(environmentId), connection));
}

export function preflightZoteroItems(
  environmentId: EnvironmentId,
  input: {
    readonly root: string;
    readonly itemKeys: ReadonlyArray<string>;
    readonly connection?: ZoteroConnection;
  },
) {
  return runtime.runPromise(
    preflightEnvironmentZoteroImport({ prepared: prepared(environmentId), ...input }),
  );
}

export function beginZoteroItemsImport(
  environmentId: EnvironmentId,
  input: {
    readonly root: string;
    readonly operationId: string;
    readonly itemKeys: ReadonlyArray<string>;
    readonly possibleMetadataMatchOverrides: ReadonlyArray<string>;
    readonly connection?: ZoteroConnection;
  },
) {
  return runtime.runPromise(
    beginEnvironmentZoteroImport({ prepared: prepared(environmentId), ...input }),
  );
}

export function beginZoteroScopeImport(
  environmentId: EnvironmentId,
  input: {
    readonly root: string;
    readonly operationId: string;
    readonly scope: ZoteroImportScope;
    readonly connection?: ZoteroConnection;
  },
) {
  return runtime.runPromise(
    beginEnvironmentZoteroScopedImport({ prepared: prepared(environmentId), ...input }),
  );
}

export function uploadLocalSourcePdf(
  environmentId: EnvironmentId,
  input: { readonly root: string; readonly file: File },
) {
  return runtime.runPromise(
    uploadEnvironmentLocalSourcePdf({
      prepared: prepared(environmentId),
      root: input.root,
      file: input.file,
      fileName: input.file.name,
    }),
  );
}

export function beginLocalSourcesImport(
  environmentId: EnvironmentId,
  input: {
    readonly root: string;
    readonly operationId: string;
    readonly itemKeys: ReadonlyArray<string>;
    readonly possibleMetadataMatchOverrides: ReadonlyArray<string>;
  },
) {
  return runtime.runPromise(
    beginEnvironmentLocalSourceImport({ prepared: prepared(environmentId), ...input }),
  );
}

export function discardLocalSourcePdfs(
  environmentId: EnvironmentId,
  input: { readonly root: string; readonly itemKeys: ReadonlyArray<string> },
) {
  return runtime.runPromise(
    discardEnvironmentLocalSourcePdfs({ prepared: prepared(environmentId), ...input }),
  );
}

export function advanceSourcesImport(
  environmentId: EnvironmentId,
  input: { readonly root: string; readonly operationId: string },
) {
  return runtime.runPromise(
    advanceEnvironmentScientSourcesImport({ prepared: prepared(environmentId), ...input }),
  );
}

export function cancelSourcesImport(
  environmentId: EnvironmentId,
  input: { readonly root: string; readonly operationId: string },
) {
  return runtime.runPromise(
    cancelEnvironmentScientSourcesImport({ prepared: prepared(environmentId), ...input }),
  );
}

export function retrySourcesImport(
  environmentId: EnvironmentId,
  input: {
    readonly root: string;
    readonly operationId: string;
    readonly itemKeys: ReadonlyArray<string>;
  },
) {
  return runtime.runPromise(
    retryEnvironmentScientSourcesImport({ prepared: prepared(environmentId), ...input }),
  );
}

export function importScientSourcesFile(
  environmentId: EnvironmentId,
  input: { readonly root: string; readonly operationId: string; readonly file: File },
) {
  return runtime.runPromise(
    importEnvironmentScientSourcesFile({
      prepared: prepared(environmentId),
      root: input.root,
      operationId: input.operationId,
      file: input.file,
      fileName: input.file.name,
    }),
  );
}

export function exportScientSources(
  environmentId: EnvironmentId,
  input: ScientSourcesExportRequest,
) {
  return runtime.runPromise(
    exportEnvironmentScientSources({ prepared: prepared(environmentId), ...input }),
  );
}

export function syncScientBibliography(
  environmentId: EnvironmentId,
  input: {
    readonly root: string;
    readonly replaceEdited?: ReadonlyArray<ScientManagedBibliographyFileName>;
  },
) {
  return runtime.runPromise(
    syncEnvironmentScientBibliography({ prepared: prepared(environmentId), ...input }),
  );
}
