import type { ProviderAdapterV2HistoricalContext } from "./ProviderAdapter.ts";
import { assert, describe, it } from "@effect/vitest";
import {
  ContextHandoffId,
  MessageId,
  NodeId,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  RunId,
  ThreadId,
  TurnItemId,
  TurnId,
  OrchestrationV2ContextHandoff,
  type OrchestrationV2HistoricalMessage,
  type OrchestrationV2ProviderThread,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  contextUsageForHandoff,
  handoffBudget,
  scientHandoffByteBudget,
  historyCost,
  historyResponseItems,
  selectHistory,
  historicalMessage,
} from "./ContextHandoffBudget.ts";
import { projectContextHandoffForWire } from "./WireProjection.ts";
import { deliverContextHandoffs } from "./ContextHandoffDelivery.ts";

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const decodeHandoff = Schema.decodeUnknownSync(OrchestrationV2ContextHandoff);

const now = DateTime.makeUnsafe("2026-09-17T00:00:00Z");
const threadId = ThreadId.make("thread:handoff");
const providerThread: OrchestrationV2ProviderThread = {
  id: ProviderThreadId.make("provider-thread:target"),
  driver: ProviderDriverKind.make("codex"),
  providerInstanceId: ProviderInstanceId.make("codex"),
  providerSessionId: null,
  appThreadId: threadId,
  ownerNodeId: null,
  nativeThreadRef: {
    driver: ProviderDriverKind.make("codex"),
    strength: "strong",
    nativeId: "native:target",
  },
  nativeConversationHeadRef: null,
  status: "idle",
  firstRunOrdinal: null,
  lastRunOrdinal: null,
  handoffIds: [],
  forkedFrom: null,
  createdAt: now,
  updatedAt: now,
};
const message = (
  id: string,
  role: "user" | "assistant",
  text: string,
): OrchestrationV2HistoricalMessage => ({
  itemId: TurnItemId.make(id),
  role,
  text,
  threadId,
  runId: RunId.make("run:source"),
  providerThreadId: ProviderThreadId.make("provider-thread:source"),
  status: "interrupted",
  kind: role === "user" ? "user_message" : "assistant_message",
});
const messages = [
  message("item:one", "user", "Preserve every line.\n\n  And this indentation.\n"),
  message("item:two", "assistant", "Partial work: 日本語 🧪 مرحبا\n" + "x".repeat(600)),
];
const handoff: OrchestrationV2ContextHandoff = {
  id: ContextHandoffId.make("handoff:one"),
  threadId,
  targetRunId: RunId.make("run:target"),
  fromProviderThreadIds: [],
  toProviderThreadId: providerThread.id,
  coveredRunOrdinals: { from: 1, to: 2 },
  strategy: "full_thread_summary",
  status: "ready",
  summaryMessageId: null,
  summaryText: "",
  history: {
    messages,
    coverage: "Historical context; retrieve thread:handoff with scient_thread_read.",
    omittedItems: 0,
  },
  createdByProviderInstanceId: null,
  createdAt: now,
  updatedAt: now,
};

