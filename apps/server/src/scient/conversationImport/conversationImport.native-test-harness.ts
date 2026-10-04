/** Native import tests use the production commit, stores and event sink on isolated SQLite. */
import {
  CommandId,
  EventId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProjectCloneSnapshot,
  type ServerProvider,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import { makeOrchestratorV2ReplayLayerWithRegistry } from "../../orchestration-v2/testkit/ProviderReplayHarness.ts";
import type { ProviderAdapterRegistryV2 } from "../../orchestration-v2/ProviderAdapterRegistry.ts";

import { ServerConfig } from "../../config.ts";
import * as EventStore from "../../orchestration-v2/EventStore.ts";
import * as EventSink from "../../orchestration-v2/EventSink.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import * as Receipts from "../../orchestration-v2/CommandReceiptStore.ts";
import * as Executor from "../../orchestration-v2/ThreadCommandExecutor.ts";
import * as SqlitePersistence from "../../persistence/Layers/Sqlite.ts";
import { ProjectCloneTracker } from "../../project/ProjectCloneTracker.ts";
import { ProviderRegistry } from "../../provider/Services/ProviderRegistry.ts";
import * as Commit from "./ConversationImportCommit.ts";
import * as ImporterLive from "./ConversationImporterLive.ts";
import type { PortableConversationImportPlan } from "./conversationImportPlan.ts";
import { OTHER_PROJECT_ID, PROJECT_ID, PROVIDER_ID } from "./conversationImport.test-fixtures.ts";

export interface NativeImportTestControls {
  readonly persistence?: "memory" | "file";
  readonly providers?: ReadonlyMap<string, boolean>;
  readonly clones?: ReadonlyMap<string, ProjectCloneSnapshot["phase"]>;
  /** Pause or fail at the commit boundary; production commit follows unless replaced. */
  readonly beforeDispatch?: (
    plan: PortableConversationImportPlan,
  ) => Effect.Effect<void, never, EventSink.EventSinkV2>;
  readonly dispatch?: (
    plan: PortableConversationImportPlan,
    commit: Commit.ConversationImportCommit["Service"],
  ) => ReturnType<Commit.ConversationImportCommit["Service"]["dispatch"]>;
}

export function nativeImportTestLayer(controls: NativeImportTestControls = {}) {
  const stores = Layer.mergeAll(
    EventStore.layer,
    ProjectionStore.layer,
    ProjectStore.layer,
    Receipts.layer,
    Executor.layer,
  ).pipe(
    Layer.provideMerge(
      controls.persistence === "file"
        ? SqlitePersistence.layerConfig
        : SqlitePersistence.SqlitePersistenceMemory,
    ),
  );
  const native = Commit.layer.pipe(
    Layer.provideMerge(EventSink.layer.pipe(Layer.provideMerge(stores))),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "scient-v2-import-test-" })),
    Layer.provideMerge(NodeServices.layer),
  );
  const controlledCommit = Layer.effect(
    Commit.ConversationImportCommit,
    Effect.gen(function* () {
      const commit = yield* Commit.ConversationImportCommit;
      const sink = yield* EventSink.EventSinkV2;
      return Commit.ConversationImportCommit.of({
        dispatch: (plan) =>
          (controls.beforeDispatch?.(plan) ?? Effect.void).pipe(
            Effect.provideService(EventSink.EventSinkV2, sink),
            Effect.andThen(controls.dispatch?.(plan, commit) ?? commit.dispatch(plan)),
          ),
      });
    }),
  );
  const providers = controls.providers ?? new Map([[PROVIDER_ID, true]]);
  const configured: ServerProvider[] = [...providers].map(([instanceId, enabled]) => ({
    instanceId: ProviderInstanceId.make(instanceId),
    driver: ProviderDriverKind.make("codex"),
    enabled,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-10-04T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
  }));
  return ImporterLive.layer.pipe(
    Layer.provide(controlledCommit),
    Layer.provide(Layer.mock(ProviderRegistry, { getProviders: Effect.succeed(configured) })),
    Layer.provide(
      Layer.mock(ProjectCloneTracker, {
        get: (projectId) =>
          Effect.succeed(
            controls.clones?.has(projectId) === true
              ? ({ phase: controls.clones.get(projectId)! } as ProjectCloneSnapshot)
              : null,
          ),
      }),
    ),
    Layer.provideMerge(native),
  );
}

export const createNativeProjects = Effect.gen(function* () {
  const sink = yield* EventSink.EventSinkV2;
  const now = yield* DateTime.now;
  const workspaceRoot = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped({
    prefix: "scient-native-import-workspace-",
  });
  for (const projectId of [PROJECT_ID, OTHER_PROJECT_ID]) {
    yield* sink.commitProjectCommand({
      commandId: CommandId.make(`native-create-${projectId}`),
      projectId: ProjectId.make(projectId),
      commandType: "project.create",
      acceptedAt: now,
      event: {
        eventId: EventId.make(`native-project-${projectId}`),
        type: "project.created",
        aggregateKind: "project",
        aggregateId: projectId,
        occurredAt: DateTime.formatIso(now),
        commandId: null,
        causationEventId: null,
        correlationId: null,
        metadata: {},
        payload: {
          projectId,
          title: projectId,
          workspaceRoot,
          defaultModelSelection: null,
          scripts: [],
          createdAt: DateTime.formatIso(now),
          updatedAt: DateTime.formatIso(now),
        },
      },
    });
  }
});

export const deleteNativeProject = Effect.gen(function* () {
  const now = yield* DateTime.now;
  const commandId = CommandId.make("native-delete-destination");
  yield* (yield* EventSink.EventSinkV2).commitProjectCommand({
    commandId,
    projectId: PROJECT_ID,
    commandType: "project.delete",
    acceptedAt: now,
    event: {
      eventId: EventId.make("native-delete-destination"),
      type: "project.deleted",
      aggregateKind: "project",
      aggregateId: PROJECT_ID,
      occurredAt: DateTime.formatIso(now),
      commandId,
      causationEventId: null,
      correlationId: null,
      metadata: {},
      payload: { projectId: PROJECT_ID, deletedAt: DateTime.formatIso(now) },
    },
  });
}).pipe(Effect.orDie, Effect.asVoid);

/** Full native runtime for import continuation and fork tests; transports remain synthetic. */
export function nativeImportRuntimeTestLayer(
  registryLayer: Layer.Layer<ProviderAdapterRegistryV2>,
  options: Parameters<typeof makeOrchestratorV2ReplayLayerWithRegistry>[2] = {},
) {
  const database = SqlitePersistence.SqlitePersistenceMemory;
  const runtime = makeOrchestratorV2ReplayLayerWithRegistry(
    { name: "scient-import-continuation" },
    registryLayer,
    { databaseLayer: database, configureMcp: false, ...options },
  ).pipe(
    Layer.provideMerge(database),
    Layer.provideMerge(NodeServices.layer),
    Layer.provideMerge(Executor.layer),
  );
  const provider: ServerProvider = {
    instanceId: PROVIDER_ID,
    driver: ProviderDriverKind.make("codex"),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-10-04T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
  };
  return ImporterLive.layer.pipe(
    Layer.provideMerge(Commit.layer),
    Layer.provide(Layer.mock(ProviderRegistry, { getProviders: Effect.succeed([provider]) })),
    Layer.provide(Layer.mock(ProjectCloneTracker, { get: () => Effect.succeed(null) })),
    Layer.provideMerge(runtime),
  );
}
