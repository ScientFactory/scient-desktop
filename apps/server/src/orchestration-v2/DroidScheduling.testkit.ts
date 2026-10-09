/** Actual Droid ACP writes through V2 command, restart and queue ownership. */
import { assert } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  DroidSettings,
  EventId,
  type ServerProvider,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2StoredEvent,
} from "@t3tools/contracts";
import type { ProviderAdapterV2Event } from "@t3tools/provider-core/server/ProviderAdapter";
import { resolveSelfInvocation } from "@t3tools/shared/nodeRuntime";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { ChildProcessSpawner } from "effect/process";
import * as SqlClient from "effect/sql/SqlClient";
import type { AcpProtocolLogEvent } from "effect-acp/protocol";
import type { AcpSessionRequestLogEvent } from "@t3tools/provider-acp/server/AcpSessionRuntime";
import * as Config from "../config.ts";
import * as ScientTestProviderHost from "./testkit/ScientTestProviderHost.ts";
import { makeDroidAcpRuntime } from "../provider/acp/DroidAcpSupport.ts";
import { scriptedDroid } from "../provider/testUtils/scriptedDroid.ts";
import { makeDroidAdapterV2 } from "./Adapters/DroidAdapterV2.ts";
import { OrchestrationEffectWorkerV2 } from "./EffectWorker.ts";
import { layer as idAllocatorLayer } from "@t3tools/provider-core/server/IdAllocator";
import { OrchestratorV2, type OrchestratorV2Error } from "./Orchestrator.ts";
import { layerFromAdapters as makeLayer } from "./ProviderAdapterRegistry.ts";
import { layerWithRegistry as makeOrchestratorV2ReplayLayerWithRegistry } from "./testkit/ProviderReplayHarness.ts";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";

import { EventSinkV2 } from "./EventSink.ts";
import { EventStoreV2 } from "./EventStore.ts";
import { layerMemory as SqlitePersistenceMemory } from "../persistence/Sqlite.ts";
import { layer as threadCommandExecutorLayer } from "./ThreadCommandExecutor.ts";
import { ProjectCloneTracker } from "../project/ProjectCloneTracker.ts";
import { ProviderRegistry } from "../provider/ProviderRegistry.ts";
import {
  ConversationImporter,
  conversationContentDigest,
} from "../scient/conversationImport/ConversationImporter.ts";
import { layer as conversationImporterLayer } from "../scient/conversationImport/ConversationImporterLive.ts";
import { layer as conversationImportCommitLayer } from "../scient/conversationImport/ConversationImportCommit.ts";
import {
  importFixture,
  principal,
  testLease,
} from "../scient/conversationImport/conversationImport.test-fixtures.ts";

