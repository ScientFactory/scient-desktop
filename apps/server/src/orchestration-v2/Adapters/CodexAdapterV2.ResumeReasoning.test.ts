import * as NodeServices from "@effect/platform-node/NodeServices";
import { RunAttemptId, RunId } from "@t3tools/contracts";
import { it, assert } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { buildRuntimeInstructions } from "../../provider/RuntimeInstructions.ts";
import { buildScientAwareness } from "../../provider/ScientAwareness.ts";
import * as IdAllocator from "../IdAllocator.ts";
import * as CodexAdapterV2 from "./CodexAdapterV2.ts";
import {
  codexReplayPreamble,
  makeCodexReplayTranscript,
  makeCodexReplayHarness,
  CODEX_TEST_MODEL_SELECTION,
  CODEX_TEST_RUNTIME_POLICY,
  makeCodexReplayTurn,
  makeCodexTestTurnInput,
  awaitUntil,
  assistantMessages,
} from "./CodexAdapterV2.replay.testkit.ts";
import { describe } from "@effect/vitest";

describe("CodexAdapterV2 post-settle continuation", () => {
  it.effect("resumes a provider thread without requesting or decoding its history", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const scenario = "codex-resume-metadata";
        const nativeThreadId = `native-${scenario}-thread`;
        const preamble = codexReplayPreamble({
          nativeThreadId,
          nativeTurnId: "unused-turn",
          prompt: "unused-prompt",
        }).slice(0, 5);
        const transcript = makeCodexReplayTranscript({
          scenario,
          entries: [
            ...preamble,
            {
              type: "expect_outbound",
              label: "thread/resume",
              frame: {
                id: 3,
                method: "thread/resume",
                params: {
                  threadId: nativeThreadId,
                  excludeTurns: true,
                  config: CodexAdapterV2.CODEX_THREAD_CONFIG,
                },
              },
            },
            {
              type: "emit_inbound",
              label: "thread/resume",
              frame: { id: 3, result: { thread: { id: nativeThreadId, updatedAt: 1782622450 } } },
            },
          ],
        });
        const harness = yield* makeCodexReplayHarness(transcript);
        const resumed = yield* harness.runtime.resumeThread({
          providerThread: harness.providerThread,
          modelSelection: CODEX_TEST_MODEL_SELECTION,
          runtimePolicy: CODEX_TEST_RUNTIME_POLICY,
        });

        assert.equal(resumed.nativeThreadRef?.nativeId, nativeThreadId);
        assert.equal(resumed.status, "idle");
        assert.equal(DateTime.toEpochMillis(resumed.updatedAt), 1782622450000);
      }).pipe(Effect.provide(Layer.merge(IdAllocator.layer, NodeServices.layer))),
    ),
  );

  it.effect("continues an interrupted native thread with empty input and reasoning summaries", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const scenario = "codex-restart-promptless";
        const nativeThreadId = "native-restart-promptless";
        const nativeTurnId = "turn-restart-promptless";
        const preamble = codexReplayPreamble({
          nativeThreadId,
          nativeTurnId,
          prompt: "unused",
        }).slice(0, 5);
        const transcript = makeCodexReplayTranscript({
          scenario,
          entries: [
            ...preamble,
            {
              type: "expect_outbound",
              label: "resume",
              frame: {
                id: 3,
                method: "thread/resume",
                params: {
                  threadId: nativeThreadId,
                  excludeTurns: true,
                  config: CodexAdapterV2.CODEX_THREAD_CONFIG,
                },
              },
            },
            {
              type: "emit_inbound",
              label: "resume",
              frame: { id: 3, result: { thread: { id: nativeThreadId, updatedAt: 1782622450 } } },
            },
            {
              type: "expect_outbound",
              label: "continue",
              frame: {
                id: 4,
                method: "turn/start",
                params: {
                  threadId: nativeThreadId,
                  input: [],
                  cwd: "/workspace",
                  model: "gpt-5.4",
                  approvalPolicy: "never",
                  approvalsReviewer: "user",
                  sandboxPolicy: { type: "dangerFullAccess" },
                  summary: "detailed",
                  additionalContext: {
                    t3_code_runtime: {
                      kind: "application",
                      value: buildRuntimeInstructions({
                        harness: "Codex",
                        model: "gpt-5.4",
                        reasoningEffort: "medium",
                      }),
                    },
                    scient_awareness: { kind: "application", value: buildScientAwareness() },
                  },
                },
              },
            },
            {
              type: "emit_inbound",
              label: "continue",
              frame: {
                id: 4,
                result: { turn: makeCodexReplayTurn({ id: nativeTurnId, status: "inProgress" }) },
              },
            },
          ],
        });
        const harness = yield* makeCodexReplayHarness(transcript);
        const resumed = yield* harness.runtime.resumeThread({
          providerThread: harness.providerThread,
          modelSelection: CODEX_TEST_MODEL_SELECTION,
          runtimePolicy: CODEX_TEST_RUNTIME_POLICY,
        });
        yield* harness.runtime.startTurn({
          ...makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: resumed,
            now: yield* DateTime.now,
            attemptId: RunAttemptId.make("attempt-restart-promptless"),
            text: "Continue where you left off.",
          }),
          restartContinuationOfRunId: RunId.make("run-before-restart"),
        });
        assert.equal(resumed.nativeThreadRef?.nativeId, nativeThreadId);
      }).pipe(Effect.provide(Layer.merge(IdAllocator.layer, NodeServices.layer))),
    ),
  );

  it.effect("resolves retryable app-server errors on resumed provider activity", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const scenario = "codex-provider-api-retry";
        const nativeThreadId = `native-${scenario}-thread`;
        const nativeTurnId = `native-${scenario}-turn`;
        const transcript = makeCodexReplayTranscript({
          scenario,
          entries: [
            ...codexReplayPreamble({
              nativeThreadId,
              nativeTurnId,
              prompt: "Open github.com.",
            }),
            {
              type: "emit_inbound",
              label: "error/retry",
              frame: {
                method: "error",
                params: {
                  threadId: nativeThreadId,
                  turnId: nativeTurnId,
                  willRetry: true,
                  error: {
                    message: "Reconnecting... 2/5",
                    additionalDetails: "The response stream disconnected.",
                    codexErrorInfo: {
                      responseStreamDisconnected: { httpStatusCode: 529 },
                    },
                  },
                },
              },
            },
            {
              type: "emit_inbound",
              label: "item/started/after-retry",
              frame: {
                method: "item/started",
                params: {
                  threadId: nativeThreadId,
                  turnId: nativeTurnId,
                  startedAtMs: 1782622445000,
                  item: {
                    type: "commandExecution",
                    id: "command-after-provider-retry",
                    command: "pwd",
                    cwd: "/workspace",
                    processId: "42",
                    source: "unifiedExecStartup",
                    status: "inProgress",
                    commandActions: [{ type: "unknown", command: "pwd" }],
                    aggregatedOutput: null,
                    exitCode: null,
                    durationMs: null,
                  },
                },
              },
            },
            {
              type: "emit_inbound",
              label: "item/completed/after-retry",
              frame: {
                method: "item/completed",
                params: {
                  threadId: nativeThreadId,
                  turnId: nativeTurnId,
                  completedAtMs: 1782622445010,
                  item: {
                    type: "commandExecution",
                    id: "command-after-provider-retry",
                    command: "pwd",
                    cwd: "/workspace",
                    processId: "42",
                    source: "unifiedExecStartup",
                    status: "completed",
                    commandActions: [{ type: "unknown", command: "pwd" }],
                    aggregatedOutput: "/workspace\n",
                    exitCode: 0,
                    durationMs: 10,
                  },
                },
              },
            },
            {
              type: "emit_inbound",
              label: "turn/completed",
              frame: {
                method: "turn/completed",
                params: {
                  threadId: nativeThreadId,
                  turn: makeCodexReplayTurn({ id: nativeTurnId, status: "completed" }),
                },
              },
            },
          ],
        });
        const harness = yield* makeCodexReplayHarness(transcript);
        const now = yield* DateTime.now;
        yield* harness.runtime.startTurn(
          makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-codex-provider-api-retry"),
            text: "Open github.com.",
          }),
        );
        yield* awaitUntil(() => harness.terminalEvents().length === 1, "Codex retry recovery");

        const retryItems = harness.events.flatMap((event) =>
          event.type === "turn_item.updated" &&
          event.turnItem.type === "error" &&
          event.turnItem.retry !== undefined
            ? [event.turnItem]
            : [],
        );
        assert.lengthOf(retryItems, 2);
        assert.equal(retryItems[0]?.status, "running");
        assert.equal(retryItems[0]?.failure.code, "responseStreamDisconnected");
        assert.deepEqual(retryItems[0]?.retry, {
          attempt: 2,
          maxAttempts: 5,
          retryDelayMs: null,
        });
        assert.equal(retryItems[1]?.id, retryItems[0]?.id);
        assert.equal(retryItems[1]?.status, "completed");
        assert.equal(retryItems[1]?.title, "Provider recovered");

        const recoveredIndex = harness.events.findIndex(
          (event) =>
            event.type === "turn_item.updated" &&
            event.turnItem.type === "error" &&
            event.turnItem.status === "completed",
        );
        const resumedCommandIndex = harness.events.findIndex(
          (event) =>
            event.type === "turn_item.updated" &&
            event.turnItem.type === "command_execution" &&
            event.turnItem.input === "pwd",
        );
        const terminalIndex = harness.events.findIndex((event) => event.type === "turn.terminal");
        assert.isAtLeast(recoveredIndex, 0);
        assert.isAbove(resumedCommandIndex, recoveredIndex);
        assert.isAbove(terminalIndex, resumedCommandIndex);
      }).pipe(Effect.provide(Layer.merge(IdAllocator.layer, NodeServices.layer))),
    ),
  );

  it.effect("stamps Codex items with their own start time, not the turn's", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const scenario = "codex-item-start-times";
        const nativeThreadId = `native-${scenario}-thread`;
        const nativeTurnId = `native-${scenario}-turn`;
        const commandLifecycle = (id: string, startedAtMs: number) =>
          (["started", "completed"] as const).map((phase) => ({
            type: "emit_inbound" as const,
            label: `item/${phase}/${id}`,
            frame: {
              method: `item/${phase}`,
              params: {
                threadId: nativeThreadId,
                turnId: nativeTurnId,
                ...(phase === "started" ? { startedAtMs } : { completedAtMs: startedAtMs + 10 }),
                item: {
                  type: "commandExecution",
                  id,
                  command: "pwd",
                  cwd: "/workspace",
                  processId: "42",
                  source: "unifiedExecStartup",
                  status: phase === "started" ? "inProgress" : "completed",
                  commandActions: [{ type: "unknown", command: "pwd" }],
                  aggregatedOutput: phase === "started" ? null : "/workspace\n",
                  exitCode: phase === "started" ? null : 0,
                  durationMs: phase === "started" ? null : 10,
                },
              },
            },
          }));
        const transcript = makeCodexReplayTranscript({
          scenario,
          entries: [
            ...codexReplayPreamble({ nativeThreadId, nativeTurnId, prompt: "Run two commands." }),
            ...commandLifecycle("first-command", 1782622445000),
            ...commandLifecycle("second-command", 1782622505000),
            ...(["started", "completed"] as const).map((phase) => ({
              type: "emit_inbound" as const,
              label: `item/${phase}/compaction`,
              frame: {
                method: `item/${phase}`,
                params: {
                  threadId: nativeThreadId,
                  turnId: nativeTurnId,
                  ...(phase === "started"
                    ? { startedAtMs: 1782622565000 }
                    : { completedAtMs: 1782622575000 }),
                  item: { type: "contextCompaction", id: "compaction" },
                },
              },
            })),
            {
              type: "emit_inbound",
              label: "turn/completed",
              frame: {
                method: "turn/completed",
                params: {
                  threadId: nativeThreadId,
                  turn: makeCodexReplayTurn({ id: nativeTurnId, status: "completed" }),
                },
              },
            },
          ],
        });
        const harness = yield* makeCodexReplayHarness(transcript);
        yield* harness.runtime.startTurn(
          makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now: yield* DateTime.now,
            attemptId: RunAttemptId.make("attempt-codex-item-start-times"),
            text: "Run two commands.",
          }),
        );
        yield* awaitUntil(() => harness.terminalEvents().length === 1, "Codex item start times");

        const startedAtByItem = harness.events.flatMap((event) =>
          event.type === "turn_item.updated" &&
          (event.turnItem.type === "command_execution" || event.turnItem.type === "compaction")
            ? [[event.turnItem.nativeItemRef?.nativeId, event.turnItem.startedAt] as const]
            : [],
        );
        assert.deepEqual(
          startedAtByItem.map(([id, startedAt]) => [id, startedAt?.epochMilliseconds]),
          [
            ["first-command", 1782622445000],
            ["first-command", 1782622445000],
            ["second-command", 1782622505000],
            ["second-command", 1782622505000],
            ["compaction", 1782622565000],
            ["compaction", 1782622565000],
          ],
        );
      }).pipe(Effect.provide(Layer.merge(IdAllocator.layer, NodeServices.layer))),
    ),
  );

  it.effect.each(
    (["completed", "interrupted"] as const).map((terminalStatus) => ({
      caseTitle: `retains Codex reasoning parts when the turn is ${terminalStatus}`,
      terminalStatus,
    })),
  )("$caseTitle", ({ terminalStatus }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const scenario = `codex-reasoning-${terminalStatus}`;
        const nativeThreadId = `native-${scenario}-thread`;
        const nativeTurnId = `native-${scenario}-turn`;
        const prompt = "Explain the check.";
        const transcript = makeCodexReplayTranscript({
          scenario,
          entries: [
            ...codexReplayPreamble({ nativeThreadId, nativeTurnId, prompt }),
            ...[
              {
                method: "item/reasoning/summaryTextDelta",
                params: { itemId: "thought", summaryIndex: 0, delta: "Summary " },
              },
              {
                method: "item/reasoning/summaryTextDelta",
                params: { itemId: "thought", summaryIndex: 0, delta: "one" },
              },
              {
                method: "item/reasoning/summaryTextDelta",
                params: { itemId: "thought", summaryIndex: 1, delta: "Summary two" },
              },
              {
                method: "item/reasoning/textDelta",
                params: { itemId: "thought", contentIndex: 0, delta: "Raw trace" },
              },
              {
                method: "item/completed",
                params: {
                  item: {
                    type: "commandExecution",
                    id: "after-thought",
                    command: "pwd",
                    cwd: "/workspace",
                    processId: "42",
                    source: "unifiedExecStartup",
                    status: "completed",
                    commandActions: [{ type: "unknown", command: "pwd" }],
                    aggregatedOutput: "/workspace",
                    exitCode: 0,
                    durationMs: 1,
                  },
                },
              },
              ...(terminalStatus === "completed"
                ? [
                    {
                      method: "item/completed",
                      params: {
                        item: {
                          type: "reasoning",
                          id: "thought",
                          summary: ["Final summary one", "Summary two"],
                          content: ["Raw trace"],
                        },
                      },
                    },
                    {
                      method: "item/completed",
                      params: {
                        item: {
                          type: "reasoning",
                          id: "completion-only",
                          summary: ["Completion without deltas"],
                          content: [],
                        },
                      },
                    },
                    {
                      method: "item/reasoning/textDelta",
                      params: {
                        itemId: "delta-only",
                        contentIndex: 0,
                        delta: "Retained when completion omits content",
                      },
                    },
                    {
                      method: "item/completed",
                      params: {
                        item: { type: "reasoning", id: "delta-only", summary: [], content: [] },
                      },
                    },
                  ]
                : []),
            ].map((event, index) => ({
              type: "emit_inbound" as const,
              label: `reasoning-${index}`,
              frame: {
                method: event.method,
                params: { threadId: nativeThreadId, turnId: nativeTurnId, ...event.params },
              },
            })),
            {
              type: "emit_inbound",
              label: "turn/completed",
              frame: {
                method: "turn/completed",
                params: {
                  threadId: nativeThreadId,
                  turn: makeCodexReplayTurn({ id: nativeTurnId, status: terminalStatus }),
                },
              },
            },
          ],
        });
        const harness = yield* makeCodexReplayHarness(transcript);
        yield* harness.runtime.startTurn(
          makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now: yield* DateTime.now,
            attemptId: RunAttemptId.make(`attempt-${scenario}`),
            text: prompt,
          }),
        );
        yield* harness.firstTerminal;
        const latest = new Map(
          harness.events.flatMap((event) =>
            event.type === "turn_item.updated" && event.turnItem.type === "reasoning"
              ? [[event.turnItem.id, event.turnItem] as const]
              : [],
          ),
        );
        assert.deepEqual(
          [...latest.values()].map((item) => item.text),
          terminalStatus === "completed"
            ? [
                "Final summary one",
                "Summary two",
                "Raw trace",
                "Completion without deltas",
                "Retained when completion omits content",
              ]
            : ["Summary one", "Summary two", "Raw trace"],
        );
        assert.isTrue([...latest.values()].every((item) => item.status === terminalStatus));
        assert.isTrue([...latest.values()].every((item) => item.streaming === false));
        assert.isTrue(
          [...latest.values()].every((item) => item.runId !== null && item.providerTurnId !== null),
        );
        assert.equal(new Set([...latest.values()].map((item) => item.ordinal)).size, latest.size);
        const command = harness.events.find(
          (event) =>
            event.type === "turn_item.updated" && event.turnItem.type === "command_execution",
        );
        assert.isDefined(command);
        if (command?.type === "turn_item.updated") {
          assert.isTrue(
            [...latest.values()]
              .slice(0, 3)
              .every((item) => item.ordinal < command.turnItem.ordinal),
          );
        }
        assert.deepEqual(assistantMessages(harness.events), []);
      }).pipe(Effect.provide(Layer.merge(IdAllocator.layer, NodeServices.layer))),
    ),
  );
});
