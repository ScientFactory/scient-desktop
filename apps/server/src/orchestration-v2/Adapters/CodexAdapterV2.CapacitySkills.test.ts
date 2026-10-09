import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  RunAttemptId,
  MessageId,
  ProviderInstanceId,
  ThreadId,
  ProviderSessionId,
} from "@t3tools/contracts";
import { it, assert } from "@effect/vitest";
import * as CodexReplay from "effect-codex-app-server/replay";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as CodexAdapterV2 from "./CodexAdapterV2.ts";
import {
  makeCodexReplayTranscript,
  codexReplayPreamble,
  makeCodexReplayHarness,
  makeCodexTestTurnInput,
  makeCodexReplayTurn,
  DEFAULT_CODEX_SETTINGS,
  CODEX_TEST_MODEL_SELECTION,
  CODEX_TEST_RUNTIME_POLICY,
} from "./CodexAdapterV2.replay.testkit.ts";
import { describe } from "@effect/vitest";

describe("CodexAdapterV2 post-settle continuation", () => {
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
    }).pipe(Effect.scoped, Effect.provide(Layer.merge(IdAllocator.layer, NodeServices.layer))),
  );

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
      }).pipe(Effect.scoped, Effect.provide(Layer.merge(IdAllocator.layer, NodeServices.layer))),
  );
});
