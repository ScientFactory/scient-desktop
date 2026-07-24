// FILE: ComposerVoiceRecorderBar.tsx
// Purpose: Renders the expanded WhatsApp-style voice recorder UI inside the chat composer.
// Layer: Chat composer presentation
// Depends on: live waveform samples and caller-owned record/cancel/send actions.

import { memo, useEffect, useRef, useState } from "react";
import { FiArrowUp, FiX } from "react-icons/fi";
import { IoStopSharp } from "react-icons/io5";

import { Loader2Icon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import type { ComposerVoiceCompletionIntent } from "./composerVoiceState";

interface ComposerVoiceRecorderBarProps {
  disabled?: boolean;
  durationLabel: string;
  completionIntent: ComposerVoiceCompletionIntent | null;
  waveformLevels: readonly number[];
  onCancel: () => void;
  onInsert: () => void;
  onSend?: () => void;
}

const BAR_WIDTH_PX = 2;
const BAR_GAP_PX = 2;
const BAR_MIN_HEIGHT_PX = 3;
const BAR_MAX_HEIGHT_PX = 22;

export const ComposerVoiceRecorderBar = memo(function ComposerVoiceRecorderBar(
  props: ComposerVoiceRecorderBarProps,
) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const [visibleBarCount, setVisibleBarCount] = useState(96);

  useEffect(() => {
    const node = trackRef.current;
    if (!node) {
      return;
    }
    const computeVisibleBars = () => {
      const width = node.clientWidth;
      if (width <= 0) {
        return;
      }
      setVisibleBarCount(Math.max(8, Math.floor(width / (BAR_WIDTH_PX + BAR_GAP_PX))));
    };
    computeVisibleBars();
    const observer = new ResizeObserver(computeVisibleBars);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const visibleLevels = props.waveformLevels.slice(-visibleBarCount);
  const isTranscribing = props.completionIntent !== null;
  const insertIsActive = props.completionIntent === "insert";
  const sendIsActive = props.completionIntent === "send";
  const cancelLabel = isTranscribing ? "Cancel voice transcription" : "Cancel voice recording";
  const insertLabel = insertIsActive
    ? "Transcribing voice note to composer"
    : "Stop and insert voice note";
  const sendLabel = sendIsActive ? "Transcribing voice note to send" : "Send voice note";

  return (
    <div className="flex min-w-0 flex-1 items-center gap-2.5">
      <div ref={trackRef} className="relative flex h-7 min-w-0 flex-1 items-center overflow-hidden">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 top-1/2 -translate-y-1/2 border-t border-dashed border-zinc-300 dark:border-zinc-700"
        />
        <div
          className="relative ml-auto flex h-full items-center"
          style={{ gap: `${BAR_GAP_PX}px` }}
        >
          {visibleLevels.map((level, index) => {
            const clamped = Math.max(0.04, Math.min(1, level));
            const height = Math.round(
              BAR_MIN_HEIGHT_PX + clamped * (BAR_MAX_HEIGHT_PX - BAR_MIN_HEIGHT_PX),
            );
            const positionFromRight = visibleLevels.length - index;
            return (
              <span
                key={positionFromRight}
                aria-hidden="true"
                className={cn(
                  "shrink-0 rounded-[1px] bg-zinc-900 dark:bg-zinc-100",
                  isTranscribing && "opacity-55",
                )}
                style={{
                  width: `${BAR_WIDTH_PX}px`,
                  height: `${height}px`,
                }}
              />
            );
          })}
        </div>
      </div>

      <span className="shrink-0 text-xs font-medium tabular-nums tracking-[0.02em] text-zinc-500 dark:text-zinc-400">
        {props.durationLabel}
      </span>

      <button
        type="button"
        className="flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-full bg-zinc-200/80 text-zinc-700 transition-colors hover:bg-zinc-200 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-white/10 dark:text-zinc-100 dark:hover:bg-white/15 sm:h-7 sm:w-7"
        aria-label={cancelLabel}
        title={cancelLabel}
        onClick={props.onCancel}
      >
        <FiX aria-hidden="true" className="size-[13px]" strokeWidth={2.25} />
      </button>

      <button
        type="button"
        className={cn(
          "flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-full bg-zinc-200/80 text-zinc-700 transition-colors hover:bg-zinc-200 disabled:cursor-not-allowed dark:bg-white/10 dark:text-zinc-100 dark:hover:bg-white/15 sm:h-7 sm:w-7",
          sendIsActive && "opacity-40",
        )}
        aria-label={insertLabel}
        title={insertLabel}
        disabled={props.disabled || isTranscribing}
        onClick={props.onInsert}
      >
        {insertIsActive ? (
          <Loader2Icon aria-hidden="true" className="size-3 animate-spin" />
        ) : (
          <IoStopSharp aria-hidden="true" className="size-[11px]" />
        )}
      </button>

      {props.onSend ? (
        <button
          type="button"
          className={cn(
            "flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-full bg-foreground text-background transition-transform duration-150 hover:scale-105 disabled:cursor-not-allowed disabled:hover:scale-100 sm:h-7 sm:w-7",
            insertIsActive && "opacity-40",
          )}
          aria-label={sendLabel}
          title={sendLabel}
          disabled={props.disabled || isTranscribing}
          onClick={props.onSend}
        >
          {sendIsActive ? (
            <Loader2Icon aria-hidden="true" className="size-3 animate-spin" />
          ) : (
            <FiArrowUp aria-hidden="true" className="size-[13px]" strokeWidth={2.25} />
          )}
        </button>
      ) : null}
    </div>
  );
});