describe("handoff budget", () => {
  it("keeps old preview handoffs readable and delivery history off the wire", () => {
    const projected = projectContextHandoffForWire({
      ...handoff,
      summaryText: "private transcript and command output",
      delivery: {
        nativeThreadId: "native:target",
        status: "injected",
        itemIds: [messages[0]!.itemId],
      },
    });
    assert.equal(projected.summaryText, "");
    assert.isUndefined(projected.history);
    assert.isUndefined(projected.delivery);
    assert.equal(decodeHandoff(projected).id, handoff.id);
    assert.deepEqual(handoff.history?.messages, messages);
  });
  it("carries command outcomes as attributed activity and excludes reasoning", () => {
    const base = {
      id: TurnItemId.make("item:command"),
      threadId,
      runId: RunId.make("run:source"),
      nodeId: null,
      providerThreadId: providerThread.id,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 1,
      status: "failed" as const,
      title: null,
      startedAt: now,
      completedAt: now,
      updatedAt: now,
    };
    const command = historicalMessage({
      ...base,
      type: "command_execution",
      input: "vp test",
      output: "Failure near the end: " + "界".repeat(300),
      exitCode: 1,
    });
    assert.equal(command?.role, "assistant");
    assert.equal(command?.kind, "command_execution");
    assert.include(command!.text, "Exit code: 1");
    assert.include(command!.text, "界".repeat(300));
    assert.isNull(
      historicalMessage({
        ...base,
        type: "reasoning",
        text: "private reasoning",
        streaming: false,
      }),
    );
    assert.equal(historyResponseItems([command!], "Activity")[1]?.type, "message");
  });

  it("carries explicitly imported reasoning and work logs while excluding live provider material", () => {
    const base = {
      id: TurnItemId.make("item:portable-history"),
      threadId,
      runId: null,
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 1,
      status: "completed" as const,
      title: null,
      startedAt: now,
      completedAt: now,
      updatedAt: now,
      historyTurnId: TurnId.make("imported-turn"),
    };
    const reasoning = {
      ...base,
      type: "reasoning" as const,
      text: "Selected portable reasoning",
      streaming: false,
    };
    assert.equal(historicalMessage(reasoning)?.text, "Selected portable reasoning");
    assert.isNull(historicalMessage({ ...reasoning, historyTurnId: undefined }));
    assert.isNull(historicalMessage({ ...reasoning, runId: RunId.make("live-run") }));
    assert.isNull(
      historicalMessage({
        ...reasoning,
        nativeItemRef: {
          driver: ProviderDriverKind.make("codex"),
          nativeId: "live-reasoning",
          strength: "strong",
        },
      }),
    );
    const activity = {
      ...base,
      type: "dynamic_tool" as const,
      toolName: "tool.completed",
      input: {
        kind: "tool.completed",
        summary: "Check results",
        tone: "tool",
        payload: { output: "retained output", omittedLines: 4 },
      },
    };
    assert.include(historicalMessage(activity)!.text, "Check results");
    assert.include(historicalMessage(activity)!.text, "retained output");
    assert.include(historicalMessage(activity)!.text, '"omittedLines":4');
    assert.isNull(historicalMessage({ ...activity, runId: RunId.make("live-run") }));
    assert.isNull(historicalMessage({ ...activity, historyTurnId: undefined }));
    assert.isNull(historicalMessage({ ...activity, input: { command: "foreign tool call" } }));
    const turnless = {
      ...activity,
      historyTurnId: undefined,
      id: TurnItemId.make("server:conversation-import:owned:item:work-log"),
    };
    assert.include(historicalMessage(turnless)!.text, "retained output");
    assert.isNull(historicalMessage({ ...turnless, nodeId: NodeId.make("live-node") }));
    assert.isNull(
      historicalMessage({
        ...turnless,
        nativeItemRef: {
          driver: ProviderDriverKind.make("codex"),
          nativeId: "live-tool",
          strength: "strong",
        },
      }),
    );
    assert.equal(
      historicalMessage({
        ...reasoning,
        historyTurnId: undefined,
        id: TurnItemId.make("migration:v1:history:reasoning:owned"),
      })?.text,
      "Selected portable reasoning",
    );
  });

  it("retains short conversations verbatim in role and order", () => {
    const selected = selectHistory({ messages, coverage: "History", budget: 16_000 });
    assert.deepEqual(selected.messages, messages);
    const items = historyResponseItems(selected.messages, selected.context);
    assert.deepEqual(
      items.map((item) => item.role),
      ["user", "user", "assistant"],
    );
    assert.include(items[1]!.content[0]!.text, messages[0]!.text);
    assert.include(items[2]!.content[0]!.text, messages[1]!.text);
    assert.equal(selected.omittedItems, 0);
  });

  it("omits oversized multilingual items whole, preserves original constraints and recent work", () => {
    const candidates = [
      messages[0]!,
      message("huge", "assistant", "界🧪".repeat(20_000)),
      message("old", "assistant", "a".repeat(4_000)),
      messages[1]!,
    ];
    const selected = selectHistory({
      messages: candidates,
      coverage: "thread:handoff runs 1-4",
      budget: 3_000,
    });
    assert.deepEqual(selected.messages, messages);
    assert.equal(selected.omittedItems, 2);
    assert.isAtMost(historyCost(selected.messages, selected.context), 3_000);
  });

  it("counts JSON escaping and UTF-8 bytes across many messages", () => {
    const candidates = Array.from({ length: 500 }, (_, i) =>
      message(`item:${i}`, i % 2 ? "assistant" : "user", '\u0000\\"🧪界'.repeat(15)),
    );
    for (const budget of [1_024, 4_000, 16_000]) {
      const selected = selectHistory({
        messages: candidates,
        coverage: "Retrieve omitted history",
        budget,
      });
      assert.isAtMost(historyCost(selected.messages, selected.context), budget);
      assert.isAbove(selected.omittedItems, 0);
    }
  });

  it("fits the final envelope at intermediate selected/omitted digit boundaries", () => {
    const candidates = Array.from({ length: 20 }, (_, index) =>
      message(`boundary:${index}`, "user", "Short request"),
    );
    for (let budget = 4_000; budget <= 9_000; budget++) {
      const selected = selectHistory({
        messages: candidates,
        coverage: "Recover history",
        omittedItems: 90,
        budget,
      });
      assert.isAtMost(historyCost(selected.messages, selected.context), budget);
    }
  });

  it("subtracts native usage, input, attachments, instructions and space for work", () => {
    const base = {
      tokenCap: 16_000,
      userText: "Continue",
      attachments: [],
      providerThread,
      nativeContextEstimate: 0,
      modelContextWindow: 32_000,
    };
    assert.isBelow(handoffBudget(base), 16_000);
    assert.isBelow(handoffBudget({ ...base, nativeContextEstimate: 8_000 }), handoffBudget(base));
    assert.equal(handoffBudget({ ...base, userText: "界".repeat(30_000) }), 0);
    assert.equal(
      handoffBudget({
        ...base,
        providerThread: {
          ...providerThread,
          contextUsage: { usedTokens: 23_000, maxTokens: 24_000 },
        },
      }),
      0,
    );
    for (const sizeBytes of [100_000, 10 * 1024 * 1024]) {
      const attachments = [
        {
          type: "image",
          id: "attachment",
          name: "image.png",
          mimeType: "image/png",
          sizeBytes,
        },
      ];
      const withImage = handoffBudget({ ...base, attachments });
      assert.isAbove(withImage, 4_000);
      assert.isBelow(withImage, handoffBudget(base));
      assert.equal(handoffBudget({ ...base, attachments: [...attachments, ...attachments] }), 0);
      assert.equal(
        handoffBudget({
          ...base,
          tokenCap: 64_000,
          modelContextWindow: 1_000_000,
          // The history byte cap is independent of both current text and image payloads.
          userText: "x".repeat(70_000),
          attachments,
          providerThread: {
            ...providerThread,
            contextUsage: { usedTokens: 0, maxTokens: 1_000_000 },
          },
        }),
        64_000,
      );
    }
    assert.equal(handoffBudget({ ...base, tokenCap: 2_000 }), 2_000);
  });

  it("keeps measured occupancy across a model change", () => {
    const previous = {
      usedTokens: 37_321,
      maxTokens: 258_400,
      autoCompactThreshold: 32_000,
    };
    assert.isNull(
      contextUsageForHandoff({
        sameNativeThread: false,
        sameSelection: false,
        reuseTelemetry: false,
        previousUsage: previous,
      }),
    );
    assert.equal(
      contextUsageForHandoff({
        sameNativeThread: true,
        sameSelection: true,
        reuseTelemetry: true,
        previousUsage: previous,
      }),
      previous,
    );
    assert.deepEqual(
      contextUsageForHandoff({
        sameNativeThread: true,
        sameSelection: false,
        reuseTelemetry: true,
        previousUsage: previous,
      }),
      { usedTokens: 37_321, maxTokens: 258_400 },
    );
    assert.deepEqual(
      contextUsageForHandoff({
        sameNativeThread: true,
        sameSelection: false,
        reuseTelemetry: false,
        previousUsage: previous,
      }),
      { usedTokens: 37_321, maxTokens: 258_400 },
    );
    assert.deepEqual(
      contextUsageForHandoff({
        sameNativeThread: true,
        sameSelection: false,
        reuseTelemetry: false,
        previousUsage: { usedTokens: 30_000, maxTokens: 32_000, autoCompactThreshold: 31_000 },
        knownModelWindow: 1_000_000,
      }),
      { usedTokens: 30_000, maxTokens: 1_000_000 },
    );

    const preserved = contextUsageForHandoff({
      sameNativeThread: true,
      sameSelection: false,
      reuseTelemetry: false,
      previousUsage: previous,
    });
    assert.equal(
      handoffBudget({
        tokenCap: 16_000,
        userText: "Continue work",
        attachments: [
          {
            type: "image",
            id: "screenshot-a",
            name: "a.png",
            mimeType: "image/png",
            sizeBytes: 100_000,
          },
          {
            type: "image",
            id: "screenshot-b",
            name: "b.png",
            mimeType: "image/png",
            sizeBytes: 100_000,
          },
        ],
        providerThread: { ...providerThread, contextUsage: preserved },
        nativeContextEstimate: 0,
        modelContextWindow: preserved?.maxTokens,
      }),
      16_000,
    );
    assert.equal(
      handoffBudget({
        tokenCap: 16_000,
        userText: "Continue work",
        attachments: [],
        providerThread,
        nativeContextEstimate: 120_000,
      }),
      0,
    );
  });
  it("reserves context for image batches up to the attachment limit, honoring smaller known windows", () => {
    let previousBudget = 16_000;
    for (let count = 1; count <= PROVIDER_SEND_TURN_MAX_ATTACHMENTS; count++) {
      const input = {
        tokenCap: 16_000,
        userText: "Compare these screenshots",
        providerThread,
        nativeContextEstimate: 0,
        attachments: Array.from({ length: count }, (_, index) => ({
          type: "image",
          id: `image-${index}`,
          name: "image.png",
          mimeType: "image/png",
          sizeBytes: 100_000,
        })),
      };
      const budget = handoffBudget(input);
      assert.isAtLeast(budget, 0);
      assert.isAtMost(budget, previousBudget);
      previousBudget = budget;
      if (count <= 8) assert.equal(budget, 16_000);
      if (count === 10) {
        assert.isAbove(budget, 0);
        assert.isBelow(budget, 16_000);
      }
      if (count === PROVIDER_SEND_TURN_MAX_ATTACHMENTS) assert.equal(budget, 0);
      if (budget > 0) {
        const selected = selectHistory({ messages, coverage: "Recover omitted history", budget });
        assert.isAtMost(historyCost(selected.messages, selected.context), budget);
      }
      assert.equal(handoffBudget({ ...input, modelContextWindow: 2_000_000 }), 16_000);
      assert.equal(handoffBudget({ ...input, modelContextWindow: 20_000 }), 0);
      assert.equal(
        handoffBudget({
          ...input,
          providerThread: { ...providerThread, contextUsage: { usedTokens: 0, maxTokens: 20_000 } },
        }),
        0,
      );
      assert.equal(
        handoffBudget({
          ...input,
          modelContextWindow: 1_000_000,
          providerThread: {
            ...providerThread,
            contextUsage: { usedTokens: 0, maxTokens: 1_000_000, autoCompactThreshold: 20_000 },
          },
        }),
        0,
      );
    }
  });
});

