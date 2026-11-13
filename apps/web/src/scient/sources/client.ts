import {
  getEnvironmentScientSourcesDuplicates,
  getEnvironmentScientSourcesMoveStatus,
  getEnvironmentScientSystematicReview,
  listEnvironmentScientSystematicReviewConflicts,
  listEnvironmentScientSystematicReviews,
  getEnvironmentScientSourceAttachmentPreview,
  searchEnvironmentScientSourcesFullText,
  getEnvironmentScientSourceDetail,
  getEnvironmentScientSourceJournalIcon,
  getEnvironmentScientSourcesOverview,
  getEnvironmentZoteroStatus,
  listEnvironmentZoteroLibrary,
  listEnvironmentZoteroCollections,
  preflightEnvironmentZoteroImport,
  listEnvironmentScientSourceRevisions,
  listEnvironmentScientSourceTrash,
  exportEnvironmentScientSources,
  readEnvironmentScientCitationStyles,
} from "@t3tools/client-runtime/state/scient-sources";
import { resolveAssetUrl } from "@t3tools/client-runtime/state/assets";
import type {
  EnvironmentId,
  ScientCitationStyleSetRequest,
  ScientCitationStylesRequest,
  ScientManagedBibliographyFileName,
  ScientSourceMetadataRefreshRequest,
  ScientSourceMetadataUpdateRequest,
  ScientSourceNoteUpdateRequest,
  ScientSourcePersonalNoteUpdateRequest,
  ScientSourceRemovalRequest,
  ScientSourceSavePageRequest,
  ScientSourcesBulkUpdateRequest,
  ScientSourcesDuplicatesRequest,
  ScientSourcesOrganizeRequest,
  ScientSourcesReadingStateRequest,
  ScientSourcesScope,
  ScientSystematicReviewChangeRequest,
  ScientSystematicReviewConflictRequest,
  ScientSystematicReviewRequest,
  ScientSystematicReviewsRequest,
  ScientSourcesExportRequest,
  ScientSourceRestoreRequest,
  ScientSourceRevertRequest,
  ScientSourceRevisionsRequest,
  ScientSourcesPermanentDeletionRequest,
  ScientSourcesTrashRequest,
  ScientSourcesZoteroRefreshRequest,
  ScientSourcesZoteroSendRequest,
  ZoteroConnection,
  ZoteroImportScope,
} from "@t3tools/contracts";

import { runtime } from "../../lib/runtime";
import { readPrimaryEnvironmentId } from "../../state/environments";
import { readPreparedConnection } from "../../state/session";
import { runSourcesCommand, sourcesCommands } from "./sourcesCommands";

function prepared(environmentId: EnvironmentId) {
  const connection = readPreparedConnection(environmentId);
  if (connection === null) throw new Error("The selected environment is not connected.");
  return connection;
}

/** `scope` is sent only to a server that offers scopes, and only for the Library view. */
export function readScientSources(
  environmentId: EnvironmentId,
  root: string,
  scope?: ScientSourcesScope,
) {
  return runtime.runPromise(
    getEnvironmentScientSourcesOverview({
      prepared: prepared(environmentId),
      root,
      ...(scope ? { scope } : {}),
    }),
  );
}

export function readScientSource(
  environmentId: EnvironmentId,
  input: {
    readonly root: string;
    readonly sourceId: string;
    readonly reviewId?: string;
    readonly citationKey?: string;
  },
) {
  return runtime.runPromise(
    getEnvironmentScientSourceDetail({ prepared: prepared(environmentId), ...input }),
  );
}

export function updateScientSourceMetadata(
  environmentId: EnvironmentId,
  input: ScientSourceMetadataUpdateRequest,
) {
  return runSourcesCommand(sourcesCommands.updateMetadata, environmentId, input);
}

export function refreshScientSourceMetadata(
  environmentId: EnvironmentId,
  input: ScientSourceMetadataRefreshRequest,
) {
  return runSourcesCommand(sourcesCommands.refreshMetadata, environmentId, input);
}

export function updateScientSourceNote(
  environmentId: EnvironmentId,
  input: ScientSourceNoteUpdateRequest,
) {
  return runSourcesCommand(sourcesCommands.updateNote, environmentId, input);
}

export function updateScientSourcePersonalNote(
  environmentId: EnvironmentId,
  input: ScientSourcePersonalNoteUpdateRequest,
) {
  return runSourcesCommand(sourcesCommands.updatePersonalNote, environmentId, input);
}

