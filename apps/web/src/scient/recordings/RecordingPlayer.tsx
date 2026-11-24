import { useGT } from "gt-react";
import * as Schema from "effect/Schema";
import {
  MaximizeIcon,
  MinimizeIcon,
  PauseIcon,
  PlayIcon,
  RectangleHorizontalIcon,
  Volume2Icon,
  VolumeXIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Popover, PopoverPopup, PopoverTrigger } from "../../components/ui/popover";
import { Button } from "../../components/ui/button";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { observeResize } from "../../lib/observeResize";
import { prepareVideoFirstFrame } from "../../lib/videoFirstFrame";
import { RecordingSelect } from "./RecordingSelect";
import "./recording-player.css";

const PLAYBACK_PREFERENCE_KEY = "scient:recording-playback:v1";
const PlaybackPreference = Schema.Struct({
  volume: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
  muted: Schema.Boolean,
});
const DEFAULT_PLAYBACK_PREFERENCE = { volume: 1, muted: false };

/** The filled part of a settings slider follows its value. */
const sliderFill = (ratio: number) => {
  const clamped = Math.max(0, Math.min(1, Number.isFinite(ratio) ? ratio : 0));
  return {
    "--settings-slider-progress": `${clamped * 100}%`,
    "--settings-slider-fill-offset": `${0.5 - clamped}rem`,
  } as React.CSSProperties;
};
import { recordingTime } from "./recordingPresentation";