describe("handoff delivery", () => {
  for (const native of [true, false]) {
    it.effect(
      `carries source omissions through ${native ? "native injection" : "inline fallback"} within the same history budget`,
      () =>
        Effect.gen(function* () {
          let offered = "";
          const result = yield* deliverContextHandoffs({
            handoffs: [handoff],
            providerThread,
            budget: 8_000,
            sourceOmissions: [{ _tag: "range-truncated", throughMessageN: 2 }],
            alreadyDeliveredItemIds: new Set(),
            inject: (value) =>
              Effect.sync(() => {
                offered = value.context;
                return native;
              }),
            persist: () => Effect.void,
          });
          const context = native ? offered : result.context;
          assert.include(context, "Known source omissions (unverified)");
          assert.include(context, '"range-truncated"');
          assert.include(context, '"throughMessageN":2');
          assert.isAtMost(Buffer.byteLength(context), 8_000);
        }),
    );
  }

  for (const native of [true, false]) {
    it.effect(
      `records omitted recovery coverage separately from ${native ? "injected" : "inline"} text`,
      () =>
        Effect.gen(function* () {
          const omittedBeforeDelivery = TurnItemId.make("item:omitted-during-preparation");
          const oversized = message("item:oversized", "user", "x".repeat(20_000));
          let durable: OrchestrationV2ContextHandoff = {
            ...handoff,
            history: {
              ...handoff.history!,
              messages: [...messages, oversized],
              omittedItems: 1,
              omittedItemIds: [omittedBeforeDelivery],
            },
          };
          const result = yield* deliverContextHandoffs({
            handoffs: [durable],
            providerThread,
            budget: 16_000,
            alreadyDeliveredItemIds: new Set(),
            inject: (value) => {
              assert.include(value.context, "omitted 2 items");
              assert.notInclude(
                value.messages.map((item) => item.itemId),
                oversized.itemId,
              );
              return Effect.succeed(native);
            },
            persist: (value) =>
              Effect.sync(() => {
                durable = value;
              }),
          });
          assert.equal(durable.delivery?.status, native ? "injected" : "pending");
          yield* result.delivered;
          assert.equal(durable.delivery?.status, native ? "injected" : "inline");
          assert.deepEqual(
            durable.delivery?.itemIds,
            messages.map((item) => item.itemId),
          );
          assert.deepEqual(durable.delivery?.omittedItemIds, [
            omittedBeforeDelivery,
            oversized.itemId,
          ]);
          assert.deepEqual(decodeHandoff(durable).delivery, durable.delivery);
        }),
    );
  }
  it.effect("loads the history budget only when a handoff needs delivery", () =>
    Effect.gen(function* () {
      let reads = 0;
      const input = {
        providerThread,
        budget: Effect.sync(() => {
          reads++;
          return 16_000;
        }),
        alreadyDeliveredItemIds: new Set<string>(),
        persist: () => Effect.void,
      };
      yield* deliverContextHandoffs({ ...input, handoffs: [] });
      yield* deliverContextHandoffs({ ...input, handoffs: [handoff], deferInline: true });
      yield* deliverContextHandoffs({
        ...input,
        handoffs: [
          {
            ...handoff,
            delivery: {
              nativeThreadId: providerThread.nativeThreadRef!.nativeId!,
              status: "injected",
              itemIds: [],
            },
          },
        ],
      });
      assert.equal(reads, 0);
      const result = yield* deliverContextHandoffs({ ...input, handoffs: [handoff] });
      assert.equal(reads, 1);
      assert.include(result.context, messages[0]!.text);
    }),
  );

  it.effect("persists successful injection before turn start and skips it on retry", () =>
    Effect.gen(function* () {
      let durable = handoff;
      const history: unknown[] = [];
      const statuses: string[] = [];
      const input = {
        providerThread,
        budget: 16_000,
        alreadyDeliveredItemIds: new Set<string>(),
        inject: (value: ProviderAdapterV2HistoricalContext) =>
          Effect.sync(() => {
            history.push(...historyResponseItems(value.messages, value.context));
            return true;
          }),
        persist: (value: OrchestrationV2ContextHandoff) =>
          Effect.sync(() => {
            durable = value;
            statuses.push(value.delivery!.status);
          }),
      };
      const first = yield* deliverContextHandoffs({ ...input, handoffs: [durable] });
      assert.equal(first.context, "");
      assert.deepEqual(statuses, ["pending", "injected"]);
      assert.lengthOf(history, 3);
      // No turn has started. Reconstruct from the durable projection as a retry would.
      const second = yield* deliverContextHandoffs({ ...input, handoffs: [durable] });
      assert.equal(second.context, "");
      assert.lengthOf(history, 3);
    }),
  );

  it.effect(
    "uses the same selection on explicit native fallback, marking only accepted input",
    () =>
      Effect.gen(function* () {
        let durable = handoff;
        const result = yield* deliverContextHandoffs({
          handoffs: [handoff],
          providerThread,
          budget: 16_000,
          alreadyDeliveredItemIds: new Set(),
          inject: () => Effect.succeed(false),
          persist: (value) =>
            Effect.sync(() => {
              durable = value;
            }),
        });
        assert.include(result.context, messages[0]!.text);
        assert.include(result.context, messages[1]!.text);
        assert.equal(durable.delivery?.status, "pending");
        yield* result.delivered;
        assert.equal(durable.delivery?.status, "inline");
      }),
  );

  it.effect(
    "defers unsupported compaction history until a normal turn without marking delivery uncertain",
    () =>
      Effect.gen(function* () {
        let durable = handoff;
        const persist = (value: OrchestrationV2ContextHandoff) =>
          Effect.sync(() => {
            durable = value;
          });
        const compact = yield* deliverContextHandoffs({
          handoffs: [durable],
          providerThread,
          budget: 16_000,
          alreadyDeliveredItemIds: new Set(),
          deferInline: true,
          inject: () => Effect.succeed(false),
          persist,
        });
        yield* compact.delivered;
        assert.equal(compact.context, "");
        assert.isUndefined((() => durable.delivery)());
        const next = yield* deliverContextHandoffs({
          handoffs: [durable],
          providerThread,
          budget: 16_000,
          alreadyDeliveredItemIds: new Set(),
          inject: () => Effect.succeed(false),
          persist,
        });
        assert.include(next.context, messages[0]!.text);
        yield* next.delivered;
        assert.equal(durable.delivery?.status, "inline");
      }),
  );

  it.effect("bounds accumulated recovery markers while keeping omitted history discoverable", () =>
    Effect.gen(function* () {
      const many = Array.from({ length: 100 }, (_, index) => ({
        ...handoff,
        id: ContextHandoffId.make(`handoff:retry:${index}`),
      }));
      let captured: ProviderAdapterV2HistoricalContext | undefined;
      const result = yield* deliverContextHandoffs({
        handoffs: many,
        providerThread,
        budget: 2_500,
        alreadyDeliveredItemIds: new Set(),
        inject: (history) =>
          Effect.sync(() => {
            captured = history;
            return true;
          }),
        persist: () => Effect.void,
      });
      assert.equal(result.context, "");
      assert.isDefined(captured);
      assert.include(captured.context, "detailed coverage references omitted");
      assert.include(captured.context, "scient_thread_read");
      assert.include(captured.context, threadId);
      assert.isAtMost(historyCost(captured.messages, captured.context), 2_500);
      assert.isAbove(captured.messages.length, 0);
    }),
  );

  it.effect("does not redeliver after ambiguous injection failure", () =>
    Effect.gen(function* () {
      let durable = handoff;
      let calls = 0;
      const input = {
        providerThread,
        budget: 16_000,
        alreadyDeliveredItemIds: new Set<string>(),
        inject: () =>
          Effect.sync(() => {
            calls++;
          }).pipe(Effect.andThen(Effect.fail("connection lost"))),
        persist: (value: OrchestrationV2ContextHandoff) =>
          Effect.sync(() => {
            durable = value;
          }),
      };
      yield* deliverContextHandoffs({ ...input, handoffs: [durable] }).pipe(Effect.result);
      assert.equal(durable.delivery?.status, "pending");
      const retry = yield* deliverContextHandoffs({ ...input, handoffs: [durable] }).pipe(
        Effect.result,
      );
      assert.equal(retry._tag, "Failure");
      assert.equal(calls, 1);
    }),
  );

  it.effect("budgets multiple handoffs together and skips previously delivered items", () =>
    Effect.gen(function* () {
      const extra = {
        ...handoff,
        id: ContextHandoffId.make("handoff:two"),
        history: {
          ...handoff.history!,
          messages: [...messages, message("item:three", "assistant", "Latest result")],
        },
      };
      let delivered: ReadonlyArray<unknown> = [];
      yield* deliverContextHandoffs({
        handoffs: [handoff, extra],
        providerThread,
        budget: 2_500,
        alreadyDeliveredItemIds: new Set(["item:one"]),
        inject: (value) =>
          Effect.sync(() => {
            delivered = historyResponseItems(value.messages, value.context);
            return true;
          }),
        persist: () => Effect.void,
      });
      const serialized = yield* encodeJson(delivered);
      assert.isAtMost(Buffer.byteLength(serialized), 2_500);
      assert.notInclude(serialized, "Preserve every line");
      assert.equal(serialized.split("Partial work").length - 1, 1);
      assert.include(serialized, "Latest result");
    }),
  );

  it.effect("fails before delivery when even the coverage marker cannot fit", () =>
    Effect.gen(function* () {
      let calls = 0;
      const result = yield* deliverContextHandoffs({
        handoffs: [handoff],
        providerThread,
        budget: 0,
        alreadyDeliveredItemIds: new Set(),
        inject: () =>
          Effect.sync(() => {
            calls++;
            return true;
          }),
        persist: () => Effect.void,
      }).pipe(Effect.result);
      assert.equal(result._tag, "Failure");
      assert.equal(calls, 0);
    }),
  );
});

