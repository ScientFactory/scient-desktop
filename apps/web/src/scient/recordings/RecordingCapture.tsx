import type { ThreadId, VoiceTranscriptionLanguage } from "@t3tools/contracts";
import { useRouter } from "@tanstack/react-router";
import { useGT } from "gt-react";
import { AudioLinesIcon, MicIcon, PauseIcon, PlayIcon, SquareIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { randomUUID } from "../../lib/utils";
import { useCaptureUi } from "./recordingCaptureStore";
import { Button } from "../../components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../../components/ui/dialog";
import { getClientSettings } from "../../hooks/useSettings";
import { useProjects } from "../../state/entities";
import { useEnvironmentProviders, usePrimaryEnvironmentId } from "../../state/environments";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  chooseRecordingMicrophone,
  listBrowserMicrophones,
  type BrowserMicrophone,
} from "../../speech/browserMicrophones";
import { requestMicrophone } from "../../speech/requestMicrophone";
import { startLessonTalkThread, transcriptionCommand } from "../../rpc/transcription";
import { dictationCommand, makeDictationTranscriber } from "../voice/chatGptDictation";
import { RecordingSelect } from "./RecordingSelect";
import { TranscribeDialog } from "./TranscribeDialog";
import { fileName, type Project } from "./recordingTypes";
import { captureElapsed, recordingTime } from "./recordingPresentation";
import { andFinally, fail } from "../../lib/compilerSafe";
import { type LessonCaption, type LessonCaptionsTap, tapLessonCaptions } from "./lessonCaptions";
import { LessonTalk, type LessonTalkRoute, lessonTalkAgent } from "./LessonTalk";

type Session = {
  recorder: MediaRecorder;
  stream: MediaStream;
  save: Promise<unknown>;
  stopped: Promise<void>;
  context: AudioContext;
  analyser: AnalyserNode;
  samples: Uint8Array<ArrayBuffer>;
  started: number | undefined;
  elapsed: number;
  id: string;
  project: Project;
  language: string;
  captions: LessonCaptionsTap | undefined;
  wakeLock: WakeLockSentinel | undefined;
  /** The thread ChatGPT's answers come from, made at the first question. */
  talkThread: ThreadId | null;
  /** Pieces saved so far; one that fails is retried until it is saved. */
  failedSaves: number;
};

type Status = "idle" | "starting" | "recording" | "paused" | "talking" | "saving";

/** Captions kept on screen; the saved captions file has them all. */
const SHOWN_CAPTIONS = 6;
const SAVE_RETRY_MS = 2_000;
const CAPTION_SETTLE_MS = 8_000;

function captureClock() {
  return performance.now();
}

const toBase64 = (bytes: Uint8Array) => {
  let text = "";
  for (let offset = 0; offset < bytes.length; offset += 8_192)
    text += String.fromCharCode(...bytes.subarray(offset, offset + 8_192));
  return btoa(text);
};

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Keeps the screen, and so the computer, awake while a lesson records; best effort. */
async function holdAwake() {
  try {
    return await navigator.wakeLock?.request("screen");
  } catch {
    return undefined;
  }
}

