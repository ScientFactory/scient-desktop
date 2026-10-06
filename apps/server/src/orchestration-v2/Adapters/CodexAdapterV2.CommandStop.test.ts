import * as NodeServices from "@effect/platform-node/NodeServices";
import { RunAttemptId } from "@t3tools/contracts";
import { it, assert } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import { TestClock } from "effect/testing";
import * as IdAllocator from "../IdAllocator.ts";
import { type ProviderAdapterV2Event } from "../ProviderAdapter.ts";
import {
  makeCodexReplayTranscript,
  codexReplayPreamble,
  INTERRUPT_NATIVE_THREAD,
  INTERRUPT_NATIVE_TURN,
  INTERRUPT_PROMPT,
  interruptCommandItem,
  makeCodexReplayTurn,
  makeCodexReplayHarness,
  makeCodexTestTurnInput,
  awaitUntil,
  INTERRUPT_COMMAND,
} from "./CodexAdapterV2.fixture.ts";
import { describe } from "@effect/vitest";

describe("CodexAdapterV2 post-settle continuation", () => {
  const INTERRUPT_SCENARIO = "codex-interrupt-mid-command";

  const INTERRUPT_COMMAND_ITEM_TWO = "exec-codex-interrupt-command-two";

  const INTERRUPT_TIMEOUT_BOUNDARY_ITEM = "exec-codex-interrupt-timeout-boundary";

  const INTERRUPT_TIMEOUT_LATE_ITEM = "exec-codex-interrupt-timeout-late";

  const INTERRUPT_COMMAND_TWO = "bash -c 'sleep 20; echo SECOND_COMMAND'";

  const interruptMidCommandTranscript = makeCodexReplayTranscript({
    scenario: INTERRUPT_SCENARIO,
    entries: [
      ...codexReplayPreamble({
        nativeThreadId: INTERRUPT_NATIVE_THREAD,
        nativeTurnId: INTERRUPT_NATIVE_TURN,
        prompt: INTERRUPT_PROMPT,
      }),
      {
        type: "emit_inbound",
        label: "item/started/command",
        frame: {
          method: "item/started",
          params: {
            item: interruptCommandItem("inProgress"),
            threadId: INTERRUPT_NATIVE_THREAD,
            turnId: INTERRUPT_NATIVE_TURN,
            startedAtMs: 1782622440500,
          },
        },
      },
      {
        type: "expect_outbound",
        label: "turn/interrupt",
        frame: {
          id: 4,
          method: "turn/interrupt",
          params: {
            threadId: INTERRUPT_NATIVE_THREAD,
            turnId: INTERRUPT_NATIVE_TURN,
          },
        },
      },
      {
        type: "emit_inbound",
        label: "turn/interrupt",
        frame: { id: 4, result: {} },
      },
      {
        type: "emit_inbound",
        label: "item/started/command-two-after-interrupt-response",
        frame: {
          method: "item/started",
          params: {
            item: {
              ...interruptCommandItem("inProgress"),
              id: INTERRUPT_COMMAND_ITEM_TWO,
              command: INTERRUPT_COMMAND_TWO,
              processId: "57681",
              commandActions: [{ type: "unknown", command: INTERRUPT_COMMAND_TWO }],
            },
            threadId: INTERRUPT_NATIVE_THREAD,
            turnId: INTERRUPT_NATIVE_TURN,
            startedAtMs: 1782622440600,
          },
        },
      },
      {
        type: "emit_inbound",
        label: "turn/completed",
        frame: {
          method: "turn/completed",
          params: {
            threadId: INTERRUPT_NATIVE_THREAD,
            turn: makeCodexReplayTurn({
              id: INTERRUPT_NATIVE_TURN,
              status: "interrupted",
            }),
          },
        },
      },
      {
        type: "expect_outbound",
        label: "thread/backgroundTerminals/terminate/one",
        frame: {
          id: 5,
          method: "thread/backgroundTerminals/terminate",
          params: { threadId: INTERRUPT_NATIVE_THREAD, processId: "57680" },
        },
      },
      {
        type: "emit_inbound",
        label: "thread/backgroundTerminals/terminate/one",
        frame: { id: 5, result: { terminated: false } },
      },
      {
        type: "expect_outbound",
        label: "thread/backgroundTerminals/list/after-false",
        frame: {
          id: 6,
          method: "thread/backgroundTerminals/list",
          params: { threadId: INTERRUPT_NATIVE_THREAD },
        },
      },
      {
        type: "emit_inbound",
        label: "thread/backgroundTerminals/list/after-false",
        frame: { id: 6, result: { data: [], nextCursor: null } },
      },
      {
        type: "expect_outbound",
        label: "thread/backgroundTerminals/terminate/two",
        frame: {
          id: 7,
          method: "thread/backgroundTerminals/terminate",
          params: { threadId: INTERRUPT_NATIVE_THREAD, processId: "57681" },
        },
      },
      {
        type: "emit_inbound",
        label: "thread/backgroundTerminals/terminate/two",
        frame: { id: 7, result: { terminated: true } },
      },
      {
        type: "emit_inbound",
        label: "item/completed/command-late",
        afterMs: 30_000,
        frame: {
          method: "item/completed",
          params: {
            item: interruptCommandItem("completed"),
            threadId: INTERRUPT_NATIVE_THREAD,
            turnId: INTERRUPT_NATIVE_TURN,
            completedAtMs: 1782622465500,
          },
        },
      },
    ],
  });

  it.effect("contains commands that start before and after the interrupt response", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeCodexReplayHarness(interruptMidCommandTranscript);
        const now = yield* DateTime.now;

        yield* harness.runtime.startTurn(
          makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-codex-interrupt-mid-command"),
            text: INTERRUPT_PROMPT,
          }),
        );

        yield* awaitUntil(
          () =>
            harness.events.some(
              (event) =>
                event.type === "turn_item.updated" &&
                event.turnItem.type === "command_execution" &&
                event.turnItem.status === "running",
            ),
          "running command item",
        );

        const providerTurnId = harness.events.find(
          (event): event is Extract<ProviderAdapterV2Event, { type: "provider_turn.updated" }> =>
            event.type === "provider_turn.updated",
        )?.providerTurn.id;
        assert.isDefined(providerTurnId);

        yield* harness.runtime.interruptTurn({
          providerThread: harness.providerThread,
          providerTurnId,
        });

        yield* awaitUntil(() => harness.terminalEvents().length === 1, "interrupted terminal");
        assert.equal(harness.terminalEvents()[0]?.status, "interrupted");

        const terminalIndex = harness.events.findIndex((event) => event.type === "turn.terminal");
        assert.isAtLeast(terminalIndex, 0);

        let lastCommandBeforeTerminal:
          | Extract<ProviderAdapterV2Event, { type: "turn_item.updated" }>
          | undefined;
        for (let index = 0; index < terminalIndex; index++) {
          const event = harness.events[index];
          if (event?.type === "turn_item.updated" && event.turnItem.type === "command_execution") {
            lastCommandBeforeTerminal = event;
          }
        }
        assert.isDefined(lastCommandBeforeTerminal);
        assert.equal(lastCommandBeforeTerminal.turnItem.status, "interrupted");
        assert.isNotNull(lastCommandBeforeTerminal.turnItem.completedAt);

        const interruptedCommandsBeforeTerminal = harness.events
          .slice(0, terminalIndex)
          .flatMap((event) =>
            event.type === "turn_item.updated" &&
            event.turnItem.type === "command_execution" &&
            event.turnItem.status === "interrupted"
              ? [event.turnItem.input]
              : [],
          )
          .sort();
        assert.deepEqual(
          interruptedCommandsBeforeTerminal,
          [INTERRUPT_COMMAND, INTERRUPT_COMMAND_TWO].sort(),
        );

        const interruptedCommandIndex = harness.events.findIndex(
          (event, index) =>
            index < terminalIndex &&
            event.type === "turn_item.updated" &&
            event.turnItem.type === "command_execution" &&
            event.turnItem.status === "interrupted",
        );
        assert.isAbove(
          terminalIndex,
          interruptedCommandIndex,
          "command terminalization must precede turn.terminal",
        );

        assert.isFalse(yield* harness.hasPendingBackgroundWork);
        assert.lengthOf(harness.continuationRequests, 0);

        // Late provider item/completed after interrupt must not revive the card
        // or request a background-command wake continuation.
        yield* TestClock.adjust("30 seconds");
        for (let attempt = 0; attempt < 100; attempt++) {
          yield* Effect.yieldNow;
        }
        assert.lengthOf(harness.continuationRequests, 0);
        assert.isFalse(yield* harness.hasPendingBackgroundWork);
        assert.lengthOf(harness.terminalEvents(), 1);

        const postTerminalCommandUpdates = harness.events.filter(
          (event, index) =>
            index > terminalIndex &&
            event.type === "turn_item.updated" &&
            event.turnItem.type === "command_execution",
        );
        assert.lengthOf(
          postTerminalCommandUpdates,
          0,
          "late item/completed after interrupt must not project",
        );

        const commandUpdates = harness.events.filter(
          (event): event is Extract<ProviderAdapterV2Event, { type: "turn_item.updated" }> =>
            event.type === "turn_item.updated" && event.turnItem.type === "command_execution",
        );
        assert.isAtLeast(commandUpdates.length, 2, "start + interrupt terminalization");
        assert.equal(commandUpdates[commandUpdates.length - 1]?.turnItem.status, "interrupted");
      }).pipe(Effect.provide(Layer.merge(IdAllocator.layer, NodeServices.layer))),
    ),
  );

  const interruptTimeoutTranscript = makeCodexReplayTranscript({
    scenario: "codex-interrupt-timeout",
    entries: [
      ...codexReplayPreamble({
        nativeThreadId: INTERRUPT_NATIVE_THREAD,
        nativeTurnId: INTERRUPT_NATIVE_TURN,
        prompt: INTERRUPT_PROMPT,
      }),
      {
        type: "emit_inbound",
        label: "item/started/command",
        frame: {
          method: "item/started",
          params: {
            item: interruptCommandItem("inProgress"),
            threadId: INTERRUPT_NATIVE_THREAD,
            turnId: INTERRUPT_NATIVE_TURN,
            startedAtMs: 1782622440500,
          },
        },
      },
      {
        type: "expect_outbound",
        label: "turn/interrupt",
        frame: {
          id: 4,
          method: "turn/interrupt",
          params: {
            threadId: INTERRUPT_NATIVE_THREAD,
            turnId: INTERRUPT_NATIVE_TURN,
          },
        },
      },
      {
        type: "emit_inbound",
        label: "turn/interrupt",
        frame: { id: 4, result: {} },
      },
      {
        type: "emit_inbound",
        label: "item/started/command-two-after-interrupt-response",
        frame: {
          method: "item/started",
          params: {
            item: {
              ...interruptCommandItem("inProgress"),
              id: INTERRUPT_COMMAND_ITEM_TWO,
              command: INTERRUPT_COMMAND_TWO,
              processId: "57681",
              commandActions: [{ type: "unknown", command: INTERRUPT_COMMAND_TWO }],
            },
            threadId: INTERRUPT_NATIVE_THREAD,
            turnId: INTERRUPT_NATIVE_TURN,
            startedAtMs: 1782622440600,
          },
        },
      },
      {
        type: "expect_outbound",
        label: "thread/backgroundTerminals/terminate/one",
        frame: {
          id: 5,
          method: "thread/backgroundTerminals/terminate",
          params: { threadId: INTERRUPT_NATIVE_THREAD, processId: "57680" },
        },
      },
      {
        type: "emit_inbound",
        label: "thread/backgroundTerminals/terminate/one",
        frame: { id: 5, result: { terminated: true } },
      },
      {
        type: "emit_inbound",
        label: "item/started/command-at-timeout-boundary",
        afterMs: 9_999,
        frame: {
          method: "item/started",
          params: {
            item: {
              ...interruptCommandItem("inProgress"),
              id: INTERRUPT_TIMEOUT_BOUNDARY_ITEM,
              command: "echo TIMEOUT_BOUNDARY",
              processId: null,
              commandActions: [{ type: "unknown", command: "echo TIMEOUT_BOUNDARY" }],
            },
            threadId: INTERRUPT_NATIVE_THREAD,
            turnId: INTERRUPT_NATIVE_TURN,
            startedAtMs: 1782622450500,
          },
        },
      },
      {
        type: "expect_outbound",
        label: "thread/backgroundTerminals/terminate/two",
        frame: {
          id: 6,
          method: "thread/backgroundTerminals/terminate",
          params: { threadId: INTERRUPT_NATIVE_THREAD, processId: "57681" },
        },
      },
      {
        type: "emit_inbound",
        label: "thread/backgroundTerminals/terminate/two",
        frame: { id: 6, result: { terminated: true } },
      },
      {
        type: "emit_inbound",
        label: "turn/completed/late",
        afterMs: 20_000,
        frame: {
          method: "turn/completed",
          params: {
            threadId: INTERRUPT_NATIVE_THREAD,
            turn: makeCodexReplayTurn({
              id: INTERRUPT_NATIVE_TURN,
              status: "interrupted",
            }),
          },
        },
      },
      {
        type: "emit_inbound",
        label: "item/started/command-after-timeout",
        frame: {
          method: "item/started",
          params: {
            item: {
              ...interruptCommandItem("inProgress"),
              id: INTERRUPT_TIMEOUT_LATE_ITEM,
              command: "echo LATE_AFTER_TIMEOUT",
              processId: null,
              commandActions: [{ type: "unknown", command: "echo LATE_AFTER_TIMEOUT" }],
            },
            threadId: INTERRUPT_NATIVE_THREAD,
            turnId: INTERRUPT_NATIVE_TURN,
            startedAtMs: 1782622470500,
          },
        },
      },
      {
        type: "emit_inbound",
        label: "item/completed/command-late",
        frame: {
          method: "item/completed",
          params: {
            item: interruptCommandItem("completed"),
            threadId: INTERRUPT_NATIVE_THREAD,
            turnId: INTERRUPT_NATIVE_TURN,
            completedAtMs: 1782622465500,
          },
        },
      },
      { type: "runtime_exit", status: "success" },
    ],
  });

  it.effect("bounds interrupt settlement and drops late completion events", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeCodexReplayHarness(interruptTimeoutTranscript);
        const now = yield* DateTime.now;

        yield* harness.runtime.startTurn(
          makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-codex-interrupt-timeout"),
            text: INTERRUPT_PROMPT,
          }),
        );
        yield* awaitUntil(
          () =>
            harness.events.filter(
              (event) =>
                event.type === "turn_item.updated" &&
                event.turnItem.type === "command_execution" &&
                event.turnItem.status === "running",
            ).length === 1,
          "running command item",
        );
        const providerTurnId = harness.events.find(
          (event): event is Extract<ProviderAdapterV2Event, { type: "provider_turn.updated" }> =>
            event.type === "provider_turn.updated",
        )?.providerTurn.id;
        assert.isDefined(providerTurnId);

        const interruptFiber = yield* harness.runtime
          .interruptTurn({
            providerThread: harness.providerThread,
            providerTurnId,
          })
          .pipe(Effect.forkScoped);
        yield* awaitUntil(
          () =>
            harness.events.filter(
              (event) =>
                event.type === "turn_item.updated" &&
                event.turnItem.type === "command_execution" &&
                event.turnItem.status === "running",
            ).length === 2,
          "post-interrupt running command item",
        );

        yield* TestClock.adjust("10 seconds");
        yield* Fiber.join(interruptFiber);
        yield* awaitUntil(() => harness.terminalEvents().length === 1, "timeout terminal");
        assert.equal(harness.terminalEvents()[0]?.status, "interrupted");
        const terminalProviderTurnsBeforeLateEvents = harness.events.filter(
          (event) =>
            event.type === "provider_turn.updated" && event.providerTurn.status === "interrupted",
        );
        assert.lengthOf(terminalProviderTurnsBeforeLateEvents, 1);

        const commandUpdatesBeforeLateEvents = harness.events.filter(
          (event): event is Extract<ProviderAdapterV2Event, { type: "turn_item.updated" }> =>
            event.type === "turn_item.updated" && event.turnItem.type === "command_execution",
        );
        const terminalCommands = commandUpdatesBeforeLateEvents.filter(
          (event) =>
            event.turnItem.status === "interrupted" &&
            event.turnItem.nativeItemRef?.nativeId !== INTERRUPT_TIMEOUT_BOUNDARY_ITEM,
        );
        assert.lengthOf(terminalCommands, 2);
        const boundaryUpdates = commandUpdatesBeforeLateEvents.filter(
          (event) => event.turnItem.nativeItemRef?.nativeId === INTERRUPT_TIMEOUT_BOUNDARY_ITEM,
        );
        const lastBoundaryUpdate = boundaryUpdates.at(-1);
        assert.isDefined(lastBoundaryUpdate);
        assert.equal(lastBoundaryUpdate.turnItem.status, "interrupted");
        assert.isFalse(yield* harness.hasPendingBackgroundWork);

        yield* TestClock.adjust("20 seconds");
        for (let attempt = 0; attempt < 100; attempt++) {
          yield* Effect.yieldNow;
        }
        assert.lengthOf(harness.terminalEvents(), 1);
        assert.lengthOf(
          harness.events.filter(
            (event) =>
              event.type === "provider_turn.updated" && event.providerTurn.status === "interrupted",
          ),
          terminalProviderTurnsBeforeLateEvents.length,
          "late completion must not duplicate provider-turn finalization",
        );
        assert.lengthOf(
          harness.events.filter(
            (event) =>
              event.type === "turn_item.updated" && event.turnItem.type === "command_execution",
          ),
          commandUpdatesBeforeLateEvents.length,
          "late starts and completions must not project after timeout",
        );
      }).pipe(Effect.provide(Layer.merge(IdAllocator.layer, NodeServices.layer))),
    ),
  );

  const interruptTerminationFailureTranscript = makeCodexReplayTranscript({
    scenario: "codex-interrupt-termination-failure",
    entries: [
      ...interruptMidCommandTranscript.entries
        .filter(
          (entry) => entry.type === "runtime_exit" || entry.label !== "item/completed/command-late",
        )
        .map((entry) =>
          entry.type === "emit_inbound" &&
          entry.label === "thread/backgroundTerminals/list/after-false"
            ? {
                ...entry,
                frame: {
                  id: 6,
                  result: {
                    data: [{ processId: "57680" }],
                    nextCursor: null,
                  },
                },
              }
            : entry,
        ),
      {
        type: "expect_outbound",
        label: "thread/backgroundTerminals/terminate/one-retry",
        frame: {
          id: 8,
          method: "thread/backgroundTerminals/terminate",
          params: { threadId: INTERRUPT_NATIVE_THREAD, processId: "57680" },
        },
      },
      {
        type: "emit_inbound",
        label: "thread/backgroundTerminals/terminate/one-retry",
        frame: { id: 8, result: { terminated: false } },
      },
      {
        type: "expect_outbound",
        label: "thread/backgroundTerminals/list/after-false-retry",
        frame: {
          id: 9,
          method: "thread/backgroundTerminals/list",
          params: { threadId: INTERRUPT_NATIVE_THREAD },
        },
      },
      {
        type: "emit_inbound",
        label: "thread/backgroundTerminals/list/after-false-retry",
        frame: {
          id: 9,
          result: { data: [{ processId: "57680" }], nextCursor: null },
        },
      },
      { type: "runtime_exit", status: "success" },
    ],
  });

  it.effect("attempts every terminal and cleans up tracking when termination fails", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeCodexReplayHarness(interruptTerminationFailureTranscript);
        const now = yield* DateTime.now;

        yield* harness.runtime.startTurn(
          makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-codex-interrupt-termination-failure"),
            text: INTERRUPT_PROMPT,
          }),
        );
        yield* awaitUntil(
          () =>
            harness.events.some(
              (event) =>
                event.type === "turn_item.updated" &&
                event.turnItem.type === "command_execution" &&
                event.turnItem.status === "running",
            ),
          "running command item",
        );
        const providerTurnId = harness.events.find(
          (event): event is Extract<ProviderAdapterV2Event, { type: "provider_turn.updated" }> =>
            event.type === "provider_turn.updated",
        )?.providerTurn.id;
        assert.isDefined(providerTurnId);

        const interruptExit = yield* harness.runtime
          .interruptTurn({
            providerThread: harness.providerThread,
            providerTurnId,
          })
          .pipe(Effect.exit);

        assert.equal(interruptExit._tag, "Failure");
        yield* awaitUntil(() => harness.terminalEvents().length === 1, "interrupted terminal");
        assert.equal(harness.terminalEvents()[0]?.status, "interrupted");
        assert.isFalse(yield* harness.hasPendingBackgroundWork);
      }).pipe(Effect.provide(Layer.merge(IdAllocator.layer, NodeServices.layer))),
    ),
  );

  for (const scenario of [
    {
      name: "usage",
      code: "usageLimitExceeded",
      notification: false,
      expectedClass: "usage_limit",
    },
    { name: "rate", code: "rateLimitExceeded", notification: false, expectedClass: "usage_limit" },
    {
      name: "ordinary",
      code: "contextWindowExceeded",
      notification: false,
      expectedClass: "provider_error",
    },
    {
      name: "notification",
      code: "usageLimitExceeded",
      notification: true,
      expectedClass: "usage_limit",
    },
    {
      name: "replacement",
      code: "usageLimitExceeded",
      notification: true,
      expectedClass: "provider_error",
    },
    {
      name: "known-reset",
      code: "usageLimitExceeded",
      notification: false,
      expectedClass: "usage_limit",
    },
    {
      name: "late-reset",
      code: "usageLimitExceeded",
      notification: false,
      expectedClass: "usage_limit",
    },
    {
      name: "matching-details",
      code: "usageLimitExceeded",
      notification: true,
      expectedClass: "usage_limit",
    },
    {
      name: "deferred-reset",
      code: "usageLimitExceeded",
      notification: false,
      expectedClass: "usage_limit",
    },
    { name: "retry", code: "usageLimitExceeded", notification: true, expectedClass: "usage_limit" },
  ] as const) {
    it.effect(`classifies Codex terminal failures from ${scenario.name} evidence`, () =>
      Effect.scoped(
        Effect.gen(function* () {
          const nativeThreadId = `native-limit-${scenario.name}`;
          const nativeTurnId = `turn-limit-${scenario.name}`;
          const message = "Provider stopped this request.";
          const resetAt = "2033-05-19T07:20:00.000Z";
          const snapshot = {
            type: "emit_inbound" as const,
            label: "account/rateLimits/updated",
            frame: {
              method: "account/rateLimits/updated",
              params: {
                rateLimits: {
                  limitId: "codex",
                  primary: { usedPercent: 100, resetsAt: 2000100000, windowDurationMins: 300 },
                },
              },
            },
          };
          const transcript = makeCodexReplayTranscript({
            scenario: `codex-limit-${scenario.name}`,
            entries: [
              ...codexReplayPreamble({ nativeThreadId, nativeTurnId, prompt: "Continue." }),
              ...(scenario.name === "known-reset" || scenario.name === "deferred-reset"
                ? [snapshot]
                : []),
              ...(scenario.name === "deferred-reset"
                ? [
                    {
                      type: "emit_inbound" as const,
                      label: "item/completed/subAgentActivity-started",
                      frame: {
                        method: "item/completed",
                        params: {
                          threadId: nativeThreadId,
                          turnId: nativeTurnId,
                          item: {
                            type: "subAgentActivity",
                            id: "limit-child-spawn",
                            kind: "started",
                            agentThreadId: "native-limit-child",
                            agentPath: "/root/limit_child",
                          },
                        },
                      },
                    },
                    {
                      type: "emit_inbound" as const,
                      label: "turn/started/child",
                      frame: {
                        method: "turn/started",
                        params: {
                          threadId: "native-limit-child",
                          turn: makeCodexReplayTurn({
                            id: "limit-child-turn",
                            status: "inProgress",
                          }),
                        },
                      },
                    },
                  ]
                : []),
              ...(scenario.notification
                ? [
                    {
                      type: "emit_inbound" as const,
                      label: "error",
                      frame: {
                        method: "error",
                        params: {
                          threadId: nativeThreadId,
                          turnId: nativeTurnId,
                          willRetry: scenario.name === "retry",
                          error: {
                            message,
                            codexErrorInfo: scenario.code,
                            additionalDetails:
                              scenario.name === "matching-details"
                                ? "Detailed provider allowance explanation."
                                : null,
                          },
                        },
                      },
                    },
                  ]
                : []),
              {
                type: "emit_inbound",
                label: "turn/completed",
                frame: {
                  method: "turn/completed",
                  params: {
                    threadId: nativeThreadId,
                    turn: {
                      ...makeCodexReplayTurn({ id: nativeTurnId, status: "failed" }),
                      error: {
                        message: scenario.name === "replacement" ? "A different failure." : message,
                        ...(scenario.notification && scenario.name !== "matching-details"
                          ? {}
                          : { codexErrorInfo: scenario.code }),
                      },
                    },
                  },
                },
              },
              ...(scenario.name === "late-reset" ? [snapshot] : []),
              ...(scenario.name === "deferred-reset"
                ? [
                    {
                      ...snapshot,
                      frame: {
                        method: "account/rateLimits/updated",
                        params: {
                          rateLimits: {
                            limitId: "codex",
                            primary: {
                              usedPercent: 100,
                              resetsAt: 2000200000,
                              windowDurationMins: 300,
                            },
                          },
                        },
                      },
                    },
                    {
                      type: "emit_inbound" as const,
                      label: "turn/completed/child",
                      frame: {
                        method: "turn/completed",
                        params: {
                          threadId: "native-limit-child",
                          turn: makeCodexReplayTurn({
                            id: "limit-child-turn",
                            status: "completed",
                          }),
                        },
                      },
                    },
                  ]
                : []),
            ],
          });
          const resetReceipt = yield* Deferred.make<void>();
          const harness = yield* makeCodexReplayHarness(transcript, (event) =>
            event.type === "turn_item.updated" &&
            event.turnItem.type === "error" &&
            event.turnItem.failure.resetAt === resetAt
              ? Deferred.succeed(resetReceipt, undefined)
              : Effect.void,
          );
          yield* harness.runtime.startTurn(
            makeCodexTestTurnInput({
              threadId: harness.threadId,
              providerThread: harness.providerThread,
              now: yield* DateTime.now,
              text: "Continue.",
              attemptId: RunAttemptId.make(`attempt-limit-${scenario.name}`),
            }),
          );
          yield* harness.firstTerminal;
          const terminal = harness.terminalEvents()[0];
          assert.equal(terminal?.status, "failed");
          if (terminal?.status !== "failed") return;
          assert.equal(terminal.failure.class, scenario.expectedClass);
          assert.equal(terminal.threadDisposition, "reusable");
          if (scenario.name === "known-reset" || scenario.name === "deferred-reset")
            assert.equal(terminal.failure.resetAt, resetAt);
          if (scenario.name === "matching-details")
            assert.equal(terminal.failure.message, "Detailed provider allowance explanation.");
          if (scenario.name === "late-reset") {
            yield* Deferred.await(resetReceipt);
            const item = harness.events.find(
              (event) =>
                event.type === "turn_item.updated" &&
                event.turnItem.type === "error" &&
                event.turnItem.failure.resetAt === resetAt,
            );
            assert.isDefined(item);
          }
          if (scenario.name === "retry") assert.equal(terminal.retry?.attempt, 1);
        }).pipe(Effect.provide(Layer.merge(IdAllocator.layer, NodeServices.layer))),
      ),
    );
  }
});
