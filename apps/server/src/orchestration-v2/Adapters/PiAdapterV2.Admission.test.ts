import { assert, describe, it } from "@effect/vitest";
import { MessageId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Duration from "effect/Duration";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as TestClock from "effect/testing/TestClock";
import { ProviderContinuationRequests } from "../ProviderContinuationRequests.ts";
import { piContinuationRequestsIfProvided } from "./PiAdapterV2.ts";
import { makePiRpcConnection } from "./PiRpc.ts";
import {
  testLayer,
  THREAD_ID,
  SESSION_ID,
  runtimePolicy,
  modelSelection,
  makeFakePi,
  openRuntime,
  startTurn,
} from "./PiAdapterV2.fixture.ts";

describe("Pi captured work admission fences", () => {
  it.effect("propagates permanent native owner refusal without a producer-local retry", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const offered =
        yield* Queue.unbounded<
          import("../ProviderContinuationRequests.ts").ProviderContinuationRequest
        >();
      const { runtime } = yield* openRuntime(
        fake,
        "default",
        THREAD_ID,
        SESSION_ID,
        undefined,
        undefined,
        {
          offer: (packet) => Queue.offer(offered, packet).pipe(Effect.asVoid),
        },
      );
      yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      fake.queueState({ model: { provider: "fixture", id: "synthetic" } });
      yield* fake.emit({ type: "agent_start" });
      const packet = yield* Queue.take(offered);
      const refusal = {
        _tag: "OrchestratorDispatchError",
        cause: "Provider-initiated work no longer owns an idle native thread.",
      };
      assert.strictEqual(
        yield* packet.dispatchIfCurrent!(Effect.fail(refusal)).pipe(Effect.flip),
        refusal,
      );
      yield* TestClock.adjust(Duration.millis(500));
      assert.equal(yield* Queue.size(offered), 0);
      assert.isTrue(yield* runtime.hasPendingBackgroundWork!);
      yield* packet.clearIfCurrent!();
      assert.isFalse(yield* runtime.hasPendingBackgroundWork!);
      assert.isTrue(
        Option.isNone(yield* packet.dispatchIfCurrent!(Effect.die("stale dispatch ran"))),
      );
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("checks exact Stop after selection and before native prompt wire", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime, observed } = yield* openRuntime(fake);
      const thread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      let checks = 0;
      const cancelled = yield* startTurn(
        runtime,
        thread,
        "default",
        [],
        "Cancelled before wire",
        undefined,
        1,
        THREAD_ID,
        {
          shouldStartProviderTurn: () =>
            Effect.sync(() => {
              checks++;
              return false;
            }),
        },
      ).pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(cancelled));
      if (Exit.isFailure(cancelled)) assert.isTrue(Cause.hasInterruptsOnly(cancelled.cause));
      assert.equal(checks, 1);
      assert.lengthOf(
        fake.allRequests().filter((r) => r.type === "prompt"),
        0,
      );
      assert.lengthOf(
        observed.filter((e) => e.type === "provider_turn.updated" || e.type === "turn.terminal"),
        0,
      );
      yield* startTurn(runtime, thread, "default", [], "Next owned turn", undefined, 2);
      yield* fake.takeRequest("prompt");
      assert.lengthOf(
        fake.allRequests().filter((r) => r.type === "prompt"),
        1,
      );
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect.each(
    [false, true].map((stopped) => ({
      caseTitle: `adopts only the exact captured native generation and fences Stop (${stopped})`,
      stopped,
    })),
  )("$caseTitle", ({ stopped }) =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const offered =
        yield* Queue.unbounded<
          import("../ProviderContinuationRequests.ts").ProviderContinuationRequest
        >();
      const { runtime, observed, takeEvent } = yield* openRuntime(
        fake,
        "default",
        THREAD_ID,
        SESSION_ID,
        undefined,
        undefined,
        { offer: (r) => Queue.offer(offered, r).pipe(Effect.asVoid) },
      );
      const thread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      fake.queueState({ model: { provider: "fixture", id: "synthetic" } });
      yield* fake.emit({ type: "agent_start" });
      const packet = yield* Queue.take(offered);
      const captured = packet.initiated!;
      assert.equal(runtime.providerSession.model, captured.modelSelection.model);
      assert.isTrue(yield* runtime.hasPendingBackgroundWork!);
      const notification = {
        source: {
          kind: "provider_work" as const,
          workId: captured.workId,
          providerSessionId: captured.providerSessionId,
          providerThreadId: packet.providerThreadId,
          modelSelection: captured.modelSelection,
          runtimePolicy: captured.runtimePolicy,
        },
        outcome: "updated" as const,
        summary: "Pi native work",
      };
      const overrides = {
        modelSelection: captured.modelSelection,
        runtimePolicy: captured.runtimePolicy,
        message: {
          messageId: MessageId.make("native-generation"),
          text: "Adopt existing native work",
          attachments: [],
          createdBy: "agent" as const,
          creationSource: "provider" as const,
          notification,
        },
      };
      const mismatch = yield* startTurn(
        runtime,
        thread,
        "default",
        [],
        "",
        undefined,
        1,
        THREAD_ID,
        { ...overrides, runtimePolicy: { ...captured.runtimePolicy, cwd: "/another-workspace" } },
      ).pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(mismatch));
      assert.isTrue(yield* runtime.hasPendingBackgroundWork!);
      const adopted = yield* startTurn(
        runtime,
        thread,
        "default",
        [],
        "",
        undefined,
        1,
        THREAD_ID,
        { ...overrides, shouldStartProviderTurn: () => Effect.succeed(!stopped) },
      ).pipe(Effect.exit);
      assert.equal(Exit.isFailure(adopted), stopped);
      assert.lengthOf(
        fake.allRequests().filter((r) => r.type === "prompt"),
        0,
      );
      assert.isFalse(yield* runtime.hasPendingBackgroundWork!);
      if (stopped) {
        assert.lengthOf(
          observed.filter((e) => e.type === "provider_turn.updated" || e.type === "turn.terminal"),
          0,
        );
        assert.isTrue(Option.isNone(yield* packet.dispatchIfCurrent!(Effect.succeed("stale"))));
      } else {
        const receipt = yield* takeEvent(
          (e) =>
            e.type === "provider_turn.updated" && e.providerTurn.nativeAcceptance === "accepted",
        );
        assert.equal(receipt.type, "provider_turn.updated");
        yield* fake.emit({ type: "agent_settled" });
        const terminal = yield* takeEvent((e) => e.type === "turn.terminal");
        assert.equal(terminal.type === "turn.terminal" ? terminal.status : undefined, "completed");
        assert.lengthOf(
          observed.filter((e) => e.type === "turn.terminal"),
          1,
        );
      }
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );
});

