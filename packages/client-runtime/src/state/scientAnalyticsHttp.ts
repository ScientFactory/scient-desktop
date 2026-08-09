import type { ScientAnalyticsConsent, ScientAnalyticsUiEvent } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type { PreparedConnection } from "../connection/model.ts";
import { environmentEndpointUrl } from "../environment/endpoint.ts";
import { ManagedRelayDpopSigner } from "../relay/managedRelay.ts";
import { executeEnvironmentHttpRequest, makeEnvironmentHttpApiClient } from "../rpc/http.ts";
import { buildEnvironmentAuthHeaders, withEnvironmentCredentials } from "./environmentHttpAuth.ts";

const REQUEST_TIMEOUT_MS = 5_000;

export const getEnvironmentScientAnalyticsStatus = Effect.fn(
  "clientRuntime.state.getEnvironmentScientAnalyticsStatus",
)(function* (prepared: PreparedConnection) {
  const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
  const requestUrl = environmentEndpointUrl(prepared.httpBaseUrl, "/api/scient/analytics/status");
  const client = yield* makeEnvironmentHttpApiClient(prepared.httpBaseUrl);
  const headers = yield* buildEnvironmentAuthHeaders(
    prepared.httpAuthorization,
    "GET",
    requestUrl,
    signer,
  );
  return yield* executeEnvironmentHttpRequest(
    requestUrl,
    REQUEST_TIMEOUT_MS,
    withEnvironmentCredentials(
      prepared.httpAuthorization,
      client.scientAnalytics.status({ headers }),
    ),
  );
});

export const updateEnvironmentScientAnalyticsPreference = Effect.fn(
  "clientRuntime.state.updateEnvironmentScientAnalyticsPreference",
)(function* (input: {
  readonly prepared: PreparedConnection;
  readonly consent: ScientAnalyticsConsent;
}) {
  const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
  const requestUrl = environmentEndpointUrl(
    input.prepared.httpBaseUrl,
    "/api/scient/analytics/preferences",
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
    REQUEST_TIMEOUT_MS,
    withEnvironmentCredentials(
      input.prepared.httpAuthorization,
      client.scientAnalytics.preferences({ headers, payload: { consent: input.consent } }),
    ),
  );
});

export const recordEnvironmentScientAnalyticsEvent = Effect.fn(
  "clientRuntime.state.recordEnvironmentScientAnalyticsEvent",
)(function* (input: {
  readonly prepared: PreparedConnection;
  readonly event: ScientAnalyticsUiEvent;
}) {
  const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
  const requestUrl = environmentEndpointUrl(
    input.prepared.httpBaseUrl,
    "/api/scient/analytics/events",
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
    REQUEST_TIMEOUT_MS,
    withEnvironmentCredentials(
      input.prepared.httpAuthorization,
      client.scientAnalytics.record({ headers, payload: input.event }),
    ),
  );
});

export const deleteEnvironmentScientAnalyticsData = Effect.fn(
  "clientRuntime.state.deleteEnvironmentScientAnalyticsData",
)(function* (prepared: PreparedConnection) {
  const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
  const requestUrl = environmentEndpointUrl(prepared.httpBaseUrl, "/api/scient/analytics/delete");
  const client = yield* makeEnvironmentHttpApiClient(prepared.httpBaseUrl);
  const headers = yield* buildEnvironmentAuthHeaders(
    prepared.httpAuthorization,
    "POST",
    requestUrl,
    signer,
  );
  return yield* executeEnvironmentHttpRequest(
    requestUrl,
    REQUEST_TIMEOUT_MS,
    withEnvironmentCredentials(
      prepared.httpAuthorization,
      client.scientAnalytics.deleteData({ headers }),
    ),
  );
});
