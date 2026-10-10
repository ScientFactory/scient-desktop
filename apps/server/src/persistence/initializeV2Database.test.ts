// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import * as SqlitePersistence from "./Sqlite.ts";
import { runMigrations } from "./Migrations.ts";
import { initializeV2Database } from "./initializeV2Database.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as LegacyV1ThreadImporter from "../orchestration-v2/legacy/LegacyV1ThreadImporter.ts";

it.effect(
  "snapshots V1, imports transcripts lazily, and preserves both databases across switches",
  () => {
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-v1-v2-"));
    const sourcePath = NodePath.join(directory, "state.sqlite");
    const destinationPath = NodePath.join(directory, "statev2.sqlite");
    const threadId = ThreadId.make("legacy-thread");
    const seed = Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 52 });
      yield* sql`INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at)
      VALUES ('project', 'Project', '/tmp/project', '[]', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`;
      yield* sql`INSERT INTO projection_threads (thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode, created_at, updated_at)
      VALUES (${threadId}, 'project', 'V1 thread', '{"instanceId":"codex","model":"gpt-5.4"}', 'full-access', 'default', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`;
      for (let index = 0; index < 6; index++) {
        yield* sql`INSERT INTO projection_thread_messages (message_id, thread_id, role, text, is_streaming, created_at, updated_at)
        VALUES (${`message-${index}`}, ${threadId}, ${index % 2 ? "assistant" : "user"}, ${`Text ${index}`}, 0, ${`2026-01-0${index + 1}T00:00:00.000Z`}, ${`2026-01-0${index + 1}T00:00:00.000Z`})`;
      }
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: sourcePath })));

    return Effect.gen(function* () {
      yield* seed;
      const original = NodeFS.readFileSync(sourcePath);
      const config = yield* ServerConfig.ServerConfig;
      const layerDatabase = SqlitePersistence.layerConfig.pipe(
        Layer.provide(ServerConfig.layer({ ...config, dbPath: destinationPath })),
      );
      const layerStores = Layer.mergeAll(EventStore.layer, ProjectionStore.layer).pipe(
        Layer.provideMerge(layerDatabase),
      );
      const layerSink = EventSink.layer.pipe(Layer.provide(layerStores));
      const layerImporter = LegacyV1ThreadImporter.layer.pipe(
        Layer.provideMerge(Layer.mergeAll(layerStores, layerSink)),
      );
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const legacy = yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter;
        yield* legacy.reconcileShells;
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        const shell = yield* projections.getThreadProjection(threadId);
        assert.equal(shell.thread.id, threadId);
        assert.deepEqual(
          shell.messages.map((message) => message.text),
          ["Text 4", "Text 5"],
        );
        const pending =
          yield* sql`SELECT transcript_imported_at FROM orchestration_v2_legacy_imports`;
        assert.equal(pending[0]?.transcript_imported_at, null);
        yield* legacy.ensureTranscript(threadId);
        const transcript = yield* projections.getThreadProjection(threadId);
        assert.deepEqual(
          transcript.messages.map((message) => message.text),
          ["Text 0", "Text 1", "Text 2", "Text 3", "Text 4", "Text 5"],
        );
        const imported =
          yield* sql`SELECT imported_message_count, transcript_imported_at FROM orchestration_v2_legacy_imports`;
        assert.equal(imported[0]?.imported_message_count, 6);
        assert.isNotNull(imported[0]?.transcript_imported_at);
        yield* sql`CREATE TABLE v2_work (text TEXT)`;
        yield* sql`INSERT INTO v2_work VALUES ('Keep V2 work')`;
      }).pipe(Effect.provide(layerImporter));
      assert.deepEqual(NodeFS.readFileSync(sourcePath), original);
      const v1 = new NodeSqlite.DatabaseSync(sourcePath);
      try {
        assert.equal(
          v1.prepare("SELECT MAX(migration_id) AS id FROM effect_sql_migrations").get()?.id,
          52,
        );
        assert.equal(
          v1
            .prepare(
              "SELECT count(*) AS count FROM sqlite_master WHERE name = 'orchestration_v2_legacy_imports'",
            )
            .get()?.count,
          0,
        );
        v1.exec("UPDATE projection_threads SET title = 'Continued in V1'");
        v1.exec(`
          INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at)
          VALUES ('later-project', 'Later project', '/tmp/later', '[]', '2026-02-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z');
          INSERT INTO projection_threads (thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode, created_at, updated_at)
          VALUES ('post-snapshot-thread', 'later-project', 'Added after the snapshot', '{"instanceId":"codex","model":"gpt-5.4"}', 'full-access', 'default', '2026-02-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z');
          INSERT INTO projection_thread_messages (message_id, thread_id, role, text, is_streaming, created_at, updated_at)
          VALUES ('later-user', 'post-snapshot-thread', 'user', 'Retained user message', 0, '2026-02-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z'),
            ('later-assistant', 'post-snapshot-thread', 'assistant', 'Retained answer', 0, '2026-02-01T00:00:01.000Z', '2026-02-01T00:00:01.000Z'),
            ('later-reasoning', 'post-snapshot-thread', 'reasoning', 'Retained reasoning', 0, '2026-02-01T00:00:00.500Z', '2026-02-01T00:00:00.500Z');
        `);
      } finally {
        v1.close();
      }
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        assert.equal((yield* sql`SELECT text FROM v2_work`)[0]?.text, "Keep V2 work");
        assert.equal(
          (yield* sql`SELECT title FROM projection_threads`)[0]?.title,
          "Continued in V1",
        );
      }).pipe(Effect.provide(layerDatabase));
      const afterV1Continuation = NodeFS.readFileSync(sourcePath);
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const legacy = yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter;
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        const laterThreadId = ThreadId.make("post-snapshot-thread");
        assert.equal(yield* legacy.pendingThreadCount, 2);
        yield* legacy.reconcileShells;
        yield* legacy.ensureTranscript(laterThreadId);
        const restored = yield* projections.getThreadProjection(laterThreadId);
        assert.equal(restored.thread.title, "Added after the snapshot");
        assert.equal(restored.thread.projectId, "later-project");
        assert.deepEqual(
          restored.messages.map((message) => message.text),
          ["Retained user message", "Retained answer"],
        );
        assert.isTrue(restored.turnItems.some((item) => item.type === "reasoning"));
        yield* legacy.ensureTranscript(threadId);
        assert.equal(yield* legacy.pendingThreadCount, 0);
        assert.equal(
          (yield* projections.getThreadProjection(threadId)).thread.title,
          "Continued in V1",
        );
        assert.equal((yield* sql`SELECT text FROM v2_work`)[0]?.text, "Keep V2 work");
      }).pipe(Effect.provide(layerImporter));
      assert.deepEqual(NodeFS.readFileSync(sourcePath), afterV1Continuation);
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

