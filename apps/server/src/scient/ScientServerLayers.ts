/**
 * Scient server composition: the Scient services, HTTP groups and provider
 * lifecycle layers that server.ts mounts into the shared server layer.
 * Shared upstream layers are passed in so every consumer builds the same
 * layer instance.
 *
 * @module ScientServerLayers
 */
import { ServerSelfUpdateError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerSelfUpdate from "../cloud/selfUpdate.ts";
import * as ServerConfig from "../config.ts";
import { ComputeMcpGatewayLive } from "../mcp/toolkits/compute/ComputeMcpGateway.ts";
import * as ProviderRuntimeRecovery from "../orchestration-v2/ProviderRuntimeRecoveryService.ts";
import * as ProcessRunner from "../processRunner.ts";
import { scientAnalyticsHttpApiLayer } from "../telemetry/http.ts";
import { scientProjectHttpApiLayer } from "../scientProject/http.ts";
import * as WorkspaceAuthorityProjection from "./projectScope/WorkspaceAuthorityProjection.ts";
import * as WorkspaceBindingEvidence from "./projectScope/WorkspaceBindingEvidence.ts";
import * as WorkspaceBindingResolver from "./projectScope/WorkspaceBindingResolver.ts";
import * as WorkspaceBindingStore from "./projectScope/WorkspaceBindingStore.ts";
import * as ProviderConnectionManager from "./providerLifecycle/ProviderConnectionManager.ts";
import * as ProviderLifecycleCoordinator from "./providerLifecycle/ProviderLifecycleCoordinator.ts";
import * as ProviderActivity from "./providerLifecycle/ProviderActivity.ts";
import * as ProviderRuntimeManager from "./providerLifecycle/ProviderRuntimeManager.ts";
import * as ManagedRuntimeCatalogReconciler from "./providerLifecycle/ManagedRuntimeCatalogReconciler.ts";
import * as AnalysisService from "./analysis/AnalysisService.ts";
import * as LocalAnalysisStore from "./analysis/LocalAnalysisStore.ts";
import * as AnalysisRunIndex from "./analysis/AnalysisRunIndex.ts";
import * as LocalDuplexProcess from "./execution/LocalDuplexProcess.ts";
import * as LocalExecutionProcess from "./execution/LocalExecutionProcess.ts";
import * as LocalComputeStore from "./compute/LocalComputeStore.ts";
import * as ComputeRuntimeRegistry from "./compute/ComputeRuntimeRegistry.ts";
import * as ScientificRuntimePreferences from "./compute/ScientificRuntimePreferences.ts";
import * as LatexBuildService from "./latex/LatexBuildService.ts";
import * as LatexManagedToolchain from "./latex/LatexManagedToolchain.ts";
import * as LatexPackageInstaller from "./latex/LatexPackageInstaller.ts";
import * as LatexToolchain from "./latex/LatexToolchain.ts";
import * as LatexSyncTex from "./latex/LatexSyncTex.ts";
import { scientSourcesHttpApiLayer } from "./sources/http.ts";
import { scientLatexHttpApiLayer } from "./latex/http.ts";
import { scientMarkdownHttpApiLayer } from "./markdown/http.ts";
import { scientThreadQueueHttpApiLayer } from "./threadQueue/http.ts";
import { scientConversationExportHttpApiLayer } from "./conversationExport/http.ts";
import * as ConversationExportFiles from "./conversationExport/ConversationExportFiles.ts";
import * as ConversationExportService from "./conversationExport/ConversationExportService.ts";
import * as ConversationSnapshotService from "./conversationExport/ConversationSnapshotService.ts";
import { scientConversationImportHttpApiLayer } from "./conversationImport/http.ts";
import * as ConversationImportStaging from "./conversationImport/ConversationImportStaging.ts";
import * as ConversationImporterLive from "./conversationImport/ConversationImporterLive.ts";
import * as ConversationImportCommit from "./conversationImport/ConversationImportCommit.ts";
import * as ScientSkillSession from "./skills/ScientSkillSession.ts";
import * as ScientSkillManagement from "./skills/ScientSkillManagement.ts";
import { scientWordExportHttpApiLayer } from "./pandoc/http.ts";
import * as PandocManagedTool from "./pandoc/PandocManagedTool.ts";
import * as PandocWordConverter from "./pandoc/PandocWordConverter.ts";
import * as WordFileExport from "./pandoc/WordFileExport.ts";

// Skill discovery and selected-turn delivery share one live policy/catalog.
export const ScientSkillsLayerLive = ScientSkillManagement.layer.pipe(
  Layer.provideMerge(ScientSkillSession.live),
);

export const WorkspaceBindingResolverLayerLive = WorkspaceBindingResolver.layer.pipe(
  Layer.provide(WorkspaceAuthorityProjection.layer),
  Layer.provide(WorkspaceBindingEvidence.layer),
  Layer.provide(WorkspaceBindingStore.layer),
);

/** Connection, runtime and catalog managers over one lifecycle coordinator. */
export const ScientProviderLifecycleLive = Layer.mergeAll(
  ProviderConnectionManager.layer,
  ProviderRuntimeManager.layer,
  ManagedRuntimeCatalogReconciler.layer,
).pipe(
  Layer.provideMerge(ProviderLifecycleCoordinator.layer),
  Layer.provideMerge(ProviderActivity.layer),
);

/** Scient route services built over the server's shared layers. */
export function makeScientRouteServices<
  PersistenceOut,
  PersistenceError,
  PersistenceIn,
  SettingsOut,
  SettingsError,
  SettingsIn,
  EndpointsOut,
  EndpointsError,
  EndpointsIn,
  UpdateOut,
  UpdateError,
  UpdateIn,
>(shared: {
  readonly PersistenceLayerLive: Layer.Layer<PersistenceOut, PersistenceError, PersistenceIn>;
  readonly ServerSettingsLayerLive: Layer.Layer<SettingsOut, SettingsError, SettingsIn>;
  readonly OwnedLocalEndpointRegistryLive: Layer.Layer<EndpointsOut, EndpointsError, EndpointsIn>;
  readonly DesktopAppUpdateLayerLive: Layer.Layer<UpdateOut, UpdateError, UpdateIn>;
}) {
  const {
    PersistenceLayerLive,
    ServerSettingsLayerLive,
    OwnedLocalEndpointRegistryLive,
    DesktopAppUpdateLayerLive,
  } = shared;

  const AnalysisRunIndexLive = AnalysisRunIndex.layer.pipe(Layer.provide(PersistenceLayerLive));
  // Word export runs the managed Pandoc. One tool serves the converter, the
  // install endpoint, and both exports, so an install is single-flight.
  const PandocWordConverterLive = PandocWordConverter.layer.pipe(
    Layer.provideMerge(PandocManagedTool.layer),
  );
  // Conversation export reads one transactional snapshot and writes temporary files.
  const ConversationExportServiceLive = ConversationExportService.layer.pipe(
    Layer.provide(ConversationSnapshotService.layer.pipe(Layer.provide(PersistenceLayerLive))),
    Layer.provide(ConversationExportFiles.layer),
    Layer.provide(PandocWordConverterLive),
  );
  const WordFileExportLive = WordFileExport.layer.pipe(
    Layer.provide(ConversationExportFiles.layer),
    Layer.provideMerge(PandocWordConverterLive),
  );
  // Import staging: uploads, validation, preview, and durable import commit.
  const ConversationImportStagingLive = ConversationImportStaging.layer().pipe(
    Layer.provide(
      ConversationImporterLive.layer.pipe(Layer.provide(ConversationImportCommit.layer)),
    ),
  );
  const ScientificRuntimePreferencesLive = ScientificRuntimePreferences.layer.pipe(
    Layer.provide(ServerSettingsLayerLive),
    Layer.provide(LocalAnalysisStore.layer),
  );

  const AnalysisServiceLive = AnalysisService.layer.pipe(
    Layer.provide(LocalAnalysisStore.layer),
    Layer.provide(AnalysisRunIndexLive),
    Layer.provide(LocalExecutionProcess.layer),
  );

  // The compute session service owns both process ports: one-shot for the
  // interpreter probe, duplex for the bridge it talks to. The store is mounted
  // here rather than inside the service so the disk that holds a session's
  // history has one owner for the life of the server.
  const ComputeSessionServiceLive = ComputeRuntimeRegistry.layer.pipe(
    Layer.provide(LocalComputeStore.layer),
    Layer.provide(LocalExecutionProcess.layer),
    Layer.provide(LocalDuplexProcess.layer),
    Layer.provide(OwnedLocalEndpointRegistryLive),
  );

  // The build coordinator owns its execution port the way the analysis runtime
  // does; the toolchain probe is merged out because the HTTP group reads it too,
  // and the managed installer sits on top of the probe so a finished install can
  // drop its cache. The package installer is mounted once for both, because
  // `tlmgr` serializes against a single distribution tree.
  const ScientLatexServicesLive = LatexBuildService.layer.pipe(
    Layer.provide(LocalExecutionProcess.layer),
    Layer.provideMerge(LatexSyncTex.layer),
    Layer.provideMerge(LatexManagedToolchain.layer.pipe(Layer.provideMerge(LatexToolchain.layer))),
    Layer.provideMerge(LatexPackageInstaller.layer),
  );

  /** Scient HTTP API groups, provided in order after the upstream groups. */
  const provideScientHttpApiGroups = <A, E, R>(self: Layer.Layer<A, E, R>) =>
    self.pipe(
      Layer.provide(scientProjectHttpApiLayer),
      Layer.provide(scientSourcesHttpApiLayer),
      Layer.provide(scientAnalyticsHttpApiLayer),
      Layer.provide(scientLatexHttpApiLayer),
      Layer.provide(scientMarkdownHttpApiLayer),
      Layer.provide(scientThreadQueueHttpApiLayer.pipe(Layer.provide(PersistenceLayerLive))),
      Layer.provide(scientConversationExportHttpApiLayer),
      Layer.provide(scientConversationImportHttpApiLayer),
      Layer.provide(scientWordExportHttpApiLayer),
    );

  /** Scient services behind the routes, provided in order. */
  const provideScientRouteServices = <A, E, R>(self: Layer.Layer<A, E, R>) =>
    self.pipe(
      Layer.provide(AnalysisServiceLive),
      Layer.provide(ConversationExportServiceLive),
      Layer.provide(ConversationImportStagingLive),
      Layer.provide(WordFileExportLive),
      Layer.provide(ComputeMcpGatewayLive),
      Layer.provide(ComputeSessionServiceLive),
      Layer.provide(ScientificRuntimePreferencesLive),
      Layer.provide(ScientLatexServicesLive),
    );

  /** Self-update that hands running threads to the next server. */
  const ScientServerSelfUpdateLive = Layer.effect(
    ServerSelfUpdate.ServerSelfUpdate,
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const recovery = yield* ProviderRuntimeRecovery.ProviderRuntimeRecoveryService;
      return yield* ServerSelfUpdate.withRunningThreadContinuation({
        mode: config.mode,
        selfUpdate: yield* ServerSelfUpdate.make(),
        prepare: recovery.prepareForUpdate.pipe(
          Effect.mapError(
            (cause) =>
              new ServerSelfUpdateError({
                reason: "Could not prepare running thread continuation.",
                cause,
              }),
          ),
        ),
        clear: recovery.clearUpdateContinuation,
      });
    }),
  ).pipe(Layer.provide(DesktopAppUpdateLayerLive), Layer.provide(ProcessRunner.layer));

  return { provideScientHttpApiGroups, provideScientRouteServices, ScientServerSelfUpdateLive };
}
