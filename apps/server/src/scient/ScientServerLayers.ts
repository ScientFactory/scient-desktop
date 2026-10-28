/**
 * Pass shared upstream layers into composition so every Scient consumer receives the same instances
 * rather than independently constructing ownership services.
 */
import * as Layer from "effect/Layer";

import { ComputeMcpGatewayLive } from "../mcp/toolkits/compute/ComputeMcpGateway.ts";
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
import * as LatexTexDirectory from "./latex/latexTexDirectory.ts";
import * as LatexSyncTex from "./latex/LatexSyncTex.ts";
import * as LatexTikzPreview from "./latex/LatexTikzPreview.ts";
import { scientSourcesHttpApiLayer } from "./sources/http.ts";
import { scientLatexHttpApiLayer } from "./latex/http.ts";
import { scientMarkdownHttpApiLayer } from "./markdown/http.ts";
import { scientPdfHttpApiLayer } from "./pdf/http.ts";
import { scientThreadQueueHttpApiLayer } from "./threadQueue/http.ts";
import { scientConversationExportHttpApiLayer } from "./conversationExport/http.ts";
import * as ConversationExportFiles from "./conversationExport/ConversationExportFiles.ts";
import * as ConversationExportService from "./conversationExport/ConversationExportService.ts";
import * as EditorFlush from "./editorFlush/EditorFlush.ts";
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
>(shared: {
  readonly PersistenceLayerLive: Layer.Layer<PersistenceOut, PersistenceError, PersistenceIn>;
  readonly ServerSettingsLayerLive: Layer.Layer<SettingsOut, SettingsError, SettingsIn>;
  readonly OwnedLocalEndpointRegistryLive: Layer.Layer<EndpointsOut, EndpointsError, EndpointsIn>;
}) {
  const { PersistenceLayerLive, ServerSettingsLayerLive, OwnedLocalEndpointRegistryLive } = shared;

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

  // Mount one package installer for managed setup and builds so tlmgr serialization spans both.
  // Share probe cache with HTTP/installer invalidation, and use the selected TeX-readable location
  // rather than assuming profile latexDir.
  const ScientLatexServicesLive = Layer.mergeAll(
    LatexBuildService.layer,
    LatexTikzPreview.layer,
  ).pipe(
    Layer.provide(LocalExecutionProcess.layer),
    Layer.provideMerge(LatexSyncTex.layer),
    Layer.provideMerge(LatexManagedToolchain.layer.pipe(Layer.provideMerge(LatexToolchain.layer))),
    Layer.provideMerge(LatexPackageInstaller.layer),
    Layer.provide(LatexTexDirectory.layer),
  );

  /** Scient HTTP API groups, provided in order after the upstream groups. */
  const provideScientHttpApiGroups = <A, E, R>(self: Layer.Layer<A, E, R>) =>
    self.pipe(
      Layer.provide(scientProjectHttpApiLayer),
      Layer.provide(scientSourcesHttpApiLayer),
      Layer.provide(scientAnalyticsHttpApiLayer),
      Layer.provide(scientLatexHttpApiLayer),
      Layer.provide(scientMarkdownHttpApiLayer),
      Layer.provide(scientPdfHttpApiLayer),
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
      // One server-lifetime set of connected windows, shared by the WebSocket
      // handlers that windows answer on and the tools that ask them.
      Layer.provide(EditorFlush.layer),
    );

  return { provideScientHttpApiGroups, provideScientRouteServices };
}
