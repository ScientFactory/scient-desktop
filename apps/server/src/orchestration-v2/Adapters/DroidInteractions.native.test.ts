import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  DroidSettings,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import { resolveSelfInvocation } from "@t3tools/shared/nodeRuntime";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/process";
import * as ServerConfig from "../../config.ts";
import { makeDroidAcpRuntime } from "../../provider/acp/DroidAcpSupport.ts";
import { scriptedDroid } from "../../provider/testUtils/scriptedDroid.ts";
import { IdAllocatorV2, layer as idAllocatorLayer } from "../IdAllocator.ts";
import { OrchestratorV2 } from "../Orchestrator.ts";
import { layerFromAdapters as makeLayer } from "../ProviderAdapterRegistry.ts";
import { layerWithRegistry as makeOrchestratorV2ReplayLayerWithRegistry } from "../testkit/ProviderReplayHarness.ts";
import { checkpointWorkspace } from "../testkit/ReplayFixtureWorkspace.ts";
import { makeDroidAdapterV2 } from "./DroidAdapterV2.ts";
const decodeSettings = Schema.decodeEffect(DroidSettings);
const layer = Layer.mergeAll(
  NodeServices.layer,
  idAllocatorLayer,
  ServerConfig.layerTest(process.cwd(), { prefix: "scient-droid-interactions-" }).pipe(
    Layer.provide(NodeServices.layer),
  ),
);
it.layer(layer, { excludeTestServices: true })("Droid native persisted interactions", (it) => {
  it.effect(
    "persists the selected native form answer and resolves its own question exactly once",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const cwd = yield* checkpointWorkspace("droid-native-form");
          const peer = yield* scriptedDroid(`async function onPrompt(message) {
        const response = await request("session/elicitation", { mode: "form", message: "Turn scope", requestedSchema: {
          type: "object", properties: { scope: { type: "string", title: "Scope", description: "Which scope should Droid use?", oneOf: [{ const: "workspace", title: "Workspace" }, { const: "session", title: "Session" }] } }, required: ["scope"]
        } });
        update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: JSON.stringify(response.result.action) } });
        reply(message, { stopReason: "end_turn" });
      }`);
          const config = yield* ServerConfig.ServerConfig;
          const instanceId = ProviderInstanceId.make("droid-form-instance");
          const threadId = ThreadId.make("droid-form-thread");
          const modelSelection = { instanceId, model: "droid-native" };
          const adapter = makeDroidAdapterV2({
            instanceId,
            settings: yield* decodeSettings({ enabled: true, binaryPath: peer.binaryPath }),
            environment: { PATH: process.env.PATH },
            sensitiveEnvironmentValues: [],
            makeRuntime: makeDroidAcpRuntime,
            childProcessSpawner: yield* ChildProcessSpawner.ChildProcessSpawner,
            fileSystem: yield* FileSystem.FileSystem,
            crypto: yield* Crypto.Crypto,
            serverConfig: config,
            idAllocator: yield* IdAllocatorV2,
            selfInvocation: yield* resolveSelfInvocation(),
            onAuthenticationRejected: () => Effect.die("No account in this native fixture"),
          });
          const runtimeLayer = makeOrchestratorV2ReplayLayerWithRegistry(
            { name: "droid-native-form", runtimePolicyOverride: { cwd } },
            makeLayer([adapter]),
            {
              configureMcp: false,
              runEffectWorker: true,
              layerServerConfig: Layer.succeed(ServerConfig.ServerConfig, config),
            },
          );
          yield* Effect.gen(function* () {
            const orchestrator = yield* OrchestratorV2;
            const waitFor = (predicate: (projection: OrchestrationV2ThreadProjection) => boolean) =>
              Effect.gen(function* () {
                const sequence = yield* orchestrator.getThreadEventSequence(threadId);
                const pull = yield* Stream.toPull(
                  orchestrator.streamStoredEventsFrom({ threadId, afterSequence: sequence }),
                );
                const found = yield* Stream.concat(
                  Stream.fromEffect(orchestrator.getThreadProjection(threadId)),
                  Stream.fromPull(Effect.succeed(pull)).pipe(
                    Stream.mapEffect(() => orchestrator.getThreadProjection(threadId)),
                  ),
                ).pipe(Stream.filter(predicate), Stream.runHead);
                if (Option.isNone(found))
                  return yield* Effect.die("Native interaction stream ended before receipt");
                return found.value;
              }).pipe(Effect.timeout("10 seconds"));
            yield* orchestrator.dispatch({
              type: "thread.create",
              commandId: CommandId.make("native-form-create"),
              threadId,
              projectId: ProjectId.make("native-form-project"),
              title: "Native form",
              modelSelection,
              runtimeMode: "full-access",
              interactionMode: "default",
              branch: null,
              worktreePath: null,
              createdBy: "user",
              creationSource: "web",
            });
            yield* orchestrator.dispatch({
              type: "message.dispatch",
              commandId: CommandId.make("native-form-send"),
              threadId,
              messageId: MessageId.make("native-form-message"),
              text: "Ask before continuing",
              attachments: [],
              createdBy: "user",
              creationSource: "web",
              dispatchMode: { type: "start_immediately" },
            });
            const pending = yield* waitFor((projection) =>
              projection.runtimeRequests.some(
                (request) => request.kind === "user_input" && request.status === "pending",
              ),
            );
            const request = pending.runtimeRequests.find(
              (request) => request.kind === "user_input" && request.status === "pending",
            );
            if (!request) return yield* Effect.die("Missing native form request");
            const question = pending.turnItems.find(
              (item) => item.type === "user_input_request" && item.requestId === request.id,
            );
            if (question?.type !== "user_input_request")
              return yield* Effect.die("Missing persisted native question");
            assert.deepEqual(question.questions, [
              {
                id: "scope",
                header: "Scope",
                question: "Which scope should Droid use?",
                options: [
                  { label: "workspace", description: "Workspace" },
                  { label: "session", description: "Session" },
                ],
              },
            ]);
            assert.isFalse(pending.runs.some((run) => run.status === "completed"));
            yield* orchestrator.dispatch({
              type: "runtime-request.respond",
              commandId: CommandId.make("native-form-answer"),
              threadId,
              requestId: request.id,
              answers: { scope: "workspace" },
            });
            const settled = yield* waitFor(
              (projection) =>
                projection.runs.some((run) => run.status === "completed") &&
                projection.runtimeRequests.some(
                  (candidate) => candidate.id === request.id && candidate.status === "resolved",
                ),
            );
            assert.lengthOf(settled.runtimeRequests, 1);
            assert.equal(settled.runtimeRequests[0]?.status, "resolved");
            assert.equal(
              settled.nodes.find((node) => node.id === request.nodeId)?.status,
              "completed",
            );
            const resolved = settled.turnItems.filter(
              (item) => item.type === "user_input_request" && item.requestId === request.id,
            );
            assert.lengthOf(resolved, 1);
            if (resolved[0]?.type !== "user_input_request")
              return yield* Effect.die("Missing resolved native question");
            assert.equal(resolved[0].status, "completed");
            assert.deepEqual(settled.runtimeRequests[0]?.answers, { scope: "workspace" });
            assert.lengthOf(
              settled.providerTurns.filter((turn) => turn.status === "completed"),
              1,
            );
            assert.include(
              settled.messages.map((message) => message.text),
              '{"action":"accept","content":{"scope":"workspace"}}',
            );
            assert.deepEqual(
              (yield* orchestrator.getThreadProjection(threadId)).turnItems,
              settled.turnItems,
            );
            const log = yield* peer.readLog();
            assert.equal(log.filter((message) => message.method === "session/prompt").length, 1);
            assert.equal(
              log.filter((message) => message.id !== undefined && message.method === undefined)
                .length,
              1,
            );
          }).pipe(Effect.provide(runtimeLayer));
        }),
      ),
  );
});
