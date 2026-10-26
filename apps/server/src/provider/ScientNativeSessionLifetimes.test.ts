import { assert, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ThreadId,
} from "@t3tools/contracts";
import {
  ProviderAdapterProtocolError,
  type ProviderAdapterV2SessionRuntime,
} from "@t3tools/provider-core/server/ProviderAdapter";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { ownNativeSessionLifetimes } from "./ScientNativeSessionLifetimes.ts";

const unused = () => Effect.die("Not used by this test.");

// regression: child Stop escaped the session-lifetime guard during instance teardown.
it.effect("forwards child Stop while the session lives and refuses it once retired", () =>
  Effect.gen(function* () {
    const instanceScope = yield* Scope.make();
    const driver = ProviderDriverKind.make("omp");
    const instanceId = ProviderInstanceId.make("lifetime-child-stop");
    const providerSessionId = ProviderSessionId.make("lifetime-child-stop-session");
    const outcome = {
      status: "cancelled" as const,
      completedAt: DateTime.makeUnsafe(2),
      result: null,
    };
    let calls = 0;
    const runtime: ProviderAdapterV2SessionRuntime = {
      instanceId,
      driver,
      providerSessionId,
      providerSession: {} as ProviderAdapterV2SessionRuntime["providerSession"],
      events: Stream.empty,
      ensureThread: unused,
      resumeThread: unused,
      startTurn: unused,
      steerTurn: unused,
      interruptTurn: unused,
      respondToRuntimeRequest: unused,
      readThreadSnapshot: unused,
      rollbackThread: unused,
      forkThread: unused,
      stopSubagent() {
        // Native adapters read their own state through the receiver.
        assert.strictEqual(this, runtime);
        calls++;
        return Effect.succeed(outcome);
      },
    };
    const session = yield* ownNativeSessionLifetimes(
      {
        instanceId,
        driverKind: driver,
        continuationIdentity: { driverKind: driver, continuationKey: "lifetime-child-stop:test" },
        displayName: undefined,
        enabled: true,
        snapshot: {} as ProviderInstance["snapshot"],
        orchestrationAdapter: {
          instanceId,
          driver,
          getCapabilities: unused,
          planSelectionTransition: unused,
          openSession: () => Effect.succeed(runtime),
        } as unknown as ProviderInstance["orchestrationAdapter"],
        textGeneration: {} as ProviderInstance["textGeneration"],
      },
      instanceScope,
    ).orchestrationAdapter.openSession({
      threadId: ThreadId.make("lifetime-child-stop-thread"),
      providerSessionId,
      modelSelection: { instanceId, model: "test/selected" },
      runtimePolicy: {
        cwd: process.cwd(),
        runtimeMode: "full-access" as const,
        interactionMode: "default" as const,
      },
    });
    const input = {
      providerThread: {} as Parameters<
        NonNullable<ProviderAdapterV2SessionRuntime["stopSubagent"]>
      >[0]["providerThread"],
      nativeTaskId: "child",
      requestedAt: DateTime.makeUnsafe(1),
    };
    assert.strictEqual(yield* session.stopSubagent!(input), outcome);
    // Created while open, run after retirement: the guard decides at execution.
    const stale = session.stopSubagent!(input);
    yield* Scope.close(instanceScope, Exit.void);
    const refused = yield* Effect.result(stale);
    assert.equal(refused._tag, "Failure");
    if (refused._tag === "Failure")
      assert.instanceOf(refused.failure, ProviderAdapterProtocolError);
    assert.equal(calls, 1);
  }).pipe(Effect.scoped),
);

it.effect("retires background generation with its instance and awaits native cleanup", () =>
  Effect.gen(function* () {
    const instanceScope = yield* Scope.make();
    const entered = yield* Deferred.make<void>();
    const stopped = yield* Deferred.make<void>();
    const driverKind = ProviderDriverKind.make("muse");
    const instance = ownNativeSessionLifetimes(
      {
        instanceId: ProviderInstanceId.make("retired-generation"),
        driverKind,
        continuationIdentity: { driverKind, continuationKey: "retired-generation:test" },
        displayName: undefined,
        enabled: true,
        snapshot: {} as ProviderInstance["snapshot"],
        orchestrationAdapter: {} as ProviderInstance["orchestrationAdapter"],
        textGeneration: {
          generateCommitMessage: unused,
          generatePrContent: unused,
          generateThreadTitle: unused,
          generateReviewGuide: unused,
          generateBranchName: () =>
            Deferred.succeed(entered, undefined).pipe(
              Effect.andThen(Effect.never),
              Effect.ensuring(Deferred.succeed(stopped, undefined)),
            ),
        },
      },
      instanceScope,
    );
    const input = { cwd: process.cwd(), message: "Fixture", modelSelection: {} as never };
    const running = yield* instance.textGeneration
      .generateBranchName(input)
      .pipe(Effect.forkScoped);
    yield* Deferred.await(entered);
    yield* Scope.close(instanceScope, Exit.void);
    assert.isTrue(Deferred.isDoneUnsafe(stopped));
    assert.isTrue(Exit.isFailure(yield* Fiber.await(running)));
    assert.strictEqual(
      (yield* instance.textGeneration.generateBranchName(input).pipe(Effect.result))._tag,
      "Failure",
    );
  }).pipe(Effect.scoped),
);
