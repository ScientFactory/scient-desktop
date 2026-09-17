import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";

import { OwnedLocalEndpointRegistry, layer, make } from "./OwnedLocalEndpointRegistry.ts";

describe("OwnedLocalEndpointRegistry", () => {
  it.effect("reserves unique ports and protects them until an idempotent release", () =>
    Effect.gen(function* () {
      const registry = yield* OwnedLocalEndpointRegistry;
      const before = yield* registry.snapshot;
      const lease = yield* registry.reserveProtectedLoopbackTcpPorts({
        owner: "compute/session-1",
        purpose: "jupyter-kernel-channels",
        count: 5,
      });

      expect(lease.ports).toHaveLength(5);
      expect(new Set(lease.ports).size).toBe(5);
      expect(lease.ports.every((port) => Number.isInteger(port) && port > 0)).toBe(true);
      const reserved = yield* registry.snapshot;
      expect(reserved.revision).toBe(before.revision + 1);
      expect(lease.ports.every((port) => reserved.protectedLoopbackTcpPorts.has(port))).toBe(true);

      yield* lease.handoff;
      yield* lease.handoff;
      const handedOff = yield* registry.snapshot;
      expect(lease.ports.every((port) => handedOff.protectedLoopbackTcpPorts.has(port))).toBe(true);

      yield* lease.release;
      yield* lease.release;
      const released = yield* registry.snapshot;
      expect(released.revision).toBe(reserved.revision + 1);
      expect(lease.ports.some((port) => released.protectedLoopbackTcpPorts.has(port))).toBe(false);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("rejects nonsensical reservation counts", () =>
    Effect.gen(function* () {
      const registry = yield* OwnedLocalEndpointRegistry;
      const failure = yield* registry
        .reserveProtectedLoopbackTcpPorts({
          owner: "compute/session-2",
          purpose: "jupyter-kernel-channels",
          count: 0,
        })
        .pipe(Effect.flip);
      expect(failure.operation).toBe("reserve");
    }).pipe(Effect.provide(layer)),
  );

  it.effect("drains an admitted probe before registration and blocks probes after handoff", () =>
    Effect.gen(function* () {
      const reservationsOpened = yield* Deferred.make<ReadonlyArray<number>>();
      const allowRegistration = yield* Deferred.make<void>();
      const probeEntered = yield* Deferred.make<void>();
      const allowProbeToFinish = yield* Deferred.make<void>();
      const registry = yield* make({
        afterReservationsOpened: (ports) =>
          Deferred.succeed(reservationsOpened, ports).pipe(
            Effect.andThen(Deferred.await(allowRegistration)),
          ),
      });
      const reserving = yield* registry
        .reserveProtectedLoopbackTcpPorts({
          owner: "compute/session-race",
          purpose: "jupyter-kernel-channels",
          count: 1,
        })
        .pipe(Effect.forkChild);
      const [port] = yield* Deferred.await(reservationsOpened);
      if (port === undefined) return yield* Effect.die("Expected one reserved port.");

      let probeRuns = 0;
      const probing = yield* registry
        .runLoopbackTcpProbe(
          port,
          Deferred.succeed(probeEntered, undefined).pipe(
            Effect.andThen(Deferred.await(allowProbeToFinish)),
            Effect.andThen(
              Effect.sync(() => {
                probeRuns += 1;
              }),
            ),
          ),
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(probeEntered);
      yield* Deferred.succeed(allowRegistration, undefined);
      yield* Effect.yieldNow;
      expect(reserving.pollUnsafe()).toBeUndefined();

      yield* Deferred.succeed(allowProbeToFinish, undefined);
      expect(yield* Fiber.join(probing)).toEqual({ _tag: "probed", value: undefined });
      const lease = yield* Fiber.join(reserving);
      yield* lease.handoff;
      expect(
        yield* registry.runLoopbackTcpProbe(
          port,
          Effect.sync(() => {
            probeRuns += 1;
          }),
        ),
      ).toEqual({ _tag: "protected" });
      expect(probeRuns).toBe(1);
      yield* lease.release;
    }),
  );
});
