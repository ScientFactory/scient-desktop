// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import ReconciliationSchema from "../orchestration-v2/scient-fork/migrations/024_LegacySourceReconciliation.ts";

import { refreshLegacyV1Snapshot } from "./refreshLegacyV1Snapshot.ts";

const fixture = () => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "scient-stale-snapshot-"));
  const sourcePath = NodePath.join(directory, "state.sqlite");
  const destinationPath = NodePath.join(directory, "statev2.sqlite");
  const source = new NodeSqlite.DatabaseSync(sourcePath);
  const destination = new NodeSqlite.DatabaseSync(destinationPath);
  const schema = `
    CREATE TABLE projection_projects(project_id TEXT PRIMARY KEY, title TEXT);
    CREATE TABLE projection_threads(thread_id TEXT PRIMARY KEY, project_id TEXT, title TEXT, deleted_at TEXT);
    CREATE TABLE projection_thread_messages(message_id TEXT PRIMARY KEY, thread_id TEXT, text TEXT);
    CREATE TABLE projection_thread_activities(activity_id TEXT PRIMARY KEY, thread_id TEXT, payload_json TEXT);
    CREATE TABLE scient_thread_lineage(thread_id TEXT PRIMARY KEY, forked_from_thread_id TEXT);
    CREATE TABLE provider_session_runtime(thread_id TEXT PRIMARY KEY, status TEXT);
    CREATE TABLE scient_thread_queue(thread_id TEXT PRIMARY KEY, document TEXT);
  `;
  source.exec(schema);
  destination.exec(`${schema}
    CREATE TABLE orchestration_v2_projection_threads(thread_id TEXT PRIMARY KEY, title TEXT, deleted_at TEXT,
      payload_json TEXT DEFAULT '{"historyOrigin":"v1_import"}');
    CREATE TABLE orchestration_v2_legacy_imports(thread_id TEXT PRIMARY KEY, transcript_imported_at TEXT, history_repair_version INTEGER, last_error TEXT);
    CREATE TABLE orchestration_v2_events(event_id TEXT PRIMARY KEY, payload_json TEXT);`);
  const initialize = ReconciliationSchema.pipe(
    Effect.provide(NodeSqliteClient.layer({ filename: destinationPath })),
  );
  return { directory, sourcePath, destinationPath, source, destination, initialize };
};

it.effect(
  "recovers post-snapshot conversations without overwriting V2 or resurrecting deleted threads",
  () => {
    const f = fixture();
    f.source.exec(`PRAGMA journal_mode=WAL;
    INSERT INTO projection_projects VALUES ('project', 'V1 project');
    INSERT INTO projection_projects VALUES ('later-project', 'Later project');
    INSERT INTO projection_threads VALUES ('old', 'project', 'V1 renamed', NULL);
    INSERT INTO projection_threads VALUES ('missing', 'later-project', 'Missing conversation', NULL);
    INSERT INTO projection_threads VALUES ('deleted-v1', 'project', 'Deleted V1', '2026-10-10');
    INSERT INTO projection_threads VALUES ('deleted-v2', 'project', 'Deleted V2', NULL);
    INSERT INTO projection_thread_messages VALUES ('missing-message', 'missing', 'Preserved transcript');
    INSERT INTO projection_thread_activities VALUES ('tool', 'missing', '{"result":"kept"}');
    INSERT INTO scient_thread_lineage VALUES ('missing', 'old');
    INSERT INTO provider_session_runtime VALUES ('missing', 'running');
    INSERT INTO scient_thread_queue VALUES ('missing', 'do not execute');`);
    f.destination.exec(`
    INSERT INTO projection_projects VALUES ('project', 'V2 project');
    INSERT INTO projection_threads VALUES ('old', 'project', 'Snapshot title', NULL);
    INSERT INTO orchestration_v2_projection_threads (thread_id,title,deleted_at) VALUES ('old', 'V2 renamed', NULL);
    INSERT INTO orchestration_v2_projection_threads (thread_id,title,deleted_at) VALUES ('deleted-v2', 'V2 tombstone', '2026-10-10');
    INSERT INTO orchestration_v2_events VALUES ('native-event', '{"message":"V2 work"}');`);
    const beforeSource = f.source
      .prepare("SELECT * FROM projection_threads ORDER BY thread_id")
      .all();
    return Effect.gen(function* () {
      yield* f.initialize;
      assert.equal(yield* refreshLegacyV1Snapshot(f.destinationPath), 2);
      assert.deepEqual(f.destination.prepare("SELECT * FROM projection_thread_messages").all(), [
        { message_id: "missing-message", thread_id: "missing", text: "Preserved transcript" },
      ]);
      assert.equal(
        f.destination.prepare("SELECT title FROM projection_threads WHERE thread_id = 'old'").get()
          ?.title,
        "V1 renamed",
      );
      assert.equal(
        f.destination
          .prepare("SELECT title FROM orchestration_v2_projection_threads WHERE thread_id = 'old'")
          .get()?.title,
        "V2 renamed",
      );
      assert.equal(
        f.destination
          .prepare("SELECT title FROM projection_projects WHERE project_id = 'project'")
          .get()?.title,
        "V2 project",
      );
      assert.equal(
        f.destination
          .prepare("SELECT title FROM projection_projects WHERE project_id = 'later-project'")
          .get()?.title,
        "Later project",
      );
      assert.equal(
        f.destination.prepare("SELECT count(*) AS n FROM provider_session_runtime").get()?.n,
        0,
      );
      assert.equal(
        f.destination.prepare("SELECT count(*) AS n FROM scient_thread_queue").get()?.n,
        0,
      );
      assert.equal(
        f.destination.prepare("SELECT count(*) AS n FROM orchestration_v2_events").get()?.n,
        1,
      );
      assert.equal(
        f.destination.prepare("SELECT forked_from_thread_id FROM scient_thread_lineage").get()
          ?.forked_from_thread_id,
        "old",
      );
      assert.equal(
        f.destination.prepare("SELECT count(*) AS n FROM projection_thread_activities").get()?.n,
        1,
      );
      assert.equal(
        f.destination
          .prepare("SELECT count(*) AS n FROM projection_threads WHERE thread_id LIKE 'deleted-%'")
          .get()?.n,
        0,
      );
      assert.deepEqual(
        f.source.prepare("SELECT * FROM projection_threads ORDER BY thread_id").all(),
        beforeSource,
      );
      assert.equal(yield* refreshLegacyV1Snapshot(f.destinationPath), 0);
    }).pipe(
      Effect.provide(NodeServices.layer),
      Effect.ensuring(
        Effect.sync(() => {
          f.source.close();
          f.destination.close();
          NodeFS.rmSync(f.directory, { recursive: true, force: true });
        }),
      ),
    );
  },
);

