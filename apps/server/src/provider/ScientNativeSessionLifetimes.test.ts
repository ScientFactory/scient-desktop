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
import * as Queue from "effect/Queue";
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

const runningItem = {
  type: "turn_item.updated",
  turnItem: { id: "command", type: "command_execution", status: "running" },
};

const openParkedSession = (
  instanceScope: Scope.Scope,
  native: {
    readonly events?: Stream.Stream<never>;
    readonly onOpen?: Effect.Effect<void, never, Scope.Scope>;
  } = {},
) => {
  const driver = ProviderDriverKind.make("claudeAgent");
  const instanceId = ProviderInstanceId.make("lifetime-parked");
  const providerSessionId = ProviderSessionId.make("lifetime-parked-session");
  const runtime = {
    instanceId,
    driver,
    providerSessionId,
    providerSession: { status: "ready" },
    events: native.events ?? Stream.concat(Stream.make(runningItem), Stream.never),
    textSnapshots: { events: Stream.concat(Stream.make(runningItem), Stream.never) },
  } as unknown as ProviderAdapterV2SessionRuntime;
  return ownNativeSessionLifetimes(
    {
      instanceId,
      driverKind: driver,
      orchestrationAdapter: {
        openSession: () => (native.onOpen ?? Effect.void).pipe(Effect.as(runtime)),
      },
      textGeneration: {},
    } as unknown as ProviderInstance,
    instanceScope,
  ).orchestrationAdapter.openSession({
    threadId: ThreadId.make("lifetime-parked-thread"),
    providerSessionId,
    modelSelection: { instanceId, model: "test/selected" },
    runtimePolicy: {
      cwd: process.cwd(),
      runtimeMode: "full-access" as const,
      interactionMode: "default" as const,
    },
  });
};

const collectAfterFirstEvent = <A, E>(events: Stream.Stream<A, E>) =>
  Effect.gen(function* () {
    const first = yield* Deferred.make<void>();
    const fiber = yield* Effect.forkChild(
      Stream.runCollect(events.pipe(Stream.tap(() => Deferred.succeed(first, undefined)))),
    );
    yield* Deferred.await(first);
    return fiber;
  });

// regression: a settings change closed the session, but its streams stayed parked, so the run and
// session stayed live forever and neither an answer nor Stop could settle them.
it.effect("closes open items and reports a stopped session when its instance retires", () =>
  Effect.gen(function* () {
    const instanceScope = yield* Scope.make();
    const session = yield* openParkedSession(instanceScope);
    const events = yield* collectAfterFirstEvent(session.events);
    const textEvents = yield* collectAfterFirstEvent(session.textSnapshots!.events);

    yield* Scope.close(instanceScope, Exit.void);

    for (const collected of [yield* Fiber.join(events), yield* Fiber.join(textEvents)]) {
      const [, closed, stopped] = collected;
      assert.lengthOf(collected, 3);
      assert.equal(closed?.type, "turn_item.updated");
      if (closed?.type === "turn_item.updated") assert.equal(closed.turnItem.status, "interrupted");
      assert.equal(stopped?.type, "provider_session.updated");
      if (stopped?.type === "provider_session.updated")
        assert.equal(stopped.providerSession.status, "stopped");
    }
  }).pipe(Effect.scoped),
);

// regression: a driver's own cleanup ended the stream first, so the stop went unreported and the
// manager took its failure path, which puts an error banner on idle threads.
it.effect("reports retirement when native cleanup shuts the stream down first", () =>
  Effect.gen(function* () {
    const instanceScope = yield* Scope.make();
    const nativeEvents = yield* Queue.unbounded<never>();
    const session = yield* openParkedSession(instanceScope, {
      events: Stream.fromQueue(nativeEvents),
      onOpen: Effect.addFinalizer(() => Queue.shutdown(nativeEvents)),
    });
    const events = yield* Effect.forkChild(Stream.runCollect(session.events));
    yield* Effect.yieldNow;

    yield* Scope.close(instanceScope, Exit.void);

    const collected = yield* Fiber.join(events);
    assert.equal(collected.at(-1)?.type, "provider_session.updated");
  }).pipe(Effect.scoped),
);

it.effect("leaves the streams alone when only the caller closes the session", () =>
  Effect.gen(function* () {
    const instanceScope = yield* Scope.make();
    const callerScope = yield* Scope.make();
    const session = yield* openParkedSession(instanceScope).pipe(
      Effect.provideService(Scope.Scope, callerScope),
    );
    const events = yield* collectAfterFirstEvent(session.events);

    yield* Scope.close(callerScope, Exit.void);
    yield* Effect.yieldNow;

    assert.isUndefined(events.pollUnsafe());
    yield* Fiber.interrupt(events);
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
