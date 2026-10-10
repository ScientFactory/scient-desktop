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
    url: (urls) => urls.updateReview(),
    timeoutMs: REQUEST_TIMEOUT_MS,
    group: "scientSources",
    request: ({ client, headers }) =>
      client.updateReview({
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
    url: (urls) => urls.zoteroStatus(),
    timeoutMs: REQUEST_TIMEOUT_MS,
    group: "scientSources",
    request: ({ client, headers }) => client.zoteroStatus({ headers, payload: {} }),
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
    url: (urls) => urls.zoteroCollections(),
    timeoutMs: REQUEST_TIMEOUT_MS,
    group: "scientSources",
    request: ({ client, headers }) => client.zoteroCollections({ headers, payload: {} }),
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
    url: (urls) => urls.preflight(),
    timeoutMs: IMPORT_STEP_TIMEOUT_MS,
    group: "scientSources",
    request: ({ client, headers }) =>
      client.preflight({
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
