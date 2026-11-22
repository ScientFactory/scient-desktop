/**
 * DesktopUpdateFactsHttpDelivery - delivers journaled update facts over authenticated HTTP to a
 * primary backend started without the telemetry pipes, as in a WSL-only setup. A primary with the
 * pipes takes them there instead, so this does nothing for it.
 *
 * @module DesktopUpdateFactsHttpDelivery
 */
import {
  DESKTOP_UPDATE_FACTS_HTTP_PATH,
  DesktopUpdateFactsHttpResponse,
  type DesktopUpdateFact,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import * as DesktopBackendManager from "../../backend/DesktopBackendManager.ts";
import * as DesktopBackendPool from "../../backend/DesktopBackendPool.ts";
import * as DesktopLocalEnvironmentAuth from "../../backend/DesktopLocalEnvironmentAuth.ts";
import * as DesktopUpdateFacts from "./DesktopUpdateFacts.ts";

const POLL_INTERVAL = "30 seconds";

/** The base URL of a ready primary that has no telemetry control pipe; otherwise none. */
export function httpDeliveryTarget(
  snapshot: DesktopBackendManager.DesktopBackendSnapshot,
  config: Option.Option<DesktopBackendManager.DesktopBackendStartConfig>,
): Option.Option<URL> {
  if (!snapshot.ready || Option.isNone(config)) return Option.none();
  return config.value.bootstrap.desktopTelemetryControlFd === undefined
    ? Option.some(config.value.httpBaseUrl)
    : Option.none();
}

const make = Effect.gen(function* () {
  const facts = yield* DesktopUpdateFacts.DesktopUpdateFacts;
  const pool = yield* DesktopBackendPool.DesktopBackendPool;
  const auth = yield* DesktopLocalEnvironmentAuth.DesktopLocalEnvironmentAuth;
  const http = yield* HttpClient.HttpClient;

  const send = Effect.fn("DesktopUpdateFactsHttpDelivery.send")(function* (
    baseUrl: URL,
    pending: ReadonlyArray<DesktopUpdateFact>,
  ) {
    const response = yield* http.execute(
      HttpClientRequest.post(new URL(DESKTOP_UPDATE_FACTS_HTTP_PATH, baseUrl)).pipe(
        HttpClientRequest.bearerToken(yield* auth.getBearerToken),
        HttpClientRequest.bodyJsonUnsafe({ facts: pending }),
      ),
    );
    if (response.status === 401) {
      yield* auth.forgetBearerToken;
      return;
    }
    if (response.status !== 200) return;
    const { ids } = yield* HttpClientResponse.schemaBodyJson(DesktopUpdateFactsHttpResponse)(
      response,
    );
    if (ids.length > 0) yield* facts.acknowledge(ids);
  });

  // Facts stay journaled until acknowledged, so a failed round simply waits for the next one.
  const deliverOnce = Effect.gen(function* () {
    const pending = yield* facts.pending;
    if (pending.length === 0) return;
    const primary = yield* pool.primary;
    const target = httpDeliveryTarget(yield* primary.snapshot, yield* primary.currentConfig);
    if (Option.isNone(target)) return;
    yield* send(target.value, pending);
  }).pipe(Effect.timeout("30 seconds"), Effect.ignoreCause());

  yield* deliverOnce.pipe(Effect.repeat(Schedule.spaced(POLL_INTERVAL)), Effect.forkScoped);
});

export const layer = Layer.effectDiscard(make);
