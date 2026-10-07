/** Native callback settlement reports the original question, without the
 * answer just committed by the application. Only lifecycle ingestion
 * opts into this guard; explicit canonical edits do not. */
import type { OrchestrationV2DomainEvent } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import { decodeTurnItemRow } from "./projectionRowJson.ts";

/** Restore a committed answer onto a completed question that arrives without it. */
export const retainCommittedQuestionAnswers = (
  sql: SqlClient.SqlClient,
  events: ReadonlyArray<OrchestrationV2DomainEvent>,
) =>
  Effect.forEach(
    events,
    (event) =>
      Effect.gen(function* () {
        if (
          event.type !== "turn-item.updated" ||
          event.payload.type !== "user_input_request" ||
          event.payload.status !== "completed" ||
          event.payload.questionAnswer !== undefined ||
          event.payload.nativeItemRef === null
        )
          return event;
        const incoming = event.payload;
        const incomingRef = incoming.nativeItemRef;
        if (incomingRef === null) return event;
        const [row] = yield* sql<{ payload_json: string }>`
            SELECT payload_json FROM orchestration_v2_projection_turn_items
            WHERE thread_id = ${event.threadId} AND turn_item_id = ${incoming.id}`;
        if (row === undefined) return event;
        const current = yield* decodeTurnItemRow(row.payload_json);
        if (
          current.type !== "user_input_request" ||
          current.status !== "completed" ||
          current.questionAnswer === undefined ||
          current.responseMode === "message" ||
          current.requestId !== incoming.requestId ||
          current.threadId !== incoming.threadId ||
          current.runId !== incoming.runId ||
          current.nodeId !== incoming.nodeId ||
          current.providerThreadId !== incoming.providerThreadId ||
          current.providerTurnId !== incoming.providerTurnId ||
          current.nativeItemRef?.driver !== incomingRef.driver ||
          current.nativeItemRef?.nativeId !== incomingRef.nativeId ||
          current.nativeItemRef?.strength !== incomingRef.strength
        )
          return event;
        return { ...event, payload: { ...incoming, questionAnswer: current.questionAnswer } };
      }),
    { concurrency: 1 },
  );
