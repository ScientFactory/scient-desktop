import { describe, expect, it } from "@effect/vitest";
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  ComputeHostCapacity,
  DEFAULT_COMPUTE_HOST_CAPACITY,
  layer,
} from "./ComputeHostCapacity.ts";

describe("compute host capacity", () => {
  for (const limit of [1, 2, 4]) {
    it.effect(`bounds concurrent admissions to ${limit} and recovers without double release`, () =>
      Effect.gen(function* () {
        const capacity = yield* ComputeHostCapacity;
        const results = yield* Effect.all(
          Array.from({ length: 40 }, () => capacity.acquire().pipe(Effect.result)),
          { concurrency: "unbounded" },
        );
        const admitted = results.filter((result) => result._tag === "Success");
        expect(admitted).toHaveLength(limit);
        for (const result of admitted) {
          yield* result.success;
          yield* result.success;
        }
        const replacements = yield* Effect.all(
          Array.from({ length: limit }, () => capacity.acquire()),
          { concurrency: "unbounded" },
        );
        const rejected = yield* capacity.acquire().pipe(Effect.result);
        expect(rejected._tag).toBe("Failure");
        if (rejected._tag === "Failure") expect(rejected.failure.reason).toBe("capacity-reached");
        yield* Effect.all(replacements);
      }).pipe(
        Effect.provide(layer),
        Effect.provideService(HostProcessEnvironment, {
          SCIENT_COMPUTE_MAX_LIVE_SESSIONS: String(limit),
        }),
      ),
    );
  }

  it.effect(
    "shares the configured ceiling across independently composed session and batch services",
    () => {
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
        const release = yield* sessionCapacity.acquire();
        const rejected = yield* batchCapacity.acquire().pipe(Effect.result);
        expect(rejected._tag).toBe("Failure");
        yield* release;
        const releaseBatch = yield* batchCapacity.acquire();
        expect((yield* sessionCapacity.acquire().pipe(Effect.result))._tag).toBe("Failure");
        yield* releaseBatch;
      }).pipe(
        Effect.provide(Layer.merge(sessions, batch)),
        Effect.provideService(HostProcessEnvironment, { SCIENT_COMPUTE_MAX_LIVE_SESSIONS: "1" }),
      );
    },
  );

  for (const value of [
    undefined,
    "",
    "0",
    "-1",
    "1.5",
    "Infinity",
    "invalid",
    "9007199254740992",
  ]) {
    it.effect(`uses the default budget for invalid configuration ${String(value)}`, () =>
      Effect.gen(function* () {
        const capacity = yield* ComputeHostCapacity;
        const releases = yield* Effect.all(
          Array.from({ length: DEFAULT_COMPUTE_HOST_CAPACITY }, () => capacity.acquire()),
        );
        expect((yield* capacity.acquire().pipe(Effect.result))._tag).toBe("Failure");
        yield* Effect.all(releases);
      }).pipe(
        Effect.provide(layer),
        Effect.provideService(HostProcessEnvironment, { SCIENT_COMPUTE_MAX_LIVE_SESSIONS: value }),
      ),
    );
  }
});