describe("Scient native handoff token policy", () => {
  const input = {
    tokenCap: null,
    bytesPerToken: 3,
    byteCap: Infinity,
    userText: "",
    attachments: [],
    providerThread,
    nativeContextEstimate: 0,
  };
  it("uses the unknown 128k window and charges token reserves before selecting bytes", () => {
    assert.equal(handoffBudget(input), 287_997);
    assert.equal(handoffBudget({ ...input, tokenCap: 64_000 }), 192_000);
    assert.equal(handoffBudget({ ...input, nativeContextEstimate: 100_000 }), 0);
  });
  it("bounds the preset by compaction, native occupancy and full current attachment allowances", () => {
    const usage = { usedTokens: 140_000, maxTokens: 1_000_000, autoCompactThreshold: 200_000 };
    const nearFull = { ...input, providerThread: { ...providerThread, contextUsage: usage } };
    assert.equal(handoffBudget(nearFull), 29_997);
    const image = {
      type: "image" as const,
      id: "image",
      name: "figure.png",
      mimeType: "image/png",
      sizeBytes: 1,
    };
    assert.equal(
      handoffBudget(nearFull) - handoffBudget({ ...nearFull, attachments: [image] }),
      24_576,
    );
    assert.equal(handoffBudget({ ...nearFull, attachments: [image, image] }), 0);
    assert.equal(
      handoffBudget({
        ...input,
        tokenCap: 64_000,
        providerThread: {
          ...providerThread,
          contextUsage: { usedTokens: 0, maxTokens: 1_000_000 },
        },
      }),
      192_000,
    );
  });
});

