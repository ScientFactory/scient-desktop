import * as Schema from "effect/Schema";
import { AuthOrchestrationOperateScope, AuthSettingsWriteScope } from "../auth.ts";
import { SCIENT_ACCOUNT_WS_METHODS } from "./accountRpcs.ts";
import { PaperQueueRequestInput } from "./accounts.ts";

/**
 * Library changes travel over the environment's HTTP API (`group.endpoint`), not WebSocket RPC, so
 * these tags stay out of the server's RPC scope table; each scope matches its server route.
 */
export const SCIENT_SOURCES_HTTP_COMMANDS = {
  savePage: "scientSources.savePage",
  updateMetadata: "scientSources.updateMetadata",
  updateNote: "scientSources.updateNote",
  updatePersonalNote: "scientSources.updatePersonalNote",
  setReadingState: "scientSources.setReadingState",
  refreshMetadata: "scientSources.refreshMetadata",
  remove: "scientSources.remove",
  organize: "scientSources.organize",
  systematicReviewChange: "scientSources.systematicReviewChange",
  systematicReviewConflict: "scientSources.systematicReviewConflict",
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
  citationStyleSet: "scientSources.citationStyleSet",
  annotationsMutate: "scientPdf.annotationsMutate",
  referencesResolve: "scientReferences.resolve",
} as const;

export type ScientSourcesHttpCommandTag =
  (typeof SCIENT_SOURCES_HTTP_COMMANDS)[keyof typeof SCIENT_SOURCES_HTTP_COMMANDS];

export const SCIENT_SOURCES_GUARDED_HTTP_SCOPES = Object.fromEntries(
  Object.values(SCIENT_SOURCES_HTTP_COMMANDS).map((tag) => [tag, AuthOrchestrationOperateScope]),
) as Record<ScientSourcesHttpCommandTag, typeof AuthOrchestrationOperateScope>;

const PAPER_INTO_LIBRARY_SCOPES = [AuthSettingsWriteScope, AuthOrchestrationOperateScope] as const;
const isPaperQueueRequest = Schema.is(PaperQueueRequestInput);

/**
 * Paper fetches use the settings grant; one that files its PDF on a Source or adds it to the
 * Library also needs the Library grant. Undefined leaves the method's own scope.
 */
export const scientPaperRequestScopes = (method: string, input: unknown) => {
  if (method === SCIENT_ACCOUNT_WS_METHODS.accountsPaperForSource) return PAPER_INTO_LIBRARY_SCOPES;
  if (method !== SCIENT_ACCOUNT_WS_METHODS.accountsPapersRequest || input === undefined) return;
  const intoLibrary =
    !isPaperQueueRequest(input) ||
    input.papers.some((paper) => paper.source !== undefined || paper.library === true);
  return intoLibrary ? PAPER_INTO_LIBRARY_SCOPES : undefined;
};
