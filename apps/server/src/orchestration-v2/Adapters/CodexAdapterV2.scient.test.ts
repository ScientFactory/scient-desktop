import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  RunAttemptId,
  ProviderThreadId,
  ProviderTurnId,
  ThreadId,
  MessageId,
} from "@t3tools/contracts";
import { it, assert } from "@effect/vitest";
import * as CodexReplay from "effect-codex-app-server/replay";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";
import { ChildProcess } from "effect/process";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import { type ProviderAdapterV2Event } from "@t3tools/provider-core/server/ProviderAdapter";
import * as CodexAdapterV2 from "./CodexAdapterV2.ts";
import {
  makeCodexReplayTranscript,
  codexReplayPreamble,
  makeCodexReplayTurn,
  makeCodexReplayHarness,
  makeCodexTestTurnInput,
  awaitUntil,
  CODEX_TEST_MODEL_SELECTION,
  encodeUnknownJson,
} from "./CodexAdapterV2.replay.testkit.ts";
import { describe } from "@effect/vitest";
import { ProviderInstanceId, ProviderSessionId } from "@t3tools/contracts";
import {
  DEFAULT_CODEX_SETTINGS,
  CODEX_TEST_RUNTIME_POLICY,
} from "./CodexAdapterV2.replay.testkit.ts";
import {
  INTERRUPT_NATIVE_THREAD,
  INTERRUPT_NATIVE_TURN,
  INTERRUPT_PROMPT,
  interruptCommandItem,
} from "./CodexAdapterV2.replay.testkit.ts";
import { assistantMessages } from "./CodexAdapterV2.replay.testkit.ts";
import { type OrchestrationV2ProviderTurn, NodeId, EnvironmentId } from "@t3tools/contracts";
import { ProviderAdapterForkThreadError } from "@t3tools/provider-core/server/ProviderAdapter";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { SpawnExecutableResolution } from "@t3tools/shared/shell";
import * as Path from "effect/Path";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { type OrchestrationV2ProviderThread } from "@t3tools/contracts";
import { RunId } from "@t3tools/contracts";
import { buildScientRuntimeInstructions } from "../../provider/ScientRuntimeInstructions.ts";
import { buildScientAwareness } from "../../provider/ScientAwareness.ts";
import { historyResponseItems } from "@t3tools/provider-core/server/handoffBudget";
// Scient's CodexAdapterV2 cases: native guidance and compaction, Scient MCP namespace and fork
// refusal, captured Stop, capacity, citations and media. Upstream's own cases live in
// CodexAdapterV2.test.ts.
import { ProviderCitationPresentation, type ModelSelection } from "@t3tools/contracts";
import { ProviderAdapterTurnStartError } from "@t3tools/provider-core/server/ProviderAdapter";
import * as CodexSchema from "effect-codex-app-server/schema";
import { HttpServer } from "effect/http";
import * as Logger from "effect/Logger";
import * as NetAddress from "effect/net/NetAddress";
import { resolveAttachmentPath } from "../../attachmentStore.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import type { McpCapability } from "../../mcp/McpInvocationContext.ts";
import * as McpSessionRegistry from "../../mcp/McpSessionRegistry.ts";
import { layerMemory as SqlitePersistenceMemory } from "../../persistence/Sqlite.ts";
import { SCIENT_ORCHESTRATION_INSTRUCTIONS } from "../../provider/ScientProviderInstructions.ts";
import * as EventSink from "../EventSink.ts";
import * as EventStore from "../EventStore.ts";
import * as ProjectionStore from "../ProjectionStore.ts";
import * as ProviderEventIngestor from "../ProviderEventIngestor.ts";
import * as ProviderInstanceRegistry from "../../provider/ProviderInstanceRegistry.ts";
import { layerGitVcsDriverWithoutBranches } from "../testkit/ProviderRuntimeTestServices.ts";
import * as ThreadCommandExecutor from "../ThreadCommandExecutor.ts";

describe("CodexAdapterV2 post-settle continuation (Background)", () => {
  it.effect.each(
    [false, true].map((rejected) => ({
      caseTitle: `preserves a newer unrelated root during a captured Stop ${rejected ? "rejection" : "success"}`,
      rejected,
    })),
  )("$caseTitle", ({ rejected }) => {
    let sessionCloses = 0;
    return Effect.scoped(
      Effect.gen(function* () {
        const nativeThreadId = "captured-stop-native-thread";
        const oldNativeTurnId = "native-1";
        const newNativeTurnId = "native-2";
        const prompt = "Start an independent root.";
        const preamble = codexReplayPreamble({
          nativeThreadId,
          nativeTurnId: oldNativeTurnId,
          prompt,
        });
        const startEntry = preamble.find(
          (entry) => entry.type === "expect_outbound" && entry.label === "turn/start",
        );
        if (startEntry?.type !== "expect_outbound" || !Predicate.isObject(startEntry.frame)) {
          return yield* Effect.die("Missing exact native turn/start replay expectation.");
        }
        const interruptRequested = yield* Deferred.make<void>();
        const responseParked = yield* Deferred.make<void>();
        const releaseResponse = yield* Deferred.make<void>();
        yield* Effect.addFinalizer(() => Deferred.succeed(releaseResponse, undefined));
        const transcript = makeCodexReplayTranscript({
          scenario: `captured-stop-unrelated-root-${rejected ? "rejected" : "accepted"}`,
          entries: [
            ...preamble,
            {
              type: "expect_outbound",
              label: "captured interrupt",
              frame: {
                id: 4,
                method: "turn/interrupt",
                params: { threadId: nativeThreadId, turnId: oldNativeTurnId },
              },
            },
            {
              type: "expect_outbound",
              label: "independent root start",
              frame: { ...startEntry.frame, id: 5 },
            },
            {
              type: "emit_inbound",
              label: "independent root accepted",
              frame: {
                id: 5,
                result: {
                  turn: makeCodexReplayTurn({ id: newNativeTurnId, status: "inProgress" }),
                },
              },
            },
            {
              type: "emit_inbound",
              label: "independent root started",
              frame: {
                method: "turn/started",
                params: {
                  threadId: nativeThreadId,
                  turn: makeCodexReplayTurn({ id: newNativeTurnId, status: "inProgress" }),
                },
              },
            },
            {
              type: "emit_inbound",
              label: "held captured interrupt response",
              frame: rejected
                ? {
                    id: 4,
                    error: { code: -32_000, message: "captured native-1 interrupt rejected" },
                  }
                : { id: 4, result: {} },
            },
            ...(!rejected
              ? [
                  {
                    type: "emit_inbound" as const,
                    label: "old root completed",
                    frame: {
                      method: "turn/completed",
                      params: {
                        threadId: nativeThreadId,
                        turn: makeCodexReplayTurn({
                          id: oldNativeTurnId,
                          status: "interrupted",
                        }),
                      },
                    },
                  },
                ]
              : []),
            {
              type: "expect_outbound",
              label: "new root still steerable",
              frame: {
                id: 6,
                method: "turn/steer",
                params: {
                  threadId: nativeThreadId,
                  expectedTurnId: newNativeTurnId,
                  input: [{ type: "text", text: "Continue the independent root." }],
                },
              },
            },
            {
              type: "emit_inbound",
              label: "new root steer acknowledged",
              frame: { id: 6, result: { turnId: newNativeTurnId } },
            },
            {
              type: "emit_inbound",
              label: "new root completed normally",
              frame: {
                method: "turn/completed",
                params: {
                  threadId: nativeThreadId,
                  turn: makeCodexReplayTurn({ id: newNativeTurnId, status: "completed" }),
                },
              },
            },
          ],
        });
        const driver = yield* CodexReplay.makeReplayDriver(transcript, {
          beforeEmitInbound: (entry) =>
            entry.label === "held captured interrupt response"
              ? Deferred.succeed(responseParked, undefined).pipe(
                  Effect.andThen(Deferred.await(releaseResponse)),
                )
              : Effect.void,
        });
        const requests: Array<{ method: string; params: unknown }> = [];
        const harness = yield* makeCodexReplayHarness(
          transcript,
          undefined,
          (method, params) =>
            Effect.sync(() => {
              requests.push({ method, params });
            }).pipe(
              Effect.andThen(
                method === "turn/interrupt"
                  ? Deferred.succeed(interruptRequested, undefined)
                  : Effect.void,
              ),
              Effect.asVoid,
            ),
          undefined,
          undefined,
          undefined,
          {
            replayDriver: driver,
            onSessionClose: () =>
              Effect.sync(() => {
                sessionCloses++;
              }),
          },
        );
        const oldInput = makeCodexTestTurnInput({
          threadId: harness.threadId,
          providerThread: harness.providerThread,
          now: yield* DateTime.now,
          attemptId: RunAttemptId.make("captured-stop-old-attempt"),
          text: prompt,
        });
        const newInput = {
          ...makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now: yield* DateTime.now,
            attemptId: RunAttemptId.make("captured-stop-independent-attempt"),
            text: prompt,
          }),
          runOrdinal: 2,
          providerTurnOrdinal: 2,
        };
        assert.notEqual(newInput.rootNodeId, oldInput.rootNodeId);
        assert.notEqual(newInput.runId, oldInput.runId);
        assert.isNull(newInput.appThread.lineage.parentThreadId);
        yield* harness.runtime.startTurn(oldInput);
        const providerTurns = () =>
          harness.events.filter(
            (event): event is Extract<ProviderAdapterV2Event, { type: "provider_turn.updated" }> =>
              event.type === "provider_turn.updated",
          );
        yield* awaitUntil(
          () =>
            providerTurns().some(
              (event) => event.providerTurn.nativeTurnRef?.nativeId === oldNativeTurnId,
            ),
          "old native root receipt",
        );
        const oldTurn = providerTurns().find(
          (event) => event.providerTurn.nativeTurnRef?.nativeId === oldNativeTurnId,
        )!.providerTurn;
        const stopInput = {
          providerThread: harness.providerThread,
          providerTurnId: oldTurn.id,
        };
        const stopFiber = yield* harness.runtime
          .interruptTurn(stopInput)
          .pipe(Effect.exit, Effect.forkScoped);
        yield* Deferred.await(interruptRequested);
        const startFiber = yield* harness.runtime.startTurn(newInput).pipe(Effect.forkScoped);
        yield* Deferred.await(responseParked);
        yield* awaitUntil(
          () =>
            providerTurns().some(
              (event) => event.providerTurn.nativeTurnRef?.nativeId === newNativeTurnId,
            ),
          "new unrelated native root receipt while old response is held",
        );
        const newTurn = providerTurns().find(
          (event) => event.providerTurn.nativeTurnRef?.nativeId === newNativeTurnId,
        )!.providerTurn;
        assert.equal(newTurn.nodeId, newInput.rootNodeId);
        assert.equal(newTurn.runAttemptId, newInput.attemptId);
        assert.equal(newTurn.nativeAcceptance, "accepted");
        assert.equal(newTurn.status, "running");
        assert.equal(oldTurn.nodeId, oldInput.rootNodeId);
        assert.equal(oldTurn.runAttemptId, oldInput.attemptId);
        assert.equal(sessionCloses, 0);
        assert.lengthOf(harness.terminalEvents(), 0);
        assert.isUndefined(stopFiber.pollUnsafe());
        yield* Deferred.succeed(releaseResponse, undefined);
        yield* Fiber.join(startFiber);
        const stopExit = yield* Fiber.join(stopFiber);
        assert.equal(stopExit._tag, rejected ? "Failure" : "Success");
        if (rejected)
          assert.include(encodeUnknownJson(stopExit), "captured native-1 interrupt rejected");
        yield* awaitUntil(() => harness.terminalEvents().length === 1, "old root settlement");
        assert.equal(harness.terminalEvents()[0]?.providerTurnId, oldTurn.id);
        assert.equal(harness.terminalEvents()[0]?.status, "interrupted");
        assert.equal(
          providerTurns()
            .filter((event) => event.providerTurn.id === newTurn.id)
            .at(-1)?.providerTurn.status,
          "running",
        );
        const staleExit = yield* harness.runtime.interruptTurn(stopInput).pipe(Effect.exit);
        assert.equal(staleExit._tag, "Failure");
        assert.deepEqual(
          requests.filter((request) => request.method === "turn/interrupt"),
          [
            {
              method: "turn/interrupt",
              params: { threadId: nativeThreadId, turnId: oldNativeTurnId },
            },
          ],
        );
        assert.equal(sessionCloses, 0);
        yield* harness.runtime.steerTurn({
          threadId: harness.threadId,
          runId: newInput.runId,
          providerThread: harness.providerThread,
          providerTurnId: newTurn.id,
          message: { ...newInput.message, text: "Continue the independent root." },
        });
        yield* awaitUntil(
          () => harness.terminalEvents().length === 2,
          "new root normal completion",
        );
        assert.equal(harness.terminalEvents()[1]?.providerTurnId, newTurn.id);
        assert.equal(harness.terminalEvents()[1]?.status, "completed");
        assert.equal(
          providerTurns()
            .filter((event) => event.providerTurn.id === newTurn.id)
            .at(-1)?.providerTurn.status,
          "completed",
        );
        assert.equal(sessionCloses, 0);
        assert.deepEqual(yield* Ref.get(driver.state), {
          cursor: transcript.entries.length,
          failure: null,
        });
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, NodeServices.layer, McpProviderSessions.layer),
        ),
      ),
    ).pipe(Effect.tap(() => Effect.sync(() => assert.equal(sessionCloses, 1))));
  });
});

