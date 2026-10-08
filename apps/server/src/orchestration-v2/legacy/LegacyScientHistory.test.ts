import { assert, it } from "@effect/vitest";
import { EventId, ThreadId, TurnItemId, TurnId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Tracer from "effect/Tracer";
import * as SqlClient from "effect/sql/SqlClient";
import { layerMemory as SqlitePersistenceMemory } from "../../persistence/Sqlite.ts";
import * as EventStore from "../EventStore.ts";
import * as EventSink from "../EventSink.ts";
import * as ProjectionStore from "../ProjectionStore.ts";
import * as ProjectionMaintenance from "../ProjectionMaintenance.ts";
import * as LegacyV1ThreadImporter from "./LegacyV1ThreadImporter.ts";
import { projectWorkLog } from "@scientfactory/conversation";
import { conversationSnapshotProjection } from "../../scient/conversationExport/conversationSnapshotProjection.ts";

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

it.effect(
  "repairs generation-one completed imports with typed inert submitted answers while preserving their audit and V2 edits",
  () =>
    Effect.gen(function* () {
      yield* seed;
      const sql = yield* SqlClient.SqlClient;
      const payload =
        '{"requestId":"legacy-request","answers":{"dataset":"Use measured data"},"questionTextById":{"dataset":"Which dataset?"},"attachmentsByQuestionId":{}}';
      yield* sql`INSERT INTO projection_thread_activities (activity_id, thread_id, turn_id, tone, kind, summary, payload_json, sequence, created_at)
      VALUES ('submitted-answer', ${THREAD}, 'answer-turn', 'info', 'user-input.answer-submitted', 'Answer submitted', ${payload}, 9, '2026-01-07T12:00:00.000Z')`;
      const importer = yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const sink = yield* EventSink.EventSinkV2;
      yield* importer.reconcileShells;
      yield* importer.ensureTranscript(THREAD);
      // Model an already completed generation-one database: the generic audit
      // exists, but that release did not project a typed submitted-answer fact.
      const answerId = "migration:v1:history:answer:submitted-answer";
      yield* sql`DELETE FROM orchestration_v2_projection_turn_items WHERE turn_item_id = ${answerId}`;
      yield* sql`DELETE FROM orchestration_events WHERE event_id = ${answerId}`;
      yield* sql`UPDATE orchestration_v2_legacy_imports SET history_repair_version = 1 WHERE thread_id = ${THREAD}`;
      const before = yield* projections.getThreadProjection(THREAD);
      const audit = before.turnItems.find(
        (item) => item.id === "migration:v1:history:activity:submitted-answer",
      );
      assert.ok(audit);
      yield* sink.write({
        events: [
          {
            id: EventId.make("answer-audit-v2-edit"),
            type: "turn-item.updated",
            threadId: THREAD,
            occurredAt: audit.updatedAt,
            payload: { ...audit, title: "Preserved V2 audit title" },
          },
        ],
      });
      yield* Effect.gen(function* () {
        yield* (yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter).ensureTranscript(THREAD);
      }).pipe(Effect.provide(Layer.fresh(LegacyV1ThreadImporter.layer)));
      const repaired = yield* projections.getThreadProjection(THREAD);
      const item = repaired.turnItems.find((item) => item.id === answerId);
      assert.ok(item?.type === "user_input_request");
      assert.equal(item.historyTurnId, "answer-turn");
      assert.deepEqual(item.questionAnswer?.answers, { dataset: "Use measured data" });
      assert.equal(item.questions[0]?.question, "Which dataset?");
      assert.equal(item.runId, null);
      assert.equal(item.nodeId, null);
      assert.equal(item.nativeItemRef, null);
      assert.deepEqual(repaired.runtimeRequests, []);
      assert.deepEqual(repaired.providerSessions, []);
      assert.equal(
        repaired.turnItems.find((item) => item.id === audit.id)?.title,
        "Preserved V2 audit title",
      );
      const sequence = yield* (yield* EventStore.EventStoreV2).latestSequence();
      yield* Effect.gen(function* () {
        yield* (yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter).ensureTranscript(THREAD);
      }).pipe(Effect.provide(Layer.fresh(LegacyV1ThreadImporter.layer)));
      assert.equal(yield* (yield* EventStore.EventStoreV2).latestSequence(), sequence);
      yield* (yield* ProjectionMaintenance.ProjectionMaintenanceV2).rebuild;
      assert.deepEqual(
        (yield* projections.getThreadProjection(THREAD)).turnItems,
        repaired.turnItems,
      );
    }).pipe(Effect.provide(TestLayer)),
);

const seedCodexCitation = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`UPDATE projection_thread_messages SET text = 'Recommendation citeturn3view1', turn_id = 'cited-turn'
    WHERE thread_id = ${THREAD} AND message_id = 'answer'`;
  yield* sql`INSERT INTO projection_thread_activities (activity_id, thread_id, turn_id, tone, kind, summary, payload_json, sequence, created_at)
    VALUES ('citation-search', ${THREAD}, 'cited-turn', 'tool', 'tool.completed', 'Web search',
      '{"itemType":"web_search","citationSources":[{"id":"turn3view1","url":"https://example.com/guideline","title":"Guideline"}]}', 8, '2026-01-07T06:00:00.000Z'),
      ('other-turn-search', ${THREAD}, 'unrelated-turn', 'tool', 'tool.completed', 'Other search',
      '{"itemType":"web_search","citationSources":[{"id":"turn3view1","url":"https://wrong.example.com/","title":"Other turn"}]}', 9, '2026-01-07T07:00:00.000Z')`;
});

it.effect.each(
  [false, true].map((completed) => ({
    caseTitle: `renders retained Codex citations for ${completed ? "old completed" : "new"} imports and preserves V2 replay`,
    completed,
  })),
)("$caseTitle", ({ completed }) =>
  Effect.gen(function* () {
    yield* seed;
    yield* seedCodexCitation;
    const sql = yield* SqlClient.SqlClient;
    const migration = yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    yield* migration.reconcileShells;
    const sink = yield* EventSink.EventSinkV2;
    const preview = (yield* projections.getThreadProjection(THREAD)).turnItems.find(
      (row) => row.type === "assistant_message",
    );
    if (preview?.type !== "assistant_message") return assert.fail("Expected shell assistant");
    yield* sink.write({
      events: [
        {
          id: EventId.make("citation-existing-title-edit"),
          type: "turn-item.updated",
          threadId: THREAD,
          occurredAt: preview.updatedAt,
          payload: { ...preview, title: "Existing V2 presentation" },
        },
      ],
    });
    if (completed)
      yield* sql`UPDATE orchestration_v2_legacy_imports
        SET transcript_imported_at = '2026-02-01T00:00:00.000Z' WHERE thread_id = ${THREAD}`;
    const original =
      yield* sql`SELECT * FROM projection_thread_messages WHERE thread_id = ${THREAD} ORDER BY message_id`;
    yield* migration.ensureTranscript(THREAD);
    const projection = yield* projections.getThreadProjection(THREAD);
    const message = projection.messages.find((row) => row.id === "answer");
    const item = projection.turnItems.find((row) => row.type === "assistant_message");
    assert.equal(message?.text, 'Recommendation [1](<https://example.com/guideline> "Guideline")');
    if (item?.type !== "assistant_message") return assert.fail("Expected historical assistant");
    assert.equal(item.text, message?.text);
    assert.equal(item.title, "Existing V2 presentation");
    assert.equal(item.runId, null);
    assert.equal(item.nativeItemRef, null);
    assert.deepEqual(projection.runtimeRequests, []);
    assert.deepEqual(projection.providerSessions, []);
    assert.deepEqual(
      yield* sql`SELECT * FROM projection_thread_messages WHERE thread_id = ${THREAD} ORDER BY message_id`,
      original,
    );
    const sequence = yield* (yield* EventStore.EventStoreV2).latestSequence();
    yield* Effect.gen(function* () {
      yield* (yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter).ensureTranscript(THREAD);
    }).pipe(Effect.provide(Layer.fresh(LegacyV1ThreadImporter.layer)));
    assert.equal(yield* (yield* EventStore.EventStoreV2).latestSequence(), sequence);
    yield* (yield* ProjectionMaintenance.ProjectionMaintenanceV2).rebuild;
    const replayed = yield* projections.getThreadProjection(THREAD);
    assert.deepEqual(replayed.messages, projection.messages);
    assert.deepEqual(replayed.turnItems, projection.turnItems);
  }).pipe(Effect.provide(TestLayer)),
);

