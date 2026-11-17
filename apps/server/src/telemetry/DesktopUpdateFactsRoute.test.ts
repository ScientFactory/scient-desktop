import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  AuthEnvironmentMaintainScope,
  AuthOrchestrationReadScope,
  DESKTOP_UPDATE_FACTS_HTTP_PATH,
  type DesktopUpdateFact,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Etag from "effect/http/Etag";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as HttpRouter from "effect/http/HttpRouter";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
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

function routes(scopes: ReadonlyArray<string> | null, settled: boolean, ingested: unknown[][]) {
  return DesktopUpdateFactsRoute.layer.pipe(
    Layer.provide(
      Layer.mock(EnvironmentAuth.EnvironmentAuth)({
        authenticateHttpRequest: () =>
          scopes === null
            ? Effect.fail({ _tag: "ServerAuthMissingCredentialError" } as never)
            : Effect.succeed({ scopes } as never),
      }),
    ),
    Layer.provide(
      Layer.succeed(ScientRecordedAnalyticsIngest, {
        ingest: (events) =>
          Effect.sync(() => void ingested.push([...events])).pipe(Effect.as(settled)),
      }),
    ),
    Layer.provideMerge(HttpPlatform.layer.pipe(Layer.provideMerge(Etag.layerWeak))),
    Layer.provide(NodeServices.layer),
  );
}

const post = (handler: (request: Request) => Promise<Response>, body: unknown) =>
  Effect.promise(() =>
    handler(
      new Request(`http://127.0.0.1${DESKTOP_UPDATE_FACTS_HTTP_PATH}`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer test" },
        body: JSON.stringify(body),
      }),
    ),
  );

const withHandler = <A>(
  layer: ReturnType<typeof routes>,
  use: (handler: (request: Request) => Promise<Response>) => Effect.Effect<A>,
) =>
  Effect.acquireUseRelease(
    Effect.sync(() => HttpRouter.toWebHandler(layer, { disableLogger: true })),
    ({ handler }) => use((request) => handler(request)),
    ({ dispose }) => Effect.promise(() => dispose()),
  );

it.effect("ingests facts over HTTP and acknowledges the ids the outbox holds", () =>
  Effect.gen(function* () {
    const ingested: unknown[][] = [];
    const response = yield* withHandler(
      routes([AuthEnvironmentMaintainScope], true, ingested),
      (handler) => post(handler, { facts: [fact] }),
    );
    expect(response.status).toBe(200);
    expect(yield* Effect.promise(() => response.json())).toEqual({ ids: ["fact-1"] });
    expect(ingested).toEqual([[fact]]);
  }),
);

it.effect("acknowledges nothing when the outbox did not take the facts", () =>
  Effect.gen(function* () {
    const response = yield* withHandler(
      routes([AuthEnvironmentMaintainScope], false, []),
      (handler) => post(handler, { facts: [fact] }),
    );
    expect(yield* Effect.promise(() => response.json())).toEqual({ ids: [] });
  }),
);

it.effect("refuses unauthenticated, under-scoped and malformed requests", () =>
  Effect.gen(function* () {
    const ingested: unknown[][] = [];
    const unauthenticated = yield* withHandler(routes(null, true, ingested), (handler) =>
      post(handler, { facts: [fact] }),
    );
    const underScoped = yield* withHandler(
      routes([AuthOrchestrationReadScope], true, ingested),
      (handler) => post(handler, { facts: [fact] }),
    );
    const malformed = yield* withHandler(
      routes([AuthEnvironmentMaintainScope], true, ingested),
      (handler) => post(handler, { facts: [{ id: "x" }] }),
    );
    expect([unauthenticated.status, underScoped.status, malformed.status]).toEqual([401, 403, 400]);
    expect(ingested).toEqual([]);
  }),
);
