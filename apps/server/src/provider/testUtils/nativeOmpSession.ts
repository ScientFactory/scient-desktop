import {
  MessageId,
  NodeId,
  OmpSettings,
  ProjectId,
  RunAttemptId,
  RunId,
  type ModelSelection,
  type OrchestrationV2AppThread,
  type ProviderInstanceId,
  type ProviderTurnId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";
import * as ServerConfig from "../../config.ts";
import * as IdAllocator from "../../orchestration-v2/IdAllocator.ts";
import type { ProviderAdapterV2TurnInput } from "../../orchestration-v2/ProviderAdapter.ts";
import { makeOmpAdapterV2 } from "../../orchestration-v2/Adapters/OmpAdapterV2.ts";
import type { EventNdjsonLogger } from "../Layers/EventNdjsonLogger.ts";
import type { OmpTarget } from "../omp/OmpTarget.ts";

const decodeSettings = Schema.decodeEffect(OmpSettings);

/** Real native OMP conversation ownership for isolated transport and CLI fixtures. */
export const nativeOmpSession = Effect.fnUntraced(function* (input: {
  readonly root: string;
  readonly stateDir: string;
  readonly attachmentsDir: string;
  readonly target: OmpTarget;
  readonly instanceId: ProviderInstanceId;
  readonly threadId: ThreadId;
  readonly binaryPath: string;
  readonly homePath?: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly modelSelection: ModelSelection;
  readonly nativeEventLogger?: EventNdjsonLogger;
  readonly makeProcess: Parameters<typeof makeOmpAdapterV2>[0]["makeProcess"];
}) {
  const scope = yield* Scope.make();
  yield* Effect.addFinalizer((exit) => Scope.close(scope, exit));
  return yield* Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const allocator = yield* IdAllocator.IdAllocatorV2;
    const adapter = makeOmpAdapterV2({
      target: input.target,
      instanceId: input.instanceId,
      settings: yield* decodeSettings({
        binaryPath: input.binaryPath,
        ...(input.homePath ? { homePath: input.homePath } : {}),
      }),
      ...(input.homePath ? { homePath: input.homePath } : {}),
      environment: input.environment,
      fileSystem: yield* FileSystem.FileSystem,
      path: yield* Path.Path,
      crypto: yield* Crypto.Crypto,
      spawner: yield* ChildProcessSpawner.ChildProcessSpawner,
      idAllocator: allocator,
      serverConfig: {
        ...config,
        cwd: input.root,
        stateDir: input.stateDir,
        attachmentsDir: input.attachmentsDir,
      },
      makeProcess: input.makeProcess,
      ...(input.nativeEventLogger ? { nativeEventLogger: input.nativeEventLogger } : {}),
      continuations: { offer: () => Effect.void },
    });
    const policy = {
      cwd: input.root,
      runtimeMode: "full-access" as const,
      interactionMode: "default" as const,
    };
    const runtime = yield* adapter.openSession({
      threadId: input.threadId,
      providerSessionId: yield* allocator.allocate.providerSession({
        providerInstanceId: input.instanceId,
        threadId: input.threadId,
      }),
      modelSelection: input.modelSelection,
      runtimePolicy: policy,
    });
    const providerThread = yield* runtime.ensureThread({
      threadId: input.threadId,
      modelSelection: input.modelSelection,
      runtimePolicy: policy,
    });
    const now = yield* DateTime.now;
    const appThread: OrchestrationV2AppThread = {
      id: input.threadId,
      projectId: ProjectId.make("native-omp-fixture"),
      title: "Native OMP fixture",
      createdBy: "user",
      creationSource: "web",
      providerInstanceId: input.instanceId,
      modelSelection: input.modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: null,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: input.threadId },
      forkedFrom: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    };
    let ordinal = 0;
    let activeTurnId: ProviderTurnId | undefined;
    const events = runtime.events.pipe(
      Stream.tap((event) =>
        Effect.sync(() => {
          if (event.type === "provider_turn.updated" && event.providerTurn.status === "running")
            activeTurnId = event.providerTurn.id;
          if (event.type === "turn.terminal" && event.providerTurnId === activeTurnId)
            activeTurnId = undefined;
        }),
      ),
    );
    const start = (
      message: Partial<ProviderAdapterV2TurnInput["message"]> & { readonly text: string },
      modelSelection: ModelSelection = input.modelSelection,
    ) =>
      Effect.suspend(() => {
        ordinal++;
        return runtime.startTurn({
          appThread,
          threadId: input.threadId,
          providerThread,
          modelSelection,
          runtimePolicy: policy,
          runId: RunId.make(`${input.threadId}-run-${ordinal}`),
          attemptId: RunAttemptId.make(`${input.threadId}-attempt-${ordinal}`),
          runOrdinal: ordinal,
          providerTurnOrdinal: ordinal,
          rootNodeId: NodeId.make(`${input.threadId}-node-${ordinal}`),
          message: {
            messageId: MessageId.make(`${input.threadId}-message-${ordinal}`),
            attachments: [],
            createdBy: "user",
            creationSource: "web",
            ...message,
          },
        });
      });
    const interrupt = Effect.suspend(() =>
      activeTurnId === undefined
        ? Effect.void
        : runtime.interruptTurn({ providerThread, providerTurnId: activeTurnId }),
    );
    return {
      adapter,
      runtime,
      providerThread,
      events,
      start,
      interrupt,
      close: Scope.close(scope, Exit.void),
    };
  }).pipe(
    Effect.provideService(Scope.Scope, scope),
    Effect.provide(
      Layer.mergeAll(IdAllocator.layer, ServerConfig.layerTest(input.root, input.root)),
    ),
    Effect.onExit((exit) => (Exit.isFailure(exit) ? Scope.close(scope, exit) : Effect.void)),
  );
});
