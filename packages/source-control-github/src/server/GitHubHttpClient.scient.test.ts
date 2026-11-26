// @effect-diagnostics nodeBuiltinImport:off -- Spies on NodeHttp.Agent.prototype.destroy to verify scoped socket cleanup.
import { describe, expect, it, vi } from "@effect/vitest";
import * as NodeHttp from "node:http";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
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

  it.effect("keeps a shared probe alive when one of two concurrent callers is interrupted", () =>
    Effect.gen(function* () {
      let probes = 0;
      const probeStarted = yield* Deferred.make<void>();
      const releaseProbe = yield* Deferred.make<void>();
      const fallback = Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.succeed(HttpClientResponse.fromWeb(request, json({ url: request.url }))),
        ),
      );
      const host = TestSourceControlHost.layer({
        process: {
          run: () =>
            Effect.gen(function* () {
              probes += 1;
              yield* Deferred.succeed(probeStarted, undefined);
              yield* Deferred.await(releaseProbe);
              return TestSourceControlHost.processOutput("\n");
            }),
        },
      });
      const client = yield* HttpClient.HttpClient.pipe(
        Effect.provide(GitHubHttpClient.layer.pipe(Layer.provide(Layer.merge(host, fallback)))),
      );

      const firstCaller = yield* Effect.forkChild(
        client.execute(HttpClientRequest.get("https://api.github.com/first")),
      );
      yield* Deferred.await(probeStarted);
      const secondCaller = yield* Effect.forkChild(
        client.execute(HttpClientRequest.get("https://api.github.com/second")),
      );
      // Yield so the second caller joins the pending cached probe before interrupting the first.
      yield* Effect.yieldNow;
      yield* Fiber.interrupt(firstCaller);

      yield* Deferred.succeed(releaseProbe, undefined);
      const response = yield* Fiber.join(secondCaller);
      expect(yield* response.json).toEqual({ url: "https://api.github.com/second" });
      expect(probes).toBe(1);
    }),
  );

  it.effect("disposes the lazily created socket agent when the layer scope closes", () =>
    Effect.gen(function* () {
      const destroySpy = vi.spyOn(NodeHttp.Agent.prototype, "destroy");
      const fallback = Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.succeed(HttpClientResponse.fromWeb(request, json({ ok: true }))),
        ),
      );
      const host = TestSourceControlHost.layer({
        process: {
          run: () => Effect.succeed(TestSourceControlHost.processOutput("/nonexistent-gh.sock\n")),
        },
      });
      const layerScope = yield* Scope.make();
      try {
        const services = yield* Layer.buildWithScope(
          GitHubHttpClient.layer.pipe(Layer.provide(Layer.merge(host, fallback))),
          layerScope,
        );
        const client = services.mapUnsafe.get(HttpClient.HttpClient.key) as HttpClient.HttpClient;
        // Request fails connecting to the nonexistent socket, after creating the scoped agent.
        const exit = yield* Effect.exit(
          client.execute(HttpClientRequest.get("https://api.github.com/user")),
        );
        expect(Exit.isFailure(exit)).toBe(true);
        const destroysBeforeClose = destroySpy.mock.calls.length;
        yield* Scope.close(layerScope, Exit.void);
        expect(destroySpy.mock.calls.length).toBeGreaterThan(destroysBeforeClose);
      } finally {
        destroySpy.mockRestore();
      }
    }),
  );
});
