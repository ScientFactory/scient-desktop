import { languageLabel } from "../../lib/languageLabel";
import { VoiceLanguagePicker } from "../../scient/voice/VoiceLanguagePicker";
import { WordsSettingsSection } from "~/scient/transcription/WordsPanel";
import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import { m } from "~/i18n/messages";
import {
  cancelEnvironmentSpeechModelDownload,
  downloadEnvironmentSpeechModel,
  getEnvironmentSpeechModels,
  getEnvironmentSpeechStatus,
  linkEnvironmentSpeechModels,
  removeEnvironmentSpeechModel,
  selectEnvironmentSpeechModel,
  updateEnvironmentSpeechAcceleration,
  updateEnvironmentSpeechModelUnloadTimeout,
} from "@t3tools/client-runtime/voice-input";
import type { PreparedConnection } from "@t3tools/client-runtime/connection";
import { openRouterIcon } from "@t3tools/client-runtime/provider-clients";
import {
  AuthFilesystemReadScope,
  AuthSettingsWriteScope,
  CLOUD_SPEECH_LABELS,
  CloudSpeechProvider,
  DEFAULT_SPEECH_POST_PROCESSING_PROMPT,
  type EnvironmentId,
  type EnvironmentSpeechModel,
  type EnvironmentSpeechStatus,
  type ProjectId,
  ProviderDriverKind,
  type SpeechAcceleration,
  type SpeechBenchmarkTier,
  type SpeechModelUnloadTimeout,
} from "@t3tools/contracts";
import { createModelSelection, pickModelSelection } from "@t3tools/shared/model";
import { resolveSpeechPostProcessingModelSelection } from "@t3tools/shared/serverSettings";
import {
  cloudSpeechLanguages,
  HEBREW_RECORDING_MODEL_ID,
  MULTILINGUAL_RECORDING_MODEL_ID,
  recommendSpeechModels,
  recordingSpeechModelIds,
  chooseSetupSpeechModel,
  type SpeechRecommendationRole,
} from "@t3tools/shared/speech";
import {
  ArrowDownUpIcon,
  AudioLinesIcon,
  CheckIcon,
  DownloadIcon,
  InfoIcon,
  LanguagesIcon,
  KeyRoundIcon,
  LaptopIcon,
  MonitorIcon,
  MicOffIcon,
  MicIcon,
  SearchIcon,
  StarIcon,
  Trash2Icon,
  UnlinkIcon,
  XIcon,
} from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { msg, T, useGT, useLocale, useMessages, Var } from "gt-react";

