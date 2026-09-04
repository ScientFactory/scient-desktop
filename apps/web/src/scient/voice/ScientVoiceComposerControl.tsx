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
import { Button } from "../../components/ui/button.tsx";
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
import { VOICE_WAVEFORM_LEVEL_COUNT } from "./useVoiceRecorder.ts";
import { getVoiceBridge } from "./voiceClient.ts";
import { formatVoiceTimer, useScientVoiceController } from "./useScientVoiceController.ts";
import {
  makeVoiceTranscriptCorrectionClient,
  voiceTranscriptCorrectionCommand,
} from "./voiceTranscriptCorrectionClient.ts";

export { describeVoiceError } from "./voiceErrorPresentation.ts";
export { describeVoiceRecorderError, formatVoiceTimer } from "./useScientVoiceController.ts";

export interface ScientVoiceComposerControlProps {
  readonly disabled?: boolean;
  readonly environmentId?: EnvironmentId;
  readonly onBusyChange?: (busy: boolean) => void;
  readonly onTranscript: (text: string) => void;
  readonly onRequestSubmit?: () => void;
  readonly className?: string;
}

export const EMPTY_TRANSCRIPT_MESSAGE = "No speech detected";

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
      className="flex h-7 min-w-0 shrink items-center gap-0.5 overflow-hidden"
      aria-hidden="true"
    >
      {levels.map((level, index) => (
        <span
          key={WAVEFORM_BAR_KEYS[index]}
          className="w-0.5 shrink-0 rounded-full bg-primary/60"
          style={{ height: barHeight(level) }}
        />
      ))}
    </div>
  );
});

function VoiceErrorText({ message }: { readonly message: string }): ReactNode {
  return (
    <span className="flex items-center gap-1 text-destructive text-xs" role="alert">
      <CircleAlertIcon aria-hidden="true" className="size-3.5 shrink-0" />
      {message}
    </span>
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
        side="top"
        sideOffset={8}
        viewportClassName="space-y-1 p-2 [--viewport-inline-padding:--spacing(2)]"
      >
        <div className="space-y-1">
          {models.map((model) => {
            const recommended = model.id === recommendedModelId;
            return (
              <button
                key={model.id}
                className="group flex w-full items-start gap-2.5 rounded-md px-2.5 py-2 text-left outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
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
          className="h-auto justify-start gap-1.5 px-2 py-1"
          render={<Link to="/settings/voice" />}
          size="xs"
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
  onTranscript,
  onBusyChange,
  onRequestSubmit,
  className,
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
    onTranscript,
    ...(onRequestSubmit ? { onRequestSubmit } : {}),
  });

  useEffect(() => {
    onBusyChange?.(
      controller.phase === "requesting-permission" ||
        controller.phase === "recording" ||
        controller.phase === "transcribing" ||
        controller.phase === "correcting",
    );
  }, [controller.phase, onBusyChange]);

  if (!client) return null;

  const recordingSurface =
    controller.phase === "requesting-permission" ||
    controller.phase === "recording" ||
    controller.phase === "transcribing" ||
    controller.phase === "correcting" ? (
      <div className="absolute inset-0 z-10 flex items-center gap-2 bg-background px-3 pb-3 sm:px-4 sm:pb-4">
        {controller.phase === "recording" ? (
          <>
            <div className="flex min-w-0 flex-1 items-center gap-2">
              <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-destructive" />
              <VoiceWaveform levels={controller.levels} />
              <span className="shrink-0 text-muted-foreground text-xs tabular-nums">
                {formatVoiceTimer(controller.elapsedMs)}
              </span>
              <span className="sr-only" role="status">
                Recording
              </span>
            </div>
            <TooltipProvider delay={40} closeDelay={0} timeout={300}>
              <div className="ml-auto flex shrink-0 items-center gap-2">
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
                          className="rounded-full bg-primary text-primary-foreground hover:bg-primary/90"
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
          </>
        ) : (
          <>
            <Loader2Icon aria-hidden="true" className="size-4 shrink-0 animate-spin" />
            <span className="min-w-0 flex-1 text-muted-foreground text-xs" role="status">
              {controller.phase === "requesting-permission"
                ? "Waiting for microphone access…"
                : controller.phase === "transcribing"
                  ? "Transcribing…"
                  : "Correcting transcript…"}
            </span>
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
          </>
        )}
      </div>
    ) : null;

  return (
    <div className={cn("flex items-center gap-2", className)}>
      {controller.phase === "setup-prompt" ? (
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
            aria-label="Dictate a voice message"
            disabled={disabled || controller.phase !== "idle"}
            onClick={() => void controller.activate()}
          >
            <ComposerControlIcon icon={MicIcon} />
          </ComposerControl>
          {controller.errorMessage ? <VoiceErrorText message={controller.errorMessage} /> : null}
        </>
      )}
      {recordingSurface}
    </div>
  );
}
