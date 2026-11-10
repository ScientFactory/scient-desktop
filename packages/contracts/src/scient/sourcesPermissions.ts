import { AuthOrchestrationOperateScope } from "../auth.ts";

/**
 * Library changes travel over the environment's HTTP API (`group.endpoint`), not WebSocket RPC, so
 * these tags stay out of the server's RPC scope table; each scope matches its server route.
 */
export const SCIENT_SOURCES_HTTP_COMMANDS = {
  savePage: "scientSources.savePage",
  updateMetadata: "scientSources.updateMetadata",
  updateNote: "scientSources.updateNote",
  refreshMetadata: "scientSources.refreshMetadata",
  remove: "scientSources.remove",
  organize: "scientSources.organize",
  systematicReviewChange: "scientSources.systematicReviewChange",
  bulkUpdate: "scientSources.bulkUpdate",
  addByIdentifier: "scientSources.addByIdentifier",
  restore: "scientSources.restore",
  deletePermanently: "scientSources.deletePermanently",
  revert: "scientSources.revert",
  localPdfUpload: "scientSources.localPdfUpload",
  localBeginImport: "scientSources.localBeginImport",
  localDiscard: "scientSources.localDiscard",
  fileImport: "scientSources.fileImport",
  beginImport: "scientSources.beginImport",
  beginScopedImport: "scientSources.beginScopedImport",
  zoteroRefresh: "scientSources.zoteroRefresh",
  zoteroSend: "scientSources.zoteroSend",
  advanceImport: "scientSources.advanceImport",
  cancelImport: "scientSources.cancelImport",
  retryImport: "scientSources.retryImport",
  syncBibliography: "scientSources.syncBibliography",
  annotationsMutate: "scientPdf.annotationsMutate",
  referencesResolve: "scientReferences.resolve",
} as const;

export type ScientSourcesHttpCommandTag =
  (typeof SCIENT_SOURCES_HTTP_COMMANDS)[keyof typeof SCIENT_SOURCES_HTTP_COMMANDS];

export const SCIENT_SOURCES_GUARDED_HTTP_SCOPES = Object.fromEntries(
  Object.values(SCIENT_SOURCES_HTTP_COMMANDS).map((tag) => [tag, AuthOrchestrationOperateScope]),
) as Record<ScientSourcesHttpCommandTag, typeof AuthOrchestrationOperateScope>;
