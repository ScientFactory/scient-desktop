import { assert, it } from "@effect/vitest";
import { EventId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import * as EventStore from "../EventStore.ts";
import * as EventSink from "../EventSink.ts";
import * as ProjectionStore from "../ProjectionStore.ts";
import * as ProjectionMaintenance from "../ProjectionMaintenance.ts";
import * as LegacyV1ThreadImporter from "./LegacyV1ThreadImporter.ts";

const stores = Layer.mergeAll(EventStore.layer, ProjectionStore.layer).pipe(
  Layer.provideMerge(SqlitePersistenceMemory),
);
const sink = EventSink.layer.pipe(Layer.provideMerge(stores));
const importer = LegacyV1ThreadImporter.layer.pipe(Layer.provideMerge(sink));
const TestLayer = Layer.mergeAll(importer, ProjectionMaintenance.layer.pipe(Layer.provide(sink)));
const THREAD = ThreadId.make("migration-history");
const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at)
    VALUES ('history-project', 'History', '/tmp/history', '[]', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`;
  yield* sql`INSERT INTO projection_threads (thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode, created_at, updated_at)
    VALUES (${THREAD}, 'history-project', 'History', '{"instanceId":"codex","model":"gpt-5.4"}', 'full-access', 'default', '2026-01-01T00:00:00.000Z', '2026-01-08T00:00:00.000Z')`;
  yield* sql`INSERT INTO projection_thread_messages (message_id, thread_id, role, text, is_streaming, created_at, updated_at)
    VALUES ('question', ${THREAD}, 'user', 'Explain the result', 0, '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z'),
      ('answer', ${THREAD}, 'assistant', 'The result is 42', 0, '2026-01-08T00:00:00.000Z', '2026-01-08T00:00:00.000Z'),
      ('system-note', ${THREAD}, 'system', 'Imported instructions are historical', 0, '2026-01-03T00:00:00.000Z', '2026-01-03T00:00:00.000Z')`;
  yield* sql`INSERT INTO projection_thread_activities (activity_id, thread_id, tone, kind, summary, payload_json, sequence, created_at)
    VALUES ('tool-call', ${THREAD}, 'tool', 'tool.completed', 'Read data.csv', '{"toolName":"read_file","input":{"path":"data.csv"},"output":"42"}', 7, '2026-01-04T00:00:00.000Z')`;
  yield* sql`INSERT INTO projection_pending_approvals (request_id, thread_id, status, decision, created_at, resolved_at)
    VALUES ('old-pending', ${THREAD}, 'pending', NULL, '2026-01-05T00:00:00.000Z', NULL),
      ('old-approved', ${THREAD}, 'resolved', 'accept', '2026-01-05T12:00:00.000Z', '2026-01-06T00:00:00.000Z')`;
  yield* sql`INSERT INTO projection_thread_proposed_plans (plan_id, thread_id, plan_markdown, created_at, updated_at)
    VALUES ('old-plan', ${THREAD}, '# Historical plan\n\nRead the dataset.', '2026-01-07T00:00:00.000Z', '2026-01-07T00:00:00.000Z')`;
});

it.effect("preserves ordered historical artifacts without restoring approval authority", () =>
  Effect.gen(function* () {
    yield* seed;
    const migration = yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    yield* migration.reconcileShells;
    yield* migration.ensureTranscript(THREAD);
    const projection = yield* projections.getThreadProjection(THREAD);
    assert.deepEqual(
      projection.turnItems.map((item) => item.title ?? item.type),
      [
        "user_message",
        "Historical system message",
        "Read data.csv",
        "Historical approval",
        "Historical approval",
        "Historical proposed plan",
        "assistant_message",
      ],
    );
    const tool = projection.turnItems.find(
      (item) => item.type === "dynamic_tool" && item.toolName === "read_file",
    );
    assert.isDefined(tool);
    if (tool?.type !== "dynamic_tool") return assert.fail("Missing historical tool");
    assert.deepEqual(tool.input, {
      activityId: "tool-call",
      turnId: null,
      tone: "tool",
      kind: "tool.completed",
      summary: "Read data.csv",
      sequence: 7,
      payload: { toolName: "read_file", input: { path: "data.csv" }, output: "42" },
    });
    assert.equal(tool.output, "42");
    const plan = projection.turnItems.find((item) => item.type === "proposed_plan");
    if (plan?.type !== "proposed_plan") return assert.fail("Missing historical plan");
    assert.equal(plan.markdown, "# Historical plan\n\nRead the dataset.");
    assert.equal(plan.runId, null);
    const artifact = projection.plans.find((entry) => entry.id === plan.planId);
    assert.equal(artifact?.status, "active");
    assert.equal(artifact?.nodeId, plan.nodeId);
    assert.equal(projection.nodes.find((node) => node.id === plan.nodeId)?.countsForRun, false);
    assert.deepEqual(projection.runtimeRequests, []);
    assert.deepEqual(projection.runs, []);
    assert.deepEqual(projection.providerSessions, []);
    const approvals = projection.turnItems.filter(
      (item) => item.type === "dynamic_tool" && item.toolName === "historical_approval",
    );
    assert.deepEqual(
      approvals.map((item) => item.status),
      ["interrupted", "completed"],
    );
    yield* migration.ensureTranscript(THREAD);
    yield* migration.reconcileShells;
    assert.deepEqual(
      (yield* projections.getThreadProjection(THREAD)).turnItems,
      projection.turnItems,
    );
    const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
    yield* maintenance.rebuild;
    assert.deepEqual(
      (yield* projections.getThreadProjection(THREAD)).turnItems,
      projection.turnItems,
    );
  }).pipe(Effect.provide(TestLayer)),
);

it.effect(
  "preserves implemented plans as completed artifacts across repeat import and replay",
  () =>
    Effect.gen(function* () {
      yield* seed;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE projection_thread_proposed_plans SET implemented_at = '2026-01-08T00:00:00.000Z'
      WHERE thread_id = ${THREAD}`;
      const migration = yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      yield* migration.reconcileShells;
      yield* migration.ensureTranscript(THREAD);
      const before = yield* projections.getThreadProjection(THREAD);
      assert.equal(before.plans.length, 1);
      assert.equal(before.plans[0]?.status, "completed");
      assert.equal(before.plans[0]?.runId, null);
      assert.equal(before.nodes[0]?.runtimeRequestId, null);
      yield* migration.ensureTranscript(THREAD);
      const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
      yield* maintenance.rebuild;
      const after = yield* projections.getThreadProjection(THREAD);
      assert.deepEqual(after.plans, before.plans);
      assert.deepEqual(after.nodes, before.nodes);
      assert.deepEqual(after.runtimeRequests, []);
      assert.deepEqual(after.runs, []);
    }).pipe(Effect.provide(TestLayer)),
);

