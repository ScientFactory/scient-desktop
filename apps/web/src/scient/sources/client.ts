import {
  advanceEnvironmentScientSourcesImport,
  beginEnvironmentLocalSourceImport,
  beginEnvironmentZoteroImport,
  beginEnvironmentZoteroScopedImport,
  cancelEnvironmentScientSourcesImport,
  retryEnvironmentScientSourcesImport,
  discardEnvironmentLocalSourcePdfs,
  getEnvironmentScientSourceAttachmentPreview,
  getEnvironmentScientSourceDetail,
  getEnvironmentScientSourceJournalIcon,
  getEnvironmentScientSourcesOverview,
  getEnvironmentZoteroStatus,
  listEnvironmentZoteroLibrary,
  listEnvironmentZoteroCollections,
  preflightEnvironmentZoteroImport,
  refreshEnvironmentScientSourceMetadata,
  removeEnvironmentScientSource,
  updateEnvironmentScientSourceMetadata,
  updateEnvironmentScientSourceNote,
  updateEnvironmentScientSourceReview,
  uploadEnvironmentLocalSourcePdf,
} from "@t3tools/client-runtime/state/scient-sources";
import { resolveAssetUrl } from "@t3tools/client-runtime/state/assets";
import type {
  EnvironmentId,
  ScientSourceMetadataRefreshRequest,
  ScientSourceMetadataUpdateRequest,
  ScientSourceNoteUpdateRequest,
  ScientSourceRemovalRequest,
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

export function readZoteroStatus(environmentId: EnvironmentId) {
  return runtime.runPromise(getEnvironmentZoteroStatus(prepared(environmentId)));
}

export function readZoteroLibrary(
  environmentId: EnvironmentId,
  input: {
    readonly scope: ZoteroImportScope;
    readonly query: string;
    readonly start: number;
    readonly limit: number;
  },
) {
  return runtime.runPromise(
    listEnvironmentZoteroLibrary({ prepared: prepared(environmentId), ...input }),
  );
}

export function readZoteroCollections(environmentId: EnvironmentId) {
  return runtime.runPromise(listEnvironmentZoteroCollections(prepared(environmentId)));
}

export function preflightZoteroItems(
  environmentId: EnvironmentId,
  input: { readonly root: string; readonly itemKeys: ReadonlyArray<string> },
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

export function approveScientSource(
  environmentId: EnvironmentId,
  input: { readonly root: string; readonly sourceId: string; readonly expectedRevision: number },
) {
  return runtime.runPromise(
    updateEnvironmentScientSourceReview({ prepared: prepared(environmentId), ...input }),
  );
}
