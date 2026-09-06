import * as Effect from "effect/Effect";

import type {
  ScientSourceMetadataRefreshRequest,
  ScientSourceMetadataUpdateRequest,
  ScientSourceNoteUpdateRequest,
  ScientSourceReviewUpdateRequest,
  ScientSourceRemovalRequest,
  ZoteroImportScope,
} from "@t3tools/contracts";

import type { PreparedConnection } from "../connection/model.ts";
import { environmentEndpointUrl } from "../environment/endpoint.ts";
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
    url: (httpBaseUrl) => environmentEndpointUrl(httpBaseUrl, "/api/scient/sources/overview"),
    timeoutMs: REQUEST_TIMEOUT_MS,
    request: ({ client, headers }) =>
      client.scientSources.overview({
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
    url: (httpBaseUrl) => environmentEndpointUrl(httpBaseUrl, "/api/scient/sources/detail"),
    timeoutMs: REQUEST_TIMEOUT_MS,
    request: ({ client, headers }) =>
      client.scientSources.detail({
        headers,
        payload: { root: input.root, sourceId: input.sourceId },
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
    url: (httpBaseUrl) =>
      environmentEndpointUrl(httpBaseUrl, "/api/scient/sources/attachments/preview"),
    timeoutMs: REQUEST_TIMEOUT_MS,
    request: ({ client, headers }) =>
      client.scientSources.attachmentPreview({
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
    url: (httpBaseUrl) => environmentEndpointUrl(httpBaseUrl, "/api/scient/sources/journal-icon"),
    timeoutMs: REQUEST_TIMEOUT_MS,
    request: ({ client, headers }) =>
      client.scientSources.journalIcon({
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
    url: (httpBaseUrl) =>
      environmentEndpointUrl(httpBaseUrl, "/api/scient/sources/metadata/update"),
    timeoutMs: REQUEST_TIMEOUT_MS,
    request: ({ client, headers }) =>
      client.scientSources.updateMetadata({
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
    url: (httpBaseUrl) =>
      environmentEndpointUrl(httpBaseUrl, "/api/scient/sources/metadata/refresh"),
    timeoutMs: METADATA_REFRESH_TIMEOUT_MS,
    request: ({ client, headers }) =>
      client.scientSources.refreshMetadata({
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
    url: (httpBaseUrl) => environmentEndpointUrl(httpBaseUrl, "/api/scient/sources/note/update"),
    timeoutMs: REQUEST_TIMEOUT_MS,
    request: ({ client, headers }) =>
      client.scientSources.updateNote({
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
    url: (httpBaseUrl) => environmentEndpointUrl(httpBaseUrl, "/api/scient/sources/remove"),
    timeoutMs: REQUEST_TIMEOUT_MS,
    request: ({ client, headers }) =>
      client.scientSources.remove({
        headers,
        payload: {
          root: input.root,
          sourceId: input.sourceId,
          expectedRevision: input.expectedRevision,
        },
      }),
  });
});

export const updateEnvironmentScientSourceReview = Effect.fn(
  "clientRuntime.state.updateEnvironmentScientSourceReview",
)(function* (input: {
  readonly prepared: PreparedConnection;
  readonly root: ScientSourceReviewUpdateRequest["root"];
  readonly sourceId: ScientSourceReviewUpdateRequest["sourceId"];
  readonly expectedRevision: ScientSourceReviewUpdateRequest["expectedRevision"];
}) {
  const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
  const remoteAuthorization = yield* Effect.serviceOption(RemoteEnvironmentAuthorization);
  return yield* executeAuthenticatedEnvironmentHttpRequest({
    prepared: input.prepared,
    signer,
    remoteAuthorization,
    method: "POST",
    url: (httpBaseUrl) => environmentEndpointUrl(httpBaseUrl, "/api/scient/sources/review/update"),
    timeoutMs: REQUEST_TIMEOUT_MS,
    request: ({ client, headers }) =>
      client.scientSources.updateReview({
        headers,
        payload: {
          root: input.root,
          sourceId: input.sourceId,
          expectedRevision: input.expectedRevision,
          review: "none",
        },
      }),
  });
});

export const getEnvironmentZoteroStatus = Effect.fn(
  "clientRuntime.state.getEnvironmentZoteroStatus",
)(function* (prepared: PreparedConnection) {
  const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
  const remoteAuthorization = yield* Effect.serviceOption(RemoteEnvironmentAuthorization);
  return yield* executeAuthenticatedEnvironmentHttpRequest({
    prepared: prepared,
    signer,
    remoteAuthorization,
    method: "POST",
    url: (httpBaseUrl) => environmentEndpointUrl(httpBaseUrl, "/api/scient/sources/zotero/status"),
    timeoutMs: REQUEST_TIMEOUT_MS,
    request: ({ client, headers }) => client.scientSources.zoteroStatus({ headers, payload: {} }),
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
}) {
  const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
  const remoteAuthorization = yield* Effect.serviceOption(RemoteEnvironmentAuthorization);
  return yield* executeAuthenticatedEnvironmentHttpRequest({
    prepared: input.prepared,
    signer,
    remoteAuthorization,
    method: "POST",
    url: (httpBaseUrl) => environmentEndpointUrl(httpBaseUrl, "/api/scient/sources/zotero/library"),
    timeoutMs: REQUEST_TIMEOUT_MS,
    request: ({ client, headers }) =>
      client.scientSources.zoteroLibrary({
        headers,
        payload: {
          scope: input.scope,
          query: input.query,
          start: input.start,
          limit: input.limit,
        },
      }),
  });
});

export const listEnvironmentZoteroCollections = Effect.fn(
  "clientRuntime.state.listEnvironmentZoteroCollections",
)(function* (prepared: PreparedConnection) {
  const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
  const remoteAuthorization = yield* Effect.serviceOption(RemoteEnvironmentAuthorization);
  return yield* executeAuthenticatedEnvironmentHttpRequest({
    prepared: prepared,
    signer,
    remoteAuthorization,
    method: "POST",
    url: (httpBaseUrl) =>
      environmentEndpointUrl(httpBaseUrl, "/api/scient/sources/zotero/collections"),
    timeoutMs: REQUEST_TIMEOUT_MS,
    request: ({ client, headers }) =>
      client.scientSources.zoteroCollections({ headers, payload: {} }),
  });
});

export const preflightEnvironmentZoteroImport = Effect.fn(
  "clientRuntime.state.preflightEnvironmentZoteroImport",
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
    url: (httpBaseUrl) =>
      environmentEndpointUrl(httpBaseUrl, "/api/scient/sources/import/preflight"),
    timeoutMs: IMPORT_STEP_TIMEOUT_MS,
    request: ({ client, headers }) =>
      client.scientSources.preflight({
        headers,
        payload: { root: input.root, itemKeys: input.itemKeys },
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
}) {
  const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
  const remoteAuthorization = yield* Effect.serviceOption(RemoteEnvironmentAuthorization);
  return yield* executeAuthenticatedEnvironmentHttpRequest({
    prepared: input.prepared,
    signer,
    remoteAuthorization,
    method: "POST",
    url: (httpBaseUrl) => environmentEndpointUrl(httpBaseUrl, "/api/scient/sources/import/begin"),
    timeoutMs: REQUEST_TIMEOUT_MS,
    request: ({ client, headers }) =>
      client.scientSources.beginImport({
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

export const beginEnvironmentZoteroScopedImport = Effect.fn(
  "clientRuntime.state.beginEnvironmentZoteroScopedImport",
)(function* (input: {
  readonly prepared: PreparedConnection;
  readonly root: string;
  readonly operationId: string;
  readonly scope: ZoteroImportScope;
}) {
  const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
  const remoteAuthorization = yield* Effect.serviceOption(RemoteEnvironmentAuthorization);
  return yield* executeAuthenticatedEnvironmentHttpRequest({
    prepared: input.prepared,
    signer,
    remoteAuthorization,
    method: "POST",
    url: (httpBaseUrl) =>
      environmentEndpointUrl(httpBaseUrl, "/api/scient/sources/zotero/import-scope/begin"),
    timeoutMs: IMPORT_STEP_TIMEOUT_MS,
    request: ({ client, headers }) =>
      client.scientSources.beginScopedImport({
        headers,
        payload: {
          root: input.root,
          operationId: input.operationId,
          scope: input.scope,
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
    url: (httpBaseUrl) =>
      environmentEndpointUrl(httpBaseUrl, "/api/scient/sources/local-files/upload"),
    timeoutMs: IMPORT_STEP_TIMEOUT_MS,
    request: ({ client, headers }) =>
      client.scientSources.localPdfUpload({
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
    url: (httpBaseUrl) =>
      environmentEndpointUrl(httpBaseUrl, "/api/scient/sources/local-files/import/begin"),
    timeoutMs: REQUEST_TIMEOUT_MS,
    request: ({ client, headers }) =>
      client.scientSources.localBeginImport({
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
    url: (httpBaseUrl) =>
      environmentEndpointUrl(httpBaseUrl, "/api/scient/sources/local-files/discard"),
    timeoutMs: REQUEST_TIMEOUT_MS,
    request: ({ client, headers }) =>
      client.scientSources.localDiscard({
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
    url: (httpBaseUrl) => environmentEndpointUrl(httpBaseUrl, "/api/scient/sources/import/advance"),
    timeoutMs: IMPORT_STEP_TIMEOUT_MS,
    request: ({ client, headers }) =>
      client.scientSources.advanceImport({
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
    url: (httpBaseUrl) => environmentEndpointUrl(httpBaseUrl, "/api/scient/sources/import/cancel"),
    timeoutMs: REQUEST_TIMEOUT_MS,
    request: ({ client, headers }) =>
      client.scientSources.cancelImport({
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
    url: (httpBaseUrl) => environmentEndpointUrl(httpBaseUrl, "/api/scient/sources/import/retry"),
    timeoutMs: REQUEST_TIMEOUT_MS,
    request: ({ client, headers }) =>
      client.scientSources.retryImport({
        headers,
        payload: {
          root: input.root,
          operationId: input.operationId,
          itemKeys: input.itemKeys,
        },
      }),
  });
});
