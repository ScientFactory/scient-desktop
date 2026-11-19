import * as Effect from "effect/Effect";

import type {
  ScientReferenceCheckRequest,
  ScientReferenceResolveRequest,
} from "@t3tools/contracts";

import type { PreparedConnection } from "../connection/model.ts";

import { RemoteEnvironmentAuthorization } from "../authorization/service.ts";
import { ManagedRelayDpopSigner } from "../relay/managedRelay.ts";
import { executeAuthenticatedEnvironmentHttpRequest } from "./environmentHttpAuth.ts";

const REQUEST_TIMEOUT_MS = 15_000;
// The server stops starting registry lookups after 90 seconds and then reports the rest.
const CHECK_TIMEOUT_MS = 120_000;
const RESOLVE_TIMEOUT_MS = 30_000;

const authenticated = Effect.fn("clientRuntime.state.scientReferencesAuthentication")(function* () {
  return {
    signer: yield* Effect.serviceOption(ManagedRelayDpopSigner),
    remoteAuthorization: yield* Effect.serviceOption(RemoteEnvironmentAuthorization),
  };
});

export const listEnvironmentReferenceDocuments = Effect.fn(
  "clientRuntime.state.listEnvironmentReferenceDocuments",
)(function* (input: { readonly prepared: PreparedConnection; readonly root: string }) {
  return yield* executeAuthenticatedEnvironmentHttpRequest({
    prepared: input.prepared,
    ...(yield* authenticated()),
    method: "POST",
    url: (urls) => urls.documents(),
    timeoutMs: REQUEST_TIMEOUT_MS,
    group: "scientReferences",
    request: ({ client, headers }) => client.documents({ headers, payload: { root: input.root } }),
  });
});

export const checkEnvironmentReferences = Effect.fn(
  "clientRuntime.state.checkEnvironmentReferences",
)(function* (input: { readonly prepared: PreparedConnection } & ScientReferenceCheckRequest) {
  return yield* executeAuthenticatedEnvironmentHttpRequest({
    prepared: input.prepared,
    ...(yield* authenticated()),
    method: "POST",
    url: (urls) => urls.check(),
    timeoutMs: CHECK_TIMEOUT_MS,
    group: "scientReferences",
    request: ({ client, headers }) =>
      client.check({ headers, payload: { root: input.root, target: input.target } }),
  });
});

export const resolveEnvironmentReferences = Effect.fn(
  "clientRuntime.state.resolveEnvironmentReferences",
)(function* (input: { readonly prepared: PreparedConnection } & ScientReferenceResolveRequest) {
  const { prepared, ...payload } = input;
  return yield* executeAuthenticatedEnvironmentHttpRequest({
    prepared,
    ...(yield* authenticated()),
    method: "POST",
    url: (urls) => urls.resolve(),
    timeoutMs: RESOLVE_TIMEOUT_MS,
    group: "scientReferences",
    request: ({ client, headers }) => client.resolve({ headers, payload }),
  });
});
