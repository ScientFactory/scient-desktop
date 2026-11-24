/**
 * What Scient's product adds to T3's provider replay harness: options, errors, extra outputs
 * and one layer of Scient's orchestration services, built from the harness's own layers.
 */
import type { ResponseStreamingMode } from "@t3tools/contracts";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import type * as Path from "effect/Path";

import type * as CheckpointStore from "../../checkpointing/CheckpointStore.ts";
import type * as ServerConfig from "../../config.ts";
import type { GitWorkflowService } from "../../git/GitWorkflowService.ts";
import type * as McpSessionRegistry from "../../mcp/McpSessionRegistry.ts";
import type { V2DatabaseImportError } from "../../persistence/initializeV2Database.ts";
import type * as ProviderRegistry from "../../provider/ProviderRegistry.ts";
import type * as ServerSettings from "../../serverSettings.ts";
import * as VcsProcess from "../../vcs/VcsProcess.ts";
import { layer as attachmentReconciliationLayer } from "../AttachmentReservationReconciliation.ts";
import { layer as attachmentRollbackPruneLayer } from "../AttachmentRollbackPruneService.ts";
import type * as CheckpointService from "../CheckpointService.ts";
import type * as CommandReceiptStore from "../CommandReceiptStore.ts";
import * as EventSink from "../EventSink.ts";
import type * as EventStore from "../EventStore.ts";
import * as LegacyV1ThreadImporter from "../legacy/LegacyV1ThreadImporter.ts";
import type * as ProjectionStore from "../ProjectionStore.ts";
import type * as ProjectStore from "../ProjectStore.ts";
import type * as ProviderTurnStartService from "../ProviderTurnStartService.ts";
import type * as RuntimePolicy from "../RuntimePolicy.ts";
import { ContextHandoffPolicyOverride } from "../ScientContextHandoffPolicy.ts";
import * as ConversationForks from "../scient-fork/ConversationForkService.ts";
import {
  ScientForkCheckpointBaseline,
  ScientForkCheckpointBaselineLive,
  type ScientForkCheckpointBaselineShape,
} from "../scient-fork/ForkCheckpointBaseline.ts";
import type { ScientMigrationError } from "../scient-fork/scientMigrator.ts";
import { layer as threadFileReleaseLayer } from "../scient-fork/ThreadFileRelease.ts";
import type * as ThreadManagementService from "../ThreadManagementService.ts";
import { layerRecordedProviderRegistry } from "./ScientHarnessLayers.ts";

/** Scient's database layers also run its own migrations and the V1 database import. */
export type ScientReplayErrors = ScientMigrationError | V2DatabaseImportError;

export interface ScientReplayOptions {
  /** Preserve one disposable profile across file-backed restart and recovery tests. */
  readonly layerServerConfig?: Layer.Layer<ServerConfig.ServerConfig>;
  readonly layerServerSettings?: Layer.Layer<ServerSettings.ServerSettingsService>;
  readonly responseStreamingMode?: ResponseStreamingMode;
  readonly providerSessionIdleTimeoutMs?: number;
  /** Capture explicitly supplied thread operations in the actual effect worker. */
  readonly threads?: Partial<ThreadManagementService.ThreadManagementServiceShape>;
  /** Observe or gate the real canonical writer without replacing its SQL transaction. */
  readonly decorateEventSink?: (sink: EventSink.EventSinkV2Shape) => EventSink.EventSinkV2Shape;
  /** Gate actual Git capture without replacing publication or admission. */
  readonly decorateForkCheckpointBaseline?: (
    baseline: ScientForkCheckpointBaselineShape,
  ) => ScientForkCheckpointBaselineShape;
  /** Run actual attachment cleanup on isolated test profiles. */
  readonly resourceCleanupLayer?: Layer.Layer<
    never,
    never,
    ServerConfig.ServerConfig | FileSystem.FileSystem
  >;
  /** Exercise native fork checkout with the production Git workflow. */
  readonly forkGitWorkflowLayer?: Layer.Layer<GitWorkflowService, never, ServerConfig.ServerConfig>;
  /** Exercise production session credential issuance; disabled for recorded transports. */
  readonly configureMcp?: boolean;
  readonly mcpSessionRegistryLayer?: Layer.Layer<McpSessionRegistry.McpSessionRegistry>;
  readonly mcpProviderSessionsLayer?: Layer.Layer<McpProviderSessions.McpProviderSessions>;
  /** Auth integration tests must supply the actual snapshot registry. */
  readonly providerRegistryLayer?: Layer.Layer<ProviderRegistry.ProviderRegistry>;
  /** Replaces the replay workspace policy, before any scenario override applies. */
  readonly runtimePolicyLayer?: Layer.Layer<RuntimePolicy.RuntimePolicyV2>;
  /** Inject an external Git process failure while retaining native checkpoint services. */
  readonly vcsProcessLayer?: Layer.Layer<VcsProcess.VcsProcess>;
  /** Existing conservative byte-policy fixtures can opt out of Scient preset budgets. */
  readonly contextHandoffPolicy?: "scient" | "byte";
}

