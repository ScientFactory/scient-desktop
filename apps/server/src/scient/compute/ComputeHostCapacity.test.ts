import { describe, expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ComputeHostCapacity, layer } from "./ComputeHostCapacity.ts";

describe("compute host capacity", () => {
  it.effect("atomically bounds concurrent admissions and releases each lease once", () =>
    Effect.gen(function* () {
      const capacity = yield* ComputeHostCapacity;
      const results = yield* Effect.all(
        Array.from({ length: 40 }, () => capacity.acquire(4).pipe(Effect.result)),
        { concurrency: "unbounded" },
      );
      const admitted = results.filter((result) => result._tag === "Success");
      expect(admitted).toHaveLength(4);
      for (const result of admitted) {
        yield* result.success;
        yield* result.success;
      }
      const release = yield* capacity.acquire(1);
      const rejected = yield* capacity.acquire(1).pipe(Effect.result);
      expect(rejected._tag).toBe("Failure");
      if (rejected._tag === "Failure") expect(rejected.failure.reason).toBe("capacity-reached");
      yield* release;
    }).pipe(Effect.provide(layer)),
  );

  it.effect("shares one counter across independently composed transport services", () => {
    class Sessions extends Context.Service<Sessions, ComputeHostCapacity["Service"]>()(
      "t3/scient/compute/ComputeHostCapacity.test/Sessions",
    ) {}
    class Batch extends Context.Service<Batch, ComputeHostCapacity["Service"]>()(
      "t3/scient/compute/ComputeHostCapacity.test/Batch",
    ) {}
    const sessions = Layer.effect(Sessions, ComputeHostCapacity).pipe(Layer.provide(layer));
    const batch = Layer.effect(Batch, ComputeHostCapacity).pipe(Layer.provide(layer));
    return Effect.gen(function* () {
      const sessionCapacity = yield* Sessions;
      const batchCapacity = yield* Batch;
      const release = yield* sessionCapacity.acquire(1);
      const rejected = yield* batchCapacity.acquire(1).pipe(Effect.result);
      expect(rejected._tag).toBe("Failure");
      if (rejected._tag === "Failure") expect(rejected.failure.reason).toBe("capacity-reached");
      yield* release;
      yield* yield* batchCapacity.acquire(1);
    }).pipe(Effect.provide(Layer.merge(sessions, batch)));
  });
});