const inertForkItem = {
  id: TurnItemId.make("frozen-item"),
  threadId,
  runId: null,
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: 1,
  status: "interrupted" as const,
  title: null,
  startedAt: now,
  completedAt: now,
  updatedAt: now,
  inheritedFrom: {
    threadId: ThreadId.make("running-source"),
    itemId: TurnItemId.make("source-partial"),
    runId: RunId.make("source-run"),
    status: "running" as const,
  },
};
it("native history names captured-window images as references without replaying image bytes", () => {
  const history = historicalMessage({
    ...inertForkItem,
    type: "user_message",
    messageId: MessageId.make("frozen-user"),
    createdBy: "user",
    creationSource: "web",
    inputIntent: "turn_start",
    status: "completed",
    text: "Look at this",
    attachments: [
      {
        type: "image",
        id: "snapshot-owned",
        name: "window.png",
        mimeType: "image/png",
        sizeBytes: 10,
        source: {
          kind: "snap-shot",
          capturedAt: "2026-09-26T10:00:00.000Z",
          appName: "Synthetic capture",
          windowTitle: "Test window",
        },
      },
      { type: "image", id: "plain-owned", name: "plot.png", mimeType: "image/png", sizeBytes: 10 },
    ],
  });
  assert.ok(history);
  assert.include(history.text, "window.png");
  assert.include(history.text, '"capturedWindow":true');
  assert.include(history.text, '"contentReattached":false');
  const wire = historyResponseItems([history], "History");
  assert.isFalse(JSON.stringify(wire).includes('"type":"input_image"'));
  assert.include(wire[1]!.content[0]!.text, "plot.png");
});
it("native selection keeps original constraints and latest thinking before oversized older work", () => {
  const candidates = [
    message("constraints", "user", "Keep source fidelity"),
    message("old-work", "assistant", "old work".repeat(5000)),
    message("latest-request", "user", "Fit the model"),
    { ...message("latest-thinking", "assistant", "Trying a quadratic"), kind: "reasoning" },
    message("latest-answer", "assistant", "Partial fit"),
  ];
  const selected = selectHistory({ messages: candidates, coverage: "History", budget: 1800 });
  assert.deepEqual(
    selected.messages.map((item) => item.itemId),
    ["constraints", "latest-request", "latest-thinking", "latest-answer"],
  );
  assert.deepEqual(selected.omittedItemIds, ["old-work"]);
  assert.isAtMost(historyCost(selected.messages, selected.context), 1800);
});
it.effect(
  "native delivery labels a running fork's unfinished material and warns about its shared folder",
  () =>
    Effect.gen(function* () {
      const thought = historicalMessage({
        ...inertForkItem,
        type: "reasoning",
        text: "Trying a quadratic",
        streaming: false,
      });
      const tool = historicalMessage({
        ...inertForkItem,
        id: TurnItemId.make("frozen-tool"),
        type: "dynamic_tool",
        toolName: "fit_model",
        input: { file: "src/fit.py" },
        output: "Still fitting",
      });
      const file = historicalMessage({
        ...inertForkItem,
        id: TurnItemId.make("frozen-file"),
        type: "file_change",
        fileName: "src/fit.py",
      });
      assert.ok(thought && tool && file);
      const result = yield* deliverContextHandoffs({
        handoffs: [
          {
            ...handoff,
            history: {
              messages: [thought, tool, file],
              coverage: "Frozen native fork",
              omittedItems: 0,
            },
          },
        ],
        providerThread,
        budget: 10000,
        alreadyDeliveredItemIds: new Set(),
        sharedForkWorkspace: true,
        persist: () => Effect.void,
      });
      assert.include(result.context, "partial");
      assert.include(result.context, "unfinished");
      assert.include(result.context, "still be running in this same folder");
      assert.include(result.context, "src/fit.py");
      assert.include(result.context, "status=interrupted");
      assert.notInclude(result.context, '"type":"tool_call"');
    }),
);

