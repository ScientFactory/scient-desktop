import { ScientCompletedAnswer } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { completedAnswerSql } from "./completedAnswerSql.ts";

const decodeAnswer = Schema.decodeUnknownEffect(Schema.fromJsonString(ScientCompletedAnswer));

it.layer(SqlitePersistenceMemory)("durable completed answer", (it) => {
  it.effect(
    "survives queued, stopped, and failed turns and disappears when its message is reverted",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        // The production query is correlated to a thread row, supplied here by a CTE.
        const read = () => sql<{ answer: string | null }>`
      WITH projection_threads(thread_id) AS (VALUES ('one'))
      SELECT ${completedAnswerSql(sql)} AS answer FROM projection_threads
    `;
        const at = "2026-09-09T10:00:00.000Z";
        yield* sql`INSERT INTO projection_thread_messages (message_id, thread_id, turn_id, role, text, is_streaming, created_at, updated_at)
      VALUES ('reply', 'one', 'finished', 'assistant', 'Answer', 0, ${at}, ${at})`;
        yield* sql`INSERT INTO projection_turns (row_id, thread_id, turn_id, assistant_message_id, state, requested_at, started_at, completed_at, checkpoint_files_json)
      VALUES (1, 'one', 'finished', 'reply', 'completed', ${at}, ${at}, ${at}, '[]')`;
        const expected = { turnId: "finished", messageId: "reply", completedAt: at };
        for (const state of ["running", "interrupted", "error", "completed"]) {
          // A later turn without an answer must never hide or create a waiting answer.
          yield* sql`INSERT OR REPLACE INTO projection_turns (row_id, thread_id, turn_id, state, requested_at, completed_at, checkpoint_files_json)
        VALUES (2, 'one', 'next', ${state}, '2026-09-09T11:00:00.000Z', '2026-09-09T11:01:00.000Z', '[]')`;
          const rows = yield* read();
          assert.deepEqual(yield* decodeAnswer(rows[0]!.answer), expected);
        }
        yield* sql`UPDATE projection_thread_messages SET is_streaming = 1 WHERE message_id = 'reply'`;
        assert.equal((yield* read())[0]!.answer, null);
        yield* sql`DELETE FROM projection_thread_messages WHERE message_id = 'reply'`;
        assert.equal((yield* read())[0]!.answer, null);
      }),
  );
});
