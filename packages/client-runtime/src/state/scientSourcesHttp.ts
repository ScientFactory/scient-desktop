import * as Effect from "effect/Effect";

import type {
  ScientCitationStyleSetRequest,
  ScientCitationStylesRequest,
  ScientManagedBibliographySyncRequest,
  ScientSourceAttachmentPreviewRequest,
  ScientSourceDetailRequest,
  ScientSourceJournalIconRequest,
  ScientSourceMetadataRefreshRequest,
  ScientSourceMetadataUpdateRequest,
  ScientSourceNoteUpdateRequest,
  ScientSourcePersonalNoteUpdateRequest,
  ScientSourceRemovalRequest,
  ScientSourceRestoreRequest,
  ScientSourceRevertRequest,
  ScientSourceRevisionsRequest,
  ScientSourcesAddByIdentifierRequest,
  ScientSourcesAdvanceImportRequest,
  ScientSourceSavePageRequest,
  ScientSourcesBackupStatusRequest,
  ScientSourcesBeginImportRequest,
  ScientSourcesBulkUpdateRequest,
  ScientSourcesCancelImportRequest,
  ScientSourcesDiscardStagedRequest,
  ScientSourcesDuplicatesRequest,
  ScientSourcesExportRequest,
  ScientSourcesFullTextSearchRequest,
  ScientSourcesLibraryRestoreRequest,
  ScientSourcesMoveStatusRequest,
  ScientSourcesOrganizeRequest,
  ScientSourcesOverviewRequest,
  ScientSourcesPermanentDeletionRequest,
  ScientSourcesPreflightRequest,
  ScientSourcesReadingStateRequest,
  ScientSourceUsesRequest,
  ScientSourceCitationKeysRequest,
  ScientSourcesRecentChangesRequest,
  ScientSourcesRetryImportRequest,
  ScientSourcesTrashRequest,
  ScientSourcesZoteroRefreshRequest,
  ScientSourcesZoteroSendRequest,
  ScientSystematicReviewChangeRequest,
  ScientLiteratureWatchChangeRequest,
  ScientLiteratureWatchRequest,
  ScientLiteratureWatchesRequest,
  ScientSystematicReviewConflictRequest,
  ScientSystematicReviewConflictsRequest,
  ScientSystematicReviewRequest,
  ScientSystematicReviewsRequest,
  ZoteroConnection,
  ZoteroLibraryRequest,
  ZoteroScopedImportRequest,
} from "@t3tools/contracts";

import type { PreparedConnection } from "../connection/model.ts";

import { ManagedRelayDpopSigner } from "../relay/managedRelay.ts";
import { executeAuthenticatedEnvironmentHttpRequest } from "./environmentHttpAuth.ts";
import { RemoteEnvironmentAuthorization } from "../authorization/service.ts";

const REQUEST_TIMEOUT_MS = 15_000;
const METADATA_REFRESH_TIMEOUT_MS = 45_000;
const IMPORT_STEP_TIMEOUT_MS = 120_000;

export const getEnvironmentScientSourcesOverview = Effect.fn(
  "clientRuntime.state.getEnvironmentScientSourcesOverview",
)(function* (input: { readonly prepared: PreparedConnection } & ScientSourcesOverviewRequest) {
  const { prepared, ...payload } = input;
  const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
  const remoteAuthorization = yield* Effect.serviceOption(RemoteEnvironmentAuthorization);
  return yield* executeAuthenticatedEnvironmentHttpRequest({
    prepared,
    signer,
    remoteAuthorization,
    method: "POST",
    url: (urls) => urls.overview(),
    timeoutMs: REQUEST_TIMEOUT_MS,
    group: "scientSources",
    request: ({ client, headers }) => client.overview({ headers, payload }),
  });
});

export const getEnvironmentScientSourceDetail = Effect.fn(
  "clientRuntime.state.getEnvironmentScientSourceDetail",
)(function* (input: { readonly prepared: PreparedConnection } & ScientSourceDetailRequest) {
  const { prepared, ...payload } = input;
  const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
  const remoteAuthorization = yield* Effect.serviceOption(RemoteEnvironmentAuthorization);
  return yield* executeAuthenticatedEnvironmentHttpRequest({
    prepared,
    signer,
    remoteAuthorization,
    method: "POST",
    url: (urls) => urls.detail(),
    timeoutMs: REQUEST_TIMEOUT_MS,
    group: "scientSources",
    request: ({ client, headers }) => client.detail({ headers, payload }),
  });
});

export const searchEnvironmentScientSourcesFullText = Effect.fn(
  "clientRuntime.state.searchEnvironmentScientSourcesFullText",
)(function* (
  input: { readonly prepared: PreparedConnection } & ScientSourcesFullTextSearchRequest,
) {
  const { prepared, ...payload } = input;
  const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
  const remoteAuthorization = yield* Effect.serviceOption(RemoteEnvironmentAuthorization);
  return yield* executeAuthenticatedEnvironmentHttpRequest({
    prepared,
    signer,
    remoteAuthorization,
    method: "POST",
    url: (urls) => urls.fullTextSearch(),
    timeoutMs: REQUEST_TIMEOUT_MS,
    group: "scientSources",
    request: ({ client, headers }) => client.fullTextSearch({ headers, payload }),
  });
});

export const saveEnvironmentScientSourcePage = Effect.fn(
  "clientRuntime.state.saveEnvironmentScientSourcePage",
)(function* (input: { readonly prepared: PreparedConnection } & ScientSourceSavePageRequest) {
  const { prepared, ...payload } = input;
  const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
  const remoteAuthorization = yield* Effect.serviceOption(RemoteEnvironmentAuthorization);
  return yield* executeAuthenticatedEnvironmentHttpRequest({
    prepared,
    signer,
    remoteAuthorization,
    method: "POST",
    url: (urls) => urls.savePage(),
    timeoutMs: METADATA_REFRESH_TIMEOUT_MS,
    group: "scientSources",
    request: ({ client, headers }) => client.savePage({ headers, payload }),
  });
});