describe("Scient serialized handoff allowance", () => {
  it("preserves presets and unclamped override without changing generic switches", () => {
    const input = {
      environmentOverride: undefined,
      userText: 'Continue "exactly" 🧪',
      attachments: [],
      providerThread,
      nativeContextEstimate: 0,
      modelContextWindow: 1_000_000,
    };
    assert.equal(scientHandoffByteBudget({ ...input, size: "compact" }), 48_000);
    assert.equal(scientHandoffByteBudget({ ...input, size: "standard" }), 192_000);
    assert.equal(scientHandoffByteBudget({ ...input, size: "large" }), 384_000);
    assert.isAbove(scientHandoffByteBudget({ ...input, size: "maximum" }), 2_000_000);
    assert.equal(
      scientHandoffByteBudget({ ...input, size: "compact", environmentOverride: 200_000 }),
      600_000,
    );
    assert.equal(handoffBudget({ ...input, tokenCap: 200_000 }), 64_000);
  });

  it("charges receiving occupancy, escaped input, attachments and selected capacity", () => {
    const input = {
      size: "maximum" as const,
      environmentOverride: undefined,
      userText: "Continue",
      attachments: [],
      providerThread: {
        ...providerThread,
        contextUsage: { usedTokens: 7_000, maxTokens: 1_000_000 },
      },
      nativeContextEstimate: 0,
      modelContextWindow: 32_000,
    };
    const available = scientHandoffByteBudget(input);
    assert.equal(available, (32_000 - 7_000 - 4 - 16_000) * 3);
    assert.equal(scientHandoffByteBudget({ ...input, userText: "界".repeat(10_000) }), 0);
    const image = {
      type: "image" as const,
      id: "image",
      name: "image.png",
      mimeType: "image/png",
      sizeBytes: 10_000_000,
    };
    assert.equal(
      scientHandoffByteBudget({ ...input, attachments: [image] }),
      Math.max(0, available - 8_192 * 3),
    );
    assert.equal(scientHandoffByteBudget({ ...input, modelContextWindow: 16_000 }), 0);
  });
});

