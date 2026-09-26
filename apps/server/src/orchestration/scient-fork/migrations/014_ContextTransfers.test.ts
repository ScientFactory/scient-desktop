import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../../../persistence/Layers/Sqlite.ts";
import Migration014 from "./014_ContextTransfers.ts";

const NOW = "2026-09-26T12:00:00.000Z";
const decodeTurnIds = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(Schema.String)));

it.layer(SqlitePersistenceMemory)("Scient migration 14: context transfers", (it) => {
  const insertLegacyFork = (threadId: string, bootstrapStatus: string, messageId: string | null) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        INSERT INTO scient_thread_lineage (
          thread_id, forked_from_thread_id, fork_point_turn_id, fork_point_turn_count,
          baseline_turn_id, copied_boundaries_json, workspace_mode, provider_mode,
          provider_bootstrap_status, provider_bootstrap_message_id, fidelity_mode, status,
          checkpoint_status, workspace_status, attempt_count, created_at, updated_at
        ) VALUES (
          ${threadId}, 'origin', 'origin-turn-2', 2,
          'baseline-turn',
          '[{"turnId":"copied-1","userMessageId":null,"assistantMessageId":"a1","completedAt":"2026-09-26T12:00:00.000Z"},{"turnId":"baseline-turn","userMessageId":null,"assistantMessageId":"a2","completedAt":"2026-09-26T12:00:00.000Z"}]',
          'local', 'transcript-bootstrap',
          ${bootstrapStatus}, ${messageId}, 'transcript-bootstrap', 'ready',
          'ready', 'shared', 1, ${NOW}, ${NOW}
        )
      `;
    });

  it.effect("carries delivery state over without re-sending delivered context", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`DELETE FROM scient_context_transfers`;
      yield* sql`DELETE FROM scient_context_handoffs`;
      yield* insertLegacyFork("fork-completed", "completed", "m-completed");
      yield* insertLegacyFork("fork-ambiguous", "ambiguous", "m-ambiguous");
      yield* insertLegacyFork("fork-pending", "pending", null);

      yield* Migration014;
      // Idempotent: a second run changes nothing.
      yield* Migration014;

      const transfers = yield* sql<{ readonly thread_id: string; readonly status: string }>`
        SELECT thread_id, status FROM scient_context_transfers ORDER BY thread_id
      `;
      assert.deepEqual(
        transfers.map((row) => [row.thread_id, row.status]),
        [
          ["fork-ambiguous", "resolved_portable"],
          ["fork-completed", "consumed"],
          ["fork-pending", "pending"],
        ],
      );
      const handoffs = yield* sql<{
        readonly thread_id: string;
        readonly delivery_status: string;
        readonly rebind_pending: number;
        readonly message_id: string | null;
      }>`
        SELECT thread_id, delivery_status, rebind_pending, message_id
        FROM scient_context_handoffs ORDER BY thread_id
      `;
      assert.deepEqual(
        handoffs.map((row) => [
          row.thread_id,
          row.delivery_status,
          row.rebind_pending,
          row.message_id,
        ]),
        [
          // Uncertain: settled from provider evidence or re-delivered fresh.
          ["fork-ambiguous", "pending", 0, "m-ambiguous"],
          // Delivered: trusted and bound to the next provider session seen.
          ["fork-completed", "inline", 1, "m-completed"],
        ],
      );
      const lineage = yield* sql<{ readonly inherited_turn_ids_json: string }>`
        SELECT inherited_turn_ids_json FROM scient_thread_lineage WHERE thread_id = 'fork-completed'
      `;
      assert.deepEqual(
        new Set(decodeTurnIds(lineage[0]!.inherited_turn_ids_json)),
        new Set(["baseline-turn", "copied-1"]),
      );
    }),
  );
});
