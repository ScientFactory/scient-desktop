import type { EnvironmentId } from "@t3tools/contracts";
import { useGT } from "gt-react";

import type { useVoiceModels } from "../../components/settings/VoiceSettingsPanel";
import { SettingsRow } from "../../components/settings/settingsLayout";
import { toastManager } from "../../components/ui/toast";
import { updateClientSettings, useClientSettings } from "../../hooks/useSettings";
import { andFinally } from "../../lib/compilerSafe";
import { TranscriptionSelect } from "./TranscriptionSelect";
import { useCloudRecordingChoices } from "./cloudDictation";

export function DictationChoices({
  catalog,
  chatGptSignedIn,
  environmentId,
  pending,
  onPendingChange,
}: {
  readonly catalog: ReturnType<typeof useVoiceModels>;
  readonly chatGptSignedIn: boolean;
  readonly environmentId: EnvironmentId;
  readonly pending: boolean;
  readonly onPendingChange: (pending: boolean) => void;
}) {
  const gt = useGT();
  const engine = useClientSettings((settings) => settings.voiceDictationEngine);
  const localModel = useClientSettings((settings) => settings.voiceCatalogModelId);
  const cloud = useClientSettings((settings) => settings.voiceCloudSelection);
  const { choices, choose, loading: cloudLoading } = useCloudRecordingChoices(environmentId);
  const localModels = catalog.models.filter((model) => model.state === "installed");
  const cloudEngines = choices.filter((choice) => !choice.reconnect && !choice.needsModel);
  const value =
    engine === "local"
      ? `local:${localModel ?? ""}`
      : engine === "cloud"
        ? `cloud:${cloud?.environmentId === environmentId ? cloud.engineId : ""}`
        : engine;
  const options: { value: string; label: string; disabled?: boolean }[] = [
    { value: "auto", label: gt("Automatic") },
    {
      value: "chatgpt",
      label: chatGptSignedIn ? "ChatGPT" : gt("ChatGPT (sign-in required)"),
      disabled: !chatGptSignedIn,
    },
    ...localModels.map((model) => ({ value: `local:${model.id}`, label: model.name })),
    ...cloudEngines.map((choice) => ({
      value: `cloud:${choice.id}`,
      label: `${choice.model} · ${choice.origin.replace(/^https?:\/\//u, "")}`,
    })),
    { value: "off", label: gt("Off", { $context: "dictation engine" }) },
  ];
  if (!options.some((option) => option.value === value)) {
    const loading = engine === "local" ? catalog.loading : engine === "cloud" && cloudLoading;
    const label =
      engine === "local" && localModel === null
        ? gt("Local model")
        : loading
          ? gt("Loading…")
          : gt("Selected engine unavailable");
    options.push({ value, label, disabled: true });
  }

  const selectEngine = (next: string) => {
    if (next === "auto" || next === "chatgpt" || next === "off") {
      void updateClientSettings({
        voiceDictationEngine: next,
        ...(next === "auto" ? { voiceCatalogModelId: null } : {}),
      });
      return;
    }
    const local = localModels.find((model) => `local:${model.id}` === next);
    if (local) {
      void updateClientSettings({ voiceDictationEngine: "local", voiceCatalogModelId: local.id });
      return;
    }
    const choice = cloudEngines.find((engine) => `cloud:${engine.id}` === next);
    if (!choice || pending) return;
    onPendingChange(true);
    void andFinally(
      async () => {
        const result = await choose({
          environmentId,
          input: { id: choice.id, origin: choice.origin, model: choice.model },
        });
        if (result._tag !== "Success") {
          toastManager.add({
            type: "error",
            title: gt("Could not select this engine"),
            description: gt("Check its account in Accounts & secrets."),
          });
          return;
        }
        await updateClientSettings({
          voiceDictationEngine: "cloud",
          voiceCloudSelection: { environmentId, engineId: choice.id },
        });
      },
      () => onPendingChange(false),
    );
  };

  return (
    <SettingsRow
      id="voice-transcription-destination"
      title={gt("Dictate with")}
      description={gt(
        "Automatic uses a local model. ChatGPT and cloud engines send audio to their providers.",
      )}
      descriptionSize="compact"
      control={
        <div className="w-full @min-[32rem]/settings-row:w-60">
          <TranscriptionSelect
            label={gt("Dictate with")}
            value={value}
            options={options}
            disabled={pending}
            onChange={selectEngine}
            width="fluid"
          />
        </div>
      }
    />
  );
}
