/** Real ACP stdio → V2 SQL terminal → held user queue; no live provider/model. */
import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  DroidSettings,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { resolveSelfInvocation } from "@t3tools/shared/nodeRuntime";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcessSpawner } from "effect/process";
import * as ServerConfig from "../config.ts";
import { makeDroidAcpRuntime } from "../provider/acp/DroidAcpSupport.ts";
import { scriptedDroid } from "../provider/testUtils/scriptedDroid.ts";
import { makeDroidAdapterV2 } from "./Adapters/DroidAdapterV2.ts";
import { OrchestrationEffectWorkerV2 } from "./EffectWorker.ts";
import { IdAllocatorV2, layer as idAllocatorLayer } from "./IdAllocator.ts";
import { OrchestratorV2 } from "./Orchestrator.ts";
import { layerFromAdapters as makeLayer } from "./ProviderAdapterRegistry.ts";
import { layerWithRegistry as makeOrchestratorV2ReplayLayerWithRegistry } from "./testkit/ProviderReplayHarness.ts";
import { checkpointWorkspace } from "./testkit/ReplayFixtureWorkspace.ts";

const decodeSettings = Schema.decodeEffect(DroidSettings);
const layer = Layer.mergeAll(
  NodeServices.layer,
  idAllocatorLayer,
  ServerConfig.layerTest(process.cwd(), { prefix: "scient-droid-watchdog-sql-" }).pipe(
    Layer.provide(NodeServices.layer),
  ),
);
it.layer(layer)("Droid native idle supervision persistence", (it) => {
  it.effect(
    "fails the silent owned turn durably and holds queued messages without delivering them",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const cwd = yield* checkpointWorkspace("droid-watchdog-sql");
          const peer = yield* scriptedDroid(`function onPrompt() {
      update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "watchdog-ready" } });
    }`);
          const config = yield* ServerConfig.ServerConfig;
          const fs = yield* FileSystem.FileSystem;
          const crypto = yield* Crypto.Crypto;
          const allocator = yield* IdAllocatorV2;
          const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
          const instanceId = ProviderInstanceId.make("droid-watchdog-instance");
          const threadId = ThreadId.make("droid-watchdog-thread");
          const modelSelection = { instanceId, model: "droid-native" };
          const nativeReady = yield* Queue.unbounded<void>();
          const adapter = makeDroidAdapterV2({
            instanceId,
            settings: yield* decodeSettings({ enabled: true, binaryPath: peer.binaryPath }),
            environment: { PATH: process.env.PATH },
            sensitiveEnvironmentValues: [],
            makeRuntime: makeDroidAcpRuntime,
            childProcessSpawner: spawner,
            fileSystem: fs,
            crypto,
            serverConfig: config,
            idAllocator: allocator,
            selfInvocation: yield* resolveSelfInvocation(),
            onAuthenticationRejected: () =>
              Effect.die("No authentication in controlled Droid peer"),
          });
          const runtimeLayer = makeOrchestratorV2ReplayLayerWithRegistry(
            {
              name: "droid-watchdog-sql",
              runtimePolicyOverride: { cwd },
            },
            makeLayer([
              {
                ...adapter,
                openSession: (input) =>
                  adapter.openSession(input).pipe(
                    Effect.map((runtime) => ({
                      ...runtime,
                      events: runtime.events.pipe(
                        Stream.tap((event) =>
                          event.type === "message.updated" &&
                          event.message.text.includes("watchdog-ready")
                            ? Queue.offer(nativeReady, undefined).pipe(Effect.asVoid)
                            : Effect.void,
                        ),
                      ),
                    })),
                  ),
              },
            ]),
            {
              configureMcp: false,
              runEffectWorker: false,
              layerServerConfig: Layer.succeed(ServerConfig.ServerConfig, config),
            },
          );
          yield* Effect.gen(function* () {
            const orchestrator = yield* OrchestratorV2;
            const worker = yield* OrchestrationEffectWorkerV2;
            yield* orchestrator.dispatch({
              type: "thread.create",
              commandId: CommandId.make("droid-watchdog-create"),
              threadId,
              projectId: ProjectId.make("droid-watchdog-project"),
              title: "Droid watchdog",
              modelSelection,
              runtimeMode: "full-access",
              interactionMode: "default",
              branch: null,
              worktreePath: null,
              createdBy: "user",
              creationSource: "web",
            });
            const send = (text: string, queue: boolean) =>
              orchestrator.dispatch({
                type: "message.dispatch",
                commandId: CommandId.make(`droid-watchdog:${text}`),
                threadId,
                messageId: MessageId.make(`droid-watchdog-message:${text}`),
                text,
                attachments: [],
                createdBy: "user",
                creationSource: "web",
                dispatchMode: { type: queue ? "queue_after_active" : "start_immediately" },
              });
            yield* send("foreground", false);
            yield* worker.drain(8);
            yield* Queue.take(nativeReady);
            yield* send("first", true);
            yield* send("second", true);
            const before = yield* orchestrator.getThreadProjection(threadId);
            assert.equal(before.runs.filter((run) => run.status === "queued").length, 2);
            assert.isFalse(
              before.runs.some((run) => run.status === "queued" && run.queueHeld === true),
            );
            const cursor = yield* orchestrator.getThreadEventSequence(threadId);
            const pull = yield* Stream.toPull(
              orchestrator.streamStoredEventsFrom({ threadId, afterSequence: cursor }),
            );
            yield* TestClock.adjust("11 minutes");
            const found = yield* Stream.concat(
              Stream.fromEffect(orchestrator.getThreadProjection(threadId)),
              Stream.fromPull(Effect.succeed(pull)).pipe(
                Stream.mapEffect(() => orchestrator.getThreadProjection(threadId)),
              ),
            ).pipe(
              Stream.filter(
                (projection) =>
                  projection.runs.some((run) => run.status === "failed") &&
                  projection.runs
                    .filter((run) => run.status === "queued")
                    .every((run) => run.queueHeld === true),
              ),
              Stream.runHead,
            );
            assert.isTrue(Option.isSome(found));
            if (Option.isNone(found)) return yield* Effect.die("No durable watchdog terminal");
            const projection = found.value;
            assert.equal(projection.runs.filter((run) => run.status === "failed").length, 1);
            assert.equal(
              projection.providerTurns.filter((turn) => turn.status === "failed").length,
              1,
            );
            assert.deepEqual(
              projection.runs.filter((run) => run.status === "queued").map((run) => run.queueHeld),
              [true, true],
            );
            const nativeRequests = yield* peer.readLog();
            assert.equal(
              nativeRequests.filter((request) => request.method === "session/prompt").length,
              1,
            );
            yield* worker.drain(8);
            assert.equal(
              (yield* peer.readLog()).filter((request) => request.method === "session/prompt")
                .length,
              1,
            );
          }).pipe(Effect.provide(runtimeLayer));
        }),
      ),
  );
});