it.live("retains V2 message and item edits racing a completed Codex citation repair", () =>
  Effect.gen(function* () {
    yield* seed;
    yield* seedCodexCitation;
    const sql = yield* SqlClient.SqlClient;
    const migration = yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const sink = yield* EventSink.EventSinkV2;
    yield* migration.reconcileShells;
    yield* sql`UPDATE orchestration_v2_legacy_imports
      SET transcript_imported_at = '2026-02-01T00:00:00.000Z' WHERE thread_id = ${THREAD}`;
    const before = yield* projections.getThreadProjection(THREAD);
    const message = before.messages.find((row) => row.id === "answer");
    const item = before.turnItems.find((row) => row.type === "assistant_message");
    if (message === undefined || item?.type !== "assistant_message")
      return assert.fail("Expected legacy answer");
    const ready = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const intercepted = EventSink.EventSinkV2.of({
      ...sink,
      write: (input) =>
        Effect.gen(function* () {
          if (input.guardLegacyCitationRepairs === true) {
            yield* Deferred.succeed(ready, undefined);
            yield* Deferred.await(release);
          }
          return yield* sink.write(input);
        }),
    });
    const repair = Effect.gen(function* () {
      yield* (yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter).ensureTranscript(THREAD);
    }).pipe(
      Effect.provide(Layer.fresh(LegacyV1ThreadImporter.layer)),
      Effect.provideService(EventSink.EventSinkV2, intercepted),
    );
    const fiber = yield* Effect.forkChild(repair);
    yield* Deferred.await(ready);
    yield* sink.write({
      events: [
        {
          id: EventId.make("raced-citation-message-edit"),
          type: "message.updated",
          threadId: THREAD,
          occurredAt: message.updatedAt,
          payload: { ...message, text: "Authoritative V2 message edit" },
        },
        {
          id: EventId.make("raced-citation-item-edit"),
          type: "turn-item.updated",
          threadId: THREAD,
          occurredAt: item.updatedAt,
          payload: { ...item, text: "Authoritative V2 item edit", title: "Preserved title" },
        },
      ],
    });
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(fiber);
    const repaired = yield* projections.getThreadProjection(THREAD);
    assert.equal(
      repaired.messages.find((row) => row.id === message.id)?.text,
      "Authoritative V2 message edit",
    );
    assert.deepEqual(
      repaired.turnItems.find((row) => row.id === item.id),
      { ...item, text: "Authoritative V2 item edit", title: "Preserved title" },
    );
    yield* (yield* ProjectionMaintenance.ProjectionMaintenanceV2).rebuild;
    const replayed = yield* projections.getThreadProjection(THREAD);
    assert.deepEqual(replayed.messages, repaired.messages);
    assert.deepEqual(replayed.turnItems, repaired.turnItems);
  }).pipe(Effect.provide(TestLayer), Effect.timeout("5 seconds")),
);

it.effect("does not apply historical citation repair to an unowned native assistant item", () =>
  Effect.gen(function* () {
    yield* seed;
    yield* seedCodexCitation;
    const migration = yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const sink = yield* EventSink.EventSinkV2;
    yield* migration.reconcileShells;
    const legacy = (yield* projections.getThreadProjection(THREAD)).turnItems.find(
      (item) => item.type === "assistant_message",
    );
    if (legacy?.type !== "assistant_message") return assert.fail("Expected legacy assistant");
    // Even an item referencing the historical message is not migration-owned
    // unless its own exact historical identity is retained.
    const native = { ...legacy, id: TurnItemId.make("native-assistant-citation-item") };
    yield* sink.write({
      events: [
        {
          id: EventId.make("native-citation-item-created"),
          type: "turn-item.updated",
          threadId: THREAD,
          occurredAt: native.updatedAt,
          payload: native,
        },
      ],
    });
    const before = yield* projections.getThreadProjection(THREAD);
    const sequence = yield* (yield* EventStore.EventStoreV2).latestSequence();
    assert.deepEqual(
      yield* sink.write({
        guardLegacyCitationRepairs: true,
        events: [
          {
            id: EventId.make("migration:v1:history:citation:unowned-native"),
            type: "turn-item.updated",
            threadId: THREAD,
            occurredAt: native.updatedAt,
            payload: { ...native, text: "Must not replace native text" },
          },
        ],
      }),
      [],
    );
    assert.equal(yield* (yield* EventStore.EventStoreV2).latestSequence(), sequence);
    assert.deepEqual((yield* projections.getThreadProjection(THREAD)).turnItems, before.turnItems);
  }).pipe(Effect.provide(TestLayer)),
);

it.effect(
  "repairs old completed citations after compaction removed the original message event",
  () =>
    Effect.gen(function* () {
      yield* seed;
      yield* seedCodexCitation;
      const sql = yield* SqlClient.SqlClient;
      const migration = yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const sink = yield* EventSink.EventSinkV2;
      const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
      yield* migration.reconcileShells;
      const message = (yield* projections.getThreadProjection(THREAD)).messages.find(
        (row) => row.id === "answer",
      );
      if (message === undefined) return assert.fail("Expected imported message");
      const updatedAt = DateTime.makeUnsafe("2026-03-01T00:00:00.000Z");
      yield* sink.write({
        events: [
          {
            id: EventId.make("non-text-edit-before-citation-compaction"),
            type: "message.updated",
            threadId: THREAD,
            occurredAt: updatedAt,
            payload: { ...message, updatedAt },
          },
        ],
      });
      yield* sql`UPDATE orchestration_v2_legacy_imports SET transcript_imported_at = '2026-02-01T00:00:00.000Z'
      WHERE thread_id = ${THREAD}`;
      yield* maintenance.compactEventStore;
      assert.deepEqual(
        yield* sql`SELECT event_id FROM orchestration_events WHERE event_id = 'migration:v1:message:answer'`,
        [],
      );
      yield* maintenance.rebuild;
      yield* migration.ensureTranscript(THREAD);
      const repaired = yield* projections.getThreadProjection(THREAD);
      const answer = repaired.messages.find((row) => row.id === "answer");
      assert.equal(answer?.text, 'Recommendation [1](<https://example.com/guideline> "Guideline")');
      assert.deepEqual(answer?.updatedAt, updatedAt);
      const item = repaired.turnItems.find((row) => row.type === "assistant_message");
      if (item?.type !== "assistant_message")
        return assert.fail("Expected repaired assistant item");
      assert.equal(item.text, answer?.text);
      const sequence = yield* (yield* EventStore.EventStoreV2).latestSequence();
      yield* Effect.gen(function* () {
        yield* (yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter).ensureTranscript(THREAD);
      }).pipe(Effect.provide(Layer.fresh(LegacyV1ThreadImporter.layer)));
      assert.equal(yield* (yield* EventStore.EventStoreV2).latestSequence(), sequence);
      yield* maintenance.rebuild;
      const replayed = yield* projections.getThreadProjection(THREAD);
      assert.deepEqual(replayed.messages, repaired.messages);
      assert.deepEqual(replayed.turnItems, repaired.turnItems);
    }).pipe(Effect.provide(TestLayer)),
);