it.effect.each(["after-record", "before-agent"] as const)(
  "native context interruption retains an uncertain pending receipt without claiming delivery: %s",
  (scenario) =>
    Effect.gen(function* () {
      let durable = handoff;
      let injectCalls = 0;
      const result = yield* deliverContextHandoffs({
        handoffs: [handoff],
        providerThread,
        budget: 16_000,
        alreadyDeliveredItemIds: new Set(),
        persist: (value) =>
          Effect.sync(() => {
            durable = value;
          }).pipe(Effect.andThen(scenario === "after-record" ? Effect.interrupt : Effect.void)),
        inject: () =>
          Effect.sync(() => {
            injectCalls++;
          }).pipe(Effect.andThen(Effect.interrupt)),
      }).pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(result));
      if (Exit.isFailure(result)) assert.isTrue(Cause.hasInterruptsOnly(result.cause));
      assert.equal(durable.delivery?.status, "pending");
      assert.equal(durable.delivery?.nativeThreadId, providerThread.nativeThreadRef?.nativeId);
      assert.equal(injectCalls, scenario === "after-record" ? 0 : 1);
      // Native pending delivery cannot be claimed as notSent or resent into the
      // same thread merely because no acceptance acknowledgement was observed.
      const retry = yield* deliverContextHandoffs({
        handoffs: [durable],
        providerThread,
        budget: 16_000,
        alreadyDeliveredItemIds: new Set(),
        persist: () => Effect.die("Ambiguous receipt must remain intact"),
        inject: () => Effect.die("Ambiguous context must not be injected twice"),
      }).pipe(Effect.result);
      assert.equal(retry._tag, "Failure");
      if (retry._tag === "Failure")
        assert.equal(retry.failure._tag, "ContextHandoffDeliveryUncertainError");
    }),
);
