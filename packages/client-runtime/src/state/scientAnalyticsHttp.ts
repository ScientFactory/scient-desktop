import type { ScientAnalyticsConsent, ScientAnalyticsUiEvent } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type { PreparedConnection } from "../connection/model.ts";

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
    url: (urls) => urls.status(),
    timeoutMs: REQUEST_TIMEOUT_MS,
    group: "scientAnalytics",
    request: ({ client, headers }) => client.status({ headers }),
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
    url: (urls) => urls.preferences(),
    timeoutMs: REQUEST_TIMEOUT_MS,
    group: "scientAnalytics",
    request: ({ client, headers }) =>
      client.preferences({ headers, payload: { consent: input.consent } }),
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
    url: (urls) => urls.record(),
    timeoutMs: REQUEST_TIMEOUT_MS,
    group: "scientAnalytics",
    request: ({ client, headers }) => client.record({ headers, payload: input.event }),
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
    url: (urls) => urls.deleteData(),
    timeoutMs: REQUEST_TIMEOUT_MS,
    group: "scientAnalytics",
    request: ({ client, headers }) => client.deleteData({ headers }),
  });
});
