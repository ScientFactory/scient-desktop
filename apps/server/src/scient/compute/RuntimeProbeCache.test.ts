import { describe, expect, it } from "@effect/vitest";
import { ComputeRuntimeError } from "@scientfactory/compute";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { TestClock } from "effect/testing";

import { makeRuntimeProbeCache } from "./RuntimeProbeCache.ts";

const failure = new ComputeRuntimeError({ operation: "discover", message: "python exited 1" });

describe("runtime probe cache", () => {
  it.effect("shares one in-flight probe between concurrent callers", () =>
    Effect.gen(function* () {
      const cache = makeRuntimeProbeCache<string>();
      const gate = yield* Deferred.make<void>();
      const started = yield* Deferred.make<void>();
      let runs = 0;
      const probe = Effect.sync(() => {
        runs += 1;
      }).pipe(
        Effect.andThen(Deferred.succeed(started, undefined)),
        Effect.andThen(Deferred.await(gate)),
        Effect.as("3.12"),
      );
      const first = yield* cache.get("/py", probe).pipe(Effect.forkChild);
      yield* Deferred.await(started);
      const second = yield* cache.get("/py", probe).pipe(Effect.forkChild);
      yield* Deferred.succeed(gate, undefined);
      expect([yield* Fiber.join(first), yield* Fiber.join(second)]).toEqual(["3.12", "3.12"]);
      expect(runs).toBe(1);
    }),
  );

  it.effect("keeps a failure with its reason briefly, then probes again", () =>
    Effect.gen(function* () {
      const cache = makeRuntimeProbeCache<string>({ failureTtlMs: 5_000 });
      let runs = 0;
      const probe = Effect.suspend(() => {
        runs += 1;
        return Effect.fail(failure);
      });
      expect((yield* Effect.flip(cache.get("/py", probe))).message).toBe("python exited 1");
      expect((yield* Effect.flip(cache.get("/py", probe))).message).toBe("python exited 1");
      expect(runs).toBe(1);
      yield* TestClock.adjust("6 seconds");
      yield* Effect.flip(cache.get("/py", probe));
      expect(runs).toBe(2);
    }),
  );

  it.effect("serves a success from the cache until it expires or is cleared", () =>
    Effect.gen(function* () {
      const cache = makeRuntimeProbeCache<number>({ successTtlMs: 30_000 });
      let runs = 0;
      const probe = Effect.sync(() => ++runs);
      yield* cache.get("/py", probe);
      yield* cache.get("/py", probe);
      expect(runs).toBe(1);
      cache.clear();
      yield* cache.get("/py", probe);
      expect(runs).toBe(2);
    }),
  );
});