export const getEnvironmentScientSourceAttachmentPreview = Effect.fn(
  "clientRuntime.state.getEnvironmentScientSourceAttachmentPreview",
)(function* (
  input: { readonly prepared: PreparedConnection } & ScientSourceAttachmentPreviewRequest,
) {
  const { prepared, ...payload } = input;
  const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
  const remoteAuthorization = yield* Effect.serviceOption(RemoteEnvironmentAuthorization);
  return yield* executeAuthenticatedEnvironmentHttpRequest({
    prepared,
    signer,
    remoteAuthorization,
    method: "POST",
    url: (urls) => urls.attachmentPreview(),
    timeoutMs: REQUEST_TIMEOUT_MS,
    group: "scientSources",
    request: ({ client, headers }) => client.attachmentPreview({ headers, payload }),
  });
});

export const getEnvironmentScientSourceJournalIcon = Effect.fn(
  "clientRuntime.state.getEnvironmentScientSourceJournalIcon",
)(function* (input: { readonly prepared: PreparedConnection } & ScientSourceJournalIconRequest) {
  const { prepared, ...payload } = input;
  const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
  const remoteAuthorization = yield* Effect.serviceOption(RemoteEnvironmentAuthorization);
  return yield* executeAuthenticatedEnvironmentHttpRequest({
    prepared,
    signer,
    remoteAuthorization,
    method: "POST",
    url: (urls) => urls.journalIcon(),
    timeoutMs: REQUEST_TIMEOUT_MS,
    group: "scientSources",
    request: ({ client, headers }) => client.journalIcon({ headers, payload }),
  });
});

export const updateEnvironmentScientSourceMetadata = Effect.fn(
  "clientRuntime.state.updateEnvironmentScientSourceMetadata",
)(function* (input: { readonly prepared: PreparedConnection } & ScientSourceMetadataUpdateRequest) {
  const { prepared, ...payload } = input;
  const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
  const remoteAuthorization = yield* Effect.serviceOption(RemoteEnvironmentAuthorization);
  return yield* executeAuthenticatedEnvironmentHttpRequest({
    prepared,
    signer,
    remoteAuthorization,
    method: "POST",
    url: (urls) => urls.updateMetadata(),
    timeoutMs: REQUEST_TIMEOUT_MS,
    group: "scientSources",
    request: ({ client, headers }) => client.updateMetadata({ headers, payload }),
  });
});

export const refreshEnvironmentScientSourceMetadata = Effect.fn(
  "clientRuntime.state.refreshEnvironmentScientSourceMetadata",
)(function* (
  input: { readonly prepared: PreparedConnection } & ScientSourceMetadataRefreshRequest,
) {
  const { prepared, ...payload } = input;
  const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
  const remoteAuthorization = yield* Effect.serviceOption(RemoteEnvironmentAuthorization);
  return yield* executeAuthenticatedEnvironmentHttpRequest({
    prepared,
    signer,
    remoteAuthorization,
    method: "POST",
    url: (urls) => urls.refreshMetadata(),
    timeoutMs: METADATA_REFRESH_TIMEOUT_MS,
    group: "scientSources",
    request: ({ client, headers }) => client.refreshMetadata({ headers, payload }),
  });
});

export const updateEnvironmentScientSourceNote = Effect.fn(
  "clientRuntime.state.updateEnvironmentScientSourceNote",
)(function* (input: { readonly prepared: PreparedConnection } & ScientSourceNoteUpdateRequest) {
  const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
  const remoteAuthorization = yield* Effect.serviceOption(RemoteEnvironmentAuthorization);
  const { prepared, ...payload } = input;
  return yield* executeAuthenticatedEnvironmentHttpRequest({
    prepared,
    signer,
    remoteAuthorization,
    method: "POST",
    url: (urls) => urls.updateNote(),
    timeoutMs: REQUEST_TIMEOUT_MS,
    group: "scientSources",
    request: ({ client, headers }) => client.updateNote({ headers, payload }),
  });
});

/** Library servers only: the person's own note, which follows the paper into every project. */
export const updateEnvironmentScientSourcePersonalNote = Effect.fn(
  "clientRuntime.state.updateEnvironmentScientSourcePersonalNote",
)(function* (
  input: { readonly prepared: PreparedConnection } & ScientSourcePersonalNoteUpdateRequest,
) {
  const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
  const remoteAuthorization = yield* Effect.serviceOption(RemoteEnvironmentAuthorization);
  const { prepared, ...payload } = input;
  return yield* executeAuthenticatedEnvironmentHttpRequest({
    prepared,
    signer,
    remoteAuthorization,
    method: "POST",
    url: (urls) => urls.updatePersonalNote(),
    timeoutMs: REQUEST_TIMEOUT_MS,
    group: "scientSources",
    request: ({ client, headers }) => client.updatePersonalNote({ headers, payload }),
  });
});

/** Library servers only: marks sources read or unread, starred or not, in one request. */
export const setEnvironmentScientSourcesReadingState = Effect.fn(
  "clientRuntime.state.setEnvironmentScientSourcesReadingState",
)(function* (input: { readonly prepared: PreparedConnection } & ScientSourcesReadingStateRequest) {
  const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
  const remoteAuthorization = yield* Effect.serviceOption(RemoteEnvironmentAuthorization);
  const { prepared, ...payload } = input;
  return yield* executeAuthenticatedEnvironmentHttpRequest({
    prepared,
    signer,
    remoteAuthorization,
    method: "POST",
    url: (urls) => urls.setReadingState(),
    timeoutMs: REQUEST_TIMEOUT_MS,
    group: "scientSources",
    request: ({ client, headers }) => client.setReadingState({ headers, payload }),
  });
});

