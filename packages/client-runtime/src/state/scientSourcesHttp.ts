import * as Effect from "effect/Effect";

import type {
  ScientManagedBibliographySyncRequest,
  ScientSourceMetadataRefreshRequest,
  ScientSourceMetadataUpdateRequest,
  ScientSourceNoteUpdateRequest,
  ScientSourceRemovalRequest,
  ScientSourcesAddByIdentifierRequest,
  ScientSourcesBulkUpdateRequest,
  ScientSourcesOrganizeRequest,
  ScientSystematicReviewChangeRequest,
  ScientSystematicReviewRequest,
  ScientSystematicReviewsRequest,
  ScientSourceRestoreRequest,
  ScientSourceRevertRequest,
  ScientSourceRevisionsRequest,
  ScientSourcesPermanentDeletionRequest,
  ScientSourcesTrashRequest,
  ZoteroConnection,
  ZoteroImportScope,
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
)(function* (input: { readonly prepared: PreparedConnection; readonly root: string }) {
  const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
  const remoteAuthorization = yield* Effect.serviceOption(RemoteEnvironmentAuthorization);
  return yield* executeAuthenticatedEnvironmentHttpRequest({
    prepared: input.prepared,
    signer,
    remoteAuthorization,
    method: "POST",
    url: (urls) => urls.overview(),
    timeoutMs: REQUEST_TIMEOUT_MS,
    group: "scientSources",
    request: ({ client, headers }) =>
      client.overview({
        headers,
        payload: { root: input.root },
      }),
  });
});

export const getEnvironmentScientSourceDetail = Effect.fn(
  "clientRuntime.state.getEnvironmentScientSourceDetail",
)(function* (input: {
  readonly prepared: PreparedConnection;
  readonly root: string;
  readonly sourceId: string;
}) {
  const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
  const remoteAuthorization = yield* Effect.serviceOption(RemoteEnvironmentAuthorization);
  return yield* executeAuthenticatedEnvironmentHttpRequest({
    prepared: input.prepared,
    signer,
    remoteAuthorization,
    method: "POST",
    url: (urls) => urls.detail(),
    timeoutMs: REQUEST_TIMEOUT_MS,
    group: "scientSources",
    request: ({ client, headers }) =>
      client.detail({
        headers,
        payload: { root: input.root, sourceId: input.sourceId },
      }),
  });
});

export const searchEnvironmentScientSourcesFullText = Effect.fn(
  "clientRuntime.state.searchEnvironmentScientSourcesFullText",
)(function* (input: {
  readonly prepared: PreparedConnection;
  readonly root: string;
  readonly query: string;
}) {
  const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
  const remoteAuthorization = yield* Effect.serviceOption(RemoteEnvironmentAuthorization);
  return yield* executeAuthenticatedEnvironmentHttpRequest({
    prepared: input.prepared,
    signer,
    remoteAuthorization,
    method: "POST",
    url: (urls) => urls.fullTextSearch(),
    timeoutMs: REQUEST_TIMEOUT_MS,
    group: "scientSources",
    request: ({ client, headers }) =>
      client.fullTextSearch({
        headers,
        payload: { root: input.root, query: input.query },
      }),
  });
});

export const getEnvironmentScientSourceAttachmentPreview = Effect.fn(
  "clientRuntime.state.getEnvironmentScientSourceAttachmentPreview",
)(function* (input: {
  readonly prepared: PreparedConnection;
  readonly root: string;
  readonly sourceId: string;
  readonly attachmentId: string;
}) {
  const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
  const remoteAuthorization = yield* Effect.serviceOption(RemoteEnvironmentAuthorization);
  return yield* executeAuthenticatedEnvironmentHttpRequest({
    prepared: input.prepared,
    signer,
    remoteAuthorization,
    method: "POST",
    url: (urls) => urls.attachmentPreview(),
    timeoutMs: REQUEST_TIMEOUT_MS,
    group: "scientSources",
    request: ({ client, headers }) =>
      client.attachmentPreview({
        headers,
        payload: {
          root: input.root,
          sourceId: input.sourceId,
          attachmentId: input.attachmentId,
        },
      }),
  });
});

