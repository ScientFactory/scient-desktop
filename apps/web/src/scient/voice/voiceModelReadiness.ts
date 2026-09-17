import type { VoiceModelsSnapshot } from "@t3tools/contracts";

export function hasReadySelectedVoiceModel(snapshot: VoiceModelsSnapshot): boolean {
  if (!snapshot.runtimeAvailable || snapshot.selectedModelId === null) return false;
  return (
    snapshot.models.find((model) => model.id === snapshot.selectedModelId)?.state.state === "ready"
  );
}
