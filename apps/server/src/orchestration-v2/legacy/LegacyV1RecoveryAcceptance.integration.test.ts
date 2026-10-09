// @effect-diagnostics nodeBuiltinImport:off -- SQLite's supported backup API snapshots both disposable databases, including their WALs.
import * as NodeSqlite from "node:sqlite";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { assert, it } from "@effect/vitest";
import {
  ChatAttachmentId,
  CommandId,
  ComposerContextId,
  FileContextRecord,
  ProviderDriverKind,
  ProviderInstanceId,
  ScientThreadQueueItem,
  ThreadId,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import { createPendingAttachmentId, resolveAttachmentPath } from "../../attachmentStore.ts";
import { deriveServerPaths, ServerConfig } from "../../config.ts";
import { layerConfig } from "../../persistence/Sqlite.ts";
import { runMigrations } from "../../persistence/Migrations.ts";
import { legacyQueueFilePath } from "../../scient/threadQueue/Store.ts";
import { readQueue } from "./LegacyQueueLedger.ts";
import { runOrderedV2StartupPhases } from "../../serverRuntimeStartup.ts";
import * as ServerSettings from "../../serverSettings.ts";
import { AcpProviderCapabilitiesV2 } from "@t3tools/provider-acp/server/adapter";
import { makeNativeSessionAdapterV2 } from "../Adapters/NativeSessionAdapterV2.ts";
import * as EffectWorker from "../EffectWorker.ts";
import { EventSinkV2 } from "../EventSink.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { OrchestratorV2 } from "../Orchestrator.ts";
import type { ProviderAdapterV2TurnInput } from "@t3tools/provider-core/server/ProviderAdapter";
import { layerFromAdapters as makeLayer } from "../ProviderAdapterRegistry.ts";
import * as ProjectionMaintenance from "../ProjectionMaintenance.ts";
import * as ProviderRecovery from "../ProviderRuntimeRecoveryService.ts";
import { SCIENT_MIGRATIONS } from "../scient-fork/scientMigrator.ts";
import {
  layerWithRegistry as makeOrchestratorV2ReplayLayerWithRegistry,
  makeReplayServerConfig,
} from "../testkit/ProviderReplayHarness.ts";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import { cutOverLegacyQueues } from "./LegacyQueueCutover.ts";
import { LegacyV1ThreadImporter } from "./LegacyV1ThreadImporter.ts";

const threadId = ThreadId.make("migration-recovery-acceptance");
const instanceId = ProviderInstanceId.make("omp");
const modelSelection = { instanceId, model: "migration-proof-model" };
const attachmentBytes = "Recovered evidence bytes";
const isFileContext = Schema.is(FileContextRecord);
const queueCodec = Schema.fromJsonString(
  Schema.Struct({
    formatVersion: Schema.Literal(1),
    threadId: ThreadId,
    items: Schema.Array(ScientThreadQueueItem),
  }),
);

/** Supported pre-cutover ledgers; current startup must apply Scient 019 and 020 itself. */
const seedV1 = Effect.fn("MigrationAcceptance.seedV1")(function* (filename: string, cwd: string) {
  yield* Effect.scoped(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 52 });
      yield* sql`CREATE TABLE scient_schema_migrations (
        migration_id INTEGER PRIMARY KEY, created_at TEXT NOT NULL DEFAULT current_timestamp,
        name TEXT NOT NULL)`;
      for (const migration of SCIENT_MIGRATIONS.filter((entry) => entry.id <= 18)) {
        yield* sql.withTransaction(
          migration.effect.pipe(
            Effect.andThen(sql`INSERT INTO scient_schema_migrations (migration_id, name)
              VALUES (${migration.id}, ${migration.name})`),
          ),
        );
      }
      yield* sql`INSERT INTO projection_projects
        (project_id, title, workspace_root, scripts_json, created_at, updated_at)
        VALUES ('migration-recovery-project', 'Recovered project', ${cwd}, '[]',
          '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`;
      yield* sql`INSERT INTO projection_threads
        (thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode,
          created_at, updated_at)
        VALUES (${threadId}, 'migration-recovery-project', 'Recovered conversation',
          '{"instanceId":"omp","model":"migration-proof-model"}', 'full-access', 'default',
          '2026-01-01T00:00:00.000Z', '2026-01-08T00:00:00.000Z')`;
      yield* sql`INSERT INTO projection_thread_messages
        (message_id, thread_id, role, text, is_streaming, created_at, updated_at)
        VALUES ('recovered-question', ${threadId}, 'user', 'Historical question', 0,
          '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z'),
          ('recovered-answer', ${threadId}, 'assistant', 'Historical answer', 0,
          '2026-01-08T00:00:00.000Z', '2026-01-08T00:00:00.000Z'),
          ('recovered-reason', ${threadId}, 'reasoning', 'Historical reasoning', 0,
          '2026-01-03T00:00:00.000Z', '2026-01-03T00:00:00.000Z')`;
      yield* sql`INSERT INTO projection_pending_approvals
        (request_id, thread_id, status, decision, created_at, resolved_at)
        VALUES ('recovered-inert-approval', ${threadId}, 'pending', NULL,
          '2026-01-04T00:00:00.000Z', NULL)`;
      yield* sql`INSERT INTO projection_thread_activities
        (activity_id, thread_id, tone, kind, summary, payload_json, sequence, created_at)
        VALUES ('recovered-submitted-answer', ${threadId}, 'info', 'user-input.answer-submitted',
          'Answer submitted',
          '{"requestId":"historical-question","answers":{"dataset":"Measured data"},"questionTextById":{"dataset":"Which dataset?"},"attachmentsByQuestionId":{}}',
          1, '2026-01-05T00:00:00.000Z')`;
      yield* sql`PRAGMA wal_checkpoint(TRUNCATE)`;
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename }))),
  );
});

