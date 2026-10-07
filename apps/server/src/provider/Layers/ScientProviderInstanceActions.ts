/**
 * Scient's per-instance action lookups: connection, managed-runtime and skill
 * actions and voice transcript correction, read from the instance currently
 * attached as a live source.
 */
import type { ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";

import type { ProviderInstance } from "../ProviderDriver.ts";

export function makeScientProviderInstanceActions(
  liveSubsRef: Ref.Ref<ReadonlyMap<ProviderInstanceId, ProviderInstance>>,
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
    getVoiceTranscriptCorrectionForInstance,
  };
}
