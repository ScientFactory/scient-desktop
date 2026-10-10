import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2ThreadProjection,
  type ModelSelection,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/process";
import * as ServerConfig from "../../config.ts";
import { ompTarget } from "../omp/OmpTarget.ts";
import { scriptedOmpRpc } from "./scriptedOmpRpc.ts";
import { IdAllocatorV2 } from "../../orchestration-v2/IdAllocator.ts";
import { EffectOutboxV2 } from "../../orchestration-v2/EffectOutbox.ts";
import { OrchestratorV2 } from "../../orchestration-v2/Orchestrator.ts";
import { layerFromAdaptersEffect as makeLayerEffect } from "../../orchestration-v2/ProviderAdapterRegistry.ts";
import { ProviderContinuationRequests } from "../../orchestration-v2/ProviderContinuationRequests.ts";
import { layerWithRegistry as makeOrchestratorV2ReplayLayerWithRegistry } from "../../orchestration-v2/testkit/ProviderReplayHarness.ts";
import { checkpointWorkspace } from "../../orchestration-v2/testkit/ReplayFixtureWorkspace.ts";
import { makeOmpAdapterV2 } from "../../orchestration-v2/Adapters/OmpAdapterV2.ts";

/** Real native RPC, continuation worker and durable projection share one provider session. */
export const nativeOmpOrchestration = Effect.fnUntraced(function* (
  input: {
    readonly cwd?: string;
    readonly eventQueueByteLimit?: number;
    readonly stateDir?: string;
    readonly attachmentsDir?: string;
    readonly target?: Parameters<typeof makeOmpAdapterV2>[0]["target"];
    readonly instanceId?: ProviderInstanceId;
    readonly threadId?: ThreadId;
    readonly modelSelection?: ModelSelection;
    readonly environment?: NodeJS.ProcessEnv;
    readonly binaryPath?: string;
    readonly makeProcess?: Parameters<typeof makeOmpAdapterV2>[0]["makeProcess"];
    readonly receiptTimeoutMs?: number;
    readonly configureMcp?: boolean;
    readonly mcpSessionRegistryLayer?: NonNullable<
      Parameters<typeof makeOrchestratorV2ReplayLayerWithRegistry>[2]
    >["mcpSessionRegistryLayer"];
    readonly threads?: NonNullable<
      Parameters<typeof makeOrchestratorV2ReplayLayerWithRegistry>[2]
    >["threads"];
    readonly decorateEventSink?: NonNullable<
      Parameters<typeof makeOrchestratorV2ReplayLayerWithRegistry>[2]
    >["decorateEventSink"];
  } = {},
) {
  const originalConfig = yield* ServerConfig.ServerConfig;
  const config = {
    ...originalConfig,
    ...(input.stateDir ? { stateDir: input.stateDir } : {}),
    ...(input.attachmentsDir ? { attachmentsDir: input.attachmentsDir } : {}),
  };
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const allocator = yield* IdAllocatorV2;
  const cwd = input.cwd ?? (yield* checkpointWorkspace("omp-background-native"));
  const instanceId = input.instanceId ?? ProviderInstanceId.make("omp-native-background-instance");
  const threadId = input.threadId ?? ThreadId.make("omp-native-background-thread");
  const modelSelection = input.modelSelection ?? { instanceId, model: "test/selected" };
  const peer = scriptedOmpRpc({ models: [], initial: { provider: "test", id: "selected" } });
  const registry = makeLayerEffect(
    Effect.gen(function* () {
      return [
        makeOmpAdapterV2({
          target: input.target ?? ompTarget,
          ...(input.eventQueueByteLimit === undefined
            ? {}
            : { eventQueueByteLimit: input.eventQueueByteLimit }),
          instanceId,
          settings: { binaryPath: input.binaryPath ?? "synthetic-omp" },
          environment: input.environment ?? { HOME: config.stateDir },
          fileSystem: fs,
          path,
          crypto,
          spawner,
          idAllocator: allocator,
          serverConfig: config,
          makeProcess: input.makeProcess ?? peer.makeProcess,
          continuations: yield* ProviderContinuationRequests,
        }),
      ];
    }),
  );
  const runtimeLayer = makeOrchestratorV2ReplayLayerWithRegistry(
    { name: "omp-native-background", runtimePolicyOverride: { cwd } },
    registry,
    {
      configureMcp: input.configureMcp ?? false,
      ...(input.mcpSessionRegistryLayer
        ? { mcpSessionRegistryLayer: input.mcpSessionRegistryLayer }
        : {}),
      ...(input.decorateEventSink ? { decorateEventSink: input.decorateEventSink } : {}),
      ...(input.threads ? { threads: input.threads } : {}),
      runEffectWorker: true,
      runContinuationWorker: true,
      layerServerConfig: Layer.succeed(ServerConfig.ServerConfig, config),
    },
  );
  const initialize = Effect.gen(function* () {
    const orchestrator = yield* OrchestratorV2;
    const outbox = yield* EffectOutboxV2;
    const completed = (commandId: CommandId) =>
      Effect.gen(function* () {
        const updates = yield* outbox.subscribeCompletions;
        const done = yield* Stream.concat(Stream.succeed(undefined), updates).pipe(
          Stream.mapEffect(() => outbox.listByCommandId(commandId)),
          Stream.filter(
            (rows) => rows.length > 0 && rows.every((row) => row.status === "succeeded"),
          ),
          Stream.runHead,
        );
        if (Option.isNone(done)) return yield* Effect.die("Native effect completion stream ended");
      }).pipe(Effect.timeout(input.receiptTimeoutMs ?? 10_000));
    const waitFor = (predicate: (p: OrchestrationV2ThreadProjection) => boolean) =>
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
          return yield* Effect.die("Native background projection ended before receipt");
        return found.value;
      }).pipe(
        Effect.timeout(input.receiptTimeoutMs ?? 10_000),
        Effect.tapError(() =>
          orchestrator.getThreadProjection(threadId).pipe(
            Effect.flatMap((p) =>
              Effect.logWarning("Native background receipt timeout", {
                runs: p.runs.map((r) => ({ id: r.id, status: r.status })),
                sessions: p.providerSessions.map((row) => ({ id: row.id, status: row.status })),
                threads: p.providerThreads.map((row) => ({
                  id: row.id,
                  status: row.status,
                  pending: row.pendingBackgroundTasks,
                })),
                shutdowns: peer.state.shutdowns,
              }),
            ),
          ),
        ),
      );
    let ordinal = 0;
    const send = (text: string) => {
      ordinal++;
      return orchestrator
        .dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(`background-send-${ordinal}`),
          threadId,
          messageId: MessageId.make(`background-message-${ordinal}`),
          text,
          attachments: [],
          createdBy: "user",
          creationSource: "web",
          dispatchMode: { type: "start_immediately" },
        })
        .pipe(Effect.asVoid);
    };
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make("background-create"),
      threadId,
      projectId: ProjectId.make("background-project"),
      title: "Native background",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    return { orchestrator, waitFor, send, completed };
  });
  const run = <A, E, R>(
    body: (state: Effect.Success<typeof initialize>) => Effect.Effect<A, E, R>,
  ) => initialize.pipe(Effect.flatMap(body), Effect.provide(runtimeLayer));
  const emit = (frames: ReadonlyArray<Record<string, unknown>>) =>
    Effect.sync(() => {
      for (const frame of frames) {
        if (frame.type === "agent_start") peer.state.streaming = true;
        if (frame.type === "agent_end" || frame.type === "session_settled")
          peer.state.streaming = false;
        if (frame.type === "session_settled") peer.state.pendingAsyncWork = false;
      }
    }).pipe(Effect.andThen(peer.emit(frames)));
  const finish = (sessionSettled: boolean) => {
    peer.state.pendingAsyncWork = !sessionSettled;
    return emit([
      { type: "agent_end", messages: [], isTerminal: true },
      {
        type: "prompt_result",
        agentInvoked: true,
        id: peer.state.prompts.at(-1)?.frame.id,
        status: "completed",
        sessionSettled,
      },
    ]);
  };
  return { peer, emit, run, finish, threadId };
});