it.effect(
  "repairs old completed history once across fresh startup importers without rescanning it",
  () =>
    Effect.gen(function* () {
      yield* seed;
      const sql = yield* SqlClient.SqlClient;
      const migration = yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const sink = yield* EventSink.EventSinkV2;
      yield* migration.reconcileShells;
      yield* migration.ensureTranscript(THREAD);
      const before = yield* projections.getThreadProjection(THREAD);
      const tool = before.turnItems.find(
        (item) => item.type === "dynamic_tool" && item.toolName === "read_file",
      );
      if (tool?.type !== "dynamic_tool") return assert.fail("Expected imported tool");
      yield* sink.write({
        events: [
          {
            id: EventId.make("startup-history-v2-edit"),
            type: "turn-item.updated",
            threadId: THREAD,
            occurredAt: tool.updatedAt,
            payload: { ...tool, output: "Authoritative V2 edit" },
          },
        ],
      });
      const edited = yield* projections.getThreadProjection(THREAD);
      yield* sql`UPDATE orchestration_v2_legacy_imports SET history_repair_version = 0 WHERE thread_id = ${THREAD}`;
      const [oldMarker] = yield* sql<{ transcript_imported_at: string | null }>`
      SELECT transcript_imported_at FROM orchestration_v2_legacy_imports WHERE thread_id = ${THREAD}`;
      const statements: string[] = [];
      const tracer = Tracer.make({
        span(options) {
          const span = new Tracer.NativeSpan(options);
          const end = span.end.bind(span);
          span.end = (time, exit) => {
            end(time, exit);
            const text = span.attributes.get("db.query.text");
            if (typeof text === "string") statements.push(text);
          };
          return span;
        },
      });
      // These are the actual startup operations, composed against the same SQL
      // and EventSink with a new importer lifetime on each invocation.
      const startup = Effect.gen(function* () {
        const fresh = yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter;
        const pending = yield* fresh.pendingThreadCount;
        yield* fresh.reconcileShells;
        yield* fresh.importPendingTranscripts;
        yield* fresh.ensureTranscript(THREAD);
        return pending;
      }).pipe(Effect.provide(Layer.fresh(LegacyV1ThreadImporter.layer)), Effect.withTracer(tracer));
      assert.equal(yield* startup, 1);
      assert.equal(statements.filter((text) => text.includes("WITH history AS")).length, 1);
      const [current] = yield* sql<{
        transcript_imported_at: string | null;
        history_repair_version: number;
      }>`
      SELECT transcript_imported_at, history_repair_version FROM orchestration_v2_legacy_imports WHERE thread_id = ${THREAD}`;
      assert.equal(
        current?.history_repair_version,
        LegacyV1ThreadImporter.LEGACY_HISTORY_REPAIR_VERSION,
      );
      assert.equal(current?.transcript_imported_at, oldMarker?.transcript_imported_at);
      assert.deepEqual(
        (yield* projections.getThreadProjection(THREAD)).turnItems,
        edited.turnItems,
      );
      statements.length = 0;
      const sequence = yield* (yield* EventStore.EventStoreV2).latestSequence();
      assert.equal(yield* startup, 0);
      assert.equal(statements.filter((text) => text.includes("WITH history AS")).length, 0);
      assert.isTrue(statements.some((text) => text.includes("history_repair_version")));
      assert.equal(yield* (yield* EventStore.EventStoreV2).latestSequence(), sequence);
      yield* (yield* ProjectionMaintenance.ProjectionMaintenanceV2).rebuild;
      assert.deepEqual(
        (yield* projections.getThreadProjection(THREAD)).turnItems,
        edited.turnItems,
      );
    }).pipe(Effect.provide(TestLayer)),
);

it.effect(
  "retries a failed repair-generation commit without overwriting committed V2 history edits",
  () =>
    Effect.gen(function* () {
      yield* seed;
      const sql = yield* SqlClient.SqlClient;
      const migration = yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const sink = yield* EventSink.EventSinkV2;
      yield* migration.reconcileShells;
      yield* migration.ensureTranscript(THREAD);
      yield* sql`UPDATE orchestration_v2_legacy_imports SET history_repair_version = 0 WHERE thread_id = ${THREAD}`;
      yield* sql`INSERT INTO projection_thread_messages (message_id, thread_id, role, text, is_streaming, created_at, updated_at)
      VALUES ('generation-reason', ${THREAD}, 'reasoning', 'Previously omitted reasoning', 0, '2026-01-03T06:00:00.000Z', '2026-01-03T07:00:00.000Z')`;
      const [oldMarker] = yield* sql<{ transcript_imported_at: string | null }>`
      SELECT transcript_imported_at FROM orchestration_v2_legacy_imports WHERE thread_id = ${THREAD}`;
      yield* sql`CREATE TRIGGER reject_repair_generation BEFORE UPDATE OF history_repair_version ON orchestration_v2_legacy_imports
      WHEN NEW.history_repair_version > 0
      BEGIN SELECT RAISE(ABORT, 'controlled failed repair generation commit'); END`;
      const repair = Effect.gen(function* () {
        yield* (yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter).ensureTranscript(THREAD);
      }).pipe(Effect.provide(Layer.fresh(LegacyV1ThreadImporter.layer)));
      assert.equal((yield* Effect.exit(repair))._tag, "Failure");
      const [failedMarker] = yield* sql<{
        transcript_imported_at: string | null;
        history_repair_version: number;
      }>`
      SELECT transcript_imported_at, history_repair_version FROM orchestration_v2_legacy_imports WHERE thread_id = ${THREAD}`;
      assert.equal(failedMarker?.history_repair_version, 0);
      assert.equal(failedMarker?.transcript_imported_at, oldMarker?.transcript_imported_at);
      const partial = yield* projections.getThreadProjection(THREAD);
      const reason = partial.turnItems.find(
        (item) => item.id === "migration:v1:history:reasoning:generation-reason",
      );
      if (reason?.type !== "reasoning")
        return assert.fail("Expected committed repair before failed stamp");
      yield* sink.write({
        events: [
          {
            id: EventId.make("edit-after-generation-commit-failure"),
            type: "turn-item.updated",
            threadId: THREAD,
            occurredAt: reason.updatedAt,
            payload: { ...reason, text: "User edited repaired history" },
          },
        ],
      });
      const edited = yield* projections.getThreadProjection(THREAD);
      yield* sql`DROP TRIGGER reject_repair_generation`;
      yield* repair;
      assert.deepEqual(
        (yield* projections.getThreadProjection(THREAD)).turnItems,
        edited.turnItems,
      );
      const [current] = yield* sql<{ history_repair_version: number }>`
      SELECT history_repair_version FROM orchestration_v2_legacy_imports WHERE thread_id = ${THREAD}`;
      assert.equal(
        current?.history_repair_version,
        LegacyV1ThreadImporter.LEGACY_HISTORY_REPAIR_VERSION,
      );
      const sequence = yield* (yield* EventStore.EventStoreV2).latestSequence();
      yield* repair;
      assert.equal(yield* (yield* EventStore.EventStoreV2).latestSequence(), sequence);
      yield* (yield* ProjectionMaintenance.ProjectionMaintenanceV2).rebuild;
      assert.deepEqual(
        (yield* projections.getThreadProjection(THREAD)).turnItems,
        edited.turnItems,
      );
    }).pipe(Effect.provide(TestLayer)),
);