export const removeEnvironmentScientSource = Effect.fn(
  "clientRuntime.state.removeEnvironmentScientSource",
)(function* (input: { readonly prepared: PreparedConnection } & ScientSourceRemovalRequest) {
  const { prepared, ...payload } = input;
  const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
  const remoteAuthorization = yield* Effect.serviceOption(RemoteEnvironmentAuthorization);
  return yield* executeAuthenticatedEnvironmentHttpRequest({
    prepared,
    signer,
    remoteAuthorization,
    method: "POST",
    url: (urls) => urls.remove(),
    timeoutMs: REQUEST_TIMEOUT_MS,
    group: "scientSources",
    request: ({ client, headers }) => client.remove({ headers, payload }),
  });
});

export const addEnvironmentScientSourcesByIdentifier = Effect.fn(
  "clientRuntime.state.addEnvironmentScientSourcesByIdentifier",
)(function* (
  input: { readonly prepared: PreparedConnection } & ScientSourcesAddByIdentifierRequest,
) {
  const { prepared, ...payload } = input;
  const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
  const remoteAuthorization = yield* Effect.serviceOption(RemoteEnvironmentAuthorization);
  return yield* executeAuthenticatedEnvironmentHttpRequest({
    prepared,
    signer,
    remoteAuthorization,
    method: "POST",
    url: (urls) => urls.addByIdentifier(),
    // Registry rate limits (arXiv asks for one request every three seconds) make large lists slow.
    timeoutMs: IMPORT_STEP_TIMEOUT_MS,
    group: "scientSources",
    request: ({ client, headers }) => client.addByIdentifier({ headers, payload }),
  });
});

export const listEnvironmentScientSourceRecentChanges = Effect.fn(
  "clientRuntime.state.listEnvironmentScientSourceRecentChanges",
)(function* (input: { readonly prepared: PreparedConnection } & ScientSourcesRecentChangesRequest) {
  const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
  const remoteAuthorization = yield* Effect.serviceOption(RemoteEnvironmentAuthorization);
  const { prepared, ...payload } = input;
  return yield* executeAuthenticatedEnvironmentHttpRequest({
    prepared,
    signer,
    remoteAuthorization,
    method: "POST",
    url: (urls) => urls.recentChanges(),
    timeoutMs: REQUEST_TIMEOUT_MS,
    group: "scientSources",
    request: ({ client, headers }) => client.recentChanges({ headers, payload }),
  });
});

export const listEnvironmentScientSourceUses = Effect.fn(
  "clientRuntime.state.listEnvironmentScientSourceUses",
)(function* (input: { readonly prepared: PreparedConnection } & ScientSourceUsesRequest) {
  const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
  const remoteAuthorization = yield* Effect.serviceOption(RemoteEnvironmentAuthorization);
  const { prepared, ...payload } = input;
  return yield* executeAuthenticatedEnvironmentHttpRequest({
    prepared,
    signer,
    remoteAuthorization,
    method: "POST",
    url: (urls) => urls.sourceUses(),
    // Reads every Markdown and LaTeX document of the project.
    timeoutMs: METADATA_REFRESH_TIMEOUT_MS,
    group: "scientSources",
    request: ({ client, headers }) => client.sourceUses({ headers, payload }),
  });
});

export const readEnvironmentScientCitationKeys = Effect.fn(
  "clientRuntime.state.readEnvironmentScientCitationKeys",
)(function* (input: { readonly prepared: PreparedConnection } & ScientSourceCitationKeysRequest) {
  const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
  const remoteAuthorization = yield* Effect.serviceOption(RemoteEnvironmentAuthorization);
  const { prepared, ...payload } = input;
  return yield* executeAuthenticatedEnvironmentHttpRequest({
    prepared,
    signer,
    remoteAuthorization,
    method: "POST",
    url: (urls) => urls.sourceCitationKeys(),
    // Reads the document's bibliographies and, for LaTeX, every LaTeX file of the project.
    timeoutMs: METADATA_REFRESH_TIMEOUT_MS,
    group: "scientSources",
    request: ({ client, headers }) => client.sourceCitationKeys({ headers, payload }),
  });
});

export const listEnvironmentScientSourceTrash = Effect.fn(
  "clientRuntime.state.listEnvironmentScientSourceTrash",
)(function* (input: { readonly prepared: PreparedConnection } & ScientSourcesTrashRequest) {
  const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
  const remoteAuthorization = yield* Effect.serviceOption(RemoteEnvironmentAuthorization);
  const { prepared, ...payload } = input;
  return yield* executeAuthenticatedEnvironmentHttpRequest({
    prepared,
    signer,
    remoteAuthorization,
    method: "POST",
    url: (urls) => urls.trash(),
    timeoutMs: REQUEST_TIMEOUT_MS,
    group: "scientSources",
    request: ({ client, headers }) => client.trash({ headers, payload }),
  });
});

export const restoreEnvironmentScientSource = Effect.fn(
  "clientRuntime.state.restoreEnvironmentScientSource",
)(function* (input: { readonly prepared: PreparedConnection } & ScientSourceRestoreRequest) {
  const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
  const remoteAuthorization = yield* Effect.serviceOption(RemoteEnvironmentAuthorization);
  const { prepared, ...payload } = input;
  return yield* executeAuthenticatedEnvironmentHttpRequest({
    prepared,
    signer,
    remoteAuthorization,
    method: "POST",
    url: (urls) => urls.restore(),
    timeoutMs: REQUEST_TIMEOUT_MS,
    group: "scientSources",
    request: ({ client, headers }) => client.restore({ headers, payload }),
  });
});

