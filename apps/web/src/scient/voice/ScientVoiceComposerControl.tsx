// Thin composer presentation for Scient-owned local voice dictation.
import { T, useGT, Var } from "gt-react";
// Async lifecycle and stale-operation protection live in the controller hook;
// this component only renders the current state into one explicit footer slot.

import { memo, type ReactNode, useEffect } from "react";
import {
  ArrowUpIcon,
  CircleAlertIcon,
  CornerDownLeftIcon,
  DownloadIcon,
  Loader2Icon,
  MicIcon,
  SlidersHorizontalIcon,
  XIcon,
} from "lucide-react";
import { Link } from "@tanstack/react-router";
import type { EnvironmentId, VoiceModelId, VoiceModelsSnapshot } from "@t3tools/contracts";

import { ComposerControl, ComposerControlIcon } from "../../components/chat/ComposerControl.tsx";
import { Badge } from "../../components/ui/badge.tsx";
import { Button, InlineButton } from "../../components/ui/button.tsx";
import { Popover, PopoverPopup, PopoverTrigger } from "../../components/ui/popover.tsx";
import {
  Tooltip,
  TooltipPopup,
  TooltipProvider,
  TooltipTrigger,
} from "../../components/ui/tooltip.tsx";
import { cn } from "../../lib/utils.ts";
import { updateClientSettings, useClientSettings } from "../../hooks/useSettings.ts";
import { useAtomCommand } from "../../state/use-atom-command.ts";
import { buildVoiceWaveformLevels, VOICE_WAVEFORM_LEVEL_COUNT } from "./voiceWaveform.ts";
import { getVoiceBridge } from "./voiceClient.ts";
import { useChatGptDictation } from "./chatGptDictation.ts";
import { formatVoiceTimer, useScientVoiceController } from "./useScientVoiceController.ts";
import {
  makeVoiceTranscriptCorrectionClient,
  voiceTranscriptCorrectionCommand,
} from "./voiceTranscriptCorrectionClient.ts";
import { hasReadySelectedVoiceModel } from "./voiceModelReadiness.ts";
import type { VoiceDraftOrigin } from "./voiceDraftDelivery.ts";

export interface ScientVoiceComposerControlProps {
  readonly disabled?: boolean;
  readonly environmentId?: EnvironmentId;
  /** Composer draft that committed dictation lands in, even after leaving. */
  readonly draftOrigin?: VoiceDraftOrigin | null;
  /** Field that local (non-draft) dictation belongs to; see the controller. */
  readonly localFieldKey?: string | null;
  readonly onBusyChange?: (busy: boolean) => void;
  readonly onTranscript: (text: string) => void;
  readonly onRequestSubmit?: () => void;
  readonly className?: string;
  readonly ariaLabel?: string;
  readonly presentation?: "composer" | "compact";
  readonly readyModelOnly?: boolean;
}

function formatModelSize(byteSize: number): string {
  // oxlint-disable-next-line t3code/no-untranslated-copy -- a size with its unit symbol
  return `~${Math.round(byteSize / 1024 / 1024)} MiB`;
}

function barHeight(level: number): number {
  return Math.max(3, Math.min(26, Math.round(level * 110)));
}

const WAVEFORM_BAR_KEYS = Array.from(
  { length: VOICE_WAVEFORM_LEVEL_COUNT },
  (_, index) => `scient-voice-waveform-${index}`,
);

const VoiceWaveform = memo(function VoiceWaveform({
  levels,
}: {
  readonly levels: readonly number[];
}): ReactNode {
  return (
    <div
      data-scient-voice-waveform="true"
      dir="ltr"
      className="flex h-7 min-w-0 flex-1 items-center justify-end overflow-hidden"
      aria-hidden="true"
    >
      <div className="flex min-w-full shrink-0 items-center gap-0.5">
        {buildVoiceWaveformLevels(levels).map((level, index) => (
          <span
            key={WAVEFORM_BAR_KEYS[index]}
            className="w-0.5 shrink-0 rounded-full bg-primary/60"
            style={{ height: barHeight(level) }}
          />
        ))}
      </div>
    </div>
  );
});

function VoiceErrorText({
  message,
  onOpenSettings,
}: {
  readonly message: string;
  readonly onOpenSettings?: () => void;
}): ReactNode {
  return (
    <TooltipProvider delay={40} closeDelay={0} timeout={300}>
      <div
        className="flex min-w-0 max-w-36 items-center gap-1 text-destructive/80 text-xs sm:max-w-48"
        role="alert"
      >
        <CircleAlertIcon aria-hidden="true" className="size-3.5 shrink-0" />
        <Tooltip>
          <TooltipTrigger render={<span className="min-w-0 truncate" />}>{message}</TooltipTrigger>
          <TooltipPopup>{message}</TooltipPopup>
        </Tooltip>
        {onOpenSettings ? (
          <InlineButton tone="destructive" onClick={onOpenSettings} type="button">
            <T>Open Settings</T>
          </InlineButton>
        ) : null}
      </div>
    </TooltipProvider>
  );
}

