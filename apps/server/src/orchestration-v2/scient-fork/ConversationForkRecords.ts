/**
 * A fork's own setup state (workspace, checkpoint, retained files, provisioning status), kept in
 * Scient's table rather than on T3's thread record, so copies of a thread never carry it.
 */
import { ScientConversationFork, type ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/sql/SqlClient";

const forkJson = Schema.fromJsonString(ScientConversationFork);
const encodeFork = Schema.encodeEffect(forkJson);
const decodeFork = Schema.decodeUnknownEffect(forkJson);

export const writeConversationFork = Effect.fnUntraced(function* (
  sql: SqlClient.SqlClient,
  threadId: ThreadId,
  fork: ScientConversationFork,
) {
  const json = yield* encodeFork(fork);
  yield* sql`
    INSERT INTO scient_conversation_forks (thread_id, fork_json) VALUES (${threadId}, ${json})
    ON CONFLICT (thread_id) DO UPDATE SET fork_json = excluded.fork_json
  `;
});

export const readConversationFork = Effect.fnUntraced(function* (
  sql: SqlClient.SqlClient,
  threadId: ThreadId,
) {
  const rows = yield* sql<{ readonly fork_json: string }>`
    SELECT fork_json FROM scient_conversation_forks WHERE thread_id = ${threadId}
  `;
  const row = rows[0];
  return row === undefined ? null : yield* decodeFork(row.fork_json);
});