export const deleteEnvironmentScientSourcesPermanently = Effect.fn(
  "clientRuntime.state.deleteEnvironmentScientSourcesPermanently",
)(function* (
  input: { readonly prepared: PreparedConnection } & ScientSourcesPermanentDeletionRequest,
) {
  const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
  const remoteAuthorization = yield* Effect.serviceOption(RemoteEnvironmentAuthorization);
  const { prepared, ...payload } = input;
  return yield* executeAuthenticatedEnvironmentHttpRequest({
    prepared,
    signer,
    remoteAuthorization,
    method: "POST",
    url: (urls) => urls.deletePermanently(),
    timeoutMs: REQUEST_TIMEOUT_MS,
    group: "scientSources",
    request: ({ client, headers }) => client.deletePermanently({ headers, payload }),
  });
});

export const listEnvironmentScientSourceRevisions = Effect.fn(
  "clientRuntime.state.listEnvironmentScientSourceRevisions",
)(function* (input: { readonly prepared: PreparedConnection } & ScientSourceRevisionsRequest) {
  const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
  const remoteAuthorization = yield* Effect.serviceOption(RemoteEnvironmentAuthorization);
  const { prepared, ...payload } = input;
  return yield* executeAuthenticatedEnvironmentHttpRequest({
    prepared,
    signer,
    remoteAuthorization,
    method: "POST",
    url: (urls) => urls.revisions(),
    timeoutMs: REQUEST_TIMEOUT_MS,
    group: "scientSources",
    request: ({ client, headers }) => client.revisions({ headers, payload }),
  });
});

export const revertEnvironmentScientSource = Effect.fn(
  "clientRuntime.state.revertEnvironmentScientSource",
)(function* (input: { readonly prepared: PreparedConnection } & ScientSourceRevertRequest) {
  const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
  const remoteAuthorization = yield* Effect.serviceOption(RemoteEnvironmentAuthorization);
  const { prepared, ...payload } = input;
  return yield* executeAuthenticatedEnvironmentHttpRequest({
    prepared,
    signer,
    remoteAuthorization,
    method: "POST",
    url: (urls) => urls.revert(),
    timeoutMs: REQUEST_TIMEOUT_MS,
    group: "scientSources",
    request: ({ client, headers }) => client.revert({ headers, payload }),
  });
});

export const organizeEnvironmentScientSources = Effect.fn(
  "clientRuntime.state.organizeEnvironmentScientSources",
)(function* (input: { readonly prepared: PreparedConnection } & ScientSourcesOrganizeRequest) {
  const { prepared, ...payload } = input;
  const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
  const remoteAuthorization = yield* Effect.serviceOption(RemoteEnvironmentAuthorization);
  return yield* executeAuthenticatedEnvironmentHttpRequest({
    prepared,
    signer,
    remoteAuthorization,
    method: "POST",
    url: (urls) => urls.organize(),
    timeoutMs: REQUEST_TIMEOUT_MS,
    group: "scientSources",
    request: ({ client, headers }) => client.organize({ headers, payload }),
  });
});

export const bulkUpdateEnvironmentScientSources = Effect.fn(
  "clientRuntime.state.bulkUpdateEnvironmentScientSources",
)(function* (input: { readonly prepared: PreparedConnection } & ScientSourcesBulkUpdateRequest) {
  const { prepared, ...payload } = input;
  const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
  const remoteAuthorization = yield* Effect.serviceOption(RemoteEnvironmentAuthorization);
  return yield* executeAuthenticatedEnvironmentHttpRequest({
    prepared,
    signer,
    remoteAuthorization,
    method: "POST",
    url: (urls) => urls.bulkUpdate(),
    // Each source in a bulk edit is its own revision write.
    timeoutMs: IMPORT_STEP_TIMEOUT_MS,
    group: "scientSources",
    request: ({ client, headers }) => client.bulkUpdate({ headers, payload }),
  });
});

export const listEnvironmentScientSystematicReviews = Effect.fn(
  "clientRuntime.state.listEnvironmentScientSystematicReviews",
)(function* (input: { readonly prepared: PreparedConnection } & ScientSystematicReviewsRequest) {
  const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
  const remoteAuthorization = yield* Effect.serviceOption(RemoteEnvironmentAuthorization);
  const { prepared, ...payload } = input;
  return yield* executeAuthenticatedEnvironmentHttpRequest({
    prepared,
    signer,
    remoteAuthorization,
    method: "POST",
    url: (urls) => urls.systematicReviews(),
    timeoutMs: REQUEST_TIMEOUT_MS,
    group: "scientSources",
    request: ({ client, headers }) => client.systematicReviews({ headers, payload }),
  });
});

export const getEnvironmentScientSystematicReview = Effect.fn(
  "clientRuntime.state.getEnvironmentScientSystematicReview",
)(function* (input: { readonly prepared: PreparedConnection } & ScientSystematicReviewRequest) {
  const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
  const remoteAuthorization = yield* Effect.serviceOption(RemoteEnvironmentAuthorization);
  const { prepared, ...payload } = input;
  return yield* executeAuthenticatedEnvironmentHttpRequest({
    prepared,
    signer,
    remoteAuthorization,
    method: "POST",
    url: (urls) => urls.systematicReview(),
    timeoutMs: REQUEST_TIMEOUT_MS,
    group: "scientSources",
    request: ({ client, headers }) => client.systematicReview({ headers, payload }),
  });
});