it.effect("upgrades a completed message-only import without overwriting V2 edits", () =>
  Effect.gen(function* () {
    yield* seed;
    const sql = yield* SqlClient.SqlClient;
    const migration = yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const sink = yield* EventSink.EventSinkV2;
    yield* migration.reconcileShells;
    const shell = yield* projections.getThreadProjection(THREAD);
    const answer = shell.turnItems.find((item) => item.type === "assistant_message");
    if (answer?.type !== "assistant_message") return assert.fail("Missing shell answer");
    yield* sql`DELETE FROM orchestration_v2_turn_item_positions WHERE thread_id = ${THREAD} AND turn_item_id LIKE 'migration:v1:history:%'`;
    yield* sql`UPDATE orchestration_v2_turn_item_positions SET ordinal = 2 WHERE turn_item_id = ${answer.id}`;
    yield* sink.write({
      events: [
        {
          id: EventId.make("v2-edit"),
          type: "turn-item.updated",
          threadId: THREAD,
          occurredAt: answer.updatedAt,
          payload: { ...answer, text: "Edited in V2", ordinal: 2 },
        },
      ],
    });
    yield* sql`UPDATE orchestration_v2_legacy_imports SET transcript_imported_at = '2026-02-01T00:00:00.000Z' WHERE thread_id = ${THREAD}`;
    yield* migration.ensureTranscript(THREAD);
    const migrated = yield* projections.getThreadProjection(THREAD);
    assert.deepEqual(
      migrated.turnItems.map((item) => item.ordinal),
      [1, 2, 3, 4, 5, 6, 7],
    );
    assert.equal(migrated.turnItems[6]?.type, "assistant_message");
    assert.equal(
      migrated.turnItems[6]?.type === "assistant_message" ? migrated.turnItems[6].text : null,
      "Edited in V2",
    );
    const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
    yield* maintenance.rebuild;
    assert.deepEqual(
      (yield* projections.getThreadProjection(THREAD)).turnItems,
      migrated.turnItems,
    );
  }).pipe(Effect.provide(TestLayer)),
);