interface VoiceModelSetupPickerProps {
  readonly disabled: boolean;
  readonly snapshot: VoiceModelsSnapshot | null;
  readonly onSelect: (modelId: VoiceModelId) => void;
  /** Offers ChatGPT first, through a provider's ChatGPT sign-in. */
  readonly onChooseChatGpt?: (() => void) | undefined;
}

const SETUP_OPTION_CLASS_NAME =
  "group flex w-full items-start gap-2.5 rounded-md px-2.5 py-2 text-left outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring";
const SETUP_OPTION_ICON_CLASS_NAME =
  "mt-0.5 size-3.5 shrink-0 text-muted-foreground transition-colors group-hover:text-foreground group-focus-visible:text-foreground";

function VoiceModelSetupPicker({
  disabled,
  snapshot,
  onSelect,
  onChooseChatGpt,
}: VoiceModelSetupPickerProps): ReactNode {
  // Models this computer cannot run are not offered; ChatGPT may still be.
  const models = snapshot?.runtimeAvailable ? snapshot.models : [];
  const recommendedModelId = snapshot?.recommendation?.modelId ?? null;

  return (
    // The microphone was just pressed: the choices open at once.
    <Popover defaultOpen>
      <PopoverTrigger
        render={
          <ComposerControl disabled={disabled || (models.length === 0 && !onChooseChatGpt)} />
        }
      >
        <ComposerControlIcon icon={MicIcon} />
        <T>Choose voice model</T>
      </PopoverTrigger>
      <PopoverPopup
        align="end"
        className="w-[min(20rem,calc(100vw-1rem))]"
        padding="none"
        side="top"
        sideOffset={8}
      >
        <div className="space-y-1 p-2">
          {onChooseChatGpt ? (
            <button
              className={SETUP_OPTION_CLASS_NAME}
              disabled={disabled}
              onClick={onChooseChatGpt}
              type="button"
            >
              <span className="min-w-0 flex-1 space-y-0.5">
                <span className="flex flex-wrap items-center gap-1.5">
                  <span className="font-medium text-sm">ChatGPT</span>
                  <Badge size="sm" variant="info">
                    <T>Nothing to download</T>
                  </Badge>
                </span>
                <span className="block text-muted-foreground text-xs leading-4">
                  <T>
                    Uses your ChatGPT sign-in. Recordings go to OpenAI, which keeps them for 30
                    days.
                  </T>
                </span>
              </span>
              <MicIcon className={SETUP_OPTION_ICON_CLASS_NAME} />
            </button>
          ) : null}
          {onChooseChatGpt && models.length > 0 ? (
            <p className="px-2.5 pt-1.5 text-muted-foreground text-xs">
              <T>Or keep recordings on this computer</T>
            </p>
          ) : null}
          {models.map((model) => {
            const recommended = model.id === recommendedModelId;
            const downloaded = model.state.state === "ready";
            return (
              <button
                key={model.id}
                className={SETUP_OPTION_CLASS_NAME}
                disabled={disabled}
                onClick={() => onSelect(model.id)}
                type="button"
              >
                <span className="min-w-0 flex-1 space-y-0.5">
                  <span className="flex flex-wrap items-center gap-1.5">
                    <span className="font-medium text-sm">{model.displayName}</span>
                    {recommended ? (
                      <Badge size="sm" variant="info">
                        <T>Best for this computer</T>
                      </Badge>
                    ) : null}
                  </span>
                  <span className="block text-muted-foreground text-xs leading-4">
                    {model.description} ·{" "}
                    {downloaded ? <T>On this computer</T> : formatModelSize(model.byteSize)}
                  </span>
                </span>
                {downloaded ? (
                  <MicIcon className={SETUP_OPTION_ICON_CLASS_NAME} />
                ) : (
                  <DownloadIcon className={SETUP_OPTION_ICON_CLASS_NAME} />
                )}
              </button>
            );
          })}
        </div>
        {/* Inset like the options above, so its hover never touches the popup's corner. */}
        <div className="px-2 pb-2">
          <Button
            className="justify-start"
            render={<Link to="/settings/voice" />}
            size="compact"
            variant="ghost-muted"
          >
            <SlidersHorizontalIcon className="text-current" />
            <T context="verb, manage voice models">Manage</T>
          </Button>
        </div>
      </PopoverPopup>
    </Popover>
  );
}