export const changeEnvironmentScientSystematicReview = Effect.fn(
  "clientRuntime.state.changeEnvironmentScientSystematicReview",
)(function* (
  input: { readonly prepared: PreparedConnection } & ScientSystematicReviewChangeRequest,
) {
  const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
  const remoteAuthorization = yield* Effect.serviceOption(RemoteEnvironmentAuthorization);
  const { prepared, ...payload } = input;
  return yield* executeAuthenticatedEnvironmentHttpRequest({
    prepared,
    signer,
    remoteAuthorization,
    method: "POST",
    url: (urls) => urls.systematicReviewChange(),
    timeoutMs: REQUEST_TIMEOUT_MS,
    group: "scientSources",
    request: ({ client, headers }) => client.systematicReviewChange({ headers, payload }),
  });
});

export const listEnvironmentScientLiteratureWatches = Effect.fn("clientRuntime.state.listEnvironmentScientLiteratureWatches")(function* (
  input: { readonly prepared: PreparedConnection } & ScientLiteratureWatchesRequest,
) {
  const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
  const remoteAuthorization = yield* Effect.serviceOption(RemoteEnvironmentAuthorization);
  const { prepared, ...payload } = input;
  return yield* executeAuthenticatedEnvironmentHttpRequest({
    prepared,
    signer,
    remoteAuthorization,
    method: "POST",
    url: (urls) => urls.literatureWatches(),
    timeoutMs: REQUEST_TIMEOUT_MS,
    group: "scientSources",
    request: ({ client, headers }) => client.literatureWatches({ headers, payload }),
  });
});

export const getEnvironmentScientLiteratureWatch = Effect.fn("clientRuntime.state.getEnvironmentScientLiteratureWatch")(function* (
  input: { readonly prepared: PreparedConnection } & ScientLiteratureWatchRequest,
) {
  const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
  const remoteAuthorization = yield* Effect.serviceOption(RemoteEnvironmentAuthorization);
  const { prepared, ...payload } = input;
  return yield* executeAuthenticatedEnvironmentHttpRequest({
    prepared,
    signer,
    remoteAuthorization,
    method: "POST",
    url: (urls) => urls.literatureWatch(),
    timeoutMs: REQUEST_TIMEOUT_MS,
    group: "scientSources",
    request: ({ client, headers }) => client.literatureWatch({ headers, payload }),
  });
});

export const changeEnvironmentScientLiteratureWatch = Effect.fn("clientRuntime.state.changeEnvironmentScientLiteratureWatch")(function* (
  input: { readonly prepared: PreparedConnection } & ScientLiteratureWatchChangeRequest,
) {
  const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
  const remoteAuthorization = yield* Effect.serviceOption(RemoteEnvironmentAuthorization);
  const { prepared, ...payload } = input;
  return yield* executeAuthenticatedEnvironmentHttpRequest({
    prepared,
    signer,
    remoteAuthorization,
    method: "POST",
    url: (urls) => urls.literatureWatchChange(),
    timeoutMs: REQUEST_TIMEOUT_MS,
    group: "scientSources",
    request: ({ client, headers }) => client.literatureWatchChange({ headers, payload }),
  });
});

export const listEnvironmentScientSystematicReviewConflicts = Effect.fn(
  "clientRuntime.state.listEnvironmentScientSystematicReviewConflicts",
)(function* (
  input: { readonly prepared: PreparedConnection } & ScientSystematicReviewConflictsRequest,
) {
  const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
  const remoteAuthorization = yield* Effect.serviceOption(RemoteEnvironmentAuthorization);
  const { prepared, ...payload } = input;
  return yield* executeAuthenticatedEnvironmentHttpRequest({
    prepared,
    signer,
    remoteAuthorization,
    method: "POST",
    url: (urls) => urls.systematicReviewConflicts(),
    timeoutMs: REQUEST_TIMEOUT_MS,
    group: "scientSources",
    request: ({ client, headers }) => client.systematicReviewConflicts({ headers, payload }),
  });
});

export const changeEnvironmentScientSystematicReviewConflict = Effect.fn(
  "clientRuntime.state.changeEnvironmentScientSystematicReviewConflict",
)(function* (
  input: { readonly prepared: PreparedConnection } & ScientSystematicReviewConflictRequest,
) {
  const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
  const remoteAuthorization = yield* Effect.serviceOption(RemoteEnvironmentAuthorization);
  const { prepared, ...payload } = input;
  return yield* executeAuthenticatedEnvironmentHttpRequest({
    prepared,
    signer,
    remoteAuthorization,
    method: "POST",
    url: (urls) => urls.systematicReviewConflict(),
    timeoutMs: REQUEST_TIMEOUT_MS,
    group: "scientSources",
    request: ({ client, headers }) => client.systematicReviewConflict({ headers, payload }),
  });
});

export const getEnvironmentScientSourcesDuplicates = Effect.fn(
  "clientRuntime.state.getEnvironmentScientSourcesDuplicates",
)(function* (input: { readonly prepared: PreparedConnection } & ScientSourcesDuplicatesRequest) {
  const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
  const remoteAuthorization = yield* Effect.serviceOption(RemoteEnvironmentAuthorization);
  const { prepared, ...payload } = input;
  return yield* executeAuthenticatedEnvironmentHttpRequest({
    prepared,
    signer,
    remoteAuthorization,
    method: "POST",
    url: (urls) => urls.duplicates(),
    timeoutMs: REQUEST_TIMEOUT_MS,
    group: "scientSources",
    request: ({ client, headers }) => client.duplicates({ headers, payload }),
  });
});

export const getEnvironmentScientSourcesMoveStatus = Effect.fn(
  "clientRuntime.state.getEnvironmentScientSourcesMoveStatus",
)(function* (input: { readonly prepared: PreparedConnection } & ScientSourcesMoveStatusRequest) {
  const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
  const remoteAuthorization = yield* Effect.serviceOption(RemoteEnvironmentAuthorization);
  const { prepared, ...payload } = input;
  return yield* executeAuthenticatedEnvironmentHttpRequest({
    prepared,
    signer,
    remoteAuthorization,
    method: "POST",
    url: (urls) => urls.moveStatus(),
    timeoutMs: REQUEST_TIMEOUT_MS,
    group: "scientSources",
    request: ({ client, headers }) => client.moveStatus({ headers, payload }),
  });
});

