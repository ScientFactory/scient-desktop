import * as NodeServices from "@effect/platform-node/NodeServices";
import { RunAttemptId } from "@t3tools/contracts";
import { it, assert } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import { TestClock } from "effect/testing";
import * as IdAllocator from "../IdAllocator.ts";
import * as CodexAdapterV2 from "./CodexAdapterV2.ts";
import {
  codexReplayPreamble,
  makeCodexReplayTranscript,
  makeCodexReplayTurn,
  makeCodexReplayHarness,
  makeCodexTestTurnInput,
} from "./CodexAdapterV2.replay.testkit.ts";
import { describe } from "@effect/vitest";

describe("CodexAdapterV2 post-settle continuation", () => {
  it.effect("waits for native start before interrupting an acknowledged queued turn", () =>
    Effect.gen(function* () {
      const nativeThreadId = "early-stop-thread";
      const nativeTurnId = "early-stop-turn";
      const prompt = "Run a command.";
      const preamble = codexReplayPreamble({ nativeThreadId, nativeTurnId, prompt });
      const transcript = makeCodexReplayTranscript({
        scenario: "early-stop-await-native-start",
        entries: [
          ...preamble.slice(0, -2),
          {
            type: "emit_inbound",
            label: "turn/start/queued",
            frame: {
              id: 3,
              result: {
                turn: {
                  ...makeCodexReplayTurn({ id: nativeTurnId, status: "inProgress" }),
                  startedAt: null,
                },
              },
            },
          },
          {
            type: "emit_inbound",
            label: "turn/started",
            afterMs: 1000,
            frame: {
              method: "turn/started",
              params: {
                threadId: nativeThreadId,
                turn: makeCodexReplayTurn({ id: nativeTurnId, status: "inProgress" }),
              },
            },
          },
          {
            type: "expect_outbound",
            label: "turn/interrupt",
            frame: {
              id: 4,
              method: "turn/interrupt",
              params: { threadId: nativeThreadId, turnId: nativeTurnId },
            },
          },
          { type: "emit_inbound", label: "turn/interrupt", frame: { id: 4, result: {} } },
          {
            type: "emit_inbound",
            label: "turn/completed",
            frame: {
              method: "turn/completed",
              params: {
                threadId: nativeThreadId,
                turn: makeCodexReplayTurn({ id: nativeTurnId, status: "interrupted" }),
              },
            },
          },
        ],
      });
      let interruptSent = false;
      const harness = yield* makeCodexReplayHarness(
        transcript,
        () => Effect.void,
        (method) =>
          Effect.sync(() => {
            if (method === "turn/interrupt") interruptSent = true;
          }),
      );
      yield* harness.runtime.startTurn(
        makeCodexTestTurnInput({
          threadId: harness.threadId,
          providerThread: harness.providerThread,
          now: yield* DateTime.now,
          attemptId: RunAttemptId.make("early-stop-attempt"),
          text: prompt,
        }),
      );
      const providerTurnId = (yield* IdAllocator.IdAllocatorV2).derive.providerTurn({
        driver: CodexAdapterV2.CODEX_DRIVER_KIND,
        nativeTurnId,
      });
      const interrupt = yield* harness.runtime
        .interruptTurn({ providerThread: harness.providerThread, providerTurnId })
        .pipe(Effect.forkScoped);
      yield* TestClock.adjust("500 millis");
      assert.isFalse(interruptSent, "Stop must not reach Codex before native turn/started");
      yield* TestClock.adjust("500 millis");
      yield* Fiber.join(interrupt);
      yield* harness.firstTerminal;
      assert.equal(harness.terminalEvents()[0]?.status, "interrupted");
      assert.lengthOf(harness.terminalEvents(), 1);
      assert.isFalse(yield* harness.hasPendingBackgroundWork);
    }).pipe(Effect.scoped, Effect.provide(Layer.merge(IdAllocator.layer, NodeServices.layer))),
  );

  it.effect("settles Stop when a queued native turn fails before starting", () =>
    Effect.gen(function* () {
      const nativeThreadId = "early-stop-thread";
      const nativeTurnId = "early-stop-turn";
      const prompt = "Run a command.";
      const preamble = codexReplayPreamble({ nativeThreadId, nativeTurnId, prompt });
      const transcript = makeCodexReplayTranscript({
        scenario: "early-stop-failed-before-native-start",
        entries: [
          ...preamble.slice(0, -2),
          {
            type: "emit_inbound",
            label: "turn/start/queued",
            frame: {
              id: 3,
              result: {
                turn: {
                  ...makeCodexReplayTurn({ id: nativeTurnId, status: "inProgress" }),
                  startedAt: null,
                },
              },
            },
          },
          {
            type: "emit_inbound",
            label: "turn/failed",
            afterMs: 1000,
            frame: {
              method: "turn/completed",
              params: {
                threadId: nativeThreadId,
                turn: {
                  ...makeCodexReplayTurn({ id: nativeTurnId, status: "failed" }),
                  startedAt: null,
                  error: {
                    message: "Failed before native start",
                    codexErrorInfo: null,
                    additionalDetails: null,
                  },
                },
              },
            },
          },
        ],
      });
      let interruptSent = false;
      const harness = yield* makeCodexReplayHarness(
        transcript,
        () => Effect.void,
        (method) =>
          Effect.sync(() => {
            if (method === "turn/interrupt") interruptSent = true;
          }),
      );
      yield* harness.runtime.startTurn(
        makeCodexTestTurnInput({
          threadId: harness.threadId,
          providerThread: harness.providerThread,
          now: yield* DateTime.now,
          attemptId: RunAttemptId.make("early-stop-attempt"),
          text: prompt,
        }),
      );
      const providerTurnId = (yield* IdAllocator.IdAllocatorV2).derive.providerTurn({
        driver: CodexAdapterV2.CODEX_DRIVER_KIND,
        nativeTurnId,
      });
      const interrupt = yield* harness.runtime
        .interruptTurn({ providerThread: harness.providerThread, providerTurnId })
        .pipe(Effect.forkScoped);
      yield* TestClock.adjust("500 millis");
      assert.isFalse(interruptSent, "Stop must not reach Codex before native turn/started");
      yield* TestClock.adjust("500 millis");
      yield* Fiber.join(interrupt);
      yield* harness.firstTerminal;
      assert.equal(harness.terminalEvents()[0]?.status, "failed");
      assert.lengthOf(harness.terminalEvents(), 1);
      assert.isFalse(interruptSent, "A terminal native turn must not receive turn/interrupt");
      assert.isFalse(yield* harness.hasPendingBackgroundWork);
    }).pipe(Effect.scoped, Effect.provide(Layer.merge(IdAllocator.layer, NodeServices.layer))),
  );

  it.effect("bounds Stop when a queued native turn never starts", () =>
    Effect.gen(function* () {
      const nativeThreadId = "early-stop-thread";
      const nativeTurnId = "early-stop-turn";
      const prompt = "Run a command.";
      const preamble = codexReplayPreamble({ nativeThreadId, nativeTurnId, prompt });
      const transcript = makeCodexReplayTranscript({
        scenario: "early-stop-never-starts",
        entries: [
          ...preamble.slice(0, -2),
          {
            type: "emit_inbound",
            label: "turn/start/queued",
            frame: {
              id: 3,
              result: {
                turn: {
                  ...makeCodexReplayTurn({ id: nativeTurnId, status: "inProgress" }),
                  startedAt: null,
                },
              },
            },
          },
        ],
      });
      let interruptSent = false;
      const harness = yield* makeCodexReplayHarness(
        transcript,
        () => Effect.void,
        (method) =>
          Effect.sync(() => {
            if (method === "turn/interrupt") interruptSent = true;
          }),
      );
      yield* harness.runtime.startTurn(
        makeCodexTestTurnInput({
          threadId: harness.threadId,
          providerThread: harness.providerThread,
          now: yield* DateTime.now,
          attemptId: RunAttemptId.make("early-stop-attempt"),
          text: prompt,
        }),
      );
      const providerTurnId = (yield* IdAllocator.IdAllocatorV2).derive.providerTurn({
        driver: CodexAdapterV2.CODEX_DRIVER_KIND,
        nativeTurnId,
      });
      const interrupt = yield* harness.runtime
        .interruptTurn({ providerThread: harness.providerThread, providerTurnId })
        .pipe(Effect.exit, Effect.forkScoped);
      yield* TestClock.adjust("10 seconds");
      assert.equal((yield* Fiber.join(interrupt))._tag, "Failure");
      yield* harness.firstTerminal;
      assert.equal(harness.terminalEvents()[0]?.status, "interrupted");
      assert.lengthOf(harness.terminalEvents(), 1);
      assert.isFalse(interruptSent, "An unstarted native turn must not receive turn/interrupt");
      assert.isFalse(yield* harness.hasPendingBackgroundWork);
    }).pipe(Effect.scoped, Effect.provide(Layer.merge(IdAllocator.layer, NodeServices.layer))),
  );
});
