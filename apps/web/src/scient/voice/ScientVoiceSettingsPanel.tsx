import { TranscriptionSelect } from "./TranscriptionSelect";
import { useThreadShells } from "../../state/entities";
import { useEnvironmentProviders } from "../../state/environments";
import { resolveThreadActivityTimestamp } from "@t3tools/client-runtime/state/thread-sort";
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

import { CheckIcon, Mic2Icon, ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import { Link } from "@tanstack/react-router";
import { useEffect, useState, type ReactNode } from "react";
import {
  AuthSettingsWriteScope,
  type EnvironmentId,
  VOICE_LANGUAGE_NAMES,
  ProviderInstanceId,
  type VoiceLanguagePreference,
} from "@t3tools/contracts";

import { useChatGptDictation } from "./chatGptDictation";
import { describeVoiceError } from "./voiceErrorPresentation";
import { getVoiceBridge } from "./voiceClient";
import { Badge } from "../../components/ui/badge";
import { Popover, PopoverTrigger, PopoverPopup } from "../../components/ui/popover";
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

const PRIMARY_VOICE_LANGUAGES = [
  "auto",
  "en",
  "he",
] as const satisfies ReadonlyArray<VoiceLanguagePreference>;
const MORE_VOICE_LANGUAGES = [
  "ar",
  "zh",
  "fr",
  "de",
  "it",
  "ja",
  "ko",
  "pt",
  "ru",
  "es",
] as const satisfies ReadonlyArray<VoiceLanguagePreference>;

function isPrimaryVoiceLanguage(language: VoiceLanguagePreference): boolean {
  return language === "auto" || language === "en" || language === "he";
}

function VoiceLanguagePicker({
  value,
  onChange,
}: {
  readonly value: VoiceLanguagePreference;
  readonly onChange: (language: VoiceLanguagePreference) => void;
}): ReactNode {
  const gt = useGT();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [moreLanguagesOpen, setMoreLanguagesOpen] = useState(!isPrimaryVoiceLanguage(value));

  const selectLanguage = (language: VoiceLanguagePreference): void => {
    onChange(language);
    setPickerOpen(false);
    if (isPrimaryVoiceLanguage(language)) setMoreLanguagesOpen(false);
  };

  return (
    <div className="relative border-border/60 border-t pt-3 md:border-t-0 md:pl-8 md:pt-1 md:before:absolute md:before:top-1 md:before:left-0 md:before:h-10 md:before:w-px md:before:bg-border/60">
      <div className="flex items-center gap-1">
        <h3 className="font-medium text-sm">
          <T context="voice dictation language">Language</T>
        </h3>
        <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
          <PopoverTrigger
            render={
              <Button
                aria-label={gt("Choose voice language")}
                className="relative top-0.5"
                size="xs"
                variant="ghost-muted"
              />
            }
          >
            {VOICE_LANGUAGE_NAMES[value]}
            <ChevronDownIcon className="size-3.5 stroke-[2.5] opacity-70" />
          </PopoverTrigger>
          <PopoverPopup
            align="start"
            className="w-56 max-w-[calc(100vw-1rem)]"
            padding="none"
            side="bottom"
            sideOffset={4}
          >
            <div className="p-1">
              <div className="space-y-0.5">
                {PRIMARY_VOICE_LANGUAGES.map((language) => {
                  const selected = value === language;
                  return (
                    <Button
                      key={language}
                      aria-pressed={selected}
                      className="w-full justify-start"
                      onClick={() => selectLanguage(language)}
                      size="sm-multiline"
                      variant={selected ? "selected" : "ghost-muted"}
                    >
                      <span className="flex min-w-0 flex-1 items-center gap-2">
                        <span>{VOICE_LANGUAGE_NAMES[language]}</span>
                        {language === "auto" ? (
                          <Badge size="sm" variant="info">
                            <T>Recommended</T>
                          </Badge>
                        ) : null}
                      </span>
                      {selected ? <CheckIcon className="stroke-[2.5]" /> : null}
                    </Button>
                  );
                })}
                <div className="mt-1 border-border/60 border-t pt-1">
                  <Button
                    aria-expanded={moreLanguagesOpen}
                    className="w-full justify-start"
                    onClick={() => setMoreLanguagesOpen((open) => !open)}
                    size="xs"
                    variant="ghost-muted"
                  >
                    <span className="flex-1 text-left">
                      <T>More languages</T>
                    </span>
                    <ChevronRightIcon
                      className={`size-3.5 stroke-[2.5] transition-transform ${moreLanguagesOpen ? "rotate-90" : ""}`}
                    />
                  </Button>
                  {moreLanguagesOpen ? (
                    <div className="mt-0.5 space-y-0.5">
                      {MORE_VOICE_LANGUAGES.map((language) => {
                        const selected = value === language;
                        return (
                          <Button
                            key={language}
                            aria-pressed={selected}
                            className="w-full justify-start"
                            onClick={() => selectLanguage(language)}
                            size="xs"
                            variant={selected ? "selected" : "ghost-muted"}
                          >
                            <span className="flex-1 text-left">
                              {VOICE_LANGUAGE_NAMES[language]}
                            </span>
                            {selected ? <CheckIcon className="stroke-[2.5]" /> : null}
                          </Button>
                        );
                      })}
                    </div>
                  ) : null}
                </div>
              </div>
            </div>
          </PopoverPopup>
        </Popover>
      </div>
    </div>
  );
}

export function ScientVoiceSettingsPanel(): ReactNode {
  const gt = useGT();
  const settingsScope = useOptionalSettingsScope();
  const silenceFiltering = useClientSettings((settings) => settings.speechSilenceFiltering);
  const removeFillerWords = useClientSettings((settings) => settings.speechRemoveFillerWords);
  const [cloudRevision, setCloudRevision] = useState(0);
  const [client] = useState(() => getVoiceBridge());
  const correctionEnabled = useClientSettings(
    (settings) => settings.voiceTranscriptCorrectionEnabled,
  );
  const languagePreference = useClientSettings((settings) => settings.voiceLanguagePreference);
  const engine = useClientSettings((settings) => settings.voiceDictationEngine);
  const localEnvironmentId = useAtomValue(localEnvironmentIdAtom);
  const prepared = Option.getOrNull(usePreparedConnection(localEnvironmentId));
  const catalog = useVoiceModels(prepared);
  const environmentId = usePrimaryEnvironmentId();
  const threads = useThreadShells();
  const providersByEnvironment = useEnvironmentProviders();
  const providers = environmentId ? providersByEnvironment.get(environmentId) : undefined;
  const recentChat = threads
    .filter((thread) => thread.environmentId === environmentId && !thread.archivedAt)
    .reduce<(typeof threads)[number] | undefined>(
      (latest, thread) =>
        !latest ||
        (resolveThreadActivityTimestamp(thread) ?? "") >
          (resolveThreadActivityTimestamp(latest) ?? "")
          ? thread
          : latest,
      undefined,
    );
  const recentProvider = recentChat?.modelSelection?.instanceId ?? recentChat?.providerInstanceId;
  const activeCodex = providers?.find(
    (provider) =>
      provider.instanceId === recentProvider && provider.driver === "codex" && provider.enabled,
  )?.instanceId;
  const chatGpt = useChatGptDictation(environmentId ?? undefined, activeCodex);
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
        id="voice-transcription-destination"
        title={gt("Dictation")}
        icon={<Mic2Icon className="size-4 text-muted-foreground" />}
        variant="plain"
      >
        <div className="space-y-3 px-3 sm:px-4">
          <div className="grid items-start gap-y-3 md:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] md:gap-y-0">
            <div className="flex items-start justify-between gap-4 py-1 md:pr-8">
              <div className="min-w-0">
                <h3 className="font-medium text-sm">
                  <T>Clean up dictation</T>
                </h3>
                <p className="text-xs text-muted-foreground">
                  <T>Fix spelling and punctuation after dictation.</T>
                </p>
              </div>
              <Switch
                aria-label={gt("Clean up dictation")}
                checked={correctionEnabled}
                onCheckedChange={(checked) =>
                  updateClientSettings({ voiceTranscriptCorrectionEnabled: Boolean(checked) })
                }
              />
            </div>
            <VoiceLanguagePicker
              value={languagePreference}
              onChange={(language) => updateClientSettings({ voiceLanguagePreference: language })}
            />
          </div>
          {correctionEnabled && settingsScope ? <CleanupModelRow /> : null}
          {prepared && (engine === "local" || engine === "auto") ? (
            <div className="grid items-start gap-y-3 md:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] md:gap-y-0">
              <div className="flex items-start justify-between gap-4 py-1 md:pr-8">
                <div className="min-w-0">
                  <h3 className="font-medium text-sm">
                    <T>Silence filtering</T>
                  </h3>
                  <p className="text-xs text-muted-foreground">
                    <T>Skip pauses before transcribing.</T>
                  </p>
                </div>
                <Switch
                  aria-label={gt("Silence filtering")}
                  checked={silenceFiltering}
                  onCheckedChange={(speechSilenceFiltering) =>
                    void updateClientSettings({ speechSilenceFiltering })
                  }
                />
              </div>
              <div className="flex items-start justify-between gap-4 py-1 md:pl-8">
                <div className="min-w-0">
                  <h3 className="font-medium text-sm">
                    <T>Remove filler words</T>
                  </h3>
                  <p className="text-xs text-muted-foreground">
                    <T>Drop “um” and “uh” from the text.</T>
                  </p>
                </div>
                <Switch
                  aria-label={gt("Remove filler words")}
                  checked={removeFillerWords}
                  onCheckedChange={(speechRemoveFillerWords) =>
                    void updateClientSettings({ speechRemoveFillerWords })
                  }
                />
              </div>
            </div>
          ) : null}
          <div className="border-border/60 border-t pt-3">
            <h3 className="font-medium text-sm">
              <T>Dictate with</T>
            </h3>
            <p className="text-muted-foreground text-xs">
              <T>ChatGPT, a model on this computer, or a cloud engine you added.</T>
            </p>
          </div>
          {environmentId ? (
            <DictationChoices
              catalog={catalog}
              chatGptSignedIn={chatGptSignedIn}
              environmentId={environmentId}
              language={languagePreference}
            />
          ) : null}
        </div>
      </SettingsSection>
      <DictationInputSettings />
      {prepared ? (
        <RecordingDefaultsSettings prepared={prepared} catalog={catalog} key={cloudRevision} />
      ) : null}
      {prepared ? (
        <SettingsSection id="voice-models" title={gt("Speech models")} variant="plain">
          <DictationEngineCatalog
            catalog={catalog}
            prepared={prepared}
            language={languagePreference}
          />
        </SettingsSection>
      ) : null}
      {prepared || environmentId ? (
        <SettingsSection id="voice-cloud" title={gt("Cloud engines")}>
          <SettingsRow
            title="ChatGPT"
            description={
              !chatGpt.pinned && activeCodex && chatGpt.connection.selected
                ? gt("Follows your active chat, currently {connection}", {
                    connection: chatGpt.connection.selected.displayName,
                  })
                : chatGpt.connection.selected
                  ? chatGpt.connection.ready
                    ? gt("Signed in with {connection}", {
                        connection: chatGpt.connection.selected.displayName,
                      })
                    : gt("Sign in again with {connection}", {
                        connection: chatGpt.connection.selected.displayName,
                      })
                  : chatGpt.connection.ambiguous
                    ? gt("Choose a connection to use for ChatGPT.")
                    : gt("Use your ChatGPT sign-in.")
            }
            control={
              <Button size="sm" variant="outline" render={<Link to="/settings/providers" />}>
                {chatGpt.connection.ready
                  ? gt("Manage sign-in…")
                  : chatGpt.connection.selected
                    ? gt("Sign in again")
                    : gt("Sign in")}
              </Button>
            }
          >
            {chatGpt.connection.choices.length ? (
              <TranscriptionSelect
                label={gt("Use a different connection…")}
                value={chatGpt.pinned ?? ""}
                options={[
                  { value: "", label: gt("Follow the active chat connection") },
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
          </SettingsRow>
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
            description={gt("Keys for cloud engines live in Accounts & secrets.")}
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
      <WordsSettingsSection />
      {environmentId ? (
        <SettingsSection id="voice-agents" title={gt("Agents")}>
          <TranscriptionPrivacy environmentId={environmentId} />
        </SettingsSection>
      ) : null}
    </SettingsPageContainer>
  );
}