it.effect("preserves completed and interrupted reasoning as inert historical V2 items", () =>
  Effect.gen(function* () {
    yield* seed;
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO projection_thread_messages (message_id, thread_id, role, text, is_streaming, created_at, updated_at)
      VALUES ('reason-complete', ${THREAD}, 'reasoning', 'First, inspect the evidence.\nThen compare results.', 0, '2026-01-03T06:00:00.000Z', '2026-01-03T07:00:00.000Z'),
      ('reason-partial', ${THREAD}, 'reasoning', 'An unfinished thought…', 1, '2026-01-03T08:00:00.000Z', '2026-01-03T09:00:00.000Z')`;
    const sourceBefore =
      yield* sql`SELECT * FROM projection_thread_messages WHERE thread_id = ${THREAD} ORDER BY message_id`;
    const migration = yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    yield* migration.reconcileShells;
    yield* migration.ensureTranscript(THREAD);
    const projection = yield* projections.getThreadProjection(THREAD);
    const reasoning = projection.turnItems.filter((item) => item.type === "reasoning");
    assert.deepEqual(
      reasoning.map((item) => ({
        text: item.text,
        status: item.status,
        streaming: item.streaming,
        ordinal: item.ordinal,
      })),
      [
        {
          text: "First, inspect the evidence.\nThen compare results.",
          status: "completed",
          streaming: false,
          ordinal: 3,
        },
        { text: "An unfinished thought…", status: "interrupted", streaming: false, ordinal: 4 },
      ],
    );
    for (const item of reasoning) {
      assert.equal(item.runId, null);
      assert.equal(item.nodeId, null);
      assert.equal(item.providerThreadId, null);
      assert.equal(item.providerTurnId, null);
      assert.equal(item.nativeItemRef, null);
    }
    assert.deepEqual(
      projection.messages.map((message) => message.role),
      ["user", "assistant"],
    );
    assert.deepEqual(projection.runs, []);
    assert.deepEqual(projection.providerSessions, []);
    assert.deepEqual(projection.runtimeRequests, []);
    assert.deepEqual(yield* sql`SELECT * FROM orchestration_v2_effect_outbox`, []);
    const sequence = yield* (yield* EventStore.EventStoreV2).latestSequence();
    yield* migration.ensureTranscript(THREAD);
    yield* migration.reconcileShells;
    assert.equal(yield* (yield* EventStore.EventStoreV2).latestSequence(), sequence);
    yield* (yield* ProjectionMaintenance.ProjectionMaintenanceV2).rebuild;
    assert.deepEqual(
      (yield* projections.getThreadProjection(THREAD)).turnItems,
      projection.turnItems,
    );
    assert.deepEqual(
      yield* sql`SELECT * FROM projection_thread_messages WHERE thread_id = ${THREAD} ORDER BY message_id`,
      sourceBefore,
    );
  }).pipe(Effect.provide(TestLayer)),
);

it.live("preserves a V2 edit interleaved between reasoning position repair read and commit", () =>
  Effect.gen(function* () {
    yield* seed;
    const sql = yield* SqlClient.SqlClient;
    const migration = yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const sink = yield* EventSink.EventSinkV2;
    yield* migration.reconcileShells;
    yield* migration.ensureTranscript(THREAD);
    const before = yield* projections.getThreadProjection(THREAD);
    const tool = before.turnItems.find(
      (item) => item.type === "dynamic_tool" && item.toolName === "read_file",
    );
    if (tool?.type !== "dynamic_tool") return assert.fail("Missing imported tool");
    yield* sql`INSERT INTO projection_thread_messages (message_id, thread_id, role, text, is_streaming, created_at, updated_at)
      VALUES ('raced-reason', ${THREAD}, 'reasoning', 'Missing historical reasoning', 0, '2026-01-03T06:00:00.000Z', '2026-01-03T07:00:00.000Z')`;
    yield* sql`UPDATE projection_thread_activities SET turn_id = 'raced-history-turn' WHERE activity_id = 'tool-call'`;
    yield* sql`UPDATE orchestration_v2_legacy_imports SET history_repair_version = 0 WHERE thread_id = ${THREAD}`;
    const repairReady = yield* Deferred.make<void>();
    const releaseRepair = yield* Deferred.make<void>();
    const intercepted = EventSink.EventSinkV2.of({
      ...sink,
      write: (input) =>
        Effect.gen(function* () {
          if (input.events.some((event) => event.id.startsWith("migration:v1:history:position:"))) {
            yield* Deferred.succeed(repairReady, undefined);
            yield* Deferred.await(releaseRepair);
          }
          return yield* sink.write(input);
        }),
    });
    const repair = Effect.gen(function* () {
      yield* (yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter).ensureTranscript(THREAD);
    }).pipe(
      Effect.provide(Layer.fresh(LegacyV1ThreadImporter.layer)),
      Effect.provideService(EventSink.EventSinkV2, intercepted),
    );
    const runningRepair = yield* Effect.forkChild(repair);
    yield* Deferred.await(repairReady);
    yield* sink.write({
      events: [
        {
          id: EventId.make("interleaved-v2-tool-edit"),
          type: "turn-item.updated",
          threadId: THREAD,
          occurredAt: tool.updatedAt,
          payload: { ...tool, title: "Concurrent V2 title", output: "Concurrent V2 result" },
        },
      ],
    });
    yield* Deferred.succeed(releaseRepair, undefined);
    yield* Fiber.join(runningRepair);
    const repaired = yield* projections.getThreadProjection(THREAD);
    assert.deepEqual(
      repaired.turnItems.find((item) => item.id === tool.id),
      {
        ...tool,
        ordinal: 4,
        historyTurnId: TurnId.make("raced-history-turn"),
        title: "Concurrent V2 title",
        output: "Concurrent V2 result",
      },
    );
    yield* (yield* ProjectionMaintenance.ProjectionMaintenanceV2).rebuild;
    assert.deepEqual(
      (yield* projections.getThreadProjection(THREAD)).turnItems,
      repaired.turnItems,
    );
  }).pipe(Effect.provide(TestLayer), Effect.timeout("5 seconds")),
);

it.effect(
  "repairs reasoning omitted by completed imports while preserving V2 edits and native runless history",
  () =>
    Effect.gen(function* () {
      yield* seed;
      const sql = yield* SqlClient.SqlClient;
      const migration = yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const sink = yield* EventSink.EventSinkV2;
      yield* migration.reconcileShells;
      yield* migration.ensureTranscript(THREAD);
      const prior = yield* projections.getThreadProjection(THREAD);
      const tool = prior.turnItems.find(
        (item) => item.type === "dynamic_tool" && item.toolName === "read_file",
      );
      const answer = prior.turnItems.find((item) => item.type === "assistant_message");
      if (tool?.type !== "dynamic_tool" || answer?.type !== "assistant_message")
        return assert.fail("Missing original imported artifacts");
      yield* sink.write({
        events: [
          {
            id: EventId.make("edit-historical-tool"),
            type: "turn-item.updated",
            threadId: THREAD,
            occurredAt: tool.updatedAt,
            payload: { ...tool, output: "V2 edited result", title: "Edited historical tool" },
          },
          {
            id: EventId.make("native-runless-history"),
            type: "turn-item.updated",
            threadId: THREAD,
            occurredAt: answer.updatedAt,
            payload: {
              ...answer,
              id: TurnItemId.make("native-runless-reasoning"),
              type: "reasoning",
              text: "Native V2 reasoning",
              streaming: false,
            },
          },
        ],
      });
      const before = yield* projections.getThreadProjection(THREAD);
      yield* sql`UPDATE orchestration_v2_legacy_imports SET history_repair_version = 0 WHERE thread_id = ${THREAD}`;
      const markerBefore =
        yield* sql`SELECT * FROM orchestration_v2_legacy_imports WHERE thread_id = ${THREAD}`;
      // Add the source row after old hydration to model a completed import made
      // by the prior importer, which excluded reasoning from its frozen snapshot.
      yield* sql`INSERT INTO projection_thread_messages (message_id, thread_id, role, text, is_streaming, created_at, updated_at)
      VALUES ('omitted-reason', ${THREAD}, 'reasoning', 'Historical reasoning omitted before upgrade', 0, '2026-01-03T06:00:00.000Z', '2026-01-03T07:00:00.000Z')`;
      const repair = Effect.gen(function* () {
        const restarted = yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter;
        yield* restarted.ensureTranscript(THREAD);
      }).pipe(Effect.provide(Layer.fresh(LegacyV1ThreadImporter.layer)));
      yield* repair;
      const repaired = yield* projections.getThreadProjection(THREAD);
      assert.deepEqual(
        repaired.turnItems.map((item) => item.ordinal),
        [1, 2, 3, 4, 5, 6, 7, 8, 9],
      );
      const imported = repaired.turnItems.find(
        (item) => item.id === "migration:v1:history:reasoning:omitted-reason",
      );
      if (imported?.type !== "reasoning") return assert.fail("Missing repaired reasoning");
      assert.equal(imported.text, "Historical reasoning omitted before upgrade");
      for (const item of before.turnItems) {
        assert.deepEqual(
          repaired.turnItems.find((next) => next.id === item.id),
          { ...item, ordinal: item.ordinal >= 3 ? item.ordinal + 1 : item.ordinal },
        );
      }
      assert.deepEqual(repaired.messages, before.messages);
      assert.deepEqual(repaired.runs, before.runs);
      assert.deepEqual(repaired.nodes, before.nodes);
      assert.deepEqual(repaired.runtimeRequests, before.runtimeRequests);
      assert.deepEqual(repaired.providerSessions, before.providerSessions);
      assert.deepEqual(
        yield* sql`SELECT * FROM orchestration_v2_legacy_imports WHERE thread_id = ${THREAD}`,
        markerBefore.map((row) => ({
          ...row,
          history_repair_version: LegacyV1ThreadImporter.LEGACY_HISTORY_REPAIR_VERSION,
        })),
      );
      yield* sink.write({
        events: [
          {
            id: EventId.make("edit-repaired-reasoning"),
            type: "turn-item.updated",
            threadId: THREAD,
            occurredAt: imported.updatedAt,
            payload: { ...imported, text: "Reasoning edited in V2" },
          },
        ],
      });
      const edited = yield* projections.getThreadProjection(THREAD);
      const sequence = yield* (yield* EventStore.EventStoreV2).latestSequence();
      yield* repair;
      assert.equal(yield* (yield* EventStore.EventStoreV2).latestSequence(), sequence);
      yield* (yield* ProjectionMaintenance.ProjectionMaintenanceV2).rebuild;
      assert.deepEqual(
        (yield* projections.getThreadProjection(THREAD)).turnItems,
        edited.turnItems,
      );
      yield* repair;
      assert.equal(yield* (yield* EventStore.EventStoreV2).latestSequence(), sequence);
    }).pipe(Effect.provide(TestLayer)),
);

it.effect(
  "retries a partially committed reasoning import without duplicates or execution authority",
  () =>
    Effect.gen(function* () {
      yield* seed;
      const sql = yield* SqlClient.SqlClient;
      for (let index = 0; index < 101; index += 1) {
        const messageId = `reason-${String(index).padStart(3, "0")}`;
        yield* sql`INSERT INTO projection_thread_messages (message_id, thread_id, role, text, is_streaming, created_at, updated_at)
        VALUES (${messageId}, ${THREAD}, 'reasoning', ${`Preserved thought ${index}`}, 0, '2026-01-06T06:00:00.000Z', '2026-01-06T07:00:00.000Z')`;
      }
      const migration = yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      yield* migration.reconcileShells;
      yield* sql`CREATE TRIGGER reject_reasoning BEFORE INSERT ON orchestration_events
      WHEN NEW.event_id = 'migration:v1:history:reasoning:reason-100'
      BEGIN SELECT RAISE(ABORT, 'synthetic reasoning write failure'); END`;
      assert.equal((yield* Effect.exit(migration.ensureTranscript(THREAD)))._tag, "Failure");
      const partial = yield* projections.getThreadProjection(THREAD);
      assert.isAbove(partial.turnItems.filter((item) => item.type === "reasoning").length, 0);
      assert.isFalse(
        partial.turnItems.some((item) => item.id === "migration:v1:history:reasoning:reason-100"),
      );
      const marker = yield* sql<{
        transcript_imported_at: string | null;
        history_repair_version: number;
      }>`SELECT transcript_imported_at, history_repair_version FROM orchestration_v2_legacy_imports WHERE thread_id = ${THREAD}`;
      assert.equal(marker[0]?.transcript_imported_at, null);
      assert.equal(marker[0]?.history_repair_version, 0);
      yield* sql`DROP TRIGGER reject_reasoning`;
      yield* migration.ensureTranscript(THREAD);
      const complete = yield* projections.getThreadProjection(THREAD);
      assert.equal(complete.turnItems.filter((item) => item.type === "reasoning").length, 101);
      assert.equal(
        new Set(complete.turnItems.map((item) => item.id)).size,
        complete.turnItems.length,
      );
      assert.deepEqual(complete.runs, []);
      assert.deepEqual(complete.providerSessions, []);
      assert.deepEqual(complete.runtimeRequests, []);
      assert.deepEqual(yield* sql`SELECT * FROM orchestration_v2_effect_outbox`, []);
      yield* (yield* ProjectionMaintenance.ProjectionMaintenanceV2).rebuild;
      assert.deepEqual(
        (yield* projections.getThreadProjection(THREAD)).turnItems,
        complete.turnItems,
      );
    }).pipe(Effect.provide(TestLayer)),
);

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
        history_repair_version: number;
      }>`SELECT transcript_imported_at, history_repair_version FROM orchestration_v2_legacy_imports WHERE thread_id = ${THREAD}`;
      assert.equal(marker[0]?.transcript_imported_at, null);
      assert.equal(marker[0]?.history_repair_version, 0);
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

it.effect(
  "preserves source turn grouping for every historical item and repairs only missing V2 associations",
  () =>
    Effect.gen(function* () {
      yield* seed;
      const sql = yield* SqlClient.SqlClient;
      const turn = TurnId.make("historical-turn");
      yield* sql`UPDATE projection_thread_messages SET turn_id = ${turn} WHERE thread_id = ${THREAD}`;
      yield* sql`UPDATE projection_thread_activities SET turn_id = ${turn} WHERE thread_id = ${THREAD}`;
      yield* sql`UPDATE projection_pending_approvals SET turn_id = ${turn} WHERE thread_id = ${THREAD}`;
      yield* sql`UPDATE projection_thread_proposed_plans SET turn_id = ${turn} WHERE thread_id = ${THREAD}`;
      yield* sql`INSERT INTO projection_thread_messages (message_id, thread_id, role, text, turn_id, is_streaming, created_at, updated_at)
      VALUES ('grouped-reason', ${THREAD}, 'reasoning', 'Historical reasoning', ${turn}, 0, '2026-01-06T06:00:00.000Z', '2026-01-06T07:00:00.000Z')`;
      const migration = yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const sink = yield* EventSink.EventSinkV2;
      yield* migration.reconcileShells;
      yield* migration.ensureTranscript(THREAD);
      const imported = yield* projections.getThreadProjection(THREAD);
      assert.equal(imported.turnItems.length, 8);
      for (const item of imported.turnItems) assert.equal(item.historyTurnId, turn);
      // Model a completed import produced before historyTurnId was populated.
      // Preserve a user-authored association on one item and all V2 text edits.
      yield* sink.write({
        events: imported.turnItems.map((item) => {
          const { historyTurnId: _historyTurnId, ...old } = item;
          return {
            id: EventId.make(`pre-association:${item.id}`),
            type: "turn-item.updated" as const,
            threadId: THREAD,
            occurredAt: item.updatedAt,
            payload: {
              ...old,
              ...(item.type === "assistant_message"
                ? {
                    text: "Edited answer",
                    historyTurnId: TurnId.make("explicit-v2-group"),
                  }
                : {}),
              ...(item.type === "reasoning" ? { text: "Edited reasoning" } : {}),
            },
          };
        }),
      });
      const repair = Effect.gen(function* () {
        yield* (yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter).ensureTranscript(THREAD);
      }).pipe(Effect.provide(Layer.fresh(LegacyV1ThreadImporter.layer)));
      yield* sql`UPDATE orchestration_v2_legacy_imports SET history_repair_version = 0 WHERE thread_id = ${THREAD}`;
      yield* repair;
      const repaired = yield* projections.getThreadProjection(THREAD);
      for (const item of repaired.turnItems) {
        assert.equal(
          item.historyTurnId,
          item.type === "assistant_message" ? "explicit-v2-group" : turn,
        );
        assert.equal(item.runId, null);
        assert.equal(item.providerThreadId, null);
        assert.equal(item.nativeItemRef, null);
        if (item.type === "assistant_message") assert.equal(item.text, "Edited answer");
        if (item.type === "reasoning") assert.equal(item.text, "Edited reasoning");
      }
      assert.deepEqual(repaired.runtimeRequests, []);
      assert.deepEqual(repaired.providerSessions, []);
      assert.deepEqual(repaired.runs, []);
      const sequence = yield* (yield* EventStore.EventStoreV2).latestSequence();
      yield* repair;
      assert.equal(yield* (yield* EventStore.EventStoreV2).latestSequence(), sequence);
      yield* (yield* ProjectionMaintenance.ProjectionMaintenanceV2).rebuild;
      assert.deepEqual(
        (yield* projections.getThreadProjection(THREAD)).turnItems,
        repaired.turnItems,
      );
      yield* repair;
      assert.equal(yield* (yield* EventStore.EventStoreV2).latestSequence(), sequence);
    }).pipe(Effect.provide(TestLayer)),
);

it.effect(
  "retains edited submitted answers through interrupted generation stamp, compaction and startup retry",
  () =>
    Effect.gen(function* () {
      yield* seed;
      const sql = yield* SqlClient.SqlClient;
      const migration = yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const sink = yield* EventSink.EventSinkV2;
      const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
      yield* migration.reconcileShells;
      yield* migration.ensureTranscript(THREAD);
      yield* sql`UPDATE orchestration_v2_legacy_imports SET history_repair_version = 1 WHERE thread_id = ${THREAD}`;
      yield* sql`INSERT INTO projection_thread_activities (activity_id, thread_id, tone, kind, summary, payload_json, created_at)
      VALUES ('generation-answer', ${THREAD}, 'info', 'user-input.answer-submitted', 'Answered', '{"requestId":"legacy-generation-answer","answers":{"dataset":"Original answer"},"attachmentsByQuestionId":{}}', '2026-01-07T12:00:00.000Z')`;
      yield* sql`CREATE TRIGGER reject_answer_generation BEFORE UPDATE OF history_repair_version ON orchestration_v2_legacy_imports
      WHEN NEW.history_repair_version > 1 BEGIN SELECT RAISE(ABORT, 'interrupted answer generation stamp'); END`;
      const repair = Effect.gen(function* () {
        yield* (yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter).ensureTranscript(THREAD);
      }).pipe(Effect.provide(Layer.fresh(LegacyV1ThreadImporter.layer)));
      assert.equal((yield* Effect.exit(repair))._tag, "Failure");
      const answerId = TurnItemId.make("migration:v1:history:answer:generation-answer");
      const partial = (yield* projections.getThreadProjection(THREAD)).turnItems.find(
        (item) => item.id === answerId,
      );
      if (partial?.type !== "user_input_request" || partial.questionAnswer === undefined)
        return assert.fail("Expected committed answer before failed generation stamp");
      const edited = {
        ...partial,
        title: "V2 edited submitted answer",
        questionAnswer: {
          ...partial.questionAnswer,
          answers: { dataset: "Preserved V2 answer" },
          attachmentsByQuestionId: {},
        },
      };
      yield* sink.write({
        events: [
          {
            id: EventId.make("answer-edited-after-interrupted-stamp"),
            type: "turn-item.updated",
            threadId: THREAD,
            occurredAt: partial.updatedAt,
            payload: edited,
          },
        ],
      });
      yield* maintenance.compactEventStore;
      // The current compactor retains turn-item history; replay must still select the newer V2 answer.
      assert.equal(
        (yield* sql`SELECT event_id FROM orchestration_events WHERE event_id = ${answerId}`).length,
        1,
      );
      yield* maintenance.rebuild;
      yield* sql`DROP TRIGGER reject_answer_generation`;
      yield* repair;
      assert.deepEqual(
        (yield* projections.getThreadProjection(THREAD)).turnItems.find(
          (item) => item.id === answerId,
        ),
        edited,
      );
      const [marker] = yield* sql<{
        history_repair_version: number;
      }>`SELECT history_repair_version FROM orchestration_v2_legacy_imports WHERE thread_id = ${THREAD}`;
      assert.equal(
        marker?.history_repair_version,
        LegacyV1ThreadImporter.LEGACY_HISTORY_REPAIR_VERSION,
      );
      yield* maintenance.rebuild;
      assert.deepEqual(
        (yield* projections.getThreadProjection(THREAD)).turnItems.find(
          (item) => item.id === answerId,
        ),
        edited,
      );
    }).pipe(Effect.provide(TestLayer)),
);

it.live(
  "does not overwrite a submitted answer concurrently committed before its missing-only repair transaction",
  () =>
    Effect.gen(function* () {
      yield* seed;
      const sql = yield* SqlClient.SqlClient;
      const migration = yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const sink = yield* EventSink.EventSinkV2;
      yield* migration.reconcileShells;
      yield* migration.ensureTranscript(THREAD);
      yield* sql`UPDATE orchestration_v2_legacy_imports SET history_repair_version = 1 WHERE thread_id = ${THREAD}`;
      yield* sql`INSERT INTO projection_thread_activities (activity_id, thread_id, tone, kind, summary, payload_json, created_at)
      VALUES ('raced-answer', ${THREAD}, 'info', 'user-input.answer-submitted', 'Answered', '{"requestId":"legacy-raced-answer","answers":{"dataset":"Legacy answer"},"attachmentsByQuestionId":{}}', '2026-01-07T12:00:00.000Z')`;
      const ready = yield* Deferred.make<Parameters<EventSink.EventSinkV2Shape["write"]>[0]>();
      const release = yield* Deferred.make<void>();
      const intercepted = EventSink.EventSinkV2.of({
        ...sink,
        write: (input) =>
          Effect.gen(function* () {
            if (
              input.guardLegacyQuestionInsertions &&
              input.events.some(
                (event) =>
                  event.type === "turn-item.updated" &&
                  event.payload.id === "migration:v1:history:answer:raced-answer",
              )
            ) {
              yield* Deferred.succeed(ready, input);
              yield* Deferred.await(release);
            }
            return yield* sink.write(input);
          }),
      });
      const repair = Effect.gen(function* () {
        yield* (yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter).ensureTranscript(THREAD);
      }).pipe(
        Effect.provide(Layer.fresh(LegacyV1ThreadImporter.layer)),
        Effect.provideService(EventSink.EventSinkV2, intercepted),
      );
      const fiber = yield* Effect.forkChild(repair);
      const input = yield* Deferred.await(ready);
      const event = input.events.find(
        (event) =>
          event.type === "turn-item.updated" &&
          event.payload.id === "migration:v1:history:answer:raced-answer",
      );
      if (
        event?.type !== "turn-item.updated" ||
        event.payload.type !== "user_input_request" ||
        event.payload.questionAnswer === undefined
      )
        return assert.fail("Expected actual repair answer payload");
      const edited = {
        ...event.payload,
        title: "Concurrent V2 answer",
        questionAnswer: {
          ...event.payload.questionAnswer,
          answers: { dataset: "Concurrent choice" },
          attachmentsByQuestionId: {},
        },
      };
      yield* sink.write({
        events: [{ ...event, id: EventId.make("concurrent-answer-owner"), payload: edited }],
      });
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(fiber);
      assert.deepEqual(
        (yield* projections.getThreadProjection(THREAD)).turnItems.find(
          (item) => item.id === edited.id,
        ),
        edited,
      );
      yield* (yield* ProjectionMaintenance.ProjectionMaintenanceV2).rebuild;
      assert.deepEqual(
        (yield* projections.getThreadProjection(THREAD)).turnItems.find(
          (item) => item.id === edited.id,
        ),
        edited,
      );
    }).pipe(Effect.provide(TestLayer), Effect.timeout("10 seconds")),
);

const command = (status: string, data: Record<string, unknown>) =>
  JSON.stringify({
    itemType: "command_execution",
    toolCallId: "call-1",
    status,
    title: "Ran command",
    data,
  });
const seedToolLifecycles = Effect.gen(function* () {
  yield* seed;
  const sql = yield* SqlClient.SqlClient;
  // Real V1 shapes: started and progress rows carry the command, the completed
  // row does not repeat every field; progress rows also report the icon.
  const rows: ReadonlyArray<readonly [string, string, string, string, string]> = [
    [
      "c1-start",
      "tool.started",
      "Ran command started",
      command("inProgress", { command: "ls" }),
      "2026-01-03T01:00:00.000Z",
    ],
    [
      "c1-u1",
      "tool.updated",
      "Ran command",
      command("inProgress", { item: { output: "a" } }),
      "2026-01-03T01:00:01.000Z",
    ],
    [
      "meter",
      "context-window.updated",
      "Context window updated",
      '{"usedTokens":10}',
      "2026-01-03T01:00:01.500Z",
    ],
    [
      "c1-u2",
      "tool.updated",
      "Ran command",
      JSON.stringify({
        itemType: "command_execution",
        toolCallId: "call-1",
        status: "inProgress",
        toolIcon: "terminal",
        data: { item: { output: "ab" } },
      }),
      "2026-01-03T01:00:02.000Z",
    ],
    [
      "c1-done",
      "tool.completed",
      "Ran command",
      command("completed", { toolName: "bash", rawOutput: "ab" }),
      "2026-01-03T01:00:03.000Z",
    ],
    ["checkpoint", "checkpoint.captured", "Checkpoint captured", "{}", "2026-01-03T01:00:04.000Z"],
    [
      "c1-again",
      "tool.completed",
      "Ran command",
      command("failed", { command: "ls missing" }),
      "2026-01-03T01:00:05.000Z",
    ],
    [
      "c2-start",
      "tool.started",
      "Edited file started",
      JSON.stringify({ itemType: "file_change", toolCallId: "call-2", status: "inProgress" }),
      "2026-01-03T01:00:06.000Z",
    ],
    [
      "c3-failing",
      "tool.updated",
      "Searched",
      JSON.stringify({ itemType: "web_search", toolCallId: "call-3", status: "failed" }),
      "2026-01-03T01:00:07.000Z",
    ],
    [
      "task",
      "task.progress",
      "Working",
      '{"taskId":"task-1","summary":"Working"}',
      "2026-01-03T01:00:08.000Z",
    ],
    // A completion that does not repeat the status its progress rows reported.
    [
      "c4-start",
      "tool.started",
      "Read file started",
      JSON.stringify({ itemType: "file_read", toolCallId: "call-4", status: "inProgress" }),
      "2026-01-03T01:00:09.000Z",
    ],
    [
      "c4-done",
      "tool.completed",
      "Read file",
      JSON.stringify({ itemType: "file_read", toolCallId: "call-4" }),
      "2026-01-03T01:00:10.000Z",
    ],
  ];
  for (const [id, kind, summary, payload, createdAt] of rows) {
    yield* sql`INSERT INTO projection_thread_activities (activity_id, thread_id, turn_id, tone, kind, summary, payload_json, sequence, created_at)
      VALUES (${id}, ${THREAD}, 'tool-turn', 'tool', ${kind}, ${summary}, ${payload}, NULL, ${createdAt})`;
  }
});
const activityItem = (id: string) => TurnItemId.make(`migration:v1:history:activity:${id}`);

it.effect("imports one item per tool call with its full content and true outcome", () =>
  Effect.gen(function* () {
    yield* seedToolLifecycles;
    const sql = yield* SqlClient.SqlClient;
    const migration = yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    yield* migration.reconcileShells;
    yield* migration.ensureTranscript(THREAD);
    const projection = yield* projections.getThreadProjection(THREAD);
    const tools = projection.turnItems.filter(
      (item) =>
        item.type === "dynamic_tool" && item.id.startsWith("migration:v1:history:activity:"),
    );
    // Telemetry is gone; each call is one item placed where it started.
    assert.deepEqual(
      tools.map((item) => item.id),
      [
        activityItem("c1-start"),
        activityItem("c1-again"),
        activityItem("c2-start"),
        activityItem("c3-failing"),
        activityItem("task"),
        activityItem("c4-start"),
        activityItem("tool-call"),
      ],
    );
    const call = tools.find((item) => item.id === activityItem("c1-start"));
    assert.ok(call?.type === "dynamic_tool");
    assert.equal(call.status, "completed");
    assert.equal(call.title, "Ran command");
    assert.equal(call.toolName, "tool.completed");
    assert.equal(DateTime.formatIso(call.startedAt!), "2026-01-03T01:00:00.000Z");
    assert.equal(DateTime.formatIso(call.completedAt!), "2026-01-03T01:00:03.000Z");
    const input = call.input as { activityId: string; kind: string; payload: unknown };
    assert.equal(input.activityId, "c1-start");
    assert.equal(input.kind, "tool.completed");
    assert.deepEqual(input.payload, {
      itemType: "command_execution",
      toolCallId: "call-1",
      status: "completed",
      title: "Ran command",
      toolIcon: "terminal",
      data: { toolName: "bash", rawOutput: "ab", item: { output: "ab" }, command: "ls" },
    });
    const status = (id: string) => tools.find((item) => item.id === activityItem(id))?.status;
    assert.equal(status("c1-again"), "failed");
    assert.equal(status("c2-start"), "interrupted");
    assert.equal(status("c3-failing"), "failed");
    assert.equal(status("task"), "completed");
    assert.equal(status("c4-start"), "completed");
    // Export reports the outcome, not a progress status the completion did not repeat.
    const exported = projectWorkLog(
      conversationSnapshotProjection(projection, null).activities,
    ).entries.flatMap((entry) => (entry._tag === "tool" ? [[entry.id, entry.status]] : []));
    assert.deepEqual(
      exported.filter(([id]) => id === activityItem("c4-start")),
      [[activityItem("c4-start"), "completed"]],
    );
    // Every item has its own position, in order, with no gaps left by folded rows.
    const positions = yield* sql<{ turn_item_id: string; ordinal: number }>`
      SELECT turn_item_id, ordinal FROM orchestration_v2_turn_item_positions
      WHERE thread_id = ${THREAD} ORDER BY ordinal`;
    const itemIds = new Set(projection.turnItems.map((item) => item.id));
    assert.isTrue(
      positions.every((position) => itemIds.has(TurnItemId.make(position.turn_item_id))),
    );
    assert.deepEqual(
      positions.map((position) => position.ordinal),
      positions.map((_, index) => index + 1),
    );
    // Importing again changes nothing; a rebuild from the event log matches.
    const sequence = yield* (yield* EventStore.EventStoreV2).latestSequence();
    yield* Effect.gen(function* () {
      yield* (yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter).ensureTranscript(THREAD);
    }).pipe(Effect.provide(Layer.fresh(LegacyV1ThreadImporter.layer)));
    assert.equal(yield* (yield* EventStore.EventStoreV2).latestSequence(), sequence);
    yield* (yield* ProjectionMaintenance.ProjectionMaintenanceV2).rebuild;
    assert.deepEqual(
      (yield* projections.getThreadProjection(THREAD)).turnItems,
      projection.turnItems,
    );
  }).pipe(Effect.provide(TestLayer)),
);

it.effect("keeps a thread an earlier build imported row by row in that shape", () =>
  Effect.gen(function* () {
    yield* seedToolLifecycles;
    const sql = yield* SqlClient.SqlClient;
    const migration = yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const sink = yield* EventSink.EventSinkV2;
    yield* migration.reconcileShells;
    yield* migration.ensureTranscript(THREAD);
    // Model the earlier build's result: a progress row imported as its own item.
    const call = (yield* projections.getThreadProjection(THREAD)).turnItems.find(
      (item) => item.id === activityItem("c1-start"),
    );
    assert.ok(call);
    yield* sink.write({
      events: [
        {
          id: EventId.make(activityItem("c1-u1")),
          type: "turn-item.updated",
          threadId: THREAD,
          occurredAt: call.updatedAt,
          payload: { ...call, id: activityItem("c1-u1") },
        },
      ],
    });
    yield* sql`UPDATE orchestration_v2_legacy_imports SET history_repair_version = 1 WHERE thread_id = ${THREAD}`;
    // A later repair must not leave that item without a position.
    yield* Effect.gen(function* () {
      yield* (yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter).ensureTranscript(THREAD);
    }).pipe(Effect.provide(Layer.fresh(LegacyV1ThreadImporter.layer)));
    const items = (yield* projections.getThreadProjection(THREAD)).turnItems;
    const positioned = new Set(
      (yield* sql<{ turn_item_id: string }>`
        SELECT turn_item_id FROM orchestration_v2_turn_item_positions WHERE thread_id = ${THREAD}`).map(
        (row) => row.turn_item_id,
      ),
    );
    assert.isTrue(items.every((item) => positioned.has(item.id)));
    yield* (yield* ProjectionMaintenance.ProjectionMaintenanceV2).rebuild;
    const repaired = yield* projections.getThreadProjection(THREAD);
    assert.equal(repaired.turnItems.length, items.length);
  }).pipe(Effect.provide(TestLayer)),
);

it.effect("exports the recorded outcome of tool rows that were not folded", () =>
  Effect.gen(function* () {
    yield* seed;
    const sql = yield* SqlClient.SqlClient;
    const migration = yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    // A failed completion without a call id is imported as it is.
    yield* sql`UPDATE projection_thread_activities
      SET payload_json = '{"itemType":"command_execution","status":"failed"}'
      WHERE activity_id = 'tool-call'`;
    yield* migration.reconcileShells;
    yield* migration.ensureTranscript(THREAD);
    const projection = yield* projections.getThreadProjection(THREAD);
    const exported = projectWorkLog(
      conversationSnapshotProjection(projection, null).activities,
    ).entries.flatMap((entry) => (entry._tag === "tool" ? [[entry.id, entry.status]] : []));
    assert.deepEqual(
      exported.filter(([id]) => id === activityItem("tool-call")),
      [[activityItem("tool-call"), "failed"]],
    );
  }).pipe(Effect.provide(TestLayer)),
);

it.effect("keeps a call an earlier build imported only partly in its row-by-row shape", () =>
  Effect.gen(function* () {
    yield* seedToolLifecycles;
    const migration = yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const sink = yield* EventSink.EventSinkV2;
    yield* migration.reconcileShells;
    // An earlier build imported the call's started row, then stopped.
    const startedAt = DateTime.makeUnsafe("2026-01-03T01:00:00.000Z");
    yield* sink.write({
      events: [
        {
          id: EventId.make(activityItem("c1-start")),
          type: "turn-item.updated",
          threadId: THREAD,
          occurredAt: startedAt,
          payload: {
            id: activityItem("c1-start"),
            threadId: THREAD,
            runId: null,
            historyTurnId: TurnId.make("tool-turn"),
            nodeId: null,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: 1,
            status: "completed",
            startedAt,
            completedAt: startedAt,
            updatedAt: startedAt,
            type: "dynamic_tool",
            title: "Ran command started",
            toolName: "tool.started",
            input: { activityId: "c1-start", kind: "tool.started" },
          },
        },
      ],
    });
    yield* migration.ensureTranscript(THREAD);
    const ids = new Set(
      (yield* projections.getThreadProjection(THREAD)).turnItems.map((item) => item.id),
    );
    // The rest of the call is imported row by row, so nothing is lost.
    for (const id of ["c1-u1", "c1-u2", "c1-done", "c1-again"])
      assert.isTrue(ids.has(activityItem(id)), id);
  }).pipe(Effect.provide(TestLayer)),
);

it.effect("keeps a partly imported call whose rows share one kind in its row-by-row shape", () =>
  Effect.gen(function* () {
    yield* seed;
    const sql = yield* SqlClient.SqlClient;
    const migration = yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const sink = yield* EventSink.EventSinkV2;
    for (const [id, output, createdAt] of [
      ["p1", "a", "2026-01-03T02:00:00.000Z"],
      ["p2", "ab", "2026-01-03T02:00:01.000Z"],
    ] as const) {
      const payload = JSON.stringify({
        itemType: "command_execution",
        toolCallId: "call-p",
        status: "inProgress",
        data: { item: { output } },
      });
      yield* sql`INSERT INTO projection_thread_activities (activity_id, thread_id, turn_id, tone, kind, summary, payload_json, sequence, created_at)
        VALUES (${id}, ${THREAD}, 'tool-turn', 'tool', 'tool.updated', 'Ran command', ${payload}, NULL, ${createdAt})`;
    }
    yield* migration.reconcileShells;
    // An earlier build imported the first progress row, then stopped.
    const at = DateTime.makeUnsafe("2026-01-03T02:00:00.000Z");
    yield* sink.write({
      events: [
        {
          id: EventId.make(activityItem("p1")),
          type: "turn-item.updated",
          threadId: THREAD,
          occurredAt: at,
          payload: {
            id: activityItem("p1"),
            threadId: THREAD,
            runId: null,
            historyTurnId: TurnId.make("tool-turn"),
            nodeId: null,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: 1,
            status: "completed",
            startedAt: at,
            completedAt: at,
            updatedAt: at,
            type: "dynamic_tool",
            title: "Ran command",
            toolName: "tool.updated",
            input: { activityId: "p1", kind: "tool.updated" },
          },
        },
      ],
    });
    yield* migration.ensureTranscript(THREAD);
    const ids = new Set(
      (yield* projections.getThreadProjection(THREAD)).turnItems.map((item) => item.id),
    );
    assert.isTrue(ids.has(activityItem("p2")));
  }).pipe(Effect.provide(TestLayer)),
);