export const getEnvironmentScientSourcesBackupStatus = Effect.fn(
  "clientRuntime.state.getEnvironmentScientSourcesBackupStatus",
)(function* (input: { readonly prepared: PreparedConnection } & ScientSourcesBackupStatusRequest) {
  const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
  const remoteAuthorization = yield* Effect.serviceOption(RemoteEnvironmentAuthorization);
  const { prepared, ...payload } = input;
  return yield* executeAuthenticatedEnvironmentHttpRequest({
    prepared,
    signer,
    remoteAuthorization,
    method: "POST",
    url: (urls) => urls.backupStatus(),
    timeoutMs: REQUEST_TIMEOUT_MS,
    group: "scientSources",
    request: ({ client, headers }) => client.backupStatus({ headers, payload }),
  });
});

export const changeEnvironmentScientLibraryRestore = Effect.fn(
  "clientRuntime.state.changeEnvironmentScientLibraryRestore",
)(function* (
  input: { readonly prepared: PreparedConnection } & ScientSourcesLibraryRestoreRequest,
) {
  const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
  const remoteAuthorization = yield* Effect.serviceOption(RemoteEnvironmentAuthorization);
  const { prepared, ...payload } = input;
  return yield* executeAuthenticatedEnvironmentHttpRequest({
    prepared,
    signer,
    remoteAuthorization,
    method: "POST",
    url: (urls) => urls.libraryRestore(),
    timeoutMs: REQUEST_TIMEOUT_MS,
    group: "scientSources",
    request: ({ client, headers }) => client.libraryRestore({ headers, payload }),
  });
});

export const getEnvironmentZoteroStatus = Effect.fn(
  "clientRuntime.state.getEnvironmentZoteroStatus",
)(function* (prepared: PreparedConnection, connection?: ZoteroConnection) {
  const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
  const remoteAuthorization = yield* Effect.serviceOption(RemoteEnvironmentAuthorization);
  return yield* executeAuthenticatedEnvironmentHttpRequest({
    prepared: prepared,
    signer,
    remoteAuthorization,
    method: "POST",
    url: (urls) => urls.zoteroStatus(),
    timeoutMs: REQUEST_TIMEOUT_MS,
    group: "scientSources",
    request: ({ client, headers }) =>
      client.zoteroStatus({ headers, payload: connection ? { connection } : {} }),
  });
});

export const listEnvironmentZoteroLibrary = Effect.fn(
  "clientRuntime.state.listEnvironmentZoteroLibrary",
)(function* (input: { readonly prepared: PreparedConnection } & ZoteroLibraryRequest) {
  const { prepared, ...payload } = input;
  const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
  const remoteAuthorization = yield* Effect.serviceOption(RemoteEnvironmentAuthorization);
  return yield* executeAuthenticatedEnvironmentHttpRequest({
    prepared,
    signer,
    remoteAuthorization,
    method: "POST",
    url: (urls) => urls.zoteroLibrary(),
    timeoutMs: REQUEST_TIMEOUT_MS,
    group: "scientSources",
    request: ({ client, headers }) => client.zoteroLibrary({ headers, payload }),
  });
});

export const listEnvironmentZoteroCollections = Effect.fn(
  "clientRuntime.state.listEnvironmentZoteroCollections",
)(function* (prepared: PreparedConnection, connection?: ZoteroConnection, groupId?: string) {
  const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
  const remoteAuthorization = yield* Effect.serviceOption(RemoteEnvironmentAuthorization);
  return yield* executeAuthenticatedEnvironmentHttpRequest({
    prepared: prepared,
    signer,
    remoteAuthorization,
    method: "POST",
    url: (urls) => urls.zoteroCollections(),
    timeoutMs: REQUEST_TIMEOUT_MS,
    group: "scientSources",
    request: ({ client, headers }) =>
      client.zoteroCollections({
        headers,
        payload: { ...(connection ? { connection } : {}), ...(groupId ? { groupId } : {}) },
      }),
  });
});

export const preflightEnvironmentZoteroImport = Effect.fn(
  "clientRuntime.state.preflightEnvironmentZoteroImport",
)(function* (input: { readonly prepared: PreparedConnection } & ScientSourcesPreflightRequest) {
  const { prepared, ...payload } = input;
  const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
  const remoteAuthorization = yield* Effect.serviceOption(RemoteEnvironmentAuthorization);
  return yield* executeAuthenticatedEnvironmentHttpRequest({
    prepared,
    signer,
    remoteAuthorization,
    method: "POST",
    url: (urls) => urls.preflight(),
    timeoutMs: IMPORT_STEP_TIMEOUT_MS,
    group: "scientSources",
    request: ({ client, headers }) => client.preflight({ headers, payload }),
  });
});

export const beginEnvironmentZoteroImport = Effect.fn(
  "clientRuntime.state.beginEnvironmentZoteroImport",
)(function* (input: { readonly prepared: PreparedConnection } & ScientSourcesBeginImportRequest) {
  const { prepared, ...payload } = input;
  const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
  const remoteAuthorization = yield* Effect.serviceOption(RemoteEnvironmentAuthorization);
  return yield* executeAuthenticatedEnvironmentHttpRequest({
    prepared,
    signer,
    remoteAuthorization,
    method: "POST",
    url: (urls) => urls.beginImport(),
    timeoutMs: REQUEST_TIMEOUT_MS,
    group: "scientSources",
    request: ({ client, headers }) => client.beginImport({ headers, payload }),
  });
});

