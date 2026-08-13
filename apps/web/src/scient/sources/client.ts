import {
  advanceEnvironmentScientSourcesImport,
  beginEnvironmentLocalSourceImport,
  beginEnvironmentZoteroImport,
  cancelEnvironmentScientSourcesImport,
  discardEnvironmentLocalSourcePdfs,
  getEnvironmentScientSourceAttachmentPreview,
  getEnvironmentScientSourcesOverview,
  getEnvironmentZoteroStatus,
  listEnvironmentZoteroLibrary,
  preflightEnvironmentZoteroImport,
  removeEnvironmentScientSource,
  updateEnvironmentScientSourceMetadata,
  uploadEnvironmentLocalSourcePdf,
} from "@t3tools/client-runtime/state/scient-sources";
import { resolveAssetUrl } from "@t3tools/client-runtime/state/assets";
import type {
  EnvironmentId,
  ScientSourceMetadataUpdateRequest,
  ScientSourceRemovalRequest,
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

export function updateScientSourceMetadata(
  environmentId: EnvironmentId,
  input: ScientSourceMetadataUpdateRequest,
) {
  return runtime.runPromise(
    updateEnvironmentScientSourceMetadata({ prepared: prepared(environmentId), ...input }),
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
  input: { readonly root: string; readonly attachmentId: string },
) {
  const connection = prepared(environmentId);
  const result = await runtime.runPromise(
    getEnvironmentScientSourceAttachmentPreview({ prepared: connection, ...input }),
  );
  const url = resolveAssetUrl(connection.httpBaseUrl, result.relativeUrl);
  if (url === null) throw new Error("The selected environment returned an invalid preview URL.");
  return { ...result, url };
}

export function readZoteroStatus(environmentId: EnvironmentId) {
  return runtime.runPromise(getEnvironmentZoteroStatus(prepared(environmentId)));
}

export function readZoteroLibrary(
  environmentId: EnvironmentId,
  input: { readonly query: string; readonly start: number; readonly limit: number },
) {
  return runtime.runPromise(
    listEnvironmentZoteroLibrary({ prepared: prepared(environmentId), ...input }),
  );
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
