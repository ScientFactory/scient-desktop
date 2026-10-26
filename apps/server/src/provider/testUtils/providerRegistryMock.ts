import * as ProviderRegistry from "../ProviderRegistry.ts";
import type { ServerProvider } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import type { ProviderVoiceTranscriptCorrection } from "../ScientProviderInstanceSeams.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "@t3tools/provider-core/server/maintenanceResolver";

export const makeProviderRegistryMock = (
  providers: ReadonlyArray<ServerProvider> = [],
): ProviderRegistry.ProviderRegistry["Service"] => ({
  getProviders: Effect.succeed(providers),
  refresh: () => Effect.succeed(providers),
  refreshInstance: () => Effect.succeed(providers),
  refreshInstanceStrict: () => Effect.succeed(providers),
  refreshInstanceAfterAccountChange: () => Effect.succeed(providers),
  reloadInstance: () => Effect.succeed(providers),
  reloadInstanceStrict: () => Effect.succeed(providers),
  refreshAfterUpdate: () => Effect.succeed(providers),
  refreshWorkspaceSnapshot: () => Effect.succeed(providers),
  getProviderMaintenanceCapabilitiesForInstance: (_instanceId, provider) =>
    Effect.succeed(makeManualOnlyProviderMaintenanceCapabilities({ provider, packageName: null })),
  // @effect-diagnostics-next-line effectSucceedWithVoid:off - This optional result requires undefined, not the wider void type.
  getProviderConnectionActionsForInstance: () => Effect.succeed(undefined),
  // @effect-diagnostics-next-line effectSucceedWithVoid:off - This optional result requires undefined, not the wider void type.
  getProviderManagedRuntimeActionsForInstance: () => Effect.succeed(undefined),
  // @effect-diagnostics-next-line effectSucceedWithVoid:off - This optional result requires undefined, not the wider void type.
  getProviderSkillActionsForInstance: () => Effect.succeed(undefined),
  // SCIENT-FORK:START — Scient Extensions provider plugins and native inventory.
  // @effect-diagnostics-next-line effectSucceedWithVoid:off - This optional result requires undefined, not the wider void type.
  getProviderPluginActionsForInstance: () => Effect.succeed(undefined),
  recordProviderNativeInventory: () => Effect.succeed(providers),
  // SCIENT-FORK:END
  getVoiceTranscriptCorrectionForInstance: () =>
    // @effect-diagnostics-next-line effectSucceedWithVoid:off -- Exact optional return requires undefined, not void.
    Effect.succeed<ProviderVoiceTranscriptCorrection | undefined>(undefined),
  setProviderManagedRuntimeSummary: () => Effect.succeed([]),
  setProviderMaintenanceActionState: () => Effect.succeed(providers),
  setProviderConnectionOperation: () => Effect.succeed(providers),
  setProviderAuthenticationFailure: () => Effect.succeed(providers),
  streamChanges: Stream.empty,
});

export const layer = (providers: ReadonlyArray<ServerProvider> = []) =>
  Layer.succeed(ProviderRegistry.ProviderRegistry, makeProviderRegistryMock(providers));