describe("CodexAdapterV2 post-settle continuation (CapacitySkills)", () => {
  it.effect(
    "learns captured native capacity for sibling sessions and isolates runtime profiles",
    () =>
      Effect.gen(function* () {
        const nativeThreadId = "capacity-producer-thread";
        const nativeTurnId = "capacity-producer-turn";
        const prompt = "Measure native context.";
        const usage = {
          inputTokens: 120,
          cachedInputTokens: 0,
          outputTokens: 6,
          reasoningOutputTokens: 0,
          totalTokens: 126,
        };
        const notification = (
          window: number | null | undefined,
          threadId = nativeThreadId,
        ): CodexReplay.CodexAppServerReplayEntry => ({
          type: "emit_inbound",
          frame: {
            method: "thread/tokenUsage/updated",
            params: {
              threadId,
              turnId: nativeTurnId,
              tokenUsage: {
                total: {
                  ...usage,
                  inputTokens: 11_833,
                  cachedInputTokens: 3456,
                  totalTokens: 11_839,
                },
                last: usage,
                ...(window === undefined ? {} : { modelContextWindow: window }),
              },
            },
          },
        });
        const transcript = makeCodexReplayTranscript({
          scenario: "native-capacity-producer",
          entries: [
            ...codexReplayPreamble({ nativeThreadId, nativeTurnId, prompt }),
            notification(777, "foreign-native-thread"),
            notification(0),
            notification(-1),
            notification(null),
            notification(258_400),
            notification(undefined),
            notification(0),
            notification(777, "foreign-native-thread"),
            {
              type: "emit_inbound",
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
        const siblings = ["same-profile", "changed-profile", "restored-profile"].map((scenario) =>
          makeCodexReplayTranscript({
            scenario,
            entries: codexReplayPreamble({
              nativeThreadId: `native-${scenario}`,
              nativeTurnId: "unused",
              prompt: "unused",
            }).slice(0, 5),
          }),
        );
        let homePath = "/synthetic/capacity-profile-a";
        const adapter = yield* Effect.scoped(
          Effect.gen(function* () {
            const h = yield* makeCodexReplayHarness(
              transcript,
              undefined,
              undefined,
              undefined,
              false,
              undefined,
              {
                additionalSessions: siblings,
                resolveRuntime: Effect.sync(() => ({
                  config: { ...DEFAULT_CODEX_SETTINGS, homePath },
                  environment: { HOME: homePath },
                  revision: "synthetic-capacity-runtime",
                })),
              },
            );
            assert.isUndefined(h.runtime.getModelContextWindow?.(CODEX_TEST_MODEL_SELECTION));
            yield* h.runtime.startTurn(
              makeCodexTestTurnInput({
                threadId: h.threadId,
                providerThread: h.providerThread,
                now: yield* DateTime.now,
                attemptId: RunAttemptId.make("capacity-producer-attempt"),
                text: prompt,
              }),
            );
            yield* h.firstTerminal;
            assert.equal(h.runtime.getModelContextWindow?.(CODEX_TEST_MODEL_SELECTION), 258_400);
            const reports = h.events.flatMap((event) =>
              event.type === "provider_turn.updated" && event.providerTurn.tokenUsage !== undefined
                ? [event.providerTurn.tokenUsage]
                : [],
            );
            assert.deepEqual(
              reports.map((report) => report.maxTokens),
              [0, -1, null, 258_400, null, 0],
            );
            assert.lengthOf(h.terminalEvents(), 1);
            assert.equal(h.terminalEvents()[0]?.status, "completed");
            const report = h.events.find(
              (event) =>
                event.type === "provider_turn.updated" &&
                event.providerTurn.tokenUsage?.maxTokens === 258_400,
            );
            assert.equal(report?.type, "provider_turn.updated");
            if (report?.type === "provider_turn.updated") {
              assert.equal(report.providerTurn.providerThreadId, h.providerThread.id);
              assert.equal(
                report.providerTurn.runAttemptId,
                RunAttemptId.make("capacity-producer-attempt"),
              );
              assert.equal(report.providerTurn.tokenUsage?.usedTokens, 126);
              assert.equal(report.providerTurn.tokenUsage?.inputTokens, 120);
            }
            assert.isUndefined(
              h.runtime.getModelContextWindow?.({
                ...CODEX_TEST_MODEL_SELECTION,
                model: "small-model",
              }),
            );
            assert.isUndefined(
              h.runtime.getModelContextWindow?.({
                ...CODEX_TEST_MODEL_SELECTION,
                instanceId: ProviderInstanceId.make("other-codex"),
              }),
            );
            assert.isUndefined(
              h.runtime.getModelContextWindow?.({
                ...CODEX_TEST_MODEL_SELECTION,
                options: [{ id: "reasoningEffort", value: "high" }],
              }),
            );
            return h.adapter;
          }),
        );
        for (const [index, profile] of [
          "/synthetic/capacity-profile-a",
          "/synthetic/capacity-profile-b",
          "/synthetic/capacity-profile-a",
        ].entries()) {
          homePath = profile;
          yield* Effect.scoped(
            Effect.gen(function* () {
              const threadId = ThreadId.make(`capacity-sibling-${index}`);
              const runtime = yield* adapter.openSession({
                threadId,
                providerSessionId: ProviderSessionId.make(`capacity-sibling-session-${index}`),
                configureMcp: false,
                modelSelection: CODEX_TEST_MODEL_SELECTION,
                runtimePolicy: CODEX_TEST_RUNTIME_POLICY,
              });
              const thread = yield* runtime.ensureThread({
                threadId,
                modelSelection: CODEX_TEST_MODEL_SELECTION,
                runtimePolicy: CODEX_TEST_RUNTIME_POLICY,
              });
              assert.equal(thread.appThreadId, threadId);
              assert.equal(thread.nativeThreadRef?.nativeId, `native-${siblings[index]!.scenario}`);
              assert.equal(
                runtime.getModelContextWindow?.(CODEX_TEST_MODEL_SELECTION),
                index === 1 ? undefined : 258_400,
              );
            }),
          );
        }
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, NodeServices.layer, McpProviderSessions.layer),
        ),
      ),
  );
});

describe("CodexAdapterV2 post-settle continuation (FinalAnswers)", () => {
  it.effect("buffers an overlapping later final stream until duplicate detection", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const scenario = "codex-overlapping-duplicate-final";
        const nativeThreadId = `native-${scenario}-thread`;
        const nativeTurnId = `native-${scenario}-turn`;
        const answerItem = (id: string, text: string) => ({
          type: "agentMessage" as const,
          id,
          text,
          phase: "final_answer" as const,
          memoryCitation: null,
        });
        const transcript = makeCodexReplayTranscript({
          scenario,
          entries: [
            ...codexReplayPreamble({
              nativeThreadId,
              nativeTurnId,
              prompt: "Reply with the requested recovery marker.",
            }),
            ...["answer-overlap-original", "answer-overlap-duplicate"].flatMap(
              (itemId, index): ReadonlyArray<CodexReplay.CodexAppServerReplayEntry> => [
                {
                  type: "emit_inbound",
                  label: `item/started/${itemId}`,
                  frame: {
                    method: "item/started",
                    params: {
                      item: answerItem(itemId, ""),
                      threadId: nativeThreadId,
                      turnId: nativeTurnId,
                      startedAtMs: 1782622440500 + index,
                    },
                  },
                },
                {
                  type: "emit_inbound",
                  label: `item/agentMessage/delta/${itemId}`,
                  frame: {
                    method: "item/agentMessage/delta",
                    params: {
                      threadId: nativeThreadId,
                      turnId: nativeTurnId,
                      itemId,
                      delta: "CODEX_RECOVERY_OK",
                    },
                  },
                },
              ],
            ),
            {
              type: "emit_inbound",
              label: "item/completed/answer-overlap-original",
              afterMs: 100,
              frame: {
                method: "item/completed",
                params: {
                  item: answerItem("answer-overlap-original", "CODEX_RECOVERY_OK"),
                  threadId: nativeThreadId,
                  turnId: nativeTurnId,
                  completedAtMs: 1782622441000,
                },
              },
            },
            {
              type: "emit_inbound",
              label: "item/completed/answer-overlap-duplicate",
              frame: {
                method: "item/completed",
                params: {
                  item: answerItem("answer-overlap-duplicate", "CODEX_RECOVERY_OK"),
                  threadId: nativeThreadId,
                  turnId: nativeTurnId,
                  completedAtMs: 1782622441001,
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
            attemptId: RunAttemptId.make("attempt-codex-overlapping-duplicate-final"),
            text: "Reply with the requested recovery marker.",
          }),
        );
        yield* Effect.yieldNow;
        yield* TestClock.adjust("50 millis");
        yield* Effect.yieldNow;

        assert.equal(
          new Set(
            harness.events.flatMap((event) =>
              event.type === "turn_item.updated" && event.turnItem.type === "assistant_message"
                ? [event.turnItem.messageId]
                : [],
            ),
          ).size,
          1,
        );
        assert.isFalse(
          harness.events.some(
            (event) =>
              event.type === "turn_item.updated" &&
              event.turnItem.type === "assistant_message" &&
              event.turnItem.nativeItemRef?.nativeId === "answer-overlap-duplicate",
          ),
        );
        assert.lengthOf(assistantMessages(harness.events), 0);

        yield* TestClock.adjust("50 millis");
        yield* awaitUntil(() => harness.terminalEvents().length === 1, "root turn terminal");
        assert.equal(
          new Set(assistantMessages(harness.events).map((event) => event.message.id)).size,
          1,
        );
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, NodeServices.layer, McpProviderSessions.layer),
        ),
      ),
    ),
  );
});

describe("CodexAdapterV2 post-settle continuation (GuidanceCompaction)", () => {
  const isNativeStartReceiptError = Schema.is(ProviderAdapterTurnStartError);

  it.effect(
    "renders a structural trusted suffix once through the actual Codex start protocol",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const nativeThreadId = "trusted-suffix-thread";
          const nativeTurnId = "trusted-suffix-turn";
          const text = "[Scient selected skills for this turn:\nauthored marker\n]";
          const runtimeInstruction =
            "[Scient selected skills for this turn:\ntrusted orientation\n]";
          const sentPrompt = `${text}\n\n${runtimeInstruction}`;
          const transcript = makeCodexReplayTranscript({
            scenario: "structural-trusted-suffix",
            entries: [
              ...codexReplayPreamble({ nativeThreadId, nativeTurnId, prompt: text, sentPrompt }),
              {
                type: "emit_inbound",
                label: "done",
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
          const input = makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now: yield* DateTime.now,
            attemptId: RunAttemptId.make("trusted-suffix-attempt"),
            text,
          });
          yield* harness.runtime.startTurn({
            ...input,
            message: { ...input.message, runtimeInstruction },
          });
          yield* harness.firstTerminal;
          assert.equal(harness.terminalEvents()[0]?.status, "completed");
        }).pipe(
          Effect.provide(
            Layer.mergeAll(IdAllocator.layer, NodeServices.layer, McpProviderSessions.layer),
          ),
        ),
      ),
  );

  it.effect(
    "preserves Auto review and full granted guidance below every entry limit in one native start packet",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const sessions = yield* McpProviderSessions.McpProviderSessions;
          const nativeThreadId = "auto-full-guidance-thread";
          const nativeTurnId = "auto-full-guidance-turn";
          const prompt = "Review this change automatically.";
          const capabilities = new Set<McpCapability>([
            "preview",
            "device",
            "documents:build",
            "skills:read",
          ]);
          const runtimePolicy = {
            ...CODEX_TEST_RUNTIME_POLICY,
            runtimeMode: "auto" as const,
          };
          const modelSelection: ModelSelection = {
            ...CODEX_TEST_MODEL_SELECTION,
            options: [{ id: "reasoningEffort", value: "high" }],
          };
          const expected = yield* CodexAdapterV2.buildCodexTurnStartParams({
            nativeThreadId,
            codexInput: [{ type: "text", text: prompt }],
            runtimePolicy,
            modelSelection,
            hasT3Mcp: true,
            mcpCapabilities: capabilities,
          });
          const packetSchema = CodexSchema.V2TurnStartParams.pipe(
            Schema.fieldsAssign({
              collaborationMode: CodexSchema.ClientRequest__CollaborationMode,
              additionalContext: Schema.Record(
                Schema.String,
                CodexSchema.V2TurnStartParams__AdditionalContextEntry,
              ),
            }),
          );
          const decodePacket = Schema.decodeUnknownEffect(packetSchema);
          const packets = yield* Ref.make<ReadonlyArray<Schema.Schema.Type<typeof packetSchema>>>(
            [],
          );
          const preamble = codexReplayPreamble({ nativeThreadId, nativeTurnId, prompt });
          const transcript = makeCodexReplayTranscript({
            scenario: "auto-full-guidance-packet",
            entries: [
              ...preamble.slice(0, 5),
              {
                type: "expect_outbound",
                label: "Auto review with full granted context",
                frame: { id: 3, method: "turn/start", params: expected },
              },
              ...preamble.slice(6),
              {
                type: "emit_inbound",
                label: "done",
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
          const harness = yield* makeCodexReplayHarness(transcript, undefined, (method, params) =>
            method === "turn/start"
              ? decodePacket(params).pipe(
                  Effect.orDie,
                  Effect.flatMap((packet) =>
                    Ref.update(packets, (current) => [...current, packet]),
                  ),
                )
              : Effect.void,
          );
          const registry = yield* McpSessionRegistry.__testing.make().pipe(
            Effect.provideService(
              HttpServer.HttpServer,
              HttpServer.HttpServer.of({
                address: NetAddress.inetAddressFromIpStringUnsafe("127.0.0.1", 43123),
                serve: () => Effect.void,
              }),
            ),
            Effect.provideService(
              ServerEnvironment.ServerEnvironment,
              ServerEnvironment.ServerEnvironment.of({
                getEnvironmentId: Effect.succeed(EnvironmentId.make("auto-full-guidance")),
                getDescriptor: Effect.die("This packet fixture does not discover environments."),
              }),
            ),
          );
          const issued = yield* registry.issue({
            threadId: harness.threadId,
            providerInstanceId: modelSelection.instanceId,
            capabilities,
          });
          const scope = yield* registry.resolve(
            issued.config.authorizationHeader.replace(/^Bearer\s+/, ""),
          );
          assert.equal(scope?.thread.threadId, harness.threadId);
          assert.equal(scope?.thread.providerInstanceId, modelSelection.instanceId);
          assert.deepEqual(scope?.capabilities, capabilities);
          yield* sessions.set(issued.config);
          yield* Effect.addFinalizer(() =>
            registry
              .revokeThread(harness.threadId)
              .pipe(Effect.andThen(sessions.clear(harness.threadId))),
          );
          yield* harness.runtime.startTurn({
            ...makeCodexTestTurnInput({
              threadId: harness.threadId,
              providerThread: harness.providerThread,
              now: yield* DateTime.now,
              attemptId: RunAttemptId.make("auto-full-guidance-attempt"),
              text: prompt,
            }),
            runtimePolicy,
            modelSelection,
          });
          yield* harness.firstTerminal;
          const delivered = yield* Ref.get(packets);
          assert.equal(delivered.length, 1);
          const packet = delivered[0]!;
          assert.equal(packet.threadId, nativeThreadId);
          assert.deepEqual(packet.input, [{ type: "text", text: prompt }]);
          assert.equal(packet.cwd, "/workspace");
          assert.equal(packet.model, "gpt-5.4");
          assert.equal(packet.effort, "high");
          assert.equal(packet.approvalPolicy, "on-request");
          assert.equal(packet.approvalsReviewer, "auto_review");
          assert.deepEqual(packet.sandboxPolicy, { type: "workspaceWrite" });
          assert.equal(packet.collaborationMode.mode, "default");
          assert.equal(packet.collaborationMode.settings.model, "gpt-5.4");
          assert.equal(packet.collaborationMode.settings.reasoning_effort, "high");
          const contextKeys = Object.keys(packet.additionalContext);
          assert.deepEqual(contextKeys.slice(-2), ["t3_code_runtime", "scient_awareness"]);
          assert.isNotEmpty(contextKeys.slice(0, -2));
          assert.isTrue(
            contextKeys.slice(0, -2).every((key) => key.startsWith("t3_code_orchestration_")),
          );
          const orchestration = Object.entries(packet.additionalContext)
            .filter(([key]) => key.startsWith("t3_code_orchestration_"))
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([, entry]) => entry.value)
            .join("\n\n");
          assert.equal(orchestration, SCIENT_ORCHESTRATION_INSTRUCTIONS.trim());
          assert.include(orchestration, "delegate_task");
          const awareness = packet.additionalContext.scient_awareness?.value ?? "";
          for (const required of [
            "preview_status",
            "preview_open",
            "device_list",
            "device_open",
            "scient_pdf_build",
            "scient_skill_load",
          ])
            assert.include(awareness, required);
          for (const [key, entry] of Object.entries(packet.additionalContext)) {
            assert.equal(entry.kind, "application");
            assert.isBelow(Buffer.byteLength(entry.value), 4_000, key);
          }
          assert.equal(harness.terminalEvents().length, 1);
          assert.equal(harness.terminalEvents()[0]?.status, "completed");
        }).pipe(
          Effect.provide(
            Layer.mergeAll(IdAllocator.layer, NodeServices.layer, McpProviderSessions.layer),
          ),
        ),
      ),
  );

  it.effect.each([
    { compact: false, completed: false },
    { compact: true, completed: false },
    { compact: false, completed: true },
    { compact: true, completed: true },
  ])("retains correlated native acceptance before a failing start response: %s", (scenario) =>
    Effect.gen(function* () {
      const nativeThreadId = "accepted-before-response-thread";
      const nativeTurnId = "accepted-before-response-turn";
      const accepted = yield* Deferred.make<void>();
      const preamble = codexReplayPreamble({ nativeThreadId, nativeTurnId, prompt: "work" });
      const transcript = makeCodexReplayTranscript({
        scenario: `accepted-before-error-${scenario.compact}-${scenario.completed}`,
        entries: [
          ...preamble.slice(0, 5),
          ...(scenario.compact
            ? [
                {
                  type: "expect_outbound" as const,
                  frame: {
                    id: 3,
                    method: "thread/compact/start",
                    params: { threadId: nativeThreadId },
                  },
                },
              ]
            : preamble.slice(5, 6)),
          ...preamble.slice(7, 8),
          ...(scenario.completed
            ? [
                {
                  type: "emit_inbound" as const,
                  frame: {
                    method: "turn/completed",
                    params: {
                      threadId: nativeThreadId,
                      turn: makeCodexReplayTurn({ id: nativeTurnId, status: "completed" }),
                    },
                  },
                },
              ]
            : []),
          // This actual request follows the observed native receipt (and terminal,
          // when present), so the failing start response cannot race its handler.
          {
            type: "expect_outbound",
            frame: {
              id: 4,
              method: "feedback/upload",
              params: {
                classification: "bug",
                includeLogs: true,
                threadId: nativeThreadId,
              },
            },
          },
          { type: "emit_inbound", frame: { id: 4, result: { threadId: "feedback" } } },
          {
            type: "emit_inbound",
            frame: {
              id: 3,
              error: { code: -32602, message: "Response failed after native acceptance" },
            },
          },
        ],
      });
      const h = yield* makeCodexReplayHarness(transcript, (event) =>
        event.type === "provider_turn.updated" && event.providerTurn.nativeAcceptance === "accepted"
          ? Deferred.succeed(accepted, undefined)
          : Effect.void,
      );
      const input = makeCodexTestTurnInput({
        threadId: h.threadId,
        providerThread: h.providerThread,
        now: yield* DateTime.now,
        attemptId: RunAttemptId.make("accepted-before-error-attempt"),
        text: "work",
      });
      const start = scenario.compact ? h.runtime.compactThread : h.runtime.startTurn;
      assert.ok(start);
      assert.ok(h.runtime.uploadFeedback);
      const failing = yield* start(input).pipe(Effect.flip, Effect.forkScoped);
      yield* Deferred.await(accepted);
      if (scenario.completed) yield* h.firstTerminal;
      yield* h.runtime.uploadFeedback({ providerThread: h.providerThread });
      const error = yield* Fiber.join(failing);
      if (!isNativeStartReceiptError(error))
        return yield* Effect.die("Expected native start error");
      const observed = h.events.find(
        (event) =>
          event.type === "provider_turn.updated" &&
          event.providerTurn.nativeAcceptance === "accepted",
      );
      assert.ok(observed?.type === "provider_turn.updated");
      assert.deepEqual(error.providerTurn, observed.providerTurn);
      assert.equal(error.providerTurn?.nativeTurnRef?.nativeId, nativeTurnId);
      assert.equal(error.providerTurn?.nativeAcceptance, "accepted");
      assert.ok(error.providerTurn?.acceptedAt);
      assert.equal(error.providerTurn?.runAttemptId, input.attemptId);
      assert.equal(error.providerTurn?.nodeId, input.rootNodeId);
      assert.equal(error.providerTurn?.providerThreadId, h.providerThread.id);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(IdAllocator.layer, NodeServices.layer, McpProviderSessions.layer),
      ),
    ),
  );

  it.effect.each([-32602, -32000])(
    "retains native compaction request refusal versus uncertainty: %s",
    (code) =>
      Effect.gen(function* () {
        const nativeThreadId = "compact-failed-thread";
        const transcript = makeCodexReplayTranscript({
          scenario: `native-compaction-failure-${code}`,
          entries: [
            ...codexReplayPreamble({
              nativeThreadId,
              nativeTurnId: "unused-turn",
              prompt: "unused",
            }).slice(0, 5),
            {
              type: "expect_outbound",
              label: "compact",
              frame: {
                id: 3,
                method: "thread/compact/start",
                params: { threadId: nativeThreadId },
              },
            },
            {
              type: "emit_inbound",
              label: "compact",
              frame: {
                id: 3,
                error: { code, message: "Native compaction refused or response uncertain" },
              },
            },
          ],
        });
        const h = yield* makeCodexReplayHarness(transcript);
        assert.ok(h.runtime.compactThread);
        const input = makeCodexTestTurnInput({
          threadId: h.threadId,
          providerThread: h.providerThread,
          now: yield* DateTime.now,
          attemptId: RunAttemptId.make("compact-failed-attempt"),
          text: "/compact",
        });
        const error = yield* h.runtime.compactThread(input).pipe(Effect.flip);
        if (!isNativeStartReceiptError(error))
          return yield* Effect.die("Expected exact compaction start error");
        assert.equal(error.providerTurn?.nativeAcceptance, code === -32602 ? "pending" : "unknown");
        assert.isUndefined(error.providerTurn?.acceptedAt);
        assert.isNull(error.providerTurn?.nativeTurnRef);
        assert.equal(error.providerTurn?.runAttemptId, input.attemptId);
        assert.equal(error.providerTurn?.nodeId, input.rootNodeId);
        assert.equal(error.providerTurn?.providerThreadId, h.providerThread.id);
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, NodeServices.layer, McpProviderSessions.layer),
        ),
      ),
  );
});

