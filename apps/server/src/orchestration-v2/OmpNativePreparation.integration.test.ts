// @effect-diagnostics nodeBuiltinImport:off
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/process";
import * as SqlClient from "effect/sql/SqlClient";
import { persistChatAttachments } from "../AttachmentPersistence.ts";
import * as ServerConfig from "../config.ts";
import { layerFromPath as makeSqlitePersistenceLive } from "../persistence/Sqlite.ts";
import { ompTarget } from "../provider/omp/OmpTarget.ts";
import { scriptedOmpRpc } from "../provider/testUtils/scriptedOmpRpc.ts";
import { makeOmpAdapterV2 } from "./Adapters/OmpAdapterV2.ts";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import { EffectOutboxV2 } from "./EffectOutbox.ts";
import { CommandReceiptStoreV2 } from "./CommandReceiptStore.ts";
import { OrchestrationEffectWorkerV2 } from "./EffectWorker.ts";
import {
  IdAllocatorV2,
  layer as idAllocatorLayer,
} from "@t3tools/provider-core/server/IdAllocator";
import { OrchestratorV2 } from "./Orchestrator.ts";
import { layerFromAdapters as makeLayer } from "./ProviderAdapterRegistry.ts";
import { ProviderSessionManagerV2 } from "./ProviderSessionManager.ts";
import { layerWithRegistry as makeOrchestratorV2ReplayLayerWithRegistry } from "./testkit/ProviderReplayHarness.ts";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import {
  encodeJson,
  observe,
  waitForThread,
  withNative,
  nativeSettlementTrace,
} from "./testkit/OmpNativeConjunctions.ts";

