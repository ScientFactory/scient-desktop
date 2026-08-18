import * as Effect from "effect/Effect";

import type {
  ThreadId,
  ScientThreadQueueEnqueueRequest,
  ScientThreadQueueRemoveRequest,
  ScientThreadQueueReorderRequest,
} from "@t3tools/contracts";

import type { PreparedConnection } from "../connection/model.ts";
import { environmentEndpointUrl } from "../environment/endpoint.ts";
import { ManagedRelayDpopSigner } from "../relay/managedRelay.ts";
import { executeEnvironmentHttpRequest, makeEnvironmentHttpApiClient } from "../rpc/http.ts";
import { buildEnvironmentAuthHeaders, withEnvironmentCredentials } from "./environmentHttpAuth.ts";

/**
 * Client for the Scient thread queue HTTP surface. Mirrors
 * `scientSourcesHttp.ts`; Scient-owned end to end. See
 * `docs/internals/scient-thread-queue.md`.
 */

const REQUEST_TIMEOUT_MS = 15_000;

const requestContext = Effect.fn("clientRuntime.state.scientThreadQueueRequestContext")(
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

export const listEnvironmentScientThreadQueue = Effect.fn(
  "clientRuntime.state.listEnvironmentScientThreadQueue",
)(function* (input: { readonly prepared: PreparedConnection; readonly threadId: ThreadId }) {
  const context = yield* requestContext({
    prepared: input.prepared,
    path: "/api/scient/thread-queue/list",
  });
  return yield* executeEnvironmentHttpRequest(
    context.requestUrl,
    REQUEST_TIMEOUT_MS,
    withEnvironmentCredentials(
      input.prepared.httpAuthorization,
      context.client.scientThreadQueue.list({
        headers: context.headers,
        payload: { threadId: input.threadId },
      }),
    ),
  );
});

export const enqueueEnvironmentScientThreadQueueItem = Effect.fn(
  "clientRuntime.state.enqueueEnvironmentScientThreadQueueItem",
)(function* (input: {
  readonly prepared: PreparedConnection;
  readonly threadId: ThreadId;
  readonly text: ScientThreadQueueEnqueueRequest["text"];
  readonly attachments: ScientThreadQueueEnqueueRequest["attachments"];
}) {
  const context = yield* requestContext({
    prepared: input.prepared,
    path: "/api/scient/thread-queue/enqueue",
  });
  return yield* executeEnvironmentHttpRequest(
    context.requestUrl,
    REQUEST_TIMEOUT_MS,
    withEnvironmentCredentials(
      input.prepared.httpAuthorization,
      context.client.scientThreadQueue.enqueue({
        headers: context.headers,
        payload: {
          threadId: input.threadId,
          text: input.text,
          attachments: input.attachments,
        },
      }),
    ),
  );
});

export const removeEnvironmentScientThreadQueueItem = Effect.fn(
  "clientRuntime.state.removeEnvironmentScientThreadQueueItem",
)(function* (input: {
  readonly prepared: PreparedConnection;
  readonly threadId: ThreadId;
  readonly queueItemId: ScientThreadQueueRemoveRequest["queueItemId"];
}) {
  const context = yield* requestContext({
    prepared: input.prepared,
    path: "/api/scient/thread-queue/remove",
  });
  return yield* executeEnvironmentHttpRequest(
    context.requestUrl,
    REQUEST_TIMEOUT_MS,
    withEnvironmentCredentials(
      input.prepared.httpAuthorization,
      context.client.scientThreadQueue.remove({
        headers: context.headers,
        payload: { threadId: input.threadId, queueItemId: input.queueItemId },
      }),
    ),
  );
});

export const reorderEnvironmentScientThreadQueue = Effect.fn(
  "clientRuntime.state.reorderEnvironmentScientThreadQueue",
)(function* (input: {
  readonly prepared: PreparedConnection;
  readonly threadId: ThreadId;
  readonly queueItemIds: ScientThreadQueueReorderRequest["queueItemIds"];
}) {
  const context = yield* requestContext({
    prepared: input.prepared,
    path: "/api/scient/thread-queue/reorder",
  });
  return yield* executeEnvironmentHttpRequest(
    context.requestUrl,
    REQUEST_TIMEOUT_MS,
    withEnvironmentCredentials(
      input.prepared.httpAuthorization,
      context.client.scientThreadQueue.reorder({
        headers: context.headers,
        payload: { threadId: input.threadId, queueItemIds: input.queueItemIds },
      }),
    ),
  );
});
