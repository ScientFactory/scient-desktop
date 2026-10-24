// Scient's CodexAdapterV2 cases: native guidance and compaction, Scient MCP namespace and fork
// refusal, captured Stop, capacity, citations and media. Upstream's own cases live in
// CodexAdapterV2.test.ts.
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  EnvironmentId,
  NodeId,
  ProviderCitationPresentation,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  ThreadId,
  type ModelSelection,
  type OrchestrationV2ProviderTurn,
} from "@t3tools/contracts";
import { historyResponseItems } from "@t3tools/provider-core/server/handoffBudget";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import {
  ProviderAdapterForkThreadError,
  ProviderAdapterTurnStartError,
  type ProviderAdapterV2Event,
} from "@t3tools/provider-core/server/ProviderAdapter";
import * as CodexReplay from "effect-codex-app-server/replay";
import * as CodexSchema from "effect-codex-app-server/schema";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import { HttpServer } from "effect/http";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as NetAddress from "effect/net/NetAddress";
import * as Path from "effect/Path";
import * as Predicate from "effect/Predicate";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";
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
import { layerGitVcsDriverWithoutBranches } from "../testkit/ProviderRuntimeTestServices.ts";
import * as ThreadCommandExecutor from "../ThreadCommandExecutor.ts";
import {
  assistantMessages,
  awaitUntil,
  CODEX_TEST_MODEL_SELECTION,
  CODEX_TEST_RUNTIME_POLICY,
  codexReplayPreamble,
  DEFAULT_CODEX_SETTINGS,
  encodeUnknownJson,
  makeCodexReplayHarness,
  makeCodexReplayTranscript,
  makeCodexReplayTurn,
  makeCodexTestTurnInput,
} from "./CodexAdapterV2.replay.testkit.ts";
import * as CodexAdapterV2 from "./CodexAdapterV2.ts";

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
          assert.match(
            packet.collaborationMode.settings.developer_instructions ?? "",
            /^<collaboration_mode>[\s\S]*<\/collaboration_mode>$/,
          );
          assert.deepEqual(Object.keys(packet.additionalContext), [
            "t3_code_orchestration_01",
            "t3_code_orchestration_02",
            "t3_code_runtime",
            "scient_awareness",
          ]);
          const orchestration = Object.entries(packet.additionalContext)
            .filter(([key]) => key.startsWith("t3_code_orchestration_"))
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([, entry]) => entry.value)
            .join("\n\n");
          assert.equal(orchestration, SCIENT_ORCHESTRATION_INSTRUCTIONS.trim());
          assert.include(orchestration, "delegate_task");
          assert.include(orchestration, "structured object, never as JSON text");
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
          }).pipe(Effect.provide(ProjectionStore.layerMemory));
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
        }).pipe(Effect.provide(ProjectionStore.layerMemory));
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
          scenario.grants ? ["preview", "documents:build", "compute:inventory", "skills:read"] : [],
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
          assert.include(orchestration, "structured object, never as JSON text");
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
