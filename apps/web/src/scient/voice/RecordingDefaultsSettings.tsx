import type { RecordingEngineSelection } from "@t3tools/contracts";
import { useCloudRecordingChoices } from "./cloudDictation";
import { useChatGptDictation } from "./chatGptDictation";
import { TranscriptionSelect } from "./TranscriptionSelect";
import { VoiceLanguagePicker } from "./VoiceLanguagePicker";
import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import {
  AuthSettingsWriteScope,
  DEFAULT_RECORDING_DEFAULTS,
  VOICE_TRANSCRIPTION_LANGUAGE_CODES,
} from "@t3tools/contracts";
import { useGT } from "gt-react";
import { useState } from "react";

import { SettingsRow, SettingsSection } from "../../components/settings/settingsLayout";
import { useOptionalSettingsScope } from "../../components/settings/SettingsScopeContext";
import {
  useScopedSettings,
  useUpdateScopedSettings,
} from "../../components/settings/useScopedSettings";
import { CleanupModelRow, type useVoiceModels } from "../../components/settings/VoiceSettingsPanel";
import { Switch } from "../../components/ui/switch";
import { ProjectRecordingStorage } from "../transcription/WordsPanel";
import { useEnvironmentSettings, useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import { useEnvironmentScope } from "../../state/session";

const selectClass = "max-w-full rounded border border-border bg-background p-2 text-sm";

export function RecordingDefaultsSettings({
  prepared,
  catalog,
}: {
  prepared: PreparedConnection;
  catalog: ReturnType<typeof useVoiceModels>;
}) {
  const gt = useGT();
  const [language, setLanguage] = useState("auto");
  const environmentId = prepared.environmentId;
  const defaults =
    useEnvironmentSettings(environmentId, (settings) => settings.recordingDefaults) ??
    DEFAULT_RECORDING_DEFAULTS;
  const update = useUpdateEnvironmentSettings(environmentId);
  const canWrite = useEnvironmentScope(environmentId, AuthSettingsWriteScope);
  const context = useOptionalSettingsScope();
  const { choices, choose } = useCloudRecordingChoices(environmentId);
  const { connection } = useChatGptDictation(environmentId);
  const eligible = catalog.models.filter((model) =>
    language === "auto"
      ? model.supportsLanguageDetection && model.languages.length > 1
      : model.languages.includes(language),
  );
  const labels = { off: gt("Off"), quick: gt("Quick"), thorough: gt("Thorough") };

  const selected =
    defaults.engines?.[language] ??
    (defaults.models[language]
      ? { kind: "local" as const, modelId: defaults.models[language] }
      : undefined);
  const routeKey = (route: RecordingEngineSelection) => {
    switch (route.kind) {
      case "local":
        return `local:${route.modelId}`;
      case "cloud":
        return `cloud:${route.engineId}`;
      case "chatgpt":
        return `chatgpt:${route.instanceId}`;
    }
  };
  const value = selected ? routeKey(selected) : "";
  const routes = new Map<string, RecordingEngineSelection>();
  const options = [
    {
      value: "",
      label: gt("Recommended engine"),
      disabled: false,
    },
  ];
  const add = (route: RecordingEngineSelection, label: string) => {
    const key = routeKey(route);
    routes.set(key, route);
    options.push({ value: key, label, disabled: false });
  };
  for (const model of eligible) {
    if (model.state === "installed") add({ kind: "local", modelId: model.id }, model.name);
  }
  for (const choice of choices) {
    if (!choice.reconnect && !choice.needsModel) {
      add({ kind: "cloud", engineId: choice.id }, `${choice.model} · ${choice.origin}`);
    }
  }
  for (const provider of connection.signedIn.filter((entry) => entry.driver === "codex")) {
    add(
      { kind: "chatgpt", instanceId: provider.instanceId },
      `ChatGPT · ${provider.displayName ?? provider.instanceId} · OpenAI`,
    );
  }
  const needsAttention = Boolean(value) && !routes.has(value);
  if (needsAttention)
    options.push({ value, label: gt("Current default needs attention"), disabled: true });
  const saveSelection = async (key: string) => {
    const route = routes.get(key);
    if (route?.kind === "cloud") {
      const choice = choices.find((entry) => entry.id === route.engineId);
      if (!choice) return;
      const result = await choose({
        environmentId,
        input: { id: choice.id, origin: choice.origin, model: choice.model },
      });
      if (result._tag !== "Success") return;
    }
    const engines = { ...defaults.engines };
    const models = { ...defaults.models };
    delete models[language];
    if (route) engines[language] = route;
    else delete engines[language];
    update({ recordingDefaults: { ...defaults, models, engines } });
  };

  return (
    <SettingsSection id="recordings-defaults" title={gt("Recordings")}>
      <SettingsRow
        title={gt("Default engine")}
        description={gt(
          "Used when an agent starts a transcription. Choose a language or use automatic detection.",
        )}
        control={
          <div className="flex flex-wrap justify-end gap-2">
            <VoiceLanguagePicker
              label={gt("Recording language")}
              value={language}
              languages={VOICE_TRANSCRIPTION_LANGUAGE_CODES}
              special={{ value: "auto", label: gt("Automatic detection") }}
              onChange={setLanguage}
            />
            <TranscriptionSelect
              label={gt("Recording engine")}
              value={value}
              options={options}
              disabled={!canWrite}
              onChange={(key) => void saveSelection(key)}
            />
          </div>
        }
      />
      <SettingsRow
        title={gt("Correction default")}
        control={
          <TranscriptionSelect
            label={gt("Correction default")}
            value={defaults.correction}
            disabled={!canWrite}
            options={Object.entries(labels).map(([value, label]) => ({
              value: value as keyof typeof labels,
              label,
            }))}
            onChange={(correction) => update({ recordingDefaults: { ...defaults, correction } })}
          />
        }
      />
      {/* Speaker labels stay hidden until an engine supports diarization. */}
      {context && defaults.correction !== "off" ? <CleanupModelRow recordings /> : null}
      <SettingsRow
        title={gt("When a transcription finishes")}
        description={gt("Notify me")}
        control={
          <Switch
            aria-label={gt("Notify when a transcription finishes")}
            checked={defaults.notify}
            disabled={!canWrite}
            onCheckedChange={(notify) => update({ recordingDefaults: { ...defaults, notify } })}
          />
        }
      />
      {context?.scope.kind === "project" || context?.scope.kind === "checkout" ? (
        <RecordingNotesRecipe />
      ) : null}
      {context?.target?.projectId ? (
        <ProjectRecordingStorage
          key={context.target.projectId}
          projectId={context.target.projectId}
          environmentId={context.target.environmentId}
        />
      ) : null}
    </SettingsSection>
  );
}

function RecordingNotesRecipe() {
  const gt = useGT();
  const recipe = useScopedSettings((settings) => settings.recordingNotesRecipe);
  const update = useUpdateScopedSettings();
  return (
    <SettingsRow
      serverScoped
      settingKeys={["recordingNotesRecipe"]}
      title={gt("Make notes with a recipe")}
      description={gt(
        "Uses the correction model to make notes from the transcript. Leave blank to keep automatic notes off.",
      )}
      control={
        <input
          key={recipe}
          aria-label={gt("Notes recipe")}
          className={selectClass}
          maxLength={2000}
          defaultValue={recipe ?? ""}
          placeholder={gt("Off")}
          onBlur={(event) => {
            const value = event.target.value.trim() || null;
            if (value !== recipe) update({ recordingNotesRecipe: value });
          }}
        />
      }
    />
  );
}