const waitForProjection = Effect.fn("MigrationAcceptance.waitForProjection")(function* (
  predicate: (projection: OrchestrationV2ThreadProjection) => boolean,
) {
  const orchestrator = yield* OrchestratorV2;
  const cursor = yield* orchestrator.getThreadEventSequence(threadId);
  const pull = yield* Stream.toPull(
    orchestrator.streamStoredEventsFrom({ threadId, afterSequence: cursor }),
  );
  const initial = yield* orchestrator.getThreadProjection(threadId);
  const found = yield* Stream.concat(
    Stream.succeed(initial),
    Stream.fromPull(Effect.succeed(pull)).pipe(
      Stream.mapEffect(() => orchestrator.getThreadProjection(threadId)),
    ),
  ).pipe(Stream.filter(predicate), Stream.runHead, Effect.timeout("15 seconds"));
  if (Option.isNone(found)) return yield* Effect.die("Migration projection did not converge");
  return found.value;
});

const backupDatabase = Effect.fn("MigrationAcceptance.backupDatabase")(function* (
  sourcePath: string,
  destinationPath: string,
) {
  yield* Effect.tryPromise(async () => {
    const database = new NodeSqlite.DatabaseSync(sourcePath, { readOnly: true });
    try {
      await NodeSqlite.backup(database, destinationPath);
    } finally {
      database.close();
    }
  });
});