export const beginEnvironmentZoteroScopedImport = Effect.fn(
  "clientRuntime.state.beginEnvironmentZoteroScopedImport",
)(function* (input: { readonly prepared: PreparedConnection } & ZoteroScopedImportRequest) {
  const { prepared, ...payload } = input;
  const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
  const remoteAuthorization = yield* Effect.serviceOption(RemoteEnvironmentAuthorization);
  return yield* executeAuthenticatedEnvironmentHttpRequest({
    prepared,
    signer,
    remoteAuthorization,
    method: "POST",
    url: (urls) => urls.beginScopedImport(),
    timeoutMs: IMPORT_STEP_TIMEOUT_MS,
    group: "scientSources",
    request: ({ client, headers }) => client.beginScopedImport({ headers, payload }),
  });
});

export const refreshEnvironmentZoteroSources = Effect.fn(
  "clientRuntime.state.refreshEnvironmentZoteroSources",
)(function* (input: { readonly prepared: PreparedConnection } & ScientSourcesZoteroRefreshRequest) {
  const { prepared, ...payload } = input;
  const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
  const remoteAuthorization = yield* Effect.serviceOption(RemoteEnvironmentAuthorization);
  return yield* executeAuthenticatedEnvironmentHttpRequest({
    prepared,
    signer,
    remoteAuthorization,
    method: "POST",
    url: (urls) => urls.zoteroRefresh(),
    timeoutMs: IMPORT_STEP_TIMEOUT_MS,
    group: "scientSources",
    request: ({ client, headers }) => client.zoteroRefresh({ headers, payload }),
  });
});

export const sendEnvironmentSourcesToZotero = Effect.fn(
  "clientRuntime.state.sendEnvironmentSourcesToZotero",
)(function* (input: { readonly prepared: PreparedConnection } & ScientSourcesZoteroSendRequest) {
  const { prepared, ...payload } = input;
  const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
  const remoteAuthorization = yield* Effect.serviceOption(RemoteEnvironmentAuthorization);
  return yield* executeAuthenticatedEnvironmentHttpRequest({
    prepared,
    signer,
    remoteAuthorization,
    method: "POST",
    url: (urls) => urls.zoteroSend(),
    timeoutMs: IMPORT_STEP_TIMEOUT_MS,
    group: "scientSources",
    request: ({ client, headers }) => client.zoteroSend({ headers, payload }),
  });
});

export const uploadEnvironmentLocalSourcePdf = Effect.fn(
  "clientRuntime.state.uploadEnvironmentLocalSourcePdf",
)(function* (input: {
  readonly prepared: PreparedConnection;
  readonly root: string;
  readonly file: Blob;
  readonly fileName: string;
}) {
  const payload = new FormData();
  payload.append("root", input.root);
  payload.append("file", input.file, input.fileName);
  const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
  const remoteAuthorization = yield* Effect.serviceOption(RemoteEnvironmentAuthorization);
  return yield* executeAuthenticatedEnvironmentHttpRequest({
    prepared: input.prepared,
    signer,
    remoteAuthorization,
    method: "POST",
    url: (urls) => urls.localPdfUpload(),
    timeoutMs: IMPORT_STEP_TIMEOUT_MS,
    group: "scientSources",
    request: ({ client, headers }) =>
      client.localPdfUpload({
        headers,
        payload,
      }),
  });
});

export const importEnvironmentScientSourcesFile = Effect.fn(
  "clientRuntime.state.importEnvironmentScientSourcesFile",
)(function* (input: {
  readonly prepared: PreparedConnection;
  readonly root: string;
  readonly operationId: string;
  readonly file: Blob;
  readonly fileName: string;
  readonly sourcePath?: string;
  readonly pin?: boolean;
}) {
  const payload = new FormData();
  payload.append("root", input.root);
  payload.append("operationId", input.operationId);
  payload.append("file", input.file, input.fileName);
  if (input.sourcePath) payload.append("sourcePath", input.sourcePath);
  if (input.pin !== undefined) payload.append("pin", String(input.pin));
  const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
  const remoteAuthorization = yield* Effect.serviceOption(RemoteEnvironmentAuthorization);
  return yield* executeAuthenticatedEnvironmentHttpRequest({
    prepared: input.prepared,
    signer,
    remoteAuthorization,
    method: "POST",
    url: (urls) => urls.fileImport(),
    timeoutMs: IMPORT_STEP_TIMEOUT_MS,
    group: "scientSources",
    request: ({ client, headers }) => client.fileImport({ headers, payload }),
  });
});

export const exportEnvironmentScientSources = Effect.fn(
  "clientRuntime.state.exportEnvironmentScientSources",
)(function* (input: { readonly prepared: PreparedConnection } & ScientSourcesExportRequest) {
  const { prepared, ...payload } = input;
  const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
  const remoteAuthorization = yield* Effect.serviceOption(RemoteEnvironmentAuthorization);
  return yield* executeAuthenticatedEnvironmentHttpRequest({
    prepared,
    signer,
    remoteAuthorization,
    method: "POST",
    url: (urls) => urls.export(),
    timeoutMs: IMPORT_STEP_TIMEOUT_MS,
    group: "scientSources",
    request: ({ client, headers }) => client.export({ headers, payload }),
  });
});

export const beginEnvironmentLocalSourceImport = Effect.fn(
  "clientRuntime.state.beginEnvironmentLocalSourceImport",
)(function* (input: { readonly prepared: PreparedConnection } & ScientSourcesBeginImportRequest) {
  const { prepared, ...payload } = input;
  const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
  const remoteAuthorization = yield* Effect.serviceOption(RemoteEnvironmentAuthorization);
  return yield* executeAuthenticatedEnvironmentHttpRequest({
    prepared,
    signer,
    remoteAuthorization,
    method: "POST",
    url: (urls) => urls.localBeginImport(),
    timeoutMs: REQUEST_TIMEOUT_MS,
    group: "scientSources",
    request: ({ client, headers }) => client.localBeginImport({ headers, payload }),
  });
});

