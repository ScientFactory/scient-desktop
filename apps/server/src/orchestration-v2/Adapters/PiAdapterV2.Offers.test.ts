import { assert, describe, it } from "@effect/vitest";
import { MessageId, NodeId, RunAttemptId, RunId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { makePiRpcConnection, PiRpcError } from "@t3tools/provider-pi/testing";
import {
  isNativeStartReceiptError,
  testLayer,
  THREAD_ID,
  SESSION_ID,
  FAKE_SESSION_FILE,
  runtimePolicy,
  modelSelection,
  recordedIdleState,
  makeFakePi,
  openRuntime,
  startTurn,
} from "./PiAdapterV2.fixture.ts";

describe("PiAdapterV2", () => {
  it.effect.each(
    [false, true].map((rejectPrompt) => ({
      caseTitle: `cancels an unacknowledged native offer before a late prompt ack, rejection=${rejectPrompt}`,
      rejectPrompt,
    })),
  )("$caseTitle", ({ rejectPrompt }) =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime, takeEvent, observed } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      yield* startTurn(runtime, providerThread, "default", [], "/extension-command");
      yield* fake.takeRequest("prompt");
      const pending = yield* takeEvent((e) => e.type === "provider_turn.updated");
      if (pending.type !== "provider_turn.updated") return;
      assert.equal(pending.providerTurn.nativeAcceptance, "unknown");
      assert.isUndefined(pending.providerTurn.acceptedAt);
      yield* runtime.interruptTurn({
        providerThread,
        providerTurnId: pending.providerTurn.id,
        requestRuntimeRestart: true,
      });
      const terminal = yield* takeEvent((e) => e.type === "turn.terminal");
      assert.isTrue(terminal.type === "turn.terminal" && terminal.status === "interrupted");
      yield* fake.emit({
        type: "response",
        command: "prompt",
        success: !rejectPrompt,
        ...(rejectPrompt ? { error: "closed by Stop" } : {}),
      });
      yield* fake.emit({ type: "agent_settled" });
      yield* Effect.yieldNow;
      assert.lengthOf(
        observed.filter((e) => e.type === "turn.terminal"),
        1,
      );
      assert.isFalse(
        observed.some(
          (e) =>
            e.type === "provider_turn.updated" && e.providerTurn.nativeAcceptance === "accepted",
        ),
      );
      assert.isFalse(
        observed.some((e) => e.type === "turn_item.updated" && e.turnItem.type === "error"),
      );
      const stopped = observed
        .flatMap((e) => (e.type === "provider_turn.updated" ? [e.providerTurn] : []))
        .at(-1);
      assert.equal(stopped?.nativeAcceptance, "unknown");
      assert.isUndefined(stopped?.acceptedAt);
      assert.equal(fake.allRequests().filter((r) => r.type === "abort").length, 1);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect.each(
    [false, true].map((hardStop) => ({
      caseTitle: `interrupts steering held in native preflight without offering it, hard Stop=${hardStop}`,
      hardStop,
    })),
  )("$caseTitle", ({ hardStop }) =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime, takeEvent, observed } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      yield* startTurn(runtime, providerThread);
      yield* fake.takeRequest("prompt");
      yield* fake.emit({ type: "response", command: "prompt", success: true });
      yield* fake.emit({ type: "agent_start" });
      const accepted = yield* takeEvent(
        (e) => e.type === "provider_turn.updated" && e.providerTurn.nativeAcceptance === "accepted",
      );
      if (accepted.type !== "provider_turn.updated") return;
      fake.deferNextState();
      const steering = yield* runtime
        .steerTurn({
          threadId: THREAD_ID,
          runId: RunId.make(`run:${THREAD_ID}:1`),
          providerThread,
          providerTurnId: accepted.providerTurn.id,
          message: {
            messageId: MessageId.make("held-steer"),
            text: "steer",
            attachments: [],
            createdBy: "user",
            creationSource: "web",
          },
        })
        .pipe(Effect.exit, Effect.forkScoped);
      yield* fake.takeRequest("get_state");
      yield* runtime.interruptTurn({
        providerThread,
        providerTurnId: accepted.providerTurn.id,
        requestRuntimeRestart: hardStop,
      });
      if (!hardStop) yield* fake.resolveDeferredState(recordedIdleState(FAKE_SESSION_FILE));
      const result = yield* Fiber.join(steering);
      assert.isTrue(Exit.isFailure(result) && Cause.hasInterruptsOnly(result.cause));
      if (!hardStop) yield* fake.emit({ type: "agent_settled" });
      const terminal = yield* takeEvent((e) => e.type === "turn.terminal");
      assert.isTrue(terminal.type === "turn.terminal" && terminal.status === "interrupted");
      assert.equal(fake.allRequests().filter((r) => r.type === "prompt").length, 1);
      assert.lengthOf(
        observed.filter((e) => e.type === "turn.terminal"),
        1,
      );
      assert.isFalse(
        observed.some((e) => e.type === "turn_item.updated" && e.turnItem.type === "error"),
      );
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("contains a blocked native steering write without waiting for command acceptance", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime, takeEvent, observed } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      yield* startTurn(runtime, providerThread);
      yield* fake.takeRequest("prompt");
      yield* fake.emit({ type: "response", command: "prompt", success: true });
      yield* fake.emit({ type: "agent_start" });
      const accepted = yield* takeEvent(
        (e) => e.type === "provider_turn.updated" && e.providerTurn.nativeAcceptance === "accepted",
      );
      if (accepted.type !== "provider_turn.updated") return;
      fake.blockNextPromptWrite();
      yield* runtime.steerTurn({
        threadId: THREAD_ID,
        runId: RunId.make(`run:${THREAD_ID}:1`),
        providerThread,
        providerTurnId: accepted.providerTurn.id,
        message: {
          messageId: MessageId.make("blocked-steer"),
          text: "steer",
          attachments: [],
          createdBy: "user",
          creationSource: "web",
        },
      });
      yield* fake.takeRequest("prompt");
      const stopping = yield* runtime
        .interruptTurn({
          providerThread,
          providerTurnId: accepted.providerTurn.id,
          requestRuntimeRestart: true,
        })
        .pipe(Effect.forkScoped);
      yield* TestClock.adjust("10 seconds");
      yield* Fiber.join(stopping);
      const terminal = yield* takeEvent((e) => e.type === "turn.terminal");
      assert.isTrue(terminal.type === "turn.terminal" && terminal.status === "interrupted");
      yield* fake.releasePromptWrite;
      yield* fake.emit({
        type: "response",
        command: "prompt",
        success: false,
        error: "closed by Stop",
      });
      yield* Effect.yieldNow;
      assert.lengthOf(
        observed.filter((e) => e.type === "turn.terminal"),
        1,
      );
      assert.isFalse(
        observed.some((e) => e.type === "turn_item.updated" && e.turnItem.type === "error"),
      );
      assert.equal(fake.allRequests().filter((r) => r.type === "prompt").length, 2);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("reports rejected native steering while the original turn keeps streaming", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime, takeEvent, observed } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      yield* startTurn(runtime, providerThread);
      yield* fake.takeRequest("prompt");
      yield* fake.emit({ type: "response", command: "prompt", success: true });
      yield* fake.emit({ type: "agent_start" });
      const accepted = yield* takeEvent(
        (e) => e.type === "provider_turn.updated" && e.providerTurn.nativeAcceptance === "accepted",
      );
      if (accepted.type !== "provider_turn.updated") return;
      yield* runtime.steerTurn({
        threadId: THREAD_ID,
        runId: RunId.make(`run:${THREAD_ID}:1`),
        providerThread,
        providerTurnId: accepted.providerTurn.id,
        message: {
          messageId: MessageId.make("refused-steer"),
          text: "steer",
          attachments: [],
          createdBy: "user",
          creationSource: "web",
        },
      });
      yield* fake.takeRequest("prompt");
      yield* fake.emit({
        type: "response",
        command: "prompt",
        success: false,
        error: "Steering refused",
      });
      const refused = yield* takeEvent(
        (e) => e.type === "turn_item.updated" && e.turnItem.type === "error",
      );
      assert.isTrue(
        refused.type === "turn_item.updated" &&
          refused.turnItem.type === "error" &&
          refused.turnItem.failure.message === "Steering refused" &&
          refused.turnItem.providerTurnId === accepted.providerTurn.id,
      );
      assert.lengthOf(
        observed.filter((e) => e.type === "turn.terminal"),
        0,
      );
      yield* fake.emit({ type: "message_start", message: { role: "assistant" } });
      yield* fake.emit({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Original reply after refusal" }],
        },
      });
      yield* fake.emit({ type: "agent_settled" });
      const terminal = yield* takeEvent((e) => e.type === "turn.terminal");
      assert.isTrue(terminal.type === "turn.terminal" && terminal.status === "completed");
      assert.isTrue(
        observed.some(
          (e) => e.type === "message.updated" && e.message.text === "Original reply after refusal",
        ),
      );
      assert.lengthOf(
        observed.filter((e) => e.type === "turn.terminal"),
        1,
      );
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect(
    "retains the exact uncertain offer when a native stdin write fails before its receipt is emitted",
    () =>
      Effect.gen(function* () {
        const fake = yield* makeFakePi;
        const makeConnection: typeof makePiRpcConnection = (input) =>
          makePiRpcConnection(input).pipe(
            Effect.map((connection) => ({
              ...connection,
              send: (record) =>
                connection.send(record).pipe(
                  Effect.andThen(
                    record.type === "prompt"
                      ? Effect.fail(
                          new PiRpcError({
                            operation: "stdin write",
                            detail: "Write outcome unknown",
                          }),
                        )
                      : Effect.void,
                  ),
                ),
            })),
          );
        const { runtime } = yield* openRuntime(
          fake,
          "default",
          THREAD_ID,
          SESSION_ID,
          undefined,
          makeConnection,
        );
        const providerThread = yield* runtime.ensureThread({
          threadId: THREAD_ID,
          modelSelection: modelSelection("default"),
          runtimePolicy,
        });
        const error = yield* startTurn(runtime, providerThread).pipe(Effect.flip);
        if (!isNativeStartReceiptError(error))
          return yield* Effect.die("Expected exact native start error");
        assert.equal(error.providerTurn?.nativeAcceptance, "unknown");
        assert.isUndefined(error.providerTurn?.acceptedAt);
        assert.equal(error.providerTurn?.providerThreadId, providerThread.id);
        assert.equal(
          error.providerTurn?.runAttemptId,
          RunAttemptId.make(`run-attempt:run:${THREAD_ID}:1:1`),
        );
        assert.equal(error.providerTurn?.nodeId, NodeId.make(`node:run:${THREAD_ID}:1:root`));
        assert.equal((yield* fake.takeRequest("prompt")).type, "prompt");
        assert.equal(runtime.providerSession.status, "error");
        assert.equal(
          (yield* startTurn(
            runtime,
            providerThread,
            "default",
            [],
            "cannot replay",
            undefined,
            2,
          ).pipe(Effect.result))._tag,
          "Failure",
        );
        assert.equal(fake.allRequests().filter((request) => request.type === "prompt").length, 1);
      }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("stops provider-initiated work that has no T3 turn owner", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime, takeEvent } = yield* openRuntime(fake);
      yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });

      yield* fake.emit({ type: "agent_start" });

      const sessionError = yield* takeEvent(
        (event) =>
          event.type === "provider_session.updated" && event.providerSession.status === "error",
      );
      assert.isTrue(
        sessionError.type === "provider_session.updated" &&
          sessionError.providerSession.lastError?.includes("invisible tool execution") === true,
      );
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );
});