describe("CodexAdapterV2 post-settle continuation (McpFork)", () => {
  const codexReplayThreadResult = (input: {
    readonly nativeThreadId: string;
    readonly forkedFromId: string | null;
  }) => ({
    thread: {
      id: input.nativeThreadId,
      sessionId: input.nativeThreadId,
      forkedFromId: input.forkedFromId,
      preview: "",
      ephemeral: false,
      modelProvider: "openai",
      createdAt: 1782622440,
      updatedAt: 1782622440,
      status: { type: "idle" },
      path: `/tmp/${input.nativeThreadId}.jsonl`,
      cwd: "/workspace",
      cliVersion: "0.144.0",
      source: "vscode",
      threadSource: null,
      agentNickname: null,
      agentRole: null,
      gitInfo: null,
      name: null,
      turns: [],
    },
    model: "gpt-5.4",
    modelProvider: "openai",
    serviceTier: null,
    cwd: "/workspace",
    instructionSources: [],
    approvalPolicy: "on-request",
    approvalsReviewer: "user",
    sandbox: { type: "workspaceWrite", writableRoots: [], networkAccess: false },
    reasoningEffort: "medium",
  });

  const errorCauseChainText = (error: unknown): string =>
    error instanceof Error ? `${error.message} ${errorCauseChainText(error.cause)}` : String(error);

  it.effect(
    "uses the Scient MCP namespace and exact thread credential for native start, resume and fork",
    () =>
      Effect.gen(function* () {
        const sessions = yield* McpProviderSessions.McpProviderSessions;
        const scenario = "scient-mcp-native-lifecycle";
        const threadId = ThreadId.make(`thread-${scenario}`);
        const targetThreadId = ThreadId.make("scient-mcp-fork-target");
        const nativeThreadId = "scient-mcp-source-native";
        const forkNativeId = "scient-mcp-fork-native";
        const endpoint = "http://127.0.0.1:43123/mcp";
        for (const [id, token] of [
          [threadId, "synthetic-source-token"],
          [targetThreadId, "synthetic-target-token"],
        ] as const) {
          yield* sessions.set({
            environmentId: EnvironmentId.make("scient-mcp-native-test"),
            threadId: id,
            providerSessionId: `mcp-${id}`,
            providerInstanceId: ProviderInstanceId.make("codex"),
            endpoint,
            authorizationHeader: `Bearer ${token}`,
            capabilities: new Set(["orchestration"] as const),
            connectors: [],
          });
        }
        yield* Effect.addFinalizer(() =>
          sessions.clear(threadId).pipe(Effect.andThen(sessions.clear(targetThreadId))),
        );
        const sourceConfig = {
          ...CodexAdapterV2.CODEX_THREAD_CONFIG,
          mcp_servers: {
            scient: {
              url: endpoint,
              http_headers: { Authorization: "Bearer synthetic-source-token" },
            },
          },
        };
        const targetConfig = {
          ...CodexAdapterV2.CODEX_THREAD_CONFIG,
          mcp_servers: {
            scient: {
              url: endpoint,
              http_headers: { Authorization: "Bearer synthetic-target-token" },
            },
          },
        };
        const transcript = makeCodexReplayTranscript({
          scenario,
          entries: [
            ...codexReplayPreamble({
              nativeThreadId,
              nativeTurnId: "unused",
              prompt: "unused",
            }).slice(0, 3),
            {
              type: "expect_outbound",
              label: "thread/start",
              frame: { id: 2, method: "thread/start", params: { config: sourceConfig } },
            },
            {
              type: "emit_inbound",
              label: "thread/start",
              frame: {
                id: 2,
                result: codexReplayThreadResult({ nativeThreadId, forkedFromId: null }),
              },
            },
            {
              type: "expect_outbound",
              label: "thread/resume",
              frame: {
                id: 3,
                method: "thread/resume",
                params: { threadId: nativeThreadId, excludeTurns: true, config: sourceConfig },
              },
            },
            {
              type: "emit_inbound",
              label: "thread/resume",
              frame: { id: 3, result: { thread: { id: nativeThreadId, updatedAt: 1782622440 } } },
            },
            {
              type: "expect_outbound",
              label: "thread/fork",
              frame: {
                id: 4,
                method: "thread/fork",
                params: {
                  threadId: nativeThreadId,
                  lastTurnId: "scient-mcp-boundary",
                  config: targetConfig,
                },
              },
            },
            {
              type: "emit_inbound",
              label: "thread/fork",
              frame: {
                id: 4,
                result: codexReplayThreadResult({
                  nativeThreadId: forkNativeId,
                  forkedFromId: nativeThreadId,
                }),
              },
            },
          ],
        });
        const harness = yield* makeCodexReplayHarness(transcript);
        const resumed = yield* harness.runtime.resumeThread({
          providerThread: harness.providerThread,
        });
        const boundary = codexReplaySourceTurn({
          id: "scient-mcp-provider-turn",
          ordinal: 1,
          nativeId: "scient-mcp-boundary",
          providerThreadId: resumed.id,
          now: yield* DateTime.now,
        });
        const forked = yield* harness.runtime.forkThread({
          sourceProviderThread: resumed,
          sourceProviderTurns: [boundary],
          providerTurnId: boundary.id,
          targetThreadId,
        });
        assert.equal(forked.nativeThreadRef?.nativeId, forkNativeId);
        assert.equal(forked.appThreadId, targetThreadId);
        assert.equal(forked.forkedFrom?.providerThreadId, resumed.id);
        assert.equal(
          (yield* sessions.read(threadId))?.authorizationHeader,
          "Bearer synthetic-source-token",
        );
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, NodeServices.layer, McpProviderSessions.layer),
        ),
      ),
  );

  const codexReplaySourceTurn = (input: {
    readonly id: string;
    readonly ordinal: number;
    readonly nativeId: string | null;
    readonly providerThreadId: ProviderThreadId;
    readonly now: DateTime.Utc;
  }): OrchestrationV2ProviderTurn => ({
    id: ProviderTurnId.make(input.id),
    providerThreadId: input.providerThreadId,
    nodeId: NodeId.make(`node-${input.id}`),
    runAttemptId: RunAttemptId.make(`run-attempt-${input.id}`),
    nativeTurnRef:
      input.nativeId === null
        ? { driver: CodexAdapterV2.CODEX_DRIVER_KIND, nativeId: null, strength: "none" }
        : {
            driver: CodexAdapterV2.CODEX_DRIVER_KIND,
            nativeId: input.nativeId,
            strength: "strong",
          },
    ordinal: input.ordinal,
    status: "completed",
    startedAt: input.now,
    completedAt: input.now,
  });

  it.effect("refuses a source-ID native fork before reading or reverting source history", () =>
    Effect.gen(function* () {
      const nativeThreadId = "source-id-refusal";
      const transcript = makeCodexReplayTranscript({
        scenario: "codex-source-id-refusal",
        entries: [
          ...codexReplayPreamble({
            nativeThreadId,
            nativeTurnId: "source-turn",
            prompt: "unused",
          }).slice(0, 5),
          {
            type: "expect_outbound",
            label: "thread/fork",
            frame: {
              id: 3,
              method: "thread/fork",
              params: { threadId: nativeThreadId, config: CodexAdapterV2.CODEX_THREAD_CONFIG },
            },
          },
          {
            type: "emit_inbound",
            label: "thread/fork/source-id",
            frame: {
              id: 3,
              result: codexReplayThreadResult({ nativeThreadId, forkedFromId: nativeThreadId }),
            },
          },
        ],
      });
      const outbound: Array<string> = [];
      const h = yield* makeCodexReplayHarness(
        transcript,
        () => Effect.void,
        (method) =>
          Effect.sync(() => {
            outbound.push(method);
          }),
      );
      const source = h.providerThread;
      const sourceBefore = encodeUnknownJson(source);
      const now = yield* DateTime.now;
      const first = codexReplaySourceTurn({
        id: "source-first",
        ordinal: 1,
        nativeId: null,
        providerThreadId: source.id,
        now,
      });
      const later = codexReplaySourceTurn({
        id: "source-later",
        ordinal: 2,
        nativeId: "later-native-turn",
        providerThreadId: source.id,
        now,
      });
      const error = yield* h.runtime
        .forkThread({
          sourceProviderThread: source,
          sourceProviderTurns: [first, later],
          providerTurnId: first.id,
          targetThreadId: ThreadId.make("source-id-refusal-target"),
        })
        .pipe(Effect.flip);
      assert.instanceOf(error, ProviderAdapterForkThreadError);
      assert.include(errorCauseChainText(error), "source native thread");
      assert.deepEqual(
        outbound,
        ["initialize", "thread/start", "thread/fork"],
        "A source-ID response must not authorize read/revert/resume/start of its source",
      );
      assert.equal(encodeUnknownJson(h.providerThread), sourceBefore);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(IdAllocator.layer, NodeServices.layer, McpProviderSessions.layer),
      ),
    ),
  );
});

describe("CodexAdapterV2 post-settle continuation (Media)", () => {
  const decodeCitationPresentation = Schema.decodeUnknownEffect(ProviderCitationPresentation);

  const imageStoresLayer = Layer.merge(EventStore.layer, ProjectionStore.layer).pipe(
    Layer.provide(SqlitePersistenceMemory),
  );

  const imageSinkLayer = EventSink.layer.pipe(
    Layer.provide(Layer.merge(imageStoresLayer, SqlitePersistenceMemory)),
  );

  const imagePersistenceLayer = Layer.mergeAll(
    imageStoresLayer,
    imageSinkLayer,
    ProviderEventIngestor.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
            // @effect-diagnostics-next-line effectSucceedWithVoid:off - Optional instances require undefined rather than void.
            getInstance: () => Effect.succeed(undefined),
          }),
          imageStoresLayer,
          imageSinkLayer,
          IdAllocator.layer,
          layerGitVcsDriverWithoutBranches,
        ),
      ),
    ),
    IdAllocator.layer,
    McpProviderSessions.layer,
  ).pipe(Layer.provideMerge(Layer.merge(NodeServices.layer, ThreadCommandExecutor.layer)));

  it.effect(
    "persists native web-search citations as portable links in both assistant representations",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const nativeThreadId = "citation-thread";
          const nativeTurnId = "citation-turn";
          const raw = "Evidence 😀 \uE200cite\uE202turn0search0\uE202turn0search1\uE201.";
          const expected = 'Evidence 😀 [1](<https://example.test/source> "Study").';
          const transcript = makeCodexReplayTranscript({
            scenario: "native-citations",
            entries: [
              ...codexReplayPreamble({ nativeThreadId, nativeTurnId, prompt: "Find evidence" }),
              {
                type: "emit_inbound",
                frame: {
                  method: "item/completed",
                  params: {
                    threadId: nativeThreadId,
                    turnId: nativeTurnId,
                    item: {
                      type: "webSearch",
                      id: "search",
                      query: "evidence",
                      action: { type: "search", query: "evidence" },
                      results: [
                        ["turn0search0", { url: "https://example.test/source", title: "Study" }],
                        {
                          ref_id: "turn0search1",
                          url: "https://example.test/source",
                          title: "Duplicate source",
                        },
                        { ref_id: "unsafe", url: "javascript:alert(1)", title: "Unsafe" },
                      ],
                    },
                  },
                },
              },
              {
                type: "emit_inbound",
                frame: {
                  method: "item/completed",
                  params: {
                    threadId: nativeThreadId,
                    turnId: nativeTurnId,
                    item: {
                      type: "agentMessage",
                      id: "citation-answer",
                      text: raw,
                      phase: "final_answer",
                    },
                  },
                },
              },
              {
                type: "emit_inbound",
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
          const input = makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("citation-attempt"),
            text: "Find evidence",
          });
          yield* harness.runtime.startTurn(input);
          yield* harness.firstTerminal;
          const message = harness.events.find(
            (event) => event.type === "message.updated" && event.message.role === "assistant",
          );
          if (message?.type !== "message.updated")
            return yield* Effect.die("Missing native cited answer");
          assert.equal(message.message.text, expected);
          const sink = yield* EventSink.EventSinkV2;
          const ids = yield* IdAllocator.IdAllocatorV2;
          yield* sink.write({
            events: [
              {
                id: yield* ids.allocate.event({ threadId: harness.threadId }),
                threadId: harness.threadId,
                type: "thread.created",
                occurredAt: now,
                payload: input.appThread,
              },
            ],
          });
          const ingestor = yield* ProviderEventIngestor.ProviderEventIngestorV2;
          for (const event of harness.events) {
            if (
              event.type !== "message.updated" &&
              event.type !== "turn_item.updated" &&
              event.type !== "node.updated"
            )
              continue;
            yield* ingestor.ingestNormalized({
              providerSessionId: harness.runtime.providerSession.id,
              providerInstanceId: CODEX_TEST_MODEL_SELECTION.instanceId,
              threadId: harness.threadId,
              event,
            });
          }
          const projections = yield* ProjectionStore.ProjectionStoreV2;
          const projected = yield* projections.getThreadProjection(harness.threadId);
          assert.equal(
            projected.messages.find((entry) => entry.id === message.message.id)?.text,
            expected,
          );
          const item = projected.turnItems.find(
            (entry) => entry.type === "assistant_message" && entry.messageId === message.message.id,
          );
          if (item?.type !== "assistant_message")
            return yield* Effect.die("Missing native cited assistant item");
          assert.equal(item.text, expected);
          const store = yield* EventStore.EventStoreV2;
          const persisted = yield* store
            .read({ threadId: harness.threadId })
            .pipe(Stream.runCollect);
          const rebuilt = yield* Effect.gen(function* () {
            const replay = yield* ProjectionStore.ProjectionStoreV2;
            for (const row of persisted) yield* replay.apply(row.event);
            return yield* replay.getThreadProjection(harness.threadId);
          }).pipe(
            Effect.provide(ProjectionStore.layer.pipe(Layer.provide(SqlitePersistenceMemory))),
          );
          assert.equal(
            rebuilt.messages.find((entry) => entry.id === message.message.id)?.text,
            expected,
          );
          const rebuiltItem = rebuilt.turnItems.find((entry) => entry.id === item.id);
          if (rebuiltItem?.type !== "assistant_message")
            return yield* Effect.die("Missing rebuilt cited assistant item");
          assert.equal(rebuiltItem.text, expected);
          assert.isFalse(rebuilt.messages.some((entry) => entry.text.includes("javascript:")));
        }).pipe(Effect.provide(imagePersistenceLayer)),
      ),
  );

  it.effect.each(
    (["oversized", "expanded-url"] as const).map((catalog) => ({
      caseTitle: `preserves a native unresolved answer with a ${catalog} catalog as bounded inert metadata`,
      catalog,
    })),
  )("$caseTitle", ({ catalog }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const nativeThreadId = "bounded-citation-thread";
        const nativeTurnId = "bounded-citation-turn";
        const text = "Raw \uE200cite\uE202s127\uE202missing\uE201";
        const results =
          catalog === "oversized"
            ? Array.from({ length: 140 }, (_, i) => ({
                ref_id: `s${i}`,
                url: `https://example.test/${i}`,
              }))
            : [
                {
                  ref_id: "s127",
                  url: `https://example.test/${"א".repeat(7000)}`,
                  title: "Unicode",
                },
              ];
        const transcript = makeCodexReplayTranscript({
          scenario: `bounded-${catalog}`,
          entries: [
            ...codexReplayPreamble({ nativeThreadId, nativeTurnId, prompt: "Find evidence" }),
            {
              type: "emit_inbound",
              frame: {
                method: "item/completed",
                params: {
                  threadId: nativeThreadId,
                  turnId: nativeTurnId,
                  item: {
                    type: "webSearch",
                    id: "search",
                    query: "evidence",
                    action: { type: "search", query: "evidence" },
                    results,
                  },
                },
              },
            },
            {
              type: "emit_inbound",
              frame: {
                method: "item/completed",
                params: {
                  threadId: nativeThreadId,
                  turnId: nativeTurnId,
                  item: { type: "agentMessage", id: "answer", text, phase: "final_answer" },
                },
              },
            },
            {
              type: "emit_inbound",
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
            attemptId: RunAttemptId.make(`bounded-${catalog}`),
            text: "Find evidence",
          }),
        );
        yield* harness.firstTerminal;
        const event = harness.events.find(
          (entry) =>
            entry.type === "message.updated" &&
            entry.message.role === "assistant" &&
            !entry.message.streaming,
        );
        assert.ok(event?.type === "message.updated");
        assert.equal(event.message.text, text);
        assert.ok(event.message.citationPresentation);
        const metadata = yield* decodeCitationPresentation(event.message.citationPresentation);
        assert.deepEqual(
          metadata.sources,
          catalog === "oversized" ? [{ id: "s127", url: "https://example.test/127" }] : [],
        );
        const item = harness.events.find(
          (entry) =>
            entry.type === "turn_item.updated" &&
            entry.turnItem.type === "assistant_message" &&
            !entry.turnItem.streaming,
        );
        assert.ok(item?.type === "turn_item.updated" && item.turnItem.type === "assistant_message");
        assert.equal(item.turnItem.text, text);
        assert.deepEqual(item.turnItem.citationPresentation, metadata);
      }).pipe(Effect.provide(imagePersistenceLayer)),
    ),
  );

  it.effect.each(
    (["saved", "default-path", "missing", "foreign", "failed"] as const).map((outcome) => ({
      caseTitle: `projects native Codex generated images with ${outcome} materialization`,
      outcome,
    })),
  )("$caseTitle", ({ outcome }) => {
    const logs: unknown[] = [];
    const logger = Logger.make(({ message }) => {
      logs.push(message);
    });
    return Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({ prefix: "scient-codex-images-" });
        const nativeThreadId = `images-${outcome}`;
        const nativeTurnId = `image-turn-${outcome}`;
        const imageId = "generated-image";
        const imageRoot = path.join(home, "generated_images", nativeThreadId);
        yield* fs.makeDirectory(imageRoot, { recursive: true });
        const sourcePath = path.join(outcome === "foreign" ? home : imageRoot, `${imageId}.png`);
        const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
        if (outcome !== "missing") yield* fs.writeFile(sourcePath, bytes);
        const imageEvent: CodexReplay.CodexAppServerReplayEntry = {
          type: "emit_inbound",
          label: "native generated image",
          frame: {
            method: "item/completed",
            params: {
              threadId: nativeThreadId,
              turnId: nativeTurnId,
              item: {
                type: "imageGeneration",
                id: imageId,
                status: outcome === "failed" ? "failed" : "completed",
                result: "not-projected-inline-base64",
                ...(outcome === "default-path" ? {} : { savedPath: sourcePath }),
              },
            },
          },
        };
        const replayContext = "Repeat generated image receipt after source removal";
        const initialImages = yield* Deferred.make<void>();
        const durableReplay = yield* Deferred.make<void>();
        let receivedImages = 0;
        const transcript = makeCodexReplayTranscript({
          scenario: `images-${outcome}`,
          entries: [
            ...codexReplayPreamble({ nativeThreadId, nativeTurnId, prompt: "Draw an image" }),
            {
              type: "emit_inbound",
              label: "ordinary image view is not generated output",
              frame: {
                method: "item/completed",
                params: {
                  threadId: nativeThreadId,
                  turnId: nativeTurnId,
                  item: {
                    id: "ordinary-image-view",
                    type: "imageView",
                    path: sourcePath,
                    result: "ordinary-view-metadata",
                  },
                },
              },
            },
            imageEvent,
            { ...imageEvent, label: "duplicate native image receipt" },
            ...(outcome !== "saved"
              ? []
              : [
                  {
                    type: "expect_outbound" as const,
                    label: "causal receipt replay trigger",
                    frame: {
                      id: 4,
                      method: "thread/inject_items",
                      params: {
                        threadId: nativeThreadId,
                        items: historyResponseItems([], replayContext),
                      },
                    },
                  },
                  { type: "emit_inbound" as const, frame: { id: 4, result: {} } },
                  { ...imageEvent, label: "native replay after source removal" },
                ]),
            {
              type: "emit_inbound",
              label: "final text",
              frame: {
                method: "item/completed",
                params: {
                  threadId: nativeThreadId,
                  turnId: nativeTurnId,
                  item: {
                    type: "agentMessage",
                    id: "image-final-answer",
                    text: "The image is ready.",
                    phase: "final_answer",
                  },
                },
              },
            },
            {
              type: "emit_inbound",
              label: "completed",
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
        const harness = yield* makeCodexReplayHarness(
          transcript,
          (event) => {
            if (event.type !== "message.updated" || event.message.text === "The image is ready.")
              return Effect.void;
            receivedImages += 1;
            return receivedImages === 2
              ? Deferred.succeed(initialImages, undefined)
              : receivedImages === 3
                ? Deferred.succeed(durableReplay, undefined)
                : Effect.void;
          },
          undefined,
          undefined,
          false,
          { ...DEFAULT_CODEX_SETTINGS, homePath: home },
        );
        yield* harness.runtime.startTurn(
          makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now: yield* DateTime.now,
            attemptId: RunAttemptId.make(`image-attempt-${outcome}`),
            text: "Draw an image",
          }),
        );
        if (outcome === "saved") {
          yield* Deferred.await(initialImages);
          yield* fs.remove(sourcePath);
          if (harness.runtime.injectHistory === undefined)
            return yield* Effect.die("Missing native replay trigger");
          yield* harness.runtime.injectHistory({
            providerThread: harness.providerThread,
            context: replayContext,
            messages: [],
          });
          yield* Deferred.await(durableReplay);
        }
        yield* harness.firstTerminal;
        const imageMessages = harness.events.filter(
          (event) =>
            event.type === "message.updated" &&
            event.message.role === "assistant" &&
            event.message.text !== "The image is ready.",
        );
        assert.lengthOf(imageMessages, outcome === "saved" ? 3 : 2);
        assert.isFalse(
          harness.events.some(
            (event) =>
              event.type === "message.updated" &&
              event.message.attachments.some((attachment) =>
                attachment.id.includes("ordinary-image-view"),
              ),
          ),
        );
        const first = imageMessages[0];
        const replay = imageMessages[1];
        if (first?.type !== "message.updated" || replay?.type !== "message.updated")
          return yield* Effect.die("Missing image messages");
        assert.equal(first.message.id, replay.message.id);
        assert.deepEqual(first.message.attachments, replay.message.attachments);
        for (const receipt of imageMessages)
          if (receipt.type === "message.updated") {
            assert.equal(receipt.message.id, first.message.id);
            assert.deepEqual(receipt.message.attachments, first.message.attachments);
          }
        const turnItem = harness.events.find(
          (event) =>
            event.type === "turn_item.updated" &&
            event.turnItem.type === "assistant_message" &&
            event.turnItem.messageId === first.message.id,
        );
        if (
          turnItem?.type !== "turn_item.updated" ||
          turnItem.turnItem.type !== "assistant_message"
        )
          return yield* Effect.die("Missing image assistant item");
        assert.deepEqual(turnItem.turnItem.attachments, first.message.attachments);
        assert.equal(turnItem.turnItem.text, first.message.text);
        assert.equal(first.message.streaming, false);
        if (outcome === "saved" || outcome === "default-path") {
          assert.equal(first.message.text, "");
          assert.lengthOf(first.message.attachments, 1);
          const attachment = first.message.attachments[0];
          if (attachment?.type !== "image") return yield* Effect.die("Missing image attachment");
          const durablePath = resolveAttachmentPath({
            attachmentsDir: harness.serverConfig.attachmentsDir,
            attachment,
          });
          if (!durablePath) return yield* Effect.die("Missing durable attachment path");
          assert.deepEqual(yield* fs.readFile(durablePath), bytes);
          assert.notEqual(durablePath, sourcePath);
        } else {
          assert.isEmpty(first.message.attachments);
          assert.include(first.message.text, "Scient could not attach it");
          assert.notInclude(first.message.text, sourcePath);
        }
        assert.isTrue(
          harness.events.some(
            (event) =>
              event.type === "message.updated" && event.message.text === "The image is ready.",
          ),
        );
        assert.isFalse(
          harness.events.some(
            (event) =>
              event.type === "message.updated" &&
              event.message.text.includes("not-projected-inline-base64"),
          ),
        );
        assert.equal(harness.terminalEvents()[0]?.status, "completed");
        const ingestor = yield* ProviderEventIngestor.ProviderEventIngestorV2;
        const sink = yield* EventSink.EventSinkV2;
        const store = yield* EventStore.EventStoreV2;
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        const ids = yield* IdAllocator.IdAllocatorV2;
        const now = yield* DateTime.now;
        const appThread = makeCodexTestTurnInput({
          threadId: harness.threadId,
          providerThread: harness.providerThread,
          now,
          attemptId: RunAttemptId.make(`image-attempt-${outcome}`),
          text: "Draw an image",
        }).appThread;
        yield* sink.write({
          events: [
            {
              id: yield* ids.allocate.event({ threadId: harness.threadId }),
              threadId: harness.threadId,
              type: "thread.created",
              occurredAt: now,
              payload: appThread,
            },
          ],
        });
        for (const event of harness.events) {
          if (
            event.type !== "message.updated" &&
            event.type !== "turn_item.updated" &&
            event.type !== "node.updated"
          )
            continue;
          yield* ingestor.ingestNormalized({
            providerSessionId: harness.runtime.providerSession.id,
            providerInstanceId: CODEX_TEST_MODEL_SELECTION.instanceId,
            threadId: harness.threadId,
            event,
          });
        }
        const projected = yield* projections.getThreadProjection(harness.threadId);
        assert.lengthOf(
          projected.messages.filter((message) => message.id === first.message.id),
          1,
        );
        assert.deepEqual(
          projected.messages.find((message) => message.id === first.message.id)?.attachments,
          first.message.attachments,
        );
        const projectedItem = projected.turnItems.find(
          (item) => item.type === "assistant_message" && item.messageId === first.message.id,
        );
        if (projectedItem?.type !== "assistant_message")
          return yield* Effect.die("Missing persisted image item");
        assert.deepEqual(projectedItem.attachments, first.message.attachments);
        const stored = yield* store.read({ threadId: harness.threadId }).pipe(Stream.runCollect);
        const rebuilt = yield* Effect.gen(function* () {
          const replayed = yield* ProjectionStore.ProjectionStoreV2;
          for (const row of stored) yield* replayed.apply(row.event);
          return yield* replayed.getThreadProjection(harness.threadId);
        }).pipe(Effect.provide(ProjectionStore.layer.pipe(Layer.provide(SqlitePersistenceMemory))));
        assert.deepEqual(
          rebuilt.messages.find((message) => message.id === first.message.id)?.attachments,
          first.message.attachments,
        );
        const rebuiltItem = rebuilt.turnItems.find(
          (item) => item.type === "assistant_message" && item.messageId === first.message.id,
        );
        if (rebuiltItem?.type !== "assistant_message")
          return yield* Effect.die("Missing rebuilt image item");
        assert.deepEqual(rebuiltItem.attachments, first.message.attachments);
        assert.equal(rebuiltItem.text, first.message.text);
        const warnings = logs.filter(
          (message) =>
            Array.isArray(message) &&
            message[0] === "orchestration-v2.codex.generated-image-import-failed",
        );
        assert.lengthOf(warnings, outcome === "saved" || outcome === "default-path" ? 0 : 2);
        if (outcome === "missing" || outcome === "foreign" || outcome === "failed") {
          const encoded = encodeUnknownJson(warnings);
          assert.include(
            encoded,
            outcome === "missing"
              ? "ENOENT"
              : outcome === "foreign"
                ? "outside_authorized_root"
                : "provider_generation_failed",
          );
          assert.notInclude(encoded, home);
          assert.notInclude(encoded, sourcePath);
        }
      }).pipe(Effect.provide(imagePersistenceLayer)),
    ).pipe(Effect.provide(Logger.layer([logger], { mergeWithExisting: false })));
  });

  it.effect.each(
    (
      [
        {
          name: "preserves runtime guidance and restores it after compaction with MCP=false",
          hasMcp: false,
          mode: "default",
          grants: false,
        },
        {
          name: "preserves runtime guidance and restores it after compaction with MCP=true",
          hasMcp: true,
          mode: "default",
          grants: true,
        },
        {
          name: "keeps native plan instructions separate from granted Scient awareness",
          hasMcp: true,
          mode: "plan",
          grants: true,
        },
        {
          name: "delivers native Scient identity with no capability grants in default mode",
          hasMcp: true,
          mode: "default",
          grants: false,
        },
        {
          name: "delivers native Scient identity with no capability grants in plan mode",
          hasMcp: true,
          mode: "plan",
          grants: false,
        },
      ] as const
    ).map((scenario) => ({ caseTitle: scenario.name, scenario })),
  )("$caseTitle", ({ scenario }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const sessions = yield* McpProviderSessions.McpProviderSessions;
        const nativeThreadId = "context-thread";
        const nativeTurnId = "context-turn";
        const { hasMcp } = scenario;
        const runtimePolicy = { ...CODEX_TEST_RUNTIME_POLICY, interactionMode: scenario.mode };
        const capabilities = new Set<McpCapability>(
          scenario.grants ? ["preview", "documents:build", "compute", "skills:read"] : [],
        );
        const modelSelection: ModelSelection = {
          ...CODEX_TEST_MODEL_SELECTION,
          options: [{ id: "reasoningEffort", value: "high" }],
        };
        const params = yield* CodexAdapterV2.buildCodexTurnStartParams({
          nativeThreadId,
          codexInput: [{ type: "text", text: "work" }],
          runtimePolicy,
          modelSelection,
          hasT3Mcp: hasMcp,
          mcpCapabilities: capabilities,
        });
        const contextSchema = Schema.Struct({
          additionalContext: Schema.Record(Schema.String, Schema.Struct({ value: Schema.String })),
        });
        const decodeContext = Schema.decodeUnknownEffect(contextSchema);
        const delivered = yield* Ref.make<ReadonlyArray<Schema.Schema.Type<typeof contextSchema>>>(
          [],
        );
        const entries = codexReplayPreamble({ nativeThreadId, nativeTurnId, prompt: "work" });
        const transcript = makeCodexReplayTranscript({
          scenario: "restore-context",
          entries: [
            ...entries.slice(0, 5),
            {
              type: "expect_outbound",
              label: "context turn",
              frame: { id: 3, method: "turn/start", params },
            },
            ...entries.slice(6),
            {
              type: "emit_inbound",
              label: "compacted",
              frame: {
                method: "item/completed",
                params: {
                  threadId: nativeThreadId,
                  turnId: nativeTurnId,
                  item: { type: "contextCompaction", id: "compact-context" },
                },
              },
            },
            {
              type: "expect_outbound",
              label: "restore context",
              frame: {
                id: 4,
                method: "thread/inject_items",
                params: {
                  threadId: nativeThreadId,
                  items: Object.entries(params.additionalContext ?? {}).map(([key, entry]) => ({
                    type: "message",
                    role: "developer",
                    content: [{ type: "input_text", text: `<${key}>${entry.value}</${key}>` }],
                  })),
                },
              },
            },
            { type: "emit_inbound", label: "restored", frame: { id: 4, result: {} } },
            {
              type: "emit_inbound",
              label: "done",
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
        const harness = yield* makeCodexReplayHarness(transcript, undefined, (method, packet) =>
          method === "turn/start"
            ? decodeContext(packet).pipe(
                Effect.orDie,
                Effect.flatMap((context) =>
                  Ref.update(delivered, (current) => [...current, context]),
                ),
              )
            : Effect.void,
        );
        if (hasMcp)
          yield* sessions.set({
            environmentId: EnvironmentId.make("test"),
            threadId: harness.threadId,
            providerSessionId: "context-session",
            providerInstanceId: ProviderInstanceId.make("codex"),
            endpoint: "http://127.0.0.1:43123/mcp",
            authorizationHeader: "Bearer test",
            capabilities,
            connectors: [],
          });
        yield* Effect.addFinalizer(() => sessions.clear(harness.threadId));
        yield* harness.runtime.startTurn({
          ...makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now: yield* DateTime.now,
            attemptId: RunAttemptId.make("context-attempt"),
            text: "work",
          }),
          modelSelection,
          runtimePolicy,
        });
        yield* harness.firstTerminal;
        const contexts = yield* Ref.get(delivered);
        assert.lengthOf(contexts, 1);
        const context = contexts[0]!.additionalContext;
        const awareness = context.scient_awareness?.value ?? "";
        for (const tool of [
          "preview_status",
          "preview_open",
          "scient_pdf_build",
          "scient_compute_inventory",
          "scient_skill_load",
        ]) {
          if (scenario.grants) assert.include(awareness, tool);
          else assert.notInclude(awareness, tool);
        }
        assert.notInclude(awareness, "device_open");
        const orchestrationEntries = Object.entries(context)
          .filter(([key]) => key.startsWith("t3_code_orchestration_"))
          .sort(([left], [right]) => left.localeCompare(right));
        if (hasMcp) {
          const orchestration = orchestrationEntries.map(([, entry]) => entry.value).join("\n\n");
          assert.equal(orchestration, SCIENT_ORCHESTRATION_INSTRUCTIONS.trim());
          assert.include(orchestration, "delegate_task");
        } else {
          assert.isEmpty(orchestrationEntries);
        }
        for (const entry of Object.values(context)) {
          assert.isAtMost(Buffer.byteLength(entry.value, "utf8"), 4_000);
        }
        assert.equal(harness.terminalEvents()[0]?.status, "completed");
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            IdAllocator.layer,
            McpProviderSessions.layer,
            Layer.merge(NodeServices.layer, ThreadCommandExecutor.layer),
          ),
        ),
      ),
    ),
  );
});