export const discardEnvironmentLocalSourcePdfs = Effect.fn(
  "clientRuntime.state.discardEnvironmentLocalSourcePdfs",
)(function* (input: { readonly prepared: PreparedConnection } & ScientSourcesDiscardStagedRequest) {
  const { prepared, ...payload } = input;
  const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
  const remoteAuthorization = yield* Effect.serviceOption(RemoteEnvironmentAuthorization);
  return yield* executeAuthenticatedEnvironmentHttpRequest({
    prepared,
    signer,
    remoteAuthorization,
    method: "POST",
    url: (urls) => urls.localDiscard(),
    timeoutMs: REQUEST_TIMEOUT_MS,
    group: "scientSources",
    request: ({ client, headers }) => client.localDiscard({ headers, payload }),
  });
});

export const advanceEnvironmentScientSourcesImport = Effect.fn(
  "clientRuntime.state.advanceEnvironmentScientSourcesImport",
)(function* (input: { readonly prepared: PreparedConnection } & ScientSourcesAdvanceImportRequest) {
  const { prepared, ...payload } = input;
  const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
  const remoteAuthorization = yield* Effect.serviceOption(RemoteEnvironmentAuthorization);
  return yield* executeAuthenticatedEnvironmentHttpRequest({
    prepared,
    signer,
    remoteAuthorization,
    method: "POST",
    url: (urls) => urls.advanceImport(),
    timeoutMs: IMPORT_STEP_TIMEOUT_MS,
    group: "scientSources",
    request: ({ client, headers }) => client.advanceImport({ headers, payload }),
  });
});

export const cancelEnvironmentScientSourcesImport = Effect.fn(
  "clientRuntime.state.cancelEnvironmentScientSourcesImport",
)(function* (input: { readonly prepared: PreparedConnection } & ScientSourcesCancelImportRequest) {
  const { prepared, ...payload } = input;
  const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
  const remoteAuthorization = yield* Effect.serviceOption(RemoteEnvironmentAuthorization);
  return yield* executeAuthenticatedEnvironmentHttpRequest({
    prepared,
    signer,
    remoteAuthorization,
    method: "POST",
    url: (urls) => urls.cancelImport(),
    timeoutMs: REQUEST_TIMEOUT_MS,
    group: "scientSources",
    request: ({ client, headers }) => client.cancelImport({ headers, payload }),
  });
});

export const retryEnvironmentScientSourcesImport = Effect.fn(
  "clientRuntime.state.retryEnvironmentScientSourcesImport",
)(function* (input: { readonly prepared: PreparedConnection } & ScientSourcesRetryImportRequest) {
  const { prepared, ...payload } = input;
  const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
  const remoteAuthorization = yield* Effect.serviceOption(RemoteEnvironmentAuthorization);
  return yield* executeAuthenticatedEnvironmentHttpRequest({
    prepared,
    signer,
    remoteAuthorization,
    method: "POST",
    url: (urls) => urls.retryImport(),
    timeoutMs: REQUEST_TIMEOUT_MS,
    group: "scientSources",
    request: ({ client, headers }) => client.retryImport({ headers, payload }),
  });
});

export const syncEnvironmentScientBibliography = Effect.fn(
  "clientRuntime.state.syncEnvironmentScientBibliography",
)(function* (
  input: { readonly prepared: PreparedConnection } & ScientManagedBibliographySyncRequest,
) {
  const { prepared, ...payload } = input;
  const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
  const remoteAuthorization = yield* Effect.serviceOption(RemoteEnvironmentAuthorization);
  return yield* executeAuthenticatedEnvironmentHttpRequest({
    prepared,
    signer,
    remoteAuthorization,
    method: "POST",
    url: (urls) => urls.syncBibliography(),
    timeoutMs: REQUEST_TIMEOUT_MS,
    group: "scientSources",
    request: ({ client, headers }) => client.syncBibliography({ headers, payload }),
  });
});

/** Downloading the style catalogue or a style can take a while on a slow network. */
export const readEnvironmentScientCitationStyles = Effect.fn(
  "clientRuntime.state.readEnvironmentScientCitationStyles",
)(function* (input: { readonly prepared: PreparedConnection } & ScientCitationStylesRequest) {
  const { prepared, ...payload } = input;
  const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
  const remoteAuthorization = yield* Effect.serviceOption(RemoteEnvironmentAuthorization);
  return yield* executeAuthenticatedEnvironmentHttpRequest({
    prepared,
    signer,
    remoteAuthorization,
    method: "POST",
    url: (urls) => urls.citationStyles(),
    timeoutMs: METADATA_REFRESH_TIMEOUT_MS,
    group: "scientSources",
    request: ({ client, headers }) => client.citationStyles({ headers, payload }),
  });
});

export const setEnvironmentScientCitationStyle = Effect.fn(
  "clientRuntime.state.setEnvironmentScientCitationStyle",
)(function* (input: { readonly prepared: PreparedConnection } & ScientCitationStyleSetRequest) {
  const { prepared, ...payload } = input;
  const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
  const remoteAuthorization = yield* Effect.serviceOption(RemoteEnvironmentAuthorization);
  return yield* executeAuthenticatedEnvironmentHttpRequest({
    prepared,
    signer,
    remoteAuthorization,
    method: "POST",
    url: (urls) => urls.citationStyleSet(),
    timeoutMs: METADATA_REFRESH_TIMEOUT_MS,
    group: "scientSources",
    request: ({ client, headers }) => client.citationStyleSet({ headers, payload }),
  });
});
