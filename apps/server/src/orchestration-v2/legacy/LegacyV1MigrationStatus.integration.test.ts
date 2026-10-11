import { assert, it } from "@effect/vitest";
import {
  NonNegativeInt,
  ServerLifecycleLegacyThreadMigrationPayload,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as Sqlite from "../../persistence/Sqlite.ts";
import * as Lifecycle from "../../serverLifecycleEvents.ts";
import { importLegacyTranscriptsWithStatus } from "../../serverRuntimeStartup.ts";
import * as EventSink from "../EventSink.ts";
import * as EventStore from "../EventStore.ts";
import * as ProjectionStore from "../ProjectionStore.ts";
import * as Legacy from "./LegacyV1ThreadImporter.ts";

const stores = Layer.mergeAll(
  Sqlite.layerMemory,
  EventStore.layer.pipe(Layer.provideMerge(Sqlite.layerMemory)),
  ProjectionStore.layer.pipe(Layer.provideMerge(Sqlite.layerMemory)),
);
const sink = EventSink.layer.pipe(Layer.provide(stores));
const testLayer = Layer.mergeAll(
  stores,
  sink,
  Legacy.layer.pipe(Layer.provide(Layer.mergeAll(stores, sink))),
  Lifecycle.layer,
);

const seed = Effect.fnUntraced(function* (id: string, attachmentsJson: string | null = null) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO projection_projects
    (project_id,title,workspace_root,scripts_json,created_at,updated_at)
    VALUES (${id},'Project','/tmp/migration-status','[]','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')`;
  yield* sql`INSERT INTO projection_threads
    (thread_id,project_id,title,model_selection_json,runtime_mode,interaction_mode,created_at,updated_at)
    VALUES (${id},${id},'Thread','{"instanceId":"codex","model":"gpt-5.4"}','full-access','default','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')`;
  yield* sql`INSERT INTO projection_thread_messages
    (message_id,thread_id,role,text,attachments_json,is_streaming,created_at,updated_at)
    VALUES (${`${id}-message`},${id},'user','Original text',${attachmentsJson},0,'2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')`;
});

// Freeze the previous wire decoder: optional failure details must not break it.
const previousMigrationPayload = Schema.Struct({
  status: Schema.Literals(["running", "complete"]),
  totalThreadCount: NonNegativeInt,
});

const migrationPayload = Effect.gen(function* () {
  const lifecycle = yield* Lifecycle.ServerLifecycleEvents;
  const snapshot = yield* lifecycle.snapshot;
  const event = snapshot.events.find((event) => event.type === "legacyThreadMigration");
  assert.isDefined(event);
  if (event?.type !== "legacyThreadMigration") throw new Error("Missing migration status");
  yield* Schema.decodeUnknownEffect(previousMigrationPayload)(event.payload);
  return yield* Schema.decodeUnknownEffect(ServerLifecycleLegacyThreadMigrationPayload)(
    event.payload,
  );
});

it.effect("never reports complete when the original V1 source could not be inspected", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const importer = yield* Legacy.LegacyV1ThreadImporter;
    yield* sql`UPDATE scient_legacy_reconciliation_state SET last_error = 'Original source unavailable' WHERE id = 1`;
    assert.equal(yield* importer.pendingThreadCount, 0);
    yield* importLegacyTranscriptsWithStatus(0);
    const payload = yield* migrationPayload;
    assert.equal(payload.status, "running");
    assert.equal(payload.failed, true);
    assert.equal(payload.pendingThreadCount, undefined);
    yield* sql`UPDATE scient_legacy_reconciliation_state SET last_error = NULL WHERE id = 1`;
    yield* importLegacyTranscriptsWithStatus(0);
    assert.equal((yield* migrationPayload).status, "complete");
  }).pipe(Effect.provide(testLayer)),
);

it.effect(
  "reports incomplete imports from the ledger, keeps healthy threads usable, and completes on retry",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const importer = yield* Legacy.LegacyV1ThreadImporter;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      yield* seed("failed");
      yield* seed("healthy");
      yield* sql`INSERT INTO projection_thread_messages
      (message_id,thread_id,role,text,is_streaming,created_at,updated_at)
      VALUES ('older-message','failed','user','Earlier text',0,'2025-12-31T00:00:00.000Z','2025-12-31T00:00:00.000Z')`;
      yield* importer.reconcileShells;
      yield* sql`CREATE TRIGGER fail_import BEFORE INSERT ON orchestration_events
      WHEN NEW.event_id='migration:v1:message:older-message'
      BEGIN SELECT RAISE(ABORT,'injected import failure'); END`;
      yield* importLegacyTranscriptsWithStatus(2);
      assert.deepEqual(yield* migrationPayload, {
        status: "running",
        failed: true,
        totalThreadCount: 2,
        pendingThreadCount: 1,
      });
      const errors =
        yield* sql`SELECT last_error FROM orchestration_v2_legacy_imports WHERE thread_id='failed'`;
      assert.isNotNull(errors[0]?.last_error);
      assert.equal(
        (yield* projections.getThreadProjection(ThreadId.make("healthy"))).messages.length,
        1,
      );
      yield* sql`DROP TRIGGER fail_import`;
      yield* importLegacyTranscriptsWithStatus(2);
      assert.deepEqual(yield* migrationPayload, {
        status: "complete",
        totalThreadCount: 2,
        pendingThreadCount: 0,
      });
      const restored = yield* projections.getThreadProjection(ThreadId.make("failed"));
      assert.deepEqual(
        restored.messages.map((message) => message.text),
        ["Earlier text", "Original text"],
      );
      const counts = yield* sql`SELECT COUNT(*) AS total,COUNT(DISTINCT event_id) AS unique_count
      FROM orchestration_events WHERE application_event_version=2`;
      assert.equal(counts[0]?.total, counts[0]?.unique_count);
      assert.equal(yield* importer.pendingThreadCount, 0);
    }).pipe(Effect.provide(testLayer)),
);

it.effect("never reports completion when the final ledger inspection fails", () =>
  Effect.gen(function* () {
    const importer = yield* Legacy.LegacyV1ThreadImporter;
    yield* importLegacyTranscriptsWithStatus(1).pipe(
      Effect.provideService(Legacy.LegacyV1ThreadImporter, {
        ...importer,
        pendingThreadCount: Effect.fail(
          new Legacy.LegacyV1ThreadImportError({ operation: "inspect pending" }),
        ),
      }),
    );
    assert.deepEqual(yield* migrationPayload, {
      status: "running",
      failed: true,
      totalThreadCount: 1,
    });
  }).pipe(Effect.provide(testLayer)),
);

const validAttachment = {
  type: "file",
  id: "valid_file",
  name: "evidence.txt",
  mimeType: "text/plain",
  sizeBytes: 14,
};

it.effect(
  "repairs partial attachment projections before completing a retried transcript import",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const importer = yield* Legacy.LegacyV1ThreadImporter;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const raw = JSON.stringify([
        validAttachment,
        { ...validAttachment, id: "bad_file", sizeBytes: 0 },
      ]);
      yield* seed("mixed", raw);
      yield* importer.reconcileShells;
      yield* importLegacyTranscriptsWithStatus(1);
      assert.deepEqual(yield* migrationPayload, {
        status: "running",
        failed: true,
        totalThreadCount: 1,
        pendingThreadCount: 1,
      });
      const threadId = ThreadId.make("mixed");
      const initialProjection = yield* projections.getThreadProjection(threadId);
      assert.deepEqual(initialProjection.messages[0]?.attachments, [validAttachment]);
      const initialUserTurn = initialProjection.turnItems.find(
        (item) => item.type === "user_message",
      );
      assert.isDefined(initialUserTurn);
      if (initialUserTurn?.type !== "user_message") throw new Error("Missing imported user turn");
      assert.deepEqual(initialUserTurn.attachments, [validAttachment]);
      const error = yield* importer.ensureTranscript(ThreadId.make("mixed")).pipe(Effect.flip);
      assert.equal(error.threadId, "mixed");
      assert.equal(yield* importer.pendingThreadCount, 1);
      const source =
        yield* sql`SELECT attachments_json FROM projection_thread_messages WHERE thread_id='mixed'`;
      assert.equal(source[0]?.attachments_json, raw);
      const marker =
        yield* sql`SELECT transcript_imported_at,last_error FROM orchestration_v2_legacy_imports WHERE thread_id='mixed'`;
      assert.isNull(marker[0]?.transcript_imported_at);
      assert.isNotNull(marker[0]?.last_error);

      const repairedAttachments = [
        validAttachment,
        {
          ...validAttachment,
          id: "repaired_file",
          name: "repaired.pdf",
          mimeType: "application/pdf",
          sizeBytes: 28,
        },
      ];
      yield* sql`UPDATE projection_thread_messages
        SET attachments_json = ${JSON.stringify(repairedAttachments)}
        WHERE message_id = 'mixed-message'`;
      yield* sql`CREATE TRIGGER fail_import_completion BEFORE UPDATE OF transcript_imported_at
        ON orchestration_v2_legacy_imports
        WHEN OLD.thread_id='mixed' AND NEW.transcript_imported_at IS NOT NULL
        BEGIN SELECT RAISE(ABORT,'injected completion failure'); END`;
      const completionError = yield* importer.ensureTranscript(threadId).pipe(Effect.flip);
      assert.equal(completionError.threadId, "mixed");

      const repairedProjection = yield* projections.getThreadProjection(threadId);
      assert.deepEqual(repairedProjection.messages[0]?.attachments, repairedAttachments);
      const repairedUserTurn = repairedProjection.turnItems.find(
        (item) => item.type === "user_message",
      );
      assert.isDefined(repairedUserTurn);
      if (repairedUserTurn?.type !== "user_message") throw new Error("Missing repaired user turn");
      assert.deepEqual(repairedUserTurn.attachments, repairedAttachments);
      const repairEventsBeforeRetry = yield* sql`
        SELECT COUNT(*) AS total, COUNT(DISTINCT event_id) AS unique_count
        FROM orchestration_events
        WHERE event_id LIKE 'migration:v1:attachment-repair:mixed-message:%'
      `;
      assert.equal(repairEventsBeforeRetry[0]?.total, 2);
      assert.equal(repairEventsBeforeRetry[0]?.unique_count, 2);

      yield* sql`DROP TRIGGER fail_import_completion`;
      yield* importer.ensureTranscript(threadId);
      yield* importLegacyTranscriptsWithStatus(1);
      assert.deepEqual(yield* migrationPayload, {
        status: "complete",
        totalThreadCount: 1,
        pendingThreadCount: 0,
      });
      const finalProjection = yield* projections.getThreadProjection(threadId);
      assert.deepEqual(finalProjection.messages[0]?.attachments, repairedAttachments);
      const finalUserTurn = finalProjection.turnItems.find((item) => item.type === "user_message");
      assert.isDefined(finalUserTurn);
      if (finalUserTurn?.type !== "user_message") throw new Error("Missing final user turn");
      assert.deepEqual(finalUserTurn.attachments, repairedAttachments);
      const repairEventsAfterRetry = yield* sql`
        SELECT COUNT(*) AS total, COUNT(DISTINCT event_id) AS unique_count
        FROM orchestration_events
        WHERE event_id LIKE 'migration:v1:attachment-repair:mixed-message:%'
      `;
      assert.equal(repairEventsAfterRetry[0]?.total, 2);
      assert.equal(repairEventsAfterRetry[0]?.unique_count, 2);
      assert.equal(yield* importer.pendingThreadCount, 0);
    }).pipe(Effect.provide(testLayer)),
);

it.effect.each(["{", "{}"])("reports malformed attachment JSON/shape: %s", (raw) =>
  Effect.gen(function* () {
    const importer = yield* Legacy.LegacyV1ThreadImporter;
    yield* seed("invalid", raw);
    yield* importer.reconcileShells;
    yield* importLegacyTranscriptsWithStatus(1);
    assert.equal((yield* migrationPayload).failed, true);
    assert.equal(yield* importer.pendingThreadCount, 1);
  }).pipe(Effect.provide(testLayer)),
);

it.effect.each([
  null,
  "[]",
  JSON.stringify([validAttachment, { ...validAttachment, type: "future-type", id: "future" }]),
])("continues to import valid, empty, and forward-compatible attachment arrays: %s", (raw) =>
  Effect.gen(function* () {
    const importer = yield* Legacy.LegacyV1ThreadImporter;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    yield* seed("valid", raw);
    yield* importer.reconcileShells;
    yield* importLegacyTranscriptsWithStatus(1);
    assert.equal((yield* migrationPayload).status, "complete");
    assert.deepEqual(
      (yield* projections.getThreadProjection(ThreadId.make("valid"))).messages[0]?.attachments,
      raw === null ? [] : JSON.parse(raw),
    );
  }).pipe(Effect.provide(testLayer)),
);
