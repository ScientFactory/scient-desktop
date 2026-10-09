import * as NodeServices from "@effect/platform-node/NodeServices";
import { RunAttemptId } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as ClaudeAdapterV2 from "./ClaudeAdapterV2.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import {
  makeWakeHarness,
  wakeTaskStarted,
  turnOneResult,
  awaitUntil,
  wakeNotification,
  wakeAssistant,
  WAKE_SUMMARY,
  wakeResult,
  claudeSdkFrame,
  WAKE_NATIVE_SESSION,
  makeAssistantErrorFrame,
  makeResultFrame,
  WAKE_RESULT_TEXT,
  WAKE_TASK_ID,
  makeAssistantTextFrame,
  STALE_TASK_NOTIFICATION_RESULT_TEXT,
  staleTaskNotificationResult,
  makeWakeHarnessWithOptions,
} from "./ClaudeAdapterV2.wake.testkit.ts";
import { makeClaudeTestTurnInput } from "./ClaudeAdapterV2.fixture.ts";
describe("ClaudeAdapterV2 background wake turns", () => {
  it.effect("buffers wake output and requests a single continuation run", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeWakeHarness;
        const now = yield* DateTime.now;

        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-wake-1"),
            text: "Run the build in the background.",
            attachments: [],
          }),
        );
        yield* Queue.offer(harness.sdkMessages, wakeTaskStarted);
        yield* Queue.offer(harness.sdkMessages, turnOneResult);
        yield* awaitUntil(() => harness.terminalEvents().length === 1, "first turn terminal");
        assert.equal(harness.terminalEvents()[0]?.status, "completed");
        assert.isTrue(yield* harness.hasPendingBackgroundWork);
        assert.lengthOf(harness.continuationRequests, 0);

        yield* Queue.offer(harness.sdkMessages, wakeNotification);
        let quietYields = 0;
        yield* awaitUntil(() => quietYields++ >= 50, "notification-only quiet window");
        assert.lengthOf(harness.continuationRequests, 0);
        assert.isFalse(yield* harness.hasPendingBackgroundWork);

        yield* Queue.offer(harness.sdkMessages, wakeAssistant);
        yield* awaitUntil(() => harness.continuationRequests.length === 1, "continuation request");
        assert.equal(harness.continuationRequests[0]?.threadId, harness.threadId);
        assert.equal(harness.continuationRequests[0]?.providerThreadId, harness.providerThread.id);
        assert.equal(harness.continuationRequests[0]?.driver, ClaudeAdapterV2.CLAUDE_PROVIDER);
        assert.equal(harness.continuationRequests[0]?.detail, WAKE_SUMMARY);

        yield* Queue.offer(harness.sdkMessages, wakeResult);
        let settleYields = 0;
        yield* awaitUntil(() => settleYields++ >= 50, "wake result to settle into the buffer");
        assert.lengthOf(harness.continuationRequests, 1);
        assert.lengthOf(harness.terminalEvents(), 1);
        assert.isTrue(yield* harness.hasPendingBackgroundWork);
      }).pipe(Effect.provide(Layer.merge(IdAllocator.layer, NodeServices.layer))),
    ),
  );

  it.effect("does not offer a continuation for notification-only opaque work", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeWakeHarness;
        const now = yield* DateTime.now;

        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-notification-only"),
            text: "Start opaque background work.",
            attachments: [],
          }),
        );
        yield* Queue.offer(harness.sdkMessages, wakeTaskStarted);
        yield* Queue.offer(harness.sdkMessages, turnOneResult);
        yield* awaitUntil(() => harness.terminalEvents().length === 1, "first turn terminal");
        assert.isTrue(yield* harness.hasPendingBackgroundWork);

        yield* Queue.offer(harness.sdkMessages, wakeNotification);
        let quietYields = 0;
        yield* awaitUntil(() => quietYields++ >= 100, "notification-only quiet window");
        assert.lengthOf(harness.continuationRequests, 0);
        assert.lengthOf(harness.terminalEvents(), 1);
        assert.isFalse(yield* harness.hasPendingBackgroundWork);

        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-notification-only-continuation"),
            text: "Background task completed.",
            attachments: [],
            providerTurnOrdinal: 2,
            messageCreatedBy: "agent",
            messageCreationSource: "provider",
          }),
        );
        yield* awaitUntil(
          () => harness.terminalEvents().length === 2,
          "notification-only continuation terminal",
        );
        assert.equal(harness.terminalEvents()[1]?.status, "completed");
        assert.lengthOf(harness.offeredMessages, 1);
      }).pipe(Effect.provide(Layer.merge(IdAllocator.layer, NodeServices.layer))),
    ),
  );

  it.effect("carries a rejected wake rate limit into the continuation failure", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeWakeHarness;
        const now = yield* DateTime.now;
        // 2026-09-25T11:10 AEST: the reset a real wake reported while the CLI
        // blocked its notification turn ("resets 11:10am (Australia/Sydney)").
        const resetsAt = 1790298600;

        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-wake-limit-1"),
            text: "Run the build in the background.",
            attachments: [],
          }),
        );
        yield* Queue.offer(harness.sdkMessages, wakeTaskStarted);
        yield* Queue.offer(harness.sdkMessages, turnOneResult);
        yield* Queue.take(harness.terminalReceipts);

        // The CLI wakes with a rejected window before the continuation turn
        // exists, then blocks the wake turn itself.
        yield* Queue.offer(harness.sdkMessages, wakeNotification);
        yield* harness.offerAndWait(
          claudeSdkFrame({
            type: "rate_limit_event",
            rate_limit_info: {
              status: "rejected",
              rateLimitType: "five_hour",
              resetsAt,
              overageStatus: "rejected",
            },
            uuid: "00000000-0000-4000-8000-000000000630",
            session_id: WAKE_NATIVE_SESSION,
          }),
        );
        // The parked rate-limit frame rides along with the wake output; it
        // must not request a continuation on its own.
        assert.lengthOf(harness.continuationRequests, 0);
        yield* harness.offerAndWait(
          makeAssistantErrorFrame({
            uuid: "00000000-0000-4000-8000-000000000631",
            error: "rate_limit",
          }),
        );
        assert.lengthOf(harness.continuationRequests, 1);
        yield* harness.offerAndWait(
          makeResultFrame({
            uuid: "00000000-0000-4000-8000-000000000632",
            result: "You've hit your session limit · resets 11:10am (Australia/Sydney)",
            isError: true,
            apiErrorStatus: 429,
            terminalReason: "api_error",
            origin: { kind: "task-notification" },
          }),
        );
        assert.lengthOf(harness.continuationRequests, 1);

        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-wake-limit-2"),
            text: "Background task completed.",
            attachments: [],
            providerTurnOrdinal: 2,
            messageCreatedBy: "agent",
            messageCreationSource: "provider",
          }),
        );
        const terminal = yield* Queue.take(harness.terminalReceipts);
        assert.equal(terminal?.status, "failed");
        if (terminal === undefined || terminal.status !== "failed") return;
        assert.equal(terminal.failure.class, "usage_limit");
        assert.equal(terminal.failure.resetAt, "2026-09-25T01:10:00.000Z");
        // The rejected window is announced once the replay has a turn to own it.
        const pause = yield* Queue.take(harness.systemNoticeReceipts);
        assert.equal(pause.turnItem.type, "system_notice");
        if (pause.turnItem.type !== "system_notice") return;
        assert.include(pause.turnItem.message, "This turn is paused until the 5-hour limit");
      }).pipe(Effect.provide(Layer.merge(IdAllocator.layer, NodeServices.layer))),
    ),
  );

  it.effect("leaves buffered wake messages for the continuation queued behind a user turn", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeWakeHarness;
        const now = yield* DateTime.now;

        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-wake-4a"),
            text: "Run the build in the background.",
            attachments: [],
          }),
        );
        yield* Queue.offer(harness.sdkMessages, wakeTaskStarted);
        yield* Queue.offer(harness.sdkMessages, turnOneResult);
        yield* awaitUntil(() => harness.terminalEvents().length === 1, "first turn terminal");
        yield* Queue.offer(harness.sdkMessages, wakeNotification);
        yield* Queue.offer(harness.sdkMessages, wakeResult);
        yield* awaitUntil(() => harness.continuationRequests.length === 1, "continuation request");

        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-wake-4b"),
            text: "How is the build going?",
            attachments: [],
            providerTurnOrdinal: 2,
          }),
        );

        // The user prompt reaches the CLI and the buffer stays untouched: the
        // wake result must not settle the user turn or surface under it.
        yield* awaitUntil(() => harness.offeredMessages.length === 2, "user prompt offered");
        assert.lengthOf(harness.terminalEvents(), 1);
        assert.isTrue(yield* harness.hasPendingBackgroundWork);

        yield* Queue.offer(
          harness.sdkMessages,
          makeResultFrame({
            uuid: "00000000-0000-4000-8000-000000000105",
            result: "The build passed; nothing else pending.",
          }),
        );
        yield* awaitUntil(() => harness.terminalEvents().length === 2, "user turn terminal");
        assert.equal(harness.terminalEvents()[1]?.status, "completed");
        assert.isFalse(
          harness.events.some(
            (event) => event.type === "message.updated" && event.message.text === WAKE_RESULT_TEXT,
          ),
        );

        // The continuation run queued behind the user turn drains the wake
        // output afterwards.
        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-wake-4c"),
            text: "Background task completed.",
            attachments: [],
            providerTurnOrdinal: 3,
            messageCreatedBy: "agent",
            messageCreationSource: "provider",
          }),
        );
        yield* awaitUntil(() => harness.terminalEvents().length === 3, "continuation terminal");
        assert.equal(harness.terminalEvents()[2]?.status, "completed");
        assert.lengthOf(harness.offeredMessages, 2);
        assert.isTrue(
          harness.events.some(
            (event) => event.type === "message.updated" && event.message.text === WAKE_RESULT_TEXT,
          ),
        );
        assert.isFalse(
          harness.events.some(
            (event) =>
              event.type !== "provider_thread.updated" &&
              JSON.stringify(event).includes(WAKE_TASK_ID),
          ),
        );
        assert.isFalse(yield* harness.hasPendingBackgroundWork);
      }).pipe(Effect.provide(Layer.merge(IdAllocator.layer, NodeServices.layer))),
    ),
  );

  it.effect("terminalizes an agent server wake from a positive task-notification result", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeWakeHarness;
        const now = yield* DateTime.now;
        const wakeText = "The background command completed.";

        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-agent-server-wake"),
            text: "Background task completed.",
            attachments: [],
            messageCreatedBy: "agent",
            messageCreationSource: "server",
          }),
        );
        yield* Queue.offer(
          harness.sdkMessages,
          makeAssistantTextFrame({
            uuid: "00000000-0000-4000-8000-00000000010b",
            text: wakeText,
          }),
        );
        yield* Queue.offer(
          harness.sdkMessages,
          makeResultFrame({
            uuid: "00000000-0000-4000-8000-00000000010c",
            result: wakeText,
            numTurns: 154,
            origin: { kind: "task-notification" },
          }),
        );
        yield* awaitUntil(() => harness.terminalEvents().length === 1, "server wake terminal");
        assert.equal(harness.terminalEvents()[0]?.status, "completed");

        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-agent-server-next"),
            text: "What finished?",
            attachments: [],
            providerTurnOrdinal: 2,
          }),
        );
        yield* Queue.offer(
          harness.sdkMessages,
          makeResultFrame({
            uuid: "00000000-0000-4000-8000-00000000010d",
            result: "The background command finished.",
          }),
        );
        yield* awaitUntil(() => harness.terminalEvents().length === 2, "queued turn terminal");
        assert.equal(harness.terminalEvents()[1]?.status, "completed");
      }).pipe(Effect.provide(Layer.merge(IdAllocator.layer, NodeServices.layer))),
    ),
  );

  it.effect("terminalizes a user mobile turn from a positive task-notification result", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeWakeHarness;
        const now = yield* DateTime.now;
        const fallbackText = "The ordinary mobile turn completed.";

        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-mobile-notif-origin"),
            text: "Complete this task.",
            attachments: [],
            messageCreationSource: "mobile",
          }),
        );
        yield* Queue.offer(
          harness.sdkMessages,
          makeResultFrame({
            uuid: "00000000-0000-4000-8000-00000000010e",
            result: fallbackText,
            numTurns: 60,
            origin: { kind: "task-notification" },
          }),
        );
        yield* awaitUntil(() => harness.terminalEvents().length === 1, "mobile turn terminal");
        assert.equal(harness.terminalEvents()[0]?.status, "completed");
        assert.isTrue(
          harness.events.some(
            (event) => event.type === "message.updated" && event.message.text === fallbackText,
          ),
        );
      }).pipe(Effect.provide(Layer.merge(IdAllocator.layer, NodeServices.layer))),
    ),
  );

  it.effect("ignores a zero-turn task-notification origin result during a normal user turn", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeWakeHarness;
        const now = yield* DateTime.now;
        const probeAssistantText = "Probe after stale task-notification result.";
        const recoveryAssistantText = "Recovered after the interrupt; continuing.";
        const staleResultText = STALE_TASK_NOTIFICATION_RESULT_TEXT;
        const hasMessageText = (text: string) =>
          harness.events.some(
            (event) => event.type === "message.updated" && event.message.text === text,
          );

        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-stale-notif-1"),
            text: "Continue after interrupt.",
            attachments: [],
          }),
        );
        yield* awaitUntil(() => harness.offeredMessages.length === 1, "recovery prompt offered");

        // Live interleaving seen after interrupt recovery: a stale stopped
        // task_notification and its task-notification-origin result arrive
        // before the real root assistant stream.
        yield* Queue.offer(
          harness.sdkMessages,
          claudeSdkFrame({
            type: "system",
            subtype: "task_notification",
            task_id: "task-stale-stopped",
            tool_use_id: "toolu-stale-stopped",
            status: "stopped",
            output_file: "/tmp/task-stale-stopped.log",
            summary: "",
            uuid: "00000000-0000-4000-8000-000000000107",
            session_id: WAKE_NATIVE_SESSION,
          }),
        );
        yield* Queue.offer(harness.sdkMessages, staleTaskNotificationResult);
        // Queue-ordered probe: once this assistant text is emitted, the stale
        // origin result ahead of it has been consumed.
        yield* Queue.offer(
          harness.sdkMessages,
          makeAssistantTextFrame({
            uuid: "00000000-0000-4000-8000-00000000010a",
            text: probeAssistantText,
          }),
        );

        yield* awaitUntil(
          () => hasMessageText(probeAssistantText),
          "probe assistant after stale task-notification result",
        );
        assert.lengthOf(harness.terminalEvents(), 0);
        assert.isFalse(hasMessageText(staleResultText));

        yield* Queue.offer(
          harness.sdkMessages,
          makeAssistantTextFrame({
            uuid: "00000000-0000-4000-8000-000000000108",
            text: recoveryAssistantText,
          }),
        );
        yield* Queue.offer(
          harness.sdkMessages,
          makeResultFrame({
            uuid: "00000000-0000-4000-8000-000000000109",
            result: recoveryAssistantText,
          }),
        );

        yield* awaitUntil(() => harness.terminalEvents().length === 1, "user turn terminal");
        assert.equal(harness.terminalEvents()[0]?.status, "completed");
        assert.isTrue(hasMessageText(recoveryAssistantText));
        assert.isFalse(hasMessageText(staleResultText));
      }).pipe(Effect.provide(Layer.merge(IdAllocator.layer, NodeServices.layer))),
    ),
  );

  it.effect("terminalizes a zero-turn task-notification result in a provider continuation", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeWakeHarness;
        const now = yield* DateTime.now;

        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-zero-continuation-1"),
            text: "Run the build in the background.",
            attachments: [],
          }),
        );
        yield* Queue.offer(harness.sdkMessages, wakeTaskStarted);
        yield* Queue.offer(harness.sdkMessages, turnOneResult);
        yield* awaitUntil(() => harness.terminalEvents().length === 1, "first turn terminal");
        yield* Queue.offer(harness.sdkMessages, wakeNotification);
        yield* Queue.offer(
          harness.sdkMessages,
          makeResultFrame({
            uuid: "00000000-0000-4000-8000-00000000010f",
            result: "Wake result with no model turns.",
            numTurns: 0,
            origin: { kind: "task-notification" },
          }),
        );
        yield* awaitUntil(() => harness.continuationRequests.length === 1, "continuation request");

        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-zero-continuation-2"),
            text: "Background task completed.",
            attachments: [],
            providerTurnOrdinal: 2,
            messageCreatedBy: "agent",
            messageCreationSource: "provider",
          }),
        );
        yield* awaitUntil(() => harness.terminalEvents().length === 2, "continuation terminal");
        assert.equal(harness.terminalEvents()[1]?.status, "completed");
      }).pipe(Effect.provide(Layer.merge(IdAllocator.layer, NodeServices.layer))),
    ),
  );

  it.effect(
    "emits one interrupted terminal for a positive task-notification result racing interrupt",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const closeGate = yield* Deferred.make<void>();
          const testScope = yield* Scope.Scope;
          yield* Scope.addFinalizer(testScope, Deferred.succeed(closeGate, undefined));
          const interruptStarted = yield* Deferred.make<void>();
          const harness = yield* makeWakeHarnessWithOptions({
            close: (sdkMessages) =>
              Deferred.await(closeGate).pipe(Effect.andThen(Queue.shutdown(sdkMessages))),
            interrupt: Deferred.succeed(interruptStarted, undefined),
          });
          const idAllocator = yield* IdAllocator.IdAllocatorV2;
          const now = yield* DateTime.now;
          const attemptId = RunAttemptId.make("attempt-claude-interrupt-positive-notif");
          const providerTurnId = idAllocator.derive.providerTurn({
            driver: ClaudeAdapterV2.CLAUDE_PROVIDER,
            nativeTurnId: `turn:${attemptId}`,
          });

          yield* harness.runtime.startTurn(
            makeClaudeTestTurnInput({
              threadId: harness.threadId,
              providerThread: harness.providerThread,
              now,
              attemptId,
              text: "Stop this task.",
              attachments: [],
            }),
          );
          yield* harness.runtime
            .interruptTurn({ providerThread: harness.providerThread, providerTurnId })
            .pipe(Effect.forkScoped);
          yield* Deferred.await(interruptStarted);
          yield* Queue.offer(
            harness.sdkMessages,
            makeResultFrame({
              uuid: "00000000-0000-4000-8000-000000000115",
              result: "Late result after interrupt.",
              numTurns: 7,
              origin: { kind: "task-notification" },
            }),
          );
          const terminalized = Exit.isSuccess(
            yield* awaitUntil(
              () => harness.terminalEvents().length === 1,
              "interrupted terminal",
            ).pipe(Effect.exit),
          );
          yield* Deferred.succeed(closeGate, undefined);
          assert.isTrue(terminalized);
          assert.equal(harness.terminalEvents()[0]?.status, "interrupted");
          assert.lengthOf(harness.terminalEvents(), 1);
        }).pipe(Effect.provide(Layer.merge(IdAllocator.layer, NodeServices.layer))),
      ),
  );

  it.effect("drops zero-turn task-notification debris racing interrupt", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const closeGate = yield* Deferred.make<void>();
        const testScope = yield* Scope.Scope;
        yield* Scope.addFinalizer(testScope, Deferred.succeed(closeGate, undefined));
        const interruptStarted = yield* Deferred.make<void>();
        const harness = yield* makeWakeHarnessWithOptions({
          close: (sdkMessages) =>
            Deferred.await(closeGate).pipe(Effect.andThen(Queue.shutdown(sdkMessages))),
          interrupt: Deferred.succeed(interruptStarted, undefined),
        });
        const idAllocator = yield* IdAllocator.IdAllocatorV2;
        const now = yield* DateTime.now;
        const attemptId = RunAttemptId.make("attempt-claude-interrupt-zero-notif");
        const providerTurnId = idAllocator.derive.providerTurn({
          driver: ClaudeAdapterV2.CLAUDE_PROVIDER,
          nativeTurnId: `turn:${attemptId}`,
        });
        const staleText = "Zero-turn debris must not leak.";

        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId,
            text: "Stop this task.",
            attachments: [],
          }),
        );
        yield* harness.runtime
          .interruptTurn({ providerThread: harness.providerThread, providerTurnId })
          .pipe(Effect.forkScoped);
        yield* Deferred.await(interruptStarted);
        yield* Queue.offer(
          harness.sdkMessages,
          makeResultFrame({
            uuid: "00000000-0000-4000-8000-000000000116",
            result: staleText,
            numTurns: 0,
            origin: { kind: "task-notification" },
          }),
        );
        let debrisYields = 0;
        yield* awaitUntil(() => debrisYields++ >= 50, "zero-turn debris consumed");
        yield* Deferred.succeed(closeGate, undefined);
        yield* awaitUntil(() => harness.terminalEvents().length === 1, "interrupted terminal");
        assert.lengthOf(harness.terminalEvents(), 1);
        assert.equal(harness.terminalEvents()[0]?.status, "interrupted");
        assert.isFalse(
          harness.events.some(
            (event) => event.type === "message.updated" && event.message.text === staleText,
          ),
        );
      }).pipe(Effect.provide(Layer.merge(IdAllocator.layer, NodeServices.layer))),
    ),
  );

  it.effect("fails a positive task-notification error result", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeWakeHarness;
        const now = yield* DateTime.now;

        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-positive-notif-error"),
            text: "Run the task.",
            attachments: [],
          }),
        );
        yield* Queue.offer(
          harness.sdkMessages,
          makeResultFrame({
            uuid: "00000000-0000-4000-8000-000000000117",
            result: "The task failed.",
            numTurns: 7,
            origin: { kind: "task-notification" },
            subtype: "error_during_execution",
            isError: true,
            errors: ["The task failed."],
          }),
        );
        yield* awaitUntil(() => harness.terminalEvents().length === 1, "failed terminal");
        assert.equal(harness.terminalEvents()[0]?.status, "failed");
      }).pipe(Effect.provide(Layer.merge(IdAllocator.layer, NodeServices.layer))),
    ),
  );

  it.effect("settles a continuation turn immediately when no wake output is buffered", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeWakeHarness;
        const now = yield* DateTime.now;

        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-wake-3"),
            text: "Background task completed.",
            attachments: [],
            messageCreatedBy: "agent",
            messageCreationSource: "provider",
          }),
        );

        yield* awaitUntil(() => harness.terminalEvents().length === 1, "spurious terminal");
        assert.equal(harness.terminalEvents()[0]?.status, "completed");
        assert.lengthOf(harness.offeredMessages, 0);
      }).pipe(Effect.provide(Layer.merge(IdAllocator.layer, NodeServices.layer))),
    ),
  );
});
