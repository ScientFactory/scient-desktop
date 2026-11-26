import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import * as TestSourceControlHost from "@t3tools/source-control-testing/TestSourceControlHost";

import * as GitHubHttpClient from "./GitHubHttpClient.ts";

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

describe("GitHubHttpClient lazy resolution", () => {
  it.effect(
    "defers gh socket config until first HTTP request, shares concurrent probes, and recovers after cancellation",
    () =>
      Effect.gen(function* () {
        let probes = 0;
        const firstGate = yield* Deferred.make<void>();
        const releaseFirst = yield* Deferred.make<void>();
        const requests: Array<HttpClientRequest.HttpClientRequest> = [];
        const fallback = Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make((request) => {
            requests.push(request);
            return Effect.succeed(HttpClientResponse.fromWeb(request, json({ ok: true })));
          }),
        );
        const host = TestSourceControlHost.layer({
          process: {
            run: () =>
              Effect.gen(function* () {
                const attempt = ++probes;
                if (attempt === 1) {
                  yield* Deferred.succeed(firstGate, undefined);
                  yield* Deferred.await(releaseFirst);
                }
                return TestSourceControlHost.processOutput("\n");
              }),
          },
        });
        const client = yield* HttpClient.HttpClient.pipe(
          Effect.provide(GitHubHttpClient.layer.pipe(Layer.provide(Layer.merge(host, fallback)))),
        );
        // Layer construction must not spawn gh.
        expect(probes).toBe(0);

        // Interrupting the first caller mid-probe must not poison the cached transport.
        const cancelledFiber = yield* Effect.forkChild(
          client.execute(HttpClientRequest.get("https://api.github.com/cancelled")),
        );
        yield* Deferred.await(firstGate);
        expect(probes).toBe(1);
        yield* Fiber.interrupt(cancelledFiber);

        // Concurrent follow-up requests trigger one fresh probe and share it.
        const [first, second] = yield* Effect.all(
          [
            client.execute(HttpClientRequest.get("https://api.github.com/one")),
            client.execute(HttpClientRequest.get("https://api.github.com/two")),
          ],
          { concurrency: "unbounded" },
        );
        expect(yield* first.json).toEqual({ ok: true });
        expect(yield* second.json).toEqual({ ok: true });
        expect(probes).toBe(2);
        expect(requests.map((request) => request.url)).toEqual([
          "https://api.github.com/one",
          "https://api.github.com/two",
        ]);
      }),
  );
});