it.effect("rescans event-free history when thread count and update time have not changed", () => {
  const f = fixture();
  for (const db of [f.source, f.destination]) {
    db.exec(`ALTER TABLE projection_threads ADD COLUMN updated_at TEXT;
      CREATE TABLE projection_thread_proposed_plans(plan_id TEXT PRIMARY KEY, thread_id TEXT, plan_markdown TEXT);`);
  }
  f.source.exec(`INSERT INTO projection_projects VALUES ('project', 'Project');
    INSERT INTO projection_threads VALUES ('thread', 'project', 'Title', NULL, '2026-01-01');
    INSERT INTO projection_thread_messages VALUES ('message', 'thread', 'Original text');
    INSERT INTO projection_thread_proposed_plans VALUES ('plan', 'thread', '# Original plan');`);
  return Effect.gen(function* () {
    yield* f.initialize;
    assert.equal(yield* refreshLegacyV1Snapshot(f.destinationPath), 1);
    const metadata = f.source
      .prepare("SELECT count(*) AS count, max(updated_at) AS updated FROM projection_threads")
      .get();
    f.source.exec(`UPDATE projection_thread_messages SET text = 'Edited text';
      UPDATE projection_thread_proposed_plans SET plan_markdown = '# Edited plan';`);
    assert.deepEqual(
      f.source
        .prepare("SELECT count(*) AS count, max(updated_at) AS updated FROM projection_threads")
        .get(),
      metadata,
    );
    assert.equal(yield* refreshLegacyV1Snapshot(f.destinationPath), 1);
    assert.equal(
      f.destination.prepare("SELECT text FROM projection_thread_messages").get()?.text,
      "Edited text",
    );
    assert.equal(
      f.destination.prepare("SELECT plan_markdown FROM projection_thread_proposed_plans").get()
        ?.plan_markdown,
      "# Edited plan",
    );
    assert.equal(yield* refreshLegacyV1Snapshot(f.destinationPath), 0);
  }).pipe(
    Effect.provide(NodeServices.layer),
    Effect.ensuring(
      Effect.sync(() => {
        f.source.close();
        f.destination.close();
        NodeFS.rmSync(f.directory, { recursive: true, force: true });
      }),
    ),
  );
});