it.effect("includes committed WAL data and does not publish a failed snapshot", () => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-v2-snapshot-"));
  const sourcePath = NodePath.join(directory, "state.sqlite");
  const destinationPath = NodePath.join(directory, "statev2.sqlite");
  return Effect.gen(function* () {
    NodeFS.writeFileSync(sourcePath, "invalid SQLite");
    assert.isTrue((yield* Effect.result(initializeV2Database(destinationPath)))._tag === "Failure");
    assert.isFalse(NodeFS.existsSync(destinationPath));
    NodeFS.unlinkSync(sourcePath);
    const source = new NodeSqlite.DatabaseSync(sourcePath);
    try {
      source.exec(
        "PRAGMA journal_mode=WAL; CREATE TABLE messages(text TEXT); INSERT INTO messages VALUES ('committed'); BEGIN; INSERT INTO messages VALUES ('uncommitted');",
      );
      yield* initializeV2Database(destinationPath);
      const copy = new NodeSqlite.DatabaseSync(destinationPath, { readOnly: true });
      try {
        assert.deepEqual(
          copy
            .prepare("SELECT text FROM messages")
            .all()
            .map((row) => row.text),
          ["committed"],
        );
      } finally {
        copy.close();
      }
      source.exec("ROLLBACK");
    } finally {
      source.close();
    }
  }).pipe(
    Effect.provide(NodeServices.layer),
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(directory, { recursive: true, force: true }))),
  );
});

