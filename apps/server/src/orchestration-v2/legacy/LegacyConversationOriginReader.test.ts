import { assert, it } from "@effect/vitest";
import { OrchestrationConversationImport, MessageId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import {
  readInheritedTurnIds,
  toConversationImportMarker,
} from "./LegacyConversationOriginReader.ts";
import {
  makeForkLineageQueries,
  toForkLineageMarker,
  importMarkerField,
} from "./LegacyForkLineageReader.ts";

const now = "2026-01-01T00:00:00.000Z";
const origin = {
  source: "scic" as const,
  exportId: "external-export",
  sourceThreadId: "external-thread",
  packageDigest: `sha256:${"a".repeat(64)}`,
  sourceFormat: "scient.conversation-file",
  sourceFormatVersion: 1,
  importedAt: now,
  omissions: [{ _tag: "range-truncated" as const, throughMessageN: 2 }],
};
const encodeOrigin = Schema.encodeEffect(Schema.fromJsonString(OrchestrationConversationImport));

it("keeps unreadable persisted origins absent without guessing provenance", () => {
  for (const json of [undefined, null, "{}", "not json", '{"source":"unknown"}']) {
    assert.isNull(toConversationImportMarker(json));
  }
  assert.isNull(toForkLineageMarker(undefined));
  assert.deepEqual(importMarkerField(undefined), {});
});

it.layer(SqlitePersistenceMemory)("persisted conversation origin readers", (it) => {
  it.effect("keeps direct import provenance separate from local fork lineage", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const threadId = ThreadId.make("reader-import");
      const json = yield* encodeOrigin(origin);
      yield* sql`INSERT INTO scient_context_transfers (thread_id, type, source_thread_id, source_point_json, status, inherited_turn_ids_json, origin_json, created_at, updated_at)
        VALUES (${threadId}, 'import', NULL, '{}', 'pending', '["first","second"]', ${json}, ${now}, ${now})`;
      const row = yield* makeForkLineageQueries(sql).getForkLineageRowByThread({ threadId });
      assert.ok(Option.isSome(row));
      assert.isNull(toForkLineageMarker(row.value));
      assert.deepEqual(importMarkerField(row.value), { conversationImport: origin });
      assert.deepEqual([...(yield* readInheritedTurnIds(sql, threadId))], ["first", "second"]);
      assert.deepEqual([...(yield* readInheritedTurnIds(sql, "unrelated"))], []);
    }),
  );

  it.effect(
    "retains local fork identity and source omissions without exporting inherited turn ids",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const threadId = ThreadId.make("reader-fork");
        yield* sql`INSERT INTO scient_thread_lineage (thread_id, forked_from_thread_id, fork_point_turn_id, fork_point_turn_count, source_checkpoint_turn_count,
        baseline_turn_id, baseline_user_message_id, baseline_assistant_message_id, workspace_mode, provider_mode,
        provider_bootstrap_status, attachment_copies_json, copied_boundaries_json, fidelity_mode, status,
        checkpoint_status, workspace_status, attempt_count, last_error, inherited_turn_ids_json, created_at, updated_at)
        VALUES (${threadId}, 'local-source', NULL, 1, NULL, 'baseline', 'question', 'answer', 'shared', 'transcript-bootstrap',
          'pending', '[]', '[]', 'transcript-bootstrap', 'pending', 'pending', 'pending', 0, NULL, '["first","baseline","first"]', ${now}, ${now})`;
        const json = yield* encodeOrigin({ ...origin, inheritedTurnIds: [] });
        yield* sql`INSERT INTO scient_context_transfers (thread_id, type, source_thread_id, source_point_json, status, inherited_turn_ids_json, origin_json, created_at, updated_at)
        VALUES (${threadId}, 'fork', 'local-source', '{}', 'pending', '[]', ${json}, ${now}, ${now})`;
        const row = yield* makeForkLineageQueries(sql).getForkLineageRowByThread({ threadId });
        assert.ok(Option.isSome(row));
        assert.deepEqual(toForkLineageMarker(row.value), {
          originThreadId: ThreadId.make("local-source"),
          baselineAssistantMessageId: MessageId.make("answer"),
          sourceImport: origin,
        });
        assert.deepEqual(importMarkerField(row.value), {});
        assert.deepEqual([...(yield* readInheritedTurnIds(sql, threadId))], ["first", "baseline"]);
        yield* sql`UPDATE scient_thread_lineage SET inherited_turn_ids_json = 'invalid' WHERE thread_id = ${threadId}`;
        assert.deepEqual([...(yield* readInheritedTurnIds(sql, threadId))], ["baseline"]);
        yield* sql`UPDATE scient_context_transfers SET origin_json = '{}' WHERE thread_id = ${threadId}`;
        const malformed = yield* makeForkLineageQueries(sql).getForkLineageRowByThread({
          threadId,
        });
        assert.ok(Option.isSome(malformed));
        assert.deepEqual(toForkLineageMarker(malformed.value), {
          originThreadId: ThreadId.make("local-source"),
          baselineAssistantMessageId: MessageId.make("answer"),
        });
      }),
  );
});
