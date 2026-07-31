import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import {
  ExternalIntegrationThreadReadError,
  makeExternalIntegrationThreadReadQuery,
} from "./threadReadQuery.ts";

const sqlite = it.layer(SqlitePersistenceMemory);

sqlite("ExternalIntegrationThreadReadQuery", (it) => {
  it.effect("traverses the true history beyond the UI's 2000-message cap in bounded pages", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, model_selection_json, branch,
          worktree_path, latest_turn_id, created_at, updated_at, deleted_at
        ) VALUES (
          'thread-long', 'project-1', 'Long thread',
          '{"provider":"codex","model":"gpt-5-codex"}', NULL,
          NULL, NULL, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', NULL
        )
      `;
      yield* sql`
        WITH RECURSIVE sequence(value) AS (
          SELECT 0
          UNION ALL
          SELECT value + 1 FROM sequence WHERE value < 2104
        )
        INSERT INTO projection_thread_messages (
          message_id, thread_id, turn_id, role, text, is_streaming, created_at, updated_at
        )
        SELECT
          printf('message-%06d', value), 'thread-long', NULL, 'assistant',
          printf('message %d', value), 0,
          printf('2026-01-01T00:%06dZ', value), printf('2026-01-01T00:%06dZ', value)
        FROM sequence
      `;
      const query = yield* makeExternalIntegrationThreadReadQuery;

      let cursor: string | undefined;
      const seen: number[] = [];
      do {
        const page = yield* query.readPage({
          projectId: "project-1",
          threadId: "thread-long",
          ...(cursor === undefined ? {} : { cursor }),
          messageLimit: 100,
        });
        assert.strictEqual(page.totalMessages, 2105);
        assert.isAtMost(page.messages.length, 100);
        seen.unshift(...page.messages.map(({ index }) => index));
        cursor = page.nextCursor ?? undefined;
      } while (cursor !== undefined);

      assert.strictEqual(seen.length, 2105);
      assert.deepEqual(
        seen,
        Array.from({ length: 2105 }, (_, index) => index),
      );
    }),
  );

  it.effect("rejects malformed and out-of-range cursors and handles exact boundaries", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, model_selection_json, branch,
          worktree_path, latest_turn_id, created_at, updated_at, deleted_at
        ) VALUES (
          'thread-boundary', 'project-1', 'Boundary thread',
          '{"provider":"codex","model":"gpt-5-codex"}', NULL,
          NULL, NULL, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', NULL
        )
      `;
      yield* sql`
        INSERT INTO projection_thread_messages (
          message_id, thread_id, turn_id, role, text, is_streaming, created_at, updated_at
        ) VALUES
          ('boundary-0', 'thread-boundary', NULL, 'user', 'zero', 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
          ('boundary-1', 'thread-boundary', NULL, 'assistant', 'one', 0, '2026-01-01T00:00:01.000Z', '2026-01-01T00:00:01.000Z')
      `;
      const query = yield* makeExternalIntegrationThreadReadQuery;
      const atStart = yield* query.readPage({
        projectId: "project-1",
        threadId: "thread-boundary",
        cursor: "0",
      });
      assert.deepEqual(atStart.messages, []);
      assert.isNull(atStart.nextCursor);
      const atEnd = yield* query.readPage({
        projectId: "project-1",
        threadId: "thread-boundary",
        cursor: "2",
        messageLimit: 1000,
      });
      assert.deepEqual(
        atEnd.messages.map(({ index }) => index),
        [0, 1],
      );

      for (const cursor of ["", "01", "-1", "1x", "3", "9007199254740992"]) {
        const result = yield* query
          .readPage({ projectId: "project-1", threadId: "thread-boundary", cursor })
          .pipe(Effect.match({ onFailure: (error) => error, onSuccess: () => null }));
        assert.instanceOf(result, ExternalIntegrationThreadReadError, cursor);
        if (result instanceof ExternalIntegrationThreadReadError) {
          assert.strictEqual(result.code, "invalid_cursor", cursor);
        }
      }

      const crossProject = yield* query
        .readPage({ projectId: "project-other", threadId: "thread-boundary" })
        .pipe(Effect.match({ onFailure: (error) => error, onSuccess: () => null }));
      assert.instanceOf(crossProject, ExternalIntegrationThreadReadError);
      if (crossProject instanceof ExternalIntegrationThreadReadError) {
        assert.strictEqual(crossProject.code, "thread_not_found");
      }
    }),
  );
});