import { useStableCallback } from "~/hooks/useStableCallback";
import { supportsAppleSpeechLocale, useAppleSpeechLocales } from "../../speech/appleSpeech";
import { cn } from "~/lib/utils";
import { preferredSpeechLanguages } from "../../speech/preferredSpeechLanguages";
import {
  chooseAudioDestination,
  chooseTranscriptCleanup,
  useCleanupGrant,
} from "../../speech/voiceConsent";
import { updateClientSettings, useClientSettings } from "../../hooks/useSettings";
import { runEnvironmentSpeech } from "../../speech/runEnvironmentSpeech";
import {
  getTextGenerationModelOptionsByInstance,
  resolveAppModelSelectionState,
} from "../../modelSelection";
import { useTextGenerationTargets } from "../../textGenerators";
import { useEnvironmentProviders, useEnvironments } from "../../state/environments";
import { useEnvironmentScope } from "../../state/session";
import { EMPTY_SERVER_PROVIDERS } from "../../state/server";
import {
  useEnvironmentSpeechInput,
  APPLE_SPEECH_LABEL,
  useVoiceTranscriptionDestination,
} from "../../speech/useEnvironmentSpeechInput";
import { ComposerSpeechRecordingPill } from "../chat/ComposerSpeechButton";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { ProviderPackageIcon } from "../chat/ProviderPackageIcon";
import { TraitsPicker } from "../chat/TraitsPicker";
import { VoiceInputSetup } from "../chat/VoiceInputSetup";
import { Badge } from "../ui/badge";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { InputGroup, InputGroupAddon, InputGroupInput } from "../ui/input-group";
import {
  Popover,
  PopoverDescription,
  PopoverPopup,
  PopoverTitle,
  PopoverTrigger,
} from "../ui/popover";
import {
  Menu,
  MenuCheckboxItem,
  MenuGroup,
  MenuGroupLabel,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuRadioItemIndicator,
  MenuSearchInput,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import {
  Select,
  SelectGroup,
  SelectGroupLabel,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import { DictationInputSettings } from "./DictationInputSettings";
import { CloudVoiceConfiguration } from "./CloudVoiceConfiguration";
import { ModelBenchmarks, orderSpeechLanguages } from "./SpeechModelComparison";
import { SpeechLanguageSelect } from "./SpeechLanguageSelect";
import { filterSpeechModels, type SpeechModelSort } from "./speechModelBrowser";
import { AdvancedSettings } from "./AdvancedSettings";
import {
  SETTINGS_PICKER_TRIGGER_CLASSNAME,
  SettingsPageContainer,
  SettingsRow,
  SettingsSearchTarget,
  SettingsSection,
  useSettingsSearchTargetId,
} from "./settingsLayout";
import { useSearchableSetting } from "./settingsSearch";
import { useOptionalSettingsScope, useSettingsScope } from "./SettingsScopeContext";
import { useScopedModelDisabledReason } from "./useScopedModelAvailability";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

const OFF = "off";
const DEVICE = "device";
function CloudSpeechLogo({ provider }: { provider: CloudSpeechProvider }) {
  if (provider === "openrouter")
    return <ProviderPackageIcon icon={openRouterIcon} aria-hidden className="size-4 shrink-0" />;
  return (
    <ProviderInstanceIcon
      driverKind={ProviderDriverKind.make(provider === "openai" ? "codex" : "grok")}
      displayName={CLOUD_SPEECH_LABELS[provider]}
      iconClassName="size-4"
    />
  );
}
const formatSize = (bytes: number) => `${Math.round(bytes / 1024 / 1024)} MB`;
const UNLOAD_LABELS: Record<SpeechModelUnloadTimeout, string> = {
  never: msg("Never", { $context: "unload the speech model" }),
  immediately: msg("Immediately"),
  min_2: msg("After 2 minutes"),
  min_5: msg("After 5 minutes"),
  min_10: msg("After 10 minutes"),
  min_15: msg("After 15 minutes"),
  hour_1: msg("After 1 hour"),
};
type ModelCardProps = {
  /** SCIENT-FORK: download and remove only; the engine is chosen elsewhere. */
  readonly manageOnly?: boolean;
  readonly model: EnvironmentSpeechModel;
  readonly comparisonLanguages: readonly string[];
  readonly recommendation: SpeechRecommendationRole | undefined;
  readonly recommendationContext?: string | undefined;
  readonly recommendationLabel?: string | undefined;
  readonly recommendationLanguage?: string | null | undefined;
  readonly benchmarkTier: SpeechBenchmarkTier | undefined;
  readonly busy: boolean;
  readonly canCancel: boolean;
  readonly onDownload: () => void;
  readonly onSelect: () => void;
  readonly onCancel: () => void;
  readonly onDelete: () => void;
  readonly testControls?: ReactNode;
  /** Keeps the controls under the text, so a live test never squeezes the model's details. */
  readonly stacked?: boolean;
  readonly dictation?: boolean;
  readonly children?: ReactNode;
};

function ModelBadge(props: { icon: ReactNode; label: string; tooltip: string }) {
  return (
    <Tooltip>
      <TooltipTrigger render={<Badge variant="outline" />}>
        {props.icon}
        {props.label}
      </TooltipTrigger>
      <TooltipPopup side="top">{props.tooltip}</TooltipPopup>
    </Tooltip>
  );
}

function EngineCard(props: ModelCardProps) {
  const gt = useGT();
  const locale = useLocale();
  const { model } = props;
  const infoButton = useRef<HTMLButtonElement>(null);
  const downloading = model.state === "downloading" || model.state === "verifying";
  const progress = model.downloaded === undefined ? 0 : (model.downloaded / model.size) * 100;
  const size = formatSize(model.size);
  const benchmarks = (
    <ModelBenchmarks
      model={model}
      languages={props.comparisonLanguages}
      tier={props.benchmarkTier}
      facts={[
        ...(model.languages.length > 1
          ? [
              gt("{count, plural, one {{count} language} other {{count} languages}}", {
                count: model.languages.length,
              }),
            ]
          : !model.benchmark && model.languages[0]
            ? [languageLabel(model.languages[0], locale)]
            : []),
        ...(props.manageOnly ? [] : [size]),
      ]}
    />
  );
  const detailLabel = gt("Details for {model}", { model: model.name });
  const downloadAction = downloading ? (
    <Button
      size="icon-sm"
      variant="outline"
      aria-label={gt("Cancel {name} download", { name: model.name })}
      disabled={!props.canCancel}
      onClick={props.onCancel}
    >
      <XIcon className="size-3.5" />
    </Button>
  ) : model.state === "downloadable" && props.manageOnly ? (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="icon-xs"
            variant="ghost-muted"
            aria-label={gt("Download {name}", { name: model.name })}
            disabled={props.busy}
            onClick={props.onDownload}
          />
        }
      >
        <DownloadIcon />
      </TooltipTrigger>
      <TooltipPopup>{gt("Download")}</TooltipPopup>
    </Tooltip>
  ) : model.state === "downloadable" ? (
    <Button size="sm" variant="outline" disabled={props.busy} onClick={props.onDownload}>
      <DownloadIcon />
      <T>Download</T>
    </Button>
  ) : null;
  const progressBar = downloading ? (
    <div className="mt-2">
      <div
        role="progressbar"
        aria-label={gt("{name} download progress", { name: model.name })}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(progress)}
        className="h-1 overflow-hidden rounded-full bg-muted"
      >
        <div
          className="h-full bg-primary transition-[width] duration-200"
          style={{ width: `${progress}%` }}
        />
      </div>
      <p className="mt-1 text-2xs text-muted-foreground">
        {model.state === "verifying"
          ? gt("Verifying download…")
          : gt("{percent}% downloaded", { percent: Math.round(progress) })}
      </p>
    </div>
  ) : null;
  if (props.manageOnly) {
    return (
      <Popover>
        <div className="relative rounded-xl border border-border/70 bg-card/50 px-3 py-2.5 transition-colors has-[[data-speech-model-body]:hover]:bg-muted/50 has-[[data-speech-model-body]:focus-visible]:outline has-[[data-speech-model-body]:focus-visible]:outline-ring">
          <div className="flex items-center gap-2">
            <PopoverTrigger
              data-speech-model-body
              aria-label={gt("Open details for {model}", { model: model.name })}
              render={
                <button
                  type="button"
                  className="flex min-w-0 flex-1 cursor-pointer flex-col gap-1 text-start outline-none after:absolute after:inset-0 after:rounded-xl"
                />
              }
            >
              <span className="text-sm font-medium leading-5">{model.name}</span>
              <span className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
                <span className="text-xs text-muted-foreground tabular-nums">{size}</span>
                {props.recommendationLabel ? (
                  <Badge variant="info" size="sm">
                    <StarIcon />
                    {props.recommendationLabel}
                  </Badge>
                ) : null}
                {props.recommendationContext && !props.recommendationLabel ? (
                  <Badge variant="outline" size="sm">
                    {props.recommendationContext}
                  </Badge>
                ) : null}
              </span>
            </PopoverTrigger>
            <div className="pointer-events-none relative z-10 flex shrink-0 items-center gap-1.5 [&>*]:pointer-events-auto">
              <PopoverTrigger
                openOnHover
                delay={150}
                closeDelay={100}
                render={
                  <Button
                    ref={infoButton}
                    tabIndex={-1}
                    size="icon-xs"
                    variant="ghost-muted"
                    aria-label={detailLabel}
                  />
                }
              >
                <InfoIcon />
              </PopoverTrigger>
              {downloadAction}
              {model.state === "installed" ? (
                <Button
                  size="sm"
                  variant="ghost-muted"
                  disabled={props.busy}
                  onClick={props.onDelete}
                >
                  {model.linkedFrom ? <T>Stop using file</T> : <T>Remove</T>}
                </Button>
              ) : null}
            </div>
          </div>
          {progressBar}
        </div>
        <PopoverPopup anchor={infoButton} width="sm" padding="comfortable" align="end">
          <div className="space-y-2">
            <PopoverTitle>{model.name}</PopoverTitle>
            {props.recommendationContext && props.recommendationLabel ? (
              <Badge variant="outline" size="sm">
                {props.recommendationContext}
              </Badge>
            ) : null}
            {model.description ? (
              <PopoverDescription size="compact">{model.description}</PopoverDescription>
            ) : null}
            {model.linkedFrom ? (
              <p className="text-xs text-muted-foreground">
                <T>Uses a model file already on this computer.</T>
              </p>
            ) : null}
            {benchmarks}
          </div>
        </PopoverPopup>
      </Popover>
    );
  }
  return (
    <div className="@container/model px-3 py-3">
      <div
        className={cn(
          "flex flex-col gap-2.5",
          !props.stacked &&
            "@min-[28rem]/model:flex-row @min-[28rem]/model:items-start @min-[28rem]/model:gap-4",
        )}
      >
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-sm font-medium leading-5">{model.name}</span>
            {props.recommendation ? (
              <ModelBadge
                icon={<StarIcon className="mr-1 size-3" />}
                label={
                  props.recommendation === "recommended"
                    ? props.recommendationLanguage
                      ? gt("Recommended for {language}", {
                          language: languageLabel(props.recommendationLanguage, locale),
                        })
                      : gt("Recommended")
                    : props.recommendation === "faster"
                      ? gt("Faster", { $context: "speech model badge, quicker than Recommended" })
                      : gt("More accurate")
                }
                tooltip={
                  props.recommendation === "recommended"
                    ? gt(
                        "Balanced accuracy and speed for your selected languages on Handy’s reference benchmarks.",
                      )
                    : props.recommendation === "faster"
                      ? gt("Quicker than Recommended on this reference tier, with useful accuracy.")
                      : gt(
                          "Higher accuracy with a longer reference processing budget for your selected languages.",
                        )
                }
              />
            ) : null}
            {!props.dictation && model.supportsStreaming ? (
              <ModelBadge
                icon={<AudioLinesIcon className="mr-1 size-3" />}
                label={gt("Live preview")}
                tooltip={gt(
                  "Shows words in your draft as you speak, before the recording finishes.",
                )}
              />
            ) : null}
            {!props.dictation && model.supportsTranslation ? (
              <ModelBadge
                icon={<LanguagesIcon className="mr-1 size-3" />}
                label={gt("Translate")}
                tooltip={gt(
                  "Can write English text from speech in another language. Turn on Translate to English to use it.",
                )}
              />
            ) : null}
          </div>
          {model.description ? (
            <p className="mt-0.5 text-xs leading-normal text-muted-foreground">
              {model.description}
            </p>
          ) : null}
          {model.linkedFrom ? (
            <p className="mt-0.5 text-2xs text-muted-foreground">
              <T>Uses a model file already on this computer.</T>
            </p>
          ) : null}
          {benchmarks}
          {progressBar}
        </div>
        <div className="flex max-w-full shrink-0 flex-wrap items-center gap-1.5">
          {props.testControls}
          {downloadAction ??
            (model.active ? (
              <Button size="sm" variant="secondary" disabled>
                <CheckIcon />
                <T>Selected</T>
              </Button>
            ) : (
              <Button size="sm" variant="outline" disabled={props.busy} onClick={props.onSelect}>
                <T>Use model</T>
              </Button>
            ))}
          {model.state === "installed" ? (
            <Button
              size="icon-sm"
              variant="outline"
              disabled={props.busy}
              aria-label={
                model.linkedFrom
                  ? gt("Stop using your {name} file; the file stays on disk", { name: model.name })
                  : gt("Delete {name}", { name: model.name })
              }
              onClick={props.onDelete}
            >
              {model.linkedFrom ? <UnlinkIcon /> : <Trash2Icon />}
            </Button>
          ) : null}
        </div>
      </div>
      {props.children}
    </div>
  );
}

