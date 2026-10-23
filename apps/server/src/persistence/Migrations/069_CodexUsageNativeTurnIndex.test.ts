import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
it.effect("indexes batched Codex native turns without discarding duplicate candidates", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 68 });
    for (const [id, driver, nativeId] of [
      ["match", "codex", "requested"],
      ["duplicate", "codex", "requested"],
      ["second", "codex", "requested-second"],
      ["other-provider", "claudeAgent", "requested"],
      ["unrelated", "codex", "unrelated"],
    ] as const) {
      yield* sql`INSERT INTO orchestration_v2_projection_run_attempts ${sql.insert({
        attempt_id: `attempt-${id}`,
        thread_id: `thread-${id}`,
        run_id: `run-${id}`,
        attempt_ordinal: 1,
        root_node_id: `node-${id}`,
        provider: driver,
        provider_thread_id: `provider-thread-${id}`,
        status: "completed",
        payload_json: "{}",
      })}`;
      yield* sql`INSERT INTO orchestration_v2_projection_provider_turns ${sql.insert({
        provider_turn_id: `turn-${id}`,
        thread_id: `thread-${id}`,
        provider_thread_id: `provider-thread-${id}`,
        node_id: `node-${id}`,
        run_attempt_id: `attempt-${id}`,
        ordinal: 1,
        status: "completed",
        payload_json: encodeJson({ nativeTurnRef: { driver, nativeId, strength: "strong" } }),
      })}`;
    }
    const lookup = sql<{ readonly provider_turn_id: string }>`
      SELECT turn.provider_turn_id
      FROM orchestration_v2_projection_provider_turns AS turn
      JOIN orchestration_v2_projection_run_attempts AS attempt
        ON attempt.attempt_id = turn.run_attempt_id
        AND attempt.thread_id = turn.thread_id
        AND attempt.provider_thread_id = turn.provider_thread_id
      WHERE json_extract(turn.payload_json, '$.nativeTurnRef.driver') = 'codex'
        AND json_extract(turn.payload_json, '$.nativeTurnRef.nativeId') IN (
          SELECT value FROM json_each(${encodeJson(["requested", "requested-second", "missing"])})
        )
    `;
    const before = (yield* lookup).map((row) => row.provider_turn_id).toSorted();
    assert.deepStrictEqual(before, ["turn-duplicate", "turn-match", "turn-second"]);
    yield* runMigrations();
    assert.deepStrictEqual((yield* lookup).map((row) => row.provider_turn_id).toSorted(), before);

    const [statement, parameters] = lookup.compile();
    const plan = yield* sql.unsafe<{ readonly detail: string }>(
      `EXPLAIN QUERY PLAN ${statement}`,
      parameters,
    );
    assert.isTrue(
      plan.some(({ detail }) =>
        /SEARCH turn USING INDEX orchestration_v2_provider_turns_codex_native_id_idx\b/.test(
          detail,
        ),
      ),
      plan.map(({ detail }) => detail).join("\n"),
    );
    assert.isFalse(plan.some(({ detail }) => /SCAN turn\b/.test(detail)));
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