export function setScientSourcesReadingState(
  environmentId: EnvironmentId,
  input: ScientSourcesReadingStateRequest,
) {
  return runSourcesCommand(sourcesCommands.setReadingState, environmentId, input);
}

export function removeScientSource(
  environmentId: EnvironmentId,
  input: ScientSourceRemovalRequest,
) {
  return runSourcesCommand(sourcesCommands.remove, environmentId, input);
}

export function organizeScientSources(
  environmentId: EnvironmentId,
  input: ScientSourcesOrganizeRequest,
) {
  return runSourcesCommand(sourcesCommands.organize, environmentId, input);
}

export function readSystematicReviews(
  environmentId: EnvironmentId,
  input: ScientSystematicReviewsRequest,
) {
  return runtime.runPromise(
    listEnvironmentScientSystematicReviews({ prepared: prepared(environmentId), ...input }),
  );
}

export function readSystematicReview(
  environmentId: EnvironmentId,
  input: ScientSystematicReviewRequest,
) {
  return runtime.runPromise(
    getEnvironmentScientSystematicReview({ prepared: prepared(environmentId), ...input }),
  );
}

export function changeSystematicReview(
  environmentId: EnvironmentId,
  input: ScientSystematicReviewChangeRequest,
) {
  return runSourcesCommand(sourcesCommands.systematicReviewChange, environmentId, input);
}

export function readSystematicReviewConflicts(
  environmentId: EnvironmentId,
  input: ScientSystematicReviewRequest,
) {
  return runtime.runPromise(
    listEnvironmentScientSystematicReviewConflicts({ prepared: prepared(environmentId), ...input }),
  );
}

export function changeSystematicReviewConflict(
  environmentId: EnvironmentId,
  input: ScientSystematicReviewConflictRequest,
) {
  return runSourcesCommand(sourcesCommands.systematicReviewConflict, environmentId, input);
}

/** Where this project's move into the personal Library is; a project server has nothing to move. */
export function readLibraryDuplicates(
  environmentId: EnvironmentId,
  root: string,
  page: Omit<ScientSourcesDuplicatesRequest, "root"> = {},
) {
  return runtime.runPromise(
    getEnvironmentScientSourcesDuplicates({ prepared: prepared(environmentId), root, ...page }),
  );
}

export function readLibraryMoveStatus(environmentId: EnvironmentId, root: string) {
  return runtime.runPromise(
    getEnvironmentScientSourcesMoveStatus({ prepared: prepared(environmentId), root }),
  );
}

export function bulkUpdateScientSources(
  environmentId: EnvironmentId,
  input: ScientSourcesBulkUpdateRequest,
) {
  return runSourcesCommand(sourcesCommands.bulkUpdate, environmentId, input);
}

export async function searchScientSourcesFullText(
  environmentId: EnvironmentId,
  input: {
    readonly root: string;
    readonly query: string;
    readonly sourceIds?: ReadonlyArray<string>;
  },
) {
  return runtime.runPromise(
    searchEnvironmentScientSourcesFullText({ prepared: prepared(environmentId), ...input }),
  );
}

export async function saveScientSourcePage(
  environmentId: EnvironmentId,
  input: ScientSourceSavePageRequest,
) {
  return runSourcesCommand(sourcesCommands.savePage, environmentId, input);
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
  return runSourcesCommand(sourcesCommands.restore, environmentId, input);
}

export function deleteScientSourcesPermanently(
  environmentId: EnvironmentId,
  input: ScientSourcesPermanentDeletionRequest,
) {
  return runSourcesCommand(sourcesCommands.deletePermanently, environmentId, input);
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
  return runSourcesCommand(sourcesCommands.revert, environmentId, input);
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
  input: {
    readonly root: string;
    readonly entries: ReadonlyArray<string>;
    readonly pin?: boolean;
  },
) {
  return runSourcesCommand(sourcesCommands.addByIdentifier, environmentId, input);
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
    readonly groupId?: string;
  },
) {
  return runtime.runPromise(
    listEnvironmentZoteroLibrary({ prepared: prepared(environmentId), ...input }),
  );
}

export function readZoteroCollections(
  environmentId: EnvironmentId,
  connection?: ZoteroConnection,
  groupId?: string,
) {
  return runtime.runPromise(
    listEnvironmentZoteroCollections(prepared(environmentId), connection, groupId),
  );
}

