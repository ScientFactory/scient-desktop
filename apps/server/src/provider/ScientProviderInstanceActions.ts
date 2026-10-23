/**
 * Scient's per-instance action lookups: connection, managed-runtime, skill and
 * plugin actions and voice transcript correction.
 */
import type { ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";

import type { ProviderInstanceRegistryShape } from "./ProviderInstanceRegistry.ts";
import type { ScientProviderInstance } from "./ScientProviderInstance.ts";

export function makeScientProviderInstanceActions(
  /** Instances currently attached as live snapshot sources; trails the instance registry. */
  liveSubsRef: Ref.Ref<ReadonlyMap<ProviderInstanceId, ScientProviderInstance>>,
  instanceRegistry: Pick<ProviderInstanceRegistryShape, "getInstance">,
) {
  const getProviderConnectionActionsForInstance = Effect.fn(
    "getProviderConnectionActionsForInstance",
  )(function* (instanceId: ProviderInstanceId) {
    const instance = (yield* Ref.get(liveSubsRef)).get(instanceId);
    return instance?.connectionActions;
  });

  const getProviderManagedRuntimeActionsForInstance = Effect.fn(
    "getProviderManagedRuntimeActionsForInstance",
  )(function* (instanceId: ProviderInstanceId) {
    const instance = (yield* Ref.get(liveSubsRef)).get(instanceId);
    return instance?.managedRuntimeActions;
  });

  const getProviderSkillActionsForInstance = Effect.fn("getProviderSkillActionsForInstance")(
    function* (instanceId: ProviderInstanceId) {
      const instance = (yield* Ref.get(liveSubsRef)).get(instanceId);
      return instance?.skillActions;
    },
  );

  // Plugin actions change provider configuration, so they come from the
  // instance registry's current generation, never the trailing live map.
  const getProviderPluginActionsForInstance = Effect.fn("getProviderPluginActionsForInstance")(
    function* (instanceId: ProviderInstanceId) {
      const instance = yield* instanceRegistry.getInstance(instanceId);
      return instance?.pluginActions;
    },
  );

  const getVoiceTranscriptCorrectionForInstance = Effect.fn(
    "getVoiceTranscriptCorrectionForInstance",
  )(function* (instanceId: ProviderInstanceId) {
    const instance = (yield* Ref.get(liveSubsRef)).get(instanceId);
    return instance?.voiceTranscriptCorrection;
  });

  return {
    getProviderConnectionActionsForInstance,
    getProviderManagedRuntimeActionsForInstance,
    getProviderSkillActionsForInstance,
    getProviderPluginActionsForInstance,
    getVoiceTranscriptCorrectionForInstance,
  };
}