describe("CodexAdapterV2 runtime policy (Policy)", () => {
  it.effect("compiles per-turn Codex model options and cwd from their owning inputs", () =>
    Effect.gen(function* () {
      const params = yield* CodexAdapterV2.buildCodexTurnStartParams({
        nativeThreadId: "native-model-options",
        codexInput: [{ type: "text", text: "test" }],
        runtimePolicy: {
          runtimeMode: "full-access",
          interactionMode: "plan",
          cwd: "/workspace/model-options",
          reasoningEffort: "low",
        },
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.4",
          options: [
            { id: "reasoningEffort", value: "xhigh" },
            { id: "serviceTier", value: "priority" },
          ],
        },
      });

      assert.equal(params.model, "gpt-5.4");
      assert.equal(params.effort, "xhigh");
      assert.equal(params.serviceTier, "priority");
      assert.equal(params.cwd, "/workspace/model-options");
      assert.equal(params.collaborationMode?.settings.model, "gpt-5.4");
      assert.equal(params.collaborationMode?.settings.reasoning_effort, "xhigh");

      // ChatGPT token sharing rejects service tiers, so managed sessions drop a stale pick.
      const managed = yield* CodexAdapterV2.buildCodexTurnStartParams({
        nativeThreadId: "native-model-options",
        codexInput: [{ type: "text", text: "test" }],
        runtimePolicy: {
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd: "/workspace/model-options",
        },
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.4",
          options: [{ id: "serviceTier", value: "priority" }],
        },
        omitServiceTier: true,
      });
      assert.equal(managed.serviceTier, undefined);
    }),
  );
});

describe("CodexAdapterV2 dynamic tool projection (Protocol)", () => {
  it.effect("uses the CUA call title while leaving other MCP titles as tool arguments", () =>
    Effect.gen(function* () {
      const call = {
        type: "mcpToolCall" as const,
        id: "inspect",
        server: "cua_repl",
        tool: "js",
        status: "completed" as const,
        arguments: {
          code: "await game.getAXStateAndScreenshot();",
          title: "Inspect Saga music screen",
        },
        result: { content: [] },
      };
      assert.equal(
        (yield* CodexAdapterV2.projectCodexDynamicToolItem(call)).title,
        "Inspect Saga music screen",
      );
      const blankTitle = yield* CodexAdapterV2.projectCodexDynamicToolItem({
        ...call,
        arguments: { title: "  " },
      });
      assert.equal(blankTitle.title, "Computer use");
      assert.deepEqual(blankTitle.input, { title: "  " });
      const otherMcp = yield* CodexAdapterV2.projectCodexDynamicToolItem({
        ...call,
        server: "github",
      });
      assert.equal(otherMcp.title, "js");
      assert.notEqual(otherMcp.title, call.arguments.title);
      assert.deepEqual(otherMcp.input, call.arguments);
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );
});

describe("CodexAdapterV2 post-settle continuation (Sessions)", () => {
  it.effect(
    "withholds a live peer's MCP config and turn instructions when native injection is disabled",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const sessions = yield* McpProviderSessions.McpProviderSessions;
          const scenario = "disabled-mcp-peer";
          const threadId = ThreadId.make(`thread-${scenario}`);
          const nativeThreadId = "disabled-mcp-native";
          const nativeTurnId = "disabled-mcp-turn";
          yield* sessions.set({
            environmentId: EnvironmentId.make("disabled-mcp-environment"),
            threadId,
            providerSessionId: "disabled-mcp-live-peer",
            providerInstanceId: CODEX_TEST_MODEL_SELECTION.instanceId,
            endpoint: "http://127.0.0.1:43123/mcp",
            authorizationHeader: "Bearer synthetic-live-peer",
            capabilities: new Set(["orchestration", "skills:read"] as const),
            connectors: [],
          });
          yield* Effect.addFinalizer(() => sessions.clear(threadId));
          const transcript = makeCodexReplayTranscript({
            scenario,
            entries: [
              ...codexReplayPreamble({ nativeThreadId, nativeTurnId, prompt: "work" }),
              {
                type: "emit_inbound",
                label: "completed",
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
          // Exact replay expectations require no peer MCP server/config or agent-facing tool instructions.
          const harness = yield* makeCodexReplayHarness(
            transcript,
            undefined,
            undefined,
            undefined,
            false,
          );
          yield* harness.runtime.startTurn(
            makeCodexTestTurnInput({
              threadId,
              providerThread: harness.providerThread,
              now: yield* DateTime.now,
              attemptId: RunAttemptId.make("disabled-mcp-attempt"),
              text: "work",
            }),
          );
          yield* harness.firstTerminal;
          assert.equal(harness.terminalEvents()[0]?.status, "completed");
          assert.equal(
            (yield* sessions.read(threadId))?.providerSessionId,
            "disabled-mcp-live-peer",
          );
        }).pipe(
          Effect.provide(
            Layer.mergeAll(IdAllocator.layer, NodeServices.layer, McpProviderSessions.layer),
          ),
        ),
      ),
  );

  it.effect("applies distinct native thread workspaces inside one pooled Codex process", () =>
    Effect.gen(function* () {
      const firstNative = "pooled-project-one";
      const secondNative = "pooled-project-two";
      const preamble = codexReplayPreamble({
        nativeThreadId: firstNative,
        nativeTurnId: "unused",
        prompt: "unused",
      });
      const second = codexReplayPreamble({
        nativeThreadId: secondNative,
        nativeTurnId: "unused",
        prompt: "unused",
        startRequestId: 3,
        cwd: "/workspace/second-project",
      });
      const h = yield* makeCodexReplayHarness(
        makeCodexReplayTranscript({
          scenario: "pooled-project-workspaces",
          entries: [...preamble.slice(0, 5), ...second.slice(3, 5)],
        }),
      );
      const sibling = yield* h.runtime.ensureThread({
        threadId: ThreadId.make("pooled-second-app-thread"),
        modelSelection: CODEX_TEST_MODEL_SELECTION,
        runtimePolicy: { ...CODEX_TEST_RUNTIME_POLICY, cwd: "/workspace/second-project" },
      });
      assert.equal(
        h.runtime.providerSession.capabilities.sessions.supportsPerThreadWorkspace,
        true,
      );
      assert.equal(h.providerThread.nativeThreadRef?.nativeId, firstNative);
      assert.equal(sibling.nativeThreadRef?.nativeId, secondNative);
      assert.equal(sibling.providerSessionId, h.providerThread.providerSessionId);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(IdAllocator.layer, NodeServices.layer, McpProviderSessions.layer),
      ),
    ),
  );
});

describe("Codex restored Background", () => {
  describe("CodexAdapterV2 post-settle continuation", () => {
    const BG_SCENARIO = "codex-bg-exec-wake";

    const BG_NATIVE_THREAD = "native-codex-bg-thread";

    const BG_NATIVE_TURN = "native-codex-bg-turn";

    const BG_COMMAND_ITEM = "call-codex-bg-command";

    const BG_COMMAND = "sleep 20 && echo CODEX_BG_WAKE_DONE";

    const BG_PROMPT = "Start the sleep in the background and reply STARTED.";

    const backgroundCommandItem = (
      status: "inProgress" | "completed",
    ): Record<string, unknown> => ({
      type: "commandExecution",
      id: BG_COMMAND_ITEM,
      command: BG_COMMAND,
      cwd: "/workspace",
      processId: "4242",
      source: "unifiedExecStartup",
      status,
      commandActions: [{ type: "unknown", command: BG_COMMAND }],
      aggregatedOutput: status === "completed" ? "CODEX_BG_WAKE_DONE\n" : null,
      exitCode: status === "completed" ? 0 : null,
      durationMs: status === "completed" ? 25_000 : null,
    });

    const backgroundExecTranscript = makeCodexReplayTranscript({
      scenario: BG_SCENARIO,
      entries: [
        ...codexReplayPreamble({
          nativeThreadId: BG_NATIVE_THREAD,
          nativeTurnId: BG_NATIVE_TURN,
          prompt: BG_PROMPT,
        }),
        {
          type: "emit_inbound",
          label: "item/started/command",
          frame: {
            method: "item/started",
            params: {
              item: backgroundCommandItem("inProgress"),
              threadId: BG_NATIVE_THREAD,
              turnId: BG_NATIVE_TURN,
              startedAtMs: 1782622440500,
            },
          },
        },
        {
          type: "emit_inbound",
          label: "item/completed/root-answer",
          frame: {
            method: "item/completed",
            params: {
              item: {
                type: "agentMessage",
                id: "root-answer-bg",
                text: "STARTED",
                phase: "final_answer",
                memoryCitation: null,
              },
              threadId: BG_NATIVE_THREAD,
              turnId: BG_NATIVE_TURN,
              completedAtMs: 1782622441000,
            },
          },
        },
        {
          type: "emit_inbound",
          label: "turn/completed",
          frame: {
            method: "turn/completed",
            params: {
              threadId: BG_NATIVE_THREAD,
              turn: makeCodexReplayTurn({ id: BG_NATIVE_TURN, status: "completed" }),
            },
          },
        },
        {
          type: "emit_inbound",
          label: "item/completed/command-late",
          afterMs: 30_000,
          frame: {
            method: "item/completed",
            params: {
              item: backgroundCommandItem("completed"),
              threadId: BG_NATIVE_THREAD,
              turnId: BG_NATIVE_TURN,
              completedAtMs: 1782622465500,
            },
          },
        },
      ],
    });
    // regression: de34391427 feat(orchestrator): introduce new orchestrator (#2829)

    it.effect(
      "projects a post-settle background command completion and requests a continuation",
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const harness = yield* makeCodexReplayHarness(backgroundExecTranscript);
            const now = yield* DateTime.now;

            yield* harness.runtime.startTurn(
              makeCodexTestTurnInput({
                threadId: harness.threadId,
                providerThread: harness.providerThread,
                now,
                attemptId: RunAttemptId.make("attempt-codex-bg-wake"),
                text: BG_PROMPT,
              }),
            );
            yield* awaitUntil(() => harness.terminalEvents().length === 1, "root turn terminal");
            assert.equal(harness.terminalEvents()[0]?.status, "completed");
            assert.isTrue(yield* harness.hasPendingBackgroundWork);
            assert.isTrue(
              yield* harness.runtime.hasPendingBackgroundWorkForThread!(harness.providerThread),
            );
            assert.lengthOf(harness.continuationRequests, 0);
            const terminalIndex = harness.events.findIndex(
              (event) => event.type === "turn.terminal",
            );

            yield* TestClock.adjust("30 seconds");
            yield* awaitUntil(
              () => harness.continuationRequests.length === 1,
              "continuation request",
            );
            const request = harness.continuationRequests[0];
            assert.equal(request?.threadId, harness.threadId);
            assert.equal(request?.providerThreadId, harness.providerThread.id);
            assert.equal(request?.driver, CodexAdapterV2.CODEX_DRIVER_KIND);
            assert.deepEqual(request?.notification, {
              source: { kind: "command" },
              outcome: "completed",
              summary: `Command "${BG_COMMAND}" finished (exit 0)`,
              detail: BG_COMMAND,
            });
            assert.equal(
              request?.detail,
              `Background command completed (exit 0): ${BG_COMMAND}\n\n` +
                "Output tail:\nCODEX_BG_WAKE_DONE",
            );

            const lateCommandUpdateIndex = () =>
              harness.events.findIndex(
                (event, index) =>
                  index > terminalIndex &&
                  event.type === "turn_item.updated" &&
                  event.turnItem.type === "command_execution" &&
                  event.turnItem.status === "completed" &&
                  event.turnItem.output === "CODEX_BG_WAKE_DONE\n" &&
                  event.turnItem.exitCode === 0,
              );
            yield* awaitUntil(
              () => lateCommandUpdateIndex() > terminalIndex,
              "post-settle command projection",
            );
            assert.lengthOf(harness.terminalEvents(), 1);
            assert.isFalse(yield* harness.hasPendingBackgroundWork);
          }).pipe(
            Effect.provide(
              Layer.mergeAll(IdAllocator.layer, NodeServices.layer, McpProviderSessions.layer),
            ),
          ),
        ),
    );

    const PRE_SETTLE_SCENARIO = "codex-bg-exec-pre-settle";

    const PRE_SETTLE_NATIVE_THREAD = "native-codex-pre-settle-thread";

    const PRE_SETTLE_NATIVE_TURN = "native-codex-pre-settle-turn";

    const preSettleTranscript = makeCodexReplayTranscript({
      scenario: PRE_SETTLE_SCENARIO,
      entries: [
        ...codexReplayPreamble({
          nativeThreadId: PRE_SETTLE_NATIVE_THREAD,
          nativeTurnId: PRE_SETTLE_NATIVE_TURN,
          prompt: BG_PROMPT,
        }),
        {
          type: "emit_inbound",
          label: "item/started/command",
          frame: {
            method: "item/started",
            params: {
              item: backgroundCommandItem("inProgress"),
              threadId: PRE_SETTLE_NATIVE_THREAD,
              turnId: PRE_SETTLE_NATIVE_TURN,
              startedAtMs: 1782622440500,
            },
          },
        },
        {
          type: "emit_inbound",
          label: "item/completed/command-pre-settle",
          frame: {
            method: "item/completed",
            params: {
              item: backgroundCommandItem("completed"),
              threadId: PRE_SETTLE_NATIVE_THREAD,
              turnId: PRE_SETTLE_NATIVE_TURN,
              completedAtMs: 1782622441000,
            },
          },
        },
        {
          type: "emit_inbound",
          label: "item/completed/root-answer",
          frame: {
            method: "item/completed",
            params: {
              item: {
                type: "agentMessage",
                id: "root-answer-pre-settle",
                text: "DONE",
                phase: "final_answer",
                memoryCitation: null,
              },
              threadId: PRE_SETTLE_NATIVE_THREAD,
              turnId: PRE_SETTLE_NATIVE_TURN,
              completedAtMs: 1782622441500,
            },
          },
        },
        {
          type: "emit_inbound",
          label: "turn/completed",
          frame: {
            method: "turn/completed",
            params: {
              threadId: PRE_SETTLE_NATIVE_THREAD,
              turn: makeCodexReplayTurn({ id: PRE_SETTLE_NATIVE_TURN, status: "completed" }),
            },
          },
        },
      ],
    });
    // regression: de34391427 feat(orchestrator): introduce new orchestrator (#2829)

    it.effect("does not request a continuation for a command that completes before settle", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const harness = yield* makeCodexReplayHarness(preSettleTranscript);
          const now = yield* DateTime.now;

          yield* harness.runtime.startTurn(
            makeCodexTestTurnInput({
              threadId: harness.threadId,
              providerThread: harness.providerThread,
              now,
              attemptId: RunAttemptId.make("attempt-codex-bg-pre-settle"),
              text: BG_PROMPT,
            }),
          );
          yield* awaitUntil(() => harness.terminalEvents().length === 1, "root turn terminal");
          assert.equal(harness.terminalEvents()[0]?.status, "completed");
          yield* awaitUntil(
            () =>
              harness.events.some(
                (event) =>
                  event.type === "turn_item.updated" &&
                  event.turnItem.type === "command_execution" &&
                  event.turnItem.status === "completed" &&
                  event.turnItem.exitCode === 0,
              ),
            "pre-settle command projection",
          );

          yield* TestClock.adjust("30 seconds");
          for (let attempt = 0; attempt < 100; attempt++) {
            yield* Effect.yieldNow;
          }
          assert.lengthOf(harness.continuationRequests, 0);
          assert.isFalse(yield* harness.hasPendingBackgroundWork);
          assert.lengthOf(harness.terminalEvents(), 1);
        }).pipe(
          Effect.provide(
            Layer.mergeAll(IdAllocator.layer, NodeServices.layer, McpProviderSessions.layer),
          ),
        ),
      ),
    );
  });
});

