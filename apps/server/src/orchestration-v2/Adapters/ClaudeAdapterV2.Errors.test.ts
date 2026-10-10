import * as NodeServices from "@effect/platform-node/NodeServices";
import { RunAttemptId } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import { ProviderAdapterV2RuntimePolicy } from "@t3tools/provider-core/server/ProviderAdapter";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import {
  makeWakeHarness,
  claudeSdkFrame,
  WAKE_NATIVE_SESSION,
  makeResultFrame,
  makeWakeHarnessWithOptions,
  awaitUntil,
  makeAssistantErrorFrame,
  makeAssistantTextFrame,
} from "./ClaudeAdapterV2.wake.testkit.ts";
import { makeClaudeTestTurnInput } from "./ClaudeAdapterV2.fixture.ts";
describe("ClaudeAdapterV2 background wake turns", () => {
  it.effect("announces usage-limit pauses once per window and again on a new turn", () =>
    Effect.gen(function* () {
      const harness = yield* makeWakeHarness;
      const now = yield* DateTime.now;
      const resetsAt = Math.floor(DateTime.toEpochMillis(now) / 1000) + 7_200;
      const limit = (rateLimitType: "five_hour" | "seven_day" = "five_hour") =>
        claudeSdkFrame({
          type: "rate_limit_event",
          rate_limit_info: { status: "rejected", rateLimitType, resetsAt },
          uuid: "00000000-0000-4000-8000-000000000601",
          session_id: WAKE_NATIVE_SESSION,
        });
      const start = (ordinal: number) =>
        harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make(`attempt-claude-limit-${ordinal}`),
            providerTurnOrdinal: ordinal,
            text: "Continue.",
            attachments: [],
          }),
        );
      yield* start(1);
      yield* Queue.offer(harness.sdkMessages, limit());
      const pause = (yield* Queue.take(harness.systemNoticeReceipts)).turnItem;
      assert.equal(pause.type, "system_notice");
      if (pause.type !== "system_notice") return;
      assert.equal(
        pause.message,
        "Claude usage limit reached. This turn is paused until the 5-hour limit resets in 2h.",
      );
      assert.lengthOf(harness.terminalEvents(), 0);
      yield* Queue.offerAll(harness.sdkMessages, [
        limit(),
        limit("seven_day"),
        limit(),
        makeResultFrame({
          uuid: "00000000-0000-4000-8000-000000000602",
          result: "Recovered.",
        }),
      ]);
      yield* Queue.take(harness.terminalReceipts);
      const notices = () =>
        harness.events.flatMap((event) =>
          event.type === "turn_item.updated" && event.turnItem.type === "system_notice"
            ? [event.turnItem]
            : [],
        );
      assert.lengthOf(notices(), 2);
      yield* start(2);
      yield* Queue.offerAll(harness.sdkMessages, [
        limit(),
        makeResultFrame({
          uuid: "00000000-0000-4000-8000-000000000603",
          result: "Done.",
        }),
      ]);
      yield* Queue.take(harness.terminalReceipts);
      assert.lengthOf(notices(), 3);
      assert.notEqual(notices()[0]?.id, notices()[2]?.id);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(IdAllocator.layer, NodeServices.layer, McpProviderSessions.layer),
      ),
    ),
  );

  it.effect("keeps usage warnings and provisioned overage silent", () =>
    Effect.gen(function* () {
      const harness = yield* makeWakeHarness;
      const now = yield* DateTime.now;
      yield* harness.runtime.startTurn(
        makeClaudeTestTurnInput({
          threadId: harness.threadId,
          providerThread: harness.providerThread,
          now,
          attemptId: RunAttemptId.make("attempt-claude-overage"),
          text: "Continue.",
          attachments: [],
        }),
      );
      for (const rate_limit_info of [
        { status: "allowed_warning" },
        { status: "rejected", overageStatus: "allowed" },
        { status: "rejected", overageStatus: "allowed_warning" },
        { status: "rejected", isUsingOverage: true },
        { status: "rejected", overageInUse: true },
      ]) {
        yield* Queue.offer(
          harness.sdkMessages,
          claudeSdkFrame({
            type: "rate_limit_event",
            rate_limit_info,
            session_id: WAKE_NATIVE_SESSION,
            uuid: "00000000-0000-4000-8000-000000000604",
          }),
        );
      }
      yield* Queue.offer(
        harness.sdkMessages,
        makeResultFrame({
          uuid: "00000000-0000-4000-8000-000000000605",
          result: "Done.",
        }),
      );
      yield* Queue.take(harness.terminalReceipts);
      assert.isFalse(
        harness.events.some(
          (event) => event.type === "turn_item.updated" && event.turnItem.type === "system_notice",
        ),
      );
    }).pipe(
      Effect.provide(
        Layer.mergeAll(IdAllocator.layer, NodeServices.layer, McpProviderSessions.layer),
      ),
    ),
  );

  it.effect.each([
    "OAuth access token has been revoked",
    "OAuth session expired and could not be refreshed",
    "Failed to authenticate. API Error: 401 OAuth access token has been revoked.",
  ])("retires the exact native query after authoritative auth failure: %s", (error) =>
    Effect.gen(function* () {
      const closed = yield* Deferred.make<void>();
      let closeCount = 0;
      const harness = yield* makeWakeHarnessWithOptions({
        close: () =>
          Effect.sync(() => {
            closeCount += 1;
          }).pipe(Effect.andThen(Deferred.succeed(closed, undefined))),
      });
      yield* harness.runtime.startTurn(
        makeClaudeTestTurnInput({
          threadId: harness.threadId,
          providerThread: harness.providerThread,
          now: yield* DateTime.now,
          attemptId: RunAttemptId.make("auth-revoked"),
          text: "Continue",
          attachments: [],
        }),
      );
      yield* Queue.offer(
        harness.sdkMessages,
        makeResultFrame({
          uuid: "00000000-0000-4000-8000-000000000608",
          result: "",
          subtype: "error_during_execution",
          isError: true,
          errors: [error],
          terminalReason: "api_error",
        }),
      );
      const terminal = yield* Queue.take(harness.terminalReceipts);
      assert.equal(terminal.status, "failed");
      yield* Deferred.await(closed);
      yield* awaitUntil(
        () =>
          harness.events.some(
            (event) =>
              event.type === "provider_session.updated" &&
              event.providerSession.status === "stopped",
          ),
        "retired native session",
      );
      const controls = harness.events.filter(
        (event) => event.type === "authentication.invalidated",
      );
      assert.equal(controls.length, 1);
      assert.equal(harness.terminalEvents().length, 1);
      const terminalIndex = harness.events.indexOf(terminal);
      assert.isBelow(
        terminalIndex,
        harness.events.findIndex((event) => event.type === "authentication.invalidated"),
      );
      assert.isBelow(
        harness.events.findIndex((event) => event.type === "authentication.invalidated"),
        harness.events.findIndex(
          (event) =>
            event.type === "provider_session.updated" && event.providerSession.status === "stopped",
        ),
      );
      assert.equal(closeCount, 1);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(IdAllocator.layer, NodeServices.layer, McpProviderSessions.layer),
      ),
    ),
  );

  it.effect.each([
    { subtype: "error_during_execution", error: "HTTP 401 Unauthorized" },
    { subtype: "success", error: "OAuth access token has been revoked" },
  ])(
    "does not invalidate account state for non-authoritative result $subtype/$error",
    ({ subtype, error }) =>
      Effect.gen(function* () {
        let closeCount = 0;
        const harness = yield* makeWakeHarnessWithOptions({
          close: () =>
            Effect.sync(() => {
              closeCount += 1;
            }),
        });
        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now: yield* DateTime.now,
            attemptId: RunAttemptId.make("auth-nonauthoritative"),
            text: "Continue",
            attachments: [],
          }),
        );
        const submittedUuid = harness.offeredMessages.at(-1)?.uuid;
        if (submittedUuid === undefined) return yield* Effect.die("Missing native prompt identity");
        yield* harness.offerAndWait(
          makeResultFrame({
            uuid: "00000000-0000-4000-8000-000000000609",
            result: error,
            subtype,
            isError: subtype !== "success",
            errors: [error],
            userMessageUuid: submittedUuid,
          }),
        );
        yield* Queue.take(harness.terminalReceipts);
        assert.equal(harness.terminalEvents().length, 1);
        assert.isFalse(harness.events.some((event) => event.type === "authentication.invalidated"));
        assert.equal(closeCount, 0);
        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now: yield* DateTime.now,
            attemptId: RunAttemptId.make("auth-nonauthoritative-recovery"),
            providerTurnOrdinal: 2,
            text: "Continue after the unrelated failure",
            attachments: [],
          }),
        );
        const recoveryUuid = harness.offeredMessages.at(-1)?.uuid;
        assert.notEqual(recoveryUuid, submittedUuid);
        if (recoveryUuid === undefined)
          return yield* Effect.die("Missing recovery prompt identity");
        yield* harness.offerAndWait(
          makeResultFrame({
            uuid: "00000000-0000-4000-8000-000000000610",
            result: "Recovered on the same query.",
            userMessageUuid: recoveryUuid,
          }),
        );
        assert.equal((yield* Queue.take(harness.terminalReceipts)).status, "completed");
        assert.equal(harness.terminalEvents().length, 2);
        assert.equal(closeCount, 0);
        assert.isFalse(harness.events.some((event) => event.type === "authentication.invalidated"));
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, NodeServices.layer, McpProviderSessions.layer),
        ),
      ),
  );

  it.effect("names an expired Claude login instead of the terminal API error", () =>
    Effect.gen(function* () {
      const configDir = "/synthetic/Claude config";
      const cwd = "/synthetic/project";
      const harness = yield* makeWakeHarnessWithOptions({
        environment: { CLAUDE_CONFIG_DIR: configDir },
      });
      const now = yield* DateTime.now;
      yield* harness.runtime.startTurn(
        makeClaudeTestTurnInput({
          threadId: harness.threadId,
          providerThread: harness.providerThread,
          now,
          attemptId: RunAttemptId.make("attempt-claude-auth-failure"),
          text: "Continue.",
          attachments: [],
          runtimePolicy: ProviderAdapterV2RuntimePolicy.make({
            runtimeMode: "full-access",
            interactionMode: "default",
            cwd,
          }),
        }),
      );
      yield* Queue.offerAll(harness.sdkMessages, [
        makeAssistantErrorFrame({
          uuid: "00000000-0000-4000-8000-000000000606",
          error: "authentication_failed",
        }),
        makeResultFrame({
          uuid: "00000000-0000-4000-8000-000000000607",
          result: "API Error",
          terminalReason: "api_error",
        }),
      ]);

      const terminal = yield* Queue.take(harness.terminalReceipts);
      assert.equal(terminal.status, "failed");
      if (terminal.status !== "failed") return;
      assert.include(terminal.failure.message, "run `claude auth login`");
      assert.include(terminal.failure.message, configDir);
      assert.include(terminal.failure.message, cwd);
      assert.notInclude(terminal.failure.message, "repeated API errors");
    }).pipe(
      Effect.provide(
        Layer.mergeAll(IdAllocator.layer, NodeServices.layer, McpProviderSessions.layer),
      ),
    ),
  );

  it.effect.each([
    { recovered: false, expected: "Claude usage limit reached" },
    { recovered: true, expected: "Claude gave up after repeated API errors" },
  ])("tracks whether a rejected usage window recovered ($recovered)", ({ recovered, expected }) =>
    Effect.gen(function* () {
      const harness = yield* makeWakeHarness;
      const now = yield* DateTime.now;
      yield* harness.runtime.startTurn(
        makeClaudeTestTurnInput({
          threadId: harness.threadId,
          providerThread: harness.providerThread,
          now,
          attemptId: RunAttemptId.make(`attempt-claude-window-${recovered}`),
          text: "Continue.",
          attachments: [],
        }),
      );
      yield* Queue.offer(
        harness.sdkMessages,
        claudeSdkFrame({
          type: "rate_limit_event",
          rate_limit_info: { status: "rejected", rateLimitType: "five_hour" },
          uuid: "00000000-0000-4000-8000-000000000608",
          session_id: WAKE_NATIVE_SESSION,
        }),
      );
      if (recovered) {
        yield* Queue.offer(
          harness.sdkMessages,
          claudeSdkFrame({
            type: "rate_limit_event",
            rate_limit_info: { status: "allowed", rateLimitType: "five_hour" },
            uuid: "00000000-0000-4000-8000-000000000609",
            session_id: WAKE_NATIVE_SESSION,
          }),
        );
      }
      yield* Queue.offer(
        harness.sdkMessages,
        makeResultFrame({
          uuid: "00000000-0000-4000-8000-000000000610",
          result: "API Error",
          terminalReason: "api_error",
        }),
      );

      const terminal = yield* Queue.take(harness.terminalReceipts);
      assert.equal(terminal.status, "failed");
      if (terminal.status !== "failed") return;
      assert.include(terminal.failure.message, expected);
      assert.equal(terminal.failure.class, recovered ? "provider_error" : "usage_limit");
    }).pipe(
      Effect.provide(
        Layer.mergeAll(IdAllocator.layer, NodeServices.layer, McpProviderSessions.layer),
      ),
    ),
  );

  it.effect.each([
    { name: "parent limit", parentErrors: ["rate_limit"], expectedLimit: true },
    {
      name: "parent limit then nested response",
      parentErrors: ["rate_limit", "nested-ok"],
      expectedLimit: true,
    },
    { name: "nested limit", parentErrors: ["nested-limit"], expectedLimit: false },
    {
      name: "parent limit then parent response",
      parentErrors: ["rate_limit", "ok"],
      expectedLimit: false,
    },
  ])("classifies retried terminal API failures after $name", ({ parentErrors, expectedLimit }) =>
    Effect.gen(function* () {
      const harness = yield* makeWakeHarness;
      const now = yield* DateTime.now;
      yield* harness.runtime.startTurn(
        makeClaudeTestTurnInput({
          threadId: harness.threadId,
          providerThread: harness.providerThread,
          now,
          attemptId: RunAttemptId.make(`attempt-claude-retry-${parentErrors.join("-")}`),
          text: "Continue.",
          attachments: [],
        }),
      );
      for (const [index, evidence] of parentErrors.entries()) {
        yield* Queue.offer(
          harness.sdkMessages,
          makeAssistantErrorFrame({
            uuid: `00000000-0000-4000-8000-00000000062${index}`,
            error: evidence.includes("limit") ? "rate_limit" : undefined,
            parentToolUseId: evidence.startsWith("nested") ? "nested-tool" : null,
          }),
        );
      }
      yield* Queue.offer(
        harness.sdkMessages,
        makeResultFrame({
          uuid: "00000000-0000-4000-8000-000000000629",
          result: "API Error",
          isError: true,
          terminalReason: "api_error",
        }),
      );

      const terminal = yield* Queue.take(harness.terminalReceipts);
      assert.equal(terminal.status, "failed");
      if (terminal.status !== "failed") return;
      assert.equal(terminal.failure.class, expectedLimit ? "usage_limit" : "provider_error");
      assert.equal(
        terminal.failure.message,
        expectedLimit
          ? "Claude usage limit reached. Send the message again once the limit resets."
          : "Claude gave up after repeated API errors.",
      );
    }).pipe(
      Effect.provide(
        Layer.mergeAll(IdAllocator.layer, NodeServices.layer, McpProviderSessions.layer),
      ),
    ),
  );

  it.effect.each([429, 401, 529])(
    "classifies the current Claude API status %s after rate-limit evidence",
    (apiErrorStatus) =>
      Effect.gen(function* () {
        const harness = yield* makeWakeHarness;
        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now: yield* DateTime.now,
            attemptId: RunAttemptId.make(`attempt-status-${apiErrorStatus}`),
            text: "Continue.",
            attachments: [],
          }),
        );
        yield* Queue.offer(
          harness.sdkMessages,
          makeAssistantErrorFrame({
            uuid: "00000000-0000-4000-8000-000000000650",
            error: "rate_limit",
          }),
        );
        yield* Queue.offer(
          harness.sdkMessages,
          makeResultFrame({
            uuid: "00000000-0000-4000-8000-000000000651",
            result: "API Error",
            terminalReason: "api_error",
            isError: true,
            apiErrorStatus,
          }),
        );
        const terminal = yield* Queue.take(harness.terminalReceipts);
        assert.equal(terminal.status, "failed");
        if (terminal.status !== "failed") return;
        assert.equal(
          terminal.failure.class,
          apiErrorStatus === 429 ? "usage_limit" : "provider_error",
        );
        if (apiErrorStatus !== 429)
          assert.notInclude(terminal.failure.message.toLowerCase(), "usage limit");
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, NodeServices.layer, McpProviderSessions.layer),
        ),
      ),
  );

  it.effect("resolves API retries on resumed assistant activity", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeWakeHarness;
        const now = yield* DateTime.now;
        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-api-retry"),
            text: "Open github.com.",
            attachments: [],
          }),
        );

        yield* Queue.offer(
          harness.sdkMessages,
          claudeSdkFrame({
            type: "system",
            subtype: "api_retry",
            attempt: 2,
            max_retries: 10,
            retry_delay_ms: 1_500,
            error_status: 529,
            error: "overloaded",
            uuid: "00000000-0000-4000-8000-000000000201",
            session_id: WAKE_NATIVE_SESSION,
          }),
        );
        const retryItems = () =>
          harness.events.flatMap((event) =>
            event.type === "turn_item.updated" &&
            event.turnItem.type === "error" &&
            event.turnItem.retry !== undefined
              ? [event.turnItem]
              : [],
          );
        yield* awaitUntil(() => retryItems().length === 1, "Claude retry item");
        const runningRetry = retryItems()[0];
        assert.equal(runningRetry?.status, "running");
        assert.equal(runningRetry?.failure.code, "api_error_529");
        assert.deepEqual(runningRetry?.retry, {
          attempt: 2,
          maxAttempts: 10,
          retryDelayMs: 1_500,
        });

        yield* Queue.offer(
          harness.sdkMessages,
          makeAssistantTextFrame({
            uuid: "00000000-0000-4000-8000-000000000202",
            text: "Opening GitHub.",
          }),
        );
        yield* awaitUntil(() => retryItems().length === 2, "resolved Claude retry item");
        assert.lengthOf(harness.terminalEvents(), 0);
        const recoveredRetry = retryItems()[1];
        assert.equal(recoveredRetry?.id, runningRetry?.id);
        assert.equal(recoveredRetry?.status, "completed");
        assert.equal(recoveredRetry?.title, "Provider recovered");

        yield* Queue.offer(
          harness.sdkMessages,
          makeResultFrame({
            uuid: "00000000-0000-4000-8000-000000000203",
            result: "Opened GitHub.",
          }),
        );
        yield* awaitUntil(() => harness.terminalEvents().length === 1, "recovered Claude turn");
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, NodeServices.layer, McpProviderSessions.layer),
        ),
      ),
    ),
  );

  it.effect("carries exhausted retry progress into the terminal provider error", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeWakeHarness;
        const now = yield* DateTime.now;
        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-api-retry-exhausted"),
            text: "Open github.com.",
            attachments: [],
          }),
        );
        yield* Queue.offer(
          harness.sdkMessages,
          claudeSdkFrame({
            type: "system",
            subtype: "api_retry",
            attempt: 10,
            max_retries: 10,
            retry_delay_ms: 38_010,
            error_status: 529,
            error: "overloaded",
            uuid: "00000000-0000-4000-8000-000000000203",
            session_id: WAKE_NATIVE_SESSION,
          }),
        );
        yield* Queue.offer(
          harness.sdkMessages,
          makeResultFrame({
            uuid: "00000000-0000-4000-8000-000000000204",
            result: "Claude is temporarily overloaded.",
            isError: true,
            apiErrorStatus: 529,
          }),
        );
        yield* awaitUntil(() => harness.terminalEvents().length === 1, "failed Claude turn");

        const terminal = harness.terminalEvents()[0];
        assert.equal(terminal?.status, "failed");
        if (terminal?.status !== "failed") return;
        assert.deepEqual(terminal.retry, {
          attempt: 10,
          maxAttempts: 10,
          retryDelayMs: 38_010,
        });
        assert.isDefined(terminal.retryStartedAt);
        assert.equal(terminal.failure.code, "api_error_529");
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, NodeServices.layer, McpProviderSessions.layer),
        ),
      ),
    ),
  );

  it.effect.each(
    (
      [
        "api_error",
        "malformed_tool_use_exhausted",
        "budget_exhausted",
        "structured_output_retry_exhausted",
        "tool_deferred_unavailable",
        "turn_setup_failed",
        "blocking_limit",
        "rapid_refill_breaker",
        "prompt_too_long",
        "image_error",
        "model_error",
        "overloaded_status",
      ] as const
    ).map((terminalReason) => ({
      caseTitle: `fails a success-shaped Claude result with ${terminalReason}`,
      terminalReason,
    })),
  )("$caseTitle", ({ terminalReason }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeWakeHarness;
        const now = yield* DateTime.now;
        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-structured-terminal-failure"),
            text: "Complete the task.",
            attachments: [],
          }),
        );
        yield* Queue.offer(
          harness.sdkMessages,
          makeResultFrame({
            uuid: "00000000-0000-4000-8000-000000000205",
            result: "Provider failure details.",
            isError: false,
            ...(terminalReason === "overloaded_status"
              ? { apiErrorStatus: 529 }
              : { terminalReason }),
          }),
        );
        const terminal = yield* Queue.take(harness.terminalReceipts);
        assert.equal(terminal.status, "failed");
        if (terminal.status !== "failed") return;
        assert.isNotEmpty(terminal.failure.message);
        assert.equal(
          terminal.failure.class,
          terminalReason === "blocking_limit" ? "usage_limit" : "provider_error",
        );
        assert.isFalse(
          harness.events.some(
            (event) =>
              event.type === "message.updated" &&
              event.message.text === "Provider failure details.",
          ),
        );
        assert.equal(
          terminal.failure.code,
          terminalReason === "overloaded_status" ? "api_error_529" : terminalReason,
        );
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, NodeServices.layer, McpProviderSessions.layer),
        ),
      ),
    ),
  );
});
