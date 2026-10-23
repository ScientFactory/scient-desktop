// @effect-diagnostics nodeBuiltinImport:off -- native Node timeouts require real loopback measurements.
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, expect } from "@effect/vitest";
import { describe, it } from "vite-plus/test";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import { measureEffectBenchmark } from "../../testUtils/benchmark.testkit.ts";
import * as OmpExecutableGate from "./OmpExecutableGate.ts";
import { connection, model, secondModel, setup } from "./OmpCustomModels.barrier.testkit.ts";

/** A raw TCP client of the loopback endpoint that writes `text` and records when it closes. */
const rawSocket = (url: string, text: string) =>
  new Promise<{
    readonly closed: Promise<void>;
    readonly closedAfterMs: () => number;
    readonly received: () => string;
  }>((resolve, reject) => {
    const { port } = new URL(url);
    const opened = performance.now();
    let closedAt = Number.NaN;
    let received = "";
    const socket = NodeNet.connect(Number(port), "127.0.0.1");
    const closed = new Promise<void>((done) =>
      socket.once("close", () => {
        closedAt = performance.now();
        done();
      }),
    );
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => (received += chunk));
    socket.once("error", () => undefined);
    socket.once("connect", () => {
      if (text) socket.write(text);
      resolve({ closed, closedAfterMs: () => closedAt - opened, received: () => received });
    });
    socket.once("error", reject);
  });

describe("Oh My Pi custom-model refresh barrier", () => {
  it("holds the long-poll past the request timeout and wakes on a change", async ({ bench }) =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const { extension, changeSettings, waitSnapshots } = yield* setup({
            label: "long-poll",
            watch: false,
            // Node enforces its request timeout on this interval; without a
            // short one a 400 ms hold would outlive a 100 ms timeout trivially.
            timing: { requestTimeoutMs: 100, waitHoldMs: 400, connectionsCheckingIntervalMs: 10 },
          });
          yield* measureEffectBenchmark(
            bench,
            "holds the long-poll past the request timeout and wakes on a change",
            Effect.gen(function* () {
              const slow = yield* Effect.promise(() =>
                rawSocket(extension.url, "GET /models HTTP/1.1\r\n"),
              );
              yield* Effect.promise(() => slow.closed);
              expect(slow.closedAfterMs()).toBeLessThan(1_000);
              const started = yield* Clock.currentTimeMillis;
              const idle = yield* Effect.promise(() => extension.wait(extension.applied()));
              expect(idle).toEqual({ status: 200, generation: extension.applied() });
              expect((yield* Clock.currentTimeMillis) - started).toBeGreaterThanOrEqual(350);
              const held = yield* Queue.take(waitSnapshots);
              assert.equal(held.after, extension.applied());
              assert.equal(held.generation, extension.applied());
              const waiting = yield* Effect.forkChild(
                Effect.promise(() => extension.wait(extension.applied())),
              );
              const subscribed = yield* Queue.take(waitSnapshots);
              assert.equal(subscribed.after, extension.applied());
              assert.equal(subscribed.generation, extension.applied());
              assert.notStrictEqual(subscribed.request, held.request);
              // Retiring this passive sink must not stop the subscribed wait from waking.
              yield* Queue.shutdown(waitSnapshots);
              const changedAt = yield* Clock.currentTimeMillis;
              yield* changeSettings([{ ...connection, models: [model, secondModel] }]);
              const woke = yield* Fiber.join(waiting);
              expect(woke.generation).toBe(extension.applied() + 1);
              expect((yield* Clock.currentTimeMillis) - changedAt).toBeLessThan(300);
            }),
          );
        }),
      ).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, OmpExecutableGate.layer))),
    ));

  it("idle and unauthenticated sockets cannot starve the extension", async ({ bench }) =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const { extension } = yield* setup({
            label: "starve",
            watch: false,
            timing: { requestTimeoutMs: 200, connectionsCheckingIntervalMs: 10 },
          });
          yield* measureEffectBenchmark(
            bench,
            "idle and unauthenticated sockets cannot starve the extension",
            Effect.gen(function* () {
              const idle = yield* Effect.promise(() =>
                Promise.all(
                  Array.from({ length: 8 }, (_, index) =>
                    rawSocket(extension.url, index % 2 === 0 ? "" : "GET /models HTTP/1.1\r\n"),
                  ),
                ),
              );
              const status = yield* Effect.promise(
                () =>
                  new Promise<number | string>((resolve) => {
                    const request = NodeHttp.get(
                      extension.url,
                      { agent: false, headers: extension.headers, timeout: 2_000 },
                      (response) => {
                        response.resume();
                        resolve(response.statusCode ?? 0);
                      },
                    );
                    request.once("error", (error) => resolve(error.message));
                    request.once("timeout", () => request.destroy(new Error("timed out")));
                  }),
              );
              expect(status).toBe(200);
              yield* Effect.promise(() => Promise.all(idle.map((socket) => socket.closed)));
              expect(Math.max(...idle.map((socket) => socket.closedAfterMs()))).toBeLessThan(2_000);
              const refused = yield* Effect.promise(() =>
                rawSocket(
                  extension.url,
                  "GET /models HTTP/1.1\r\nhost: 127.0.0.1\r\nauthorization: Bearer wrong\r\n\r\n",
                ),
              );
              yield* Effect.promise(() => refused.closed);
              expect(refused.received()).toMatch(/^HTTP\/1\.1 403 /u);
              expect(refused.closedAfterMs()).toBeLessThan(1_000);
            }),
          );
        }),
      ).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, OmpExecutableGate.layer))),
    ));
});
