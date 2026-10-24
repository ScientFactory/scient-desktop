import * as Effect from "effect/Effect";

import type {
  ScientOverleafConnectionRequest,
  ScientOverleafConnectRequest,
  ScientOverleafDisconnectRequest,
  ScientOverleafPreviewRequest,
  ScientOverleafRestoreRequest,
  ScientOverleafSyncRequest,
  ScientOverleafUndoRequest,
  ScientOverleafWorkspaceRequest,
} from "@t3tools/contracts";

import type { PreparedConnection } from "../connection/model.ts";

import { ManagedRelayDpopSigner } from "../relay/managedRelay.ts";
import { executeAuthenticatedEnvironmentHttpRequest } from "./environmentHttpAuth.ts";
import { RemoteEnvironmentAuthorization } from "../authorization/service.ts";

/**
 * Client for Scient's Overleaf manual sync (`/api/scient/overleaf/v1/*`).
 * Requests name the caller's workspace; the server owns every tree, commit and
 * credential. Scient-owned end to end; mirrors `scientWordExportHttp.ts`.
 */

/** Token, list, status, kept copies and undoable sends: reads that never reach Overleaf. */
const READ_TIMEOUT_MS = 60_000;
/**
 * Connect, preview, sync, restore and undo fetch from Overleaf, write the folder
 * and send. The server bounds each step itself; this only keeps a lost connection
 * from waiting forever.
 */
const OVERLEAF_OPERATION_TIMEOUT_MS = 15 * 60_000;

type Group = "scientOverleaf";

const request = Effect.fn("clientRuntime.state.overleafRequest")(function* <A, E, R>(input: {
  readonly prepared: PreparedConnection;
  readonly timeoutMs: number;
  readonly url: Parameters<
    typeof executeAuthenticatedEnvironmentHttpRequest<Group, A, E, R>
  >[0]["url"];
  readonly run: Parameters<
    typeof executeAuthenticatedEnvironmentHttpRequest<Group, A, E, R>
  >[0]["request"];
}) {
  const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
  const remoteAuthorization = yield* Effect.serviceOption(RemoteEnvironmentAuthorization);
  return yield* executeAuthenticatedEnvironmentHttpRequest({
    prepared: input.prepared,
    signer,
    remoteAuthorization,
    method: "POST",
    url: input.url,
    timeoutMs: input.timeoutMs,
    group: "scientOverleaf",
    request: input.run,
  });
});

export const getEnvironmentOverleafTokenStatus = Effect.fn(
  "clientRuntime.state.getEnvironmentOverleafTokenStatus",
)(function* (input: { readonly prepared: PreparedConnection }) {
  return yield* request({
    prepared: input.prepared,
    timeoutMs: READ_TIMEOUT_MS,
    url: (urls) => urls.tokenStatus(),
    run: ({ client, headers }) => client.tokenStatus({ headers }),
  });
});

export const saveEnvironmentOverleafToken = Effect.fn(
  "clientRuntime.state.saveEnvironmentOverleafToken",
)(function* (input: { readonly prepared: PreparedConnection; readonly token: string }) {
  return yield* request({
    prepared: input.prepared,
    timeoutMs: READ_TIMEOUT_MS,
    url: (urls) => urls.saveToken(),
    run: ({ client, headers }) => client.saveToken({ headers, payload: { token: input.token } }),
  });
});

export const removeEnvironmentOverleafToken = Effect.fn(
  "clientRuntime.state.removeEnvironmentOverleafToken",
)(function* (input: { readonly prepared: PreparedConnection }) {
  return yield* request({
    prepared: input.prepared,
    timeoutMs: READ_TIMEOUT_MS,
    url: (urls) => urls.removeToken(),
    run: ({ client, headers }) => client.removeToken({ headers }),
  });
});

export const listEnvironmentOverleafConnections = Effect.fn(
  "clientRuntime.state.listEnvironmentOverleafConnections",
)(function* (input: {
  readonly prepared: PreparedConnection;
  readonly request: ScientOverleafWorkspaceRequest;
}) {
  return yield* request({
    prepared: input.prepared,
    timeoutMs: READ_TIMEOUT_MS,
    url: (urls) => urls.list(),
    run: ({ client, headers }) => client.list({ headers, payload: input.request }),
  });
});

export const connectEnvironmentOverleaf = Effect.fn(
  "clientRuntime.state.connectEnvironmentOverleaf",
)(function* (input: {
  readonly prepared: PreparedConnection;
  readonly request: ScientOverleafConnectRequest;
}) {
  return yield* request({
    prepared: input.prepared,
    timeoutMs: OVERLEAF_OPERATION_TIMEOUT_MS,
    url: (urls) => urls.connect(),
    run: ({ client, headers }) => client.connect({ headers, payload: input.request }),
  });
});

