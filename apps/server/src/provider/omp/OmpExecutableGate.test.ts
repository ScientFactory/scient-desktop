// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";

import {
  canonicalOmpExecutablePath,
  makeOmpExecutableGate,
  OMP_ACTIVATION_DRAIN_TIMEOUT,
  OMP_PROCESS_WAIT_TIMEOUT,
} from "./OmpExecutableGate.ts";

const IDENTITY = "/usr/local/bin/omp";

/** Acquire into a scope the test closes explicitly. */
const hold = <A, E>(acquire: Effect.Effect<A, E, Scope.Scope>) =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const value = yield* acquire.pipe(Effect.provideService(Scope.Scope, scope));
    return { value, release: Scope.close(scope, Exit.void) };
  });

describe("OmpExecutableGate", () => {
  it.effect("makes a new process wait for an activation, then fails with a typed error", () =>
    Effect.gen(function* () {
      const gate = yield* makeOmpExecutableGate();
      const activation = yield* hold(gate.acquireActivation(IDENTITY));
      const waiting = yield* Effect.scoped(gate.acquireProcess(IDENTITY, { kind: "session" })).pipe(
        Effect.flip,
        Effect.forkChild,
      );
      yield* TestClock.adjust(OMP_PROCESS_WAIT_TIMEOUT);
      const error = yield* Fiber.join(waiting);
      expect(error._tag).toBe("OmpExecutableBusyError");
      expect(error.message).toContain("Oh My Pi is being updated");
      yield* activation.release;
      // Once the activation is released, the same identity leases immediately.
      yield* Effect.scoped(gate.acquireProcess(IDENTITY, { kind: "session" }));
    }),
  );

  it.effect("admits a waiting process as soon as the activation commits", () =>
    Effect.gen(function* () {
      const gate = yield* makeOmpExecutableGate();
      const activation = yield* hold(gate.acquireActivation(IDENTITY));
      const leased = yield* Deferred.make<void>();
      const waiting = yield* Effect.scoped(
        gate
          .acquireProcess(IDENTITY, { kind: "one-shot" })
          .pipe(Effect.andThen(Deferred.succeed(leased, undefined))),
      ).pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      expect(yield* Deferred.isDone(leased)).toBe(false);
      yield* activation.release;
      yield* Fiber.join(waiting);
      expect(yield* Deferred.isDone(leased)).toBe(true);
    }),
  );

  it.effect("waits for one-shot leases to drain and blocks new leases meanwhile", () =>
    Effect.gen(function* () {
      const gate = yield* makeOmpExecutableGate();
      const oneShot = yield* hold(gate.acquireProcess(IDENTITY, { kind: "one-shot" }));
      const activated = yield* Deferred.make<void>();
      const activating = yield* hold(
        gate
          .acquireActivation(IDENTITY)
          .pipe(Effect.tap(() => Deferred.succeed(activated, undefined))),
      ).pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      expect(yield* Deferred.isDone(activated)).toBe(false);

      // A process that arrives while the activation drains waits behind it.
      const newcomer = yield* Deferred.make<void>();
      const late = yield* Effect.scoped(
        gate
          .acquireProcess(IDENTITY, { kind: "one-shot" })
          .pipe(Effect.andThen(Deferred.succeed(newcomer, undefined))),
      ).pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      expect(yield* Deferred.isDone(newcomer)).toBe(false);

      yield* oneShot.release;
      const activation = yield* Fiber.join(activating);
      expect(yield* Deferred.isDone(activated)).toBe(true);
      expect(yield* Deferred.isDone(newcomer)).toBe(false);
      yield* activation.release;
      yield* Fiber.join(late);
      expect(yield* Deferred.isDone(newcomer)).toBe(true);
    }),
  );

  it.effect("fails an activation whose one-shot work does not drain, and unblocks new work", () =>
    Effect.gen(function* () {
      const gate = yield* makeOmpExecutableGate();
      const oneShot = yield* hold(gate.acquireProcess(IDENTITY, { kind: "one-shot" }));
      const activating = yield* Effect.scoped(gate.acquireActivation(IDENTITY)).pipe(
        Effect.flip,
        Effect.forkChild,
      );
      yield* TestClock.adjust(OMP_ACTIVATION_DRAIN_TIMEOUT);
      const error = yield* Fiber.join(activating);
      expect(error._tag).toBe("OmpExecutableBusyError");
      // The failed activation released its hold without waiting for its scope.
      yield* Effect.scoped(gate.acquireProcess(IDENTITY, { kind: "one-shot" }));
      yield* oneShot.release;
    }),
  );

  it.effect("refuses an activation while a conversation still holds the executable", () =>
    Effect.gen(function* () {
      const gate = yield* makeOmpExecutableGate();
      const session = yield* hold(gate.acquireProcess(IDENTITY, { kind: "session" }));
      const error = yield* Effect.scoped(gate.acquireActivation(IDENTITY)).pipe(Effect.flip);
      expect(error._tag).toBe("OmpExecutableBusyError");
      expect(error.message).toContain("conversation");
      yield* session.release;
      yield* Effect.scoped(gate.acquireActivation(IDENTITY));
    }),
  );

  it.effect("lets the activation's own qualification process through", () =>
    Effect.gen(function* () {
      const gate = yield* makeOmpExecutableGate();
      yield* Effect.scoped(
        Effect.gen(function* () {
          const activation = yield* gate.acquireActivation(IDENTITY);
          yield* Effect.scoped(gate.acquireProcess(IDENTITY, { kind: "one-shot", activation }));
        }),
      );
    }),
  );

  it.effect("reserves atomically under concurrency", () =>
    Effect.gen(function* () {
      const gate = yield* makeOmpExecutableGate();
      // Exactly one of many concurrent activations wins while it is held.
      const latch = yield* Deferred.make<void>();
      const refused = yield* Ref.make(0);
      const contenders = yield* Effect.forEach(Array.from({ length: 8 }), () =>
        Effect.scoped(
          gate.acquireActivation(IDENTITY).pipe(Effect.andThen(Deferred.await(latch))),
        ).pipe(
          Effect.tapError(() => Ref.update(refused, (count) => count + 1)),
          Effect.exit,
          Effect.forkChild,
        ),
      );
      for (let turn = 0; turn < 1000 && (yield* Ref.get(refused)) < 7; turn += 1) {
        yield* Effect.yieldNow;
      }
      yield* Deferred.succeed(latch, undefined);
      const activations = yield* Fiber.joinAll(contenders);
      expect(activations.filter(Exit.isSuccess)).toHaveLength(1);
      // An activation and many leases never overlap.
      let activeLeases = 0;
      let overlap = false;
      let activationHeld = false;
      const lease = Effect.scoped(
        Effect.gen(function* () {
          yield* gate.acquireProcess(IDENTITY, { kind: "one-shot" });
          activeLeases += 1;
          if (activationHeld) overlap = true;
          yield* Effect.yieldNow;
          activeLeases -= 1;
        }),
      );
      const activate = Effect.scoped(
        Effect.gen(function* () {
          yield* gate.acquireActivation(IDENTITY);
          activationHeld = true;
          if (activeLeases > 0) overlap = true;
          yield* Effect.yieldNow;
          activationHeld = false;
        }),
      ).pipe(Effect.ignore);
      yield* Effect.all([...Array.from({ length: 32 }, () => lease), activate, activate], {
        concurrency: "unbounded",
      });
      expect(overlap).toBe(false);
    }),
  );

  it.effect("keeps separate gates and separate identities independent", () =>
    Effect.gen(function* () {
      const first = yield* makeOmpExecutableGate();
      const second = yield* makeOmpExecutableGate();
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* first.acquireActivation(IDENTITY);
          yield* second.acquireProcess(IDENTITY, { kind: "session" });
          yield* first.acquireProcess("/opt/company/testing/omp", { kind: "session" });
        }),
      );
    }),
  );

  it.effect("memoizes only a verified version", () =>
    Effect.gen(function* () {
      const gate = yield* makeOmpExecutableGate();
      let probes = 0;
      const failing = Effect.sync(() => (probes += 1)).pipe(Effect.andThen(Effect.fail("bad")));
      expect(yield* gate.verifiedVersion("key", failing).pipe(Effect.flip)).toBe("bad");
      expect(yield* gate.verifiedVersion("key", failing).pipe(Effect.flip)).toBe("bad");
      expect(probes).toBe(2);
      const ok = Effect.sync(() => {
        probes += 1;
        return "18.3.1";
      });
      expect(yield* gate.verifiedVersion("key", ok)).toBe("18.3.1");
      expect(yield* gate.verifiedVersion("key", ok)).toBe("18.3.1");
      expect(probes).toBe(3);
    }),
  );
});

describe("canonicalOmpExecutablePath", () => {
  it.effect("resolves symlinks and missing leaves through their nearest existing parent", () =>
    Effect.gen(function* () {
      const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "scient-omp-identity-"));
      try {
        const real = NodePath.join(root, "omp-real");
        NodeFS.writeFileSync(real, "binary");
        NodeFS.symlinkSync(real, NodePath.join(root, "omp"));
        const canonicalRoot = NodeFS.realpathSync(root);
        expect(yield* canonicalOmpExecutablePath(NodePath.join(root, "omp"))).toBe(
          NodePath.join(canonicalRoot, "omp-real"),
        );
        // A managed runtime that is not installed yet keeps a stable identity.
        expect(
          yield* canonicalOmpExecutablePath(NodePath.join(root, "versions", "18.3.1", "omp")),
        ).toBe(NodePath.join(canonicalRoot, "versions", "18.3.1", "omp"));
      } finally {
        NodeFS.rmSync(root, { recursive: true, force: true });
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