export function RecordingPlayer({
  onMedia,
  onReady,
  src,
  video,
  time,
  onTime,
  onStale,
  frontier,
  theater,
  onTheater,
  caption,
}: {
  onReady: (element: HTMLMediaElement) => void;
  onMedia: (element: HTMLMediaElement | null) => void;
  src: string;
  video: boolean;
  time: number;
  onTime: (time: number) => void;
  /** The loaded link stopped working (it expires); the owner fetches a fresh one. */
  onStale: (wasPlaying: boolean) => void;
  theater: boolean;
  onTheater: () => void;
  caption: string;
  frontier?: number | undefined;
}) {
  const gt = useGT();
  const media = useRef<HTMLMediaElement | null>(null);
  const stage = useRef<HTMLDivElement>(null);
  const fullscreenButton = useRef<HTMLButtonElement>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [fullscreenError, setFullscreenError] = useState(false);
  const [captions, setCaptions] = useState(false);
  const [{ muted, volume }, setPlaybackPreference] = useLocalStorage(
    PLAYBACK_PREFERENCE_KEY,
    DEFAULT_PLAYBACK_PREFERENCE,
    PlaybackPreference,
  );
  const toggleMute = () =>
    setPlaybackPreference((current) => ({ ...current, muted: !current.muted }));
  const [ratio, setRatio] = useState(16 / 9);
  const [controlsVisible, setControlsVisible] = useState(true);
  const hideControls = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- keeps controls and focus in sync with the browser fullscreen event.
  useEffect(() => {
    const sync = () => {
      const active = document.fullscreenElement === stage.current;
      document.documentElement.toggleAttribute("data-recording-fullscreen", active);
      setFullscreen(active);
      if (active) {
        stage.current?.focus();
        clearTimeout(hideControls.current);
        setControlsVisible(true);
        hideControls.current = setTimeout(() => setControlsVisible(false), 2500);
      } else if (stage.current?.contains(document.activeElement)) fullscreenButton.current?.focus();
    };
    document.addEventListener("fullscreenchange", sync);
    return () => {
      document.removeEventListener("fullscreenchange", sync);
      document.documentElement.removeAttribute("data-recording-fullscreen");
      clearTimeout(hideControls.current);
    };
  }, []);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- keeps the fullscreen stage fitted to the resized Electron renderer viewport.
  useEffect(() => {
    const element = stage.current;
    if (!fullscreen || !element) return;
    const fitViewport = () => {
      element.style.setProperty("--recording-fullscreen-width", `${window.innerWidth}px`);
      element.style.setProperty("--recording-fullscreen-height", `${window.innerHeight}px`);
    };
    const stopObserving = observeResize(document.documentElement, fitViewport);
    window.addEventListener("resize", fitViewport);
    fitViewport();
    return () => {
      stopObserving();
      window.removeEventListener("resize", fitViewport);
      element.style.removeProperty("--recording-fullscreen-width");
      element.style.removeProperty("--recording-fullscreen-height");
    };
  }, [fullscreen]);
  const toggleFullscreen = async () => {
    try {
      if (document.fullscreenElement === stage.current) await document.exitFullscreen();
      else await stage.current?.requestFullscreen();
      setFullscreenError(false);
    } catch {
      setFullscreenError(true);
    }
  };
  const revealControls = () => {
    clearTimeout(hideControls.current);
    setControlsVisible(true);
    hideControls.current = setTimeout(() => setControlsVisible(false), 2500);
  };
  const [playing, setPlaying] = useState(false);
  const [duration, setDuration] = useState(0);
  const [rate, setRate] = useState("1");
  const [error, setError] = useState(false);
  const loaded = useRef(false);
  const failed = useRef(false);
  const wantsPlay = useRef(false);
  // A link that loaded once and then fails has expired; a link that never loaded cannot play.
  const fail = () => {
    if (failed.current) return;
    failed.current = true;
    setPlaying(false);
    if (loaded.current) onStale(wantsPlay.current);
    else setError(true);
  };
  const events = {
    src,
    preload: "metadata" as const,
    ref: (element: HTMLMediaElement | null) => {
      media.current = element;
      if (element && element.volume !== volume) element.volume = volume;
      onMedia(element);
    },
    onLoadedMetadata: (event: React.SyntheticEvent<HTMLMediaElement>) => {
      loaded.current = true;
      onReady(event.currentTarget);
    },
    onTimeUpdate: () => onTime(media.current?.currentTime ?? 0),
    onDurationChange: () => {
      const next = media.current?.duration ?? 0;
      setDuration(Number.isFinite(next) ? next : 0);
    },
    onPlay: () => {
      wantsPlay.current = true;
      setPlaying(true);
    },
    onPause: () => {
      wantsPlay.current = false;
      setPlaying(false);
    },
    onError: fail,
  };
  const seek = (seconds: number) => {
    if (!media.current || !duration) return;
    media.current.currentTime = Math.max(0, Math.min(duration, seconds));
    onTime(media.current.currentTime);
  };
  const toggle = async () => {
    if (!media.current) return;
    if (media.current.paused) {
      wantsPlay.current = true;
      try {
        await media.current.play();
      } catch {
        if (media.current?.error) fail();
        else wantsPlay.current = false;
      }
    } else media.current.pause();
  };
  const volumeSlider = (className: string) => (
    <input
      type="range"
      min={0}
      max={1}
      step={0.05}
      value={volume}
      aria-label={gt("Volume")}
      className={`settings-slider ${className}`}
      style={sliderFill(muted ? 0 : volume)}
      onChange={(event) => {
        setPlaybackPreference({ volume: event.currentTarget.valueAsNumber, muted: false });
      }}
    />
  );
  const volumeIcon = muted || volume === 0 ? <VolumeXIcon /> : <Volume2Icon />;
  return (
    <div
      ref={stage}
      className={`recording-stage relative min-w-0 shrink-0 bg-card ${video ? "" : "rounded-xl border"}`}
      tabIndex={-1}
      data-recording-focus
      onPointerMove={fullscreen ? revealControls : undefined}
      onKeyDownCapture={fullscreen ? revealControls : undefined}
      onKeyDown={(event) => {
        if (
          event.metaKey ||
          event.ctrlKey ||
          event.altKey ||
          !(event.target instanceof HTMLElement) ||
          event.target.closest(
            "input, textarea, select, [contenteditable], [role=combobox], [role=menu]",
          )
        )
          return;
        const key = event.key.toLowerCase();
        if (key === "f" && video) void toggleFullscreen();
        else if (key === "t" && video && !fullscreen) onTheater();
        else if (key === "escape" && fullscreen && !event.defaultPrevented) void toggleFullscreen();
        else if (key === "escape" && theater && !fullscreen) onTheater();
        else if (key === "c" && video) setCaptions((value) => !value);
        else if (key === "m") toggleMute();
        else return;
        event.preventDefault();
        event.stopPropagation();
        revealControls();
      }}
    >
      {video ? (
        <div
          className={`recording-frame relative mx-auto w-full bg-zinc-950 ${theater ? "max-h-[70dvh]" : "max-h-[45dvh] @[1200px]/recording:max-h-[65dvh]"}`}
          style={{ aspectRatio: ratio }}
        >
          <video
            {...events}
            playsInline
            muted={muted}
            className="absolute inset-0 size-full object-contain"
            onLoadedMetadata={(event) => {
              const element = event.currentTarget;
              loaded.current = true;
              if (element.videoWidth && element.videoHeight)
                setRatio(element.videoWidth / element.videoHeight);
              prepareVideoFirstFrame(element);
              onReady(element);
            }}
            onClick={() => void toggle()}
            onDoubleClick={() => void toggleFullscreen()}
          />
          {captions && caption && (
            <p
              dir="auto"
              className="recording-captions pointer-events-none absolute inset-x-6 bottom-14 mx-auto w-fit rounded bg-black/80 px-3 py-1 text-center text-white"
            >
              {caption}
            </p>
          )}
        </div>
      ) : (
        <audio {...events} muted={muted} />
      )}
      <div
        className={`recording-transport flex min-h-11 items-center gap-2 px-3 py-1 motion-safe:transition-opacity ${fullscreen && !controlsVisible ? "pointer-events-none opacity-0 focus-within:pointer-events-auto" : ""}`}
        dir="ltr"
      >
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={playing ? gt("Pause playback") : gt("Play recording")}
          onClick={() => void toggle()}
        >
          {playing ? <PauseIcon /> : <PlayIcon />}
        </Button>
        <Button
          variant="ghost"
          size="xs"
          data-recording-skip
          aria-label={gt("Back 15 seconds")}
          onClick={() => seek(time - 15)}
        >
          −15
        </Button>
        <Button
          variant="ghost"
          size="xs"
          data-recording-skip
          aria-label={gt("Forward 15 seconds")}
          onClick={() => seek(time + 15)}
        >
          +15
        </Button>
        <input
          className="recording-seek settings-slider min-w-0 flex-1"
          style={sliderFill(duration ? time / duration : 0)}
          type="range"
          min={0}
          max={duration}
          step={0.1}
          value={Math.min(time, duration)}
          disabled={!duration}
          onChange={(event) => seek(event.currentTarget.valueAsNumber)}
          aria-label={gt("Playback position")}
          aria-valuetext={gt("{position} of {duration}", {
            position: recordingTime(time),
            duration: recordingTime(duration),
          })}
          onKeyDown={(event) => {
            if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
            event.preventDefault();
            seek(time + (event.key === "ArrowLeft" ? -5 : 5));
          }}
        />
        <span className={`text-xs tabular-nums ${fullscreen ? "" : "text-muted-foreground"}`}>
          {recordingTime(time)} / {recordingTime(duration)}
        </span>
        <Button
          variant="ghost"
          size="icon-sm"
          data-player-key="m"
          data-recording-wide-volume
          aria-label={gt("Mute (M)")}
          aria-pressed={muted}
          onClick={toggleMute}
        >
          {volumeIcon}
        </Button>
        {volumeSlider("recording-wide-volume w-16")}
        {!fullscreen && (
          <div className="recording-volume-menu">
            <Popover>
              <PopoverTrigger
                render={
                  <Button variant="ghost" size="icon-sm" aria-label={gt("Volume controls")} />
                }
              >
                {volumeIcon}
              </PopoverTrigger>
              <PopoverPopup side="top">
                <div className="flex items-center gap-2 p-2" dir="ltr">
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={gt("Mute (M)")}
                    aria-pressed={muted}
                    onClick={toggleMute}
                  >
                    {volumeIcon}
                  </Button>
                  {volumeSlider("w-24")}
                </div>
              </PopoverPopup>
            </Popover>
          </div>
        )}
        <RecordingSelect
          label={gt("Playback speed")}
          portalContainer={fullscreen ? stage : undefined}
          value={rate}
          options={["0.75", "1", "1.25", "1.5", "2"].map((value) => ({
            value,
            label: `${value}×`,
          }))}
          onChange={(value) => {
            if (media.current) media.current.playbackRate = Number(value);
            setRate(value);
          }}
        />
        {video && (
          <>
            <Button
              variant="ghost"
              size="icon-sm"
              data-player-key="t"
              aria-label={gt("Theater (T)")}
              aria-pressed={theater}
              onClick={onTheater}
            >
              <RectangleHorizontalIcon />
            </Button>
            <Button
              ref={fullscreenButton}
              variant="ghost"
              size="icon-sm"
              data-player-key="f"
              aria-label={gt("Full screen (F)")}
              aria-pressed={fullscreen}
              onClick={() => void toggleFullscreen()}
            >
              {fullscreen ? <MinimizeIcon /> : <MaximizeIcon />}
            </Button>
            {fullscreen && (
              <Button
                variant="ghost"
                size="xs"
                aria-pressed={captions}
                onClick={() => setCaptions(!captions)}
              >
                {gt("Captions (C)")}
              </Button>
            )}
          </>
        )}
      </div>
      {fullscreenError && (
        <p role="status" className="px-3 text-xs text-muted-foreground">
          {gt("Could not enter full screen")}
        </p>
      )}
      {frontier !== undefined && duration > 0 && frontier < duration && (
        <div className="px-3 pb-2 text-xs text-muted-foreground">
          {gt("Transcribed through {time}", { time: recordingTime(frontier) })}
        </div>
      )}
      {error && (
        <p role="status" className="px-3 pb-3 text-xs text-muted-foreground">
          {gt("Could not play the recording")}
        </p>
      )}
    </div>
  );
}
