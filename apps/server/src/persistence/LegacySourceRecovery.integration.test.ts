// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { EventId, ProviderThreadId, ThreadId } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as Importer from "../orchestration-v2/legacy/LegacyV1ThreadImporter.ts";
import { runMigrations } from "./Migrations.ts";
import * as Persistence from "./Sqlite.ts";

const THREAD = ThreadId.make("continued-v1");

it.effect.each([false, true])(
  "reconciles newer history, preserves conflicting V2 edits, and retries a committed batch (compacted=%s)",
  (compacted) => {
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "scient-source-recovery-"));
    const sourcePath = NodePath.join(directory, "state.sqlite");
    const destinationPath = NodePath.join(directory, "statev2.sqlite");
    return Effect.gen(function* () {
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 52 });
        yield* sql`INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at)
          VALUES ('project', 'Project', '/tmp/project', '[]', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`;
        yield* sql`INSERT INTO projection_threads (thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode, created_at, updated_at)
          VALUES (${THREAD}, 'project', 'Snapshot title', '{"instanceId":"codex","model":"gpt-5.4"}', 'full-access', 'default', '2026-01-01T00:00:00.000Z', '2026-01-06T00:00:00.000Z')`;
        yield* sql`INSERT INTO projection_thread_messages (message_id, thread_id, role, text, is_streaming, created_at, updated_at)
          VALUES ('question', ${THREAD}, 'user', 'Original question', 0, '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z'),
            ('answer', ${THREAD}, 'assistant', 'Snapshot answer', 0, '2026-01-06T00:00:00.000Z', '2026-01-06T00:00:00.000Z')`;
        yield* sql`INSERT INTO projection_thread_activities (activity_id, thread_id, tone, kind, summary, payload_json, sequence, created_at)
          VALUES ('tool-start', ${THREAD}, 'tool', 'tool.started', 'Read data', '{"toolCallId":"call","toolName":"read_file","input":{"path":"data.csv"}}', 1, '2026-01-03T00:00:00.000Z')`;
        yield* sql`INSERT INTO projection_thread_proposed_plans (plan_id, thread_id, plan_markdown, created_at, updated_at)
          VALUES ('plan', ${THREAD}, '# Snapshot plan', '2026-01-04T00:00:00.000Z', '2026-01-04T00:00:00.000Z')`;
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: sourcePath })));
      const config = yield* ServerConfig.ServerConfig;
      const database = Persistence.layerConfig.pipe(
        Layer.provide(ServerConfig.layer({ ...config, dbPath: destinationPath })),
      );
      const stores = Layer.mergeAll(EventStore.layer, ProjectionStore.layer).pipe(
        Layer.provideMerge(database),
      );
      const sinkLayer = EventSink.layer.pipe(Layer.provideMerge(stores));
      const importerLayer = Importer.layer.pipe(Layer.provideMerge(sinkLayer));
      yield* Effect.gen(function* () {
        const importer = yield* Importer.LegacyV1ThreadImporter;
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        const sink = yield* EventSink.EventSinkV2;
        const sql = yield* SqlClient.SqlClient;
        yield* importer.reconcileShells;
        yield* importer.ensureTranscript(THREAD);
        const initial = yield* projections.getThreadProjection(THREAD);
        const answer = initial.messages.find((message) => message.id === "answer")!;
        const plan = initial.plans.find((plan) => plan.id === "plan")!;
        if (plan.kind !== "proposed_plan") return assert.fail("Expected historical proposed plan");
        yield* sink.write({
          events: [
            {
              id: EventId.make("v2-edited-title"),
              type: "thread.metadata-updated",
              threadId: THREAD,
              occurredAt: initial.thread.updatedAt,
              payload: {
                ...initial.thread,
                title: "V2 title",
                activeProviderThreadId: ProviderThreadId.make("native-v2-owner"),
              },
            },
            {
              id: EventId.make("v2-edited-answer"),
              type: "message.updated",
              threadId: THREAD,
              occurredAt: answer.updatedAt,
              payload: { ...answer, text: "V2 edited answer" },
            },
            {
              id: EventId.make("v2-edited-plan"),
              type: "plan.updated",
              threadId: THREAD,
              occurredAt: initial.thread.updatedAt,
              payload: { ...plan, markdown: "# V2 edited plan" },
            },
          ],
        });
        if (compacted)
          yield* sql`DELETE FROM orchestration_events WHERE application_event_version = 2 AND
          (event_id LIKE 'migration:v1:message:%' OR event_id LIKE 'migration:v1:turn-item:%' OR event_id LIKE 'migration:v1:history:%')`;
      }).pipe(Effect.provide(importerLayer));

      const source = new NodeSqlite.DatabaseSync(sourcePath);
      try {
        source.exec(`UPDATE projection_threads SET title = 'New V1 title', archived_at = '2026-02-01T00:00:00.000Z', model_selection_json = '{"instanceId":"claude","model":"claude-sonnet-4-6"}', updated_at = '2026-02-01T00:00:00.000Z';
          UPDATE projection_thread_messages SET text = 'New V1 question', updated_at = '2026-02-01T00:00:00.000Z' WHERE message_id = 'question';
          UPDATE projection_thread_messages SET text = 'New V1 answer', updated_at = '2026-02-01T00:00:01.000Z' WHERE message_id = 'answer';
          UPDATE projection_thread_proposed_plans SET plan_markdown = '# New V1 plan', updated_at = '2026-02-01T00:00:00.000Z';
          INSERT INTO projection_thread_activities (activity_id, thread_id, tone, kind, summary, payload_json, sequence, created_at)
            VALUES ('tool-end', 'continued-v1', 'tool', 'tool.completed', 'Read data', '{"toolCallId":"call","toolName":"read_file","output":"result"}', 2, '2026-01-03T00:00:01.000Z');
          INSERT INTO projection_thread_messages (message_id, thread_id, role, text, attachments_json, is_streaming, created_at, updated_at)
            VALUES ('later-user', 'continued-v1', 'user', 'Later question', '[{"type":"image","id":"image","name":"plot.png","mimeType":"image/png","sizeBytes":100}]', 0, '2026-02-02T00:00:00.000Z', '2026-02-02T00:00:00.000Z');`);
      } finally {
        source.close();
      }
      const originalBytes = NodeFS.readFileSync(sourcePath);

      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const sink = yield* EventSink.EventSinkV2;
        const interruptedSink = EventSink.EventSinkV2.of({
          ...sink,
          write: (input) =>
            Effect.gen(function* () {
              const result = yield* sink.write(input);
              if (result.some((stored) => stored.event.type === "message.updated"))
                return yield* new EventSink.EventSinkWriteError({
                  eventCount: result.length,
                  cause: new Error("Simulated interruption after commit"),
                });
              return result;
            }),
        });
        const restore = Effect.gen(function* () {
          yield* (yield* Importer.LegacyV1ThreadImporter).ensureTranscript(THREAD);
        }).pipe(
          Effect.provide(Layer.fresh(Importer.layer)),
          Effect.provideService(EventSink.EventSinkV2, interruptedSink),
        );
        assert.equal((yield* Effect.result(restore))._tag, "Failure");
        assert.equal(
          (yield* sql`SELECT transcript_imported_at FROM orchestration_v2_legacy_imports`)[0]
            ?.transcript_imported_at,
          null,
        );
        assert.isAbove(
          (yield* sql<{
            n: number;
          }>`SELECT count(*) AS n FROM scient_legacy_reconciliation_changes WHERE resolved = 0`)[0]!
            .n,
          0,
        );
        const projection = yield* (yield* ProjectionStore.ProjectionStoreV2).getThreadProjection(
          THREAD,
        );
        const question = projection.messages.find((message) => message.id === "question")!;
        yield* sink.write({
          events: [
            {
              id: EventId.make("v2-edit-before-retry"),
              type: "message.updated",
              threadId: THREAD,
              occurredAt: question.updatedAt,
              payload: { ...question, text: "V2 edit during restoration" },
            },
          ],
        });
      }).pipe(Effect.provide(sinkLayer));

      yield* Effect.gen(function* () {
        const importer = yield* Importer.LegacyV1ThreadImporter;
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        yield* importer.ensureTranscript(THREAD);
        assert.equal(yield* importer.pendingThreadCount, 0);
        const restored = yield* projections.getThreadProjection(THREAD);
        assert.equal(restored.thread.title, "V2 title");
        assert.equal(restored.thread.archivedAt, null);
        assert.equal(restored.thread.activeProviderThreadId, "native-v2-owner");
        assert.equal(restored.thread.providerInstanceId, "codex");
        assert.equal(restored.thread.modelSelection.instanceId, "codex");
        assert.equal(
          restored.messages.find((message) => message.id === "question")?.text,
          "V2 edit during restoration",
        );
        assert.equal(
          restored.messages.filter((message) => message.text === "New V1 question").length,
          1,
        );
        assert.equal(
          restored.messages.find((message) => message.id === "answer")?.text,
          "V2 edited answer",
        );
        assert.equal(
          restored.messages.filter((message) => message.text === "New V1 answer").length,
          1,
        );
        assert.equal(
          restored.messages.find((message) => message.id === "later-user")?.attachments?.length,
          1,
        );
        const primaryPlan = restored.plans.find((plan) => plan.id === "plan");
        if (primaryPlan?.kind !== "proposed_plan") return assert.fail("Expected preserved plan");
        assert.equal(primaryPlan.markdown, "# V2 edited plan");
        assert.equal(
          restored.plans.filter(
            (plan) => plan.kind === "proposed_plan" && plan.markdown === "# New V1 plan",
          ).length,
          1,
        );
        assert.ok(
          restored.turnItems.some(
            (item) => item.type === "dynamic_tool" && item.title === "Recovered V1 version",
          ),
        );
        assert.ok(
          restored.turnItems.some(
            (item) =>
              item.type === "dynamic_tool" &&
              item.input !== null &&
              JSON.stringify(item.input).includes("result") &&
              item.status === "completed",
          ),
        );
        assert.deepEqual(restored.runs, []);
        assert.deepEqual(restored.runtimeRequests, []);
        assert.deepEqual(restored.providerSessions, []);
        const sequence = yield* (yield* EventStore.EventStoreV2).latestSequence();
        yield* importer.ensureTranscript(THREAD);
        assert.equal(yield* (yield* EventStore.EventStoreV2).latestSequence(), sequence);
      }).pipe(Effect.provide(importerLayer));
      assert.deepEqual(NodeFS.readFileSync(sourcePath), originalBytes);

      const advancedSource = new NodeSqlite.DatabaseSync(sourcePath);
      try {
        advancedSource.exec(`UPDATE projection_threads SET updated_at = '2026-02-03T00:00:00.000Z';
          INSERT INTO projection_thread_messages (message_id, thread_id, role, text, is_streaming, created_at, updated_at)
            VALUES ('even-later-user', 'continued-v1', 'user', 'Another V1 question', 0, '2026-02-03T00:00:00.000Z', '2026-02-03T00:00:00.000Z');`);
      } finally {
        advancedSource.close();
      }
      const advancedBytes = NodeFS.readFileSync(sourcePath);
      yield* Effect.gen(function* () {
        const importer = yield* Importer.LegacyV1ThreadImporter;
        yield* importer.ensureTranscript(THREAD);
        assert.equal(yield* importer.pendingThreadCount, 0);
        const restored = yield* (yield* ProjectionStore.ProjectionStoreV2).getThreadProjection(
          THREAD,
        );
        assert.equal(
          restored.messages.find((message) => message.id === "even-later-user")?.text,
          "Another V1 question",
        );
        for (const text of ["New V1 question", "New V1 answer"])
          assert.equal(restored.messages.filter((message) => message.text === text).length, 1);
        assert.equal(
          restored.plans.filter(
            (plan) => plan.kind === "proposed_plan" && plan.markdown === "# New V1 plan",
          ).length,
          1,
        );
        assert.equal(restored.thread.archivedAt, null);
      }).pipe(Effect.provide(importerLayer));
      assert.deepEqual(NodeFS.readFileSync(sourcePath), advancedBytes);

      const changedSource = new NodeSqlite.DatabaseSync(sourcePath);
      try {
        changedSource.exec(`UPDATE projection_threads SET updated_at = '2026-02-04T00:00:00.000Z';
          UPDATE projection_thread_messages SET text = 'Newest V1 answer', updated_at = '2026-02-04T00:00:00.000Z' WHERE message_id = 'answer';`);
      } finally {
        changedSource.close();
      }
      const changedBytes = NodeFS.readFileSync(sourcePath);
      yield* Effect.gen(function* () {
        const importer = yield* Importer.LegacyV1ThreadImporter;
        yield* importer.ensureTranscript(THREAD);
        const restored = yield* (yield* ProjectionStore.ProjectionStoreV2).getThreadProjection(
          THREAD,
        );
        assert.equal(
          restored.messages.find((message) => message.id === "answer")?.text,
          "V2 edited answer",
        );
        for (const text of ["New V1 question", "New V1 answer", "Newest V1 answer"])
          assert.equal(restored.messages.filter((message) => message.text === text).length, 1);
        assert.equal(
          restored.plans.filter(
            (plan) => plan.kind === "proposed_plan" && plan.markdown === "# New V1 plan",
          ).length,
          1,
        );
      }).pipe(Effect.provide(importerLayer));
      assert.deepEqual(NodeFS.readFileSync(sourcePath), changedBytes);
    }).pipe(
      Effect.provide(
        ServerConfig.layerTest(directory, directory).pipe(Layer.provideMerge(NodeServices.layer)),
      ),
      Effect.ensuring(
        Effect.sync(() => NodeFS.rmSync(directory, { recursive: true, force: true })),
      ),
    );
  },
);
