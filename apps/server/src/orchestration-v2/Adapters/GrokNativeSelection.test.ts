// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  GrokSettings,
  MessageId,
  NodeId,
  ProviderInstanceId,
  ProjectId,
  ProviderSessionId,
  RunAttemptId,
  RunId,
  ThreadId,
  type ModelSelection,
} from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { resolveSelfInvocation } from "@t3tools/shared/nodeRuntime";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";
import * as ServerConfig from "../../config.ts";
import { execScriptSource, writeFakeCli } from "../../testUtils/fakeCli.ts";
import * as IdAllocator from "../IdAllocator.ts";
import {
  ProviderAdapterV2RuntimePolicy,
  type ProviderAdapterV2TurnInput,
} from "../ProviderAdapter.ts";
import { makeGrokAdapterV2 } from "./GrokAdapterV2.ts";

const decodeSettings = Schema.decodeEffect(GrokSettings);
const decodeRequest = Schema.decodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      method: Schema.String,
      params: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
    }),
  ),
);
const layer = Layer.mergeAll(
  NodeServices.layer,
  IdAllocator.layer,
  ServerConfig.layerTest(process.cwd(), { prefix: "scient-grok-native-selection-" }).pipe(
    Layer.provide(NodeServices.layer),
  ),
);
const harness = Effect.fn("GrokNativeSelection.harness")(function* (
  generation: "1" | "2",
  preference: { readonly model: string; readonly options?: NonNullable<ModelSelection["options"]> },
  environment: Record<string, string> = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "scient-grok-native-peer-" });
  const requestsPath = path.join(directory, "requests.ndjson");
  const binary = writeFakeCli({
    directory,
    name: "grok-native",
    source: execScriptSource({
      scriptPath: yield* path.fromFileUrl(
        new URL("../../../scripts/grok-v1-mock-agent.ts", import.meta.url),
      ),
    }),
  });
  const instanceId = ProviderInstanceId.make("grok-native-selection");
  const threadId = ThreadId.make("grok-native-selection");
  const modelSelection = { instanceId, ...preference };
  const runtimePolicy = ProviderAdapterV2RuntimePolicy.make({
    runtimeMode: "full-access",
    interactionMode: "default",
    cwd: directory,
  });
  const adapter = makeGrokAdapterV2({
    instanceId,
    settings: yield* decodeSettings({ binaryPath: binary }),
    environment: {
      T3_ACP_GROK_MOCK_GENERATION: generation,
      T3_ACP_REQUEST_LOG_PATH: requestsPath,
      ...environment,
    },
    hostPlatform: yield* HostProcessPlatform,
    childProcessSpawner: yield* ChildProcessSpawner.ChildProcessSpawner,
    crypto: yield* Crypto.Crypto,
    fileSystem: fs,
    serverConfig: yield* ServerConfig.ServerConfig,
    idAllocator: yield* IdAllocator.IdAllocatorV2,
    selfInvocation: yield* resolveSelfInvocation(),
  });
  const open = adapter.openSession({
    threadId,
    providerSessionId: ProviderSessionId.make("grok-native-session"),
    modelSelection,
    runtimePolicy,
    configureMcp: false,
  });
  const now = yield* DateTime.now;
  const appThread: ProviderAdapterV2TurnInput["appThread"] = {
    id: threadId,
    projectId: ProjectId.make("grok-native-project"),
    title: "Native Grok selection",
    createdBy: "user",
    creationSource: "web",
    providerInstanceId: instanceId,
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
  const send = Effect.gen(function* () {
    const runtime = yield* open;
    const providerThread = yield* runtime.ensureThread({ threadId, modelSelection, runtimePolicy });
    const completed = yield* runtime.events.pipe(
      Stream.filter((event) => event.type === "turn.terminal"),
      Stream.take(1),
      Stream.runCollect,
      Effect.forkScoped,
    );
    yield* runtime.startTurn({
      threadId,
      providerThread,
      appThread,
      modelSelection,
      runtimePolicy,
      runId: RunId.make("grok-native-run"),
      runOrdinal: 1,
      providerTurnOrdinal: 1,
      attemptId: RunAttemptId.make("grok-native-attempt"),
      rootNodeId: NodeId.make("grok-native-root"),
      message: {
        messageId: MessageId.make("grok-native-message"),
        text: "Hello",
        attachments: [],
        createdBy: "user",
        creationSource: "web",
      },
    });
    const terminal = (yield* Fiber.join(completed))[0];
    assert.equal(terminal?.type, "turn.terminal");
    if (terminal?.type === "turn.terminal") assert.equal(terminal.status, "completed");
  });
  const requests = () =>
    NodeFS.readFileSync(requestsPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => decodeRequest(line));
  return { send, requests };
});

