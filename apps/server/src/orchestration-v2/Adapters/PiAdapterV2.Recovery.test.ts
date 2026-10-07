import { assert, describe, it } from "@effect/vitest";
import { RunId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { makePiRpcConnection } from "./PiRpc.ts";
import { piContextErrorMessage } from "../../provider/pi/PiContextError.ts";
import {
  testLayer,
  THREAD_ID,
  SESSION_ID,
  runtimePolicy,
  modelSelection,
  makeFakePi,
  openRuntime,
  startTurn,
  expectModelFailure,
} from "./PiAdapterV2.fixture.ts";

describe("PiAdapterV2", () => {
  for (const partial of ["", "Preserved partial answer"]) {
    it.effect(
      `settles native Pi truncation with ${partial ? "partial" : "empty"} text and reuses the session`,
      () =>
        Effect.gen(function* () {
          const fake = yield* makeFakePi;
          const { runtime, takeEvent, observed } = yield* openRuntime(fake);
          const providerThread = yield* runtime.ensureThread({
            threadId: THREAD_ID,
            modelSelection: modelSelection("default"),
            runtimePolicy,
          });
          yield* startTurn(runtime, providerThread);
          yield* fake.emit({ type: "agent_start" });
          yield* fake.emit({ type: "message_start", message: { role: "assistant" } });
          yield* fake.emit({
            type: "message_end",
            message: {
              role: "assistant",
              stopReason: "length",
              content: [{ type: "text", text: partial }],
            },
          });
          yield* fake.emit({ type: "agent_end" });
          yield* fake.emit({ type: "agent_settled" });
          const first = yield* takeEvent((event) => event.type === "turn.terminal");
          assert.isTrue(first.type === "turn.terminal" && first.status === "completed");
          assert.deepEqual(
            observed
              .filter(
                (event) =>
                  event.type === "turn_item.updated" && event.turnItem.type === "assistant_message",
              )
              .map((event) =>
                event.type === "turn_item.updated" && event.turnItem.type === "assistant_message"
                  ? event.turnItem.text
                  : "",
              ),
            partial ? [partial] : [],
          );
          assert.isTrue(
            observed.some(
              (event) =>
                event.type === "turn_item.updated" &&
                event.turnItem.type === "notification" &&
                event.turnItem.source.kind === "output_truncated",
            ),
          );
          yield* startTurn(runtime, providerThread, "default", [], "continue", undefined, 2);
          yield* fake.emit({ type: "agent_start" });
          yield* fake.emit({ type: "agent_settled" });
          const second = yield* takeEvent((event) => event.type === "turn.terminal");
          assert.isTrue(second.type === "turn.terminal" && second.status === "completed");
          assert.equal(observed.filter((event) => event.type === "turn.terminal").length, 2);
        }).pipe(Effect.scoped, Effect.provide(testLayer)),
    );
  }

  for (const initialStopReason of ["error", "length"]) {
    it.effect(`preserves final whitespace after native Pi recovery from ${initialStopReason}`, () =>
      Effect.gen(function* () {
        const fake = yield* makeFakePi;
        const { runtime, takeEvent, observed } = yield* openRuntime(fake);
        const providerThread = yield* runtime.ensureThread({
          threadId: THREAD_ID,
          modelSelection: modelSelection("default"),
          runtimePolicy,
        });
        yield* startTurn(runtime, providerThread);
        yield* fake.emit({ type: "agent_start" });
        yield* fake.emit({ type: "message_start", message: { role: "assistant" } });
        yield* fake.emit({
          type: "message_end",
          message: {
            role: "assistant",
            stopReason: initialStopReason,
            errorMessage: "retrying",
            content: [],
          },
        });
        yield* fake.emit({ type: "agent_end" });
        yield* fake.emit({ type: "turn_end" });
        yield* fake.emit({ type: "turn_start" });
        yield* fake.emit({ type: "message_start", message: { role: "assistant" } });
        yield* fake.emit({
          type: "message_end",
          message: {
            role: "assistant",
            stopReason: "stop",
            content: [{ type: "text", text: "  שלום π\n" }],
          },
        });
        yield* fake.emit({
          type: "extension_ui_request",
          method: "notify",
          message: "cycle-fence",
        });
        yield* takeEvent(
          (event) =>
            event.type === "turn_item.updated" &&
            event.turnItem.type === "dynamic_tool" &&
            event.turnItem.toolName === "notify",
        );
        assert.isFalse(observed.some((event) => event.type === "turn.terminal"));
        yield* fake.emit({ type: "agent_settled" });
        const terminal = yield* takeEvent((event) => event.type === "turn.terminal");
        assert.isTrue(terminal.type === "turn.terminal" && terminal.status === "completed");
        const text = observed
          .filter(
            (event) =>
              event.type === "turn_item.updated" && event.turnItem.type === "assistant_message",
          )
          .map((event) =>
            event.type === "turn_item.updated" && event.turnItem.type === "assistant_message"
              ? event.turnItem.text
              : "",
          );
        assert.deepEqual(text, ["  שלום π\n"]);
        assert.equal(observed.filter((event) => event.type === "turn.terminal").length, 1);
      }).pipe(Effect.scoped, Effect.provide(testLayer)),
    );
  }

  it.effect("native Pi Stop wins pending truncation and suppresses blank messages", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime, takeEvent, observed } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      yield* startTurn(runtime, providerThread);
      const running = yield* takeEvent((event) => event.type === "provider_turn.updated");
      if (running.type !== "provider_turn.updated")
        return yield* Effect.die("Missing running turn");
      yield* fake.emit({ type: "message_start", message: { role: "assistant" } });
      yield* fake.emit({
        type: "message_end",
        message: { role: "assistant", stopReason: "length", content: [] },
      });
      yield* runtime.interruptTurn({ providerThread, providerTurnId: running.providerTurn.id });
      yield* fake.emit({ type: "agent_settled" });
      const terminal = yield* takeEvent((event) => event.type === "turn.terminal");
      assert.isTrue(terminal.type === "turn.terminal" && terminal.status === "interrupted");
      assert.isFalse(
        observed.some(
          (event) =>
            event.type === "turn_item.updated" &&
            (event.turnItem.type === "assistant_message" || event.turnItem.type === "notification"),
        ),
      );
      assert.equal(observed.filter((event) => event.type === "turn.terminal").length, 1);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  for (const error of [
    "400 maximum context length exceeded",
    "429 rate limit: too many tokens",
    "Invalid API key",
  ]) {
    it.effect(
      `classifies native Pi context failure without rewriting ${error.startsWith("400") ? "the recovery advice" : error}`,
      () => expectModelFailure(error, piContextErrorMessage(error)),
    );
  }

  for (const failure of ["context-limit", "extension-error", "continue"]) {
    it.effect(`settles guarded native Pi context recovery after ${failure}`, () =>
      Effect.gen(function* () {
        const fake = yield* makeFakePi;
        const { runtime, takeEvent, observed } = yield* openRuntime(fake);
        const providerThread = yield* runtime.ensureThread({
          threadId: THREAD_ID,
          modelSelection: modelSelection("default"),
          runtimePolicy,
        });
        yield* startTurn(runtime, providerThread);
        yield* fake.emit({ type: "agent_start" });
        yield* fake.emit({
          type: "extension_ui_request",
          method: "notify",
          message: "scient:context-recovery: compacting",
        });
        yield* takeEvent(
          (event) =>
            event.type === "turn_item.updated" &&
            event.turnItem.type === "dynamic_tool" &&
            event.turnItem.toolName === "notify",
        );
        yield* fake.emit({ type: "agent_settled" });
        yield* fake.takeRequest("get_state");
        yield* fake.emit({
          type: "extension_ui_request",
          method: "notify",
          message: "probe-fence",
        });
        yield* takeEvent(
          (event) =>
            event.type === "turn_item.updated" &&
            event.turnItem.type === "dynamic_tool" &&
            event.turnItem.toolName === "notify",
        );
        assert.isFalse(observed.some((event) => event.type === "turn.terminal"));
        yield* fake.emit({ type: "compaction_end", result: { summary: "saved progress" } });
        if (failure === "context-limit")
          yield* fake.emit({
            type: "extension_ui_request",
            method: "notify",
            message: "scient:context-limit: failed",
          });
        else if (failure === "extension-error")
          yield* fake.emit({
            type: "extension_error",
            event: "send_message",
            error: "synthetic continuation failure",
          });
        else {
          yield* fake.emit({ type: "agent_start" });
          yield* fake.emit({ type: "message_start", message: { role: "assistant" } });
          yield* fake.emit({
            type: "message_end",
            message: {
              role: "assistant",
              stopReason: "stop",
              content: [{ type: "text", text: "Continued" }],
            },
          });
          yield* fake.emit({ type: "agent_settled" });
        }
        const terminal = yield* takeEvent((event) => event.type === "turn.terminal");
        assert.isTrue(
          terminal.type === "turn.terminal" &&
            terminal.status === (failure === "continue" ? "completed" : "failed"),
        );
        if (terminal.type === "turn.terminal" && terminal.status === "failed")
          assert.include(terminal.failure.message, "Saved");
        assert.equal(observed.filter((event) => event.type === "turn.terminal").length, 1);
      }).pipe(Effect.scoped, Effect.provide(testLayer)),
    );
  }

  it.effect("persists current xAI capacity text for the thread error banner", () =>
    expectModelFailure("The model is currently at capacity due to high demand."),
  );

  it.effect("persists extension-normalized xAI capacity text for the thread error banner", () =>
    expectModelFailure(
      "Provider overloaded: The model is currently at capacity due to high demand.",
    ),
  );

  it.effect("fails a rejected native Pi prompt once and permits the next turn", () =>
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
      yield* fake.emit({
        type: "response",
        command: "prompt",
        success: false,
        error: "Synthetic rejected prompt",
      });
      const failed = yield* takeEvent((event) => event.type === "turn.terminal");
      assert.isTrue(
        failed.type === "turn.terminal" &&
          failed.status === "failed" &&
          failed.failure?.message === "Synthetic rejected prompt",
      );
      yield* startTurn(runtime, providerThread, "default", [], "second", undefined, 2);
      yield* fake.takeRequest("prompt");
      yield* fake.emit({ type: "agent_start" });
      yield* fake.emit({ type: "agent_settled" });
      const recovered = yield* takeEvent((event) => event.type === "turn.terminal");
      assert.isTrue(
        recovered.type === "turn.terminal" &&
          recovered.status === "completed" &&
          recovered.providerTurnId !==
            (failed.type === "turn.terminal" ? failed.providerTurnId : undefined),
      );
      assert.equal(observed.filter((event) => event.type === "turn.terminal").length, 2);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("fails native Pi transport closure once and refuses further delivery", () =>
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
      yield* fake.emit({ type: "agent_start" });
      yield* takeEvent(
        (event) =>
          event.type === "provider_turn.updated" &&
          event.providerTurn.nativeAcceptance === "accepted",
      );
      yield* fake.closeStdout;
      const failed = yield* takeEvent((event) => event.type === "turn.terminal");
      assert.isTrue(
        failed.type === "turn.terminal" &&
          failed.status === "failed" &&
          failed.threadDisposition === "broken" &&
          failed.failure?.message.includes("exited unexpectedly"),
      );
      assert.equal(
        (yield* startTurn(runtime, providerThread, "default", [], "after close", undefined, 2).pipe(
          Effect.result,
        ))._tag,
        "Failure",
      );
      assert.equal(fake.allRequests().filter((record) => record.type === "prompt").length, 1);
      assert.equal(observed.filter((event) => event.type === "turn.terminal").length, 1);
      const replacement = yield* makeFakePi;
      const next = yield* openRuntime(replacement);
      const resumed = yield* next.runtime.resumeThread({ providerThread });
      yield* startTurn(next.runtime, resumed, "default", [], "recovered", undefined, 2);
      yield* replacement.emit({ type: "agent_start" });
      yield* replacement.emit({ type: "agent_settled" });
      assert.isTrue(
        (yield* next.takeEvent((event) => event.type === "turn.terminal")).type === "turn.terminal",
      );
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("rejects native Pi thread startup after an already closed transport", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      yield* fake.closeStdout;
      const { runtime } = yield* openRuntime(fake);
      const starting = yield* runtime
        .ensureThread({
          threadId: THREAD_ID,
          modelSelection: modelSelection("default"),
          runtimePolicy,
        })
        .pipe(Effect.result, Effect.forkScoped);
      yield* Effect.yieldNow;
      assert.isUndefined(starting.pollUnsafe());
      const result = yield* Fiber.join(starting);
      assert.equal(result._tag, "Failure");
      assert.equal(fake.allRequests().filter((record) => record.type === "prompt").length, 0);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("rejects native Pi preflight when stdout closes during model confirmation", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime, observed } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      fake.deferNextState();
      const sending = yield* startTurn(runtime, providerThread, "xai/grok-4.6").pipe(
        Effect.result,
        Effect.forkScoped,
      );
      yield* fake.takeRequest("set_model");
      yield* fake.takeRequest("get_state");
      yield* fake.closeStdout;
      assert.equal((yield* Fiber.join(sending))._tag, "Failure");
      assert.equal(fake.allRequests().filter((record) => record.type === "prompt").length, 0);
      assert.isFalse(observed.some((event) => event.type === "provider_turn.updated"));
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  for (const phase of ["settlement", "steering"] as const) {
    it.effect(`fails native Pi identity drift during ${phase} once and keeps Stop idempotent`, () =>
      Effect.gen(function* () {
        const fake = yield* makeFakePi;
        let terminations = 0;
        const makeConnection: typeof makePiRpcConnection = (input) =>
          makePiRpcConnection(input).pipe(
            Effect.map((connection) => ({
              ...connection,
              terminate: Effect.sync(() => {
                terminations += 1;
              }).pipe(Effect.andThen(connection.terminate), Effect.andThen(fake.closeStdout)),
            })),
          );
        const { runtime, takeEvent, observed } = yield* openRuntime(
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
        yield* startTurn(runtime, providerThread);
        yield* fake.takeRequest("prompt");
        yield* fake.emit({ type: "agent_start" });
        const accepted = yield* takeEvent(
          (event) =>
            event.type === "provider_turn.updated" &&
            event.providerTurn.nativeAcceptance === "accepted",
        );
        if (accepted.type !== "provider_turn.updated") return;
        fake.queueState({ sessionId: "unexpected-session" });
        if (phase === "settlement") yield* fake.emit({ type: "agent_settled" });
        else {
          const result = yield* runtime
            .steerTurn({
              threadId: THREAD_ID,
              runId: RunId.make("run:thread-pi-test:1"),
              providerThread,
              providerTurnId: accepted.providerTurn.id,
              message: {
                messageId: "drift" as never,
                text: "steer",
                attachments: [],
                createdBy: "user",
                creationSource: "web",
              },
            })
            .pipe(Effect.exit);
          assert.equal(result._tag, "Failure");
          if (result._tag === "Failure") assert.isFalse(Cause.hasInterruptsOnly(result.cause));
        }
        const terminal = yield* takeEvent((event) => event.type === "turn.terminal");
        assert.isTrue(
          terminal.type === "turn.terminal" &&
            terminal.status === "failed" &&
            terminal.threadDisposition === "broken",
        );
        for (let count = 0; count < 2; count++)
          yield* runtime.interruptTurn({
            providerThread,
            providerTurnId: accepted.providerTurn.id,
            requestRuntimeRestart: true,
          });
        assert.equal(terminations, 1);
        assert.equal(observed.filter((event) => event.type === "turn.terminal").length, 1);
        assert.equal(fake.allRequests().filter((record) => record.type === "prompt").length, 1);
      }).pipe(Effect.scoped, Effect.provide(testLayer)),
    );
  }

  it.effect("keeps a settled turn's late prompt rejection off the next turn", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePi;
      const { runtime, takeEvent } = yield* openRuntime(fake);
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection: modelSelection("default"),
        runtimePolicy,
      });
      // An extension command can hold its prompt ack open past settlement.
      yield* startTurn(runtime, providerThread, "default", [], "/my-command");
      yield* fake.takeRequest("prompt");
      yield* fake.emit({ type: "agent_start" });
      yield* fake.emit({ type: "agent_settled" });
      const firstTerminal = yield* takeEvent((event) => event.type === "turn.terminal");
      assert.isTrue(firstTerminal.type === "turn.terminal" && firstTerminal.status === "completed");

      yield* startTurn(runtime, providerThread, "default", [], "Second turn", undefined, 2);
      yield* fake.takeRequest("prompt");
      // The rejection answers the first turn's prompt. It must not consume or
      // fail the second turn's prompt acknowledgement.
      yield* fake.emit({
        type: "response",
        command: "prompt",
        success: false,
        error: "late command rejection",
      });
      yield* fake.emit({ type: "agent_start" });
      yield* fake.emit({ type: "agent_settled" });
      const secondTerminal = yield* takeEvent((event) => event.type === "turn.terminal");
      assert.isTrue(
        secondTerminal.type === "turn.terminal" && secondTerminal.status === "completed",
      );
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );
});