export const getEnvironmentOverleafStatus = Effect.fn(
  "clientRuntime.state.getEnvironmentOverleafStatus",
)(function* (input: {
  readonly prepared: PreparedConnection;
  readonly request: ScientOverleafConnectionRequest;
}) {
  return yield* request({
    prepared: input.prepared,
    timeoutMs: READ_TIMEOUT_MS,
    url: (urls) => urls.status(),
    run: ({ client, headers }) => client.status({ headers, payload: input.request }),
  });
});

export const previewEnvironmentOverleaf = Effect.fn(
  "clientRuntime.state.previewEnvironmentOverleaf",
)(function* (input: {
  readonly prepared: PreparedConnection;
  readonly request: ScientOverleafPreviewRequest;
}) {
  return yield* request({
    prepared: input.prepared,
    timeoutMs: OVERLEAF_OPERATION_TIMEOUT_MS,
    url: (urls) => urls.preview(),
    run: ({ client, headers }) => client.preview({ headers, payload: input.request }),
  });
});

export const syncEnvironmentOverleaf = Effect.fn("clientRuntime.state.syncEnvironmentOverleaf")(
  function* (input: {
    readonly prepared: PreparedConnection;
    readonly request: ScientOverleafSyncRequest;
  }) {
    return yield* request({
      prepared: input.prepared,
      timeoutMs: OVERLEAF_OPERATION_TIMEOUT_MS,
      url: (urls) => urls.sync(),
      run: ({ client, headers }) => client.sync({ headers, payload: input.request }),
    });
  },
);

export const listEnvironmentOverleafKeptCopies = Effect.fn(
  "clientRuntime.state.listEnvironmentOverleafKeptCopies",
)(function* (input: {
  readonly prepared: PreparedConnection;
  readonly request: ScientOverleafConnectionRequest;
}) {
  return yield* request({
    prepared: input.prepared,
    timeoutMs: READ_TIMEOUT_MS,
    url: (urls) => urls.keptCopies(),
    run: ({ client, headers }) => client.keptCopies({ headers, payload: input.request }),
  });
});

export const restoreEnvironmentOverleafKeptCopy = Effect.fn(
  "clientRuntime.state.restoreEnvironmentOverleafKeptCopy",
)(function* (input: {
  readonly prepared: PreparedConnection;
  readonly request: ScientOverleafRestoreRequest;
}) {
  return yield* request({
    prepared: input.prepared,
    timeoutMs: OVERLEAF_OPERATION_TIMEOUT_MS,
    url: (urls) => urls.restoreKept(),
    run: ({ client, headers }) => client.restoreKept({ headers, payload: input.request }),
  });
});

export const listEnvironmentOverleafUndoableSends = Effect.fn(
  "clientRuntime.state.listEnvironmentOverleafUndoableSends",
)(function* (input: {
  readonly prepared: PreparedConnection;
  readonly request: ScientOverleafConnectionRequest;
}) {
  return yield* request({
    prepared: input.prepared,
    timeoutMs: READ_TIMEOUT_MS,
    url: (urls) => urls.undoableSends(),
    run: ({ client, headers }) => client.undoableSends({ headers, payload: input.request }),
  });
});

/** Puts back what Overleaf had before one accepted send, then syncs. */
export const undoEnvironmentOverleafSend = Effect.fn(
  "clientRuntime.state.undoEnvironmentOverleafSend",
)(function* (input: {
  readonly prepared: PreparedConnection;
  readonly request: ScientOverleafUndoRequest;
}) {
  return yield* request({
    prepared: input.prepared,
    timeoutMs: OVERLEAF_OPERATION_TIMEOUT_MS,
    url: (urls) => urls.undo(),
    run: ({ client, headers }) => client.undo({ headers, payload: input.request }),
  });
});

export const disconnectEnvironmentOverleaf = Effect.fn(
  "clientRuntime.state.disconnectEnvironmentOverleaf",
)(function* (input: {
  readonly prepared: PreparedConnection;
  readonly request: ScientOverleafDisconnectRequest;
}) {
  return yield* request({
    prepared: input.prepared,
    timeoutMs: OVERLEAF_OPERATION_TIMEOUT_MS,
    url: (urls) => urls.disconnect(),
    run: ({ client, headers }) => client.disconnect({ headers, payload: input.request }),
  });
});

export const cancelEnvironmentOverleafSync = Effect.fn(
  "clientRuntime.state.cancelEnvironmentOverleafSync",
)(function* (input: {
  readonly prepared: PreparedConnection;
  readonly request: ScientOverleafConnectionRequest;
}) {
  return yield* request({
    prepared: input.prepared,
    timeoutMs: READ_TIMEOUT_MS,
    url: (urls) => urls.cancel(),
    run: ({ client, headers }) => client.cancel({ headers, payload: input.request }),
  });
});
