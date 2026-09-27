/**
 * A real orchestration engine on in-memory SQLite, with the conversation
 * importer and the context-delivery service, for importer and scenario tests.
 * Providers and project clones are controlled by the test.
 */
import {
  CommandId,
  ProjectId,
  type OrchestrationCommand,
  type ProjectCloneSnapshot,
  type ServerProvider,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ServerConfig } from "../../config.ts";
import { OrchestrationEngineLive } from "../../orchestration/Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "../../orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../../orchestration/Layers/ProjectionSnapshotQuery.ts";
import { ScientForkContextDeliveryLive } from "../../orchestration/scient-fork/ForkContextDelivery.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import * as ThreadBackgroundLiveness from "../../orchestration/ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../../orchestration/ThreadPlanProgress.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { ProjectCloneTracker } from "../../project/ProjectCloneTracker.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import { ProviderRegistry } from "../../provider/Services/ProviderRegistry.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import * as ConversationImporterLive from "./ConversationImporterLive.ts";
import { OTHER_PROJECT_ID, PROJECT_ID, PROVIDER_ID } from "./conversationImport.test-fixtures.ts";

export interface ImportTestControls {
  /** Provider instances the server reports, by id; enabled unless listed as false. */
  readonly providers?: ReadonlyMap<string, boolean>;
  readonly clones?: ReadonlyMap<string, ProjectCloneSnapshot["phase"]>;
  /** Runs before each importer dispatch; the real dispatch follows unless it fails. */
  readonly beforeDispatch?: (
    command: OrchestrationCommand,
  ) => Effect.Effect<void, never, OrchestrationEngineService>;
  /** Replaces the importer's dispatch (to fail without committing, or to commit and then fail). */
  readonly dispatch?: (
    command: OrchestrationCommand,
    engine: OrchestrationEngineService["Service"],
  ) => ReturnType<OrchestrationEngineService["Service"]["dispatch"]>;
}

const orchestrationLayer = Layer.mergeAll(
  OrchestrationEngineLive.pipe(
    Layer.provide(OrchestrationProjectionSnapshotQueryLive),
    Layer.provide(OrchestrationProjectionPipelineLive),
  ),
  OrchestrationProjectionSnapshotQueryLive,
  ScientForkContextDeliveryLive,
).pipe(
  Layer.provide(ServerSettingsService.layerTest()),
  Layer.provideMerge(ThreadBackgroundLiveness.layer),
  Layer.provide(ThreadPlanProgress.layer),
  Layer.provide(OrchestrationEventStoreLive),
  Layer.provideMerge(OrchestrationCommandReceiptRepositoryLive),
  Layer.provide(RepositoryIdentityResolver.layer),
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "scient-import-test-" })),
  Layer.provideMerge(NodeServices.layer),
);

export function importTestLayer(controls: ImportTestControls = {}) {
  const providers = controls.providers ?? new Map([[PROVIDER_ID, true]]);
  const importerEngine = Layer.effect(
    OrchestrationEngineService,
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      return {
        ...engine,
        dispatch: (command, options) =>
          (controls.beforeDispatch?.(command) ?? Effect.void).pipe(
            Effect.provideService(OrchestrationEngineService, engine),
            Effect.andThen(
              controls.dispatch?.(command, engine) ?? engine.dispatch(command, options),
            ),
          ),
      } satisfies OrchestrationEngineService["Service"];
    }),
  );
  const importer = ConversationImporterLive.layer.pipe(
    Layer.provide(importerEngine),
    Layer.provide(
      Layer.mock(ProviderRegistry, {
        getProviders: Effect.succeed(
          [...providers].map(
            ([instanceId, enabled]) => ({ instanceId, enabled }) as unknown as ServerProvider,
          ),
        ),
      }),
    ),
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
  );
  return importer.pipe(Layer.provideMerge(orchestrationLayer));
}

/** The two destination projects every importer test can use. */
export const createProjects = Effect.gen(function* () {
  const engine = yield* OrchestrationEngineService;
  for (const projectId of [PROJECT_ID, OTHER_PROJECT_ID]) {
    yield* engine.dispatch({
      type: "project.create",
      commandId: CommandId.make(`create-${projectId}`),
      projectId: ProjectId.make(projectId),
      title: projectId,
      workspaceRoot: `/tmp/${projectId}`,
      defaultModelSelection: null,
      createdAt: "2026-09-27T09:00:00.000Z",
    });
  }
});