it.layer(layer, { excludeTestServices: true })("native Grok model selection", (it) => {
  it.effect("uses V1 response shape even when advertised protocol version is 2", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* harness("1", {
          model: "grok-mock-alt",
          options: [{ id: "reasoningEffort", value: "low" }],
        });
        yield* h.send;
        const writes = h.requests().filter((request) => request.method === "session/set_model");
        assert.isAtLeast(writes.length, 1);
        for (const request of writes)
          assert.deepEqual(request.params, {
            sessionId: "mock-session-1",
            modelId: "grok-mock-alt",
            _meta: { reasoningEffort: "low" },
          });
        assert.lengthOf(
          h.requests().filter((request) => request.method === "session/prompt"),
          1,
        );
      }),
    ),
  );
  it.effect("confirms V2 model and reasoning through the agent's own option IDs", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* harness("2", {
          model: "grok-mock-alt",
          options: [{ id: "reasoningEffort", value: "low" }],
        });
        yield* h.send;
        assert.deepEqual(
          h
            .requests()
            .filter((request) => request.method === "session/set_config_option")
            .map((request) => request.params),
          [
            {
              sessionId: "mock-session-1",
              configId: "native-model-choice",
              value: "grok-mock-alt",
              type: "id",
            },
            {
              sessionId: "mock-session-1",
              configId: "native-effort-choice",
              value: "low",
              type: "id",
            },
          ],
        );
        assert.lengthOf(
          h.requests().filter((request) => request.method === "session/set_model"),
          0,
        );
      }),
    ),
  );
  for (const generation of ["1", "2"] as const) {
    it.effect(`preserves omitted native model and effort defaults in V${generation}`, () =>
      Effect.scoped(
        Effect.gen(function* () {
          const h = yield* harness(generation, { model: "grok-build" });
          yield* h.send;
          assert.lengthOf(
            h.requests().filter((request) => request.method.startsWith("session/set_")),
            0,
          );
          assert.lengthOf(
            h.requests().filter((request) => request.method === "session/prompt"),
            1,
          );
        }),
      ),
    );
  }
  for (const generation of ["1", "2"] as const) {
    it.effect(
      `rejects invalid explicit reasoning in V${generation} before model writes or prompt`,
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const h = yield* harness(generation, {
              model: "grok-mock-alt",
              options: [{ id: "reasoningEffort", value: "bad effort!" }],
            });
            assert.isTrue(Exit.isFailure(yield* h.send.pipe(Effect.exit)));
            assert.lengthOf(
              h
                .requests()
                .filter(
                  (request) =>
                    request.method.startsWith("session/set_") ||
                    request.method === "session/prompt",
                ),
              0,
            );
          }),
        ),
    );
  }
  it.effect(
    "rejects explicit reasoning without a V1 default model before any write or prompt",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const h = yield* harness(
            "1",
            { model: "grok-build", options: [{ id: "reasoningEffort", value: "low" }] },
            { T3_ACP_GROK_MODEL_UNAVAILABLE: "1" },
          );
          assert.isTrue(Exit.isFailure(yield* h.send.pipe(Effect.exit)));
          assert.lengthOf(
            h
              .requests()
              .filter(
                (request) =>
                  request.method.startsWith("session/set_") || request.method === "session/prompt",
              ),
            0,
          );
        }),
      ),
  );
  it.effect(
    "rejects a well-formed V2 effort absent from the native ladder before any write or prompt",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const h = yield* harness("2", {
            model: "grok-build",
            options: [{ id: "reasoningEffort", value: "medium" }],
          });
          assert.isTrue(Exit.isFailure(yield* h.send.pipe(Effect.exit)));
          assert.lengthOf(
            h
              .requests()
              .filter(
                (request) =>
                  request.method.startsWith("session/set_") || request.method === "session/prompt",
              ),
            0,
          );
        }),
      ),
  );
  for (const [name, options] of [
    ["mismatched", { T3_ACP_GROK_EFFORT_MISMATCH: "1" }],
    ["unavailable", { T3_ACP_GROK_EFFORT_UNAVAILABLE: "1" }],
  ] as const) {
    it.effect(`rejects ${name} explicit reasoning before any prompt`, () =>
      Effect.scoped(
        Effect.gen(function* () {
          const h = yield* harness(
            "2",
            { model: "grok-build", options: [{ id: "reasoningEffort", value: "low" }] },
            options,
          );
          assert.isTrue(Exit.isFailure(yield* h.send.pipe(Effect.exit)));
          assert.lengthOf(
            h.requests().filter((request) => request.method === "session/prompt"),
            0,
          );
        }),
      ),
    );
  }
});
