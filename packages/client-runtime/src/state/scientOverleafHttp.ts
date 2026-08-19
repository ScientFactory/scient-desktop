import type {
  ScientOverleafConnectionRequest,
  ScientOverleafConnectionSettingsRequest,
  ScientOverleafConflictRequest,
  ScientOverleafConflictResolutionRequest,
  ScientOverleafContinueRequest,
  ScientOverleafDisconnectRequest,
  ScientOverleafOperationRequest,
  ScientOverleafOverviewRequest,
  ScientOverleafPreflightCompleteRequest,
  ScientOverleafPreflightStartRequest,
  ScientOverleafReviewConfirmationRequest,
  ScientOverleafSaveAccountRequest,
  ScientOverleafSyncStartRequest,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type { PreparedConnection } from "../connection/model.ts";
import { environmentEndpointUrl } from "../environment/endpoint.ts";
import { ManagedRelayDpopSigner } from "../relay/managedRelay.ts";
import { executeEnvironmentHttpRequest, makeEnvironmentHttpApiClient } from "../rpc/http.ts";
import {
  buildEnvironmentAuthHeaders,
  type EnvironmentHttpAuthHeaders,
  withEnvironmentCredentials,
} from "./environmentHttpAuth.ts";

const REQUEST_TIMEOUT_MS = 20_000;
type EnvironmentClient = Effect.Success<ReturnType<typeof makeEnvironmentHttpApiClient>>;

function post<A, E, R>(
  prepared: PreparedConnection,
  path: string,
  invoke: (
    client: EnvironmentClient,
    headers: EnvironmentHttpAuthHeaders,
  ) => Effect.Effect<A, E, R>,
) {
  return Effect.gen(function* () {
    const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
    const requestUrl = environmentEndpointUrl(prepared.httpBaseUrl, path);
    const client = yield* makeEnvironmentHttpApiClient(prepared.httpBaseUrl);
    const headers = yield* buildEnvironmentAuthHeaders(
      prepared.httpAuthorization,
      "POST",
      requestUrl,
      signer,
    );
    return yield* executeEnvironmentHttpRequest(
      requestUrl,
      REQUEST_TIMEOUT_MS,
      withEnvironmentCredentials(prepared.httpAuthorization, invoke(client, headers)),
    );
  });
}

export const getEnvironmentScientOverleafOverview = Effect.fn(
  "clientRuntime.state.getEnvironmentScientOverleafOverview",
)((input: { readonly prepared: PreparedConnection; readonly workspaceRoot: string }) =>
  post(input.prepared, "/api/scient/overleaf/overview", (client, headers) =>
    client.scientOverleaf.overview({
      headers,
      payload: { workspaceRoot: input.workspaceRoot } satisfies ScientOverleafOverviewRequest,
    }),
  ),
);

export const saveEnvironmentScientOverleafAccount = Effect.fn(
  "clientRuntime.state.saveEnvironmentScientOverleafAccount",
)(
  (input: {
    readonly prepared: PreparedConnection;
    readonly payload: ScientOverleafSaveAccountRequest;
  }) =>
    post(input.prepared, "/api/scient/overleaf/accounts/save", (client, headers) =>
      client.scientOverleaf.saveAccount({ headers, payload: input.payload }),
    ),
);

export const removeEnvironmentScientOverleafAccount = Effect.fn(
  "clientRuntime.state.removeEnvironmentScientOverleafAccount",
)((input: { readonly prepared: PreparedConnection; readonly accountId: string }) =>
  post(input.prepared, "/api/scient/overleaf/accounts/remove", (client, headers) =>
    client.scientOverleaf.removeAccount({ headers, payload: { accountId: input.accountId } }),
  ),
);

export const startEnvironmentScientOverleafPreflight = Effect.fn(
  "clientRuntime.state.startEnvironmentScientOverleafPreflight",
)(
  (input: {
    readonly prepared: PreparedConnection;
    readonly payload: ScientOverleafPreflightStartRequest;
  }) =>
    post(input.prepared, "/api/scient/overleaf/connect/preflight/start", (client, headers) =>
      client.scientOverleaf.preflightStart({ headers, payload: input.payload }),
    ),
);

export const getEnvironmentScientOverleafOperation = Effect.fn(
  "clientRuntime.state.getEnvironmentScientOverleafOperation",
)((input: { readonly prepared: PreparedConnection; readonly operationId: string }) =>
  post(input.prepared, "/api/scient/overleaf/operations/status", (client, headers) =>
    client.scientOverleaf.operationStatus({
      headers,
      payload: { operationId: input.operationId } satisfies ScientOverleafOperationRequest,
    }),
  ),
);

export const completeEnvironmentScientOverleafPreflight = Effect.fn(
  "clientRuntime.state.completeEnvironmentScientOverleafPreflight",
)(
  (input: {
    readonly prepared: PreparedConnection;
    readonly payload: ScientOverleafPreflightCompleteRequest;
  }) =>
    post(input.prepared, "/api/scient/overleaf/connect/preflight/complete", (client, headers) =>
      client.scientOverleaf.preflightComplete({ headers, payload: input.payload }),
    ),
);

export const cancelEnvironmentScientOverleafOperation = Effect.fn(
  "clientRuntime.state.cancelEnvironmentScientOverleafOperation",
)((input: { readonly prepared: PreparedConnection; readonly operationId: string }) =>
  post(input.prepared, "/api/scient/overleaf/operations/cancel", (client, headers) =>
    client.scientOverleaf.operationCancel({
      headers,
      payload: { operationId: input.operationId } satisfies ScientOverleafOperationRequest,
    }),
  ),
);

export const updateEnvironmentScientOverleafConnection = Effect.fn(
  "clientRuntime.state.updateEnvironmentScientOverleafConnection",
)(
  (input: {
    readonly prepared: PreparedConnection;
    readonly payload: ScientOverleafConnectionSettingsRequest;
  }) =>
    post(input.prepared, "/api/scient/overleaf/connections/settings", (client, headers) =>
      client.scientOverleaf.updateConnection({ headers, payload: input.payload }),
    ),
);

export const startEnvironmentScientOverleafSync = Effect.fn(
  "clientRuntime.state.startEnvironmentScientOverleafSync",
)(
  (input: {
    readonly prepared: PreparedConnection;
    readonly payload: ScientOverleafSyncStartRequest;
  }) =>
    post(input.prepared, "/api/scient/overleaf/sync/start", (client, headers) =>
      client.scientOverleaf.syncStart({ headers, payload: input.payload }),
    ),
);

export const retryEnvironmentScientOverleafOperation = Effect.fn(
  "clientRuntime.state.retryEnvironmentScientOverleafOperation",
)((input: { readonly prepared: PreparedConnection; readonly operationId: string }) =>
  post(input.prepared, "/api/scient/overleaf/operations/retry", (client, headers) =>
    client.scientOverleaf.operationRetry({
      headers,
      payload: { operationId: input.operationId } satisfies ScientOverleafOperationRequest,
    }),
  ),
);

export const confirmEnvironmentScientOverleafReview = Effect.fn(
  "clientRuntime.state.confirmEnvironmentScientOverleafReview",
)(
  (input: {
    readonly prepared: PreparedConnection;
    readonly payload: ScientOverleafReviewConfirmationRequest;
  }) =>
    post(input.prepared, "/api/scient/overleaf/review/confirm", (client, headers) =>
      client.scientOverleaf.confirmReview({ headers, payload: input.payload }),
    ),
);

export const listEnvironmentScientOverleafConflicts = Effect.fn(
  "clientRuntime.state.listEnvironmentScientOverleafConflicts",
)((input: { readonly prepared: PreparedConnection; readonly operationId: string }) =>
  post(input.prepared, "/api/scient/overleaf/conflicts", (client, headers) =>
    client.scientOverleaf.conflicts({
      headers,
      payload: { operationId: input.operationId } satisfies ScientOverleafOperationRequest,
    }),
  ),
);

export const getEnvironmentScientOverleafConflict = Effect.fn(
  "clientRuntime.state.getEnvironmentScientOverleafConflict",
)(
  (input: {
    readonly prepared: PreparedConnection;
    readonly operationId: string;
    readonly conflictId: string;
  }) =>
    post(input.prepared, "/api/scient/overleaf/conflicts/detail", (client, headers) =>
      client.scientOverleaf.conflictDetail({
        headers,
        payload: {
          operationId: input.operationId,
          conflictId: input.conflictId,
        } satisfies ScientOverleafConflictRequest,
      }),
    ),
);

export const resolveEnvironmentScientOverleafConflict = Effect.fn(
  "clientRuntime.state.resolveEnvironmentScientOverleafConflict",
)(
  (input: {
    readonly prepared: PreparedConnection;
    readonly payload: ScientOverleafConflictResolutionRequest;
  }) =>
    post(input.prepared, "/api/scient/overleaf/conflicts/resolve", (client, headers) =>
      client.scientOverleaf.resolveConflict({ headers, payload: input.payload }),
    ),
);

export const continueEnvironmentScientOverleafOperation = Effect.fn(
  "clientRuntime.state.continueEnvironmentScientOverleafOperation",
)(
  (input: {
    readonly prepared: PreparedConnection;
    readonly payload: ScientOverleafContinueRequest;
  }) =>
    post(input.prepared, "/api/scient/overleaf/operations/continue", (client, headers) =>
      client.scientOverleaf.continueOperation({
        headers,
        payload: input.payload,
      }),
    ),
);

export const reconcileEnvironmentScientOverleafLocal = Effect.fn(
  "clientRuntime.state.reconcileEnvironmentScientOverleafLocal",
)((input: { readonly prepared: PreparedConnection; readonly connectionId: string }) =>
  post(input.prepared, "/api/scient/overleaf/reconcile-local", (client, headers) =>
    client.scientOverleaf.reconcileLocal({
      headers,
      payload: { connectionId: input.connectionId } satisfies ScientOverleafConnectionRequest,
    }),
  ),
);

export const repairEnvironmentScientOverleafConnection = Effect.fn(
  "clientRuntime.state.repairEnvironmentScientOverleafConnection",
)((input: { readonly prepared: PreparedConnection; readonly connectionId: string }) =>
  post(input.prepared, "/api/scient/overleaf/repair", (client, headers) =>
    client.scientOverleaf.repair({
      headers,
      payload: { connectionId: input.connectionId } satisfies ScientOverleafConnectionRequest,
    }),
  ),
);

export const disconnectEnvironmentScientOverleafConnection = Effect.fn(
  "clientRuntime.state.disconnectEnvironmentScientOverleafConnection",
)(
  (input: {
    readonly prepared: PreparedConnection;
    readonly payload: ScientOverleafDisconnectRequest;
  }) =>
    post(input.prepared, "/api/scient/overleaf/disconnect", (client, headers) =>
      client.scientOverleaf.disconnect({ headers, payload: input.payload }),
    ),
);