/** Cleanup runs on the draft's environment, so its model is an environment setting there. */
export function CleanupModelRow({
  recordings = false,
  disabled = false,
  keepControlsVisible = false,
}: {
  recordings?: boolean;
  disabled?: boolean;
  keepControlsVisible?: boolean;
}) {
  const setting = useSearchableSetting();
  const gt = useGT();
  const { environment, connectedEnvironments } = useSettingsScope();
  const settings = useScopedSettings();
  const modelKey = recordings
    ? "recordingCorrectionModelSelection"
    : "speechPostProcessingModelSelection";
  const dedicatedSelection = settings[modelKey] ?? null;
  const updateSettings = useUpdateScopedSettings();
  const providersByEnvironment = useEnvironmentProviders();
  const providers =
    (environment?.serverConfig
      ? providersByEnvironment.get(environment.environmentId)
      : undefined) ?? EMPTY_SERVER_PROVIDERS;
  const targets = useTextGenerationTargets({
    environmentId: environment?.environmentId ?? null,
    settings,
    providers: providers.filter((provider) => provider.supportsTextGeneration !== false),
    projectId: null,
    selections: [dedicatedSelection, settings.textGenerationModelSelection],
  });
  const textGenerationProviders = targets.providers;
  const instanceEntries = targets.entries;
  const hasProvider = instanceEntries.some((entry) => entry.enabled && entry.isAvailable);
  const dedicated = dedicatedSelection !== null;
  const selection = resolveAppModelSelectionState(
    {
      ...settings,
      textGenerationModelSelection: resolveSpeechPostProcessingModelSelection(
        { ...settings, speechPostProcessingModelSelection: dedicatedSelection },
        textGenerationProviders,
      ),
    },
    textGenerationProviders,
  );
  const modelOptionsByInstance = getTextGenerationModelOptionsByInstance(
    settings,
    textGenerationProviders,
    selection.instanceId,
    selection.model,
  );
  const instanceEntry = instanceEntries.find((entry) => entry.instanceId === selection.instanceId);
  const modelDisabledReason = useScopedModelDisabledReason(settings, instanceEntries, true);
  const setModel = (next: ReturnType<typeof createModelSelection>) => {
    const reason = modelDisabledReason(next.instanceId, next.model);
    if (reason) {
      toastManager.add({
        type: "error",
        title: gt("Cleanup model not saved"),
        description: reason,
      });
      return;
    }
    updateSettings({ [modelKey]: next });
  };
  return (
    <SettingsRow
      serverScoped
      settingKeys={[modelKey]}
      {...setting("speech-post-processing-model")}
      title={recordings ? gt("Correction model") : gt("Cleanup model")}
      description={gt("Uses the default text generation model when off.")}
      control={
        connectedEnvironments.length === 0 ? (
          <span className="text-sm text-muted-foreground">
            <T>Connect an environment first.</T>
          </span>
        ) : (
          <div className="flex min-w-0 flex-wrap items-center gap-2 @min-[32rem]/settings-row:justify-end">
            {dedicated && (!hasProvider || !instanceEntry) ? (
              <span className="text-sm text-muted-foreground">
                <T>No text generation providers available.</T>
              </span>
            ) : null}
            {(dedicated || keepControlsVisible) && hasProvider && instanceEntry ? (
              <>
                <ProviderModelPicker
                  environmentId={environment?.environmentId ?? null}
                  activeInstanceId={selection.instanceId}
                  model={selection.model}
                  lockedProvider={null}
                  disabled={disabled || !dedicated}
                  instanceEntries={instanceEntries}
                  modelOptionsByInstance={modelOptionsByInstance}
                  triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
                  getModelDisabledReason={modelDisabledReason}
                  onInstanceModelChange={(instanceId, model) =>
                    setModel(pickModelSelection(selection, instanceId, model))
                  }
                />
                <TraitsPicker
                  provider={instanceEntry.driverKind}
                  models={instanceEntry.models}
                  model={selection.model}
                  modelOptions={selection.options ?? []}
                  allowPromptInjectedEffort={false}
                  disabled={disabled || !dedicated}
                  triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
                  onModelOptionsChange={(options) =>
                    setModel(createModelSelection(selection.instanceId, selection.model, options))
                  }
                />
              </>
            ) : null}
            <Switch
              checked={dedicated}
              disabled={disabled || (!dedicated && !hasProvider)}
              onCheckedChange={(checked) =>
                updateSettings({
                  [modelKey]: checked
                    ? createModelSelection(
                        settings.textGenerationModelSelection.instanceId,
                        settings.textGenerationModelSelection.model,
                        settings.textGenerationModelSelection.options,
                      )
                    : null,
                })
              }
              aria-label={gt("Use a separate cleanup model")}
            />
          </div>
        )
      }
    />
  );
}