/** The harness's own services Scient tests also read. */
export type ScientReplayServices =
  | ProviderTurnStartService.ProviderTurnStartServiceV2
  | CommandReceiptStore.CommandReceiptStoreV2
  | EventStore.EventStoreV2
  | ProjectionStore.ProjectionStoreV2
  | ProjectStore.ProjectStoreV2
  | CheckpointService.CheckpointServiceV2
  | CheckpointStore.CheckpointStore
  | ConversationForks.ConversationForkService
  | LegacyV1ThreadImporter.LegacyV1ThreadImporter
  | McpProviderSessions.McpProviderSessions
  | ServerConfig.ServerConfig
  | ServerSettings.ServerSettingsService;

/** Scient's state folders inside one replay profile. */
export const scientReplayStatePaths = (path: Path.Path, stateDir: string) => ({
  analysisDir: path.join(stateDir, "analysis"),
  computeDir: path.join(stateDir, "compute"),
  latexDir: path.join(stateDir, "latex"),
  documentArtifactsDir: path.join(stateDir, "document-artifacts"),
});

/** What the whole replay runtime reads in Scient; a test's fork Git replaces T3's double. */
const layerRuntimeBase = (options: ScientReplayOptions) =>
  Layer.mergeAll(
    options.providerRegistryLayer ?? layerRecordedProviderRegistry,
    attachmentReconciliationLayer,
    LegacyV1ThreadImporter.layer,
    options.forkGitWorkflowLayer ?? Layer.empty,
  );

/** Only context handoff and turn start read the byte policy, not the orchestrator's sources. */
const layerUpperBase = (options: ScientReplayOptions) =>
  options.contextHandoffPolicy === "byte"
    ? Layer.succeed(ContextHandoffPolicyOverride, "byte")
    : Layer.empty;

/** Scient's orchestration services, which also need the harness's session manager. */
const layerServices = (options: ScientReplayOptions) => {
  const decorate = options.decorateForkCheckpointBaseline;
  return Layer.mergeAll(
    ConversationForks.layer.pipe(
      Layer.provide(
        decorate === undefined
          ? ScientForkCheckpointBaselineLive
          : Layer.effect(
              ScientForkCheckpointBaseline,
              Effect.map(ScientForkCheckpointBaseline, decorate),
            ).pipe(Layer.provide(ScientForkCheckpointBaselineLive)),
      ),
      Layer.provide(VcsProcess.layer),
    ),
    attachmentRollbackPruneLayer,
    threadFileReleaseLayer,
    options.resourceCleanupLayer ?? Layer.empty,
  );
};

/**
 * Puts Scient's services under T3's replay runtime from the harness's own memoized layers,
 * exporting only them, `shared`, `upper` and `leaves`, so a caller's registry, Git or database
 * still wins. `upper` never sees `leaves`: the session manager reads config optionally.
 */
export const withScientServices =
  <A, E1, R1, B, E2, R2, C, E3, R3, D, E4, R4>(
    layers: {
      readonly leaves: Layer.Layer<A, E1, R1>;
      readonly database: Layer.Layer<D, E4, R4>;
      readonly shared: Layer.Layer<C, E3, R3>;
      readonly upper: Layer.Layer<B, E2, R2>;
    },
    options: ScientReplayOptions,
  ) =>
  <ROut, E, RIn>(runtime: Layer.Layer<ROut, E, RIn>) => {
    const { leaves, database, shared, upper } = layers;
    const base = layerRuntimeBase(options).pipe(Layer.provide(Layer.merge(leaves, database)));
    const exported = layerServices(options).pipe(
      Layer.provideMerge(LegacyV1ThreadImporter.layer),
      Layer.provide(database),
      Layer.provideMerge(
        Layer.mergeAll(
          upper.pipe(Layer.provide(layerUpperBase(options)), Layer.provideMerge(shared)),
          leaves,
        ),
      ),
    );
    return runtime.pipe(Layer.provideMerge(exported), Layer.provide(base));
  };

/** Wraps the harness's real event sink when a test observes or gates it. */
export const decorateEventSink =
  (decorate: ScientReplayOptions["decorateEventSink"]) =>
  <E, R>(
    sink: Layer.Layer<EventSink.EventSinkV2, E, R>,
  ): Layer.Layer<EventSink.EventSinkV2, E, R> =>
    decorate === undefined
      ? sink
      : Layer.effect(EventSink.EventSinkV2, Effect.map(EventSink.EventSinkV2, decorate)).pipe(
          Layer.provide(sink),
        );

/** A pipe step that swaps T3's layer for Scient's, or a test's, when one is given. */
export const replaceWith =
  <A, E2, R2>(replacement: Layer.Layer<A, E2, R2> | undefined) =>
  <E, R>(layer: Layer.Layer<A, E, R>): Layer.Layer<A, E | E2, R | R2> =>
    replacement ?? layer;