export function ScientVoiceComposerControl({
  disabled = false,
  environmentId,
  draftOrigin = null,
  localFieldKey = null,
  onTranscript,
  onBusyChange,
  onRequestSubmit,
  className,
  ariaLabel,
  presentation = "composer",
  readyModelOnly = false,
}: ScientVoiceComposerControlProps): ReactNode {
  const gt = useGT();
  const client = getVoiceBridge();
  const correctionEnabled = useClientSettings(
    (settings) => settings.voiceTranscriptCorrectionEnabled,
  );
  const languagePreference = useClientSettings((settings) => settings.voiceLanguagePreference);
  const engine = useClientSettings((settings) => settings.voiceDictationEngine);
  const chatGpt = useChatGptDictation(environmentId);
  const runVoiceTranscriptCorrection = useAtomCommand(voiceTranscriptCorrectionCommand, {
    reportFailure: false,
  });
  const correctionClient = makeVoiceTranscriptCorrectionClient(runVoiceTranscriptCorrection);
  const controller = useScientVoiceController({
    client,
    correctionClient,
    correctionEnabled,
    languagePreference,
    engine,
    chatGpt: chatGpt.transcriber,
    chatGptUnavailableMessage: chatGpt.unavailableMessage,
    onEngineChosen: (chosen) => void updateClientSettings({ voiceDictationEngine: chosen }),
    ...(environmentId === undefined ? {} : { environmentId }),
    draftOrigin,
    localFieldKey,
    onTranscript,
    ...(onRequestSubmit ? { onRequestSubmit } : {}),
  });
  const desktopBridge = typeof window === "undefined" ? undefined : window.desktopBridge;
  const canOpenMicrophoneSettings =
    controller.microphonePermissionDenied &&
    desktopBridge?.getClientPlatform?.() === "darwin" &&
    desktopBridge.openSystemSettings !== undefined;

  const busy =
    controller.phase === "requesting-permission" ||
    controller.phase === "recording" ||
    controller.phase === "transcribing" ||
    controller.phase === "correcting";
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reports recording busy state to the parent callback
  useEffect(() => {
    onBusyChange?.(busy);
  }, [busy, onBusyChange]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reports busy=false to the parent callback on unmount
  useEffect(() => () => onBusyChange?.(false), [onBusyChange]);

  // A surface that offers dictation only when it is ready hides it while its engine is not.
  const readyModelBecameUnavailable =
    readyModelOnly &&
    engine !== "chatgpt" &&
    (controller.phase === "setup-prompt" ||
      (controller.modelSnapshot !== null &&
        !hasReadySelectedVoiceModel(controller.modelSnapshot)) ||
      (controller.modelSnapshot === null && controller.errorMessage !== null));
  if (!client || readyModelBecameUnavailable) return null;

  const actionsClassName = cn(
    "flex shrink-0 items-center justify-end gap-2",
    presentation === "composer" ? "w-28 sm:w-25" : "w-24",
  );
  const recordingSurface = busy ? (
    <div
      data-scient-voice-surface="true"
      className="flex min-h-8 w-full min-w-0 items-center gap-2"
    >
      <div data-scient-voice-center="true" className="flex min-w-0 flex-1 justify-center">
        <div
          data-scient-voice-content="true"
          className="flex w-full min-w-0 max-w-[calc(--spacing(0.5)*267)] items-center gap-2"
        >
          {controller.phase === "recording" ? (
            <>
              <span aria-hidden="true" className="flex w-9 shrink-0 justify-end">
                <span className="size-2 rounded-full bg-destructive" />
              </span>
              <VoiceWaveform levels={controller.levels} />
              <span dir="ltr" className="w-9 shrink-0 text-muted-foreground text-xs tabular-nums">
                {formatVoiceTimer(controller.elapsedMs)}
              </span>
              <span className="sr-only" role="status">
                <T context="voice recording in progress">Recording</T>
              </span>
            </>
          ) : (
            <>
              <span aria-hidden="true" className="flex w-9 shrink-0 justify-end">
                <Loader2Icon className="size-4 animate-spin" />
              </span>
              <span
                data-scient-voice-status="true"
                className="min-w-0 flex-1 text-start font-(family-name:--font-composer,var(--font-sans)) text-sm font-normal text-placeholder/75"
                role="status"
              >
                {controller.phase === "requesting-permission"
                  ? gt("Waiting for microphone access…")
                  : controller.phase === "transcribing"
                    ? gt("Transcribing…")
                    : gt("Correcting transcript…")}
              </span>
              <span aria-hidden="true" className="w-9 shrink-0" />
            </>
          )}
        </div>
      </div>
      {controller.phase === "recording" ? (
        <TooltipProvider delay={40} closeDelay={0} timeout={300}>
          <div data-scient-voice-actions="true" className={actionsClassName}>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    aria-label={gt("Cancel recording (Esc)")}
                    onClick={() => void controller.cancel()}
                    size="icon-sm"
                    variant="ghost"
                  />
                }
              >
                <XIcon />
              </TooltipTrigger>
              <TooltipPopup>
                <T>Cancel recording (Esc)</T>
              </TooltipPopup>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    aria-label={gt("Transcribe and insert (Enter)")}
                    onClick={() => void controller.stop(false)}
                    size="icon-sm"
                    variant="ghost"
                  />
                }
              >
                <CornerDownLeftIcon />
              </TooltipTrigger>
              <TooltipPopup>
                <T>Transcribe and insert (Enter)</T>
              </TooltipPopup>
            </Tooltip>
            {onRequestSubmit ? (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      aria-label={gt("Transcribe and send")}
                      onClick={() => void controller.stop(true)}
                      size="icon-sm"
                      variant="round-primary"
                    />
                  }
                >
                  <ArrowUpIcon />
                </TooltipTrigger>
                <TooltipPopup>
                  <T>Transcribe and send</T>
                </TooltipPopup>
              </Tooltip>
            ) : null}
          </div>
        </TooltipProvider>
      ) : (
        <div data-scient-voice-actions="true" className={actionsClassName}>
          {controller.phase === "correcting" ? (
            <Button onClick={controller.useOriginal} size="xs" variant="ghost-muted">
              <T>Use original</T>
            </Button>
          ) : (
            <Button
              aria-label={
                controller.phase === "requesting-permission"
                  ? gt("Cancel microphone request")
                  : gt("Cancel transcription")
              }
              onClick={() => void controller.cancel()}
              size="icon-sm"
              variant="ghost"
            >
              <XIcon />
            </Button>
          )}
        </div>
      )}
    </div>
  ) : null;

  return (
    <div
      data-scient-voice-control="true"
      className={cn("flex min-w-0 items-center gap-2", className)}
    >
      {busy ? (
        recordingSurface
      ) : controller.phase === "setup-prompt" ? (
        <div className="flex min-w-0 items-center gap-1.5">
          <VoiceModelSetupPicker
            disabled={disabled}
            onSelect={(modelId) => void controller.setupModel(modelId)}
            snapshot={controller.modelSnapshot}
            onChooseChatGpt={
              controller.chatGptOffered ? () => void controller.chooseChatGpt() : undefined
            }
          />
          <Button
            aria-label={gt("Dismiss voice setup")}
            onClick={controller.dismissSetup}
            size="icon-sm"
            variant="ghost"
          >
            <XIcon />
          </Button>
        </div>
      ) : controller.phase === "downloading" ? (
        <div className="flex items-center gap-2">
          <div aria-live="polite" className="flex items-center gap-2" role="status">
            <Loader2Icon aria-hidden="true" className="size-4 shrink-0 animate-spin" />
            <span className="text-muted-foreground text-xs">
              <T>
                Downloading voice model… <Var>{controller.downloadPercent}</Var>%
              </T>
            </span>
          </div>
          <TooltipProvider delay={40} closeDelay={0} timeout={300}>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    aria-label={gt("Cancel voice setup")}
                    onClick={() => void controller.cancel()}
                    size="icon-sm"
                    variant="ghost"
                  />
                }
              >
                <XIcon />
              </TooltipTrigger>
              <TooltipPopup>
                <T>Cancel voice setup</T>
              </TooltipPopup>
            </Tooltip>
          </TooltipProvider>
        </div>
      ) : (
        <>
          <ComposerControl
            aria-label={ariaLabel ?? gt("Dictate a voice message")}
            disabled={disabled || controller.phase !== "idle"}
            onPointerDown={(event) => event.preventDefault()}
            onClick={() => void controller.activate()}
          >
            <ComposerControlIcon icon={MicIcon} />
          </ComposerControl>
          {controller.errorMessage ? (
            <VoiceErrorText
              message={controller.errorMessage}
              {...(canOpenMicrophoneSettings
                ? {
                    onOpenSettings: () => void desktopBridge.openSystemSettings?.("microphone"),
                  }
                : {})}
            />
          ) : null}
        </>
      )}
    </div>
  );
}