export const importedQuestion = "Which city did we pick for the workshop?";
export const importedAnswer = "We picked Poseidonis for the workshop.";
const decodeDroidSettings = Schema.decodeEffect(DroidSettings);
export const encodeUnknownJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const instanceId = ProviderInstanceId.make("droid-native-scheduling");
const threadId = ThreadId.make("thread:droid-native-scheduling");
export const selection = { instanceId, model: "droid-native" };
const fixtureServices = Layer.mergeAll(
  NodeServices.layer,
  idAllocatorLayer,
  Config.layerTest(process.cwd(), { prefix: "droid-native-scheduling-" }).pipe(
    Layer.provide(NodeServices.layer),
  ),
);
const outer = ScientTestProviderHost.layer.pipe(Layer.provideMerge(fixtureServices));
export const withDroid = <A, E, R>(
  body: string,
  run: (h: {
    threadId: ThreadId;
    orchestrator: OrchestratorV2["Service"];
    worker: OrchestrationEffectWorkerV2["Service"];
    send: (
      text: string,
      mode?: "start_immediately" | "queue_after_active" | "steer_active",
      model?: string,
    ) => ReturnType<OrchestratorV2["Service"]["dispatch"]>;
    stop: () => Effect.Effect<void, OrchestratorV2Error>;
    waitFor: (
      p: (projection: OrchestrationV2ThreadProjection) => boolean,
    ) => Effect.Effect<OrchestrationV2ThreadProjection, OrchestratorV2Error>;
    preparationEntered: Effect.Effect<void>;
    admissionGuard: () => Effect.Effect<boolean>;
    releasePreparation: Effect.Effect<boolean>;
    log: Effect.Effect<ReadonlyArray<{ method?: string; params?: Record<string, unknown> }>>;
    injectEvent: (event: ProviderAdapterV2Event) => Effect.Effect<void>;
    teardownEntered: Effect.Effect<void>;
    releaseTeardown: Effect.Effect<boolean>;
    pids: ReadonlyArray<number>;
    nativeEvents: ReadonlyArray<ProviderAdapterV2Event>;
    requests: ReadonlyArray<AcpSessionRequestLogEvent>;
    protocol: ReadonlyArray<AcpProtocolLogEvent>;
    observe: (
      phase: string,
      commandResult?: unknown,
    ) => Effect.Effect<{
      projection: OrchestrationV2ThreadProjection;
      ownership: ReadonlyArray<ReadonlyArray<{ payload_json: string }>>;
      events: ReadonlyArray<OrchestrationV2StoredEvent>;
      effects: ReadonlyArray<{
        effect_id: string;
        command_id: string;
        effect_type: string;
        payload_json: string;
        status: string;
      }>;
    }>;
  }) => Effect.Effect<A, E, R>,
  options: {
    manualWorker?: boolean;
    holdModel?: boolean;
    holdFirstModel?: boolean;
    injectEvents?: boolean;
    importHistory?: boolean;
    holdTeardown?: boolean;
    receiptName?: string;
  } = {},
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const cwd = yield* checkpointWorkspace("droid-native-scheduling");
      const injected = yield* Queue.unbounded<ProviderAdapterV2Event>();
      const peer = yield* scriptedDroid(body);
      const config = yield* Config.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const receiptDirectory = process.env.DROID_SCHED_RECEIPTS;
      const record = (phase: string, value: unknown) =>
        receiptDirectory === undefined || options.receiptName === undefined
          ? Effect.void
          : fs
              .makeDirectory(receiptDirectory, { recursive: true })
              .pipe(
                Effect.andThen(
                  fs.writeFileString(
                    `${receiptDirectory}/${options.receiptName}-${phase}.json`,
                    JSON.stringify(value, null, 2) + "\n",
                  ),
                ),
                Effect.orDie,
              );
      const pids: number[] = [];
      const exits: Array<Fiber.Fiber<unknown>> = [];
      const nativeEvents: ProviderAdapterV2Event[] = [];
      const requests: AcpSessionRequestLogEvent[] = [];
      const protocol: AcpProtocolLogEvent[] = [];
      const trackedSpawner = ChildProcessSpawner.make((command) =>
        spawner.spawn(command).pipe(
          Effect.tap((handle) =>
            Effect.gen(function* () {
              pids.push(Number(handle.pid));
              exits.push(yield* handle.exitCode.pipe(Effect.exit, Effect.forkDetach));
            }),
          ),
        ),
      );
      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          const exitResults = yield* Effect.forEach(exits, (exit) =>
            Fiber.join(exit).pipe(Effect.timeout("5 seconds"), Effect.orDie),
          );
          for (const pid of pids) assert.throws(() => process.kill(pid, 0), /ESRCH/u);
          yield* record("cleanup", { pids, exitResults, gone: true });
        }),
      );
      const entered = yield* Deferred.make<void>(),
        released = yield* Deferred.make<void>();
      const teardownEntered = yield* Deferred.make<void>(),
        teardownReleased = yield* Deferred.make<void>();
      let admissionGuard = () => Effect.succeed(false);
      const nativeAdapter = yield* makeDroidAdapterV2({
        testHooks: {
          afterHardTeardownTransportDrained: () =>
            options.holdTeardown
              ? Deferred.succeed(teardownEntered, undefined).pipe(
                  Effect.andThen(Deferred.await(teardownReleased)),
                )
              : Effect.void,
        },
        instanceId,
        settings: yield* decodeDroidSettings({
          enabled: true,
          binaryPath: peer.binaryPath,
        }),
        environment: { PATH: process.env.PATH },
        sensitiveEnvironmentValues: [],
        makeRuntime: (input) =>
          makeDroidAcpRuntime({
            ...input,
            requestLogger: (event) =>
              Effect.sync(() => {
                requests.push(event);
              }),
            protocolLogging: {
              logIncoming: true,
              logOutgoing: true,
              logger: (event) =>
                Effect.sync(() => {
                  protocol.push(event);
                }),
            },
          }).pipe(
            Effect.map((runtime) => ({
              ...runtime,
              setModel: (model) =>
                (options.holdModel || options.holdFirstModel) && model === "droid-other"
                  ? Deferred.succeed(entered, undefined).pipe(
                      Effect.andThen(Deferred.await(released)),
                      Effect.andThen(runtime.setModel(model)),
                    )
                  : runtime.setModel(model),
            })),
          ),
        childProcessSpawner: trackedSpawner,
        selfInvocation: yield* resolveSelfInvocation(),
        onAuthenticationRejected: () => Effect.die("No authentication in scheduling peer"),
      });
      const adapter = {
        ...nativeAdapter,
        openSession: (input: Parameters<typeof nativeAdapter.openSession>[0]) =>
          nativeAdapter.openSession(input).pipe(
            Effect.map((runtime) => ({
              ...runtime,
              events: (options.injectEvents
                ? runtime.events.pipe(
                    Stream.merge(Stream.fromQueue(injected), { haltStrategy: "left" }),
                  )
                : runtime.events
              ).pipe(
                Stream.tap((event) =>
                  Effect.sync(() => {
                    nativeEvents.push(event);
                  }),
                ),
              ),
              startTurn: (turn: Parameters<typeof runtime.startTurn>[0]) => {
                admissionGuard = turn.shouldStartProviderTurn ?? (() => Effect.succeed(false));
                return runtime.startTurn(turn);
              },
            })),
          ),
      };
      const nativeLayer = makeOrchestratorV2ReplayLayerWithRegistry(
        { name: "droid-native-scheduling", runtimePolicyOverride: { cwd } },
        makeLayer([adapter]),
        {
          configureMcp: false,
          layerDatabase: SqlitePersistenceMemory,
          runEffectWorker: !options.manualWorker,
          layerServerConfig: Layer.succeed(Config.ServerConfig, config),
          responseStreamingMode: options.injectEvents ? "paragraph" : "turn",
        },
      );
      const configured: ServerProvider = {
        instanceId,
        driver: ProviderDriverKind.make("droid"),
        enabled: true,
        installed: true,
        version: null,
        status: "ready",
        auth: { status: "authenticated" },
        checkedAt: "2026-10-05T00:00:00.000Z",
        models: [],
        slashCommands: [],
        skills: [],
      };
      const layer = conversationImporterLayer.pipe(
        Layer.provideMerge(conversationImportCommitLayer),
        Layer.provide(Layer.mock(ProviderRegistry, { getProviders: Effect.succeed([configured]) })),
        Layer.provide(Layer.mock(ProjectCloneTracker, { get: () => Effect.succeed(null) })),
        Layer.provideMerge(nativeLayer),
        Layer.provideMerge(threadCommandExecutorLayer),
        Layer.provideMerge(SqlitePersistenceMemory),
      );
      return yield* Effect.gen(function* () {
        const orchestrator = yield* OrchestratorV2,
          worker = yield* OrchestrationEffectWorkerV2;
        const sql = yield* SqlClient.SqlClient;
        const eventStore = yield* EventStoreV2;
        let currentThreadId = threadId;
        if (options.importHistory) {
          const now = DateTime.formatIso(yield* DateTime.now);
          const projectId = ProjectId.make("droid-project");
          yield* (yield* EventSinkV2).commitProjectCommand({
            commandId: CommandId.make("droid-import-project"),
            projectId,
            commandType: "project.create",
            acceptedAt: yield* DateTime.now,
            event: {
              eventId: EventId.make("droid-import-project-event"),
              type: "project.created",
              aggregateKind: "project",
              aggregateId: projectId,
              occurredAt: now,
              commandId: null,
              causationEventId: null,
              correlationId: null,
              metadata: {},
              payload: {
                projectId,
                title: "Droid imported history",
                workspaceRoot: cwd,
                defaultModelSelection: null,
                scripts: [],
                createdAt: now,
                updatedAt: now,
              },
            },
          });
          const fixture = importFixture({ turns: 1 });
          const changedSnapshot = {
            ...fixture.input.snapshot,
            proposedPlans: [],
            messages: fixture.input.snapshot.messages.map((message) => ({
              ...message,
              text: message.role === "user" ? importedQuestion : importedAnswer,
            })),
          };
          const digest = conversationContentDigest(changedSnapshot);
          const { lease } = testLease({
            fixture: {
              ...fixture,
              input: {
                ...fixture.input,
                snapshot: { ...changedSnapshot, contentDigest: digest },
                package: { ...fixture.input.package, contentDigest: digest },
              },
            },
            attemptDirectory: `${config.stateDir}/conversation-imports/native-droid-history`,
          });
          const imported = yield* (yield* ConversationImporter).importConversation(lease, {
            destination: {
              projectId,
              modelSelection: selection,
              runtimeMode: "full-access",
              interactionMode: "default",
            },
            principal: principal(),
          });
          currentThreadId = imported.result.threadId;
          const history = yield* orchestrator.getThreadProjection(currentThreadId);
          assert.deepEqual(
            history.messages.map((message) => message.text),
            [importedQuestion, importedAnswer],
          );
          assert.lengthOf(history.runs, 0);
          assert.lengthOf(history.providerTurns, 0);
        } else
          yield* orchestrator.dispatch({
            type: "thread.create",
            commandId: CommandId.make("droid-create"),
            threadId,
            projectId: ProjectId.make("droid-project"),
            title: "Droid scheduling",
            modelSelection: selection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            createdBy: "user",
            creationSource: "web",
          });
        const waitFor = (predicate: (p: OrchestrationV2ThreadProjection) => boolean) =>
          Effect.scoped(
            Effect.gen(function* () {
              const cursor = yield* orchestrator.getThreadEventSequence(currentThreadId);
              const pull = yield* Stream.toPull(
                orchestrator.streamStoredEventsFrom({
                  threadId: currentThreadId,
                  afterSequence: cursor,
                }),
              );
              const initial = yield* orchestrator.getThreadProjection(currentThreadId);
              const found = yield* Stream.concat(
                Stream.succeed(initial),
                Stream.fromPull(Effect.succeed(pull)).pipe(
                  Stream.mapEffect(() => orchestrator.getThreadProjection(currentThreadId)),
                ),
              ).pipe(
                Stream.filter(predicate),
                Stream.runHead,
                Effect.timeout("15 seconds"),
                Effect.catchTags({
                  TimeoutError: () => Effect.die("Missing native Droid scheduling receipt"),
                }),
              );
              assert.ok(Option.isSome(found));
              return found.value;
            }),
          );
        return yield* run({
          threadId: currentThreadId,
          orchestrator,
          worker,
          waitFor,
          send: (text, mode = "start_immediately", model = selection.model) =>
            Effect.gen(function* () {
              const projection = yield* orchestrator.getThreadProjection(currentThreadId);
              return yield* orchestrator.dispatch({
                type: "message.dispatch",
                commandId: CommandId.make(`send:${text}`),
                threadId: currentThreadId,
                messageId: MessageId.make(`message:${text}`),
                text,
                attachments: [],
                dispatchMode:
                  mode === "steer_active"
                    ? {
                        type: "steer_active",
                        targetRunId: projection.runs.find((r) =>
                          ["starting", "running", "waiting"].includes(r.status),
                        )!.id,
                      }
                    : { type: mode },
                modelSelection: { instanceId, model },
                createdBy: "user",
                creationSource: "web",
              });
            }),
          stop: () =>
            Effect.gen(function* () {
              const p = yield* orchestrator.getThreadProjection(currentThreadId);
              yield* orchestrator.dispatch({
                type: "run.interrupt",
                commandId: CommandId.make(
                  `droid-stop:${p.runs.find((r) => ["starting", "running", "waiting"].includes(r.status))!.id}`,
                ),
                threadId: currentThreadId,
                runId: p.runs.find((r) => ["starting", "running", "waiting"].includes(r.status))!
                  .id,
              });
            }),
          preparationEntered: Deferred.await(entered),
          admissionGuard: () => admissionGuard(),
          releasePreparation: Deferred.succeed(released, undefined),
          log: peer.readLog(),
          injectEvent: (event) => Queue.offer(injected, event).pipe(Effect.asVoid),
          teardownEntered: Deferred.await(teardownEntered),
          releaseTeardown: Deferred.succeed(teardownReleased, undefined),
          pids,
          nativeEvents,
          requests,
          protocol,
          observe: (phase, commandResult) =>
            Effect.gen(function* () {
              const projection = yield* orchestrator.getThreadProjection(currentThreadId);
              const ownership = yield* Effect.all([
                sql<{
                  payload_json: string;
                }>`SELECT payload_json FROM orchestration_v2_projection_runs WHERE thread_id = ${currentThreadId} ORDER BY ordinal`,
                sql<{
                  payload_json: string;
                }>`SELECT payload_json FROM orchestration_v2_projection_run_attempts WHERE thread_id = ${currentThreadId} ORDER BY run_id, attempt_ordinal`,
                sql<{
                  payload_json: string;
                }>`SELECT payload_json FROM orchestration_v2_projection_nodes WHERE thread_id = ${currentThreadId} ORDER BY node_id`,
                sql<{
                  payload_json: string;
                }>`SELECT payload_json FROM orchestration_v2_projection_messages WHERE thread_id = ${currentThreadId} ORDER BY message_id`,
                sql<{
                  payload_json: string;
                }>`SELECT payload_json FROM orchestration_v2_projection_checkpoint_scopes WHERE thread_id = ${currentThreadId} ORDER BY scope_id`,
                sql<{
                  payload_json: string;
                }>`SELECT payload_json FROM orchestration_v2_projection_checkpoints WHERE thread_id = ${currentThreadId} ORDER BY checkpoint_id`,
              ]);
              const events = yield* eventStore
                .read({ threadId: currentThreadId })
                .pipe(Stream.runCollect);
              const effects = yield* sql<{
                effect_id: string;
                command_id: string;
                effect_type: string;
                payload_json: string;
                status: string;
              }>`SELECT effect_id, command_id, effect_type, payload_json, status FROM orchestration_v2_effect_outbox WHERE thread_id = ${currentThreadId} ORDER BY effect_id`;
              yield* record(phase, {
                phase,
                commandResult,
                projection,
                ownershipTables: [
                  "runs",
                  "attempts",
                  "nodes",
                  "messages",
                  "checkpointScopes",
                  "checkpoints",
                ],
                ownership,
                events,
                effects,
                nativeEvents,
                requests,
                protocol,
                log: yield* peer.readLog(),
                pids,
                cwd,
              });
              return { projection, ownership, events, effects };
            }).pipe(Effect.orDie),
        }).pipe(
          Effect.onError((cause) =>
            Effect.gen(function* () {
              const projection = yield* orchestrator.getThreadProjection(currentThreadId);
              const events = yield* eventStore
                .read({ threadId: currentThreadId })
                .pipe(Stream.runCollect);
              yield* record("failure-before-cleanup", {
                cause,
                projection,
                events,
                nativeEvents,
                requests,
                protocol,
                log: yield* peer.readLog(),
                pids,
              });
            }).pipe(Effect.ignoreCause),
          ),
        );
      }).pipe(Effect.provide(layer));
    }),
  ).pipe(Effect.provide(outer));

export const promptTexts = (
  log: ReadonlyArray<{ method?: string; params?: Record<string, unknown> }>,
) =>
  log
    .filter((row) => row.method === "session/prompt")
    .map((row) => (row.params?.prompt as ReadonlyArray<{ text?: string }> | undefined)?.[0]?.text)
    .map((text) => text?.match(/<user_request>\n([\s\S]*)\n<\/user_request>$/u)?.[1] ?? text);
export const waiting = `const pending = [];
function onPrompt(message) { if ((message.params.prompt[0].text === "first" || message.params.prompt[0].text.endsWith("\\nfirst\\n</user_request>"))) { pending.push(message); update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "owned-first" } }); } else reply(message, { stopReason: "end_turn" }); }
onCancel = () => { for (const message of pending.splice(0)) reply(message, { stopReason: "cancelled" }); };`;
