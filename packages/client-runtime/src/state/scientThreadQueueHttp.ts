import * as Effect from "effect/Effect";

import type {
  ThreadId,
  ScientThreadQueueControlRequest,
  ScientThreadQueueEnqueueRequest,
  ScientThreadQueueRemoveRequest,
  ScientThreadQueueReorderRequest,
  ScientThreadQueueUpdateRequest,
} from "@t3tools/contracts";

import type { PreparedConnection } from "../connection/model.ts";
import { environmentEndpointUrl } from "../environment/endpoint.ts";
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
    url: (httpBaseUrl) => environmentEndpointUrl(httpBaseUrl, "/api/scient/thread-queue/v2/list"),
    timeoutMs: REQUEST_TIMEOUT_MS,
    request: ({ client, headers }) =>
      client.scientThreadQueue.list({
        headers,
        payload: {
          threadId: input.threadId,
          ...(input.knownRevision !== undefined ? { knownRevision: input.knownRevision } : {}),
        },
      }),
  });
});

export const enqueueEnvironmentScientThreadQueueItem = Effect.fn(
  "clientRuntime.state.enqueueEnvironmentScientThreadQueueItem",
)(function* (input: {
  readonly prepared: PreparedConnection;
  readonly threadId: ThreadId;
  readonly queueItemId: string;
  readonly modelSelection?: ScientThreadQueueEnqueueRequest["modelSelection"];
  readonly runtimeMode?: ScientThreadQueueEnqueueRequest["runtimeMode"];
  readonly interactionMode?: ScientThreadQueueEnqueueRequest["interactionMode"];
  readonly text: ScientThreadQueueEnqueueRequest["text"];
  readonly attachments: ScientThreadQueueEnqueueRequest["attachments"];
}) {
  const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
  const remoteAuthorization = yield* Effect.serviceOption(RemoteEnvironmentAuthorization);
  return yield* executeAuthenticatedEnvironmentHttpRequest({
    prepared: input.prepared,
    signer,
    remoteAuthorization,
    method: "POST",
    url: (httpBaseUrl) =>
      environmentEndpointUrl(httpBaseUrl, "/api/scient/thread-queue/v2/enqueue"),
    timeoutMs: REQUEST_TIMEOUT_MS,
    request: ({ client, headers }) =>
      client.scientThreadQueue.enqueue({
        headers,
        payload: {
          threadId: input.threadId,
          queueItemId: input.queueItemId,
          modelSelection: input.modelSelection,
          runtimeMode: input.runtimeMode,
          interactionMode: input.interactionMode,
          text: input.text,
          attachments: input.attachments,
        },
      }),
  });
});

export const removeEnvironmentScientThreadQueueItem = Effect.fn(
  "clientRuntime.state.removeEnvironmentScientThreadQueueItem",
)(function* (input: {
  readonly prepared: PreparedConnection;
  readonly threadId: ThreadId;
  readonly queueItemId: ScientThreadQueueRemoveRequest["queueItemId"];
}) {
  const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
  const remoteAuthorization = yield* Effect.serviceOption(RemoteEnvironmentAuthorization);
  return yield* executeAuthenticatedEnvironmentHttpRequest({
    prepared: input.prepared,
    signer,
    remoteAuthorization,
    method: "POST",
    url: (httpBaseUrl) => environmentEndpointUrl(httpBaseUrl, "/api/scient/thread-queue/v2/remove"),
    timeoutMs: REQUEST_TIMEOUT_MS,
    request: ({ client, headers }) =>
      client.scientThreadQueue.remove({
        headers,
        payload: { threadId: input.threadId, queueItemId: input.queueItemId },
      }),
  });
});

export const updateEnvironmentScientThreadQueueItem = Effect.fn(
  "clientRuntime.state.updateEnvironmentScientThreadQueueItem",
)(function* (input: {
  readonly prepared: PreparedConnection;
  readonly threadId: ThreadId;
  readonly queueItemId: ScientThreadQueueUpdateRequest["queueItemId"];
  readonly editToken: string;
  readonly modelSelection?: ScientThreadQueueUpdateRequest["modelSelection"];
  readonly runtimeMode?: ScientThreadQueueUpdateRequest["runtimeMode"];
  readonly interactionMode?: ScientThreadQueueUpdateRequest["interactionMode"];
  readonly text: ScientThreadQueueUpdateRequest["text"];
  readonly attachments: ScientThreadQueueUpdateRequest["attachments"];
}) {
  const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
  const remoteAuthorization = yield* Effect.serviceOption(RemoteEnvironmentAuthorization);
  return yield* executeAuthenticatedEnvironmentHttpRequest({
    prepared: input.prepared,
    signer,
    remoteAuthorization,
    method: "POST",
    url: (httpBaseUrl) => environmentEndpointUrl(httpBaseUrl, "/api/scient/thread-queue/v2/update"),
    timeoutMs: REQUEST_TIMEOUT_MS,
    request: ({ client, headers }) =>
      client.scientThreadQueue.update({
        headers,
        payload: {
          threadId: input.threadId,
          queueItemId: input.queueItemId,
          editToken: input.editToken,
          modelSelection: input.modelSelection,
          runtimeMode: input.runtimeMode,
          interactionMode: input.interactionMode,
          text: input.text,
          attachments: input.attachments,
        },
      }),
  });
});

export const reorderEnvironmentScientThreadQueue = Effect.fn(
  "clientRuntime.state.reorderEnvironmentScientThreadQueue",
)(function* (input: {
  readonly prepared: PreparedConnection;
  readonly threadId: ThreadId;
  readonly queueItemIds: ScientThreadQueueReorderRequest["queueItemIds"];
}) {
  const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
  const remoteAuthorization = yield* Effect.serviceOption(RemoteEnvironmentAuthorization);
  return yield* executeAuthenticatedEnvironmentHttpRequest({
    prepared: input.prepared,
    signer,
    remoteAuthorization,
    method: "POST",
    url: (httpBaseUrl) =>
      environmentEndpointUrl(httpBaseUrl, "/api/scient/thread-queue/v2/reorder"),
    timeoutMs: REQUEST_TIMEOUT_MS,
    request: ({ client, headers }) =>
      client.scientThreadQueue.reorder({
        headers,
        payload: { threadId: input.threadId, queueItemIds: input.queueItemIds },
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
    url: (httpBaseUrl) =>
      environmentEndpointUrl(httpBaseUrl, "/api/scient/thread-queue/v2/control"),
    timeoutMs: REQUEST_TIMEOUT_MS,
    request: ({ client, headers }) =>
      client.scientThreadQueue.control({
        headers,
        payload: input.payload,
      }),
  });
});
