/**
 * Disposable native-protocol acceptance: real SQLite admission, effect worker,
 * turn start, handoff preparation and credential lifecycle with scripted OMP
 * stdio. This qualifies host integration; it does not launch a live model.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as NetAddress from "effect/net/NetAddress";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpServer } from "effect/http";
import { ChildProcessSpawner } from "effect/process";
import { makeOmpRpcClient } from "effect-omp-rpc/client";
import { OmpRpcProtocolError } from "effect-omp-rpc/errors";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as McpProviderSession from "../mcp/McpProviderSession.ts";
import * as McpSessionRegistry from "../mcp/McpSessionRegistry.ts";
import { layerMemory as SqlitePersistenceMemory } from "../persistence/Sqlite.ts";
import * as ProviderInstances from "../provider/ProviderInstanceRegistry.ts";
import { makeOmpScriptedWire } from "../provider/omp/OmpCaptureReplay.testFixtures.ts";
import { makeOmpRedaction } from "../provider/omp/OmpRpcProcess.ts";
import { ompTarget } from "../provider/omp/OmpTarget.ts";
import { scientAgentTarget } from "../provider/scient/ScientAgentTarget.ts";
import { prepareScientSkillTurn } from "../scient/skills/ScientSkillInvocation.ts";
import { makeOmpAdapterV2 } from "./Adapters/OmpAdapterV2.ts";
import * as EventSink from "./EventSink.ts";
import * as IdAllocator from "./IdAllocator.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapters from "./ProviderAdapterRegistry.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as RuntimePolicy from "./RuntimePolicy.ts";
import { layerWithRegistry as makeOrchestratorV2ReplayLayerWithRegistry } from "./testkit/ProviderReplayHarness.ts";

const Bootstrap = Schema.Struct({
  endpoint: Schema.NullOr(Schema.String),
  authorization: Schema.NullOr(Schema.String),
  awareness: Schema.String,
});
const decodeBootstrap = Schema.decodeEffect(Schema.fromJsonString(Bootstrap));
const database = SqlitePersistenceMemory;
const mcpLayer = Layer.effect(
  McpSessionRegistry.McpSessionRegistry,
  McpSessionRegistry.__testing.make(),
).pipe(
  Layer.provide(
    Layer.mergeAll(
      NodeServices.layer,
      Layer.succeed(HttpServer.HttpServer, {
        address: NetAddress.inetAddressFromIpStringUnsafe("127.0.0.1", 43125),
        serve: () => Effect.void,
      }),
      Layer.mock(ServerEnvironment.ServerEnvironment)({
        getEnvironmentId: Effect.succeed(EnvironmentId.make("omp-handoff-environment")),
      }),
    ),
  ),
);
const projectsLayer = ProjectStore.layer.pipe(Layer.provide(database));
const policyLayer = RuntimePolicy.layerFromProjectStore.pipe(
  Layer.provide(
    Layer.mergeAll(
      projectsLayer,
      Layer.mock(ProviderInstances.ProviderInstanceRegistry)({
        getInstance: () => Effect.succeed(undefined),
      }),
    ),
  ),
);
const testLayer = Layer.mergeAll(
  NodeServices.layer,
  IdAllocator.layer,
  mcpLayer,
  ServerConfig.layerTest(process.cwd(), { prefix: "scient-omp-service-handoff-" }).pipe(
    Layer.provide(NodeServices.layer),
  ),
);

for (const target of [ompTarget, scientAgentTarget]) {
  const instanceId = ProviderInstanceId.make(`${target.driverKind}-handoff-instance`);
  const modelSelection = { instanceId, model: "scient-stub/stub-model" };
  it.effect.each(
    (["valid", "stale", "workspace"] as const).map((transition) => ({
      caseTitle: `qualifies ${transition} ${target.name} continuation through native turn start and held admission`,
      transition,
    })),
  )("$caseTitle", ({ transition }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const config = yield* ServerConfig.ServerConfig;
      const crypto = yield* Crypto.Crypto;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const mcp = yield* McpSessionRegistry.McpSessionRegistry;
      const firstWorkspace = yield* fs.makeTempDirectoryScoped({
        prefix: "scient-omp-workspace-before-",
      });
      const nextWorkspace = yield* fs.makeTempDirectoryScoped({
        prefix: "scient-omp-workspace-after-",
      });
      const prompts: string[] = [];
      const promptSessions: string[] = [];
      const switches: string[] = [];
      const issuedTokens: string[] = [];
      const nativeRoots: string[] = [];
      let freshOrdinal = 0;
      let processOrdinal = 0;
      const adapter = makeOmpAdapterV2({
        target,
        instanceId,
        settings: { binaryPath: "synthetic-omp" },
        environment: {},
        fileSystem: fs,
        path,
        crypto,
        spawner,
        serverConfig: config,
        idAllocator,
        continuations: { offer: () => Effect.void },
        makeProcess: (options) =>
          Effect.gen(function* () {
            const root = options.sessionDir;
            if (!root) return yield* Effect.die("Missing native owned session root");
            processOrdinal += 1;
            let sessionFile = path.join(root, `opened-${processOrdinal}.jsonl`);
            let sessionId = `opened-${processOrdinal}`;
            for (const name of [sessionId, "fresh-1", "fresh-2", "fresh-3"]) {
              const file = path.join(root, `${name}.jsonl`);
              if (!(yield* fs.exists(file))) yield* fs.writeFileString(file, "{}\n");
            }
            nativeRoots.push(root);
            const extensionPath = options.extraArgs?.at(-1);
            if (!extensionPath) return yield* Effect.die("Missing private bootstrap extension");
            const bootstrap = yield* decodeBootstrap(
              yield* fs.readFileString(extensionPath.replace(/\.mjs$/, ".bootstrap.json")),
            );
            const credential = McpProviderSession.readMcpProviderSession(
              ThreadId.make(`omp-handoff:${transition}`),
            );
            assert.isTrue(credential?.providerInstanceId === instanceId);
            assert.isTrue(bootstrap.authorization === credential?.authorizationHeader);
            if (!bootstrap.authorization?.startsWith("Bearer "))
              return yield* Effect.die("Missing native tool credential");
            issuedTokens.push(bootstrap.authorization.slice("Bearer ".length));
            const wire = yield* makeOmpScriptedWire(
              (command) => {
                if (command.type === "new_session") {
                  freshOrdinal += 1;
                  sessionId = `fresh-${freshOrdinal}`;
                  sessionFile = path.join(root, `${sessionId}.jsonl`);
                }
                if (command.type === "switch_session") {
                  const file = command.sessionPath;
                  if (typeof file !== "string")
                    throw new Error("Missing scripted native session path");
                  switches.push(file);
                  sessionFile = file;
                  sessionId = path.basename(file, ".jsonl");
                  return {
                    type: "response",
                    command: "switch_session",
                    id: command.id,
                    success: true,
                    data: { cancelled: false },
                  };
                }
                if (command.type === "prompt" && typeof command.message === "string") {
                  prompts.push(command.message);
                  promptSessions.push(sessionFile);
                  return {
                    type: "response",
                    command: "prompt",
                    id: command.id,
                    success: true,
                    data: { agentInvoked: true },
                  };
                }
                if (command.type === "get_state")
                  return {
                    type: "response",
                    command: "get_state",
                    id: command.id,
                    success: true,
                    data: {
                      sessionFile,
                      sessionId,
                      model: { provider: "scient-stub", id: "stub-model" },
                      isStreaming: false,
                      isCompacting: false,
                    },
                  };
                return undefined;
              },
              (command) =>
                command.type === "prompt"
                  ? [
                      { type: "agent_start" },
                      {
                        type: "message_end",
                        message: {
                          role: "assistant",
                          content: [
                            {
                              type: "text",
                              text:
                                prompts.length === 1
                                  ? "Historical native answer"
                                  : "Current native answer",
                            },
                          ],
                          stopReason: "stop",
                        },
                      },
                      { type: "agent_end", messages: [], isTerminal: true },
                      {
                        type: "prompt_result",
                        id: command.id,
                        agentInvoked: true,
                        status: "completed",
                        sessionSettled: true,
                      },
                      { type: "session_settled" },
                    ]
                  : [],
            );
            const client = yield* makeOmpRpcClient(wire.io);
            return {
              ...client,
              version: target.driverKind === "scient" ? "0.1.0" : "18.4.8",
              runtimeVersion: "18.4.8",
              redaction: makeOmpRedaction({}, [bootstrap.authorization]),
              shutdown: client.close().pipe(Effect.as({ code: 0, forced: false, stderrTail: "" })),
            };
          }).pipe(
            Effect.mapError(
              (cause) =>
                new OmpRpcProtocolError({
                  detail: "Synthetic native fixture could not be prepared.",
                  cause,
                }),
            ),
          ),
      });
      const replay = makeOrchestratorV2ReplayLayerWithRegistry(
        { name: `omp-service-handoff-${transition}` },
        ProviderAdapters.layerFromAdapters([adapter]),
        {
          layerDatabase: database,
          runtimePolicyLayer: policyLayer.pipe(Layer.orDie),
          configureMcp: true,
          mcpSessionRegistryLayer: mcpLayer,
        },
      );
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        const projects = yield* ProjectStore.ProjectStoreV2;
        const sink = yield* EventSink.EventSinkV2;
        const sessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
        const threadId = ThreadId.make(`omp-handoff:${transition}`);
        const projectId = ProjectId.make(`omp-handoff-project:${transition}`);
        const now = yield* DateTime.now;
        const applyWorkspace = (workspaceRoot: string, sequence: number) =>
          projects.apply({
            sequence,
            eventId: EventId.make(`omp-handoff-project:${transition}:${sequence}`),
            aggregateKind: "project",
            aggregateId: projectId,
            occurredAt: DateTime.formatIso(now),
            commandId: null,
            causationEventId: null,
            correlationId: null,
            metadata: {},
            type: "project.created",
            payload: {
              projectId,
              title: "OMP handoff project",
              workspaceRoot,
              defaultModelSelection: modelSelection,
              scripts: [],
              createdAt: DateTime.formatIso(now),
              updatedAt: DateTime.formatIso(now),
            },
          });
        yield* applyWorkspace(firstWorkspace, 1);
        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make(`create:${transition}`),
          threadId,
          projectId,
          title: "OMP handoff",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdBy: "user",
          creationSource: "web",
        });
        const firstSequence = yield* sink.latestSequence({ threadId });
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(`first:${transition}`),
          threadId,
          messageId: MessageId.make(`first:${transition}`),
          text: "Historical native question",
          attachments: [],
          createdBy: "user",
          creationSource: "web",
          dispatchMode: { type: "start_immediately" },
        });
        const admitted = yield* projections.getThreadProjection(threadId);
        const firstRun = admitted.runs.find((run) => run.userMessageId === `first:${transition}`);
        if (!firstRun) return yield* Effect.die("First run was not admitted");
        yield* sink
          .stream({ threadId, afterSequence: firstSequence, eventType: "run.updated" })
          .pipe(
            Stream.filter(
              (event) =>
                event.event.type === "run.updated" &&
                event.event.payload.id === firstRun.id &&
                event.event.payload.status === "completed",
            ),
            Stream.take(1),
            Stream.runDrain,
          );
        const completed = yield* projections.getThreadProjection(threadId);
        const oldThread = completed.providerThreads.find(
          (row) => row.id === firstRun.providerThreadId,
        );
        if (!oldThread?.providerSessionId || !oldThread.nativeMetadata?.resumeCursor)
          return yield* Effect.die("Missing durable native continuation");
        assert.equal(oldThread.driver, target.driverKind);
        assert.equal(oldThread.providerInstanceId, instanceId);
        assert.isTrue(
          nativeRoots[0]?.startsWith(
            path.join(yield* fs.realPath(config.stateDir), `${target.stateNamespace}-sessions`) +
              path.sep,
          ),
        );
        assert.equal(prompts.length, 1);
        assert.isTrue(issuedTokens.length === 1);
        const previousToken = issuedTokens[0];
        if (!previousToken) return yield* Effect.die("Missing previous credential observation");
        yield* sessions.close(oldThread.providerSessionId);
        assert.equal(yield* mcp.resolve(previousToken), undefined);
        if (transition === "stale")
          yield* sink.write({
            events: [
              {
                id: EventId.make(`stale:${transition}`),
                type: "provider-thread.updated",
                threadId,
                occurredAt: now,
                payload: { ...oldThread, nativeMetadata: { resumeCursor: {} } },
              },
            ],
          });
        if (transition === "workspace") yield* applyWorkspace(nextWorkspace, 2);
        for (const ordinal of [1, 2])
          yield* orchestrator.dispatch({
            type: "legacy-queue.import",
            commandId: CommandId.make(`queue:${transition}:${ordinal}`),
            threadId,
            queueItemId: `held:${ordinal}`,
            messageId: MessageId.make(`held:${transition}:${ordinal}`),
            text: ordinal === 1 ? "Current queued request" : "Later held request",
            attachments: [],
            selectedScientSkillNames: [],
            createdAt: now,
          });
        const held = yield* projections.getThreadProjection(threadId);
        const firstHeld = held.runs.find((run) => run.userMessageId === `held:${transition}:1`);
        const secondHeld = held.runs.find((run) => run.userMessageId === `held:${transition}:2`);
        if (!firstHeld || !secondHeld) return yield* Effect.die("Missing held runs");
        assert.equal(firstHeld.status, "queued");
        assert.equal(secondHeld.status, "queued");
        assert.isBelow(firstHeld.ordinal, secondHeld.ordinal);
        const secondSequence = yield* sink.latestSequence({ threadId });
        yield* orchestrator.dispatch({
          type: "queue.resume",
          commandId: CommandId.make(`resume:${transition}`),
          threadId,
          runId: firstHeld.id,
        });
        yield* sink
          .stream({ threadId, afterSequence: secondSequence, eventType: "run.updated" })
          .pipe(
            Stream.filter(
              (event) =>
                event.event.type === "run.updated" &&
                event.event.payload.id === firstHeld.id &&
                event.event.payload.status === "completed",
            ),
            Stream.take(1),
            Stream.runDrain,
          );
        const delivered = yield* projections.getThreadProjection(threadId);
        assert.equal(prompts.length, 2);
        const deliveredRun = delivered.runs.find((run) => run.id === firstHeld.id);
        assert.equal(deliveredRun?.providerInstanceId, instanceId);
        assert.equal(deliveredRun?.userMessageId, firstHeld.userMessageId);
        assert.equal(delivered.runs.find((run) => run.id === secondHeld.id)?.status, "queued");
        assert.equal(issuedTokens.length, 2);
        assert.isTrue(issuedTokens[0] !== issuedTokens[1]);
        const currentToken = issuedTokens[1];
        if (!currentToken) return yield* Effect.die("Missing replacement credential observation");
        assert.equal((yield* mcp.resolve(currentToken))?.thread.threadId, threadId);
        assert.equal((yield* mcp.resolve(currentToken))?.thread.providerInstanceId, instanceId);
        assert.equal(yield* mcp.resolve(previousToken), undefined);
        if (transition === "valid") {
          assert.equal(switches.length, 1);
          // Each process starts on a private empty transcript before verified resume.
          assert.equal(freshOrdinal, 2);
          assert.equal(promptSessions[1], oldThread.nativeThreadRef?.nativeId);
          assert.equal(delivered.contextHandoffs.length, 0);
          assert.equal(
            prompts[1],
            prepareScientSkillTurn("Current queued request", [], new Map(), {
              skillLoadToolName: "scient_skill_load",
              skillListToolName: "scient_skills_list",
              includeCatalogMarker: true,
            }).input,
          );
        } else {
          assert.equal(switches.length, 0);
          assert.equal(freshOrdinal, 2);
          assert.notEqual(promptSessions[1], oldThread.nativeThreadRef?.nativeId);
          assert.include(prompts[1] ?? "", "Historical native question");
          assert.include(prompts[1] ?? "", "Historical native answer");
          assert.include(prompts[1] ?? "", "Current queued request");
          assert.isTrue(
            delivered.contextHandoffs.some(
              (handoff) => handoff.status === "ready" && handoff.delivery?.status === "inline",
            ),
          );
          assert.isTrue(
            delivered.contextTransfers.some(
              (transfer) => transfer.resolution?.strategy === "portable_context",
            ),
          );
        }
        assert.equal(nativeRoots.length, 2);
      }).pipe(Effect.provide(replay));
    }).pipe(Effect.provide(testLayer), Effect.scoped),
  );
}
