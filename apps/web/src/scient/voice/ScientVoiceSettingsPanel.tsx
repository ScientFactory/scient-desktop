import { TranscriptionSelect } from "./TranscriptionSelect";
import { VoiceLanguagePicker } from "./VoiceLanguagePicker";
import { CloudDictationSettings } from "./cloudDictation";
import { DictationChoices } from "./DictationChoices";
import { DictationInputSettings } from "../../components/settings/DictationInputSettings";
import { useAtomValue } from "@effect/atom-react";
import * as Option from "effect/Option";
import { RecordingDefaultsSettings } from "./RecordingDefaultsSettings";
import { useOptionalSettingsScope } from "../../components/settings/SettingsScopeContext";
import {
  CleanupModelRow,
  DictationEngineCatalog,
  useVoiceModels,
} from "../../components/settings/VoiceSettingsPanel";
import { localEnvironmentIdAtom } from "../../state/primaryEnvironment";
import { WordsSettingsSection } from "../transcription/WordsPanel";
// SCIENT-OWNED: Transcription settings for Scient dictation.
import { T, useGT } from "gt-react";

import { Mic2Icon } from "lucide-react";
import { Link } from "@tanstack/react-router";
import { useEffect, useState, type ReactNode } from "react";
import {
  AuthSettingsWriteScope,
  type EnvironmentId,
  VOICE_TRANSCRIPTION_LANGUAGE_CODES,
  ProviderInstanceId,
} from "@t3tools/contracts";

