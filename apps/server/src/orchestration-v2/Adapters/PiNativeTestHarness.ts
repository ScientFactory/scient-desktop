// @effect-diagnostics nodeBuiltinImport:off
import * as NodeHttp from "node:http";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  MessageId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";
import * as ServerConfig from "../../config.ts";
import * as IdAllocator from "../IdAllocator.ts";
import * as ProviderAdapter from "../ProviderAdapter.ts";
import { makePiAdapterV2, type PiAdapterV2Options } from "./PiAdapterV2.ts";

export const binary = process.env.SCIENT_PI_TEST_BINARY;
export const json = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
export const decodeRecord = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);
export const layer = Layer.mergeAll(
  NodeServices.layer,
  IdAllocator.layer,
  ServerConfig.layerTest(process.cwd(), { prefix: "scient-pi-real-v2-" }).pipe(
    Layer.provide(NodeServices.layer),
  ),
);

export const fixture = Effect.fnUntraced(function* (suffix: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "scient-pi-real-v2-" });
  const profile = path.join(root, "profile");
  yield* fs.makeDirectory(profile);
  const instanceId = ProviderInstanceId.make(`pi-real-${suffix}`);
  const threadId = ThreadId.make(`pi-real-${suffix}`);
  const modelSelection = { instanceId, model: "scient-test/synthetic" };
  const policy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
    runtimeMode: "full-access",
    interactionMode: "default",
    cwd: root,
  });
  const adapterOptions: PiAdapterV2Options = {
    instanceId,
    settings: { enabled: true, binaryPath: binary!, launchArgs: "", customModels: [] },
    environment: {
      PATH: process.env.PATH,
      HOME: root,
      PI_CODING_AGENT_DIR: profile,
      PI_TELEMETRY: "0",
      PI_SKIP_VERSION_CHECK: "1",
      PI_OFFLINE: "1",
    },
    spawner: yield* ChildProcessSpawner.ChildProcessSpawner,
    fileSystem: fs,
    path,
    idAllocator: yield* IdAllocator.IdAllocatorV2,
    serverConfig: yield* ServerConfig.ServerConfig,
  };
  const adapter = makePiAdapterV2(adapterOptions);
  const open = (initialNativeThreadId?: string) =>
    adapter.openSession({
      threadId,
      providerSessionId: ProviderSessionId.make(`pi-real-${suffix}`),
      modelSelection,
      runtimePolicy: policy,
      ...(initialNativeThreadId === undefined ? {} : { initialNativeThreadId }),
    });
  const cwd = root;
  const send = Effect.fnUntraced(function* (
    session: ProviderAdapter.ProviderAdapterV2SessionRuntime,
    providerThread: Parameters<
      ProviderAdapter.ProviderAdapterV2SessionRuntime["resumeThread"]
    >[0]["providerThread"],
    ordinal = 1,
    text = "Reply with one short line.",
  ) {
    const now = yield* DateTime.now;
    yield* session.startTurn({
      appThread: {
        id: threadId,
        projectId: ProjectId.make("pi-real-project"),
        title: "Native lifecycle",
        createdBy: "user",
        creationSource: "web",
        providerInstanceId: instanceId,
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: cwd,
        activeProviderThreadId: providerThread.id,
        lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        lastVisitedAt: null,
        deletedAt: null,
      },
      threadId,
      runId: RunId.make(`pi-real-run-${suffix}-${ordinal}`),
      runOrdinal: ordinal,
      providerTurnOrdinal: ordinal,
      attemptId: RunAttemptId.make(`pi-real-attempt-${suffix}-${ordinal}`),
      rootNodeId: NodeId.make(`pi-real-node-${suffix}-${ordinal}`),
      providerThread,
      message: {
        createdBy: "user",
        creationSource: "web",
        messageId: MessageId.make(`pi-real-message-${suffix}-${ordinal}`),
        text,
        attachments: [],
      },
      modelSelection,
      runtimePolicy: policy,
    });
  });

  const models = (baseUrl: string, reasoning = false, contextWindow = 32000, maxTokens = 1024) =>
    fs.writeFileString(
      path.join(profile, "models.json"),
      json({
        providers: {
          "scient-test": {
            baseUrl,
            api: "openai-completions",
            apiKey: "synthetic-not-a-secret",
            models: [
              {
                id: "synthetic",
                name: "Synthetic test model",
                reasoning,
                input: ["text"],
                contextWindow,
                maxTokens,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              },
            ],
          },
        },
      }),
    );
  return {
    fs,
    path,
    root,
    profile,
    instanceId,
    threadId,
    modelSelection,
    policy,
    adapter,
    adapterOptions,
    open,
    send,
    models,
  };
});
export const collect = Effect.fnUntraced(function* (
  runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime,
) {
  const events: ProviderAdapter.ProviderAdapterV2Event[] = [];
  const queue = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
  yield* runtime.events.pipe(
    Stream.runForEach((event) =>
      Effect.sync(() => events.push(event)).pipe(Effect.andThen(Queue.offer(queue, event))),
    ),
    Effect.forkScoped({ startImmediately: true }),
  );
  const take = (predicate: (event: ProviderAdapter.ProviderAdapterV2Event) => boolean) =>
    Queue.take(queue).pipe(Effect.repeat({ until: predicate }));
  return { events, take };
});
export const serve = Effect.fnUntraced(function* (handler: NodeHttp.RequestListener) {
  const server = NodeHttp.createServer((request, response) => {
    if (request.method !== "POST") {
      response.writeHead(404).end();
      return;
    }
    handler(request, response);
  });
  yield* Effect.acquireRelease(
    Effect.promise(() => new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))),
    () =>
      Effect.promise(
        () =>
          new Promise<void>((resolve) => {
            server.closeAllConnections();
            server.close(() => resolve());
          }),
      ),
  );
  const address = server.address();
  if (!address || typeof address === "string")
    return yield* Effect.die("Missing synthetic endpoint");
  return `http://127.0.0.1:${address.port}`;
});
export const ensure = (
  h: Effect.Success<ReturnType<typeof fixture>>,
  runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime,
) =>
  runtime.ensureThread({
    threadId: h.threadId,
    modelSelection: h.modelSelection,
    runtimePolicy: h.policy,
  });
