import type { ScientAnalyticsConsent, ScientAnalyticsUiEvent } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type { PreparedConnection } from "../connection/model.ts";
import { environmentEndpointUrl } from "../environment/endpoint.ts";
import { ManagedRelayDpopSigner } from "../relay/managedRelay.ts";
import { executeAuthenticatedEnvironmentHttpRequest } from "./environmentHttpAuth.ts";
import { RemoteEnvironmentAuthorization } from "../authorization/service.ts";

const REQUEST_TIMEOUT_MS = 5_000;

export const getEnvironmentScientAnalyticsStatus = Effect.fn(
  "clientRuntime.state.getEnvironmentScientAnalyticsStatus",
)(function* (prepared: PreparedConnection) {
  const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
  const remoteAuthorization = yield* Effect.serviceOption(RemoteEnvironmentAuthorization);
  return yield* executeAuthenticatedEnvironmentHttpRequest({
    prepared: prepared,
    signer,
    remoteAuthorization,
    method: "GET",
    url: (httpBaseUrl) => environmentEndpointUrl(httpBaseUrl, "/api/scient/analytics/status"),
    timeoutMs: REQUEST_TIMEOUT_MS,
    request: ({ client, headers }) => client.scientAnalytics.status({ headers }),
  });
});

export const updateEnvironmentScientAnalyticsPreference = Effect.fn(
  "clientRuntime.state.updateEnvironmentScientAnalyticsPreference",
)(function* (input: {
  readonly prepared: PreparedConnection;
  readonly consent: ScientAnalyticsConsent;
}) {
  const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
  const remoteAuthorization = yield* Effect.serviceOption(RemoteEnvironmentAuthorization);
  return yield* executeAuthenticatedEnvironmentHttpRequest({
    prepared: input.prepared,
    signer,
    remoteAuthorization,
    method: "POST",
    url: (httpBaseUrl) => environmentEndpointUrl(httpBaseUrl, "/api/scient/analytics/preferences"),
    timeoutMs: REQUEST_TIMEOUT_MS,
    request: ({ client, headers }) =>
      client.scientAnalytics.preferences({ headers, payload: { consent: input.consent } }),
  });
});

export const recordEnvironmentScientAnalyticsEvent = Effect.fn(
  "clientRuntime.state.recordEnvironmentScientAnalyticsEvent",
)(function* (input: {
  readonly prepared: PreparedConnection;
  readonly event: ScientAnalyticsUiEvent;
}) {
  const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
  const remoteAuthorization = yield* Effect.serviceOption(RemoteEnvironmentAuthorization);
  return yield* executeAuthenticatedEnvironmentHttpRequest({
    prepared: input.prepared,
    signer,
    remoteAuthorization,
    method: "POST",
    url: (httpBaseUrl) => environmentEndpointUrl(httpBaseUrl, "/api/scient/analytics/events"),
    timeoutMs: REQUEST_TIMEOUT_MS,
    request: ({ client, headers }) =>
      client.scientAnalytics.record({ headers, payload: input.event }),
  });
});

export const deleteEnvironmentScientAnalyticsData = Effect.fn(
  "clientRuntime.state.deleteEnvironmentScientAnalyticsData",
)(function* (prepared: PreparedConnection) {
  const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
  const remoteAuthorization = yield* Effect.serviceOption(RemoteEnvironmentAuthorization);
  return yield* executeAuthenticatedEnvironmentHttpRequest({
    prepared: prepared,
    signer,
    remoteAuthorization,
    method: "POST",
    url: (httpBaseUrl) => environmentEndpointUrl(httpBaseUrl, "/api/scient/analytics/delete"),
    timeoutMs: REQUEST_TIMEOUT_MS,
    request: ({ client, headers }) => client.scientAnalytics.deleteData({ headers }),
  });
});
