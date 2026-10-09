import * as NodeServices from "@effect/platform-node/NodeServices";
import { RunAttemptId } from "@t3tools/contracts";
import { it, assert } from "@effect/vitest";
import * as CodexReplay from "effect-codex-app-server/replay";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { TestClock } from "effect/testing";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import {
  makeCodexReplayTranscript,
  codexReplayPreamble,
  makeCodexReplayTurn,
  makeCodexReplayHarness,
  makeCodexTestTurnInput,
  awaitUntil,
  assistantMessages,
} from "./CodexAdapterV2.replay.testkit.ts";
import { describe } from "@effect/vitest";

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

  it.effect("suppresses a trailing empty final answer after a non-empty final answer", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const transcript = finalAnswerTranscript("codex-redundant-empty-final", [
          { id: "answer-non-empty", text: "CODEX_RECOVERY_OK" },
          { id: "answer-empty", text: "" },
        ]);
        const harness = yield* makeCodexReplayHarness(transcript);
        const now = yield* DateTime.now;

        yield* harness.runtime.startTurn(
          makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-codex-redundant-empty-final"),
            text: "Reply with the requested recovery marker.",
          }),
        );
        yield* awaitUntil(() => harness.terminalEvents().length === 1, "root turn terminal");

        assert.deepEqual(
          assistantMessages(harness.events).map((event) => event.message.text),
          ["CODEX_RECOVERY_OK"],
        );
      }).pipe(Effect.provide(Layer.merge(IdAllocator.layer, NodeServices.layer))),
    ),
  );

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
        yield* awaitUntil(() => assistantMessages(harness.events).length === 1, "original answer");
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
      }).pipe(Effect.provide(Layer.merge(IdAllocator.layer, NodeServices.layer))),
    ),
  );

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
      }).pipe(Effect.provide(Layer.merge(IdAllocator.layer, NodeServices.layer))),
    ),
  );

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
      }).pipe(Effect.provide(Layer.merge(IdAllocator.layer, NodeServices.layer))),
    ),
  );

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
      }).pipe(Effect.provide(Layer.merge(IdAllocator.layer, NodeServices.layer))),
    ),
  );

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
      }).pipe(Effect.provide(Layer.merge(IdAllocator.layer, NodeServices.layer))),
    ),
  );

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
      }).pipe(Effect.provide(Layer.merge(IdAllocator.layer, NodeServices.layer))),
    ),
  );

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
      }).pipe(Effect.provide(Layer.merge(IdAllocator.layer, NodeServices.layer))),
    ),
  );

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
      }).pipe(Effect.provide(Layer.merge(IdAllocator.layer, NodeServices.layer))),
    ),
  );
});