export const getEnvironmentScientSourceJournalIcon = Effect.fn(
  "clientRuntime.state.getEnvironmentScientSourceJournalIcon",
)(function* (input: {
  readonly prepared: PreparedConnection;
  readonly root: string;
  readonly sourceId: string;
}) {
  const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
  const remoteAuthorization = yield* Effect.serviceOption(RemoteEnvironmentAuthorization);
  return yield* executeAuthenticatedEnvironmentHttpRequest({
    prepared: input.prepared,
    signer,
    remoteAuthorization,
    method: "POST",
    url: (urls) => urls.journalIcon(),
    timeoutMs: REQUEST_TIMEOUT_MS,
    group: "scientSources",
    request: ({ client, headers }) =>
      client.journalIcon({
        headers,
        payload: { root: input.root, sourceId: input.sourceId },
      }),
  });
});

export const updateEnvironmentScientSourceMetadata = Effect.fn(
  "clientRuntime.state.updateEnvironmentScientSourceMetadata",
)(function* (input: {
  readonly prepared: PreparedConnection;
  readonly root: string;
  readonly sourceId: string;
  readonly expectedRevision: number;
  readonly metadata: ScientSourceMetadataUpdateRequest["metadata"];
  readonly allowPossibleMetadataMatch?: boolean;
}) {
  const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
  const remoteAuthorization = yield* Effect.serviceOption(RemoteEnvironmentAuthorization);
  return yield* executeAuthenticatedEnvironmentHttpRequest({
    prepared: input.prepared,
    signer,
    remoteAuthorization,
    method: "POST",
    url: (urls) => urls.updateMetadata(),
    timeoutMs: REQUEST_TIMEOUT_MS,
    group: "scientSources",
    request: ({ client, headers }) =>
      client.updateMetadata({
        headers,
        payload: {
          root: input.root,
          sourceId: input.sourceId,
          expectedRevision: input.expectedRevision,
          metadata: input.metadata,
          ...(input.allowPossibleMetadataMatch === undefined
            ? {}
            : { allowPossibleMetadataMatch: input.allowPossibleMetadataMatch }),
        },
      }),
  });
});

export const refreshEnvironmentScientSourceMetadata = Effect.fn(
  "clientRuntime.state.refreshEnvironmentScientSourceMetadata",
)(function* (input: {
  readonly prepared: PreparedConnection;
  readonly root: ScientSourceMetadataRefreshRequest["root"];
  readonly sourceId: ScientSourceMetadataRefreshRequest["sourceId"];
  readonly expectedRevision: ScientSourceMetadataRefreshRequest["expectedRevision"];
}) {
  const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
  const remoteAuthorization = yield* Effect.serviceOption(RemoteEnvironmentAuthorization);
  return yield* executeAuthenticatedEnvironmentHttpRequest({
    prepared: input.prepared,
    signer,
    remoteAuthorization,
    method: "POST",
    url: (urls) => urls.refreshMetadata(),
    timeoutMs: METADATA_REFRESH_TIMEOUT_MS,
    group: "scientSources",
    request: ({ client, headers }) =>
      client.refreshMetadata({
        headers,
        payload: {
          root: input.root,
          sourceId: input.sourceId,
          expectedRevision: input.expectedRevision,
        },
      }),
  });
});

export const updateEnvironmentScientSourceNote = Effect.fn(
  "clientRuntime.state.updateEnvironmentScientSourceNote",
)(function* (input: {
  readonly prepared: PreparedConnection;
  readonly root: ScientSourceNoteUpdateRequest["root"];
  readonly sourceId: ScientSourceNoteUpdateRequest["sourceId"];
  readonly expectedRevision: ScientSourceNoteUpdateRequest["expectedRevision"];
  readonly note: ScientSourceNoteUpdateRequest["note"];
}) {
  const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
  const remoteAuthorization = yield* Effect.serviceOption(RemoteEnvironmentAuthorization);
  return yield* executeAuthenticatedEnvironmentHttpRequest({
    prepared: input.prepared,
    signer,
    remoteAuthorization,
    method: "POST",
    url: (urls) => urls.updateNote(),
    timeoutMs: REQUEST_TIMEOUT_MS,
    group: "scientSources",
    request: ({ client, headers }) =>
      client.updateNote({
        headers,
        payload: {
          root: input.root,
          sourceId: input.sourceId,
          expectedRevision: input.expectedRevision,
          note: input.note,
        },
      }),
  });
});