export function preflightZoteroItems(
  environmentId: EnvironmentId,
  input: {
    readonly root: string;
    readonly itemKeys: ReadonlyArray<string>;
    readonly connection?: ZoteroConnection;
    readonly groupId?: string;
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
    readonly groupId?: string;
    readonly pin?: boolean;
  },
) {
  return runSourcesCommand(sourcesCommands.beginImport, environmentId, input);
}

export function beginZoteroScopeImport(
  environmentId: EnvironmentId,
  input: {
    readonly root: string;
    readonly operationId: string;
    readonly scope: ZoteroImportScope;
    readonly connection?: ZoteroConnection;
    readonly groupId?: string;
    readonly pin?: boolean;
  },
) {
  return runSourcesCommand(sourcesCommands.beginScopedImport, environmentId, input);
}

export function refreshZoteroSources(
  environmentId: EnvironmentId,
  input: ScientSourcesZoteroRefreshRequest,
) {
  return runSourcesCommand(sourcesCommands.zoteroRefresh, environmentId, input);
}

export function sendSourcesToZotero(
  environmentId: EnvironmentId,
  input: ScientSourcesZoteroSendRequest,
) {
  return runSourcesCommand(sourcesCommands.zoteroSend, environmentId, input);
}

export function uploadLocalSourcePdf(
  environmentId: EnvironmentId,
  input: { readonly root: string; readonly file: File },
) {
  return runSourcesCommand(sourcesCommands.localPdfUpload, environmentId, {
    root: input.root,
    file: input.file,
    fileName: input.file.name,
  });
}

export function beginLocalSourcesImport(
  environmentId: EnvironmentId,
  input: {
    readonly root: string;
    readonly operationId: string;
    readonly itemKeys: ReadonlyArray<string>;
    readonly possibleMetadataMatchOverrides: ReadonlyArray<string>;
    readonly pin?: boolean;
  },
) {
  return runSourcesCommand(sourcesCommands.localBeginImport, environmentId, input);
}

export function discardLocalSourcePdfs(
  environmentId: EnvironmentId,
  input: { readonly root: string; readonly itemKeys: ReadonlyArray<string> },
) {
  return runSourcesCommand(sourcesCommands.localDiscard, environmentId, input);
}

export function advanceSourcesImport(
  environmentId: EnvironmentId,
  input: { readonly root: string; readonly operationId: string },
) {
  return runSourcesCommand(sourcesCommands.advanceImport, environmentId, input);
}

export function cancelSourcesImport(
  environmentId: EnvironmentId,
  input: { readonly root: string; readonly operationId: string },
) {
  return runSourcesCommand(sourcesCommands.cancelImport, environmentId, input);
}

export function retrySourcesImport(
  environmentId: EnvironmentId,
  input: {
    readonly root: string;
    readonly operationId: string;
    readonly itemKeys: ReadonlyArray<string>;
  },
) {
  return runSourcesCommand(sourcesCommands.retryImport, environmentId, input);
}

export function importScientSourcesFile(
  environmentId: EnvironmentId,
  input: {
    readonly root: string;
    readonly operationId: string;
    readonly file: File;
    readonly pin?: boolean;
  },
) {
  // A path on this computer means nothing to another computer's server.
  const sourcePath =
    environmentId === readPrimaryEnvironmentId()
      ? window.desktopBridge?.getPathForFile(input.file)
      : null;
  return runSourcesCommand(sourcesCommands.fileImport, environmentId, {
    root: input.root,
    operationId: input.operationId,
    file: input.file,
    fileName: input.file.name,
    ...(sourcePath ? { sourcePath } : {}),
    ...(input.pin !== undefined ? { pin: input.pin } : {}),
  });
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
    readonly importEdited?: ReadonlyArray<ScientManagedBibliographyFileName>;
  },
) {
  return runSourcesCommand(sourcesCommands.syncBibliography, environmentId, input);
}

export function readCitationStyles(
  environmentId: EnvironmentId,
  input: ScientCitationStylesRequest,
) {
  return runtime.runPromise(
    readEnvironmentScientCitationStyles({ prepared: prepared(environmentId), ...input }),
  );
}

export function setCitationStyle(
  environmentId: EnvironmentId,
  input: ScientCitationStyleSetRequest,
) {
  return runSourcesCommand(sourcesCommands.citationStyleSet, environmentId, input);
}