it.effect("rolls back all recovery inputs on a conflicting historical message identity", () => {
  const f = fixture();
  f.source.exec(`
    INSERT INTO projection_projects VALUES ('project', 'New project');
    INSERT INTO projection_threads VALUES ('missing', 'project', 'Missing', NULL);
    INSERT INTO projection_thread_messages VALUES ('collision', 'missing', 'V1 text');`);
  f.destination.exec(
    "INSERT INTO projection_thread_messages VALUES ('collision', 'existing', 'Keep existing text')",
  );
  return Effect.gen(function* () {
    yield* f.initialize;
    const result = yield* Effect.result(refreshLegacyV1Snapshot(f.destinationPath));
    assert.equal(result._tag, "Failure");
    assert.equal(f.destination.prepare("SELECT count(*) AS n FROM projection_threads").get()?.n, 0);
    assert.equal(
      f.destination.prepare("SELECT count(*) AS n FROM projection_projects").get()?.n,
      0,
    );
    assert.equal(
      f.destination.prepare("SELECT text FROM projection_thread_messages").get()?.text,
      "Keep existing text",
    );
  }).pipe(
    Effect.provide(NodeServices.layer),
    Effect.ensuring(
      Effect.sync(() => {
        f.source.close();
        f.destination.close();
        NodeFS.rmSync(f.directory, { recursive: true, force: true });
      }),
    ),
  );
});

it.effect(
  "uses V1 thread ancestry, reads committed WAL revisions, and retains removed source before-images",
  () => {
    const f = fixture();
    f.source.exec(`PRAGMA journal_mode=WAL;
    ALTER TABLE projection_threads ADD COLUMN updated_at TEXT;
    CREATE TABLE orchestration_events(sequence INTEGER PRIMARY KEY, event_id TEXT);
    INSERT INTO orchestration_events VALUES (5, 'v1-baseline');
    INSERT INTO projection_projects VALUES ('project', 'Project');
    INSERT INTO projection_threads VALUES ('old', 'project', 'Original', NULL, '2026-01-01');
    INSERT INTO projection_thread_messages VALUES ('removed', 'old', 'Old rewindable text');`);
    f.destination.exec(`ALTER TABLE projection_threads ADD COLUMN updated_at TEXT;
    CREATE TABLE orchestration_events(sequence INTEGER PRIMARY KEY, event_id TEXT, aggregate_kind TEXT, application_event_version INTEGER);
    INSERT INTO orchestration_events VALUES (5, 'v1-baseline', 'thread', 1), (30, 'native-v2-project', 'project', 1);
    INSERT INTO projection_projects VALUES ('project', 'Project');
    INSERT INTO projection_threads VALUES ('old', 'project', 'Original', NULL, '2026-01-01');
    INSERT INTO projection_thread_messages VALUES ('removed', 'old', 'Old rewindable text');
    INSERT INTO orchestration_v2_projection_threads(thread_id, title, deleted_at) VALUES ('old', 'Original', NULL);`);
    return Effect.gen(function* () {
      yield* f.initialize;
      assert.equal(yield* refreshLegacyV1Snapshot(f.destinationPath), 0);
      f.source.exec(`BEGIN; DELETE FROM projection_thread_messages;
      INSERT INTO projection_thread_messages VALUES ('new', 'old', 'Committed later');
      INSERT INTO orchestration_events VALUES (6, 'v1-rewind');`);
      assert.equal(yield* refreshLegacyV1Snapshot(f.destinationPath), 0);
      assert.equal(
        f.destination.prepare("SELECT message_id FROM projection_thread_messages").get()
          ?.message_id,
        "removed",
      );
      f.source.exec("COMMIT");
      assert.equal(yield* refreshLegacyV1Snapshot(f.destinationPath), 1);
      assert.equal(
        f.destination.prepare("SELECT message_id FROM projection_thread_messages").get()
          ?.message_id,
        "new",
      );
      assert.equal(
        f.destination
          .prepare(
            "SELECT after_json FROM scient_legacy_reconciliation_changes WHERE row_key = '[\"removed\"]'",
          )
          .get()?.after_json,
        null,
      );
      assert.isString(
        f.destination
          .prepare(
            "SELECT before_json FROM scient_legacy_reconciliation_changes WHERE row_key = '[\"removed\"]'",
          )
          .get()?.before_json,
      );
      assert.equal(yield* refreshLegacyV1Snapshot(f.destinationPath), 0);
      f.destination.exec("DELETE FROM orchestration_events WHERE aggregate_kind = 'thread'");
      f.source.exec(
        "UPDATE orchestration_events SET event_id = 'different-profile' WHERE sequence = 6",
      );
      assert.equal(
        (yield* Effect.result(refreshLegacyV1Snapshot(f.destinationPath)))._tag,
        "Failure",
      );
      assert.equal(
        f.destination.prepare("SELECT message_id FROM projection_thread_messages").get()
          ?.message_id,
        "new",
      );
      f.source.exec("DROP TABLE orchestration_events");
      assert.equal(
        (yield* Effect.result(refreshLegacyV1Snapshot(f.destinationPath)))._tag,
        "Failure",
      );
    }).pipe(
      Effect.provide(NodeServices.layer),
      Effect.ensuring(
        Effect.sync(() => {
          f.source.close();
          f.destination.close();
          NodeFS.rmSync(f.directory, { recursive: true, force: true });
        }),
      ),
    );
  },
);