it.live.each(
  [false, true].map((superseded) => ({
    caseTitle: superseded
      ? "rejects the captured OMP owner after preparation when a newer public turn owns the session"
      : "preserves public healthy OMP steering after held payload preparation",
    superseded,
  })),
)(
  "$caseTitle",
  ({ superseded }) =>
    withNative(`omp-preparation-${superseded ? "superseded" : "healthy"}`, {}, (f) =>
      Effect.gen(function* () {
        const orchestrator = yield* OrchestratorV2;
        const worker = yield* OrchestrationEffectWorkerV2;
        const sessions = yield* ProviderSessionManagerV2;
        const receipts = yield* CommandReceiptStoreV2;
        const outbox = yield* EffectOutboxV2;
        const trace = nativeSettlementTrace(f.threadId, { orchestrator, outbox, receipts });
        trace.admissionCommands.push(
          CommandId.make(`omp-preparation-${superseded ? "superseded" : "healthy"}-start`),
        );
        return yield* Effect.gen(function* () {
          const original = yield* trace.at("original-admission", f.seed);
          yield* trace.drain("original-start-drain", 8, worker.drain(8));
          const peer = f.peers[0]!;
          yield* trace.at(
            "initial-native-prompt-delivered",
            peer.promptDelivered().pipe(Effect.timeout("10 seconds")),
          );
          const active = yield* trace.at(
            "initial-native-acceptance",
            waitForThread(f.threadId, (p) =>
              p.providerTurns.some(
                (t) => t.runAttemptId === original.activeAttemptId && t.acceptedAt !== undefined,
              ),
            ),
          );
          const turn = active.providerTurns[0]!;
          const thread = active.providerThreads.find((t) => t.id === turn.providerThreadId)!;
          const owner = Option.getOrNull(yield* sessions.get(thread.providerSessionId!));
          assert.ok(owner);
          const token = yield* f.fs.readFileString(f.lock());
          yield* trace.drain("original-settlement-drain", 8, worker.drain(8));
          f.holdPreparation();
          const followupId = MessageId.make(`${f.threadId}-followup`);
          const commandId = CommandId.make(`${f.threadId}-steer`);
          // Public effects serialize lifecycle work. Only this superseded-owner
          // negative calls the published native API directly while the worker
          // starts a genuine replacement; it makes no public Steer admission claim.
          const delivery = yield* Effect.gen(function* () {
            if (superseded) {
              yield* owner.steerTurn({
                threadId: f.threadId,
                runId: original.id,
                providerThread: thread,
                providerTurnId: turn.id,
                message: {
                  messageId: followupId,
                  text: "Old captured owner",
                  attachments: [],
                  createdBy: "user",
                  creationSource: "web",
                },
              });
            } else {
              yield* orchestrator.dispatch({
                type: "message.dispatch",
                commandId,
                threadId: f.threadId,
                messageId: followupId,
                text: "Healthy current owner",
                attachments: [],
                selectedScientSkillNames: [],
                dispatchMode: { type: "steer_active", targetRunId: original.id },
                createdBy: "user",
                creationSource: "web",
              });
              assert.equal(
                Option.getOrNull(yield* receipts.getByCommandId(commandId))?.status,
                "accepted",
              );
              yield* worker.runOnce;
            }
          }).pipe(Effect.exit, Effect.forkScoped);
          yield* trace.at(
            "preparation-entered",
            Deferred.await(f.prepEntered).pipe(Effect.timeout("10 seconds")),
          );
          yield* f.snapshot("preparation-held");
          if (superseded) {
            yield* peer.finish();
            yield* trace.at(
              "old-attempt-completed",
              waitForThread(f.threadId, (p) =>
                p.attempts.some(
                  (a) => a.id === original.activeAttemptId && a.status === "completed",
                ),
              ),
            );
            const replacementCommand = CommandId.make(`${f.threadId}-replacement`);
            trace.admissionCommands.push(replacementCommand);
            yield* trace.at(
              "replacement-admission",
              orchestrator.dispatch({
                type: "message.dispatch",
                commandId: replacementCommand,
                threadId: f.threadId,
                messageId: MessageId.make(`${f.threadId}-replacement`),
                text: "New public owner",
                attachments: [],
                selectedScientSkillNames: [],
                dispatchMode: { type: "start_immediately" },
                createdBy: "user",
                creationSource: "web",
              }),
            );
            yield* trace.capture("replacement-before-drain", {
              peers: f.peers.map((p) => p.state),
            });
            yield* trace.drain("replacement-start-drain", 8, worker.drain(8));
            yield* trace.capture("replacement-after-drain", {
              peers: f.peers.map((p) => p.state),
            });
            yield* trace.at(
              "replacement-start-committed",
              waitForThread(f.threadId, (p) =>
                p.runs.some(
                  (run) =>
                    run.userMessageId === `${f.threadId}-replacement` &&
                    (run.status === "starting" || run.status === "running"),
                ),
              ),
            );
            yield* trace.drain("replacement-admitted-drain", 8, worker.drain(8));
            const newer = yield* trace.at(
              "replacement-native-acceptance",
              waitForThread(
                f.threadId,
                (p) =>
                  p.providerTurns.length === 2 &&
                  p.providerTurns.every((t) => t.acceptedAt !== undefined),
              ),
            );
            assert.notEqual(newer.runs[1]!.activeAttemptId, original.activeAttemptId);
            assert.notEqual(newer.providerTurns[1]!.id, turn.id);
            assert.notEqual(
              newer.providerTurns[1]!.nativeTurnRef?.nativeId,
              turn.nativeTurnRef?.nativeId,
            );
            yield* peer.emit([{ type: "agent_start" }]);
            yield* trace.at(
              "replacement-session-running",
              waitForThread(f.threadId, (p) =>
                p.providerSessions.some(
                  (s) => s.id === thread.providerSessionId && s.status === "running",
                ),
              ),
            );
            yield* f.snapshot("newer-owner-before-release");
          }
          yield* Deferred.succeed(f.prepRelease, undefined);
          const exit = yield* trace.at(
            "captured-owner-delivery-join",
            Fiber.join(delivery).pipe(Effect.timeout("10 seconds")),
          );
          if (superseded) {
            assert.isTrue(Exit.isFailure(exit));
            assert.include(encodeJson(exit), "no longer owns this active turn");
            assert.include(encodeJson(exit), '"breaksSession":false');
            assert.deepEqual(
              peer.state.prompts.map((p) => p.frame.type),
              ["prompt", "prompt"],
            );
            assert.equal(peer.state.frames.filter((p) => p.type === "steer").length, 0);
            const current = Option.getOrNull(yield* sessions.get(thread.providerSessionId!));
            assert.strictEqual(current, owner);
            const retained = yield* f.snapshot("superseded-refused");
            assert.equal(
              retained.providerSessions.find((s) => s.id === thread.providerSessionId)?.status,
              "running",
            );
            const newerTurn = retained.providerTurns[1]!;
            const newerRun = retained.runs.find(
              (r) => r.activeAttemptId === newerTurn.runAttemptId,
            )!;
            // Manager publication is a runtime handle, not a mutable status
            // projection. Prove the retained newer generation can still steer.
            yield* current!.steerTurn({
              threadId: f.threadId,
              runId: newerRun.id,
              providerThread: retained.providerThreads.find(
                (t) => t.id === newerTurn.providerThreadId,
              )!,
              providerTurnId: newerTurn.id,
              message: {
                messageId: MessageId.make(`${f.threadId}-newer-steer`),
                text: "Healthy newer captured owner",
                attachments: [],
                createdBy: "user",
                creationSource: "web",
              },
            });
            assert.deepEqual(
              peer.state.prompts.map((p) => p.frame.type),
              ["prompt", "prompt", "steer"],
            );
          } else {
            assert.isTrue(Exit.isSuccess(exit));
            yield* trace.drain("healthy-steer-drain", 8, worker.drain(8));
            assert.deepEqual(
              peer.state.prompts.map((p) => p.frame.type),
              ["prompt", "steer"],
            );
            assert.include(peer.state.prompts[1]!.frame.message ?? "", "Healthy current owner");
            const projection = yield* f.snapshot("healthy-steer-delivered");
            assert.equal(projection.runs.length, 1);
            assert.equal(projection.providerTurns.length, 1);
            assert.equal(projection.messages.filter((m) => m.id === followupId).length, 1);
          }
          assert.equal(yield* f.fs.readFileString(f.lock()), token);
          assert.equal(f.peers.length, 1);
          assert.equal(peer.state.shutdowns, 0);
          yield* peer.finish();
          yield* trace.at(
            "final-attempts-completed",
            waitForThread(f.threadId, (p) => p.attempts.every((a) => a.status === "completed")),
          );
          const final = yield* f.snapshot("terminal-after-release");
          assert.equal(final.providerTurns.length, superseded ? 2 : 1);
          assert.isTrue(final.providerTurns.every((t) => t.status === "completed"));
        }).pipe(
          Effect.onError((cause) => trace.failure(cause, { peers: f.peers.map((p) => p.state) })),
        );
      }),
    ),
  { timeout: 60_000 },
);