import { useChatGptDictation } from "./chatGptDictation";
import { describeVoiceError } from "./voiceErrorPresentation";
import { getVoiceBridge } from "./voiceClient";
import { Button } from "../../components/ui/button";
import { Switch } from "../../components/ui/switch";
import {
  updateClientSettings,
  useClientSettings,
  useEnvironmentSettings,
  useUpdateEnvironmentSettings,
} from "../../hooks/useSettings";
import {
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "../../components/settings/settingsLayout";
import { usePrimaryEnvironmentId } from "../../state/environments";

import { useEnvironmentScope, usePreparedConnection } from "../../state/session";
import { andFinally } from "../../lib/compilerSafe";

function TranscriptionPrivacy({ environmentId }: { environmentId: EnvironmentId }) {
  const gt = useGT();
  const preferences = useEnvironmentSettings(environmentId, (settings) => settings.transcription);
  const update = useUpdateEnvironmentSettings(environmentId);
  const canWrite = useEnvironmentScope(environmentId, AuthSettingsWriteScope);
  const rows = [
    {
      key: "agentsMayUseCloudEngines",
      label: gt("Agents may send audio to cloud engines"),
      checked: preferences.agentsMayUseCloudEngines,
    },
    {
      key: "agentsMayTranscribe",
      label: gt("Agents may start and check transcriptions"),
      checked: preferences.agentsMayTranscribe !== false,
    },
    {
      key: "agentsMaySuggestWords",
      label: gt("Agents may suggest Words"),
      checked: preferences.agentsMaySuggestWords !== false,
    },
  ] as const;

  return (
    <>
      {rows.map(({ key, label, checked }) => (
        <SettingsRow
          key={key}
          serverScoped
          settingKeys={["transcription"]}
          title={label}
          control={
            <Switch
              aria-label={label}
              checked={checked}
              disabled={!canWrite}
              onCheckedChange={(value) =>
                update({ transcription: { ...preferences, [key]: value } })
              }
            />
          }
        />
      ))}
    </>
  );
}

export function ScientVoiceSettingsPanel(): ReactNode {
  const gt = useGT();
  const settingsScope = useOptionalSettingsScope();
  const silenceFiltering = useClientSettings((settings) => settings.speechSilenceFiltering);
  const removeFillerWords = useClientSettings((settings) => settings.speechRemoveFillerWords);
  const [cloudRevision, setCloudRevision] = useState(0);
  const [engineSelectionPending, setEngineSelectionPending] = useState(false);
  const [client] = useState(() => getVoiceBridge());
  const correctionEnabled = useClientSettings(
    (settings) => settings.voiceTranscriptCorrectionEnabled,
  );
  const languagePreference = useClientSettings((settings) => settings.voiceLanguagePreference);
  const engine = useClientSettings((settings) => settings.voiceDictationEngine);
  const localDictation = engine === "local" || engine === "auto";
  const localEnvironmentId = useAtomValue(localEnvironmentIdAtom);
  const prepared = Option.getOrNull(usePreparedConnection(localEnvironmentId));
  const catalog = useVoiceModels(prepared);
  const environmentId = usePrimaryEnvironmentId();
  const chatGpt = useChatGptDictation(environmentId ?? undefined);
  const chatGptSignedIn = chatGpt.transcriber !== null;
  const catalogDictated = useClientSettings((settings) => settings.voiceCatalogDictated);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [hasLegacyModels, setHasLegacyModels] = useState(false);
  const [removingLegacyModels, setRemovingLegacyModels] = useState(false);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the native file inventory after catalog dictation succeeds
  useEffect(() => {
    if (!catalogDictated || !client?.hasLegacyModels) return;
    let current = true;
    void client
      .hasLegacyModels()
      .then((present) => {
        if (current) setHasLegacyModels(present);
      })
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, [catalogDictated, client]);

  const removeLegacyModels = async () => {
    const removeModels = client?.removeLegacyModels;
    if (!removeModels || removingLegacyModels) return;
    setErrorMessage(null);
    setRemovingLegacyModels(true);
    await andFinally(
      async () => {
        try {
          await removeModels.call(client);
          setHasLegacyModels(false);
        } catch (error) {
          setErrorMessage(describeVoiceError(error));
        }
      },
      () => {
        setRemovingLegacyModels(false);
      },
    );
  };

  if (!client && !prepared && !environmentId) {
    return (
      <SettingsPageContainer>
        <WordsSettingsSection />
      </SettingsPageContainer>
    );
  }

  return (
    <SettingsPageContainer>
      <SettingsSection
        title={gt("Dictation")}
        icon={<Mic2Icon className="size-4 text-muted-foreground" />}
      >
        {environmentId ? (
          <DictationChoices
            catalog={catalog}
            chatGptSignedIn={chatGptSignedIn}
            environmentId={environmentId}
            pending={engineSelectionPending}
            onPendingChange={setEngineSelectionPending}
          />
        ) : null}
        <SettingsRow
          id="speech-language"
          title={gt("Language", { $context: "voice dictation language" })}
          control={
            <VoiceLanguagePicker
              label={gt("Choose voice language")}
              languages={VOICE_TRANSCRIPTION_LANGUAGE_CODES}
              special={{ value: "auto", label: gt("Automatic"), recommended: true }}
              value={languagePreference}
              onChange={(language) => updateClientSettings({ voiceLanguagePreference: language })}
            />
          }
        />
        <SettingsRow
          id="speech-post-processing"
          title={gt("Clean up dictation")}
          description={gt("Fix spelling and punctuation after dictation.")}
          descriptionSize="compact"
          control={
            <Switch
              aria-label={gt("Clean up dictation")}
              checked={correctionEnabled}
              onCheckedChange={(checked) =>
                void updateClientSettings({ voiceTranscriptCorrectionEnabled: checked })
              }
            />
          }
        />
        {settingsScope ? (
          <CleanupModelRow disabled={!correctionEnabled} keepControlsVisible />
        ) : null}
        {prepared ? (
          <>
            <SettingsRow
              id="speech-silence-filtering"
              title={gt("Silence filtering")}
              description={gt("Skip pauses in local dictation.")}
              descriptionSize="compact"
              control={
                <Switch
                  aria-label={gt("Silence filtering")}
                  checked={silenceFiltering}
                  disabled={!localDictation}
                  onCheckedChange={(speechSilenceFiltering) =>
                    void updateClientSettings({ speechSilenceFiltering })
                  }
                />
              }
            />
            <SettingsRow
              id="remove-filler-words"
              title={gt("Remove filler words")}
              description={gt("Drop “um” and “uh” from local dictation.")}
              descriptionSize="compact"
              control={
                <Switch
                  aria-label={gt("Remove filler words")}
                  checked={removeFillerWords}
                  disabled={!localDictation}
                  onCheckedChange={(speechRemoveFillerWords) =>
                    void updateClientSettings({ speechRemoveFillerWords })
                  }
                />
              }
            />
          </>
        ) : null}
      </SettingsSection>
      {prepared ? (
        <RecordingDefaultsSettings prepared={prepared} catalog={catalog} key={cloudRevision} />
      ) : null}
      {prepared ? (
        <SettingsSection id="voice-models" title={gt("Speech models")} variant="plain">
          <DictationEngineCatalog
            catalog={catalog}
            prepared={prepared}
            language={languagePreference}
            selectionPending={engineSelectionPending}
          />
        </SettingsSection>
      ) : null}
      {prepared || environmentId ? (
        <SettingsSection id="voice-cloud" title={gt("Cloud engines")}>
          <SettingsRow
            title="ChatGPT"
            alignControl="start"
            description={
              !chatGpt.pinned && chatGpt.connection.ready && chatGpt.connection.selected
                ? gt(
                    "Dictation uses your chat’s connection when available. Otherwise uses {connection}.",
                    {
                      connection:
                        chatGpt.connection.selected.displayName ??
                        chatGpt.connection.selected.driver,
                    },
                  )
                : chatGpt.connection.selected
                  ? chatGpt.connection.ready
                    ? gt("Signed in with {connection}", {
                        connection: chatGpt.connection.selected.displayName,
                      })
                    : gt("Sign in again with {connection}", {
                        connection: chatGpt.connection.selected.displayName,
                      })
                  : gt("Use your ChatGPT sign-in.")
            }
            control={
              <div className="flex min-w-0 flex-wrap items-start gap-2 @min-[32rem]/settings-row:justify-end">
                {chatGpt.connection.choices.length ? (
                  <TranscriptionSelect
                    label={gt("ChatGPT connection")}
                    value={chatGpt.pinned ?? ""}
                    options={[
                      { value: "", label: gt("Automatic") },
                      ...chatGpt.connection.choices.map((provider) => ({
                        value: provider.instanceId,
                        label: provider.displayName ?? provider.instanceId,
                      })),
                    ]}
                    onChange={(value) =>
                      void updateClientSettings({
                        voiceChatGptInstanceId: value ? ProviderInstanceId.make(value) : null,
                      })
                    }
                  />
                ) : null}
                <Button size="sm" variant="outline" render={<Link to="/settings/providers" />}>
                  {chatGpt.connection.ready
                    ? gt("Manage sign-in…")
                    : chatGpt.connection.selected
                      ? gt("Sign in again")
                      : gt("Sign in")}
                </Button>
              </div>
            }
          />
          {environmentId ? (
            <CloudDictationSettings
              key={environmentId}
              manage
              environmentId={environmentId}
              onEngineAdded={() => setCloudRevision((value) => value + 1)}
            />
          ) : null}
          <SettingsRow
            title={gt("Speech accounts")}
            description={gt("Manage saved API keys or reuse a compatible key from Custom models.")}
            control={
              <Button size="sm" variant="outline" render={<Link to="/settings/accounts" />}>
                <T>Open</T>
              </Button>
            }
          />
          {catalogDictated && hasLegacyModels && client?.removeLegacyModels ? (
            <SettingsRow
              title={gt("Previous dictation models")}
              status={
                errorMessage ? (
                  <span className="text-destructive" role="alert">
                    {errorMessage}
                  </span>
                ) : null
              }
              description={gt("You can free up space by removing the old model files.")}
              control={
                <Button
                  size="sm"
                  variant="outline"
                  disabled={removingLegacyModels}
                  onClick={() => void removeLegacyModels()}
                >
                  <T>Remove old model files</T>
                </Button>
              }
            />
          ) : null}
        </SettingsSection>
      ) : null}
      <DictationInputSettings />
      <WordsSettingsSection />
      {environmentId ? (
        <SettingsSection id="voice-agents" title={gt("Agents")}>
          <TranscriptionPrivacy environmentId={environmentId} />
        </SettingsSection>
      ) : null}
    </SettingsPageContainer>
  );
}
