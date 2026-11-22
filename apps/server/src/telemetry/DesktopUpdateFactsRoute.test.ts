import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { DESKTOP_UPDATE_FACTS_HTTP_PATH, type DesktopUpdateFact } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Etag from "effect/http/Etag";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as HttpRouter from "effect/http/HttpRouter";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerConfig from "../config.ts";
import * as DesktopUpdateFactsRoute from "./DesktopUpdateFactsRoute.ts";
import { ScientRecordedAnalyticsIngest } from "./ScientAnalytics.ts";

const fact: DesktopUpdateFact = {
  id: "fact-1",
  name: "app.update.outcome",
  occurredAt: "2026-11-18T00:00:00.000Z",
  appVersion: "0.6.31",
  buildChannel: "stable",
  properties: { step: "apply", outcome: "completed" },
};

interface Setup {
  /** The session's subject; null for a request that does not authenticate. */
  readonly subject?: string | null;
  readonly settled?: boolean;
  /** The telemetry control pipe the backend was started with. */
  readonly controlFd?: number;
}

function routes(setup: Setup, ingested: unknown[][]) {
  const subject = setup.subject === undefined ? "desktop-bootstrap" : setup.subject;
  return DesktopUpdateFactsRoute.layer.pipe(
    Layer.provide(
      Layer.mock(EnvironmentAuth.EnvironmentAuth)({
        authenticateHttpRequest: () =>
          subject === null
            ? Effect.fail({ _tag: "ServerAuthMissingCredentialError" } as never)
            : Effect.succeed({ subject, scopes: [] } as never),
      }),
    ),
    Layer.provide(
      Layer.succeed(ScientRecordedAnalyticsIngest, {
        ingest: (events) =>
          Effect.sync(() => void ingested.push([...events])).pipe(Effect.as(setup.settled ?? true)),
      }),
    ),
    Layer.provide(
      Layer.succeed(ServerConfig.ServerConfig, {
        mode: "desktop",
        desktopTelemetryControlFd: setup.controlFd,
      } as never),
    ),
    Layer.provideMerge(HttpPlatform.layer.pipe(Layer.provideMerge(Etag.layerWeak))),
    Layer.provide(NodeServices.layer),
  );
}

const post = (setup: Setup, body: string, ingested: unknown[][] = []) =>
  Effect.acquireUseRelease(
    Effect.sync(() => HttpRouter.toWebHandler(routes(setup, ingested), { disableLogger: true })),
    ({ handler }) =>
      Effect.promise(() =>
        handler(
          new Request(`http://127.0.0.1${DESKTOP_UPDATE_FACTS_HTTP_PATH}`, {
            method: "POST",
            headers: { "content-type": "application/json", authorization: "Bearer test" },
            body,
          }),
        ),
      ),
    ({ dispose }) => Effect.promise(() => dispose()),
  );

const valid = JSON.stringify({ facts: [fact] });

it.effect("ingests the desktop's facts and acknowledges the ids the outbox holds", () =>
  Effect.gen(function* () {
    const ingested: unknown[][] = [];
    const response = yield* post({}, valid, ingested);
    expect(response.status).toBe(200);
    expect(yield* Effect.promise(() => response.json())).toEqual({ ids: ["fact-1"] });
    expect(ingested).toEqual([[fact]]);
  }),
);

it.effect("acknowledges nothing when the outbox did not take the facts", () =>
  Effect.gen(function* () {
    const response = yield* post({ settled: false }, valid);
    expect(yield* Effect.promise(() => response.json())).toEqual({ ids: [] });
  }),
);

it.effect("refuses anyone but the desktop, and malformed or oversized bodies", () =>
  Effect.gen(function* () {
    const ingested: unknown[][] = [];
    const statuses = [
      (yield* post({ subject: null }, valid, ingested)).status,
      // A paired client holds the standard scopes but not the desktop's subject.
      (yield* post({ subject: "cloud-connect" }, valid, ingested)).status,
      (yield* post({}, JSON.stringify({ facts: [{ id: "x" }] }), ingested)).status,
      (yield* post({}, `{"facts":[],"pad":"${"x".repeat(300 * 1024)}"}`, ingested)).status,
    ];
    expect(statuses[0]).toBe(401);
    expect(statuses[1]).toBe(403);
    expect(statuses[2]).toBe(400);
    expect([400, 413]).toContain(statuses[3]);
    expect(ingested).toEqual([]);
  }),
);

it.effect("is not served by a backend that has the telemetry pipes", () =>
  Effect.gen(function* () {
    const ingested: unknown[][] = [];
    const response = yield* post({ controlFd: 5 }, valid, ingested);
    expect(response.status).toBe(404);
    expect(ingested).toEqual([]);
  }),
);