export function useVoiceModels(prepared: PreparedConnection | null) {
  const gt = useGT();
  const canManage = useEnvironmentScope(prepared?.environmentId ?? null, AuthSettingsWriteScope);
  const [models, setModels] = useState<readonly EnvironmentSpeechModel[]>([]);
  const [status, setStatus] = useState<EnvironmentSpeechStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [requestedDownload, setRequestedDownload] = useState<string | null>(null);
  const [actionConnection, setActionConnection] = useState(prepared);
  if (actionConnection !== prepared) {
    setActionConnection(prepared);
    setBusy(false);
    setRequestedDownload(null);
    setModels([]);
    setStatus(null);
  }
  const epoch = useRef(0);
  const refreshRevision = useRef(0);
  const refresh = useStableCallback(
    async (connection: PreparedConnection, mode: "foreground" | "progress") => {
      const current = epoch.current;
      const revision = ++refreshRevision.current;
      try {
        const [nextStatus, nextModels] = await Promise.all([
          runEnvironmentSpeech(getEnvironmentSpeechStatus(connection)),
          runEnvironmentSpeech(getEnvironmentSpeechModels(connection, mode === "foreground")),
        ]);
        if (current !== epoch.current || revision !== refreshRevision.current) return;
        setStatus(nextStatus);
        setModels((previous) => {
          if (mode === "foreground") return nextModels.models;
          const benchmarks = new Map(previous.map((model) => [model.id, model.benchmark]));
          return nextModels.models.map((model) => {
            const benchmark = benchmarks.get(model.id);
            return benchmark ? { ...model, benchmark } : model;
          });
        });
      } catch (error) {
        if (mode === "progress") return;
        if (current !== epoch.current || revision !== refreshRevision.current) return;
        toastManager.add({
          type: "error",
          title: gt("Could not load transcription models"),
          description:
            error instanceof Error
              ? (thrownErrorMessage(error, m) ?? error.message)
              : String(error),
        });
      }
    },
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- loads the environment's model catalog when its connection becomes available
  useEffect(() => {
    epoch.current += 1;
    if (prepared) void refresh(prepared, "foreground");
    return () => {
      epoch.current += 1;
    };
  }, [prepared, refresh]);
  const downloading =
    requestedDownload !== null ||
    models.some((model) => model.state === "downloading" || model.state === "verifying");
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- polls progress while a local request or the environment reports an active download
  useEffect(() => {
    if (!prepared || !downloading) return;
    let cancelled = false;
    let timer: number | undefined;
    const poll = async () => {
      await refresh(prepared, "progress");
      if (!cancelled) timer = window.setTimeout(() => void poll(), 1_000);
    };
    void poll();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [downloading, prepared, refresh]);

  const run = async (label: string, work: () => Promise<unknown>, downloadId?: string) => {
    if (!prepared || !canManage) return;
    const current = epoch.current;
    if (downloadId) setRequestedDownload(downloadId);
    else setBusy(true);
    try {
      await work();
    } catch (error) {
      if (current === epoch.current)
        toastManager.add({
          type: "error",
          title: label,
          description:
            error instanceof Error
              ? (thrownErrorMessage(error, m) ?? error.message)
              : String(error),
        });
    }
    if (current === epoch.current) {
      if (downloadId) setRequestedDownload(null);
      else setBusy(false);
      await refresh(prepared, "foreground");
    }
  };
  return {
    models,
    status,
    run,
    controlsDisabled: busy || downloading || !canManage,
    canCancel: canManage && !busy,
    requestedDownload,
  };
}

type VoiceModels = ReturnType<typeof useVoiceModels>;

function AdvancedSpeechSettings({
  prepared,
  catalog,
  dictation = false,
}: {
  prepared: PreparedConnection;
  catalog: VoiceModels;
  dictation?: boolean;
}) {
  const messages = useMessages();
  const setting = useSearchableSetting();
  const gt = useGT();
  const settings = useClientSettings();
  const { run, controlsDisabled, status } = catalog;
  if (!status?.supported) return null;
  const supported = status;
  return (
    <AdvancedSettings targetIds={[setting("speech-streaming").id, setting("speech-hardware").id]}>
      {!dictation ? (
        <SettingsRow
          {...setting("speech-streaming")}
          title={gt("Streaming transcription")}
          description={
            supported.supportsStreaming
              ? gt(
                  "Transcribe while recording. Turn off to transcribe after stopping, which may help when live transcription falls behind.",
                )
              : gt("This model doesn’t support native streaming.")
          }
          control={
            <Switch
              aria-label={gt("Streaming transcription")}
              disabled={!supported.supportsStreaming}
              checked={settings.speechStreaming}
              onCheckedChange={(checked) => void updateClientSettings({ speechStreaming: checked })}
            />
          }
        />
      ) : null}
      <SettingsRow
        {...setting("speech-hardware")}
        title={gt("Hardware")}
        description={gt("Auto uses the environment’s GPU when it has one.")}
        control={
          <Select
            value={supported.acceleration}
            disabled={controlsDisabled}
            onValueChange={(value) => {
              if (value)
                void run(gt("Could not change transcription hardware"), () =>
                  runEnvironmentSpeech(
                    updateEnvironmentSpeechAcceleration(prepared, value as SpeechAcceleration),
                  ),
                );
            }}
          >
            <SelectTrigger size="sm" aria-label={gt("Transcription hardware")} className="max-w-72">
              <SelectValue>
                {supported.acceleration === "auto"
                  ? gt("Auto")
                  : supported.acceleration === "cpu"
                    ? gt("CPU")
                    : (supported.gpuDevices.find(
                        (device) => `gpu:${device.id}` === supported.acceleration,
                      )?.name ?? gt("Selected GPU"))}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              <SelectItem value="auto">
                <T>Auto</T>
              </SelectItem>
              <SelectItem value="cpu">
                <T>CPU</T>
              </SelectItem>
              {supported.gpuDevices.map((device) => (
                <SelectItem key={device.id} value={`gpu:${device.id}`}>
                  {device.name}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
      <SettingsRow
        title={gt("Unload model")}
        description={gt("Release the model’s memory on the environment after it sits idle.")}
        control={
          <Select
            value={supported.modelUnloadTimeout}
            disabled={controlsDisabled}
            onValueChange={(value) => {
              if (value)
                void run(gt("Could not change when the model unloads"), () =>
                  runEnvironmentSpeech(
                    updateEnvironmentSpeechModelUnloadTimeout(
                      prepared,
                      value as SpeechModelUnloadTimeout,
                    ),
                  ),
                );
            }}
          >
            <SelectTrigger size="sm" aria-label={gt("Unload model")} className="max-w-72">
              <SelectValue>{messages(UNLOAD_LABELS[supported.modelUnloadTimeout])}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {(Object.keys(UNLOAD_LABELS) as SpeechModelUnloadTimeout[]).map((timeout) => (
                <SelectItem key={timeout} value={timeout}>
                  {messages(UNLOAD_LABELS[timeout])}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
    </AdvancedSettings>
  );
}

export function DictationEngineCatalog({
  prepared,
  language,
  catalog,
}: {
  prepared: PreparedConnection | null;
  language: string;
  catalog: VoiceModels;
}) {
  const gt = useGT();
  const locale = useLocale();
  const { status, models, run, controlsDisabled, canCancel, requestedDownload } = catalog;
  const [preferred] = useState(preferredSpeechLanguages);
  const [compareLanguage, setCompareLanguage] = useState("");
  const [showAllModels, setShowAllModels] = useState(false);
  if (!prepared || !status) return null;
  if (!status.supported) {
    return <SettingsRow title={gt("Local transcription")} description={status.reason} />;
  }
  const recommendation = chooseSetupSpeechModel(models, {
    selectedModelId: "",
    intent: compareLanguage || language,
    preferred,
    benchmarkTier: status.benchmarkTier,
  });
  const effectiveLanguage = recommendation?.language ?? (language === "auto" ? "en" : language);
  const recordingChoices = recordingSpeechModelIds(effectiveLanguage)
    .map((id) =>
      models.find((model) => model.id === id && model.languages.includes(effectiveLanguage)),
    )
    .filter((model) => model !== undefined);
  const recordingModel =
    recordingChoices.find((model) => model.state === "installed") ?? recordingChoices[0];
  const recommendedModel = recommendation?.model;
  const ordered = recommendedModel
    ? [recommendedModel, ...models.filter(({ id }) => id !== recommendedModel.id)]
    : models;
  // Installed and recommended models come first; the rest of the catalog waits behind one button.
  const featured = (model: (typeof models)[number]) =>
    model.state !== "downloadable" ||
    model.id === recommendedModel?.id ||
    model.id === recordingModel?.id ||
    (effectiveLanguage === "he" && model.id === HEBREW_RECORDING_MODEL_ID) ||
    model.id === requestedDownload;
  const visibleModels = showAllModels ? ordered : ordered.filter(featured);
  const hiddenCount = ordered.length - ordered.filter(featured).length;
  const recommendationLabel = (model: EnvironmentSpeechModel) => {
    if (model.id === HEBREW_RECORDING_MODEL_ID) return gt("Recommended for Hebrew");
    if (model.id === MULTILINGUAL_RECORDING_MODEL_ID) return gt("Recommended for mixed languages");
    if (model.id === recommendedModel?.id && effectiveLanguage !== "he")
      return gt("Recommended for {language}", {
        language: languageLabel(effectiveLanguage, locale),
      });
    return undefined;
  };
  return (
    <>
      <SettingsRow
        title={gt("Models on this computer")}
        description={gt("{size} downloaded. Models you add here appear under Dictate with.", {
          size: formatSize(
            models
              .filter(({ state, linkedFrom }) => state === "installed" && !linkedFrom)
              .reduce((total, model) => total + model.size, 0),
          ),
        })}
        control={
          <VoiceLanguagePicker
            label={gt("Compare languages")}
            value={compareLanguage}
            languages={models.flatMap((model) => model.languages)}
            special={{ value: "", label: gt("Clear comparison"), clearOnly: true }}
            onChange={setCompareLanguage}
          />
        }
      >
        <div className="mt-3 grid gap-3 md:grid-cols-2">
          {visibleModels.map((model) => (
            <EngineCard
              manageOnly
              key={model.id}
              model={{
                ...model,
                active: false,
                state:
                  model.id === requestedDownload && model.state === "downloadable"
                    ? "downloading"
                    : model.state,
              }}
              comparisonLanguages={recommendation?.language ? [recommendation.language] : []}
              recommendation={undefined}
              recommendationLabel={recommendationLabel(model)}
              recommendationContext={
                recordingModel && recommendedModel && recordingModel.id !== recommendedModel.id
                  ? model.id === recordingModel.id
                    ? gt("for recordings")
                    : model.id === recommendedModel.id
                      ? gt("for dictation")
                      : undefined
                  : undefined
              }
              benchmarkTier={status.benchmarkTier}
              busy={controlsDisabled}
              canCancel={canCancel}
              dictation
              onDownload={() =>
                void run(
                  gt("Could not download the model"),
                  () => runEnvironmentSpeech(downloadEnvironmentSpeechModel(prepared, model.id)),
                  model.id,
                )
              }
              onSelect={() =>
                void updateClientSettings({
                  voiceCatalogModelId: model.id,
                  voiceDictationEngine: "local",
                })
              }
              onCancel={() =>
                void run(gt("Could not cancel the download"), () =>
                  runEnvironmentSpeech(cancelEnvironmentSpeechModelDownload(prepared, model.id)),
                )
              }
              onDelete={() =>
                void run(gt("Could not delete the model"), () =>
                  runEnvironmentSpeech(removeEnvironmentSpeechModel(prepared, model.id)),
                )
              }
            />
          ))}
        </div>
        {hiddenCount > 0 ? (
          <Button
            className="mt-2"
            size="sm"
            variant="ghost-muted"
            onClick={() => setShowAllModels(!showAllModels)}
          >
            {showAllModels
              ? gt("Show fewer models")
              : gt("Show {count} more models to download", { count: hiddenCount })}
          </Button>
        ) : null}
      </SettingsRow>
      <AdvancedSpeechSettings prepared={prepared} catalog={catalog} dictation />
    </>
  );
}

function SpeechModelBrowser(props: {
  prepared: PreparedConnection;
  catalog: VoiceModels;
  testEnvironmentId: EnvironmentId;
  projectId: ProjectId | null;
  projectName: string | null;
}) {
  const setting = useSearchableSetting();
  const gt = useGT();
  const locale = useLocale();
  const {
    prepared,
    catalog: { status, models, run, controlsDisabled, canCancel, requestedDownload },
  } = props;
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<SpeechModelSort>("recommended");
  const [downloadedOnly, setDownloadedOnly] = useState(false);
  const [existingPath, setExistingPath] = useState("");
  const canReadFiles = useEnvironmentScope(prepared.environmentId, AuthFilesystemReadScope);
  const [languageSearch, setLanguageSearch] = useState("");
  const [selection, setSelection] = useState<string[] | null>(null);
  const [preferred] = useState(preferredSpeechLanguages);
  const supportedLanguages = [...new Set(models.flatMap((model) => model.languages))];
  const defaultLanguage = preferred.find((code) => supportedLanguages.includes(code));
  const selectedLanguages = selection ?? (defaultLanguage ? [defaultLanguage] : []);
  const languages = orderSpeechLanguages(supportedLanguages, preferred, locale);
  const needle = languageSearch.trim().toLocaleLowerCase();
  const visibleLanguages = languages.filter(
    (code) =>
      !needle ||
      code.includes(needle) ||
      languageLabel(code, locale).toLocaleLowerCase().includes(needle),
  );
  const accuracyLanguage = selectedLanguages[0] ?? "en";
  const sortLabels: Record<SpeechModelSort, string> = {
    recommended: gt("Recommended"),
    size: gt("Smallest"),
    accuracy: gt("Most accurate"),
    speed: gt("Fastest"),
  };
  const languagesLabel =
    selectedLanguages.length === 0
      ? gt("All languages")
      : selectedLanguages.map((code) => languageLabel(code, locale)).join(", ");
  const benchmarkTier = status?.supported ? status.benchmarkTier : undefined;
  const recommendations = recommendSpeechModels(models, selectedLanguages, benchmarkTier);
  const sortedModels = filterSpeechModels(
    models,
    {
      search,
      languages: selectedLanguages,
      downloadedOnly,
      sort,
      accuracyLanguage,
      benchmarkTier,
    },
    recommendations,
  );
  const activeModel = models.find((model) => model.active);
  const renderedModels =
    activeModel && !sortedModels.includes(activeModel)
      ? [activeModel, ...sortedModels]
      : sortedModels;

  if (!status) return null;
  if (!status.supported)
    return (
      <SettingsRow
        {...setting("speech-models")}
        title={gt("Models")}
        description={gt("This environment can’t transcribe audio: {reason}.", {
          reason: status.reason,
        })}
      />
    );
  return (
    <SettingsRow
      {...setting("speech-models")}
      title={gt("Models")}
      description={gt(
        "Grades and seconds per 30 s use Handy’s reference {tier}, not your hardware. Select languages for balanced recommendations.",
        { tier: status.benchmarkTier === "cpu" ? "CPU" : "GPU" },
      )}
      className="@container/voice-models"
    >
      <div className="mt-3 flex min-w-0 gap-2">
        <InputGroup className="min-w-0 flex-1 **:[input]:h-9 sm:**:[input]:h-8">
          <InputGroupAddon>
            <SearchIcon aria-hidden />
          </InputGroupAddon>
          {/* Native search inputs clear on Escape even during IME composition. */}
          <InputGroupInput
            type="text"
            role="searchbox"
            aria-label={gt("Search transcription models")}
            placeholder={gt("Search models")}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Escape" || event.defaultPrevented) return;
              if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
              const composing = event.nativeEvent.isComposing || event.keyCode === 229;
              if (!composing && !search && !event.repeat) return;
              event.stopPropagation();
              if (composing) return;
              event.preventDefault();
              setSearch("");
            }}
          />
        </InputGroup>
        <Menu>
          <MenuTrigger
            render={<Button variant="outline" className="max-w-56" />}
            aria-label={gt("Filter by language: {languagesLabel}", { languagesLabel })}
          >
            <LanguagesIcon />
            <span className="hidden truncate @min-[34rem]/voice-models:inline">
              {languagesLabel}
            </span>
          </MenuTrigger>
          <MenuPopup align="end">
            <MenuSearchInput
              autoFocus
              aria-label={gt("Search languages")}
              placeholder={gt("Search languages")}
              value={languageSearch}
              onChange={(e) => setLanguageSearch(e.target.value)}
            />
            <div
              role="group"
              aria-label={gt("Browse models by language")}
              className="max-h-72 overflow-y-auto"
            >
              {needle ? null : (
                <MenuCheckboxItem
                  checked={selectedLanguages.length === 0}
                  onCheckedChange={() => setSelection([])}
                >
                  <T>All languages</T>
                </MenuCheckboxItem>
              )}
              {visibleLanguages.map((code) => (
                <MenuCheckboxItem
                  key={code}
                  checked={selectedLanguages.includes(code)}
                  onCheckedChange={() =>
                    setSelection(
                      selectedLanguages.includes(code)
                        ? selectedLanguages.filter((language) => language !== code)
                        : [...selectedLanguages, code],
                    )
                  }
                >
                  {languageLabel(code, locale)}
                </MenuCheckboxItem>
              ))}
              {visibleLanguages.length === 0 && (
                <p className="px-2 py-1.5 text-sm text-muted-foreground">
                  <T>No languages match.</T>
                </p>
              )}
            </div>
          </MenuPopup>
        </Menu>
        <Menu>
          <MenuTrigger
            render={<Button variant="outline" />}
            aria-label={
              downloadedOnly
                ? gt("Sort and filter models: {sort}, downloaded only", { sort: sortLabels[sort] })
                : gt("Sort and filter models: {sort}", { sort: sortLabels[sort] })
            }
          >
            <ArrowDownUpIcon />
            <span className="hidden @min-[34rem]/voice-models:inline">{sortLabels[sort]}</span>
          </MenuTrigger>
          <MenuPopup align="end">
            <MenuGroup>
              <MenuGroupLabel>
                <T>Sort by</T>
              </MenuGroupLabel>
              <MenuRadioGroup
                value={sort}
                onValueChange={(value) => setSort(value as SpeechModelSort)}
              >
                {(Object.keys(sortLabels) as SpeechModelSort[]).map((value) => (
                  <MenuRadioItem key={value} value={value} closeOnClick>
                    <span className="flex items-center justify-between gap-3">
                      {value === "accuracy"
                        ? gt("Most accurate in {language}", {
                            language: languageLabel(accuracyLanguage, locale),
                          })
                        : sortLabels[value]}
                      <MenuRadioItemIndicator />
                    </span>
                  </MenuRadioItem>
                ))}
              </MenuRadioGroup>
            </MenuGroup>
            <MenuSeparator />
            <MenuCheckboxItem checked={downloadedOnly} onCheckedChange={setDownloadedOnly}>
              <T>Downloaded only</T>
            </MenuCheckboxItem>
          </MenuPopup>
        </Menu>
      </div>
      <div
        className="mt-2 mb-2 max-h-96 divide-y divide-border/60 overflow-y-auto rounded-lg border border-border/60"
        role="region"
        aria-label={gt("Transcription models")}
        tabIndex={0}
      >
        {sortedModels.length === 0 && (
          <p className="px-3 py-3 text-sm text-muted-foreground">
            <T>No models match.</T>
          </p>
        )}
        {renderedModels.map((model) => {
          const card: ModelCardProps = {
            model:
              model.id === requestedDownload && model.state === "downloadable"
                ? { ...model, state: "downloading" }
                : model,
            busy: controlsDisabled,
            canCancel,
            comparisonLanguages: selectedLanguages,
            recommendation: recommendations.get(model.id),
            benchmarkTier: status.benchmarkTier,
            onDownload: () =>
              void run(
                gt("Could not download the model"),
                () => runEnvironmentSpeech(downloadEnvironmentSpeechModel(prepared, model.id)),
                model.id,
              ),
            onSelect: () =>
              void run(gt("Could not select the model"), () =>
                runEnvironmentSpeech(selectEnvironmentSpeechModel(prepared, model.id)),
              ),
            onCancel: () =>
              void run(gt("Could not cancel the download"), () =>
                runEnvironmentSpeech(cancelEnvironmentSpeechModelDownload(prepared, model.id)),
              ),
            onDelete: () =>
              void run(gt("Could not delete the model"), () =>
                runEnvironmentSpeech(removeEnvironmentSpeechModel(prepared, model.id)),
              ),
          };
          return model.active ? (
            <TranscriptionTest
              key={model.id}
              card={card}
              hidden={!sortedModels.includes(model)}
              environmentId={props.testEnvironmentId}
              projectId={props.projectId}
              projectName={props.projectName}
            />
          ) : (
            <EngineCard key={model.id} {...card} />
          );
        })}
      </div>
      {status.supportsModelLinking && canReadFiles ? (
        <form
          className="mb-2 flex flex-col items-start gap-2 @min-[28rem]/voice-models:flex-row @min-[28rem]/voice-models:items-center"
          onSubmit={(event) => {
            event.preventDefault();
            void run(gt("Could not use a model from that path"), async () => {
              await runEnvironmentSpeech(linkEnvironmentSpeechModels(prepared, existingPath));
              setExistingPath("");
            });
          }}
        >
          <div className="w-full min-w-0 flex-1">
            <Input
              size="compact"
              aria-label={gt("Path to a model file or folder already on this environment")}
              placeholder={gt("Already downloaded elsewhere? Paste the model file or folder path")}
              value={existingPath}
              onChange={(e) => setExistingPath(e.target.value)}
            />
          </div>
          <Button
            type="submit"
            size="sm"
            variant="outline"
            disabled={controlsDisabled || !existingPath.trim()}
          >
            <T>Use existing</T>
          </Button>
        </form>
      ) : null}
    </SettingsRow>
  );
}

function TranscriptionTest(props: {
  readonly card: ModelCardProps;
  readonly hidden: boolean;
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId | null;
  readonly projectName: string | null;
}) {
  const setting = useSearchableSetting();
  const gt = useGT();
  const [transcript, setTranscript] = useState<string | null>(null);
  const draft = transcript ?? "";
  const [showTranscript, setShowTranscript] = useState(false);
  const draftRef = useRef(draft);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- publishes the committed draft to the asynchronous transcription controller
  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);
  const speech = useEnvironmentSpeechInput({
    environmentId: props.environmentId,
    projectId: props.projectId,
    projectName: props.projectName,
    ownerKey: JSON.stringify([props.environmentId, props.projectId]),
    cleanup: false,
    readDraft: () => ({
      text: draftRef.current,
      selection: { start: draftRef.current.length, end: draftRef.current.length },
    }),
    commitDraft: (text) => setTranscript(text),
  });
  return (
    <SettingsSearchTarget {...setting("transcription-test")} hidden={props.hidden}>
      <EngineCard
        {...props.card}
        stacked={showTranscript}
        testControls={
          <div className="order-last flex min-w-0 max-w-full basis-full items-center gap-1 @min-[28rem]/model:order-none @min-[28rem]/model:basis-auto">
            <ComposerSpeechRecordingPill
              state={speech.state}
              progress={null}
              level={speech.level}
              onStart={() => void speech.start()}
              onStop={() => void speech.stop()}
              onCancel={() => speech.cancel()}
              onSkipPostProcessing={() => speech.skipPostProcessing()}
            />
            {speech.available ? (
              speech.state.phase === "idle" ? (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setShowTranscript(true);
                    void speech.start();
                  }}
                >
                  <MicIcon />
                  <T>Test model</T>
                </Button>
              ) : null
            ) : (
              <span className="text-xs text-muted-foreground">
                {speech.status?.supported === false
                  ? speech.status.reason
                  : gt("Waiting for the environment to connect")}
              </span>
            )}
          </div>
        }
      >
        {showTranscript ? (
          <div className="mt-3 flex items-start gap-3 rounded-lg border border-border/60 bg-muted/30 py-1 ps-3 pe-1">
            <div className="min-w-0 flex-1 py-1.5">
              {speech.preview || transcript !== null ? null : (
                <p className="text-xs text-muted-foreground">
                  <T>
                    Say a sentence. Cleanup is skipped, so you see exactly what the model heard.
                  </T>
                </p>
              )}
              {speech.preview || transcript !== null ? (
                <p
                  role="status"
                  aria-label={gt("Test transcript")}
                  className="select-text whitespace-pre-wrap break-words text-sm leading-relaxed"
                >
                  {speech.preview ? (
                    <>
                      {speech.preview.committed}
                      <span className="text-muted-foreground">{speech.preview.tentative}</span>
                    </>
                  ) : (
                    transcript || gt("No speech recognized. Try again.")
                  )}
                </p>
              ) : null}
            </div>
            <Button
              size="icon-sm"
              variant="ghost-muted"
              aria-label={gt("Close model test")}
              onClick={() => {
                speech.cancel();
                setShowTranscript(false);
              }}
            >
              <XIcon />
            </Button>
          </div>
        ) : null}
      </EngineCard>
      <VoiceInputSetup
        environmentId={speech.transcriptionEnvironmentId}
        open={speech.setup.open}
        step={speech.setup.step}
        status={speech.status}
        model={speech.setup.model}
        language={speech.setup.language}
        downloading={speech.setup.downloading}
        error={speech.setup.error}
        onOpenChange={speech.setup.setOpen}
        onRetryCatalog={speech.setup.retryCatalog}
        onDownload={() => void speech.setup.download()}
        onCancelDownload={() => void speech.setup.cancelDownload()}
        onStartRecording={() => void speech.setup.startRecording()}
      />
    </SettingsSearchTarget>
  );
}

export function VoiceSettingsPanel() {
  const searchTargetId = useSettingsSearchTargetId();
  const setting = useSearchableSetting();
  const gt = useGT();
  const cleanupEnabled = useCleanupGrant() !== null;
  const settings = useClientSettings();
  const settingsScope = useOptionalSettingsScope();
  const destination = useVoiceTranscriptionDestination();
  const appleSpeechLocales = useAppleSpeechLocales();
  const appleSpeechLanguages =
    !appleSpeechLocales.includes(settings.speechLanguage) &&
    supportsAppleSpeechLocale(appleSpeechLocales, settings.speechLanguage)
      ? [...appleSpeechLocales, settings.speechLanguage]
      : appleSpeechLocales;
  const appleSpeechAvailable = appleSpeechLocales.length > 0;
  const appleSpeechLabel = appleSpeechAvailable
    ? APPLE_SPEECH_LABEL
    : gt("Apple Speech (unavailable)");
  const canManageKey = useEnvironmentScope(destination.environmentId, AuthSettingsWriteScope);
  const [pendingCloud, setPendingCloud] = useState<{
    provider: CloudSpeechProvider;
    environmentId: EnvironmentId;
  } | null>(null);
  const { environments } = useEnvironments();
  const prepared = destination.cloudProvider ? null : destination.prepared;
  const catalog = useVoiceModels(prepared);

  const modelStatus = catalog.status;
  const target = settingsScope?.target;
  const members = settingsScope?.scope.members;
  const project =
    members?.find(
      (member) => member.environmentId === target?.environmentId && member.id === target.projectId,
    ) ?? members?.[0];

  const environmentChoices = environments.map((environment) => ({
    environment,
    value: JSON.stringify(["environment", environment.environmentId]),
  }));
  const cloudGroups = environments
    .filter(
      (environment) => environment.serverConfig?.environment.capabilities.cloudVoiceTranscription,
    )
    .map((environment) => ({
      environment,
      choices: CloudSpeechProvider.literals.map((provider) => ({
        environment,
        provider,
        value: JSON.stringify(["cloud", environment.environmentId, provider]),
      })),
    }));
  const cloudChoices = cloudGroups.flatMap((group) => group.choices);
  const destinationValue = destination.device
    ? DEVICE
    : destination.cloudProvider
      ? JSON.stringify(["cloud", destination.environmentId, destination.cloudProvider])
      : destination.environmentId
        ? JSON.stringify(["environment", destination.environmentId])
        : OFF;
  const cloudEnvironment = environments.find(
    (env) => env.environmentId === pendingCloud?.environmentId,
  );
  // OpenRouter users without settings access still manage their own model choice.
  const manageLabel =
    destination.cloudProvider === "openrouter" ? gt("Manage OpenRouter") : gt("Manage key");
  const chosenEnvironment = environments.find(
    (environment) => environment.environmentId === destination.environmentId,
  );
  const chosenUnsupported =
    !destination.cloudProvider &&
    chosenEnvironment?.serverConfig != null &&
    chosenEnvironment.serverConfig.environment.capabilities.voiceTranscription !== true;
  const model = prepared && modelStatus?.supported ? modelStatus : null;

  return (
    <SettingsPageContainer
      searchTargetFallbacks={{
        "speech-language":
          model || destination.cloudProvider || destination.device
            ? undefined
            : "voice-transcription-destination",
        "speech-models": prepared ? undefined : "voice-transcription-destination",
        "speech-hardware": prepared && model ? undefined : "voice-transcription-destination",
        "speech-streaming": prepared && model ? undefined : "voice-transcription-destination",
        "transcription-test": !prepared
          ? "voice-transcription-destination"
          : !model || model.state === "missing-model"
            ? "speech-models"
            : undefined,
        "speech-post-processing-model":
          cleanupEnabled && settingsScope ? undefined : "speech-post-processing",
        "speech-correction-word": cleanupEnabled ? undefined : "speech-post-processing",
      }}
    >
      <DictationInputSettings />

      <SettingsSection id="voice-transcription" title={gt("Transcription")}>
        <SettingsRow
          {...setting("voice-transcription-destination")}
          title={gt("Transcribe with")}
          description={
            destination.environmentId && chosenUnsupported
              ? gt("{label} can’t transcribe audio locally. Choose another destination.", {
                  label: chosenEnvironment.label,
                })
              : gt("Where your speech is turned into text.")
          }
          control={
            <div className="flex w-full min-w-0 items-center gap-1.5 @min-[32rem]/settings-row:w-auto">
              <Select
                value={destinationValue}
                onValueChange={(value) => {
                  if (!value) return;
                  const cloud = cloudChoices.find((choice) => choice.value === value);
                  if (cloud) {
                    setPendingCloud({
                      environmentId: cloud.environment.environmentId,
                      provider: cloud.provider,
                    });
                    return;
                  }
                  setPendingCloud(null);
                  const chosen = environmentChoices.find((choice) => choice.value === value);
                  if (value === OFF) chooseAudioDestination(null);
                  else if (value === DEVICE) chooseAudioDestination({ kind: "device" });
                  else if (chosen)
                    chooseAudioDestination({
                      kind: "environment",
                      environmentId: chosen.environment.environmentId,
                    });
                }}
              >
                <SelectTrigger
                  size="sm"
                  aria-label={gt("Transcribe with")}
                  className="min-w-0 @min-[32rem]/settings-row:w-auto @min-[32rem]/settings-row:max-w-72"
                >
                  <SelectValue>
                    <span className="flex min-w-0 items-center gap-2">
                      {destination.device ? (
                        <LaptopIcon aria-hidden className="size-4" />
                      ) : destination.cloudProvider ? (
                        <CloudSpeechLogo provider={destination.cloudProvider} />
                      ) : destination.environmentId ? (
                        <MonitorIcon aria-hidden className="size-4" />
                      ) : (
                        <MicOffIcon aria-hidden className="size-4" />
                      )}
                      <span className="truncate">
                        {destination.device
                          ? appleSpeechLabel
                          : destination.cloudProvider
                            ? CLOUD_SPEECH_LABELS[destination.cloudProvider]
                            : destination.environmentId
                              ? (chosenEnvironment?.label ?? gt("Chosen environment (unavailable)"))
                              : gt("Off")}
                        {destination.cloudProvider && (
                          <span className="text-muted-foreground">
                            {" via "}
                            {chosenEnvironment?.label ?? gt("unavailable environment")}
                          </span>
                        )}
                      </span>
                    </span>
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  <SelectItem value={OFF}>
                    <span className="flex items-center gap-2">
                      <MicOffIcon aria-hidden className="size-4" />
                      <T>Off</T>
                    </span>
                  </SelectItem>
                  {(appleSpeechAvailable || destination.device) && (
                    <SelectGroup>
                      <SelectGroupLabel>
                        <T>On this Mac</T>
                      </SelectGroupLabel>
                      <SelectItem value={DEVICE}>
                        <span className="flex items-center gap-2">
                          <LaptopIcon aria-hidden className="size-4" />
                          {appleSpeechLabel}
                        </span>
                      </SelectItem>
                    </SelectGroup>
                  )}
                  {environmentChoices.length > 0 && (
                    <SelectGroup>
                      <SelectGroupLabel>
                        <T>On an environment</T>
                      </SelectGroupLabel>
                      {environmentChoices.map(({ environment, value }) => (
                        <SelectItem key={value} value={value}>
                          <span className="flex items-center gap-2">
                            <MonitorIcon aria-hidden className="size-4" />
                            {environment.label}
                          </span>
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  )}
                  {cloudGroups.map(({ environment, choices }) => (
                    <SelectGroup key={environment.environmentId}>
                      <SelectGroupLabel>
                        <T>
                          Cloud via <Var>{environment.label}</Var>
                        </T>
                      </SelectGroupLabel>
                      {choices.map(({ value, provider }) => (
                        <SelectItem
                          key={value}
                          value={value}
                          aria-label={`${CLOUD_SPEECH_LABELS[provider]} via ${environment.label}`}
                        >
                          <span className="flex items-center gap-2">
                            <CloudSpeechLogo provider={provider} />
                            {CLOUD_SPEECH_LABELS[provider]}
                          </span>
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  ))}
                  {destination.environmentId &&
                  (!chosenEnvironment ||
                    (destination.cloudProvider &&
                      !cloudChoices.some((option) => option.value === destinationValue))) ? (
                    <SelectItem value={destinationValue}>
                      <T>Chosen environment (unavailable)</T>
                    </SelectItem>
                  ) : null}
                </SelectPopup>
              </Select>
              {destination.cloudProvider &&
                chosenEnvironment &&
                (canManageKey || destination.cloudProvider === "openrouter") && (
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <Button
                          size="icon-sm"
                          type="button"
                          variant="ghost"
                          aria-label={manageLabel}
                          onClick={() => {
                            if (destination.cloudProvider)
                              setPendingCloud({
                                provider: destination.cloudProvider,
                                environmentId: chosenEnvironment.environmentId,
                              });
                          }}
                        >
                          <KeyRoundIcon aria-hidden className="size-4" />
                        </Button>
                      }
                    />
                    <TooltipPopup>{manageLabel}</TooltipPopup>
                  </Tooltip>
                )}
            </div>
          }
        />
        {pendingCloud && cloudEnvironment && (
          <CloudVoiceConfiguration
            key={JSON.stringify(pendingCloud)}
            provider={pendingCloud.provider}
            environment={cloudEnvironment}
            active={
              destination.environmentId === pendingCloud.environmentId &&
              destination.cloudProvider === pendingCloud.provider
            }
            close={() => setPendingCloud(null)}
          />
        )}
        {(model || destination.cloudProvider || destination.device) && (
          <SettingsRow
            {...setting("speech-language")}
            title={gt("Language")}
            description={
              destination.device
                ? gt(
                    "Automatic uses your Mac’s language. The first use of a language downloads it.",
                  )
                : destination.cloudProvider
                  ? gt("The provider detects your language automatically.")
                  : model?.supportsLanguageDetection
                    ? gt("{model} detects the language automatically.", { model: model.model })
                    : model
                      ? gt("{model} uses one fixed language.", { model: model.model })
                      : gt("This model uses one fixed language.")
            }
            control={
              <SpeechLanguageSelect
                automaticLabel={
                  destination.device
                    ? gt("Auto", { $context: "automatic language detection" })
                    : undefined
                }
                model={
                  destination.device
                    ? { languages: appleSpeechLanguages, supportsLanguageDetection: true }
                    : destination.cloudProvider
                      ? cloudSpeechLanguages
                      : model
                }
              />
            }
          />
        )}
        {model?.supportsTranslation ? (
          <SettingsRow
            title={gt("Translate to English")}
            description={gt("Speak any language and get English text.")}
            control={
              <Switch
                aria-label={gt("Translate to English")}
                checked={settings.speechTranslateToEnglish}
                onCheckedChange={(checked) =>
                  void updateClientSettings({ speechTranslateToEnglish: checked })
                }
              />
            }
          />
        ) : null}
        <SettingsRow
          {...setting("speech-silence-filtering")}
          title={gt("Silence filtering")}
          description={
            destination.device
              ? gt("Apple Speech handles silence itself.")
              : destination.cloudProvider === "openai"
                ? gt("OpenAI handles silence itself.")
                : gt("Skip silence and background noise before transcribing.")
          }
          control={
            <Switch
              aria-label={gt("Silence filtering")}
              disabled={destination.device || destination.cloudProvider === "openai"}
              checked={settings.speechSilenceFiltering}
              onCheckedChange={(checked) =>
                void updateClientSettings({ speechSilenceFiltering: checked })
              }
            />
          }
        />
        <SettingsRow
          {...setting("remove-filler-words")}
          title={gt("Remove filler words")}
          description={
            destination.device
              ? gt("Not available with Apple Speech.")
              : gt("Drop “um” and “uh” from transcripts.")
          }
          control={
            <Switch
              aria-label={gt("Remove filler words")}
              disabled={destination.device}
              checked={settings.speechRemoveFillerWords}
              onCheckedChange={(checked) =>
                void updateClientSettings({ speechRemoveFillerWords: checked })
              }
            />
          }
        />
        {prepared ? (
          <SpeechModelBrowser
            key={prepared.environmentId}
            prepared={prepared}
            catalog={catalog}
            testEnvironmentId={
              project?.environmentId ?? target?.environmentId ?? prepared.environmentId
            }
            projectId={project?.id ?? null}
            projectName={project?.title ?? null}
          />
        ) : null}
        {prepared && <AdvancedSpeechSettings prepared={prepared} catalog={catalog} />}
      </SettingsSection>

      <WordsSettingsSection key={searchTargetId ?? "words"} />

      <SettingsSection id={setting("speech-post-processing").id} title={gt("Cleanup")}>
        <SettingsRow
          title={gt("Clean up transcripts")}
          description={gt(
            "Off by default. Sends the transcript and nearby draft text, never audio, to the cleanup model.",
          )}
          control={
            <Switch
              aria-label={gt("Clean up transcripts")}
              checked={cleanupEnabled}
              onCheckedChange={chooseTranscriptCleanup}
            />
          }
        />
        {cleanupEnabled ? (
          <SettingsRow
            title={gt("Instructions")}
            description={
              settings.speechPostProcessingPrompt.mode === "custom"
                ? gt("Your own instructions for cleanup.")
                : gt("Fix punctuation, numbers, lists, and spoken corrections.")
            }
            control={
              <Select
                value={settings.speechPostProcessingPrompt.mode}
                onValueChange={(value) => {
                  if (value === "default" || value === "custom")
                    void updateClientSettings({
                      speechPostProcessingPrompt: {
                        mode: value,
                        customInstructions:
                          value === "custom" &&
                          !settings.speechPostProcessingPrompt.customInstructions.trim()
                            ? DEFAULT_SPEECH_POST_PROCESSING_PROMPT
                            : settings.speechPostProcessingPrompt.customInstructions,
                      },
                    });
                }}
              >
                <SelectTrigger size="sm" aria-label={gt("Cleanup instructions")}>
                  <SelectValue>
                    {settings.speechPostProcessingPrompt.mode === "custom"
                      ? gt("Custom")
                      : gt("Built-in")}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  <SelectItem value="default">
                    <T>Built-in</T>
                  </SelectItem>
                  <SelectItem value="custom">
                    <T>Custom</T>
                  </SelectItem>
                </SelectPopup>
              </Select>
            }
          >
            {settings.speechPostProcessingPrompt.mode === "custom" ? (
              <div className="mt-3 pb-2">
                <Textarea
                  aria-label={gt("Custom cleanup instructions")}
                  maxLength={10_000}
                  value={settings.speechPostProcessingPrompt.customInstructions}
                  onChange={(event) =>
                    void updateClientSettings({
                      speechPostProcessingPrompt: {
                        mode: "custom",
                        customInstructions: event.target.value,
                      },
                    })
                  }
                />
              </div>
            ) : null}
          </SettingsRow>
        ) : null}
        {cleanupEnabled && settingsScope !== null ? <CleanupModelRow /> : null}
        {cleanupEnabled ? (
          <SettingsRow
            {...setting("speech-correction-word")}
            title={gt("Correction cue")}
            description={gt("The phrase you say to fix a mistake, like “scratch that”.")}
            control={
              <Input
                key={settings.speechCorrectionWord}
                defaultValue={settings.speechCorrectionWord}
                maxLength={50}
                placeholder="sorry"
                aria-label={gt("Correction cue")}
                className="@min-[32rem]/settings-row:w-40"
                onBlur={(event) => {
                  const next = event.target.value.trim();
                  if (next !== settings.speechCorrectionWord)
                    void updateClientSettings({ speechCorrectionWord: next });
                }}
              />
            }
          />
        ) : null}
      </SettingsSection>
    </SettingsPageContainer>
  );
}
