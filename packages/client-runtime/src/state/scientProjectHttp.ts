import * as Effect from "effect/Effect";

import type { PreparedConnection } from "../connection/model.ts";
import { environmentEndpointUrl } from "../environment/endpoint.ts";
import { ManagedRelayDpopSigner } from "../relay/managedRelay.ts";
import { executeEnvironmentHttpRequest, makeEnvironmentHttpApiClient } from "../rpc/http.ts";
import { buildEnvironmentAuthHeaders, withEnvironmentCredentials } from "./environmentHttpAuth.ts";

const DEFAULT_SCIENT_PROJECT_REQUEST_TIMEOUT_MS = 10_000;

export const inspectEnvironmentScientProject = Effect.fn(
  "clientRuntime.state.inspectEnvironmentScientProject",
)(function* (input: {
  readonly prepared: PreparedConnection;
  readonly root: string;
  readonly timeoutMs?: number;
}) {
  const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
  const requestUrl = environmentEndpointUrl(
    input.prepared.httpBaseUrl,
    "/api/scient/projects/inspect",
  );
  const client = yield* makeEnvironmentHttpApiClient(input.prepared.httpBaseUrl);
  const headers = yield* buildEnvironmentAuthHeaders(
    input.prepared.httpAuthorization,
    "POST",
    requestUrl,
    signer,
  );
  return yield* executeEnvironmentHttpRequest(
    requestUrl,
    input.timeoutMs ?? DEFAULT_SCIENT_PROJECT_REQUEST_TIMEOUT_MS,
    withEnvironmentCredentials(
      input.prepared.httpAuthorization,
      client.scientProject.inspect({ headers, payload: { root: input.root } }),
    ),
  );
});

export const initializeEnvironmentScientProject = Effect.fn(
  "clientRuntime.state.initializeEnvironmentScientProject",
)(function* (input: {
  readonly prepared: PreparedConnection;
  readonly root: string;
  readonly title?: string;
  readonly timeoutMs?: number;
}) {
  const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
  const requestUrl = environmentEndpointUrl(
    input.prepared.httpBaseUrl,
    "/api/scient/projects/initialize",
  );
  const client = yield* makeEnvironmentHttpApiClient(input.prepared.httpBaseUrl);
  const headers = yield* buildEnvironmentAuthHeaders(
    input.prepared.httpAuthorization,
    "POST",
    requestUrl,
    signer,
  );
  return yield* executeEnvironmentHttpRequest(
    requestUrl,
    input.timeoutMs ?? DEFAULT_SCIENT_PROJECT_REQUEST_TIMEOUT_MS,
    withEnvironmentCredentials(
      input.prepared.httpAuthorization,
      client.scientProject.initialize({
        headers,
        payload: {
          root: input.root,
          ...(input.title === undefined ? {} : { title: input.title }),
        },
      }),
    ),
  );
});