export const removeEnvironmentScientSource = Effect.fn(
  "clientRuntime.state.removeEnvironmentScientSource",
)(function* (input: {
  readonly prepared: PreparedConnection;
  readonly root: ScientSourceRemovalRequest["root"];
  readonly sourceId: ScientSourceRemovalRequest["sourceId"];
  readonly expectedRevision: ScientSourceRemovalRequest["expectedRevision"];
}) {
  const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
  const remoteAuthorization = yield* Effect.serviceOption(RemoteEnvironmentAuthorization);
  return yield* executeAuthenticatedEnvironmentHttpRequest({
    prepared: input.prepared,
    signer,
    remoteAuthorization,
    method: "POST",
    url: (urls) => urls.remove(),
    timeoutMs: REQUEST_TIMEOUT_MS,
    group: "scientSources",
    request: ({ client, headers }) =>
      client.remove({
        headers,
        payload: {
          root: input.root,
          sourceId: input.sourceId,
          expectedRevision: input.expectedRevision,
        },
      }),
  });
});

export const addEnvironmentScientSourcesByIdentifier = Effect.fn(
  "clientRuntime.state.addEnvironmentScientSourcesByIdentifier",
)(function* (input: {
  readonly prepared: PreparedConnection;
  readonly root: ScientSourcesAddByIdentifierRequest["root"];
  readonly entries: ScientSourcesAddByIdentifierRequest["entries"];
}) {
  const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
  const remoteAuthorization = yield* Effect.serviceOption(RemoteEnvironmentAuthorization);
  return yield* executeAuthenticatedEnvironmentHttpRequest({
    prepared: input.prepared,
    signer,
    remoteAuthorization,
    method: "POST",
    url: (urls) => urls.addByIdentifier(),
    // Registry rate limits (arXiv asks for one request every three seconds) make large lists slow.
    timeoutMs: IMPORT_STEP_TIMEOUT_MS,
    group: "scientSources",
    request: ({ client, headers }) =>
      client.addByIdentifier({
        headers,
        payload: { root: input.root, entries: input.entries },
      }),
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
)(function* (input: {
  readonly prepared: PreparedConnection;
  readonly root: ScientSourcesOrganizeRequest["root"];
  readonly change: ScientSourcesOrganizeRequest["change"];
}) {
  const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
  const remoteAuthorization = yield* Effect.serviceOption(RemoteEnvironmentAuthorization);
  return yield* executeAuthenticatedEnvironmentHttpRequest({
    prepared: input.prepared,
    signer,
    remoteAuthorization,
    method: "POST",
    url: (urls) => urls.organize(),
    timeoutMs: REQUEST_TIMEOUT_MS,
    group: "scientSources",
    request: ({ client, headers }) =>
      client.organize({ headers, payload: { root: input.root, change: input.change } }),
  });
});

export const bulkUpdateEnvironmentScientSources = Effect.fn(
  "clientRuntime.state.bulkUpdateEnvironmentScientSources",
)(function* (input: {
  readonly prepared: PreparedConnection;
  readonly root: ScientSourcesBulkUpdateRequest["root"];
  readonly change: ScientSourcesBulkUpdateRequest["change"];
}) {
  const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
  const remoteAuthorization = yield* Effect.serviceOption(RemoteEnvironmentAuthorization);
  return yield* executeAuthenticatedEnvironmentHttpRequest({
    prepared: input.prepared,
    signer,
    remoteAuthorization,
    method: "POST",
    url: (urls) => urls.bulkUpdate(),
    // Each source in a bulk edit is its own revision write.
    timeoutMs: IMPORT_STEP_TIMEOUT_MS,
    group: "scientSources",
    request: ({ client, headers }) =>
      client.bulkUpdate({ headers, payload: { root: input.root, change: input.change } }),
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
)(function* (input: {
  readonly prepared: PreparedConnection;
  readonly scope: ZoteroImportScope;
  readonly query: string;
  readonly start: number;
  readonly limit: number;
  readonly connection?: ZoteroConnection;
}) {
  const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
  const remoteAuthorization = yield* Effect.serviceOption(RemoteEnvironmentAuthorization);
  return yield* executeAuthenticatedEnvironmentHttpRequest({
    prepared: input.prepared,
    signer,
    remoteAuthorization,
    method: "POST",
    url: (urls) => urls.zoteroLibrary(),
    timeoutMs: REQUEST_TIMEOUT_MS,
    group: "scientSources",
    request: ({ client, headers }) =>
      client.zoteroLibrary({
        headers,
        payload: {
          scope: input.scope,
          query: input.query,
          start: input.start,
          limit: input.limit,
          ...(input.connection ? { connection: input.connection } : {}),
        },
      }),
  });
});

export const listEnvironmentZoteroCollections = Effect.fn(
  "clientRuntime.state.listEnvironmentZoteroCollections",
)(function* (prepared: PreparedConnection, connection?: ZoteroConnection) {
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
      client.zoteroCollections({ headers, payload: connection ? { connection } : {} }),
  });
});

export const preflightEnvironmentZoteroImport = Effect.fn(
  "clientRuntime.state.preflightEnvironmentZoteroImport",
)(function* (input: {
  readonly prepared: PreparedConnection;
  readonly root: string;
  readonly itemKeys: ReadonlyArray<string>;
  readonly connection?: ZoteroConnection;
}) {
  const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
  const remoteAuthorization = yield* Effect.serviceOption(RemoteEnvironmentAuthorization);
  return yield* executeAuthenticatedEnvironmentHttpRequest({
    prepared: input.prepared,
    signer,
    remoteAuthorization,
    method: "POST",
    url: (urls) => urls.preflight(),
    timeoutMs: IMPORT_STEP_TIMEOUT_MS,
    group: "scientSources",
    request: ({ client, headers }) =>
      client.preflight({
        headers,
        payload: {
          root: input.root,
          itemKeys: input.itemKeys,
          ...(input.connection ? { connection: input.connection } : {}),
        },
      }),
  });
});

export const beginEnvironmentZoteroImport = Effect.fn(
  "clientRuntime.state.beginEnvironmentZoteroImport",
)(function* (input: {
  readonly prepared: PreparedConnection;
  readonly root: string;
  readonly operationId: string;
  readonly itemKeys: ReadonlyArray<string>;
  readonly possibleMetadataMatchOverrides: ReadonlyArray<string>;
  readonly connection?: ZoteroConnection;
}) {
  const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
  const remoteAuthorization = yield* Effect.serviceOption(RemoteEnvironmentAuthorization);
  return yield* executeAuthenticatedEnvironmentHttpRequest({
    prepared: input.prepared,
    signer,
    remoteAuthorization,
    method: "POST",
    url: (urls) => urls.beginImport(),
    timeoutMs: REQUEST_TIMEOUT_MS,
    group: "scientSources",
    request: ({ client, headers }) =>
      client.beginImport({
        headers,
        payload: {
          root: input.root,
          operationId: input.operationId,
          itemKeys: input.itemKeys,
          possibleMetadataMatchOverrides: input.possibleMetadataMatchOverrides,
          ...(input.connection ? { connection: input.connection } : {}),
        },
      }),
  });
});

export const beginEnvironmentZoteroScopedImport = Effect.fn(
  "clientRuntime.state.beginEnvironmentZoteroScopedImport",
)(function* (input: {
  readonly prepared: PreparedConnection;
  readonly root: string;
  readonly operationId: string;
  readonly scope: ZoteroImportScope;
  readonly connection?: ZoteroConnection;
}) {
  const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
  const remoteAuthorization = yield* Effect.serviceOption(RemoteEnvironmentAuthorization);
  return yield* executeAuthenticatedEnvironmentHttpRequest({
    prepared: input.prepared,
    signer,
    remoteAuthorization,
    method: "POST",
    url: (urls) => urls.beginScopedImport(),
    timeoutMs: IMPORT_STEP_TIMEOUT_MS,
    group: "scientSources",
    request: ({ client, headers }) =>
      client.beginScopedImport({
        headers,
        payload: {
          root: input.root,
          operationId: input.operationId,
          scope: input.scope,
          ...(input.connection ? { connection: input.connection } : {}),
        },
      }),
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

export const beginEnvironmentLocalSourceImport = Effect.fn(
  "clientRuntime.state.beginEnvironmentLocalSourceImport",
)(function* (input: {
  readonly prepared: PreparedConnection;
  readonly root: string;
  readonly operationId: string;
  readonly itemKeys: ReadonlyArray<string>;
  readonly possibleMetadataMatchOverrides: ReadonlyArray<string>;
}) {
  const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
  const remoteAuthorization = yield* Effect.serviceOption(RemoteEnvironmentAuthorization);
  return yield* executeAuthenticatedEnvironmentHttpRequest({
    prepared: input.prepared,
    signer,
    remoteAuthorization,
    method: "POST",
    url: (urls) => urls.localBeginImport(),
    timeoutMs: REQUEST_TIMEOUT_MS,
    group: "scientSources",
    request: ({ client, headers }) =>
      client.localBeginImport({
        headers,
        payload: {
          root: input.root,
          operationId: input.operationId,
          itemKeys: input.itemKeys,
          possibleMetadataMatchOverrides: input.possibleMetadataMatchOverrides,
        },
      }),
  });
});

export const discardEnvironmentLocalSourcePdfs = Effect.fn(
  "clientRuntime.state.discardEnvironmentLocalSourcePdfs",
)(function* (input: {
  readonly prepared: PreparedConnection;
  readonly root: string;
  readonly itemKeys: ReadonlyArray<string>;
}) {
  const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
  const remoteAuthorization = yield* Effect.serviceOption(RemoteEnvironmentAuthorization);
  return yield* executeAuthenticatedEnvironmentHttpRequest({
    prepared: input.prepared,
    signer,
    remoteAuthorization,
    method: "POST",
    url: (urls) => urls.localDiscard(),
    timeoutMs: REQUEST_TIMEOUT_MS,
    group: "scientSources",
    request: ({ client, headers }) =>
      client.localDiscard({
        headers,
        payload: { root: input.root, itemKeys: input.itemKeys },
      }),
  });
});

export const advanceEnvironmentScientSourcesImport = Effect.fn(
  "clientRuntime.state.advanceEnvironmentScientSourcesImport",
)(function* (input: {
  readonly prepared: PreparedConnection;
  readonly root: string;
  readonly operationId: string;
}) {
  const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
  const remoteAuthorization = yield* Effect.serviceOption(RemoteEnvironmentAuthorization);
  return yield* executeAuthenticatedEnvironmentHttpRequest({
    prepared: input.prepared,
    signer,
    remoteAuthorization,
    method: "POST",
    url: (urls) => urls.advanceImport(),
    timeoutMs: IMPORT_STEP_TIMEOUT_MS,
    group: "scientSources",
    request: ({ client, headers }) =>
      client.advanceImport({
        headers,
        payload: { root: input.root, operationId: input.operationId },
      }),
  });
});

export const cancelEnvironmentScientSourcesImport = Effect.fn(
  "clientRuntime.state.cancelEnvironmentScientSourcesImport",
)(function* (input: {
  readonly prepared: PreparedConnection;
  readonly root: string;
  readonly operationId: string;
}) {
  const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
  const remoteAuthorization = yield* Effect.serviceOption(RemoteEnvironmentAuthorization);
  return yield* executeAuthenticatedEnvironmentHttpRequest({
    prepared: input.prepared,
    signer,
    remoteAuthorization,
    method: "POST",
    url: (urls) => urls.cancelImport(),
    timeoutMs: REQUEST_TIMEOUT_MS,
    group: "scientSources",
    request: ({ client, headers }) =>
      client.cancelImport({
        headers,
        payload: { root: input.root, operationId: input.operationId },
      }),
  });
});

export const retryEnvironmentScientSourcesImport = Effect.fn(
  "clientRuntime.state.retryEnvironmentScientSourcesImport",
)(function* (input: {
  readonly prepared: PreparedConnection;
  readonly root: string;
  readonly operationId: string;
  readonly itemKeys: ReadonlyArray<string>;
}) {
  const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
  const remoteAuthorization = yield* Effect.serviceOption(RemoteEnvironmentAuthorization);
  return yield* executeAuthenticatedEnvironmentHttpRequest({
    prepared: input.prepared,
    signer,
    remoteAuthorization,
    method: "POST",
    url: (urls) => urls.retryImport(),
    timeoutMs: REQUEST_TIMEOUT_MS,
    group: "scientSources",
    request: ({ client, headers }) =>
      client.retryImport({
        headers,
        payload: {
          root: input.root,
          operationId: input.operationId,
          itemKeys: input.itemKeys,
        },
      }),
  });
});

export const syncEnvironmentScientBibliography = Effect.fn(
  "clientRuntime.state.syncEnvironmentScientBibliography",
)(function* (input: {
  readonly prepared: PreparedConnection;
  readonly root: ScientManagedBibliographySyncRequest["root"];
  readonly replaceEdited?: ScientManagedBibliographySyncRequest["replaceEdited"];
}) {
  const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
  const remoteAuthorization = yield* Effect.serviceOption(RemoteEnvironmentAuthorization);
  return yield* executeAuthenticatedEnvironmentHttpRequest({
    prepared: input.prepared,
    signer,
    remoteAuthorization,
    method: "POST",
    url: (urls) => urls.syncBibliography(),
    timeoutMs: REQUEST_TIMEOUT_MS,
    group: "scientSources",
    request: ({ client, headers }) =>
      client.syncBibliography({
        headers,
        payload: {
          root: input.root,
          ...(input.replaceEdited ? { replaceEdited: input.replaceEdited } : {}),
        },
      }),
  });
});
