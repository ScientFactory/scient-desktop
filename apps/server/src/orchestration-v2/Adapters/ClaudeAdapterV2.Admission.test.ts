import * as NodeServices from "@effect/platform-node/NodeServices";
import { MessageId, RunAttemptId } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as ClaudeAdapterV2 from "./ClaudeAdapterV2.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import {
  makeWakeHarness,
  makeResultFrame,
  makeAssistantTextFrame,
  claudeSdkFrame,
  WAKE_NATIVE_SESSION,
  awaitUntil,
  wakeAssistant,
  WAKE_ASSISTANT_TEXT,
} from "./ClaudeAdapterV2.wake.testkit.ts";
import { makeClaudeTestTurnInput } from "./ClaudeAdapterV2.fixture.ts";
describe("ClaudeAdapterV2 background wake turns", () => {
  it.effect(
    "retains uncertain admission when an offered native prompt fails before acknowledgment",
    () =>
      Effect.gen(function* () {
        const h = yield* makeWakeHarness;
        yield* h.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: h.threadId,
            providerThread: h.providerThread,
            now: yield* DateTime.now,
            attemptId: RunAttemptId.make("uncertain-native-offer"),
            text: "Do not repeat an uncertain offer",
            attachments: [],
          }),
        );
        yield* Queue.offer(
          h.sdkMessages,
          makeResultFrame({
            uuid: "00000000-0000-4000-8000-000000000799",
            result: "",
            subtype: "error_during_execution",
            isError: true,
            errors: ["Native response lost before acknowledgement"],
            terminalReason: "api_error",
          }),
        );
        assert.equal((yield* Queue.take(h.terminalReceipts)).status, "failed");
        const turns = h.events
          .filter((event) => event.type === "provider_turn.updated")
          .map((event) => event.providerTurn);
        assert.equal(turns[0]?.nativeAcceptance, "pending");
        assert.equal(turns.at(-1)?.nativeAcceptance, "unknown");
        assert.isTrue(turns.every((turn) => turn.acceptedAt === undefined));
        assert.lengthOf(h.offeredMessages, 1);
      }).pipe(Effect.provide(Layer.merge(IdAllocator.layer, NodeServices.layer))),
  );

  it.effect.each([
    "foreign-session",
    "child-replay",
    "synthetic-model",
    "synthetic-id",
    "api-error",
    "owned-root",
  ] as const)("keeps Claude's inclusive fork cursor owned by the root query: %s", (kind) =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* makeWakeHarness;
        const now = yield* DateTime.now;
        yield* h.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: h.threadId,
            providerThread: h.providerThread,
            now,
            attemptId: RunAttemptId.make(`attempt-cursor-${kind}`),
            text: "Answer with native root ownership.",
            attachments: [],
            providerTurnOrdinal: 1,
          }),
        );
        const rootUuid = "00000000-0000-4000-8000-000000009001";
        const nextUuid = "00000000-0000-4000-8000-000000009002";
        yield* h.offerAndWait(makeAssistantTextFrame({ uuid: rootUuid, text: "Root answer." }));
        if (kind === "foreign-session") {
          for (const event of [
            { type: "message_start", message: { id: "foreign-thinking" } },
            {
              type: "content_block_start",
              index: 0,
              content_block: { type: "thinking", thinking: "Foreign thought." },
            },
            { type: "content_block_stop", index: 0 },
          ]) {
            yield* h.offerAndWait(
              claudeSdkFrame({
                type: "stream_event",
                event,
                parent_tool_use_id: null,
                session_id: "foreign-native-session",
                uuid: nextUuid,
              }),
            );
          }
        }
        const candidate = makeAssistantTextFrame({
          uuid: kind === "synthetic-id" ? "turn:synthetic-message" : nextUuid,
          text: "Candidate answer.",
        });
        if (candidate.type !== "assistant") assert.fail("Expected native assistant fixture.");
        yield* h.offerAndWait(
          claudeSdkFrame({
            ...candidate,
            session_id: kind === "foreign-session" ? "foreign-native-session" : WAKE_NATIVE_SESSION,
            parent_tool_use_id: kind === "child-replay" ? "cursor-child-tool" : null,
            message: {
              ...candidate.message,
              model: kind === "synthetic-model" ? "<synthetic>" : candidate.message.model,
            },
            ...(kind === "api-error" ? { error: "server_error" } : {}),
          }),
        );
        if (kind === "child-replay") {
          // Registration releases the held child frame through the real replay
          // route after the root answer. It must never move the root cursor.
          yield* h.offerAndWait(
            claudeSdkFrame({
              type: "system",
              subtype: "task_started",
              task_id: "cursor-child-task",
              tool_use_id: "cursor-child-tool",
              description: "Child answer",
              subagent_type: "general-purpose",
              is_backgrounded: true,
              task_type: "local_agent",
              prompt: "Inspect independently.",
              uuid: "00000000-0000-4000-8000-000000009003",
              session_id: WAKE_NATIVE_SESSION,
            }),
          );
        }
        yield* h.offerAndWait(
          makeResultFrame({
            uuid: "00000000-0000-4000-8000-000000009004",
            result: "Done.",
          }),
        );
        yield* Queue.take(h.terminalReceipts);
        const terminalTurn = h.events.findLast(
          (event) =>
            event.type === "provider_turn.updated" && event.providerTurn.status === "completed",
        );
        if (terminalTurn?.type !== "provider_turn.updated")
          assert.fail("Missing persisted native turn artifact.");
        assert.equal(
          terminalTurn.providerTurn.nativeTurnRef?.nativeId,
          kind === "owned-root" ? nextUuid : rootUuid,
        );
        assert.equal(terminalTurn.providerTurn.nativeTurnRef?.strength, "weak");
        const rootItems = h.events.flatMap((event) =>
          event.type === "turn_item.updated" && event.turnItem.threadId === h.threadId
            ? [event.turnItem]
            : [],
        );
        assert.ok(rootItems.some((item) => item.nativeItemRef?.nativeId === rootUuid));
        if (kind === "foreign-session") {
          assert.equal(
            rootItems.some((item) => item.type === "reasoning"),
            false,
          );
        }
        if (kind === "foreign-session" || kind === "child-replay") {
          assert.equal(
            rootItems.some((item) => item.nativeItemRef?.nativeId === nextUuid),
            false,
          );
          assert.equal(
            h.events.some(
              (event) =>
                event.type === "message.updated" &&
                event.message.threadId === h.threadId &&
                event.message.text === "Candidate answer.",
            ),
            false,
          );
        }
        if (kind === "child-replay") {
          yield* awaitUntil(
            () =>
              h.events.some(
                (event) =>
                  event.type === "message.updated" &&
                  event.message.threadId !== h.threadId &&
                  event.message.text === "Candidate answer.",
              ),
            "owned child replay projection",
          );
        }
      }).pipe(Effect.provide(Layer.merge(IdAllocator.layer, NodeServices.layer))),
    ),
  );

  it.effect.each(["completed", "interrupted"] as const)(
    "projects Claude thinking blocks when %s",
    (status) =>
      Effect.gen(function* () {
        const harness = yield* makeWakeHarness;
        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now: yield* DateTime.now,
            attemptId: RunAttemptId.make("reasoning-attempt"),
            text: "Check the plan",
            attachments: [],
          }),
        );
        const stream = (event: unknown, parent: string | null = null) =>
          claudeSdkFrame({
            type: "stream_event",
            event,
            parent_tool_use_id: parent,
            session_id: WAKE_NATIVE_SESSION,
            uuid: "stream-frame",
          });
        const snapshot = (id: string, uuid: string, thinking: string) =>
          claudeSdkFrame({
            type: "assistant",
            uuid,
            session_id: WAKE_NATIVE_SESSION,
            parent_tool_use_id: null,
            message: {
              id,
              model: "claude-sonnet-4-6",
              content: [{ type: "thinking", thinking, signature: "secret-signature" }],
            },
          });
        const frames = [
          stream({ type: "message_start", message: { id: "thought-message" } }),
          stream({
            type: "content_block_start",
            index: 2,
            content_block: { type: "thinking", thinking: "" },
          }),
          stream({
            type: "content_block_delta",
            index: 2,
            delta: { type: "thinking_delta", thinking: "First " },
          }),
          stream({
            type: "content_block_delta",
            index: 2,
            delta: { type: "thinking_delta", thinking: "thought" },
          }),
          stream({
            type: "content_block_delta",
            index: 2,
            delta: { type: "signature_delta", signature: "secret-signature" },
          }),
          stream({ type: "content_block_stop", index: 2 }),
          snapshot("thought-message", "first-snapshot", "Authoritative first thought"),
          snapshot("thought-message", "first-snapshot", "Authoritative first thought"),
          stream({
            type: "content_block_start",
            index: 4,
            content_block: { type: "thinking", thinking: "Second thought" },
          }),
          stream({ type: "content_block_stop", index: 4 }),
          snapshot("thought-message", "second-snapshot", ""),
          snapshot("completion-only", "third-snapshot", "Completion only"),
          snapshot("redacted", "empty-snapshot", ""),
          stream({ type: "message_start", message: { id: "child-message" } }, "child-tool"),
          stream(
            {
              type: "content_block_start",
              index: 0,
              content_block: { type: "thinking", thinking: "Child thought" },
            },
            "child-tool",
          ),
          stream({ type: "message_start", message: { id: "partial-message" } }),
          stream({
            type: "content_block_start",
            index: 0,
            content_block: { type: "thinking", thinking: "Partial thought" },
          }),
          makeResultFrame({
            uuid: "reasoning-result",
            result: "",
            ...(status === "interrupted" ? { terminalReason: "aborted_streaming" as const } : {}),
          }),
        ];
        for (const frame of frames) yield* Queue.offer(harness.sdkMessages, frame);
        const terminal = yield* Queue.take(harness.terminalReceipts);
        assert.equal(terminal.status, status);
        const latest = new Map(
          harness.events.flatMap((event) =>
            event.type === "turn_item.updated" && event.turnItem.type === "reasoning"
              ? [[event.turnItem.id, event.turnItem] as const]
              : [],
          ),
        );
        assert.deepEqual(
          [...latest.values()].map((item) => item.text),
          ["Authoritative first thought", "Second thought", "Completion only", "Partial thought"],
        );
        assert.equal(new Set([...latest.values()].map((item) => item.ordinal)).size, 4);
        for (const item of latest.values()) {
          assert.equal(item.streaming, false);
          assert.isNotNull(item.completedAt);
        }
        assert.isFalse(
          harness.events.some(
            (event) => event.type === "message.updated" && event.message.role === "assistant",
          ),
        );
        for (const item of latest.values()) assert.notInclude(item.text, "secret-signature");
      }).pipe(Effect.scoped, Effect.provide(Layer.merge(IdAllocator.layer, NodeServices.layer))),
  );

  for (const terminalReason of ["aborted_tools", "aborted_streaming"] as const) {
    it.effect.each(
      [true, false].map((steered) => ({
        caseTitle: `handles ${terminalReason} with active steering=${steered}`,
        steered,
      })),
    )("$caseTitle", ({ steered }) =>
      Effect.scoped(
        Effect.gen(function* () {
          const harness = yield* makeWakeHarness;
          const idAllocator = yield* IdAllocator.IdAllocatorV2;
          const attemptId = RunAttemptId.make("attempt-steering-abort");
          const input = makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now: yield* DateTime.now,
            attemptId,
            text: "Audit the settings pages.",
            attachments: [],
          });
          yield* harness.runtime.startTurn(input);
          if (steered) {
            yield* harness.runtime.steerTurn({
              threadId: harness.threadId,
              runId: input.runId,
              providerThread: harness.providerThread,
              providerTurnId: idAllocator.derive.providerTurn({
                driver: ClaudeAdapterV2.CLAUDE_PROVIDER,
                nativeTurnId: `turn:${attemptId}`,
              }),
              message: {
                createdBy: "user",
                creationSource: "web",
                messageId: MessageId.make("message-steering-abort"),
                text: "Include the hierarchy mock.",
                attachments: [],
              },
            });
            assert.equal(harness.offeredMessages[1]?.priority, "now");
          }
          yield* Queue.offer(
            harness.sdkMessages,
            makeResultFrame({
              uuid: "00000000-0000-4000-8000-000000000901",
              result: "",
              terminalReason,
            }),
          );
          if (steered) {
            yield* Queue.offer(harness.sdkMessages, wakeAssistant);
            yield* Queue.offer(
              harness.sdkMessages,
              makeResultFrame({
                uuid: "00000000-0000-4000-8000-000000000902",
                result: "Audit finished after the steer.",
              }),
            );
          }
          const terminal = yield* Queue.take(harness.terminalReceipts);
          assert.equal(terminal.status, steered ? "completed" : "interrupted");
          if (steered) {
            assert.isTrue(
              harness.events.some(
                (event) =>
                  event.type === "turn_item.updated" &&
                  event.turnItem.type === "assistant_message" &&
                  event.turnItem.text === WAKE_ASSISTANT_TEXT,
              ),
            );
          }
          assert.lengthOf(harness.terminalEvents(), 1);
        }).pipe(Effect.provide(Layer.merge(IdAllocator.layer, NodeServices.layer))),
      ),
    );
  }

  it.effect("surfaces a Claude safety model fallback without failing the turn", () =>
    Effect.gen(function* () {
      const harness = yield* makeWakeHarness;
      const now = yield* DateTime.now;
      yield* harness.runtime.startTurn(
        makeClaudeTestTurnInput({
          threadId: harness.threadId,
          providerThread: harness.providerThread,
          now,
          attemptId: RunAttemptId.make("claude-safety-fallback-attempt"),
          text: "Continue the audit",
          attachments: [],
        }),
      );
      const notice = "Safeguards flagged this message. Switched to Opus 4.8.";
      const uuid = "00000000-0000-4000-8000-000000000301";
      yield* Queue.offer(
        harness.sdkMessages,
        claudeSdkFrame({
          type: "system",
          subtype: "model_refusal_fallback",
          trigger: "refusal",
          direction: "retry",
          original_model: "claude-fable-5",
          fallback_model: "claude-opus-4-8",
          request_id: "request-safety-fallback",
          api_refusal_category: "cyber",
          api_refusal_explanation: null,
          content: notice,
          session_id: WAKE_NATIVE_SESSION,
          uuid,
        }),
      );
      yield* Queue.offer(
        harness.sdkMessages,
        makeResultFrame({
          uuid: "00000000-0000-4000-8000-000000000302",
          result: "Audit complete.",
        }),
      );
      yield* Queue.take(harness.terminalReceipts);
      const notices = harness.events.flatMap((event) =>
        event.type === "turn_item.updated" && event.turnItem.type === "system_notice"
          ? [event.turnItem]
          : [],
      );
      assert.lengthOf(notices, 1);
      assert.equal(notices[0]?.message, notice);
      assert.equal(notices[0]?.status, "completed");
      assert.equal(notices[0]?.nativeItemRef?.nativeId, uuid);
      assert.equal(harness.terminalEvents()[0]?.status, "completed");
      assert.isFalse(
        harness.events.some(
          (event) => event.type === "turn_item.updated" && event.turnItem.type === "error",
        ),
      );
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, IdAllocator.layer))),
  );

  it.effect(
    "runs native compaction and keeps its context watermark separate from billed usage",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeWakeHarness;
        const now = yield* DateTime.now;
        const compact = harness.runtime.compactThread;
        assert.isDefined(compact);
        if (compact === undefined) return;
        yield* compact(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("claude-native-compact-attempt"),
            text: " /COMPACT ",
            attachments: [],
          }),
        );
        yield* Queue.offer(
          harness.sdkMessages,
          claudeSdkFrame({
            type: "system",
            subtype: "compact_boundary",
            compact_metadata: { trigger: "manual", pre_tokens: 1500, post_tokens: 400 },
            uuid: "00000000-0000-4000-8000-000000000201",
            session_id: WAKE_NATIVE_SESSION,
          }),
        );
        yield* Queue.offer(
          harness.sdkMessages,
          makeResultFrame({
            uuid: "00000000-0000-4000-8000-000000000202",
            result: "Compacted conversation.",
          }),
        );
        yield* Queue.take(harness.terminalReceipts);

        assert.deepEqual(harness.offeredMessages[0]?.message.content, "/compact");
        const compaction = harness.events.find(
          (event) => event.type === "turn_item.updated" && event.turnItem.type === "compaction",
        );
        assert.isDefined(compaction);
        if (compaction?.type === "turn_item.updated" && compaction.turnItem.type === "compaction") {
          assert.equal(compaction.turnItem.beforeTokenCount, 1500);
          assert.equal(compaction.turnItem.afterTokenCount, 400);
          assert.equal(compaction.turnItem.status, "completed");
        }
        const watermark = harness.events.find(
          (event) =>
            event.type === "provider_turn.updated" &&
            event.providerTurn.tokenUsage?.usedTokens === 400,
        );
        assert.isDefined(watermark);
        const completed = harness.events.findLast(
          (event) => event.type === "provider_turn.updated",
        );
        assert.equal(completed?.type, "provider_turn.updated");
        if (completed?.type === "provider_turn.updated") {
          assert.deepEqual(completed.providerTurn.turnTokenUsage, {
            usageScope: "main_agent",
            usageStatus: "complete",
            hasSubagents: false,
            inputTokens: 1,
            outputTokens: 1,
            cachedInputTokens: 0,
            cacheCreationTokens: 0,
          });
        }
      }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, IdAllocator.layer))),
  );
});
