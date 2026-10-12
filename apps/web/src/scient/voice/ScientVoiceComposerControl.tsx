// Thin composer presentation for Scient-owned local voice dictation.
// Async lifecycle and stale-operation protection live in the controller hook;
// this component only renders the current state into one explicit footer slot.

import { memo, type ReactNode, useMemo, useEffect } from "react";
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

import {
  ComposerControl,
  ComposerControlChevron,
  ComposerControlIcon,
} from "../../components/chat/ComposerControl.tsx";
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
import { useClientSettings } from "../../hooks/useSettings.ts";
import { useAtomCommand } from "../../state/use-atom-command.ts";
import { buildVoiceWaveformLevels, VOICE_WAVEFORM_LEVEL_COUNT } from "./voiceWaveform.ts";
import { getVoiceBridge } from "./voiceClient.ts";
import { formatVoiceTimer, useScientVoiceController } from "./useScientVoiceController.ts";
import {
  makeVoiceTranscriptCorrectionClient,
  voiceTranscriptCorrectionCommand,
} from "./voiceTranscriptCorrectionClient.ts";
import { hasReadySelectedVoiceModel } from "./voiceModelReadiness.ts";
import type { VoiceDraftOrigin } from "./voiceDraftDelivery.ts";

export { describeVoiceError } from "./voiceErrorPresentation.ts";
export { describeVoiceRecorderError, formatVoiceTimer } from "./useScientVoiceController.ts";

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

export { EMPTY_TRANSCRIPT_MESSAGE } from "./voiceProcessing.ts";

function formatModelSize(byteSize: number): string {
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
            Open Settings
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
}

export function VoiceModelSetupPicker({
  disabled,
  snapshot,
  onSelect,
}: VoiceModelSetupPickerProps): ReactNode {
  const models = snapshot?.models ?? [];
  const recommendedModelId = snapshot?.recommendation?.modelId ?? null;

  return (
    <Popover>
      <PopoverTrigger render={<ComposerControl disabled={disabled || models.length === 0} />}>
        <ComposerControlIcon icon={MicIcon} />
        Choose voice model
        <ComposerControlChevron />
      </PopoverTrigger>
      <PopoverPopup
        align="end"
        className="w-[min(20rem,calc(100vw-1rem))]"
        padding="none"
        side="top"
        sideOffset={8}
      >
        <div className="space-y-1 p-2">
          {models.map((model) => {
            const recommended = model.id === recommendedModelId;
            return (
              <button
                key={model.id}
                className="group flex w-full items-start gap-2.5 rounded-md px-2.5 py-2 text-left outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                disabled={disabled}
                onClick={() => onSelect(model.id)}
                type="button"
              >
                <span className="min-w-0 flex-1 space-y-0.5">
                  <span className="flex flex-wrap items-center gap-1.5">
                    <span className="font-medium text-sm">{model.displayName}</span>
                    {recommended ? (
                      <Badge size="sm" variant="info">
                        Best for this computer
                      </Badge>
                    ) : null}
                  </span>
                  <span className="block text-muted-foreground text-xs leading-4">
                    {model.description} · {formatModelSize(model.byteSize)}
                  </span>
                </span>
                <DownloadIcon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground transition-colors group-hover:text-foreground group-focus-visible:text-foreground" />
              </button>
            );
          })}
        </div>
        <Button
          className="justify-start"
          render={<Link to="/settings/voice" />}
          size="compact"
          variant="ghost-muted"
        >
          <SlidersHorizontalIcon className="text-current" />
          Manage
        </Button>
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
  ariaLabel = "Dictate a voice message",
  presentation = "composer",
  readyModelOnly = false,
}: ScientVoiceComposerControlProps): ReactNode {
  const client = useMemo(() => getVoiceBridge(), []);
  const correctionEnabled = useClientSettings(
    (settings) => settings.voiceTranscriptCorrectionEnabled,
  );
  const languagePreference = useClientSettings((settings) => settings.voiceLanguagePreference);
  const runVoiceTranscriptCorrection = useAtomCommand(voiceTranscriptCorrectionCommand, {
    reportFailure: false,
  });
  const correctionClient = useMemo(
    () => makeVoiceTranscriptCorrectionClient(runVoiceTranscriptCorrection),
    [runVoiceTranscriptCorrection],
  );
  const controller = useScientVoiceController({
    client,
    correctionClient,
    correctionEnabled,
    languagePreference,
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
  useEffect(() => {
    onBusyChange?.(busy);
  }, [busy, onBusyChange]);
  useEffect(() => () => onBusyChange?.(false), [onBusyChange]);

  const readyModelBecameUnavailable =
    readyModelOnly &&
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
                Recording
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
                  ? "Waiting for microphone access…"
                  : controller.phase === "transcribing"
                    ? "Transcribing…"
                    : "Correcting transcript…"}
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
                    aria-label="Cancel recording (Esc)"
                    onClick={() => void controller.cancel()}
                    size="icon-sm"
                    variant="ghost"
                  />
                }
              >
                <XIcon />
              </TooltipTrigger>
              <TooltipPopup>Cancel recording (Esc)</TooltipPopup>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    aria-label="Transcribe and insert (Enter)"
                    onClick={() => void controller.stop(false)}
                    size="icon-sm"
                    variant="ghost"
                  />
                }
              >
                <CornerDownLeftIcon />
              </TooltipTrigger>
              <TooltipPopup>Transcribe and insert (Enter)</TooltipPopup>
            </Tooltip>
            {onRequestSubmit ? (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      aria-label="Transcribe and send"
                      onClick={() => void controller.stop(true)}
                      size="icon-sm"
                      variant="round-primary"
                    />
                  }
                >
                  <ArrowUpIcon />
                </TooltipTrigger>
                <TooltipPopup>Transcribe and send</TooltipPopup>
              </Tooltip>
            ) : null}
          </div>
        </TooltipProvider>
      ) : (
        <div data-scient-voice-actions="true" className={actionsClassName}>
          {controller.phase === "correcting" ? (
            <Button onClick={controller.useOriginal} size="xs" variant="ghost-muted">
              Use original
            </Button>
          ) : (
            <Button
              aria-label={
                controller.phase === "requesting-permission"
                  ? "Cancel microphone request"
                  : "Cancel transcription"
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
          />
          <Button
            aria-label="Dismiss voice setup"
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
              Downloading voice model… {controller.downloadPercent}%
            </span>
          </div>
          <TooltipProvider delay={40} closeDelay={0} timeout={300}>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    aria-label="Cancel voice setup"
                    onClick={() => void controller.cancel()}
                    size="icon-sm"
                    variant="ghost"
                  />
                }
              >
                <XIcon />
              </TooltipTrigger>
              <TooltipPopup>Cancel voice setup</TooltipPopup>
            </Tooltip>
          </TooltipProvider>
        </div>
      ) : (
        <>
          <ComposerControl
            aria-label={ariaLabel}
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