describe("Codex restored CapacitySkills", () => {
  describe("CodexAdapterV2 post-settle continuation", () => {
    // regression: de34391427 feat(orchestrator): introduce new orchestrator (#2829)

    it.effect("sends currency-sigil skill mentions to Codex as $ mentions", () =>
      Effect.gen(function* () {
        const nativeThreadId = "skill-sigil-thread";
        const nativeTurnId = "skill-sigil-turn";
        const transcript = makeCodexReplayTranscript({
          scenario: "skill-sigil-canonicalized",
          entries: [
            ...codexReplayPreamble({
              nativeThreadId,
              nativeTurnId,
              prompt: "€review do it",
              sentPrompt: "$review do it",
            }),
            {
              type: "expect_outbound",
              label: "turn/steer",
              frame: {
                id: 4,
                method: "turn/steer",
                params: {
                  expectedTurnId: nativeTurnId,
                  input: [{ type: "text", text: "then $ship it" }],
                  threadId: nativeThreadId,
                },
              },
            },
            {
              type: "emit_inbound",
              label: "turn/steer",
              frame: { id: 4, result: { turnId: nativeTurnId } },
            },
          ],
        });
        const harness = yield* makeCodexReplayHarness(transcript);
        const turnInput = makeCodexTestTurnInput({
          threadId: harness.threadId,
          providerThread: harness.providerThread,
          now: yield* DateTime.now,
          attemptId: RunAttemptId.make("skill-sigil-attempt"),
          text: "€review do it",
        });
        yield* harness.runtime.startTurn(turnInput);
        yield* harness.runtime.steerTurn({
          threadId: harness.threadId,
          runId: turnInput.runId,
          providerThread: harness.providerThread,
          providerTurnId: (yield* IdAllocator.IdAllocatorV2).derive.providerTurn({
            driver: CodexAdapterV2.CODEX_DRIVER_KIND,
            nativeTurnId,
          }),
          message: {
            ...turnInput.message,
            messageId: MessageId.make("message-skill-sigil-steer"),
            text: "then £ship it",
          },
        });
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, NodeServices.layer, McpProviderSessions.layer),
        ),
      ),
    );
  });
});

describe("Codex restored CommandStop", () => {
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
    // regression: de34391427 feat(orchestrator): introduce new orchestrator (#2829)

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
                event.type === "provider_turn.updated" &&
                event.providerTurn.status === "interrupted",
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
        }).pipe(
          Effect.provide(
            Layer.mergeAll(IdAllocator.layer, NodeServices.layer, McpProviderSessions.layer),
          ),
        ),
      ),
    );

    const interruptTerminationFailureTranscript = makeCodexReplayTranscript({
      scenario: "codex-interrupt-termination-failure",
      entries: [
        ...interruptMidCommandTranscript.entries
          .filter(
            (entry) =>
              entry.type === "runtime_exit" || entry.label !== "item/completed/command-late",
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
    // regression: de34391427 feat(orchestrator): introduce new orchestrator (#2829)

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
        }).pipe(
          Effect.provide(
            Layer.mergeAll(IdAllocator.layer, NodeServices.layer, McpProviderSessions.layer),
          ),
        ),
      ),
    );
  });
});

describe("Codex restored DescendantStop", () => {
  describe("CodexAdapterV2 post-settle continuation", () => {
    const INTERRUPT_CHILD_COMMAND_ITEM = "exec-codex-interrupt-child-command";

    const INTERRUPT_CHILD_TIMEOUT_BOUNDARY_ITEM = "exec-codex-interrupt-child-timeout-boundary";

    const INTERRUPT_CHILD_NATIVE_THREAD = "native-codex-interrupt-child-thread";

    const INTERRUPT_CHILD_NATIVE_TURN = "native-codex-interrupt-child-turn";

    const INTERRUPT_LATE_CHILD_NATIVE_TURN = "native-codex-interrupt-late-child-turn";

    const INTERRUPT_LATE_CHILD_2_NATIVE_TURN = "native-codex-interrupt-late-child-2-turn";

    const interruptSubagentCommandTranscript = makeCodexReplayTranscript({
      scenario: "codex-interrupt-subagent-command",
      entries: [
        ...codexReplayPreamble({
          nativeThreadId: INTERRUPT_NATIVE_THREAD,
          nativeTurnId: INTERRUPT_NATIVE_TURN,
          prompt: INTERRUPT_PROMPT,
        }),
        {
          type: "emit_inbound",
          label: "item/completed/subAgentActivity-started",
          frame: {
            method: "item/completed",
            params: {
              item: {
                type: "subAgentActivity",
                id: "call-codex-interrupt-subagent",
                kind: "started",
                agentThreadId: INTERRUPT_CHILD_NATIVE_THREAD,
                agentPath: "/root/stop_hold",
              },
              threadId: INTERRUPT_NATIVE_THREAD,
              turnId: INTERRUPT_NATIVE_TURN,
              completedAtMs: 1782622441000,
            },
          },
        },
        {
          type: "emit_inbound",
          label: "turn/started/child",
          frame: {
            method: "turn/started",
            params: {
              threadId: INTERRUPT_CHILD_NATIVE_THREAD,
              turn: makeCodexReplayTurn({
                id: INTERRUPT_CHILD_NATIVE_TURN,
                status: "inProgress",
              }),
            },
          },
        },
        {
          type: "emit_inbound",
          label: "item/started/child-command",
          frame: {
            method: "item/started",
            params: {
              item: {
                ...interruptCommandItem("inProgress"),
                id: INTERRUPT_CHILD_COMMAND_ITEM,
                processId: "57682",
              },
              threadId: INTERRUPT_CHILD_NATIVE_THREAD,
              turnId: INTERRUPT_CHILD_NATIVE_TURN,
              startedAtMs: 1782622441500,
            },
          },
        },
        {
          type: "expect_outbound",
          label: "turn/interrupt/root",
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
          label: "turn/interrupt/root",
          frame: { id: 4, result: {} },
        },
        {
          type: "expect_outbound",
          label: "turn/interrupt/child",
          frame: {
            id: 5,
            method: "turn/interrupt",
            params: {
              threadId: INTERRUPT_CHILD_NATIVE_THREAD,
              turnId: INTERRUPT_CHILD_NATIVE_TURN,
            },
          },
        },
        {
          type: "emit_inbound",
          label: "turn/interrupt/child",
          frame: { id: 5, result: {} },
        },
        {
          type: "expect_outbound",
          label: "thread/backgroundTerminals/terminate/child",
          frame: {
            id: 6,
            method: "thread/backgroundTerminals/terminate",
            params: { threadId: INTERRUPT_CHILD_NATIVE_THREAD, processId: "57682" },
          },
        },
        {
          type: "emit_inbound",
          label: "thread/backgroundTerminals/terminate/child",
          frame: { id: 6, result: { terminated: true } },
        },
        {
          type: "emit_inbound",
          label: "turn/completed/root",
          frame: {
            method: "turn/completed",
            params: {
              threadId: INTERRUPT_NATIVE_THREAD,
              turn: makeCodexReplayTurn({ id: INTERRUPT_NATIVE_TURN, status: "interrupted" }),
            },
          },
        },
        {
          type: "emit_inbound",
          label: "turn/completed/child-completed-race",
          frame: {
            method: "turn/completed",
            params: {
              threadId: INTERRUPT_CHILD_NATIVE_THREAD,
              turn: makeCodexReplayTurn({
                id: INTERRUPT_CHILD_NATIVE_TURN,
                status: "completed",
              }),
            },
          },
        },
        { type: "runtime_exit", status: "success" },
      ],
    });

    const assertChildProviderTerminalBeforeRoot = (
      events: ReadonlyArray<ProviderAdapterV2Event>,
      rootThreadId: ThreadId,
    ) => {
      const terminalIndex = events.findIndex((event) => event.type === "turn.terminal");
      const childProviderTurnIndex = events.findIndex(
        (event) =>
          event.type === "provider_turn.updated" &&
          event.threadId !== rootThreadId &&
          event.providerTurn.status === "interrupted",
      );
      const childProviderThreadIndex = events.findIndex(
        (event) =>
          event.type === "provider_thread.updated" &&
          event.providerThread.appThreadId !== rootThreadId &&
          event.providerThread.status === "idle",
      );
      assert.isAtLeast(childProviderTurnIndex, 0, "child provider turn must terminalize");
      assert.isAtLeast(childProviderThreadIndex, 0, "child provider thread must become idle");
      assert.isAbove(
        terminalIndex,
        childProviderTurnIndex,
        "child provider turn must terminalize before the root run",
      );
      assert.isAbove(
        terminalIndex,
        childProviderThreadIndex,
        "child provider thread must become idle before the root run",
      );
    };

    const childInterruptResponseIndex = interruptSubagentCommandTranscript.entries.findIndex(
      (entry) => entry.type === "emit_inbound" && entry.label === "turn/interrupt/child",
    );

    const rootInterruptResponseIndex = interruptSubagentCommandTranscript.entries.findIndex(
      (entry) => entry.type === "emit_inbound" && entry.label === "turn/interrupt/root",
    );

    const interruptSubagentRequestFailureTranscript = makeCodexReplayTranscript({
      scenario: "codex-interrupt-subagent-request-failure",
      entries: [
        ...interruptSubagentCommandTranscript.entries.slice(0, rootInterruptResponseIndex + 1),
        {
          type: "emit_inbound",
          label: "turn/completed/root-before-child-interrupt-failure",
          frame: {
            method: "turn/completed",
            params: {
              threadId: INTERRUPT_NATIVE_THREAD,
              turn: makeCodexReplayTurn({ id: INTERRUPT_NATIVE_TURN, status: "interrupted" }),
            },
          },
        },
        ...interruptSubagentCommandTranscript.entries.slice(
          rootInterruptResponseIndex + 1,
          childInterruptResponseIndex,
        ),
        {
          type: "emit_inbound",
          label: "turn/interrupt/child",
          frame: {
            id: 5,
            error: { code: -32_000, message: "child interrupt request failed" },
          },
        },
        { type: "runtime_exit", status: "success" },
      ],
    });
    // regression: de34391427 feat(orchestrator): introduce new orchestrator (#2829)

    it.effect("terminalizes descendants before the root when an interrupt request fails", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const harness = yield* makeCodexReplayHarness(interruptSubagentRequestFailureTranscript);
          const now = yield* DateTime.now;

          yield* harness.runtime.startTurn(
            makeCodexTestTurnInput({
              threadId: harness.threadId,
              providerThread: harness.providerThread,
              now,
              attemptId: RunAttemptId.make("attempt-codex-interrupt-subagent-request-failure"),
              text: INTERRUPT_PROMPT,
            }),
          );
          yield* awaitUntil(
            () =>
              harness.events.some(
                (event) =>
                  event.type === "turn_item.updated" &&
                  event.turnItem.type === "command_execution" &&
                  event.turnItem.nativeItemRef?.nativeId === INTERRUPT_CHILD_COMMAND_ITEM &&
                  event.turnItem.status === "running",
              ),
            "running child command item",
          );
          const providerTurnId = harness.events.find(
            (event): event is Extract<ProviderAdapterV2Event, { type: "provider_turn.updated" }> =>
              event.type === "provider_turn.updated" && event.threadId === harness.threadId,
          )?.providerTurn.id;
          assert.isDefined(providerTurnId);

          const interruptExit = yield* harness.runtime
            .interruptTurn({ providerThread: harness.providerThread, providerTurnId })
            .pipe(Effect.exit);

          assert.equal(interruptExit._tag, "Failure");
          yield* awaitUntil(
            () => harness.terminalEvents().length === 1,
            "interrupted root terminal",
          );
          assertChildProviderTerminalBeforeRoot(harness.events, harness.threadId);
          assert.isFalse(yield* harness.hasPendingBackgroundWork);
        }).pipe(
          Effect.provide(
            Layer.mergeAll(IdAllocator.layer, NodeServices.layer, McpProviderSessions.layer),
          ),
        ),
      ),
    );

    const childTerminationResponseIndex = interruptSubagentCommandTranscript.entries.findIndex(
      (entry) =>
        entry.type === "emit_inbound" &&
        entry.label === "thread/backgroundTerminals/terminate/child",
    );

    const interruptSubagentTimeoutTranscript = makeCodexReplayTranscript({
      scenario: "codex-interrupt-subagent-timeout",
      entries: [
        ...interruptSubagentCommandTranscript.entries.slice(0, childTerminationResponseIndex + 1),
        {
          type: "emit_inbound",
          label: "item/started/child-timeout-boundary",
          frame: {
            method: "item/started",
            params: {
              item: {
                ...interruptCommandItem("inProgress"),
                id: INTERRUPT_CHILD_TIMEOUT_BOUNDARY_ITEM,
                processId: null,
              },
              threadId: INTERRUPT_CHILD_NATIVE_THREAD,
              turnId: INTERRUPT_CHILD_NATIVE_TURN,
              startedAtMs: 1782622441600,
            },
          },
        },
      ],
    });
    // regression: de34391427 feat(orchestrator): introduce new orchestrator (#2829)

    it.effect("terminalizes timed-out descendants before the root", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const harness = yield* makeCodexReplayHarness(interruptSubagentTimeoutTranscript);
          const now = yield* DateTime.now;

          yield* harness.runtime.startTurn(
            makeCodexTestTurnInput({
              threadId: harness.threadId,
              providerThread: harness.providerThread,
              now,
              attemptId: RunAttemptId.make("attempt-codex-interrupt-subagent-timeout"),
              text: INTERRUPT_PROMPT,
            }),
          );
          yield* awaitUntil(
            () =>
              harness.events.some(
                (event) =>
                  event.type === "turn_item.updated" &&
                  event.turnItem.type === "command_execution" &&
                  event.turnItem.nativeItemRef?.nativeId === INTERRUPT_CHILD_COMMAND_ITEM &&
                  event.turnItem.status === "running",
              ),
            "running child command item",
          );
          const providerTurnId = harness.events.find(
            (event): event is Extract<ProviderAdapterV2Event, { type: "provider_turn.updated" }> =>
              event.type === "provider_turn.updated" && event.threadId === harness.threadId,
          )?.providerTurn.id;
          assert.isDefined(providerTurnId);

          const interruptFiber = yield* harness.runtime
            .interruptTurn({ providerThread: harness.providerThread, providerTurnId })
            .pipe(Effect.forkScoped);
          yield* awaitUntil(
            () =>
              harness.events.some(
                (event) =>
                  event.type === "turn_item.updated" &&
                  event.turnItem.type === "command_execution" &&
                  event.turnItem.nativeItemRef?.nativeId ===
                    INTERRUPT_CHILD_TIMEOUT_BOUNDARY_ITEM &&
                  event.turnItem.status === "running",
              ),
            "child timeout boundary item",
          );
          yield* TestClock.adjust("10 seconds");
          yield* Fiber.join(interruptFiber);

          yield* awaitUntil(
            () => harness.terminalEvents().length === 1,
            "interrupted root terminal",
          );
          assertChildProviderTerminalBeforeRoot(harness.events, harness.threadId);
          assert.isFalse(yield* harness.hasPendingBackgroundWork);
        }).pipe(
          Effect.provide(
            Layer.mergeAll(IdAllocator.layer, NodeServices.layer, McpProviderSessions.layer),
          ),
        ),
      ),
    );

    const interruptRescanLateSubagentTurnTranscript = makeCodexReplayTranscript({
      scenario: "codex-interrupt-rescan-late-subagent-turn",
      entries: [
        ...interruptSubagentCommandTranscript.entries.slice(0, childTerminationResponseIndex + 1),
        {
          type: "emit_inbound",
          label: "turn/started/late-child-1",
          frame: {
            method: "turn/started",
            params: {
              threadId: INTERRUPT_CHILD_NATIVE_THREAD,
              turn: makeCodexReplayTurn({
                id: INTERRUPT_LATE_CHILD_NATIVE_TURN,
                status: "inProgress",
              }),
            },
          },
        },
        {
          type: "expect_outbound",
          label: "turn/interrupt/late-child-1",
          frame: {
            id: 7,
            method: "turn/interrupt",
            params: {
              threadId: INTERRUPT_CHILD_NATIVE_THREAD,
              turnId: INTERRUPT_LATE_CHILD_NATIVE_TURN,
            },
          },
        },
        {
          type: "emit_inbound",
          label: "turn/started/late-child-2",
          frame: {
            method: "turn/started",
            params: {
              threadId: INTERRUPT_CHILD_NATIVE_THREAD,
              turn: makeCodexReplayTurn({
                id: INTERRUPT_LATE_CHILD_2_NATIVE_TURN,
                status: "inProgress",
              }),
            },
          },
        },
        {
          type: "emit_inbound",
          label: "turn/interrupt/late-child-1",
          frame: { id: 7, result: {} },
        },
        {
          type: "expect_outbound",
          label: "turn/interrupt/late-child-2",
          frame: {
            id: 8,
            method: "turn/interrupt",
            params: {
              threadId: INTERRUPT_CHILD_NATIVE_THREAD,
              turnId: INTERRUPT_LATE_CHILD_2_NATIVE_TURN,
            },
          },
        },
        {
          type: "emit_inbound",
          label: "turn/interrupt/late-child-2",
          frame: { id: 8, result: {} },
        },
        { type: "runtime_exit", status: "success" },
      ],
    });
    // regression: de34391427 feat(orchestrator): introduce new orchestrator (#2829)

    it.effect("interrupts descendants discovered only by the final interrupt rescan", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const harness = yield* makeCodexReplayHarness(interruptRescanLateSubagentTurnTranscript);
          const now = yield* DateTime.now;

          yield* harness.runtime.startTurn(
            makeCodexTestTurnInput({
              threadId: harness.threadId,
              providerThread: harness.providerThread,
              now,
              attemptId: RunAttemptId.make("attempt-codex-interrupt-rescan-late-subagent-turn"),
              text: INTERRUPT_PROMPT,
            }),
          );
          yield* awaitUntil(
            () =>
              harness.events.some(
                (event) =>
                  event.type === "turn_item.updated" &&
                  event.turnItem.type === "command_execution" &&
                  event.turnItem.nativeItemRef?.nativeId === INTERRUPT_CHILD_COMMAND_ITEM &&
                  event.turnItem.status === "running",
              ),
            "running child command item",
          );
          const providerTurnId = harness.events.find(
            (event): event is Extract<ProviderAdapterV2Event, { type: "provider_turn.updated" }> =>
              event.type === "provider_turn.updated" && event.threadId === harness.threadId,
          )?.providerTurn.id;
          assert.isDefined(providerTurnId);

          const interruptFiber = yield* harness.runtime
            .interruptTurn({ providerThread: harness.providerThread, providerTurnId })
            .pipe(Effect.forkScoped);
          yield* awaitUntil(
            () =>
              harness.events.some(
                (event) =>
                  event.type === "provider_turn.updated" &&
                  event.providerTurn.nativeTurnRef?.nativeId === INTERRUPT_LATE_CHILD_NATIVE_TURN,
              ),
            "late child 1 provider turn",
          );
          yield* TestClock.adjust("10 seconds");
          yield* Fiber.join(interruptFiber);

          yield* awaitUntil(
            () => harness.terminalEvents().length === 1,
            "interrupted root terminal",
          );
          assert.equal(harness.terminalEvents()[0]?.status, "interrupted");

          const rootTerminalIndex = harness.events.findIndex(
            (event) => event.type === "turn.terminal",
          );
          const lateChild1InterruptedIndex = harness.events.findIndex(
            (event) =>
              event.type === "provider_turn.updated" &&
              event.providerTurn.nativeTurnRef?.nativeId === INTERRUPT_LATE_CHILD_NATIVE_TURN &&
              event.providerTurn.status === "interrupted",
          );
          const lateChild2InterruptedIndex = harness.events.findIndex(
            (event) =>
              event.type === "provider_turn.updated" &&
              event.providerTurn.nativeTurnRef?.nativeId === INTERRUPT_LATE_CHILD_2_NATIVE_TURN &&
              event.providerTurn.status === "interrupted",
          );
          assert.isAtLeast(
            lateChild1InterruptedIndex,
            0,
            "late child 1 must terminalize interrupted",
          );
          assert.isAtLeast(
            lateChild2InterruptedIndex,
            0,
            "late child 2 must terminalize interrupted",
          );
          assert.isAbove(
            rootTerminalIndex,
            lateChild1InterruptedIndex,
            "late child 1 must terminalize before the root run",
          );
          assert.isAbove(
            rootTerminalIndex,
            lateChild2InterruptedIndex,
            "late child 2 must terminalize before the root run",
          );
          assertChildProviderTerminalBeforeRoot(harness.events, harness.threadId);
          assert.isFalse(yield* harness.hasPendingBackgroundWork);
        }).pipe(
          Effect.provide(
            Layer.mergeAll(IdAllocator.layer, NodeServices.layer, McpProviderSessions.layer),
          ),
        ),
      ),
    );
  });
});

