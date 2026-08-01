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

  it.effect("uses opaque scoped cursors, validates anchors, and truncates in SQL", () =>
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
          ('boundary-1', 'thread-boundary', NULL, 'assistant', 'one-long', 0, '2026-01-01T00:00:01.000Z', '2026-01-01T00:00:01.000Z')
      `;
      const query = yield* makeExternalIntegrationThreadReadQuery;
      const newest = yield* query.readPage({
        projectId: "project-1",
        threadId: "thread-boundary",
        messageLimit: 1,
        maxMessageChars: 3,
      });
      assert.deepEqual(newest.messages, [
        {
          index: 1,
          role: "assistant",
          text: "one",
          truncated: true,
          createdAt: "2026-01-01T00:00:01.000Z",
        },
      ]);
      assert.isNotNull(newest.nextCursor);
      const oldest = yield* query.readPage({
        projectId: "project-1",
        threadId: "thread-boundary",
        cursor: newest.nextCursor!,
        messageLimit: 1,
      });
      assert.deepEqual(
        oldest.messages.map(({ index, text }) => [index, text]),
        [[0, "zero"]],
      );
      assert.isNull(oldest.nextCursor);

      const decoded = JSON.parse(Buffer.from(newest.nextCursor!, "base64url").toString("utf8")) as [
        number,
        string,
        string,
        string,
      ];
      const missingAnchor = Buffer.from(
        JSON.stringify([decoded[0], decoded[1], decoded[2], "missing-message"]),
        "utf8",
      ).toString("base64url");

      for (const cursor of ["", "not-base64!", `${newest.nextCursor!}A`, missingAnchor]) {
        const result = yield* query
          .readPage({ projectId: "project-1", threadId: "thread-boundary", cursor })
          .pipe(Effect.match({ onFailure: (error) => error, onSuccess: () => null }));
        assert.instanceOf(result, ExternalIntegrationThreadReadError, cursor);
        if (result instanceof ExternalIntegrationThreadReadError) {
          assert.strictEqual(result.code, "invalid_cursor", cursor);
        }
      }

      const wrongScope = yield* query
        .readPage({
          projectId: "project-1",
          threadId: "another-thread",
          cursor: newest.nextCursor!,
        })
        .pipe(Effect.match({ onFailure: (error) => error, onSuccess: () => null }));
      assert.instanceOf(wrongScope, ExternalIntegrationThreadReadError);
      if (wrongScope instanceof ExternalIntegrationThreadReadError) {
        assert.strictEqual(wrongScope.code, "invalid_cursor");
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

  it.effect("does not skip or duplicate original messages after a late earlier import", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, model_selection_json, branch,
          worktree_path, latest_turn_id, created_at, updated_at, deleted_at
        ) VALUES (
          'thread-late-import', 'project-1', 'Late import',
          '{"provider":"codex","model":"gpt-5-codex"}', NULL,
          NULL, NULL, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', NULL
        )
      `;
      yield* sql`
        INSERT INTO projection_thread_messages (
          message_id, thread_id, turn_id, role, text, is_streaming, created_at, updated_at
        ) VALUES
          ('original-0', 'thread-late-import', NULL, 'assistant', 'original-0', 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
          ('original-1', 'thread-late-import', NULL, 'assistant', 'original-1', 0, '2026-01-01T00:00:01.000Z', '2026-01-01T00:00:01.000Z'),
          ('original-2', 'thread-late-import', NULL, 'assistant', 'original-2', 0, '2026-01-01T00:00:02.000Z', '2026-01-01T00:00:02.000Z'),
          ('original-3', 'thread-late-import', NULL, 'assistant', 'original-3', 0, '2026-01-01T00:00:03.000Z', '2026-01-01T00:00:03.000Z'),
          ('original-4', 'thread-late-import', NULL, 'assistant', 'original-4', 0, '2026-01-01T00:00:04.000Z', '2026-01-01T00:00:04.000Z')
      `;
      const query = yield* makeExternalIntegrationThreadReadQuery;
      const first = yield* query.readPage({
        projectId: "project-1",
        threadId: "thread-late-import",
        messageLimit: 2,
      });
      assert.strictEqual(first.totalMessages, 5);
      assert.deepEqual(
        first.messages.map(({ text }) => text),
        ["original-3", "original-4"],
      );

      yield* sql`
        INSERT INTO projection_thread_messages (
          message_id, thread_id, turn_id, role, text, is_streaming, created_at, updated_at
        ) VALUES (
          'late-import', 'thread-late-import', NULL, 'assistant', 'late-import', 0,
          '2026-01-01T00:00:00.500Z', '2026-01-01T00:00:00.500Z'
        )
      `;

      let cursor = first.nextCursor;
      const pages = [first.messages.map(({ text }) => text)];
      while (cursor !== null) {
        const page = yield* query.readPage({
          projectId: "project-1",
          threadId: "thread-late-import",
          cursor,
          messageLimit: 2,
        });
        assert.strictEqual(page.totalMessages, 6);
        pages.unshift(page.messages.map(({ text }) => text));
        cursor = page.nextCursor;
      }
      const traversed = pages.flat();
      assert.deepEqual(
        traversed.filter((text) => text.startsWith("original-")),
        ["original-0", "original-1", "original-2", "original-3", "original-4"],
      );
      assert.strictEqual(new Set(traversed).size, traversed.length);
      assert.include(traversed, "late-import");
    }),
  );
});
