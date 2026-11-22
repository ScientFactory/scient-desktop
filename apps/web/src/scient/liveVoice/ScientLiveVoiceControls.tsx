import type { LiveVoicePhase } from "@t3tools/contracts";
import { msg, T, useGT, useMessages } from "gt-react";
import { AudioLinesIcon, CircleAlertIcon, MicIcon, MicOffIcon, PhoneOffIcon } from "lucide-react";

import { ComposerBanner } from "../../components/chat/ComposerBanner.tsx";
import { ComposerControl, ComposerControlIcon } from "../../components/chat/ComposerControl.tsx";
import { Button } from "../../components/ui/button.tsx";
import {
  Tooltip,
  TooltipPopup,
  TooltipProvider,
  TooltipTrigger,
} from "../../components/ui/tooltip.tsx";
import { cn } from "../../lib/utils.ts";
import type { VoiceDraftOrigin } from "../voice/voiceDraftDelivery.ts";
import type { ScientLiveVoiceCall } from "./useScientLiveVoiceCall.ts";

const PHASE_LABELS: Record<LiveVoicePhase, string> = {
  connecting: msg("Connecting…"),
  listening: msg("Listening", { $context: "voice call status" }),
  working: msg("Working on it"),
  speaking: msg("Speaking", { $context: "voice call status" }),
  muted: msg("Muted", { $context: "voice call status" }),
  error: msg("Connection problem"),
};

/** Starts a voice call; `unavailableReason` says why it can't, in its tooltip. */
export function ScientLiveVoiceButton({
  call,
  unavailableReason,
  draftOrigin = null,
}: {
  readonly call: ScientLiveVoiceCall;
  readonly unavailableReason: string | null;
  /** Where the first spoken request goes while the conversation does not exist yet. */
  readonly draftOrigin?: VoiceDraftOrigin | null;
}) {
  const gt = useGT();
  if (call.state.status !== "idle" && call.state.status !== "failed") return null;
  const label = unavailableReason ?? gt("Talk with Scient Agent");
  return (
    <TooltipProvider delay={40} closeDelay={0} timeout={300}>
      <Tooltip>
        <TooltipTrigger
          render={
            <ComposerControl
              aria-label={label}
              aria-disabled={unavailableReason !== null || undefined}
              onPointerDown={(event) => event.preventDefault()}
              onClick={() => {
                if (unavailableReason === null) void call.start(draftOrigin);
              }}
              className={cn(unavailableReason !== null && "opacity-64")}
            />
          }
        >
          <ComposerControlIcon icon={AudioLinesIcon} />
        </TooltipTrigger>
        <TooltipPopup>{label}</TooltipPopup>
      </Tooltip>
    </TooltipProvider>
  );
}

const LEVEL_BARS = [
  { id: "outer-start", weight: 0.55 },
  { id: "inner-start", weight: 0.85 },
  { id: "middle", weight: 1 },
  { id: "inner-end", weight: 0.85 },
  { id: "outer-end", weight: 0.55 },
] as const;

function LevelBars({ level, className }: { readonly level: number; readonly className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn("flex h-3.5 w-4 shrink-0 items-center justify-between", className)}
    >
      {LEVEL_BARS.map(({ id, weight }) => (
        <span
          key={id}
          className="w-0.5 rounded-full bg-current transition-[height] duration-100"
          style={{ height: `${Math.round(25 + Math.min(1, level * weight) * 75)}%` }}
        />
      ))}
    </span>
  );
}

/** What the call shows now: its phase, the loudness to draw, and the latest spoken line. */
function callView(call: ScientLiveVoiceCall) {
  const { state } = call;
  const phase: LiveVoicePhase = state.status === "active" ? state.phase : "connecting";
  const muted = state.status === "active" && state.muted;
  const level = phase === "speaking" ? call.levels.output : muted ? 0 : call.levels.input;
  const line = state.status === "active" ? state.line : null;
  const caption = line ? `${line.role === "user" ? "You" : "Scient Agent"}: ${line.text}` : null;
  return { phase, muted, level, caption, active: state.status === "active" };
}

function MuteButton({ call }: { readonly call: ScientLiveVoiceCall }) {
  const gt = useGT();
  const { muted, active } = callView(call);
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            aria-label={muted ? gt("Unmute") : gt("Mute")}
            aria-pressed={muted}
            disabled={!active}
            onClick={() => call.setMuted(!muted)}
            size="icon-sm"
            variant="ghost"
          />
        }
      >
        {muted ? <MicOffIcon /> : <MicIcon />}
      </TooltipTrigger>
      <TooltipPopup>{muted ? gt("Unmute") : gt("Mute")}</TooltipPopup>
    </Tooltip>
  );
}

function FailureBanner({ call }: { readonly call: ScientLiveVoiceCall }) {
  const gt = useGT();
  if (call.state.status !== "failed") return null;
  return (
    <ComposerBanner.Root variant="error" detached role="alert">
      <ComposerBanner.Row>
        <ComposerBanner.Icon>
          <CircleAlertIcon />
        </ComposerBanner.Icon>
        <ComposerBanner.Content className="text-foreground">
          {call.state.message}
        </ComposerBanner.Content>
        <ComposerBanner.Actions>
          <ComposerBanner.Dismiss aria-label={gt("Dismiss")} onClick={call.dismiss} />
        </ComposerBanner.Actions>
      </ComposerBanner.Row>
    </ComposerBanner.Root>
  );
}

/** The call in progress, as a small card over the composer's top-right corner. */
export function ScientLiveVoiceCard({ call }: { readonly call: ScientLiveVoiceCall }) {
  const gt = useGT();
  const m = useMessages();
  if (call.state.status === "idle") return null;
  if (call.state.status === "failed") {
    return (
      <div className="absolute end-0 bottom-full z-10 mb-2 w-[min(22rem,100%)]">
        <FailureBanner call={call} />
      </div>
    );
  }
  const { phase, level, caption } = callView(call);
  return (
    <div
      aria-label={gt("Voice call")}
      className="absolute end-0 bottom-full z-10 mb-2 w-[min(20rem,100%)]"
    >
      <ComposerBanner.Root detached density="spacious">
        <div className="flex items-center gap-3">
          <span
            aria-hidden="true"
            className="relative flex size-9 shrink-0 items-center justify-center rounded-full bg-primary/12 text-primary"
          >
            <span
              className="absolute inset-0 rounded-full bg-primary/20 transition-transform duration-100"
              style={{ transform: `scale(${1 + level * 0.35})` }}
            />
            <LevelBars level={level} className="relative" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-muted-foreground text-xs">
              <T>Voice call</T>
            </span>
            <span role="status" className="block font-medium text-foreground text-sm">
              {m(PHASE_LABELS[phase])}
            </span>
          </span>
          <TooltipProvider delay={40} closeDelay={0} timeout={300}>
            <MuteButton call={call} />
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    aria-label={gt("End call")}
                    onClick={call.hangUp}
                    size="icon-sm"
                    variant="round-destructive"
                  />
                }
              >
                <PhoneOffIcon />
              </TooltipTrigger>
              <TooltipPopup>
                <T>End call</T>
              </TooltipPopup>
            </Tooltip>
          </TooltipProvider>
        </div>
        {caption ? (
          <p className="mt-2 line-clamp-2 text-muted-foreground text-xs/4">{caption}</p>
        ) : null}
      </ComposerBanner.Root>
    </div>
  );
}