it.effect(
  "resumes after a committed history batch without duplicates or a premature completion marker",
  () =>
    Effect.gen(function* () {
      yield* seed;
      const sql = yield* SqlClient.SqlClient;
      const migration = yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const bulkIds = Array.from(
        { length: 99 },
        (_, index) => `bulk-${String(index).padStart(3, "0")}`,
      );
      for (const activityId of bulkIds) {
        yield* sql`INSERT INTO projection_thread_activities (activity_id, thread_id, tone, kind, summary, payload_json, sequence, created_at)
        VALUES (${activityId}, ${THREAD}, 'tool', 'tool.completed', ${activityId}, '{"toolName":"read_file"}', 8, '2026-01-06T00:00:00.000Z')`;
      }
      yield* sql`INSERT INTO projection_thread_activities (activity_id, thread_id, tone, kind, summary, payload_json, sequence, created_at)
      VALUES ('zz-last', ${THREAD}, 'tool', 'tool.completed', 'Last activity', '{}', 9, '2026-01-10T00:00:00.000Z')`;
      const expectedIds = [
        "migration:v1:turn-item:question",
        "migration:v1:history:system:system-note",
        "migration:v1:history:activity:tool-call",
        "migration:v1:history:approval:old-pending",
        "migration:v1:history:approval:old-approved",
        ...bulkIds.map((id) => `migration:v1:history:activity:${id}`),
        "migration:v1:history:plan:old-plan",
        "migration:v1:turn-item:answer",
        "migration:v1:history:activity:zz-last",
      ];
      yield* migration.reconcileShells;
      yield* sql`CREATE TRIGGER reject_history BEFORE INSERT ON orchestration_events
      WHEN NEW.event_id = 'migration:v1:history:activity:zz-last'
      BEGIN SELECT RAISE(ABORT, 'synthetic interrupted history write'); END`;
      const failed = yield* Effect.exit(migration.ensureTranscript(THREAD));
      assert.equal(failed._tag, "Failure");
      const marker = yield* sql<{
        transcript_imported_at: string | null;
      }>`SELECT transcript_imported_at FROM orchestration_v2_legacy_imports WHERE thread_id = ${THREAD}`;
      assert.equal(marker[0]?.transcript_imported_at, null);
      assert.deepEqual(
        (yield* projections.getThreadProjection(THREAD)).turnItems.map((item) => item.id),
        [...expectedIds.slice(0, 101), "migration:v1:turn-item:answer"],
      );
      yield* sql`DROP TRIGGER reject_history`;
      yield* migration.ensureTranscript(THREAD);
      const projection = yield* projections.getThreadProjection(THREAD);
      assert.deepEqual(
        projection.turnItems.map((item) => item.id),
        expectedIds,
      );
      assert.deepEqual(
        projection.turnItems.map((item) => item.ordinal),
        expectedIds.map((_, index) => index + 1),
      );
      yield* migration.ensureTranscript(THREAD);
      assert.deepEqual(
        (yield* projections.getThreadProjection(THREAD)).turnItems,
        projection.turnItems,
      );
    }).pipe(Effect.provide(TestLayer)),
);

