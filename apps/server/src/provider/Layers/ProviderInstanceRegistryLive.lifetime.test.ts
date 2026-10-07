import { assert, it } from "@effect/vitest";
import { RuntimeRequestId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";

import {
  configMap,
  first,
  second,
  TestLayer,
  harness,
} from "./ProviderInstanceRegistryNativeLifetime.test-harness.ts";

it.layer(TestLayer)("ProviderInstanceRegistry native lifetimes", (it) => {
  it.effect("preserves native sessions on a structurally unchanged settings emission", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      const instance = yield* h.registry.getInstance(first);
      const runtime = yield* h.open(first);
      yield* h.mutator.reconcile(configMap());
      assert.equal(yield* h.registry.getInstance(first), instance);
      assert.equal(runtime.providerSession.status, "ready");
      assert.deepEqual(h.log, [`create:${first}:1`, `create:${second}:1`, `open:${first}:1`]);
    }),
  );

  it.effect("retires the removed instance's native session and rejects stale transport calls", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      const removed = yield* h.registry.getInstance(first);
      if (!removed) return yield* Effect.die("Missing native test instance");
      const runtime = yield* h.open(first);
      const bystander = yield* h.open(second);
      yield* h.mutator.reconcile({ [second]: configMap()[second]! });
      assert.equal(runtime.providerSession.status, "stopped");
      assert.equal(bystander.providerSession.status, "ready");
      assert.equal(h.log.filter((entry) => entry === `close:${first}:1`).length, 1);
      assert.isFalse(h.log.includes(`close:${second}:1`));
      const stale = yield* Effect.result(
        removed.orchestrationAdapter
          .openSession(h.input(first, 2))
          .pipe(Effect.provideService(Scope.Scope, h.callerScope)),
      );
      assert.equal(stale._tag, "Failure");
      const reply = yield* Effect.result(
        runtime.respondToRuntimeRequest({ requestId: RuntimeRequestId.make("stale-request") }),
      );
      assert.equal(reply._tag, "Failure");
      assert.isFalse(h.log.includes(`respond:${first}`));
      yield* Scope.close(h.callerScope, Exit.void);
      assert.equal(h.log.filter((entry) => entry === `close:${first}:1`).length, 1);
    }),
  );

  it.effect("closes changed native sessions before constructing their replacement", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      const runtime = yield* h.open(first);
      yield* h.open(second);
      yield* h.mutator.reconcile(configMap(2));
      assert.equal(runtime.providerSession.status, "stopped");
      assert.isTrue(h.log.indexOf(`close:${first}:1`) < h.log.indexOf(`create:${first}:2`));
      assert.isFalse(h.log.includes(`close:${second}:1`));
      const replacement = yield* h.open(first, 2);
      assert.equal(replacement.providerSession.status, "ready");
      assert.isTrue(h.log.includes(`open:${first}:2`));
    }),
  );

  it.effect(
    "caller shutdown closes the native child without retiring its configured instance",
    () =>
      Effect.gen(function* () {
        const h = yield* harness();
        const runtime = yield* h.open(first);
        yield* Scope.close(h.callerScope, Exit.void);
        assert.equal(runtime.providerSession.status, "stopped");
        const instance = yield* h.registry.getInstance(first);
        if (!instance) return yield* Effect.die("Missing native test instance");
        const fresh = yield* instance.orchestrationAdapter.openSession(h.input(first, 2));
        assert.equal(fresh.providerSession.status, "ready");
      }),
  );

  it.effect(
    "removal interrupts an in-flight native open and finalizes its acquired transport",
    () =>
      Effect.gen(function* () {
        const openingStarted = yield* Deferred.make<void>();
        const openingGate = yield* Deferred.make<void>();
        const h = yield* harness({ openingStarted, openingGate });
        const opening = yield* h.open(first).pipe(Effect.forkChild);
        yield* Deferred.await(openingStarted);
        yield* h.mutator.reconcile({ [second]: configMap()[second]! });
        const outcome = yield* Fiber.await(opening);
        assert.isTrue(Exit.isFailure(outcome));
        assert.equal(h.log.filter((entry) => entry === `close:${first}:1`).length, 1);
        assert.equal(h.log.filter((entry) => entry === `open:${first}:1`).length, 1);
        yield* Deferred.succeed(openingGate, undefined);
      }),
  );

  it.effect("a failed native open immediately cleans its child lifetime", () =>
    Effect.gen(function* () {
      const h = yield* harness({ failOpen: true });
      assert.equal((yield* Effect.result(h.open(first)))._tag, "Failure");
      assert.equal(h.log.filter((entry) => entry === `close:${first}:1`).length, 1);
      const instance = yield* h.registry.getInstance(first);
      assert.isDefined(instance);
      yield* Scope.close(h.callerScope, Exit.void);
      assert.equal(h.log.filter((entry) => entry === `close:${first}:1`).length, 1);
    }),
  );
});
