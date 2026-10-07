import type { OrchestrationV2DomainEvent } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

/** An import creates a message identity. Recheck under the same transaction
 * as its receipt so a competing admission cannot replace existing history. */
export const legacyQueueImportReusesMessageIdentity = (
  sql: SqlClient.SqlClient,
  events: ReadonlyArray<OrchestrationV2DomainEvent>,
) =>
  Effect.gen(function* () {
    for (const event of events) {
      if (event.type !== "message.updated") continue;
      const existing = yield* sql<{ readonly message_id: string }>`
        SELECT message_id FROM orchestration_v2_projection_messages
        WHERE message_id = ${event.payload.id}
        LIMIT 1
      `;
      if (existing.length > 0) return true;
    }
    return false;
  });