it.effect("uses statev2.sqlite for default and explicit development paths", () =>
  Effect.gen(function* () {
    for (const devUrl of [undefined, new URL("http://localhost:5173")]) {
      for (const baseDirIsExplicit of [false, true]) {
        const paths = yield* ServerConfig.deriveServerPaths("/tmp/t3", devUrl, {
          baseDirIsExplicit,
        });
        assert.equal(NodePath.basename(paths.dbPath), "statev2.sqlite");
        assert.equal(paths.settingsPath, NodePath.join(paths.stateDir, "settings.json"));
      }
    }
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("starts fresh without V1 and never imports over existing V2 state", () => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-v2-fresh-"));
  const destinationPath = NodePath.join(directory, "userdata", "statev2.sqlite");
  return Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const layerDatabase = SqlitePersistence.layerConfig.pipe(
      Layer.provide(ServerConfig.layer({ ...config, dbPath: destinationPath })),
    );
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE v2_work (text TEXT)`;
      yield* sql`INSERT INTO v2_work VALUES ('fresh V2 work')`;
    }).pipe(Effect.provide(layerDatabase));
    const sourcePath = NodePath.join(NodePath.dirname(destinationPath), "state.sqlite");
    assert.isFalse(NodeFS.existsSync(sourcePath));
    NodeFS.writeFileSync(sourcePath, "This source must never be opened once V2 exists");
    yield* initializeV2Database(destinationPath);
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      assert.equal((yield* sql`SELECT text FROM v2_work`)[0]?.text, "fresh V2 work");
    }).pipe(Effect.provide(layerDatabase));
  }).pipe(
    Effect.provide(
      ServerConfig.layerTest(directory, directory).pipe(Layer.provideMerge(NodeServices.layer)),
    ),
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(directory, { recursive: true, force: true }))),
  );
});

it.effect(
  "publishes one snapshot under concurrent startup and restores independent V1/V2 work",
  () => {
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "scient-v2-recovery-"));
    const sourcePath = NodePath.join(directory, "state.sqlite");
    const destinationPath = NodePath.join(directory, "statev2.sqlite");
    const source = new NodeSqlite.DatabaseSync(sourcePath);
    source.exec(
      "CREATE TABLE messages(text TEXT); INSERT INTO messages VALUES ('legacy conversation')",
    );
    source.close();
    return Effect.gen(function* () {
      yield* Effect.all(
        [initializeV2Database(destinationPath), initializeV2Database(destinationPath)],
        { concurrency: 2 },
      );
      const v1 = new NodeSqlite.DatabaseSync(sourcePath);
      const v2 = new NodeSqlite.DatabaseSync(destinationPath);
      try {
        v1.exec("INSERT INTO messages VALUES ('continued in V1')");
        v2.exec("INSERT INTO messages VALUES ('continued in V2')");
        const recovery = NodePath.join(directory, "recovery");
        NodeFS.mkdirSync(recovery);
        yield* Effect.promise(() => NodeSqlite.backup(v1, NodePath.join(recovery, "state.sqlite")));
        yield* Effect.promise(() =>
          NodeSqlite.backup(v2, NodePath.join(recovery, "statev2.sqlite")),
        );
        v2.exec("INSERT INTO messages VALUES ('after backup')");
        yield* initializeV2Database(NodePath.join(recovery, "statev2.sqlite"));
        const restoredV1 = new NodeSqlite.DatabaseSync(NodePath.join(recovery, "state.sqlite"), {
          readOnly: true,
        });
        const restoredV2 = new NodeSqlite.DatabaseSync(NodePath.join(recovery, "statev2.sqlite"), {
          readOnly: true,
        });
        try {
          assert.deepEqual(
            restoredV1
              .prepare("SELECT text FROM messages ORDER BY rowid")
              .all()
              .map((row) => row.text),
            ["legacy conversation", "continued in V1"],
          );
          assert.deepEqual(
            restoredV2
              .prepare("SELECT text FROM messages ORDER BY rowid")
              .all()
              .map((row) => row.text),
            ["legacy conversation", "continued in V2"],
          );
          assert.equal(restoredV1.prepare("PRAGMA integrity_check").get()?.integrity_check, "ok");
          assert.equal(restoredV2.prepare("PRAGMA integrity_check").get()?.integrity_check, "ok");
          assert.deepEqual(
            v2
              .prepare("SELECT text FROM messages ORDER BY rowid")
              .all()
              .map((row) => row.text),
            ["legacy conversation", "continued in V2", "after backup"],
          );
        } finally {
          restoredV1.close();
          restoredV2.close();
        }
      } finally {
        v1.close();
        v2.close();
      }
    }).pipe(
      Effect.provide(NodeServices.layer),
      Effect.ensuring(
        Effect.sync(() => NodeFS.rmSync(directory, { recursive: true, force: true })),
      ),
    );
  },
);