describe("Codex restored FinalAnswers", () => {
  describe("CodexAdapterV2 post-settle continuation", () => {
    const finalAnswerTranscript = (
      scenario: string,
      answers: ReadonlyArray<{
        readonly id: string;
        readonly text: string;
        readonly phase?: "commentary" | "final_answer" | null;
        readonly omitPhase?: boolean;
        readonly streamed?: boolean;
        readonly completionDelayMs?: number;
      }>,
    ) => {
      const nativeThreadId = `native-${scenario}-thread`;
      const nativeTurnId = `native-${scenario}-turn`;
      const prompt = "Reply with the requested recovery marker.";
      return makeCodexReplayTranscript({
        scenario,
        entries: [
          ...codexReplayPreamble({ nativeThreadId, nativeTurnId, prompt }),
          ...answers.flatMap(
            (answer, index): ReadonlyArray<CodexReplay.CodexAppServerReplayEntry> => {
              const phase = answer.omitPhase
                ? {}
                : { phase: answer.phase === undefined ? ("final_answer" as const) : answer.phase };
              const completed: CodexReplay.CodexAppServerReplayEntry = {
                type: "emit_inbound",
                label: `item/completed/${answer.id}`,
                ...(answer.completionDelayMs === undefined
                  ? {}
                  : { afterMs: answer.completionDelayMs }),
                frame: {
                  method: "item/completed",
                  params: {
                    item: {
                      type: "agentMessage",
                      id: answer.id,
                      text: answer.text,
                      ...phase,
                      memoryCitation: null,
                    },
                    threadId: nativeThreadId,
                    turnId: nativeTurnId,
                    completedAtMs: 1782622441000 + index,
                  },
                },
              };
              if (!answer.streamed) {
                return [completed];
              }
              return [
                {
                  type: "emit_inbound",
                  label: `item/started/${answer.id}`,
                  frame: {
                    method: "item/started",
                    params: {
                      item: {
                        type: "agentMessage",
                        id: answer.id,
                        text: "",
                        ...phase,
                        memoryCitation: null,
                      },
                      threadId: nativeThreadId,
                      turnId: nativeTurnId,
                      startedAtMs: 1782622440500 + index,
                    },
                  },
                },
                {
                  type: "emit_inbound",
                  label: `item/agentMessage/delta/${answer.id}`,
                  frame: {
                    method: "item/agentMessage/delta",
                    params: {
                      threadId: nativeThreadId,
                      turnId: nativeTurnId,
                      itemId: answer.id,
                      delta: answer.text,
                    },
                  },
                },
                completed,
              ];
            },
          ),
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
    };
    // regression: de34391427 feat(orchestrator): introduce new orchestrator (#2829)

    it.effect("suppresses a later streamed duplicate final answer", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const transcript = finalAnswerTranscript("codex-streamed-duplicate-final", [
            { id: "answer-original", text: "CODEX_RECOVERY_OK" },
            {
              id: "answer-duplicate",
              text: "CODEX_RECOVERY_OK",
              streamed: true,
              completionDelayMs: 100,
            },
          ]);
          const harness = yield* makeCodexReplayHarness(transcript);
          const now = yield* DateTime.now;

          yield* harness.runtime.startTurn(
            makeCodexTestTurnInput({
              threadId: harness.threadId,
              providerThread: harness.providerThread,
              now,
              attemptId: RunAttemptId.make("attempt-codex-streamed-duplicate-final"),
              text: "Reply with the requested recovery marker.",
            }),
          );
          yield* awaitUntil(
            () => assistantMessages(harness.events).length === 1,
            "original answer",
          );
          yield* Effect.yieldNow;
          yield* TestClock.adjust("50 millis");
          yield* Effect.yieldNow;

          assert.deepEqual(
            assistantMessages(harness.events).map((event) => event.message.text),
            ["CODEX_RECOVERY_OK"],
          );

          yield* TestClock.adjust("50 millis");
          yield* awaitUntil(() => harness.terminalEvents().length === 1, "root turn terminal");
          assert.deepEqual(
            assistantMessages(harness.events).map((event) => event.message.text),
            ["CODEX_RECOVERY_OK"],
          );
        }).pipe(
          Effect.provide(
            Layer.mergeAll(IdAllocator.layer, NodeServices.layer, McpProviderSessions.layer),
          ),
        ),
      ),
    );
    // regression: de34391427 feat(orchestrator): introduce new orchestrator (#2829)

    it.effect("preserves a sole empty final answer", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const transcript = finalAnswerTranscript("codex-sole-empty-final", [
            { id: "answer-empty", text: "" },
          ]);
          const harness = yield* makeCodexReplayHarness(transcript);
          const now = yield* DateTime.now;

          yield* harness.runtime.startTurn(
            makeCodexTestTurnInput({
              threadId: harness.threadId,
              providerThread: harness.providerThread,
              now,
              attemptId: RunAttemptId.make("attempt-codex-sole-empty-final"),
              text: "Reply with the requested recovery marker.",
            }),
          );
          yield* awaitUntil(() => harness.terminalEvents().length === 1, "root turn terminal");

          assert.deepEqual(
            assistantMessages(harness.events).map((event) => event.message.text),
            [""],
          );
        }).pipe(
          Effect.provide(
            Layer.mergeAll(IdAllocator.layer, NodeServices.layer, McpProviderSessions.layer),
          ),
        ),
      ),
    );
    // regression: de34391427 feat(orchestrator): introduce new orchestrator (#2829)

    it.effect("suppresses a second empty final answer", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const transcript = finalAnswerTranscript("codex-duplicate-empty-final", [
            { id: "answer-empty-original", text: "" },
            { id: "answer-empty-duplicate", text: "" },
          ]);
          const harness = yield* makeCodexReplayHarness(transcript);
          const now = yield* DateTime.now;

          yield* harness.runtime.startTurn(
            makeCodexTestTurnInput({
              threadId: harness.threadId,
              providerThread: harness.providerThread,
              now,
              attemptId: RunAttemptId.make("attempt-codex-duplicate-empty-final"),
              text: "Reply with the requested recovery marker.",
            }),
          );
          yield* awaitUntil(() => harness.terminalEvents().length === 1, "root turn terminal");

          assert.deepEqual(
            assistantMessages(harness.events).map((event) => event.message.text),
            [""],
          );
        }).pipe(
          Effect.provide(
            Layer.mergeAll(IdAllocator.layer, NodeServices.layer, McpProviderSessions.layer),
          ),
        ),
      ),
    );
    // regression: de34391427 feat(orchestrator): introduce new orchestrator (#2829)

    it.effect("preserves an empty final answer when only commentary preceded it", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const transcript = finalAnswerTranscript("codex-commentary-then-empty-final", [
            { id: "answer-commentary", text: "Working on it.", phase: "commentary" },
            { id: "answer-empty", text: "" },
          ]);
          const harness = yield* makeCodexReplayHarness(transcript);
          const now = yield* DateTime.now;

          yield* harness.runtime.startTurn(
            makeCodexTestTurnInput({
              threadId: harness.threadId,
              providerThread: harness.providerThread,
              now,
              attemptId: RunAttemptId.make("attempt-codex-commentary-then-empty-final"),
              text: "Reply with the requested recovery marker.",
            }),
          );
          yield* awaitUntil(() => harness.terminalEvents().length === 1, "root turn terminal");

          assert.deepEqual(
            assistantMessages(harness.events).map((event) => event.message.text),
            ["Working on it.", ""],
          );
        }).pipe(
          Effect.provide(
            Layer.mergeAll(IdAllocator.layer, NodeServices.layer, McpProviderSessions.layer),
          ),
        ),
      ),
    );
    // regression: de34391427 feat(orchestrator): introduce new orchestrator (#2829)

    it.effect("suppresses an empty final answer after a non-empty unknown-phase answer", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const transcript = finalAnswerTranscript("codex-unknown-non-empty-then-empty-final", [
            { id: "answer-non-empty", text: "CODEX_RECOVERY_OK", phase: null },
            { id: "answer-empty", text: "" },
          ]);
          const harness = yield* makeCodexReplayHarness(transcript);
          const now = yield* DateTime.now;

          yield* harness.runtime.startTurn(
            makeCodexTestTurnInput({
              threadId: harness.threadId,
              providerThread: harness.providerThread,
              now,
              attemptId: RunAttemptId.make("attempt-codex-unknown-non-empty-then-empty-final"),
              text: "Reply with the requested recovery marker.",
            }),
          );
          yield* awaitUntil(() => harness.terminalEvents().length === 1, "root turn terminal");

          assert.deepEqual(
            assistantMessages(harness.events).map((event) => event.message.text),
            ["CODEX_RECOVERY_OK"],
          );
        }).pipe(
          Effect.provide(
            Layer.mergeAll(IdAllocator.layer, NodeServices.layer, McpProviderSessions.layer),
          ),
        ),
      ),
    );
    // regression: de34391427 feat(orchestrator): introduce new orchestrator (#2829)

    it.effect("suppresses a trailing empty answer with an omitted phase", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const transcript = finalAnswerTranscript("codex-final-then-empty-unknown", [
            { id: "answer-non-empty", text: "CODEX_RECOVERY_OK" },
            { id: "answer-empty", text: "", omitPhase: true },
          ]);
          const harness = yield* makeCodexReplayHarness(transcript);
          const now = yield* DateTime.now;

          yield* harness.runtime.startTurn(
            makeCodexTestTurnInput({
              threadId: harness.threadId,
              providerThread: harness.providerThread,
              now,
              attemptId: RunAttemptId.make("attempt-codex-final-then-empty-unknown"),
              text: "Reply with the requested recovery marker.",
            }),
          );
          yield* awaitUntil(() => harness.terminalEvents().length === 1, "root turn terminal");

          assert.deepEqual(
            assistantMessages(harness.events).map((event) => event.message.text),
            ["CODEX_RECOVERY_OK"],
          );
        }).pipe(
          Effect.provide(
            Layer.mergeAll(IdAllocator.layer, NodeServices.layer, McpProviderSessions.layer),
          ),
        ),
      ),
    );
    // regression: de34391427 feat(orchestrator): introduce new orchestrator (#2829)

    it.effect("keeps a later non-empty final answer after an initial empty final answer", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const transcript = finalAnswerTranscript("codex-empty-then-non-empty-final", [
            { id: "answer-empty", text: "" },
            { id: "answer-non-empty", text: "CODEX_RECOVERY_OK" },
          ]);
          const harness = yield* makeCodexReplayHarness(transcript);
          const now = yield* DateTime.now;

          yield* harness.runtime.startTurn(
            makeCodexTestTurnInput({
              threadId: harness.threadId,
              providerThread: harness.providerThread,
              now,
              attemptId: RunAttemptId.make("attempt-codex-empty-then-non-empty-final"),
              text: "Reply with the requested recovery marker.",
            }),
          );
          yield* awaitUntil(() => harness.terminalEvents().length === 1, "root turn terminal");

          assert.deepEqual(
            assistantMessages(harness.events).map((event) => event.message.text),
            ["", "CODEX_RECOVERY_OK"],
          );
        }).pipe(
          Effect.provide(
            Layer.mergeAll(IdAllocator.layer, NodeServices.layer, McpProviderSessions.layer),
          ),
        ),
      ),
    );
  });
});

