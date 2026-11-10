import * as Effect from "effect/Effect";
import type {
  ScientAnnotationMutationRequest,
  ScientAnnotationsDocumentRequest,
  ScientAnnotationsSourceRequest,
} from "@t3tools/contracts";

import type { PreparedConnection } from "../connection/model.ts";
import { RemoteEnvironmentAuthorization } from "../authorization/service.ts";
import { ManagedRelayDpopSigner } from "../relay/managedRelay.ts";
import { executeAuthenticatedEnvironmentHttpRequest } from "./environmentHttpAuth.ts";

// Reading a document hashes its PDF on the server, which takes a moment for a large file.
const READ_TIMEOUT_MS = 30_000;
const WRITE_TIMEOUT_MS = 30_000;

export const getEnvironmentDocumentAnnotations = Effect.fn(
  "clientRuntime.state.getEnvironmentDocumentAnnotations",
)(function* (input: {
  readonly prepared: PreparedConnection;
  readonly request: ScientAnnotationsDocumentRequest;
}) {
  return yield* executeAuthenticatedEnvironmentHttpRequest({
    prepared: input.prepared,
    signer: yield* Effect.serviceOption(ManagedRelayDpopSigner),
    remoteAuthorization: yield* Effect.serviceOption(RemoteEnvironmentAuthorization),
    method: "POST",
    url: (urls) => urls.annotationsForDocument(),
    timeoutMs: READ_TIMEOUT_MS,
    group: "scientPdf",
    request: ({ client, headers }) =>
      client.annotationsForDocument({ headers, payload: input.request }),
  });
});

export const getEnvironmentSourceAnnotations = Effect.fn(
  "clientRuntime.state.getEnvironmentSourceAnnotations",
)(function* (input: {
  readonly prepared: PreparedConnection;
  readonly request: ScientAnnotationsSourceRequest;
}) {
  return yield* executeAuthenticatedEnvironmentHttpRequest({
    prepared: input.prepared,
    signer: yield* Effect.serviceOption(ManagedRelayDpopSigner),
    remoteAuthorization: yield* Effect.serviceOption(RemoteEnvironmentAuthorization),
    method: "POST",
    url: (urls) => urls.annotationsForSource(),
    timeoutMs: READ_TIMEOUT_MS,
    group: "scientPdf",
    request: ({ client, headers }) =>
      client.annotationsForSource({ headers, payload: input.request }),
  });
});

export const mutateEnvironmentAnnotation = Effect.fn(
  "clientRuntime.state.mutateEnvironmentAnnotation",
)(function* (input: {
  readonly prepared: PreparedConnection;
  readonly request: ScientAnnotationMutationRequest;
}) {
  return yield* executeAuthenticatedEnvironmentHttpRequest({
    prepared: input.prepared,
    signer: yield* Effect.serviceOption(ManagedRelayDpopSigner),
    remoteAuthorization: yield* Effect.serviceOption(RemoteEnvironmentAuthorization),
    method: "POST",
    url: (urls) => urls.annotationsMutate(),
    timeoutMs: WRITE_TIMEOUT_MS,
    group: "scientPdf",
    request: ({ client, headers }) => client.annotationsMutate({ headers, payload: input.request }),
  });
});
