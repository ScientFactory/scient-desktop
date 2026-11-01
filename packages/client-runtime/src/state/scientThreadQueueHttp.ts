import * as Effect from "effect/Effect";

import type { ThreadId, ScientThreadQueueControlRequest } from "@t3tools/contracts";

import type { PreparedConnection } from "../connection/model.ts";

import { ManagedRelayDpopSigner } from "../relay/managedRelay.ts";
import { executeAuthenticatedEnvironmentHttpRequest } from "./environmentHttpAuth.ts";
import { RemoteEnvironmentAuthorization } from "../authorization/service.ts";

/**
 * Client for the Scient thread queue HTTP surface. Mirrors
 * `scientSourcesHttp.ts`; Scient-owned end to end. See
 * `docs/internals/scient-thread-queue.md`.
 */

const REQUEST_TIMEOUT_MS = 15_000;

export const listEnvironmentScientThreadQueue = Effect.fn(
  "clientRuntime.state.listEnvironmentScientThreadQueue",
)(function* (input: {
  readonly prepared: PreparedConnection;
  readonly threadId: ThreadId;
  readonly knownRevision?: number;
}) {
  const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
  const remoteAuthorization = yield* Effect.serviceOption(RemoteEnvironmentAuthorization);
  return yield* executeAuthenticatedEnvironmentHttpRequest({
    prepared: input.prepared,
    signer,
    remoteAuthorization,
    method: "POST",
    url: (urls) => urls.list(),
    timeoutMs: REQUEST_TIMEOUT_MS,
    group: "scientThreadQueue",
    request: ({ client, headers }) =>
      client.list({
        headers,
        payload: {
          threadId: input.threadId,
          ...(input.knownRevision !== undefined ? { knownRevision: input.knownRevision } : {}),
        },
      }),
  });
});

export const controlEnvironmentScientThreadQueue = Effect.fn(
  "clientRuntime.state.controlScientThreadQueue",
)(function* (input: {
  readonly prepared: PreparedConnection;
  readonly payload: ScientThreadQueueControlRequest;
}) {
  const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
  const remoteAuthorization = yield* Effect.serviceOption(RemoteEnvironmentAuthorization);
  return yield* executeAuthenticatedEnvironmentHttpRequest({
    prepared: input.prepared,
    signer,
    remoteAuthorization,
    method: "POST",
    url: (urls) => urls.control(),
    timeoutMs: REQUEST_TIMEOUT_MS,
    group: "scientThreadQueue",
    request: ({ client, headers }) =>
      client.control({
        headers,
        payload: input.payload,
      }),
  });
});
