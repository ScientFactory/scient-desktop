import * as Effect from "effect/Effect";
import type {
  AnnotationDocumentRequest,
  AnnotationPrepareRequest,
  AnnotationMutationRequest,
  AnnotationMaterialRequest,
} from "@t3tools/contracts";
import type { PreparedConnection } from "../connection/model.ts";
import { environmentEndpointUrl } from "../environment/endpoint.ts";
import { ManagedRelayDpopSigner } from "../relay/managedRelay.ts";
import { executeAuthenticatedEnvironmentHttpRequest } from "./environmentHttpAuth.ts";
import { RemoteEnvironmentAuthorization } from "../authorization/service.ts";

export const openEnvironmentAnnotations = Effect.fn("clientRuntime.annotations.open")(function* (
  input: AnnotationDocumentRequest & { prepared: PreparedConnection },
) {
  const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
  const remoteAuthorization = yield* Effect.serviceOption(RemoteEnvironmentAuthorization);
  const { prepared, ...payload } = input;
  return yield* executeAuthenticatedEnvironmentHttpRequest({
    prepared,
    signer,
    remoteAuthorization,
    method: "POST",
    url: (base) => environmentEndpointUrl(base, "/api/scient/annotations/open"),
    timeoutMs: 30_000,
    request: ({ client, headers }) => client.scientAnnotations.open({ headers, payload }),
  });
});
export const prepareEnvironmentAnnotations = Effect.fn("clientRuntime.annotations.prepare")(
  function* (input: AnnotationPrepareRequest & { prepared: PreparedConnection }) {
    const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
    const remoteAuthorization = yield* Effect.serviceOption(RemoteEnvironmentAuthorization);
    const { prepared, ...payload } = input;
    return yield* executeAuthenticatedEnvironmentHttpRequest({
      prepared,
      signer,
      remoteAuthorization,
      method: "POST",
      url: (base) => environmentEndpointUrl(base, "/api/scient/annotations/prepare"),
      timeoutMs: 120_000,
      request: ({ client, headers }) => client.scientAnnotations.prepare({ headers, payload }),
    });
  },
);
export const mutateEnvironmentAnnotation = Effect.fn("clientRuntime.annotations.mutate")(function* (
  input: AnnotationMutationRequest & { prepared: PreparedConnection },
) {
  const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
  const remoteAuthorization = yield* Effect.serviceOption(RemoteEnvironmentAuthorization);
  const { prepared, ...payload } = input;
  return yield* executeAuthenticatedEnvironmentHttpRequest({
    prepared,
    signer,
    remoteAuthorization,
    method: "POST",
    url: (base) => environmentEndpointUrl(base, "/api/scient/annotations/mutate"),
    timeoutMs: 120_000,
    request: ({ client, headers }) => client.scientAnnotations.mutate({ headers, payload }),
  });
});
export const getEnvironmentAnnotationMaterial = Effect.fn("clientRuntime.annotations.material")(
  function* (input: AnnotationMaterialRequest & { prepared: PreparedConnection }) {
    const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
    const remoteAuthorization = yield* Effect.serviceOption(RemoteEnvironmentAuthorization);
    const { prepared, ...payload } = input;
    return yield* executeAuthenticatedEnvironmentHttpRequest({
      prepared,
      signer,
      remoteAuthorization,
      method: "POST",
      url: (base) => environmentEndpointUrl(base, "/api/scient/annotations/material"),
      timeoutMs: 30_000,
      request: ({ client, headers }) => client.scientAnnotations.material({ headers, payload }),
    });
  },
);