it.effect("refuses an ordinary prompt when native work races its correlated preparation", () =>
  Effect.gen(function* () {
    const fake = yield* makeFakePi;
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const offered =
      yield* Queue.unbounded<
        import("../ProviderContinuationRequests.ts").ProviderContinuationRequest
      >();
    let selectionStarted = false;
    let held = false;
    const { runtime } = yield* openRuntime(
      fake,
      "default",
      THREAD_ID,
      SESSION_ID,
      undefined,
      (input) =>
        makePiRpcConnection(input).pipe(
          Effect.map((connection) => ({
            ...connection,
            request: (record, timeout) =>
              connection.request(record, timeout).pipe(
                Effect.tap(() => {
                  if (record.type === "set_model") selectionStarted = true;
                  if (record.type !== "get_state" || !selectionStarted || held) return Effect.void;
                  held = true;
                  return Deferred.succeed(entered, undefined).pipe(
                    Effect.andThen(Deferred.await(release)),
                  );
                }),
              ),
          })),
        ),
      { offer: (packet) => Queue.offer(offered, packet).pipe(Effect.asVoid) },
    );
    const thread = yield* runtime.ensureThread({
      threadId: THREAD_ID,
      modelSelection: modelSelection("default"),
      runtimePolicy,
    });
    const preparing = yield* startTurn(runtime, thread, "fixture/synthetic").pipe(
      Effect.exit,
      Effect.forkScoped,
    );
    yield* Deferred.await(entered);
    yield* fake.emit({ type: "agent_start" });
    const packet = yield* Queue.take(offered);
    assert.isTrue(yield* runtime.hasPendingBackgroundWork!);
    yield* Deferred.succeed(release, undefined);
    assert.isTrue(Exit.isFailure(yield* Fiber.join(preparing)));
    assert.lengthOf(
      fake.allRequests().filter((r) => r.type === "prompt"),
      0,
    );
    assert.isTrue(Option.isNone(yield* packet.dispatchIfCurrent!(Effect.succeed("stale"))));
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.effect.each(
  (["unknown-model", "state-query", "relative-cwd"] as const).map((failure) => ({
    caseTitle: `refuses and releases unowned native work when capture fails (${failure})`,
    failure,
  })),
)("$caseTitle", ({ failure }) =>
  Effect.gen(function* () {
    const fake = yield* makeFakePi;
    let offers = 0;
    const { runtime, observed, takeEvent } = yield* openRuntime(
      fake,
      "default",
      THREAD_ID,
      SESSION_ID,
      undefined,
      undefined,
      {
        offer: () =>
          Effect.sync(() => {
            offers++;
          }),
      },
      failure === "relative-cwd" ? { ...runtimePolicy, cwd: "relative" } : runtimePolicy,
    );
    yield* runtime.ensureThread({
      threadId: THREAD_ID,
      modelSelection: modelSelection("default"),
      runtimePolicy,
    });
    if (failure === "state-query") fake.failNextState();
    if (failure === "relative-cwd")
      fake.queueState({ model: { provider: "fixture", id: "synthetic" } });
    yield* fake.emit({ type: "agent_start" });
    const refusal = yield* takeEvent(
      (e) => e.type === "provider_session.updated" && e.providerSession.status === "error",
    );
    assert.include(
      refusal.type === "provider_session.updated" ? refusal.providerSession.lastError : "",
      failure === "state-query"
        ? "could not be captured"
        : failure === "relative-cwd"
          ? "absolute captured cwd"
          : "known native model",
    );
    assert.equal(offers, 0);
    assert.isFalse(yield* runtime.hasPendingBackgroundWork!);
    assert.lengthOf(
      observed.filter((e) => e.type === "provider_turn.updated" || e.type === "turn.terminal"),
      0,
    );
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.effect(
  "requires an explicitly provided continuation queue instead of the dropping reference default",
  () =>
    Effect.gen(function* () {
      assert.isUndefined(yield* piContinuationRequestsIfProvided);
      const bus = { offer: () => Effect.void, take: Effect.never };
      assert.strictEqual(
        yield* piContinuationRequestsIfProvided.pipe(
          Effect.provideService(ProviderContinuationRequests, bus),
        ),
        bus,
      );
    }).pipe(Effect.provide(testLayer)),
);