export function RecordingCapture() {
  const gt = useGT();
  const router = useRouter();
  const environmentId = usePrimaryEnvironmentId();
  const projects = useProjects().filter(
    (project) => !project.isScratch && project.environmentId === environmentId,
  );
  const providers = useEnvironmentProviders();
  const runDictation = useAtomCommand(dictationCommand, { reportFailure: false });
  const { open, projectId, setOpen } = useCaptureUi();
  const [destination, setDestination] = useState("");
  const [microphones, setMicrophones] = useState<BrowserMicrophone[]>([]);
  const [microphone, setMicrophone] = useState<string>();
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<"permission" | "microphone" | "save">();
  const [readings, setReadings] = useState({ seconds: 0, level: 0 });
  const [activeProject, setActiveProject] = useState("");
  const [saved, setSaved] = useState<{ project: Project; source: string }>();
  const [captions, setCaptions] = useState<LessonCaption[]>([]);
  const [captionsState, setCaptionsState] = useState<"off" | "on" | "delayed">("off");
  const [talkRoute, setTalkRoute] = useState<LessonTalkRoute | null>(null);
  const [talkThread, setTalkThread] = useState<ThreadId | null>(null);
  const [talkError, setTalkError] = useState<string>();
  const [resumeAfterTalk, setResumeAfterTalk] = useState(true);
  /** What the question being asked needs from the recording, kept for rendering. */
  const [talking, setTalking] = useState<{
    environmentId: Project["environmentId"];
    project: string;
    id: string;
    stream: MediaStream;
  } | null>(null);
  const session = useRef<Session | null>(null);
  /** The question being asked; ending one makes its late results stale. */
  const talkAttempt = useRef(0);
  /** Closes the question's call; set by the call while it is open. */
  const closeTalk = useRef<(() => Promise<boolean>) | null>(null);
  /** An End in progress; another End waits for it. */
  const ending = useRef(false);
  const [endingTalk, setEndingTalk] = useState(false);
  const target =
    projects.find((project) => project.id === (destination || projectId)) ??
    (projects.length === 1 ? projects[0] : undefined);
  const chatGptAgent = environmentId ? lessonTalkAgent(providers.get(environmentId)) : null;

  const captureProjects = JSON.stringify(projects.map((project) => project.workspaceRoot));
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- recovers unfinished microphone writes when project roots become available.
  useEffect(() => {
    const paths: string[] = JSON.parse(captureProjects);
    if (!paths.length) return;
    const controller = new AbortController();
    const recover = () => {
      for (const path of paths)
        void transcriptionCommand("capture-recover", path, {}, controller.signal).catch(
          () => undefined,
        );
    };
    recover();
    // A renderer can restart before the old capture's lease expires.
    const retry = setTimeout(recover, 13_000);
    return () => {
      controller.abort();
      clearTimeout(retry);
    };
  }, [captureProjects]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads browser device inventory when the microphone picker opens.
  useEffect(() => {
    if (!open) return;
    let current = true;
    void Promise.all([listBrowserMicrophones().catch(() => []), chooseRecordingMicrophone()]).then(
      ([list, preferred]) => {
        if (current) {
          setMicrophones(list);
          setMicrophone((value) => value ?? preferred);
        }
      },
    );
    return () => {
      current = false;
    };
  }, [open]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- samples the live microphone and keeps the interrupted-capture lease current.
  useEffect(() => {
    // The lease is kept while saving too, so a slow save is never taken for an abandoned one.
    if (status === "idle" || status === "starting") return;
    const current = session.current;
    if (!current) return;
    const meter = setInterval(() => {
      let level = 0;
      if (current.started !== undefined) {
        current.analyser.getByteTimeDomainData(current.samples);
        for (const sample of current.samples) level = Math.max(level, Math.abs(sample - 128) / 128);
      }
      setReadings({ level, seconds: Math.floor(captureElapsed(current, captureClock()) / 1000) });
    }, 100);
    const lease = setInterval(() => {
      void transcriptionCommand("capture-touch", current.project.workspaceRoot, {
        id: current.id,
      }).catch(() => undefined);
    }, 4000);
    return () => {
      clearInterval(meter);
      clearInterval(lease);
    };
  }, [status]);

  /** Saves one piece, retrying until it is saved; a failure shows, and later pieces wait. */
  const savePiece = async (current: Session, input: Record<string, unknown>) => {
    for (;;) {
      try {
        await transcriptionCommand("capture-chunk", current.project.workspaceRoot, {
          id: current.id,
          ...(input as { format: "webm" | "m4a"; index: number; bytes: string }),
        });
        if (current.failedSaves > 0) {
          current.failedSaves = 0;
          setError((value) => (value === "save" ? undefined : value));
        }
        return;
      } catch (cause) {
        current.failedSaves += 1;
        setError("save");
        // The server refused the piece, as for a recording already saved: retrying can't help.
        if (cause instanceof Error && /\(4\d\d\)/.test(cause.message)) return;
        await wait(SAVE_RETRY_MS);
      }
    }
  };

  /** Starts captions on the recorder's stream; they begin with the recording, never before. */
  const openCaptions = async (
    current: Session,
    engine: NonNullable<Awaited<ReturnType<typeof captureStart>>["captions"]>,
  ) => {
    if (!environmentId) return;
    const transcriber = makeDictationTranscriber(runDictation, environmentId, engine);
    const language =
      current.language === "auto" ? undefined : (current.language as VoiceTranscriptionLanguage);
    try {
      return await tapLessonCaptions({
        stream: current.stream,
        transcribe: async (clip, signal) =>
          (
            await transcriber.transcribe(
              {
                audioBase64: clip.base64,
                mimeType: "audio/wav",
                sampleRateHz: clip.sampleRateHz,
                durationMs: clip.durationMs,
                ...(language ? { language } : {}),
              },
              signal,
            )
          ).text,
        save: (caption) =>
          transcriptionCommand("capture-caption", current.project.workspaceRoot, {
            id: current.id,
            ...caption,
          }).then(() => undefined),
        onCaption: (caption) => {
          if (session.current !== current) return;
          setCaptionsState("on");
          setCaptions((list) => [...list, caption].slice(-SHOWN_CAPTIONS));
        },
        onDelayed: () => {
          if (session.current === current) setCaptionsState("delayed");
        },
      });
    } catch {
      return undefined;
    }
  };

  const captureStart = (project: Project, id: string, language: string) =>
    transcriptionCommand("capture-start", project.workspaceRoot, { id, language });

  const start = async () => {
    if (!target || status !== "idle") return;
    setStatus("starting");
    setError(undefined);
    setTalkError(undefined);
    setCaptions([]);
    setCaptionsState("off");
    setTalkThread(null);
    let stream: MediaStream | undefined;
    let context: AudioContext | undefined;
    try {
      stream = await requestMicrophone(microphone ?? "");
      const mimeType = ["audio/webm;codecs=opus", "audio/mp4"].find((type) =>
        MediaRecorder.isTypeSupported(type),
      );
      if (!mimeType) fail("Recording format unavailable");
      const recorder = new MediaRecorder(stream, { mimeType, audioBitsPerSecond: 64_000 });
      const id = randomUUID();
      const format = mimeType.startsWith("audio/webm") ? "webm" : "m4a";
      const settings = getClientSettings();
      const language =
        settings.voiceExtendedLanguagePreference ?? settings.voiceLanguagePreference ?? "auto";
      const lesson = await captureStart(target, id, language);
      context = new AudioContext();
      const analyser = context.createAnalyser();
      analyser.fftSize = 1024;
      context.createMediaStreamSource(stream).connect(analyser);
      void context.resume().catch(() => undefined);
      const stopped = new Promise<void>((resolve) =>
        recorder.addEventListener("stop", () => resolve(), { once: true }),
      );
      const current: Session = {
        recorder,
        stream,
        save: Promise.resolve(),
        stopped,
        context,
        analyser,
        samples: new Uint8Array(analyser.fftSize),
        started: captureClock(),
        elapsed: 0,
        id,
        project: target,
        language: lesson.language,
        captions: undefined,
        wakeLock: await holdAwake(),
        talkThread: null,
        failedSaves: 0,
      };
      let index = 0;
      recorder.addEventListener("dataavailable", ({ data }) => {
        if (!data.size) return;
        current.save = current.save.then(async () => {
          for (let offset = 0; offset < data.size; offset += 16_000) {
            const bytes = new Uint8Array(await data.slice(offset, offset + 16_000).arrayBuffer());
            await savePiece(current, { format, index, bytes: toBase64(bytes) });
            index += 1;
          }
        });
      });
      recorder.addEventListener("error", () => setError("microphone"));
      if (lesson.captions) current.captions = await openCaptions(current, lesson.captions);
      recorder.start(1000);
      current.started = captureClock();
      session.current = current;
      setReadings({ level: 0, seconds: 0 });
      setActiveProject(target.title);
      setStatus("recording");
      setTalkRoute(
        chatGptAgent
          ? { kind: "chatgpt", instanceId: chatGptAgent }
          : lesson.talk.openai
            ? { kind: "openai" }
            : null,
      );
      setCaptionsState(current.captions ? "on" : "off");
      void listBrowserMicrophones()
        .then(setMicrophones)
        .catch(() => undefined);
    } catch (cause) {
      stream?.getTracks().forEach((track) => track.stop());
      void context?.close().catch(() => undefined);
      setError(
        cause instanceof DOMException && cause.name === "NotAllowedError"
          ? "permission"
          : "microphone",
      );
      setStatus("idle");
    }
  };

  const pauseRecording = (current: Session) => {
    current.recorder.requestData();
    current.recorder.pause();
    current.captions?.setPaused(true);
    current.elapsed = captureElapsed(current, captureClock());
    current.started = undefined;
  };

  const resumeRecording = (current: Session) => {
    current.recorder.resume();
    current.captions?.setPaused(false);
    current.started = captureClock();
  };

  const togglePause = () => {
    const current = session.current;
    if (!current) return;
    if (status === "recording") {
      pauseRecording(current);
      setStatus("paused");
    } else if (status === "paused") {
      resumeRecording(current);
      setStatus("recording");
    }
  };

  /** Ends the question: the call is closed before the lesson records again. */
  const endTalk = async (message?: string) => {
    const current = session.current;
    if (!current || ending.current) return;
    ending.current = true;
    setEndingTalk(true);
    const attempt = (talkAttempt.current += 1);
    if (message) setTalkError(message);
    const close = closeTalk.current;
    closeTalk.current = null;
    // A call that doesn't go quiet in time leaves the lesson paused rather than recording it.
    const quiet = close ? await close().catch(() => false) : true;
    ending.current = false;
    setEndingTalk(false);
    if (session.current !== current || talkAttempt.current !== attempt) return;
    setTalking(null);
    if (resumeAfterTalk && !message && quiet) {
      resumeRecording(current);
      setStatus("recording");
    } else setStatus("paused");
  };

  /** Pauses the lesson, so neither the question nor the answer is recorded, and asks. */
  const talk = async () => {
    const current = session.current;
    if (!current || !talkRoute || (status !== "recording" && status !== "paused")) return;
    const attempt = (talkAttempt.current += 1);
    const live = () => talkAttempt.current === attempt && session.current === current;
    setTalkError(undefined);
    setResumeAfterTalk(status === "recording");
    if (status === "recording") pauseRecording(current);
    setStatus("talking");
    // What was said just before the question is captioned first, so the answer can use it.
    await current.captions?.settle(CAPTION_SETTLE_MS);
    if (talkRoute.kind === "chatgpt" && !current.talkThread) {
      try {
        const thread = await startLessonTalkThread(current.project.workspaceRoot, current.id);
        if (!("threadId" in thread)) fail("No model for the conversation");
        current.talkThread = thread.threadId as ThreadId;
      } catch {
        if (live()) void endTalk(gt("Could not start the conversation."));
        return;
      }
    }
    if (!live()) return;
    setTalkThread(current.talkThread);
    setTalking({
      environmentId: current.project.environmentId,
      project: current.project.workspaceRoot,
      id: current.id,
      stream: current.stream,
    });
  };

  const stop = async () => {
    const current = session.current;
    if (!current || status === "saving") return;
    setStatus("saving");
    await andFinally(
      async () => {
        try {
          current.captions?.close();
          if (current.recorder.state !== "inactive") current.recorder.stop();
          await current.stopped;
          current.stream.getTracks().forEach((track) => track.stop());
          await current.save;
          const finished = await transcriptionCommand(
            "capture-finish",
            current.project.workspaceRoot,
            { id: current.id, lesson: { language: current.language } },
          );
          const { source } = finished;
          if (!source) fail("No recording was saved");
          setOpen(false);
          setDestination("");
          setError(undefined);
          if (finished.transcription === "started" || finished.transcription === "queued") {
            void router.navigate({
              to: "/recordings",
              search: { project: current.project.id, source },
            });
          } else setSaved({ source, project: current.project });
        } catch {
          setError("save");
          setOpen(true);
        }
      },
      () => {
        current.stream.getTracks().forEach((track) => track.stop());
        void current.context.close().catch(() => undefined);
        void current.wakeLock?.release().catch(() => undefined);
        session.current = null;
        talkAttempt.current += 1;
        void closeTalk.current?.();
        closeTalk.current = null;
        setTalkThread(null);
        setTalking(null);
        setStatus("idle");
      },
    );
  };

  const active =
    status === "recording" || status === "paused" || status === "talking" || status === "saving";
  return (
    <>
      {active && (
        <div className="fixed start-1/2 top-1 z-50 -translate-x-1/2 [-webkit-app-region:no-drag]">
          <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
            <MicIcon />{" "}
            {status === "talking"
              ? gt("Paused · Talking")
              : status === "paused"
                ? gt("Recording paused")
                : status === "saving"
                  ? gt("Saving recording…")
                  : gt("Recording")}{" "}
            · {recordingTime(readings.seconds)}
          </Button>
        </div>
      )}
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!next && status === "idle") {
            setDestination("");
            setError(undefined);
          }
          setOpen(next);
        }}
      >
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>{gt("Record a lesson")}</DialogTitle>
            {active && <DialogDescription>{activeProject}</DialogDescription>}
          </DialogHeader>
          <DialogPanel>
            {active ? (
              <div className="space-y-3">
                <div className="flex items-center gap-3 pt-3">
                  <span className="text-sm tabular-nums">{recordingTime(readings.seconds)}</span>
                  <meter
                    className="w-full"
                    min={0}
                    max={1}
                    value={readings.level}
                    aria-label={gt("Microphone level")}
                  />
                </div>
                {status === "talking" && !talking ? (
                  <p role="status" className="py-1 text-sm font-medium">
                    {gt("Connecting…")}
                  </p>
                ) : status === "talking" && talking && talkRoute ? (
                  <LessonTalk
                    closeRef={closeTalk}
                    route={talkRoute}
                    environmentId={talking.environmentId}
                    project={talking.project}
                    captureId={talking.id}
                    threadId={talkThread}
                    stream={talking.stream}
                    onEnded={(message) => void endTalk(message)}
                  />
                ) : captionsState !== "off" ? (
                  <div
                    aria-label={gt("Live captions")}
                    aria-live="polite"
                    className="max-h-40 space-y-1.5 overflow-y-auto text-sm"
                  >
                    {captions.length ? (
                      captions.map((caption) => (
                        <p key={caption.window}>
                          <span className="me-2 text-xs text-muted-foreground tabular-nums">
                            {recordingTime(caption.start)}
                          </span>
                          {caption.text}
                        </p>
                      ))
                    ) : (
                      <p className="text-muted-foreground">{gt("Captions appear as you go.")}</p>
                    )}
                    {captionsState === "delayed" && (
                      <p className="text-xs text-muted-foreground">{gt("Captions delayed")}</p>
                    )}
                  </div>
                ) : null}
              </div>
            ) : (
              <div className="space-y-3">
                <div className="flex items-center justify-between gap-2 text-sm">
                  {gt("Project")}
                  <RecordingSelect
                    label={gt("Project")}
                    variant="outline"
                    display={target ? undefined : gt("Choose a project")}
                    value={target?.id ?? ""}
                    options={projects.map((project) => ({
                      value: project.id,
                      label: project.title,
                    }))}
                    onChange={setDestination}
                  />
                </div>
                <div className="flex items-center justify-between gap-2 text-sm">
                  {gt("Microphone")}
                  <RecordingSelect
                    label={gt("Microphone")}
                    variant="outline"
                    value={microphone ?? ""}
                    options={[
                      { value: "", label: gt("System default") },
                      ...microphones
                        .filter((item) => item.deviceId && item.deviceId !== "default")
                        .map((item) => ({ value: item.deviceId, label: item.label })),
                    ]}
                    onChange={setMicrophone}
                  />
                </div>
              </div>
            )}
            {(error || talkError) && (
              <p role="status" className="mt-2 text-sm text-muted-foreground">
                {talkError ??
                  (error === "permission"
                    ? gt("Microphone access was denied. Allow it in system settings to record.")
                    : error === "save"
                      ? gt("Could not save the recording. Retrying…")
                      : gt("Could not open the microphone."))}
              </p>
            )}
          </DialogPanel>
          <DialogFooter>
            {status === "talking" ? (
              <Button disabled={endingTalk} onClick={() => void endTalk()}>
                {resumeAfterTalk ? gt("End and resume") : gt("End")}
              </Button>
            ) : active ? (
              <>
                <Button variant="outline" disabled={status === "saving"} onClick={togglePause}>
                  {status === "paused" ? <PlayIcon /> : <PauseIcon />}
                  {status === "paused" ? gt("Resume") : gt("Pause")}
                </Button>
                {talkRoute && (
                  <Button
                    variant="outline"
                    disabled={status === "saving"}
                    onClick={() => void talk()}
                  >
                    <AudioLinesIcon /> {gt("Talk")}
                  </Button>
                )}
                <Button disabled={status === "saving"} onClick={() => void stop()}>
                  <SquareIcon /> {gt("Stop")}
                </Button>
              </>
            ) : (
              <Button disabled={!target || status === "starting"} onClick={() => void start()}>
                <MicIcon /> {gt("Start recording")}
              </Button>
            )}
          </DialogFooter>
        </DialogPopup>
      </Dialog>
      {saved && (
        <TranscribeDialog
          project={saved.project.workspaceRoot}
          projectTitle={saved.project.title}
          source={saved.source}
          title={fileName(saved.source)}
          onClose={() => setSaved(undefined)}
          onStart={() => setSaved(undefined)}
        />
      )}
    </>
  );
}
