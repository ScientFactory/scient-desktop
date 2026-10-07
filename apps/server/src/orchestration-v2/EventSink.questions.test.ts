import { assert, it } from "@effect/vitest";
import {
  EventId,
  NodeId,
  ProviderDriverKind,
  ProviderThreadId,
  ProviderTurnId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as EventSink from "./EventSink.ts";
import * as EventStore from "./EventStore.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

const stores = Layer.merge(EventStore.layer, ProjectionStore.layer).pipe(
  Layer.provideMerge(SqlitePersistenceMemory),
);
const testLayer = EventSink.layer.pipe(Layer.provideMerge(stores));
for (const change of [
  "same-owner",
  "request",
  "node",
  "provider-turn",
  "native-reference",
  "cancelled",
  "explicit-answer",
  "canonical-edit",
] as const) {
  it.effect(
    `preserves a submitted callback answer only for exact native settlement: ${change}`,
    () =>
      Effect.gen(function* () {
        const sink = yield* EventSink.EventSinkV2;
        const store = yield* ProjectionStore.ProjectionStoreV2;
        const threadId = ThreadId.make(`settlement-${change}`);
        const now = yield* DateTime.now;
        const current = {
          id: TurnItemId.make(`settlement:${change}`),
          type: "user_input_request" as const,
          threadId,
          runId: RunId.make("source-run"),
          nodeId: NodeId.make("question-node"),
          providerThreadId: ProviderThreadId.make("source-provider-thread"),
          providerTurnId: ProviderTurnId.make("source-provider-turn"),
          nativeItemRef: {
            driver: ProviderDriverKind.make("acp"),
            nativeId: "native-question",
            strength: "strong" as const,
          },
          parentItemId: null,
          ordinal: 1,
          status: "completed" as const,
          startedAt: now,
          completedAt: now,
          updatedAt: now,
          title: "Dataset",
          requestId: RuntimeRequestId.make("callback-request"),
          questions: [
            { id: "dataset", header: "Dataset", question: "Which dataset?", options: [] },
          ],
          questionAnswer: {
            requestId: "callback-request",
            answers: { dataset: "Observed answer" },
            attachmentsByQuestionId: {},
          },
        } satisfies OrchestrationV2TurnItem;
        yield* sink.write({
          events: [
            {
              id: EventId.make(`answer:${change}`),
              type: "turn-item.updated",
              threadId,
              occurredAt: now,
              payload: current,
            },
          ],
        });
        const { questionAnswer: _answer, ...withoutAnswer } = current;
        const incoming = {
          ...withoutAnswer,
          ...(change === "request" ? { requestId: RuntimeRequestId.make("new-request") } : {}),
          ...(change === "node" ? { nodeId: NodeId.make("other-node") } : {}),
          ...(change === "provider-turn"
            ? { providerTurnId: ProviderTurnId.make("other-turn") }
            : {}),
          ...(change === "native-reference"
            ? { nativeItemRef: { ...current.nativeItemRef, nativeId: "other-question" } }
            : {}),
          ...(change === "cancelled" ? { status: "cancelled" as const } : {}),
          ...(change === "explicit-answer"
            ? {
                questionAnswer: {
                  ...current.questionAnswer,
                  answers: { dataset: "Canonical replacement" },
                },
              }
            : {}),
        };
        const committed = yield* sink.write({
          guardPendingUserInputCancellations: change !== "canonical-edit",
          events: [
            {
              id: EventId.make(`settled:${change}`),
              type: "turn-item.updated",
              threadId,
              occurredAt: now,
              payload: incoming,
            },
          ],
        });
        const [projected] = yield* store.getTurnStartHistory(threadId);
        const stored = committed[0]?.event;
        if (stored?.type !== "turn-item.updated" || stored.payload.type !== "user_input_request")
          return assert.fail("Expected durable question update");
        if (change === "same-owner") {
          assert.deepEqual(stored.payload.questionAnswer, current.questionAnswer);
          if (projected?.type !== "user_input_request")
            return assert.fail("Expected recoverable completed question");
          assert.deepEqual(projected.questionAnswer, current.questionAnswer);
        } else if (change === "explicit-answer") {
          assert.deepEqual(stored.payload.questionAnswer?.answers, {
            dataset: "Canonical replacement",
          });
        } else {
          assert.isUndefined(stored.payload.questionAnswer);
          assert.isUndefined(projected);
        }
      }).pipe(Effect.provide(testLayer)),
  );
}
