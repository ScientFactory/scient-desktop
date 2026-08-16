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
import { executeEnvironmentHttpRequest, makeEnvironmentHttpApiClient } from "../rpc/http.ts";
import { buildEnvironmentAuthHeaders, withEnvironmentCredentials } from "./environmentHttpAuth.ts";

const REQUEST_TIMEOUT_MS = 15_000;
const METADATA_REFRESH_TIMEOUT_MS = 45_000;
const IMPORT_STEP_TIMEOUT_MS = 120_000;

const requestContext = Effect.fn("clientRuntime.state.scientSourcesRequestContext")(
  function* (input: { readonly prepared: PreparedConnection; readonly path: string }) {
    const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
    const requestUrl = environmentEndpointUrl(input.prepared.httpBaseUrl, input.path);
    const client = yield* makeEnvironmentHttpApiClient(input.prepared.httpBaseUrl);
    const headers = yield* buildEnvironmentAuthHeaders(
      input.prepared.httpAuthorization,
      "POST",
      requestUrl,
      signer,
    );
    return { requestUrl, client, headers };
  },
);

export const getEnvironmentScientSourcesOverview = Effect.fn(
  "clientRuntime.state.getEnvironmentScientSourcesOverview",
)(function* (input: { readonly prepared: PreparedConnection; readonly root: string }) {
  const context = yield* requestContext({
    prepared: input.prepared,
    path: "/api/scient/sources/overview",
  });
  return yield* executeEnvironmentHttpRequest(
    context.requestUrl,
    REQUEST_TIMEOUT_MS,
    withEnvironmentCredentials(
      input.prepared.httpAuthorization,
      context.client.scientSources.overview({
        headers: context.headers,
        payload: { root: input.root },
      }),
    ),
  );
});

export const getEnvironmentScientSourceDetail = Effect.fn(
  "clientRuntime.state.getEnvironmentScientSourceDetail",
)(function* (input: {
  readonly prepared: PreparedConnection;
  readonly root: string;
  readonly sourceId: string;
}) {
  const context = yield* requestContext({
    prepared: input.prepared,
    path: "/api/scient/sources/detail",
  });
  return yield* executeEnvironmentHttpRequest(
    context.requestUrl,
    REQUEST_TIMEOUT_MS,
    withEnvironmentCredentials(
      input.prepared.httpAuthorization,
      context.client.scientSources.detail({
        headers: context.headers,
        payload: { root: input.root, sourceId: input.sourceId },
      }),
    ),
  );
});

export const getEnvironmentScientSourceAttachmentPreview = Effect.fn(
  "clientRuntime.state.getEnvironmentScientSourceAttachmentPreview",
)(function* (input: {
  readonly prepared: PreparedConnection;
  readonly root: string;
  readonly sourceId: string;
  readonly attachmentId: string;
}) {
  const context = yield* requestContext({
    prepared: input.prepared,
    path: "/api/scient/sources/attachments/preview",
  });
  return yield* executeEnvironmentHttpRequest(
    context.requestUrl,
    REQUEST_TIMEOUT_MS,
    withEnvironmentCredentials(
      input.prepared.httpAuthorization,
      context.client.scientSources.attachmentPreview({
        headers: context.headers,
        payload: {
          root: input.root,
          sourceId: input.sourceId,
          attachmentId: input.attachmentId,
        },
      }),
    ),
  );
});