it.live(
  "requalifies current file-backed migration, held native release, repeat/rebuild and both-database/file restore",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* checkpointWorkspace("migration-recovery-acceptance");
        const initialConfig = yield* makeReplayServerConfig("migration-recovery-acceptance");
        const config: ServerConfig["Service"] = {
          ...initialConfig,
          ...(yield* deriveServerPaths(initialConfig.baseDir, undefined)),
          cwd,
        };
        yield* Effect.addFinalizer(() =>
          fs.remove(config.baseDir, { recursive: true }).pipe(Effect.ignore),
        );
        const v1Path = path.join(config.stateDir, "state.sqlite");
        yield* seedV1(v1Path, cwd);
        const originalV1 = yield* fs.readFile(v1Path);
        const pendingId = ChatAttachmentId.make(createPendingAttachmentId("txt"));
        const attachment = {
          type: "file" as const,
          id: pendingId,
          name: "evidence.txt",
          mimeType: "text/plain",
          sizeBytes: new TextEncoder().encode(attachmentBytes).byteLength,
        };
        const pendingPath = resolveAttachmentPath({
          attachmentsDir: config.attachmentsDir,
          attachment,
        });
        assert.ok(pendingPath);
        yield* fs.writeFileString(pendingPath, attachmentBytes);
        const sourceQueue = yield* Schema.encodeEffect(queueCodec)({
          formatVersion: 1,
          threadId,
          items: ["first", "second"].map((position) => ({
            queueItemId: `qitem_recovery-${position}`,
            text: `Recovered ${position} work`,
            attachments: position === "first" ? [attachment] : [],
            ...(position === "first"
              ? {
                  context: {
                    version: 1 as const,
                    records: [
                      {
                        version: 1 as const,
                        kind: "file" as const,
                        contextId: ComposerContextId.make("recovered-file-context"),
                        label: "evidence.txt",
                        name: "evidence.txt",
                        mimeType: "text/plain",
                        sizeBytes: attachment.sizeBytes,
                        attachmentId: pendingId,
                      },
                    ],
                  },
                }
              : {}),
            selectedScientSkillNames: ["analysis"],
            composerSnapshot: '{"draft":"recovered original"}',
            modelSelection,
            runtimeMode: "approval-required" as const,
            interactionMode: "default" as const,
            sendRequested: true,
            steerRequested: true,
            state: "editing" as const,
            editToken: "obsolete-edit-authority",
            createdAt: "2026-01-09T00:00:00.000Z",
            updatedAt: "2026-01-09T00:00:00.000Z",
          })),
        });
        const queuePath = legacyQueueFilePath(config.stateDir, threadId);
        yield* fs.makeDirectory(path.dirname(queuePath), { recursive: true });
        yield* fs.writeFileString(queuePath, sourceQueue);
        const restoredBase = yield* fs.makeTempDirectoryScoped({ prefix: "t3-migration-restore-" });
        const restoredConfig: ServerConfig["Service"] = {
          ...config,
          baseDir: restoredBase,
          ...(yield* deriveServerPaths(restoredBase, undefined)),
        };
        yield* fs.makeDirectory(restoredConfig.stateDir, { recursive: true });

        interface NativeOffer {
          readonly input: ProviderAdapterV2TurnInput;
          readonly complete: Effect.Effect<void>;
        }
        const runBoot = Effect.fn("MigrationAcceptance.boot")(function* (
          activeConfig: ServerConfig["Service"],
          options: { readonly release: boolean; readonly backup: boolean },
          expected?: OrchestrationV2ThreadProjection,
        ) {
          const allocator = yield* IdAllocator.IdAllocatorV2;
          const offers = yield* Queue.unbounded<NativeOffer>();
          const offered: ProviderAdapterV2TurnInput[] = [];
          const adapter = makeNativeSessionAdapterV2({
            instanceId,
            driver: ProviderDriverKind.make("omp"),
            capabilities: AcpProviderCapabilitiesV2,
            idAllocator: allocator,
            defaultCwd: cwd,
            continuations: { offer: () => Effect.die("No background work in migration fixture") },
            open: (input, publish) =>
              Effect.succeed({
                nativeId: `migration-native:${input.providerSessionId}`,
                nativeThreadKnown: true,
                resume: () => Effect.void,
                respond: () => Effect.die("Historical approvals cannot become live requests"),
                interrupt: Effect.void,
                send: (turn, nativeTurnId) =>
                  Effect.gen(function* () {
                    offered.push(turn);
                    yield* Queue.offer(offers, {
                      input: turn,
                      complete: publish({
                        type: "text",
                        id: nativeTurnId,
                        delta: "Recovered answer",
                      }).pipe(
                        Effect.andThen(publish({ type: "text-completed", id: nativeTurnId })),
                        Effect.andThen(publish({ type: "terminal", status: "completed" })),
                      ),
                    });
                  }),
              }),
          });
          const configLayer = Layer.succeed(ServerConfig, activeConfig);
          const databaseLayer = layerConfig.pipe(
            Layer.provide(configLayer),
            Layer.provide(NodeServices.layer),
          );
          const runtime = makeOrchestratorV2ReplayLayerWithRegistry(
            { name: "migration-recovery-acceptance", runtimePolicyOverride: { cwd } },
            makeLayer([adapter]),
            {
              layerDatabase: databaseLayer,
              layerServerConfig: configLayer,
              runEffectWorker: false,
            },
          );
          const services = Layer.mergeAll(
            runtime,
            databaseLayer,
            IdAllocator.layer,
            ServerSettings.layerTest({ continueThreadsAfterServerUpdate: false }).pipe(Layer.orDie),
          );
          const recovery = ProviderRecovery.layer.pipe(Layer.provideMerge(services));
          const bootLayer = ProjectionMaintenance.layer.pipe(Layer.provideMerge(recovery));
          return yield* Effect.scoped(
            Effect.gen(function* () {
              const importer = yield* LegacyV1ThreadImporter;
              const orchestrator = yield* OrchestratorV2;
              const sink = yield* EventSinkV2;
              const sql = yield* SqlClient.SqlClient;
              const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
              yield* runOrderedV2StartupPhases({
                importLegacyShells: importer.reconcileShells.pipe(
                  Effect.andThen(cutOverLegacyQueues),
                ),
                recover: (yield* ProviderRecovery.ProviderRuntimeRecoveryService).recover,
                recoverDelegatedTasks: orchestrator.recoverDelegatedTasks,
                startEffectWorker: Effect.gen(function* () {
                  assert.equal(yield* (yield* EffectWorker.OrchestrationEffectWorkerV2).drain(), 0);
                  yield* EffectWorker.runDaemon.pipe(Effect.forkScoped);
                }),
                autoBootstrap: Effect.succeed({}),
              });
              const held = yield* orchestrator.getThreadProjection(threadId);
              if (expected !== undefined) assert.deepEqual(held, expected);
              assert.deepEqual(
                held.runs.map((run) => [run.status, run.queueHeld, run.queuePosition]),
                [
                  ["queued", true, 1],
                  ["queued", true, 2],
                ],
              );
              assert.deepEqual(held.providerSessions, []);
              assert.deepEqual(held.runtimeRequests, []);
              assert.isAbove(held.thread.workspaceAuthorityRevision ?? 0, 0);
              const historical = held.turnItems.filter((item) => item.runId === null);
              assert.ok(
                historical.some(
                  (item) => item.type === "reasoning" && item.text === "Historical reasoning",
                ),
              );
              assert.ok(
                historical.some(
                  (item) =>
                    item.type === "dynamic_tool" &&
                    item.toolName === "historical_approval" &&
                    item.status === "interrupted",
                ),
              );
              assert.ok(
                historical.some(
                  (item) =>
                    item.type === "user_input_request" &&
                    item.questionAnswer?.answers.dataset === "Measured data",
                ),
              );
              assert.deepEqual(offered, []);
              assert.equal(yield* orchestrator.resumeQueuedRuns, 0);
              assert.deepEqual((yield* readQueue(threadId)).items, []);
              const migrationRows = yield* sql<{
                migration_id: number;
                name: string;
              }>`SELECT migration_id, name
                FROM scient_schema_migrations WHERE migration_id >= 19 ORDER BY migration_id`;
              assert.deepEqual(
                migrationRows,
                SCIENT_MIGRATIONS.filter((entry) => entry.id >= 19).map((entry) => ({
                  migration_id: entry.id,
                  name: entry.name,
                })),
              );
              assert.equal(
                (yield* sql<{ history_repair_version: number }>`SELECT history_repair_version
                FROM orchestration_v2_legacy_imports WHERE thread_id = ${threadId}`)[0]
                  ?.history_repair_version,
                3,
              );
              const first = held.messages.find(
                (message) => message.text === "Recovered first work",
              );
              assert.ok(first);
              assert.deepEqual(first.selectedScientSkillNames, ["analysis"]);
              assert.equal(first.composerSnapshot, '{"draft":"recovered original"}');
              const owned = first.attachments[0];
              assert.ok(owned);
              assert.notEqual(owned.id, pendingId);
              const ownedPath = resolveAttachmentPath({
                attachmentsDir: activeConfig.attachmentsDir,
                attachment: owned,
              });
              assert.ok(ownedPath);
              assert.equal(yield* fs.readFileString(ownedPath), attachmentBytes);
              const reference = first.context?.records[0];
              assert.ok(isFileContext(reference));
              assert.equal(reference.attachmentId, owned.id);
              const sequence = yield* sink.latestSequence();
              yield* importer.reconcileShells;
              yield* importer.ensureTranscript(threadId);
              assert.equal(yield* cutOverLegacyQueues, 0);
              assert.equal(yield* sink.latestSequence(), sequence);
              assert.isTrue((yield* maintenance.rebuild).valid);
              assert.deepEqual(yield* orchestrator.getThreadProjection(threadId), held);
              if (options.backup) {
                yield* backupDatabase(v1Path, path.join(restoredConfig.stateDir, "state.sqlite"));
                yield* backupDatabase(activeConfig.dbPath, restoredConfig.dbPath);
                yield* fs.copy(activeConfig.attachmentsDir, restoredConfig.attachmentsDir);
                const restoredQueuePath = legacyQueueFilePath(restoredConfig.stateDir, threadId);
                yield* fs.makeDirectory(path.dirname(restoredQueuePath), { recursive: true });
                yield* fs.copy(queuePath, restoredQueuePath);
              }
              if (options.release) {
                yield* orchestrator.dispatch({
                  type: "queue.resume",
                  commandId: CommandId.make("migration-acceptance-resume"),
                  threadId,
                });
                for (const text of ["Recovered first work", "Recovered second work"]) {
                  const offer = yield* Queue.take(offers).pipe(Effect.timeout("15 seconds"));
                  assert.include(offer.input.message.text, text);
                  assert.equal(offer.input.runtimePolicy.runtimeMode, "approval-required");
                  assert.equal(offer.input.runtimePolicy.interactionMode, "default");
                  assert.equal(offer.input.modelSelection.instanceId, instanceId);
                  yield* offer.complete;
                }
                const complete = yield* waitForProjection(
                  (projection) =>
                    projection.runs.length === 2 &&
                    projection.runs.every((run) => run.status === "completed"),
                );
                assert.equal(offered.length, 2);
                const [firstOffer, secondOffer] = offered;
                assert.ok(firstOffer);
                assert.ok(secondOffer);
                assert.notEqual(firstOffer.providerThread.id, secondOffer.providerThread.id);
                assert.equal(
                  firstOffer.providerThread.providerSessionId,
                  secondOffer.providerThread.providerSessionId,
                );
                assert.deepEqual(
                  firstOffer.providerThread.nativeThreadRef,
                  secondOffer.providerThread.nativeThreadRef,
                );
                assert.include(firstOffer.message.text, "Historical question");
                assert.include(offered[0]!.message.text, "Historical answer");
                assert.deepEqual(complete.runtimeRequests, []);
                const after = yield* sink.latestSequence();
                yield* cutOverLegacyQueues;
                assert.equal(yield* sink.latestSequence(), after);
                assert.equal(offered.length, 2);
              }
              return held;
            }).pipe(Effect.provide(bootLayer)),
          );
        });
        const held = yield* runBoot(config, { release: false, backup: false });
        yield* runBoot(config, { release: true, backup: true }, held);
        yield* runBoot(restoredConfig, { release: true, backup: false }, held);
        assert.deepEqual(yield* fs.readFile(v1Path), originalV1);
        assert.equal(yield* fs.readFileString(queuePath), sourceQueue);
        assert.equal(
          yield* fs.readFileString(legacyQueueFilePath(restoredConfig.stateDir, threadId)),
          sourceQueue,
        );
        // Restoring into a separate profile must not replace work completed after the backup.
        yield* Effect.try(() => {
          const database = new NodeSqlite.DatabaseSync(config.dbPath, { readOnly: true });
          try {
            assert.equal(
              database
                .prepare(
                  "SELECT COUNT(*) AS count FROM orchestration_v2_projection_runs WHERE thread_id = ? AND json_extract(payload_json, '$.status') = 'completed'",
                )
                .get(threadId)?.count,
              2,
            );
            assert.deepEqual(database.prepare("PRAGMA integrity_check").get(), {
              integrity_check: "ok",
            });
          } finally {
            database.close();
          }
        });
        yield* Effect.try(() => {
          const database = new NodeSqlite.DatabaseSync(
            path.join(restoredConfig.stateDir, "state.sqlite"),
            { readOnly: true },
          );
          try {
            assert.deepEqual(database.prepare("PRAGMA integrity_check").get(), {
              integrity_check: "ok",
            });
            assert.equal(
              database
                .prepare("SELECT MAX(migration_id) AS version FROM scient_schema_migrations")
                .get()?.version,
              18,
            );
            assert.equal(
              database
                .prepare(
                  "SELECT status FROM projection_pending_approvals WHERE request_id = 'recovered-inert-approval'",
                )
                .get()?.status,
              "pending",
            );
          } finally {
            database.close();
          }
        });
      }).pipe(Effect.provide(Layer.merge(IdAllocator.layer, NodeServices.layer))),
    ),
  60_000,
);
