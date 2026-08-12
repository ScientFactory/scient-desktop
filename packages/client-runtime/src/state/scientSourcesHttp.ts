import * as Effect from "effect/Effect";

import type { PreparedConnection } from "../connection/model.ts";
import { environmentEndpointUrl } from "../environment/endpoint.ts";
import { ManagedRelayDpopSigner } from "../relay/managedRelay.ts";
import { executeEnvironmentHttpRequest, makeEnvironmentHttpApiClient } from "../rpc/http.ts";
import { buildEnvironmentAuthHeaders, withEnvironmentCredentials } from "./environmentHttpAuth.ts";

const REQUEST_TIMEOUT_MS = 15_000;
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
        payload: { query: input.query, start: input.start, limit: input.limit },
      }),
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
        },
      }),
    ),
  );
});

export const advanceEnvironmentZoteroImport = Effect.fn(
  "clientRuntime.state.advanceEnvironmentZoteroImport",
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

export const cancelEnvironmentZoteroImport = Effect.fn(
  "clientRuntime.state.cancelEnvironmentZoteroImport",
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