it.effect(
  "reports corrupt historical payloads without changing the source or confirming completion",
  () =>
    Effect.gen(function* () {
      yield* seed;
      const sql = yield* SqlClient.SqlClient;
      const migration = yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter;
      yield* sql`UPDATE projection_thread_activities SET payload_json = 'not-json' WHERE activity_id = 'tool-call'`;
      yield* migration.reconcileShells;
      assert.equal((yield* Effect.exit(migration.ensureTranscript(THREAD)))._tag, "Failure");
      const source = yield* sql<{
        payload_json: string;
      }>`SELECT payload_json FROM projection_thread_activities WHERE activity_id = 'tool-call'`;
      assert.equal(source[0]?.payload_json, "not-json");
      const marker = yield* sql<{
        transcript_imported_at: string | null;
      }>`SELECT transcript_imported_at FROM orchestration_v2_legacy_imports WHERE thread_id = ${THREAD}`;
      assert.equal(marker[0]?.transcript_imported_at, null);
    }).pipe(Effect.provide(TestLayer)),
);

const seedLineage = (parent: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO projection_threads (thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode, created_at, updated_at)
    SELECT 'ancestor', project_id, 'Ancestor', model_selection_json, runtime_mode, interaction_mode, created_at, updated_at FROM projection_threads WHERE thread_id = ${THREAD}`;
    yield* sql`INSERT INTO scient_thread_lineage (
    thread_id, forked_from_thread_id, fork_point_turn_id, fork_point_turn_count, source_checkpoint_turn_count,
    baseline_turn_id, baseline_user_message_id, baseline_assistant_message_id, workspace_mode, provider_mode,
    provider_bootstrap_status, attachment_copies_json, copied_boundaries_json, fidelity_mode, status,
    checkpoint_status, workspace_status, attempt_count, last_error, created_at, updated_at)
    VALUES (${THREAD}, ${parent}, NULL, 1, NULL, 'old-turn', 'question', 'answer', 'shared', 'transcript-bootstrap',
      'pending', '[]', '[]', 'transcript-bootstrap', 'pending', 'pending', 'pending', 0, NULL,
      '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`;
  });

it.effect("retains fork ancestry and boundary markers without provider-native authority", () =>
  Effect.gen(function* () {
    yield* seed;
    yield* seedLineage("ancestor");
    const migration = yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    yield* migration.reconcileShells;
    yield* migration.ensureTranscript(THREAD);
    const projection = yield* projections.getThreadProjection(THREAD);
    assert.equal(projection.thread.lineage.parentThreadId, "ancestor");
    assert.equal(projection.thread.lineage.rootThreadId, "ancestor");
    assert.equal(projection.thread.forkLineage?.baselineAssistantMessageId, "answer");
    assert.equal(projection.thread.historyOrigin, "v1_import");
    assert.equal(projection.thread.activeProviderThreadId, null);
    assert.equal(projection.thread.forkedFrom, null);
    assert.deepEqual(projection.providerThreads, []);
    assert.deepEqual(projection.providerSessions, []);
  }).pipe(Effect.provide(TestLayer)),
);

it.effect("refuses cyclic lineage instead of inventing a repaired root", () =>
  Effect.gen(function* () {
    yield* seed;
    yield* seedLineage(THREAD);
    const migration = yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter;
    const sql = yield* SqlClient.SqlClient;
    assert.equal((yield* Effect.exit(migration.reconcileShells))._tag, "Failure");
    const shell =
      yield* sql`SELECT thread_id FROM orchestration_v2_projection_threads WHERE thread_id = ${THREAD}`;
    assert.deepEqual(shell, []);
    const source = yield* sql<{
      forked_from_thread_id: string;
    }>`SELECT forked_from_thread_id FROM scient_thread_lineage WHERE thread_id = ${THREAD}`;
    assert.equal(source[0]?.forked_from_thread_id, THREAD);
  }).pipe(Effect.provide(TestLayer)),
);
