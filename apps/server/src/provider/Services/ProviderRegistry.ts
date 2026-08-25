/**
 * ProviderRegistry - Provider snapshot service.
 *
 * Owns provider install/auth/version/model snapshots and exposes the latest
 * provider state to transport layers.
 *
 * @module ProviderRegistry
 */
import type {
  ProviderInstanceId,
  ProviderDriverKind,
  ProviderConnectionOperation,
  ProviderRuntimeSummary,
  ServerProvider,
  ServerProviderUpdateState,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";
import type { ProviderMaintenanceCapabilities } from "../providerMaintenance.ts";
import type {
  ProviderConnectionActions,
  ProviderManagedRuntimeActions,
  ProviderSkillActions,
  ProviderVoiceTranscriptCorrection,
} from "../ProviderDriver.ts";
import type { ProviderAdapterError } from "../Errors.ts";

export type ProviderMaintenanceActionKind = "update";

export class ProviderRegistryRefreshError extends Data.TaggedError("ProviderRegistryRefreshError")<{
  readonly operation: "refresh" | "reload";
  readonly instanceId: ProviderInstanceId;
  readonly message: string;
  readonly cause?: unknown;
}> {}

export interface ProviderRegistryShape {
  /**
   * Read the latest provider snapshots for every configured instance.
   * Multiple snapshots may share the same `provider` kind (multiple
   * instances of the same driver) and disambiguate via `instanceId`.
   */
  readonly getProviders: Effect.Effect<ReadonlyArray<ServerProvider>>;

  /**
   * Refresh all providers, or the default instance of the specified
   * kind when supplied.
   *
   * Retained for back-compat with legacy call sites (WS refresh RPC,
   * orchestration metrics). New code should prefer `refreshInstance`.
   *
   * @deprecated prefer `refreshInstance` for new call sites.
   */
  readonly refresh: (provider?: ProviderDriverKind) => Effect.Effect<ReadonlyArray<ServerProvider>>;

  /**
   * Refresh the specific configured instance. Returns the updated snapshot
   * list. When the instance id is unknown the call resolves with the
   * currently cached list (no error) — matching the legacy `refresh` shim
   * behaviour so transport layers don't have to special-case unknowns.
   */
  readonly refreshInstance: (
    instanceId: ProviderInstanceId,
  ) => Effect.Effect<ReadonlyArray<ServerProvider>>;

  /**
   * Refresh one instance without substituting cached state when its live probe
   * fails. Lifecycle operations use this when fresh state decides whether an
   * operation may start or can truthfully be reported as complete.
   */
  readonly refreshInstanceStrict: (
    instanceId: ProviderInstanceId,
  ) => Effect.Effect<ReadonlyArray<ServerProvider>, ProviderRegistryRefreshError>;

  /**
   * Recreate one provider instance from unchanged settings, attach its fresh
   * snapshot source, and run a probe before returning. Used when an external
   * dependency such as a managed provider executable changed atomically.
   */
  readonly reloadInstance: (
    instanceId: ProviderInstanceId,
  ) => Effect.Effect<ReadonlyArray<ServerProvider>>;

  /**
   * Rebuild and refresh one instance without recovering to cached state.
   * Managed-runtime reconciliation uses this after a durable runtime change.
   */
  readonly reloadInstanceStrict: (
    instanceId: ProviderInstanceId,
  ) => Effect.Effect<ReadonlyArray<ServerProvider>, ProviderRegistryRefreshError>;

  /**
   * Resolve the maintenance capabilities owned by one live provider instance.
   * Falls back to manual-only capabilities when the instance is not live.
   */
  readonly getProviderMaintenanceCapabilitiesForInstance: (
    instanceId: ProviderInstanceId,
    provider: ProviderDriverKind,
  ) => Effect.Effect<ProviderMaintenanceCapabilities>;

  /** Resolve the optional provider-owned connection seam for one live instance. */
  readonly getProviderConnectionActionsForInstance: (
    instanceId: ProviderInstanceId,
  ) => Effect.Effect<ProviderConnectionActions | undefined>;

  /** Resolve the optional Scient-managed runtime seam for one live instance. */
  readonly getProviderManagedRuntimeActionsForInstance: (
    instanceId: ProviderInstanceId,
  ) => Effect.Effect<ProviderManagedRuntimeActions | undefined>;

  /** Resolve the optional provider-owned native skill management seam. */
  readonly getProviderSkillActionsForInstance: (
    instanceId: ProviderInstanceId,
  ) => Effect.Effect<ProviderSkillActions | undefined>;

  /** Resolve the optional transcript-correction capability for one live instance. */
  readonly getVoiceTranscriptCorrectionForInstance: (
    instanceId: ProviderInstanceId,
  ) => Effect.Effect<ProviderVoiceTranscriptCorrection | undefined>;

  /** Stop every live session using one shared provider runtime before mutating it. */
  readonly stopProviderSessions: (
    provider: ProviderDriverKind,
  ) => Effect.Effect<void, ProviderAdapterError>;

  /**
   * Apply volatile maintenance-action state to one configured instance.
   * This state is never persisted to disk. Today only update actions are
   * projected onto `ServerProvider.updateState`; install/auth actions can
   * extend this action map without adding driver-scoped APIs.
   */
  readonly setProviderMaintenanceActionState: (input: {
    readonly instanceId: ProviderInstanceId;
    readonly action: ProviderMaintenanceActionKind;
    readonly state: ServerProviderUpdateState | null;
  }) => Effect.Effect<ReadonlyArray<ServerProvider>>;

  /**
   * Overlay one transient provider-owned connection operation onto the
   * canonical snapshot. Authentication truth continues to come from the
   * provider probe; this state is progress only and is never persisted.
   */
  readonly setProviderConnectionOperation: (input: {
    readonly instanceId: ProviderInstanceId;
    readonly operation: ProviderConnectionOperation | null;
  }) => Effect.Effect<ReadonlyArray<ServerProvider>>;

  /** Overlay the current derived app-private runtime summary without persisting operation state. */
  readonly setProviderManagedRuntimeSummary: (input: {
    readonly instanceId: ProviderInstanceId;
    readonly runtime: ProviderRuntimeSummary | null;
  }) => Effect.Effect<ReadonlyArray<ServerProvider>>;

  /**
   * Stream of provider snapshot updates — one emission per aggregated
   * change. The array contains the full current state.
   */
  readonly streamChanges: Stream.Stream<ReadonlyArray<ServerProvider>>;
}

export class ProviderRegistry extends Context.Service<ProviderRegistry, ProviderRegistryShape>()(
  "t3/provider/Services/ProviderRegistry",
) {}
