import * as Effect from "effect/Effect";

import type {
  ScientCloudEnrollmentProofRequest,
  ScientCloudShareBuildRequest,
  ScientCloudTakeOverRequest,
} from "@t3tools/contracts";

import type { PreparedConnection } from "../connection/model.ts";

import { ManagedRelayDpopSigner } from "../relay/managedRelay.ts";
import { executeAuthenticatedEnvironmentHttpRequest } from "./environmentHttpAuth.ts";
import { RemoteEnvironmentAuthorization } from "../authorization/service.ts";

/**
 * Client for a computer's Scient Cloud surface: its cloud copy status and switch, enrollment,
 * share building and take-over import. Mirrors `scientThreadQueueHttp.ts`; Scient-owned.
 */

const REQUEST_TIMEOUT_MS = 30_000;
// Deleting copies and importing a long conversation both talk to the cloud first.
const LONG_TIMEOUT_MS = 180_000;

type Endpoint =
  | "status"
  | "enrollmentProof"
  | "enrollmentComplete"
  | "setEnabled"
  | "stop"
  | "shareBuild"
  | "takeOver";

// Untraced: every caller below is a named Effect.fn whose span covers the request.
const call = Effect.fnUntraced(function* <A, E, R>(
  prepared: PreparedConnection,
  endpoint: Endpoint,
  timeoutMs: number,
  request: Parameters<
    typeof executeAuthenticatedEnvironmentHttpRequest<"scientCloud", A, E, R>
  >[0]["request"],
) {
  const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
  const remoteAuthorization = yield* Effect.serviceOption(RemoteEnvironmentAuthorization);
  return yield* executeAuthenticatedEnvironmentHttpRequest({
    prepared,
    signer,
    remoteAuthorization,
    method: "POST",
    url: (urls) => urls[endpoint](),
    timeoutMs,
    group: "scientCloud",
    request,
  });
});

export const readEnvironmentScientCloudStatus = Effect.fn(
  "clientRuntime.state.readScientCloudStatus",
)(function* (input: { readonly prepared: PreparedConnection }) {
  return yield* call(input.prepared, "status", REQUEST_TIMEOUT_MS, ({ client, headers }) =>
    client.status({ headers }),
  );
});

export const makeEnvironmentScientCloudEnrollmentProof = Effect.fn(
  "clientRuntime.state.makeScientCloudEnrollmentProof",
)(function* (input: {
  readonly prepared: PreparedConnection;
  readonly payload: ScientCloudEnrollmentProofRequest;
}) {
  return yield* call(input.prepared, "enrollmentProof", REQUEST_TIMEOUT_MS, ({ client, headers }) =>
    client.enrollmentProof({ headers, payload: input.payload }),
  );
});

export const completeEnvironmentScientCloudEnrollment = Effect.fn(
  "clientRuntime.state.completeScientCloudEnrollment",
)(function* (input: { readonly prepared: PreparedConnection; readonly userId: string }) {
  return yield* call(
    input.prepared,
    "enrollmentComplete",
    REQUEST_TIMEOUT_MS,
    ({ client, headers }) =>
      client.enrollmentComplete({ headers, payload: { userId: input.userId } }),
  );
});

export const setEnvironmentScientCloudEnabled = Effect.fn(
  "clientRuntime.state.setScientCloudEnabled",
)(function* (input: { readonly prepared: PreparedConnection; readonly enabled: boolean }) {
  return yield* call(input.prepared, "setEnabled", REQUEST_TIMEOUT_MS, ({ client, headers }) =>
    client.setEnabled({ headers, payload: { enabled: input.enabled } }),
  );
});

export const stopEnvironmentScientCloud = Effect.fn("clientRuntime.state.stopScientCloud")(
  function* (input: { readonly prepared: PreparedConnection; readonly deleteCopies: boolean }) {
    return yield* call(input.prepared, "stop", LONG_TIMEOUT_MS, ({ client, headers }) =>
      client.stop({ headers, payload: { deleteCopies: input.deleteCopies } }),
    );
  },
);

export const buildEnvironmentScientCloudShare = Effect.fn(
  "clientRuntime.state.buildScientCloudShare",
)(function* (input: {
  readonly prepared: PreparedConnection;
  readonly payload: ScientCloudShareBuildRequest;
}) {
  return yield* call(input.prepared, "shareBuild", LONG_TIMEOUT_MS, ({ client, headers }) =>
    client.shareBuild({ headers, payload: input.payload }),
  );
});

export const takeOverEnvironmentScientCloudThread = Effect.fn(
  "clientRuntime.state.takeOverScientCloudThread",
)(function* (input: {
  readonly prepared: PreparedConnection;
  readonly payload: ScientCloudTakeOverRequest;
}) {
  return yield* call(input.prepared, "takeOver", LONG_TIMEOUT_MS, ({ client, headers }) =>
    client.takeOver({ headers, payload: input.payload }),
  );
});
