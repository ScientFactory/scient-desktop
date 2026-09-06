import * as Effect from "effect/Effect";

import type { PreparedConnection } from "../connection/model.ts";
import { environmentEndpointUrl } from "../environment/endpoint.ts";
import { ManagedRelayDpopSigner } from "../relay/managedRelay.ts";
import { executeAuthenticatedEnvironmentHttpRequest } from "./environmentHttpAuth.ts";
import { RemoteEnvironmentAuthorization } from "../authorization/service.ts";

const DEFAULT_SCIENT_PROJECT_REQUEST_TIMEOUT_MS = 10_000;

export const inspectEnvironmentScientProject = Effect.fn(
  "clientRuntime.state.inspectEnvironmentScientProject",
)(function* (input: {
  readonly prepared: PreparedConnection;
  readonly root: string;
  readonly timeoutMs?: number;
}) {
  const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
  const remoteAuthorization = yield* Effect.serviceOption(RemoteEnvironmentAuthorization);
  return yield* executeAuthenticatedEnvironmentHttpRequest({
    prepared: input.prepared,
    signer,
    remoteAuthorization,
    method: "POST",
    url: (httpBaseUrl) => environmentEndpointUrl(httpBaseUrl, "/api/scient/projects/inspect"),
    timeoutMs: input.timeoutMs ?? DEFAULT_SCIENT_PROJECT_REQUEST_TIMEOUT_MS,
    request: ({ client, headers }) =>
      client.scientProject.inspect({ headers, payload: { root: input.root } }),
  });
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
  const remoteAuthorization = yield* Effect.serviceOption(RemoteEnvironmentAuthorization);
  return yield* executeAuthenticatedEnvironmentHttpRequest({
    prepared: input.prepared,
    signer,
    remoteAuthorization,
    method: "POST",
    url: (httpBaseUrl) => environmentEndpointUrl(httpBaseUrl, "/api/scient/projects/initialize"),
    timeoutMs: input.timeoutMs ?? DEFAULT_SCIENT_PROJECT_REQUEST_TIMEOUT_MS,
    request: ({ client, headers }) =>
      client.scientProject.initialize({
        headers,
        payload: {
          root: input.root,
          ...(input.title === undefined ? {} : { title: input.title }),
        },
      }),
  });
});
