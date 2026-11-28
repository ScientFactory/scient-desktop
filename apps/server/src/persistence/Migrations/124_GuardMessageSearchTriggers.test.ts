import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as SqlClient from "effect/sql/SqlClient";
import { runMigrations } from "../Migrations.ts";

it.effect("refreshes installed search triggers on a profile already at migration 123", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 123 });

    // Restore the shipped insert definition: pre-guard triggers had no json_valid predicates.
    const [trigger] = yield* sql<{ sql: string }>`
      SELECT sql FROM sqlite_master WHERE name = 'orchestration_v2_message_search_insert'
    `;
    yield* sql`DROP TRIGGER orchestration_v2_message_search_insert`;
    yield* sql.unsafe(
      trigger!.sql
        .replace(/^\s*WHEN NOT json_valid\(new\.payload_json\) THEN NULL\s*$/mu, "")
        .replace(/^\s*AND json_valid\((new|subagent_threads)\.payload_json\)\s*$/gmu, ""),
    );
    const time = "2026-11-28T00:00:00.000Z";
    const insertThread = (id: string, payload: string) => sql`
      INSERT INTO orchestration_v2_projection_threads (
        thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
        created_at, updated_at, payload_json)
      VALUES (${id}, 'project-1', 'Thread', 'codex', 'full-access', 'default',
        ${time}, ${time}, ${payload})
    `;
    const insertMessage = (id: string, thread: string) => sql`
      INSERT INTO orchestration_v2_projection_messages
        (message_id, thread_id, role, streaming, created_at, updated_at, payload_json)
      VALUES (${id}, ${thread}, 'assistant', 0, ${time}, ${time}, '{"text":"needle"}')
    `;
    yield* insertThread("valid", "{}");
    yield* insertMessage("original", "valid");
    yield* insertThread("unreadable", "{not json");
    assert.isTrue(Result.isFailure(yield* Effect.result(insertMessage("new", "unreadable"))));

    assert.deepEqual(yield* runMigrations(), [[124, "GuardMessageSearchTriggers"]]);
    yield* insertMessage("new", "unreadable");
    assert.deepEqual(
      yield* sql`
        SELECT messages.message_id FROM orchestration_v2_message_search AS search
        JOIN orchestration_v2_projection_messages AS messages ON messages.rowid = search.rowid
        WHERE orchestration_v2_message_search MATCH 'needle'
        ORDER BY messages.message_id
      `,
      [{ message_id: "new" }, { message_id: "original" }],
    );
    assert.deepEqual(yield* runMigrations(), []);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