export const getEnvironmentScientSourceJournalIcon = Effect.fn(
  "clientRuntime.state.getEnvironmentScientSourceJournalIcon",
)(function* (input: {
  readonly prepared: PreparedConnection;
  readonly root: string;
  readonly sourceId: string;
}) {
  const context = yield* requestContext({
    prepared: input.prepared,
    path: "/api/scient/sources/journal-icon",
  });
  return yield* executeEnvironmentHttpRequest(
    context.requestUrl,
    REQUEST_TIMEOUT_MS,
    withEnvironmentCredentials(
      input.prepared.httpAuthorization,
      context.client.scientSources.journalIcon({
        headers: context.headers,
        payload: { root: input.root, sourceId: input.sourceId },
      }),
    ),
  );
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
  const context = yield* requestContext({
    prepared: input.prepared,
    path: "/api/scient/sources/metadata/update",
  });
  return yield* executeEnvironmentHttpRequest(
    context.requestUrl,
    REQUEST_TIMEOUT_MS,
    withEnvironmentCredentials(
      input.prepared.httpAuthorization,
      context.client.scientSources.updateMetadata({
        headers: context.headers,
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
    ),
  );
});

export const refreshEnvironmentScientSourceMetadata = Effect.fn(
  "clientRuntime.state.refreshEnvironmentScientSourceMetadata",
)(function* (input: {
  readonly prepared: PreparedConnection;
  readonly root: ScientSourceMetadataRefreshRequest["root"];
  readonly sourceId: ScientSourceMetadataRefreshRequest["sourceId"];
  readonly expectedRevision: ScientSourceMetadataRefreshRequest["expectedRevision"];
}) {
  const context = yield* requestContext({
    prepared: input.prepared,
    path: "/api/scient/sources/metadata/refresh",
  });
  return yield* executeEnvironmentHttpRequest(
    context.requestUrl,
    METADATA_REFRESH_TIMEOUT_MS,
    withEnvironmentCredentials(
      input.prepared.httpAuthorization,
      context.client.scientSources.refreshMetadata({
        headers: context.headers,
        payload: {
          root: input.root,
          sourceId: input.sourceId,
          expectedRevision: input.expectedRevision,
        },
      }),
    ),
  );
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
  const context = yield* requestContext({
    prepared: input.prepared,
    path: "/api/scient/sources/note/update",
  });
  return yield* executeEnvironmentHttpRequest(
    context.requestUrl,
    REQUEST_TIMEOUT_MS,
    withEnvironmentCredentials(
      input.prepared.httpAuthorization,
      context.client.scientSources.updateNote({
        headers: context.headers,
        payload: {
          root: input.root,
          sourceId: input.sourceId,
          expectedRevision: input.expectedRevision,
          note: input.note,
        },
      }),
    ),
  );
});

export const removeEnvironmentScientSource = Effect.fn(
  "clientRuntime.state.removeEnvironmentScientSource",
)(function* (input: {
  readonly prepared: PreparedConnection;
  readonly root: ScientSourceRemovalRequest["root"];
  readonly sourceId: ScientSourceRemovalRequest["sourceId"];
  readonly expectedRevision: ScientSourceRemovalRequest["expectedRevision"];
}) {
  const context = yield* requestContext({
    prepared: input.prepared,
    path: "/api/scient/sources/remove",
  });
  return yield* executeEnvironmentHttpRequest(
    context.requestUrl,
    REQUEST_TIMEOUT_MS,
    withEnvironmentCredentials(
      input.prepared.httpAuthorization,
      context.client.scientSources.remove({
        headers: context.headers,
        payload: {
          root: input.root,
          sourceId: input.sourceId,
          expectedRevision: input.expectedRevision,
        },
      }),
    ),
  );
});

export const updateEnvironmentScientSourceReview = Effect.fn(
  "clientRuntime.state.updateEnvironmentScientSourceReview",
)(function* (input: {
  readonly prepared: PreparedConnection;
  readonly root: ScientSourceReviewUpdateRequest["root"];
  readonly sourceId: ScientSourceReviewUpdateRequest["sourceId"];
  readonly expectedRevision: ScientSourceReviewUpdateRequest["expectedRevision"];
}) {
  const context = yield* requestContext({
    prepared: input.prepared,
    path: "/api/scient/sources/review/update",
  });
  return yield* executeEnvironmentHttpRequest(
    context.requestUrl,
    REQUEST_TIMEOUT_MS,
    withEnvironmentCredentials(
      input.prepared.httpAuthorization,
      context.client.scientSources.updateReview({
        headers: context.headers,
        payload: {
          root: input.root,
          sourceId: input.sourceId,
          expectedRevision: input.expectedRevision,
          review: "none",
        },
      }),
    ),
  );
});

export const getEnvironmentZoteroStatus = Effect.fn(
  "clientRuntime.state.getEnvironmentZoteroStatus",
)(function* (prepared: PreparedConnection) {
  const context = yield* requestContext({ prepared, path: "/api/scient/sources/zotero/status" });
  return yield* executeEnvironmentHttpRequest(
    context.requestUrl,
    REQUEST_TIMEOUT_MS,
    withEnvironmentCredentials(
      prepared.httpAuthorization,
      context.client.scientSources.zoteroStatus({ headers: context.headers, payload: {} }),
    ),
  );
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
  const context = yield* requestContext({
    prepared: input.prepared,
    path: "/api/scient/sources/zotero/library",
  });
  return yield* executeEnvironmentHttpRequest(
    context.requestUrl,
    REQUEST_TIMEOUT_MS,
    withEnvironmentCredentials(
      input.prepared.httpAuthorization,
      context.client.scientSources.zoteroLibrary({
        headers: context.headers,
        payload: {
          scope: input.scope,
          query: input.query,
          start: input.start,
          limit: input.limit,
        },
      }),
    ),
  );
});

export const listEnvironmentZoteroCollections = Effect.fn(
  "clientRuntime.state.listEnvironmentZoteroCollections",
)(function* (prepared: PreparedConnection) {
  const context = yield* requestContext({
    prepared,
    path: "/api/scient/sources/zotero/collections",
  });
  return yield* executeEnvironmentHttpRequest(
    context.requestUrl,
    REQUEST_TIMEOUT_MS,
    withEnvironmentCredentials(
      prepared.httpAuthorization,
      context.client.scientSources.zoteroCollections({ headers: context.headers, payload: {} }),
    ),
  );
});

export const preflightEnvironmentZoteroImport = Effect.fn(
  "clientRuntime.state.preflightEnvironmentZoteroImport",
)(function* (input: {
  readonly prepared: PreparedConnection;
  readonly root: string;
  readonly itemKeys: ReadonlyArray<string>;
}) {
  const context = yield* requestContext({
    prepared: input.prepared,
    path: "/api/scient/sources/import/preflight",
  });
  return yield* executeEnvironmentHttpRequest(
    context.requestUrl,
    IMPORT_STEP_TIMEOUT_MS,
    withEnvironmentCredentials(
      input.prepared.httpAuthorization,
      context.client.scientSources.preflight({
        headers: context.headers,
        payload: { root: input.root, itemKeys: input.itemKeys },
      }),
    ),
  );
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
  const context = yield* requestContext({
    prepared: input.prepared,
    path: "/api/scient/sources/import/begin",
  });
  return yield* executeEnvironmentHttpRequest(
    context.requestUrl,
    REQUEST_TIMEOUT_MS,
    withEnvironmentCredentials(
      input.prepared.httpAuthorization,
      context.client.scientSources.beginImport({
        headers: context.headers,
        payload: {
          root: input.root,
          operationId: input.operationId,
          itemKeys: input.itemKeys,
          possibleMetadataMatchOverrides: input.possibleMetadataMatchOverrides,
        },
      }),
    ),
  );
});

export const beginEnvironmentZoteroScopedImport = Effect.fn(
  "clientRuntime.state.beginEnvironmentZoteroScopedImport",
)(function* (input: {
  readonly prepared: PreparedConnection;
  readonly root: string;
  readonly operationId: string;
  readonly scope: ZoteroImportScope;
}) {
  const context = yield* requestContext({
    prepared: input.prepared,
    path: "/api/scient/sources/zotero/import-scope/begin",
  });
  return yield* executeEnvironmentHttpRequest(
    context.requestUrl,
    IMPORT_STEP_TIMEOUT_MS,
    withEnvironmentCredentials(
      input.prepared.httpAuthorization,
      context.client.scientSources.beginScopedImport({
        headers: context.headers,
        payload: {
          root: input.root,
          operationId: input.operationId,
          scope: input.scope,
        },
      }),
    ),
  );
});

export const uploadEnvironmentLocalSourcePdf = Effect.fn(
  "clientRuntime.state.uploadEnvironmentLocalSourcePdf",
)(function* (input: {
  readonly prepared: PreparedConnection;
  readonly root: string;
  readonly file: Blob;
  readonly fileName: string;
}) {
  const context = yield* requestContext({
    prepared: input.prepared,
    path: "/api/scient/sources/local-files/upload",
  });
  const payload = new FormData();
  payload.append("root", input.root);
  payload.append("file", input.file, input.fileName);
  return yield* executeEnvironmentHttpRequest(
    context.requestUrl,
    IMPORT_STEP_TIMEOUT_MS,
    withEnvironmentCredentials(
      input.prepared.httpAuthorization,
      context.client.scientSources.localPdfUpload({
        headers: context.headers,
        payload,
      }),
    ),
  );
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
  const context = yield* requestContext({
    prepared: input.prepared,
    path: "/api/scient/sources/local-files/import/begin",
  });
  return yield* executeEnvironmentHttpRequest(
    context.requestUrl,
    REQUEST_TIMEOUT_MS,
    withEnvironmentCredentials(
      input.prepared.httpAuthorization,
      context.client.scientSources.localBeginImport({
        headers: context.headers,
        payload: {
          root: input.root,
          operationId: input.operationId,
          itemKeys: input.itemKeys,
          possibleMetadataMatchOverrides: input.possibleMetadataMatchOverrides,
        },
      }),
    ),
  );
});

export const discardEnvironmentLocalSourcePdfs = Effect.fn(
  "clientRuntime.state.discardEnvironmentLocalSourcePdfs",
)(function* (input: {
  readonly prepared: PreparedConnection;
  readonly root: string;
  readonly itemKeys: ReadonlyArray<string>;
}) {
  const context = yield* requestContext({
    prepared: input.prepared,
    path: "/api/scient/sources/local-files/discard",
  });
  return yield* executeEnvironmentHttpRequest(
    context.requestUrl,
    REQUEST_TIMEOUT_MS,
    withEnvironmentCredentials(
      input.prepared.httpAuthorization,
      context.client.scientSources.localDiscard({
        headers: context.headers,
        payload: { root: input.root, itemKeys: input.itemKeys },
      }),
    ),
  );
});

export const advanceEnvironmentScientSourcesImport = Effect.fn(
  "clientRuntime.state.advanceEnvironmentScientSourcesImport",
)(function* (input: {
  readonly prepared: PreparedConnection;
  readonly root: string;
  readonly operationId: string;
}) {
  const context = yield* requestContext({
    prepared: input.prepared,
    path: "/api/scient/sources/import/advance",
  });
  return yield* executeEnvironmentHttpRequest(
    context.requestUrl,
    IMPORT_STEP_TIMEOUT_MS,
    withEnvironmentCredentials(
      input.prepared.httpAuthorization,
      context.client.scientSources.advanceImport({
        headers: context.headers,
        payload: { root: input.root, operationId: input.operationId },
      }),
    ),
  );
});

export const cancelEnvironmentScientSourcesImport = Effect.fn(
  "clientRuntime.state.cancelEnvironmentScientSourcesImport",
)(function* (input: {
  readonly prepared: PreparedConnection;
  readonly root: string;
  readonly operationId: string;
}) {
  const context = yield* requestContext({
    prepared: input.prepared,
    path: "/api/scient/sources/import/cancel",
  });
  return yield* executeEnvironmentHttpRequest(
    context.requestUrl,
    REQUEST_TIMEOUT_MS,
    withEnvironmentCredentials(
      input.prepared.httpAuthorization,
      context.client.scientSources.cancelImport({
        headers: context.headers,
        payload: { root: input.root, operationId: input.operationId },
      }),
    ),
  );
});

export const retryEnvironmentScientSourcesImport = Effect.fn(
  "clientRuntime.state.retryEnvironmentScientSourcesImport",
)(function* (input: {
  readonly prepared: PreparedConnection;
  readonly root: string;
  readonly operationId: string;
  readonly itemKeys: ReadonlyArray<string>;
}) {
  const context = yield* requestContext({
    prepared: input.prepared,
    path: "/api/scient/sources/import/retry",
  });
  return yield* executeEnvironmentHttpRequest(
    context.requestUrl,
    REQUEST_TIMEOUT_MS,
    withEnvironmentCredentials(
      input.prepared.httpAuthorization,
      context.client.scientSources.retryImport({
        headers: context.headers,
        payload: {
          root: input.root,
          operationId: input.operationId,
          itemKeys: input.itemKeys,
        },
      }),
    ),
  );
});