describe("Codex restored McpFork", () => {
  describe("CodexAdapterV2 post-settle continuation", () => {
    const codexReplayThreadResult = (input: {
      readonly nativeThreadId: string;
      readonly forkedFromId: string | null;
    }) => ({
      thread: {
        id: input.nativeThreadId,
        sessionId: input.nativeThreadId,
        forkedFromId: input.forkedFromId,
        preview: "",
        ephemeral: false,
        modelProvider: "openai",
        createdAt: 1782622440,
        updatedAt: 1782622440,
        status: { type: "idle" },
        path: `/tmp/${input.nativeThreadId}.jsonl`,
        cwd: "/workspace",
        cliVersion: "0.144.0",
        source: "vscode",
        threadSource: null,
        agentNickname: null,
        agentRole: null,
        gitInfo: null,
        name: null,
        turns: [],
      },
      model: "gpt-5.4",
      modelProvider: "openai",
      serviceTier: null,
      cwd: "/workspace",
      instructionSources: [],
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandbox: { type: "workspaceWrite", writableRoots: [], networkAccess: false },
      reasoningEffort: "medium",
    });

    const errorCauseChainText = (error: unknown): string =>
      error instanceof Error
        ? `${error.message} ${errorCauseChainText(error.cause)}`
        : String(error);

    const codexReplaySourceTurn = (input: {
      readonly id: string;
      readonly ordinal: number;
      readonly nativeId: string | null;
      readonly providerThreadId: ProviderThreadId;
      readonly now: DateTime.Utc;
    }): OrchestrationV2ProviderTurn => ({
      id: ProviderTurnId.make(input.id),
      providerThreadId: input.providerThreadId,
      nodeId: NodeId.make(`node-${input.id}`),
      runAttemptId: RunAttemptId.make(`run-attempt-${input.id}`),
      nativeTurnRef:
        input.nativeId === null
          ? { driver: CodexAdapterV2.CODEX_DRIVER_KIND, nativeId: null, strength: "none" }
          : {
              driver: CodexAdapterV2.CODEX_DRIVER_KIND,
              nativeId: input.nativeId,
              strength: "strong",
            },
      ordinal: input.ordinal,
      status: "completed",
      startedAt: input.now,
      completedAt: input.now,
    });
    // regression: de34391427 feat(orchestrator): introduce new orchestrator (#2829)

    it.effect(
      "fails honestly when a legacy fork cannot honor a source turn without a native reference",
      () =>
        Effect.gen(function* () {
          const nativeThreadId = "legacy-fallback-source-thread";
          const forkThreadId = "legacy-fallback-fork-thread";
          const preamble = codexReplayPreamble({
            nativeThreadId,
            nativeTurnId: "legacy-fallback-source-turn",
            prompt: "unused",
          });
          const transcript = makeCodexReplayTranscript({
            scenario: "codex-fork-legacy-fallback",
            entries: [
              ...preamble.slice(0, 5),
              {
                type: "expect_outbound",
                label: "thread/fork",
                frame: {
                  id: 3,
                  method: "thread/fork",
                  params: { threadId: nativeThreadId, config: CodexAdapterV2.CODEX_THREAD_CONFIG },
                },
              },
              {
                type: "emit_inbound",
                label: "thread/fork",
                frame: {
                  id: 3,
                  result: codexReplayThreadResult({
                    nativeThreadId: forkThreadId,
                    forkedFromId: nativeThreadId,
                  }),
                },
              },
              {
                type: "expect_outbound",
                label: "thread/read",
                frame: {
                  id: 4,
                  method: "thread/read",
                  params: { threadId: forkThreadId, includeTurns: false },
                },
              },
              {
                type: "emit_inbound",
                label: "thread/read",
                frame: {
                  id: 4,
                  result: { thread: { id: forkThreadId, historyMode: "legacy" } },
                },
              },
            ],
          });
          const outbound: Array<string> = [];
          const harness = yield* makeCodexReplayHarness(
            transcript,
            () => Effect.void,
            (method) =>
              Effect.sync(() => {
                outbound.push(method);
              }),
          );
          const now = yield* DateTime.now;
          const firstTurn = codexReplaySourceTurn({
            id: "provider-turn-first",
            ordinal: 1,
            nativeId: null,
            providerThreadId: harness.providerThread.id,
            now,
          });
          const secondTurn = codexReplaySourceTurn({
            id: "provider-turn-second",
            ordinal: 2,
            nativeId: "native-turn-second",
            providerThreadId: harness.providerThread.id,
            now,
          });

          const error = yield* Effect.flip(
            harness.runtime.forkThread({
              sourceProviderThread: harness.providerThread,
              sourceProviderTurns: [firstTurn, secondTurn],
              providerTurnId: firstTurn.id,
              targetThreadId: ThreadId.make("thread-fork-legacy-fallback-target"),
            }),
          );

          assert.instanceOf(error, ProviderAdapterForkThreadError);
          assert.include(
            errorCauseChainText(error),
            "legacy",
            "the missing-native-reference fallback must name the legacy limitation",
          );
          assert.notInclude(
            outbound,
            "thread/rollback",
            "thread/rollback must not be sent to a legacy Codex fork",
          );
        }).pipe(
          Effect.scoped,
          Effect.provide(
            Layer.mergeAll(IdAllocator.layer, NodeServices.layer, McpProviderSessions.layer),
          ),
        ),
    );
    // regression: de34391427 feat(orchestrator): introduce new orchestrator (#2829)

    it.effect("propagates native thread/fork failures as typed fork errors", () =>
      Effect.gen(function* () {
        const nativeThreadId = "fork-failure-source-thread";
        const preamble = codexReplayPreamble({
          nativeThreadId,
          nativeTurnId: "fork-failure-source-turn",
          prompt: "unused",
        });
        const transcript = makeCodexReplayTranscript({
          scenario: "codex-fork-request-failure",
          entries: [
            ...preamble.slice(0, 5),
            {
              type: "expect_outbound",
              label: "thread/fork",
              frame: {
                id: 3,
                method: "thread/fork",
                params: {
                  threadId: nativeThreadId,
                  lastTurnId: "native-turn-first",
                  config: CodexAdapterV2.CODEX_THREAD_CONFIG,
                },
              },
            },
            {
              type: "emit_inbound",
              label: "thread/fork",
              frame: { id: 3, error: { code: -32000, message: "fork exploded" } },
            },
          ],
        });
        const harness = yield* makeCodexReplayHarness(transcript);
        const now = yield* DateTime.now;
        const firstTurn = codexReplaySourceTurn({
          id: "provider-turn-first",
          ordinal: 1,
          nativeId: "native-turn-first",
          providerThreadId: harness.providerThread.id,
          now,
        });

        const error = yield* Effect.flip(
          harness.runtime.forkThread({
            sourceProviderThread: harness.providerThread,
            sourceProviderTurns: [firstTurn],
            providerTurnId: firstTurn.id,
            targetThreadId: ThreadId.make("thread-fork-failure-target"),
          }),
        );

        assert.instanceOf(error, ProviderAdapterForkThreadError);
        assert.include(errorCauseChainText(error), "fork exploded");
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, NodeServices.layer, McpProviderSessions.layer),
        ),
      ),
    );
  });
});

describe("Codex restored Policy", () => {
  describe("CodexAdapterV2 runtime policy", () => {
    // regression: de34391427 feat(orchestrator): introduce new orchestrator (#2829)

    it.effect("preserves explicit Codex turn policy overrides", () =>
      Effect.gen(function* () {
        const params = yield* CodexAdapterV2.buildCodexTurnStartParams({
          nativeThreadId: "native-override",
          codexInput: [{ type: "text", text: "test" }],
          runtimePolicy: {
            runtimeMode: "full-access",
            interactionMode: "default",
            cwd: null,
            approvalPolicy: "on-request",
            sandboxPolicy: {
              type: "readOnly",
            },
          },
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5.4",
          },
        });

        assert.equal(params.approvalPolicy, "on-request");
        assert.equal(params.sandboxPolicy?.type, "readOnly");
      }),
    );
    // regression: de34391427 feat(orchestrator): introduce new orchestrator (#2829)

    it.effect("keeps Codex in plan mode without referencing unavailable T3 MCP tools", () =>
      Effect.gen(function* () {
        const params = yield* CodexAdapterV2.buildCodexTurnStartParams({
          nativeThreadId: "native-plan-without-t3-mcp",
          codexInput: [{ type: "text", text: "plan this task" }],
          runtimePolicy: {
            runtimeMode: "full-access",
            interactionMode: "plan",
            cwd: null,
          },
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5.4",
          },
          hasT3Mcp: false,
        });

        assert.equal(params.collaborationMode?.mode, "plan");
        assert.notProperty(params.collaborationMode?.settings, "developer_instructions");
      }),
    );
  });

  describe("CodexAdapterV2 process spawning", () => {
    // regression: de34391427 feat(orchestrator): introduce new orchestrator (#2829)

    it.effect("resolves Windows command shims through the shared spawn policy", () =>
      Effect.gen(function* () {
        const command = yield* CodexAdapterV2.makeCodexAppServerSpawnCommand({
          command: "codex",
          args: ["app-server", "argument with spaces"],
          cwd: "C:\\workspace",
          env: { CUSTOM: "1" },
          extendEnv: true,
        });

        assert.isTrue(ChildProcess.isStandardCommand(command));
        if (!ChildProcess.isStandardCommand(command)) {
          return;
        }
        assert.equal(
          command.command,
          '^"C:\\npm\\codex.cmd^" ^"app-server^" ^"argument^ with^ spaces^"',
        );
        assert.deepEqual(command.args, []);
        assert.equal(command.options.shell, true);
        assert.equal(command.options.cwd, "C:\\workspace");
        assert.deepEqual(command.options.env, { CUSTOM: "1" });
        assert.equal(command.options.extendEnv, true);
      }).pipe(
        Effect.provideService(HostProcess.Platform, "win32"),
        Effect.provideService(HostProcess.Environment, {
          PATH: "C:\\Windows\\System32",
          HOST_ONLY: "1",
        }),
        Effect.provideService(SpawnExecutableResolution, (_command, _platform, environment) => {
          assert.equal(environment.HOST_ONLY, "1");
          assert.equal(environment.CUSTOM, "1");
          return "C:\\npm\\codex.cmd";
        }),
      ),
    );
    // regression: de34391427 feat(orchestrator): introduce new orchestrator (#2829)

    it.effect("uses direct execution for native executables", () =>
      Effect.gen(function* () {
        const command = yield* CodexAdapterV2.makeCodexAppServerSpawnCommand({
          command: "codex.exe",
          args: ["app-server"],
        });

        assert.isTrue(ChildProcess.isStandardCommand(command));
        if (!ChildProcess.isStandardCommand(command)) {
          return;
        }
        assert.equal(command.command, "C:\\bin\\codex.exe");
        assert.deepEqual(command.args, ["app-server"]);
        assert.equal(command.options.shell, false);
      }).pipe(
        Effect.provideService(HostProcess.Platform, "win32"),
        Effect.provideService(SpawnExecutableResolution, () => "C:\\bin\\codex.exe"),
      ),
    );
  });
});

describe("Codex restored Protocol", () => {
  describe("CodexAdapterV2 native protocol logging", () => {
    // regression: de34391427 feat(orchestrator): introduce new orchestrator (#2829)

    it.effect("filters streaming frames before redaction without losing decode failures", () =>
      Effect.gen(function* () {
        const writes: Array<unknown> = [];
        const protocolLogger = CodexAdapterV2.makeCodexAppServerProtocolLogger({
          nativeEventLogger: {
            filePath: "/tmp/events.log",
            write: (event) =>
              Effect.sync(() => {
                writes.push(event);
              }),
            close: () => Effect.void,
          },
          threadId: ThreadId.make("thread-1"),
          providerSessionId: ProviderSessionId.make("provider-session-1"),
        });
        assert.exists(protocolLogger);
        if (protocolLogger === undefined) return;

        yield* protocolLogger({
          direction: "incoming",
          stage: "decoded",
          payload: {
            method: "item/agentMessage/delta",
            get params() {
              throw new Error("delta must not be copied");
            },
          },
        });
        yield* protocolLogger({
          direction: "incoming",
          stage: "raw",
          get payload() {
            throw new Error("raw frame must not be parsed");
          },
        });
        yield* protocolLogger({
          direction: "incoming",
          stage: "decode_failed",
          payload: { operation: "decode", method: "turn/completed", issueCount: 1 },
        });

        assert.equal(writes.length, 1);
        assert.nestedPropertyVal(writes[0], "event.stage", "decode_failed");
        assert.nestedPropertyVal(writes[0], "event.payload.method", "turn/completed");
      }),
    );
    // regression: de34391427 feat(orchestrator): introduce new orchestrator (#2829)

    it.effect("retains redacted failures when large payloads are summarized", () =>
      Effect.gen(function* () {
        const writes: Array<unknown> = [];
        const protocolLogger = CodexAdapterV2.makeCodexAppServerProtocolLogger({
          nativeEventLogger: {
            filePath: "/tmp/events.log",
            write: (event) =>
              Effect.sync(() => {
                writes.push(event);
              }),
            close: () => Effect.void,
          },
          threadId: ThreadId.make("thread-1"),
          providerSessionId: ProviderSessionId.make("provider-session-1"),
        });
        assert.exists(protocolLogger);
        if (protocolLogger === undefined) return;

        yield* protocolLogger({
          direction: "incoming",
          stage: "decoded",
          payload: {
            method: "error",
            params: {
              threadId: "native-thread",
              turnId: "native-turn",
              error: {
                code: "unauthorized",
                message: '{"message":"Unauthorized","Authorization":"Bearer secret-token"}',
              },
              history: "x".repeat(128 * 1_024),
            },
          },
        });

        const serialized = encodeUnknownJson(writes);
        assert.equal(writes.length, 1);
        assert.isBelow(serialized.length, 2_048);
        assert.notInclude(serialized, "secret-token");
        assert.include(serialized, "[REDACTED]");
        assert.nestedPropertyVal(writes[0], "event.payload.params.error.code", "unauthorized");
        assert.nestedPropertyVal(writes[0], "event.payload.params.turnId", "native-turn");
      }),
    );
  });

  describe("CodexAdapterV2 fork boundary", () => {
    const providerThreadId = ProviderThreadId.make("provider-thread-codex-fork-boundary");
    const makeProviderThread = (now: DateTime.Utc): OrchestrationV2ProviderThread => ({
      id: providerThreadId,
      driver: CodexAdapterV2.CODEX_DRIVER_KIND,
      providerInstanceId: ProviderInstanceId.make("codex"),
      providerSessionId: ProviderSessionId.make("provider-session-codex-fork-boundary"),
      appThreadId: ThreadId.make("thread-codex-fork-boundary"),
      ownerNodeId: null,
      nativeThreadRef: {
        driver: CodexAdapterV2.CODEX_DRIVER_KIND,
        nativeId: "native-thread-codex-fork-boundary",
        strength: "strong",
      },
      nativeConversationHeadRef: null,
      status: "idle",
      firstRunOrdinal: 1,
      lastRunOrdinal: 2,
      handoffIds: [],
      forkedFrom: null,
      createdAt: now,
      updatedAt: now,
    });
    const makeProviderTurn = (
      id: string,
      ordinal: number,
      nativeId: string | null,
      now: DateTime.Utc,
    ): OrchestrationV2ProviderTurn => ({
      id: ProviderTurnId.make(id),
      providerThreadId,
      nodeId: NodeId.make(`node-${id}`),
      runAttemptId: RunAttemptId.make(`run-attempt-${id}`),
      nativeTurnRef:
        nativeId === null
          ? { driver: CodexAdapterV2.CODEX_DRIVER_KIND, nativeId: null, strength: "none" }
          : { driver: CodexAdapterV2.CODEX_DRIVER_KIND, nativeId, strength: "strong" },
      ordinal,
      status: "completed",
      startedAt: now,
      completedAt: now,
    });
    // regression: de34391427 feat(orchestrator): introduce new orchestrator (#2829)

    it.effect("resolves the latest source turn to a native fork boundary without rollback", () =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        const firstTurn = makeProviderTurn("provider-turn-first", 1, "native-turn-first", now);
        const secondTurn = makeProviderTurn("provider-turn-second", 2, "native-turn-second", now);

        const boundary = yield* CodexAdapterV2.resolveCodexForkBoundary({
          sourceProviderThread: makeProviderThread(now),
          sourceProviderTurns: [firstTurn, secondTurn],
          providerTurnId: secondTurn.id,
          targetThreadId: ThreadId.make("thread-codex-fork-target"),
        });

        assert.deepEqual(boundary, {
          lastTurnId: "native-turn-second",
          rollbackTurnCount: 0,
        });
      }),
    );
    // regression: de34391427 feat(orchestrator): introduce new orchestrator (#2829)

    it.effect("keeps the rollback-count fallback when the boundary turn has no native ref", () =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        const firstTurn: OrchestrationV2ProviderTurn = {
          ...makeProviderTurn("provider-turn-first", 1, "native-turn-first", now),
          nativeTurnRef: null,
        };
        const secondTurn = makeProviderTurn("provider-turn-second", 2, "native-turn-second", now);

        const boundary = yield* CodexAdapterV2.resolveCodexForkBoundary({
          sourceProviderThread: makeProviderThread(now),
          sourceProviderTurns: [firstTurn, secondTurn],
          providerTurnId: firstTurn.id,
          targetThreadId: ThreadId.make("thread-codex-fork-target"),
        });

        assert.deepEqual(boundary, { lastTurnId: undefined, rollbackTurnCount: 1 });
      }),
    );
    // regression: de34391427 feat(orchestrator): introduce new orchestrator (#2829)

    it.effect("forks at head without a boundary when no provider turn is selected", () =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;

        const boundary = yield* CodexAdapterV2.resolveCodexForkBoundary({
          sourceProviderThread: makeProviderThread(now),
          targetThreadId: ThreadId.make("thread-codex-fork-target"),
        });

        assert.deepEqual(boundary, { lastTurnId: undefined, rollbackTurnCount: 0 });
      }),
    );
    // regression: de34391427 feat(orchestrator): introduce new orchestrator (#2829)

    it.effect("fails with a typed error when the selected source turn is missing", () =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        const firstTurn = makeProviderTurn("provider-turn-first", 1, "native-turn-first", now);

        const error = yield* Effect.flip(
          CodexAdapterV2.resolveCodexForkBoundary({
            sourceProviderThread: makeProviderThread(now),
            sourceProviderTurns: [firstTurn],
            providerTurnId: ProviderTurnId.make("provider-turn-missing"),
            targetThreadId: ThreadId.make("thread-codex-fork-target"),
          }),
        );

        assert.instanceOf(error, ProviderAdapterForkThreadError);
        assert.include(String(error.cause), "provider-turn-missing");
      }),
    );
  });
});

describe("Codex restored QueuedStop", () => {
  describe("CodexAdapterV2 post-settle continuation", () => {
    // regression: de34391427 feat(orchestrator): introduce new orchestrator (#2829)

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
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, NodeServices.layer, McpProviderSessions.layer),
        ),
      ),
    );
    // regression: de34391427 feat(orchestrator): introduce new orchestrator (#2829)

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
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, NodeServices.layer, McpProviderSessions.layer),
        ),
      ),
    );
  });
});

describe("Codex restored ResumeReasoning", () => {
  describe("CodexAdapterV2 post-settle continuation", () => {
    // regression: de34391427 feat(orchestrator): introduce new orchestrator (#2829)

    it.effect(
      "continues an interrupted native thread with empty input and reasoning summaries",
      () =>
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
                  frame: {
                    id: 3,
                    result: { thread: { id: nativeThreadId, updatedAt: 1782622450 } },
                  },
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
                      collaborationMode: { mode: "default", settings: { model: "gpt-5.4" } },
                      additionalContext: {
                        t3_code_runtime: {
                          kind: "application",
                          value: buildScientRuntimeInstructions({
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
                    result: {
                      turn: makeCodexReplayTurn({ id: nativeTurnId, status: "inProgress" }),
                    },
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
          }).pipe(
            Effect.provide(
              Layer.mergeAll(IdAllocator.layer, NodeServices.layer, McpProviderSessions.layer),
            ),
          ),
        ),
    );
    // regression: de34391427 feat(orchestrator): introduce new orchestrator (#2829)

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
        }).pipe(
          Effect.provide(
            Layer.mergeAll(IdAllocator.layer, NodeServices.layer, McpProviderSessions.layer),
          ),
        ),
      ),
    );
  });
});

describe("Codex restored Sessions", () => {
  describe("CodexAdapterV2 post-settle continuation", () => {
    // regression: de34391427 feat(orchestrator): introduce new orchestrator (#2829)

    it.effect("unsubscribes from the native thread when it is unloaded", () =>
      Effect.gen(function* () {
        const nativeThreadId = "unload-thread";
        const preamble = codexReplayPreamble({
          nativeThreadId,
          nativeTurnId: "unused",
          prompt: "unused",
        });
        const transcript = makeCodexReplayTranscript({
          scenario: "unload-thread",
          entries: [
            // initialize + thread/start only; no turn runs.
            ...preamble.slice(0, 5),
            {
              type: "expect_outbound",
              label: "thread/unsubscribe",
              frame: { id: 3, method: "thread/unsubscribe", params: { threadId: nativeThreadId } },
            },
            // Response shape recorded from codex app-server 0.156.1.
            {
              type: "emit_inbound",
              label: "thread/unsubscribe",
              frame: { id: 3, result: { status: "unsubscribed" } },
            },
          ],
        });
        const requests: Array<string> = [];
        const harness = yield* makeCodexReplayHarness(
          transcript,
          () => Effect.void,
          (method) => Effect.sync(() => requests.push(method)),
        );
        assert.isDefined(harness.runtime.unloadThread);
        yield* harness.runtime.unloadThread!({ providerThread: harness.providerThread });
        assert.deepEqual(requests, ["initialize", "thread/start", "thread/unsubscribe"]);
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, NodeServices.layer, McpProviderSessions.layer),
        ),
      ),
    );
    // regression: de34391427 feat(orchestrator): introduce new orchestrator (#2829)

    it.effect("keeps the app-server failure as the cause when an unload is rejected", () =>
      Effect.gen(function* () {
        const nativeThreadId = "unload-thread-rejected";
        const preamble = codexReplayPreamble({
          nativeThreadId,
          nativeTurnId: "unused",
          prompt: "unused",
        });
        const transcript = makeCodexReplayTranscript({
          scenario: "unload-thread-rejected",
          entries: [
            ...preamble.slice(0, 5),
            {
              type: "expect_outbound",
              label: "thread/unsubscribe",
              frame: { id: 3, method: "thread/unsubscribe", params: { threadId: nativeThreadId } },
            },
            {
              type: "emit_inbound",
              label: "thread/unsubscribe",
              frame: { id: 3, error: { code: -32600, message: "invalid thread id" } },
            },
          ],
        });
        const harness = yield* makeCodexReplayHarness(transcript);
        const error = yield* harness.runtime.unloadThread!({
          providerThread: harness.providerThread,
        }).pipe(Effect.flip);
        assert.equal(error._tag, "ProviderAdapterProtocolError");
        const cause = error._tag === "ProviderAdapterProtocolError" ? error.cause : undefined;
        assert.equal((cause as { _tag?: string } | undefined)?._tag, "CodexAppServerRequestError");
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, NodeServices.layer, McpProviderSessions.layer),
        ),
      ),
    );
  });
});