it.live(
  "C398 redispatches one exact follow-up prompt when the predecessor completes during actual OMP payload preparation",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const config = yield* ServerConfig.ServerConfig;
        const cwd = yield* checkpointWorkspace("omp-native-conjunction", {
          ".scient/skills/project-method/SKILL.md":
            "---\nname: project-method\ndescription: Controlled OMP conjunction.\n---\n\nRetain exact inputs.\n",
        });
        const home = path.join(config.stateDir, "synthetic-home");
        yield* fs.makeDirectory(home);
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined));
        let holdPreparation = false;
        let sessionRoot = "";
        let launches = 0;
        const instanceId = ProviderInstanceId.make("omp-native-conjunction-instance");
        const threadId = ThreadId.make("omp-native-conjunction-thread");
        const followupId = MessageId.make("omp-native-conjunction-followup");
        const followupCommand = CommandId.make("omp-native-conjunction-steer");
        const selection = {
          instanceId,
          model: "controlled/model",
          options: [{ id: "thinkingLevel", value: "high" }],
        };
        const peer = scriptedOmpRpc({
          models: [
            {
              provider: "controlled",
              id: "model",
              reasoning: true,
              input: ["text", "image"],
              contextWindow: 200_000,
              thinking: { mode: "effort", efforts: ["low", "high"], defaultLevel: "low" },
            },
          ],
          initial: { provider: "controlled", id: "model" },
          environment: { HOME: home },
        });
        const adapter = yield* makeOmpAdapterV2({
          target: ompTarget,
          instanceId,
          settings: { binaryPath: "synthetic-omp", homePath: home },
          environment: { HOME: home },
          fileSystem: fs,
          path,
          crypto: yield* Crypto.Crypto,
          spawner: yield* ChildProcessSpawner.ChildProcessSpawner,
          idAllocator: yield* IdAllocatorV2,
          serverConfig: config,
          continuations: { offer: () => Effect.void },
          nativeEventLogger: {
            filePath: "synthetic-evidence-only",
            write: (event) => observe("native.rpc", event),
            close: () => Effect.void,
          },
          makeProcess: (options) =>
            Effect.gen(function* () {
              launches++;
              sessionRoot = options.sessionDir ?? "";
              yield* observe("native.open", { launches, options });
              const client = yield* peer.makeProcess(options);
              return {
                ...client,
                // The normal generic owner validation has already returned when
                // production OMP payload preparation reaches this transport seam.
                limits: Effect.suspend(() => {
                  if (!holdPreparation) return client.limits;
                  holdPreparation = false;
                  return observe("preparation.entered", { launches }).pipe(
                    Effect.andThen(Deferred.succeed(entered, undefined)),
                    Effect.andThen(Deferred.await(release)),
                    Effect.timeout("10 seconds"),
                    Effect.orDie,
                    Effect.andThen(client.limits),
                  );
                }),
              };
            }),
        });
        const mcpSessions = yield* McpProviderSessions.McpProviderSessions;
        const database = makeSqlitePersistenceLive(config.dbPath).pipe(
          Layer.provide(NodeServices.layer),
        );
        const runtime = makeOrchestratorV2ReplayLayerWithRegistry(
          { name: "omp-native-conjunction", runtimePolicyOverride: { cwd } },
          makeLayer([adapter]),
          {
            databaseLayer: database,
            layerServerConfig: Layer.succeed(ServerConfig.ServerConfig, config),
            configureMcp: false,
            mcpProviderSessionsLayer: Layer.succeed(
              McpProviderSessions.McpProviderSessions,
              mcpSessions,
            ),
            runEffectWorker: false,
          },
        ).pipe(Layer.provideMerge(database));
        yield* Effect.gen(function* () {
          const orchestrator = yield* OrchestratorV2;
          const worker = yield* OrchestrationEffectWorkerV2;
          const receipts = yield* CommandReceiptStoreV2;
          const sessions = yield* ProviderSessionManagerV2;
          const sql = yield* SqlClient.SqlClient;
          const lockPath = () => path.join(sessionRoot, ".session.lock");
          const snapshot = Effect.fnUntraced(function* (phase: string) {
            const projection = yield* orchestrator.getThreadProjection(threadId);
            const tables = yield* sql<{ name: string }>`SELECT name FROM sqlite_master
              WHERE type = 'table' AND name LIKE 'orchestration%' ORDER BY name`;
            const rows: Record<string, unknown> = {};
            for (const { name } of tables)
              rows[name] = yield* sql.unsafe(`SELECT * FROM "${name}"`);
            const owner = projection.providerSessions[0];
            const current = owner ? yield* sessions.get(owner.id) : Option.none();
            const files: Record<string, string> = {};
            if (sessionRoot && (yield* fs.exists(sessionRoot))) {
              for (const name of yield* fs.readDirectory(sessionRoot)) {
                const file = path.join(sessionRoot, name);
                if ((yield* fs.stat(file)).type === "File")
                  files[name] = yield* fs.readFileString(file);
              }
            }
            yield* observe(phase, {
              projection,
              rows,
              files,
              launches,
              publishedOwner: Option.isSome(current) ? current.value.providerSession : null,
              wire: peer.state.frames,
              nativeState: peer.state,
            });
            return projection;
          });
          const waitFor = Effect.fnUntraced(function* (
            predicate: (projection: OrchestrationV2ThreadProjection) => boolean,
          ) {
            const cursor = yield* orchestrator.getThreadEventSequence(threadId);
            const pull = yield* Stream.toPull(
              orchestrator.streamStoredEventsFrom({
                threadId,
                afterSequence: cursor,
              }),
            );
            const found = yield* Stream.concat(
              Stream.fromEffect(orchestrator.getThreadProjection(threadId)),
              Stream.fromPull(Effect.succeed(pull)).pipe(
                Stream.mapEffect(() => orchestrator.getThreadProjection(threadId)),
              ),
            ).pipe(Stream.filter(predicate), Stream.runHead, Effect.timeout("10 seconds"));
            if (Option.isNone(found)) return yield* Effect.die("Native SQL did not converge");
            return found.value;
          });
          yield* Effect.addFinalizer(() =>
            Deferred.succeed(release, undefined).pipe(
              Effect.andThen(sessions.closeInstance(instanceId)),
              Effect.andThen(
                Effect.gen(function* () {
                  yield* observe("cleanup.closed", {
                    shutdowns: peer.state.shutdowns,
                    lockExists: sessionRoot ? yield* fs.exists(lockPath()) : false,
                    launches,
                  });
                }),
              ),
              Effect.orDie,
            ),
          );
          yield* orchestrator.dispatch({
            type: "thread.create",
            commandId: CommandId.make("omp-native-conjunction-create"),
            threadId,
            projectId: ProjectId.make("omp-native-conjunction-project"),
            title: "Actual native preparation race",
            modelSelection: selection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            createdBy: "user",
            creationSource: "web",
          });
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make("omp-native-conjunction-start"),
            threadId,
            messageId: MessageId.make("omp-native-conjunction-first"),
            text: "Foreground",
            attachments: [],
            selectedScientSkillNames: [],
            dispatchMode: { type: "start_immediately" },
            createdBy: "user",
            creationSource: "web",
          });
          yield* worker.drain(8);
          yield* peer.promptDelivered().pipe(Effect.timeout("10 seconds"));
          yield* peer.emit([{ type: "agent_start" }]);
          const active = yield* waitFor((p) =>
            p.providerTurns.some((t) => t.acceptedAt !== undefined),
          );
          const first = active.runs[0]!;
          const firstTurn = active.providerTurns[0]!;
          assert.equal(firstTurn.runAttemptId, first.activeAttemptId);
          const token = yield* fs.readFileString(lockPath());
          const bytes = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
          const attachments = yield* persistChatAttachments({
            threadId,
            messageId: followupId,
            attachments: [
              {
                type: "image",
                name: "current.png",
                mimeType: "image/png",
                sizeBytes: bytes.length,
                dataUrl: `data:image/png;base64,${Buffer.from(bytes).toString("base64")}`,
              },
            ],
          });
          yield* worker.drain(8);
          holdPreparation = true;
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            commandId: followupCommand,
            threadId,
            messageId: followupId,
            text: "$project-method inspect the current image exactly once.",
            attachments,
            selectedScientSkillNames: ["project-method"],
            dispatchMode: { type: "steer_active", targetRunId: first.id },
            createdBy: "user",
            creationSource: "web",
          });
          assert.equal(
            Option.getOrNull(yield* receipts.getByCommandId(followupCommand))?.status,
            "accepted",
          );
          const delivery = yield* worker.runOnce.pipe(Effect.forkScoped);
          yield* Deferred.await(entered).pipe(Effect.timeout("10 seconds"));
          const prepared = yield* snapshot("sql.preparation-held");
          assert.equal(
            prepared.providerTurns.find((t) => t.id === firstTurn.id)?.status,
            "running",
          );
          assert.deepEqual(
            peer.state.prompts.map((p) => p.frame.type),
            ["prompt"],
          );
          yield* peer.finish();
          // The provider-turn update precedes the subscriber's canonical
          // terminal transaction. Await that exact attempt, not its queue hint.
          yield* waitFor(
            (p) =>
              p.providerTurns.some((t) => t.id === firstTurn.id && t.status === "completed") &&
              p.attempts.some((a) => a.id === first.activeAttemptId && a.status === "completed"),
          );
          const terminal = yield* snapshot("sql.terminal-before-release");
          assert.equal(
            terminal.attempts.find((a) => a.id === first.activeAttemptId)?.status,
            "completed",
          );
          assert.equal(yield* fs.readFileString(lockPath()), token);
          yield* Deferred.succeed(release, undefined);
          yield* Fiber.join(delivery).pipe(Effect.timeout("10 seconds"));
          yield* worker.drain(16);
          // The terminal consumer admits the successor after checkpoint capture.
          // With the daemon disabled, join that commit before driving its start.
          yield* waitFor((p) =>
            p.runs.some(
              (run) =>
                run.userMessageId === followupId &&
                (run.status === "starting" || run.status === "running"),
            ),
          );
          yield* worker.drain(16);
          const final = yield* snapshot("sql.delivery-after-release");
          // Outbox completion precedes the adapter's forked native prompt.
          // Join its correlated acceptance before counting delivered frames.
          const accepted = yield* waitFor(
            (p) =>
              p.providerTurns.length === 2 &&
              p.providerTurns.every((t) => t.acceptedAt !== undefined),
          ).pipe(
            Effect.onError(() =>
              snapshot("sql.native-acceptance-failed").pipe(
                Effect.catchCause((cause) =>
                  Effect.logWarning("C398 native acceptance observer failed", { cause }),
                ),
              ),
            ),
          );
          yield* snapshot("sql.native-acceptance-before-frame-assertions");
          assert.deepEqual(
            peer.state.prompts.map((p) => p.frame.type),
            ["prompt", "prompt"],
          );
          assert.equal(peer.state.frames.filter((f) => f.type === "steer").length, 0);
          const message = accepted.messages.find((m) => m.id === followupId)!;
          const followup = accepted.runs.find((r) => r.id === message.runId)!;
          assert.equal(accepted.messages.filter((m) => m.id === followupId).length, 1);
          assert.equal(final.messages.filter((m) => m.id === followupId).length, 1);
          assert.notEqual(followup.id, first.id);
          assert.notEqual(followup.activeAttemptId, first.activeAttemptId);
          const followupTurn = accepted.providerTurns.find(
            (t) => t.runAttemptId === followup.activeAttemptId,
          )!;
          assert.notEqual(followupTurn.id, firstTurn.id);
          assert.notEqual(followupTurn.nativeTurnRef?.nativeId, firstTurn.nativeTurnRef?.nativeId);
          assert.deepEqual(followup.modelSelection, selection);
          assert.equal(followup.runtimeMode, "full-access");
          assert.equal(followup.interactionMode, "default");
          assert.deepEqual(message.attachments, attachments);
          assert.deepEqual(message.selectedScientSkillNames, ["project-method"]);
          assert.equal(message.text, "$project-method inspect the current image exactly once.");
          assert.include(peer.state.prompts[1]!.frame.message ?? "", message.text);
          const expectedImages = [
            {
              type: "image",
              data: Buffer.from(bytes).toString("base64"),
              mimeType: "image/png",
            },
          ];
          assert.deepEqual(peer.state.prompts[1]!.frame.images, expectedImages);
          assert.equal(peer.state.thinkingLevel, "high");
          assert.equal(yield* fs.readFileString(lockPath()), token);
          assert.equal(launches, 1);
        }).pipe(Effect.provide(runtime));
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            NodeServices.layer,
            idAllocatorLayer,
            McpProviderSessions.layer,
            ServerConfig.layerTest(process.cwd(), { prefix: "scient-omp-conjunction-" }).pipe(
              Layer.provide(NodeServices.layer),
            ),
          ),
        ),
      ),
    ),
  { timeout: 60_000 },
);
