import type { VoiceSetupSnapshot } from "./voiceClient";

export function hasReadySelectedVoiceModel(snapshot: VoiceSetupSnapshot): boolean {
  if (!snapshot.runtimeAvailable || snapshot.selectedModelId === null) return false;
  return (
    snapshot.models.find((model) => model.id === snapshot.selectedModelId)?.state.state === "ready"
  );
}