describe("Codex restored Subagents", () => {
  describe("CodexAdapterV2 post-settle continuation", () => {
    const RESUME_SCENARIO = "codex-resume-subagent";

    const RESUME_NATIVE_THREAD = "native-codex-resume-thread";

    const RESUME_NATIVE_TURN = "native-codex-resume-root-turn";

    const RESUME_CHILD_THREAD = "native-codex-resume-child-thread";

    const RESUME_CHILD_TURN_1 = "native-codex-resume-child-turn-1";

    const RESUME_CHILD_TURN_2 = "native-codex-resume-child-turn-2";

    const RESUME_PROMPT = "Spawn a sub-agent, nudge it, and reply NUDGED.";

    const childAgentMessage = (input: {
      readonly id: string;
      readonly text: string;
      readonly turnId: string;
      readonly completedAtMs: number;
      readonly afterMs?: number;
      readonly omitPhase?: boolean;
    }): CodexReplay.CodexAppServerReplayEntry => ({
      type: "emit_inbound",
      label: `item/completed/${input.id}`,
      ...(input.afterMs === undefined ? {} : { afterMs: input.afterMs }),
      frame: {
        method: "item/completed",
        params: {
          item: {
            type: "agentMessage",
            id: input.id,
            text: input.text,
            ...(input.omitPhase ? {} : { phase: "final_answer" as const }),
            memoryCitation: null,
          },
          threadId: RESUME_CHILD_THREAD,
          turnId: input.turnId,
          completedAtMs: input.completedAtMs,
        },
      },
    });

    const childTurnStarted = (
      turnId: string,
      afterMs?: number,
    ): CodexReplay.CodexAppServerReplayEntry => ({
      type: "emit_inbound",
      label: `turn/started/${turnId}`,
      ...(afterMs === undefined ? {} : { afterMs }),
      frame: {
        method: "turn/started",
        params: {
          threadId: RESUME_CHILD_THREAD,
          turn: {
            ...makeCodexReplayTurn({ id: turnId, status: "inProgress" }),
            startedAt: turnId === RESUME_CHILD_TURN_2 ? 1782622470 : 1782622440,
          },
        },
      },
    });

    const childTurnCompleted = (
      turnId: string,
      afterMs?: number,
    ): CodexReplay.CodexAppServerReplayEntry => ({
      type: "emit_inbound",
      label: `turn/completed/${turnId}`,
      ...(afterMs === undefined ? {} : { afterMs }),
      frame: {
        method: "turn/completed",
        params: {
          threadId: RESUME_CHILD_THREAD,
          turn: makeCodexReplayTurn({ id: turnId, status: "completed" }),
        },
      },
    });

    const resumeSubagentTranscript = makeCodexReplayTranscript({
      scenario: RESUME_SCENARIO,
      entries: [
        ...codexReplayPreamble({
          nativeThreadId: RESUME_NATIVE_THREAD,
          nativeTurnId: RESUME_NATIVE_TURN,
          prompt: RESUME_PROMPT,
        }),
        {
          type: "emit_inbound",
          label: "item/completed/subAgentActivity-started",
          frame: {
            method: "item/completed",
            params: {
              item: {
                type: "subAgentActivity",
                id: "call-codex-resume-spawn",
                kind: "started",
                agentThreadId: RESUME_CHILD_THREAD,
                agentPath: "/root/resume_agent",
              },
              threadId: RESUME_NATIVE_THREAD,
              turnId: RESUME_NATIVE_TURN,
              completedAtMs: 1782622441000,
            },
          },
        },
        childTurnStarted(RESUME_CHILD_TURN_1),
        childAgentMessage({
          id: "child-first-answer",
          text: "CODEX_FIRST_DONE",
          turnId: RESUME_CHILD_TURN_1,
          completedAtMs: 1782622442000,
        }),
        childAgentMessage({
          id: "child-first-answer-empty",
          text: "",
          turnId: RESUME_CHILD_TURN_1,
          completedAtMs: 1782622442001,
          omitPhase: true,
        }),
        childAgentMessage({
          id: "child-first-answer-duplicate",
          text: "CODEX_FIRST_DONE",
          turnId: RESUME_CHILD_TURN_1,
          completedAtMs: 1782622442002,
        }),
        childTurnCompleted(RESUME_CHILD_TURN_1, 100),
        {
          type: "emit_inbound",
          label: "item/completed/root-answer",
          frame: {
            method: "item/completed",
            params: {
              item: {
                type: "agentMessage",
                id: "root-answer-resume",
                text: "NUDGED",
                phase: "final_answer",
                memoryCitation: null,
              },
              threadId: RESUME_NATIVE_THREAD,
              turnId: RESUME_NATIVE_TURN,
              completedAtMs: 1782622443000,
            },
          },
        },
        {
          type: "emit_inbound",
          label: "turn/completed/root",
          frame: {
            method: "turn/completed",
            params: {
              threadId: RESUME_NATIVE_THREAD,
              turn: makeCodexReplayTurn({ id: RESUME_NATIVE_TURN, status: "completed" }),
            },
          },
        },
        childTurnStarted(RESUME_CHILD_TURN_2, 30_000),
        childAgentMessage({
          id: "child-resume-answer",
          text: "CODEX_RESUME_DONE",
          turnId: RESUME_CHILD_TURN_2,
          completedAtMs: 1782622480000,
          afterMs: 30_000,
        }),
        childTurnCompleted(RESUME_CHILD_TURN_2),
      ],
    });
    // regression: de34391427 feat(orchestrator): introduce new orchestrator (#2829)

    it.effect.each([
      { name: "Sol", model: "gpt-5.6-sol" },
      { name: "Fable", model: "gpt-5.6-fable" },
      { name: "Astra", model: "gpt-6-astra" },
      { name: "missing", model: null },
      { name: "invalid", model: null },
      { name: "wrong child", model: null },
    ])("reads $name child metadata without using the parent model", ({ name, model }) =>
      Effect.scoped(
        Effect.gen(function* () {
          const metadataRead = yield* Deferred.make<void>();
          const modelReported = yield* Deferred.make<void>();
          const harness = yield* makeCodexReplayHarness(
            resumeSubagentTranscript,
            (event) =>
              event.type === "subagent.updated" && event.subagent.model === model
                ? Deferred.succeed(modelReported, undefined)
                : Effect.void,
            undefined,
            (threadId) => {
              assert.equal(threadId, RESUME_CHILD_THREAD);
              return Deferred.succeed(metadataRead, undefined).pipe(
                Effect.as(
                  name === "invalid"
                    ? {}
                    : {
                        thread: { id: name === "wrong child" ? "other-child" : threadId },
                        model: name === "wrong child" ? "gpt-5.6-sol" : model,
                      },
                ),
              );
            },
          );
          yield* harness.runtime.startTurn(
            makeCodexTestTurnInput({
              threadId: harness.threadId,
              providerThread: harness.providerThread,
              now: yield* DateTime.now,
              attemptId: RunAttemptId.make("attempt-child-model"),
              text: RESUME_PROMPT,
            }),
          );
          yield* Deferred.await(metadataRead);
          yield* Deferred.await(modelReported);
          yield* TestClock.adjust("100 millis");
          yield* harness.firstTerminal;
          assert.equal(harness.subagentUpdates().at(-1)?.subagent.model, model);
        }).pipe(
          Effect.provide(
            Layer.mergeAll(IdAllocator.layer, NodeServices.layer, McpProviderSessions.layer),
          ),
        ),
      ),
    );
    // regression: de34391427 feat(orchestrator): introduce new orchestrator (#2829)

    it.effect("rejects duplicate child starts across parent runs", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const firstDone = yield* Deferred.make<void>();
          const resumed = yield* Deferred.make<void>();
          const secondTurn = "native-parent-resume-turn";
          const secondPrompt = "Resume the child.";
          const entries = [...resumeSubagentTranscript.entries];
          const resumeIndex = entries.findIndex(
            (e) => e.type === "emit_inbound" && e.label === `turn/started/${RESUME_CHILD_TURN_2}`,
          );
          const suffix = entries.splice(resumeIndex);
          for (const entry of codexReplayPreamble({
            nativeThreadId: RESUME_NATIVE_THREAD,
            nativeTurnId: secondTurn,
            prompt: secondPrompt,
          }).slice(-3)) {
            entries.push(
              entry.type === "expect_outbound" || entry.type === "emit_inbound"
                ? {
                    ...entry,
                    frame:
                      Predicate.isObject(entry.frame) && "id" in entry.frame
                        ? { ...entry.frame, id: 4 }
                        : entry.frame,
                  }
                : entry,
            );
          }
          entries.push(childTurnStarted(RESUME_CHILD_TURN_1));
          entries.push(...suffix);
          const harness = yield* makeCodexReplayHarness(
            makeCodexReplayTranscript({
              scenario: "codex-cross-run-resume",
              entries,
            }),
            (event) =>
              event.type === "turn.terminal"
                ? Deferred.succeed(firstDone, undefined)
                : event.type === "subagent.updated" &&
                    event.subagent.runId === "run-cross-run-second"
                  ? Deferred.succeed(resumed, undefined)
                  : Effect.void,
          );
          const now = yield* DateTime.now;
          yield* harness.runtime.startTurn(
            makeCodexTestTurnInput({
              threadId: harness.threadId,
              providerThread: harness.providerThread,
              now,
              attemptId: RunAttemptId.make("cross-run-first"),
              text: RESUME_PROMPT,
            }),
          );
          yield* TestClock.adjust("100 millis");
          yield* Deferred.await(firstDone);
          yield* harness.runtime.startTurn({
            ...makeCodexTestTurnInput({
              threadId: harness.threadId,
              providerThread: harness.providerThread,
              now,
              attemptId: RunAttemptId.make("cross-run-second"),
              text: secondPrompt,
            }),
            runOrdinal: 2,
            providerTurnOrdinal: 2,
          });
          yield* TestClock.adjust("30 seconds");
          yield* Deferred.await(resumed);
          const row = harness
            .subagentUpdates()
            .find((e) => e.subagent.runId === "run-cross-run-second")?.subagent;
          assert.equal(row?.status, "running");
          assert.equal(row?.parentNodeId, "node-cross-run-second");
          assert.isNull(row?.completedAt);
          assert.isNotNull(row?.startedAt);
          assert.equal(DateTime.toEpochMillis(row!.startedAt!), 1782622470000);
        }).pipe(
          Effect.provide(
            Layer.mergeAll(IdAllocator.layer, NodeServices.layer, McpProviderSessions.layer),
          ),
        ),
      ),
    );
    // regression: child lifecycle and metadata must survive native protocol updates.
    it.effect.each(["thread/settings/updated"])(
      "keeps %s child metadata when an older lookup finishes later",
      (method) =>
        Effect.scoped(
          Effect.gen(function* () {
            const releaseMetadata = yield* Deferred.make<void>();
            const observed = yield* Deferred.make<void>();
            const model = "gpt-5.6-sol";
            const notification: CodexReplay.CodexAppServerReplayEntry = {
              type: "emit_inbound",
              frame: {
                method,
                params:
                  method === "model/rerouted"
                    ? {
                        threadId: RESUME_CHILD_THREAD,
                        turnId: RESUME_CHILD_TURN_1,
                        fromModel: "gpt-6-astra",
                        toModel: model,
                        reason: "highRiskCyberActivity",
                      }
                    : {
                        threadId: RESUME_CHILD_THREAD,
                        threadSettings: {
                          model,
                          modelProvider: "openai",
                          cwd: "/workspace",
                          approvalPolicy: "never",
                          approvalsReviewer: "auto_review",
                          collaborationMode: { mode: "default", settings: { model } },
                          sandboxPolicy: { type: "dangerFullAccess" },
                        },
                      },
              },
            };
            const harness = yield* makeCodexReplayHarness(
              {
                ...resumeSubagentTranscript,
                entries: resumeSubagentTranscript.entries.flatMap((entry) =>
                  entry.type === "emit_inbound" && entry.label === "turn/completed/root"
                    ? [entry, notification]
                    : [entry],
                ),
              },
              (event) =>
                event.type === "subagent.updated" && event.subagent.model === model
                  ? Deferred.succeed(observed, undefined)
                  : Effect.void,
              undefined,
              (threadId) =>
                Deferred.await(releaseMetadata).pipe(
                  Effect.as({ thread: { id: threadId }, model: "gpt-6-astra" }),
                ),
            );
            yield* harness.runtime.startTurn(
              makeCodexTestTurnInput({
                threadId: harness.threadId,
                providerThread: harness.providerThread,
                now: yield* DateTime.now,
                attemptId: RunAttemptId.make("attempt-child-model-update"),
                text: RESUME_PROMPT,
              }),
            );
            yield* TestClock.adjust("100 millis");
            yield* Deferred.await(observed);
            assert.equal(harness.subagentUpdates().at(-1)?.subagent.status, "completed");
            yield* Deferred.succeed(releaseMetadata, undefined);
            yield* TestClock.adjust("30 seconds");
            assert.equal(harness.subagentUpdates().at(-1)?.subagent.model, model);
          }).pipe(
            Effect.provide(
              Layer.mergeAll(IdAllocator.layer, NodeServices.layer, McpProviderSessions.layer),
            ),
          ),
        ),
    );

    // regression: child lifecycle and metadata must survive native protocol updates.
    it.effect.each(
      (
        [
          ["pendingInit", "pending"],
          ["running", "running"],
          ["interrupted", "interrupted"],
          ["notFound", "failed"],
          ["errored", "failed"],
        ] satisfies ReadonlyArray<readonly [string, string]>
      ).map(([nativeStatus, expectedStatus]) => ({
        caseTitle: `normalizes subagent ${nativeStatus} without losing its lifecycle`,
        nativeStatus,
        expectedStatus,
      })),
    )("$caseTitle", ({ nativeStatus, expectedStatus }) =>
      Effect.scoped(
        Effect.gen(function* () {
          const marker = yield* Deferred.make<void>();
          const firstCompletion = yield* Deferred.make<void>();
          const stateEntry = (
            status: string,
            id: string,
          ): Extract<CodexReplay.CodexAppServerReplayEntry, { type: "emit_inbound" }> => ({
            type: "emit_inbound",
            label: id,
            frame: {
              method: "item/completed",
              params: {
                threadId: RESUME_NATIVE_THREAD,
                turnId: RESUME_NATIVE_TURN,
                item: {
                  type: "collabAgentToolCall",
                  id,
                  tool: "listAgents",
                  status: "completed",
                  senderThreadId: RESUME_NATIVE_THREAD,
                  receiverThreadIds: [RESUME_CHILD_THREAD],
                  agentsStates: { [RESUME_CHILD_THREAD]: { status, message: null } },
                },
              },
            },
          });
          const entries: Array<CodexReplay.CodexAppServerReplayEntry> = [
            ...codexReplayPreamble({
              nativeThreadId: RESUME_NATIVE_THREAD,
              nativeTurnId: RESUME_NATIVE_TURN,
              prompt: RESUME_PROMPT,
            }),
            resumeSubagentTranscript.entries.find(
              (e) =>
                e.type === "emit_inbound" && e.label === "item/completed/subAgentActivity-started",
            )!,
          ];
          if (nativeStatus === "late-activity-completed") {
            entries.push(
              resumeSubagentTranscript.entries.find(
                (e) => e.type === "emit_inbound" && e.label === "turn/completed/root",
              )!,
            );
          }
          if (nativeStatus === "activity-completed" || nativeStatus === "late-activity-completed") {
            entries.push({
              type: "emit_inbound",
              label: "activity-done",
              frame: {
                method: "item/completed",
                params: {
                  threadId: RESUME_NATIVE_THREAD,
                  turnId: RESUME_NATIVE_TURN,
                  item: {
                    type: "subAgentActivity",
                    id: "activity-done",
                    kind: "completed",
                    agentThreadId: RESUME_CHILD_THREAD,
                    agentPath: "/root/resume_agent",
                  },
                },
              },
            });
          } else if (nativeStatus === "stale-running" || nativeStatus === "duplicate-completed") {
            entries.push(stateEntry("completed", "child-completed"), {
              ...stateEntry(
                nativeStatus === "stale-running" ? "running" : "completed",
                "trailing-snapshot",
              ),
              afterMs: 100,
            });
          } else {
            entries.push(stateEntry(nativeStatus, "status-update"));
          }
          // A known child's turn provides a receipt even after the parent context is released.
          if (nativeStatus === "late-activity-completed") {
            entries.push({
              type: "emit_inbound",
              label: "late-marker",
              frame: {
                method: "turn/started",
                params: {
                  threadId: RESUME_CHILD_THREAD,
                  turn: makeCodexReplayTurn({ id: RESUME_CHILD_TURN_1, status: "inProgress" }),
                },
              },
            });
          } else {
            entries.push({
              type: "emit_inbound",
              label: "marker",
              frame: {
                method: "item/completed",
                params: {
                  threadId: RESUME_NATIVE_THREAD,
                  turnId: RESUME_NATIVE_TURN,
                  item: {
                    type: "agentMessage",
                    id: "marker",
                    text: "LIFECYCLE_MARKER",
                    phase: "final_answer",
                    memoryCitation: null,
                  },
                },
              },
            });
          }
          const harness = yield* makeCodexReplayHarness(
            makeCodexReplayTranscript({ scenario: `subagent-${nativeStatus}`, entries }),
            (event) =>
              (event.type === "message.updated" && event.message.text === "LIFECYCLE_MARKER") ||
              (nativeStatus === "late-activity-completed" &&
                event.type === "provider_turn.updated" &&
                event.providerTurn.nativeTurnRef?.nativeId === RESUME_CHILD_TURN_1)
                ? Deferred.succeed(marker, undefined)
                : event.type === "subagent.updated" && event.subagent.status === "completed"
                  ? Deferred.succeed(firstCompletion, undefined)
                  : Effect.void,
          );
          yield* harness.runtime.startTurn(
            makeCodexTestTurnInput({
              threadId: harness.threadId,
              providerThread: harness.providerThread,
              now: yield* DateTime.now,
              attemptId: RunAttemptId.make(`subagent-${nativeStatus}`),
              text: RESUME_PROMPT,
            }),
          );
          if (nativeStatus === "stale-running" || nativeStatus === "duplicate-completed") {
            yield* Deferred.await(firstCompletion);
            yield* TestClock.adjust("100 millis");
          }
          yield* Deferred.await(marker);
          const latest = harness.subagentUpdates().at(-1)!.subagent;
          assert.equal(latest.status, expectedStatus);
          if (nativeStatus === "duplicate-completed") {
            const first = harness.subagentUpdates().find((e) => e.subagent.status === "completed")!;
            assert.equal(
              DateTime.toEpochMillis(latest.completedAt!),
              DateTime.toEpochMillis(first.subagent.completedAt!),
            );
          }
        }).pipe(
          Effect.provide(
            Layer.mergeAll(IdAllocator.layer, NodeServices.layer, McpProviderSessions.layer),
          ),
        ),
      ),
    );
  });
});

// regression: rateLimitExceeded retains usage-limit and reusable-thread semantics.
it.effect.each(
  [
    {
      name: "rate",
      code: "rateLimitExceeded",
      notification: false,
      expectedClass: "usage_limit",
    },
  ].map((scenario) => ({
    caseTitle: `classifies Codex terminal failures from ${scenario.name} evidence`,
    scenario,
  })),
)("$caseTitle", ({ scenario }) =>
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
    }).pipe(
      Effect.provide(
        Layer.mergeAll(IdAllocator.layer, NodeServices.layer, McpProviderSessions.layer),
      ),
    ),
  ),
);
