import { useGT } from "gt-react";
import { MicIcon, PauseIcon, PlayIcon, SquareIcon } from "lucide-react";
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
import { useProjects } from "../../state/entities";
import { usePrimaryEnvironmentId } from "../../state/environments";
import {
  chooseRecordingMicrophone,
  listBrowserMicrophones,
  type BrowserMicrophone,
} from "../../speech/browserMicrophones";
import { requestMicrophone } from "../../speech/requestMicrophone";
import { transcriptionCommand } from "../../rpc/transcription";
import { RecordingSelect } from "./RecordingSelect";
import { TranscribeDialog } from "./TranscribeDialog";
import { fileName, type Project } from "./recordingTypes";
import { captureElapsed, recordingTime } from "./recordingPresentation";
import { andFinally, fail } from "../../lib/compilerSafe";

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
};

function captureClock() {
  return performance.now();
}

export function RecordingCapture() {
  const gt = useGT();
  const environmentId = usePrimaryEnvironmentId();
  const projects = useProjects().filter(
    (project) => !project.isScratch && project.environmentId === environmentId,
  );
  const { open, projectId, setOpen } = useCaptureUi();
  const [destination, setDestination] = useState("");
  const [microphones, setMicrophones] = useState<BrowserMicrophone[]>([]);
  const [microphone, setMicrophone] = useState<string>();
  const [status, setStatus] = useState<"idle" | "starting" | "recording" | "paused" | "saving">(
    "idle",
  );
  const [error, setError] = useState<"permission" | "microphone" | "save">();
  const [readings, setReadings] = useState({ seconds: 0, level: 0 });
  const [activeProject, setActiveProject] = useState("");
  const [saved, setSaved] = useState<{ project: Project; source: string }>();
  const session = useRef<Session | null>(null);
  const target =
    projects.find((project) => project.id === (destination || projectId)) ??
    (projects.length === 1 ? projects[0] : undefined);

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
    if (status !== "recording" && status !== "paused") return;
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

  const start = async () => {
    if (!target || status !== "idle") return;
    setStatus("starting");
    setError(undefined);
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
      await transcriptionCommand("capture-touch", target.workspaceRoot, { id });
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
      };
      let index = 0;
      recorder.addEventListener("dataavailable", ({ data }) => {
        if (!data.size) return;
        current.save = current.save.then(async () => {
          for (let offset = 0; offset < data.size; offset += 16_000) {
            const bytes = new Uint8Array(await data.slice(offset, offset + 16_000).arrayBuffer());
            await transcriptionCommand("capture-chunk", current.project.workspaceRoot, {
              id,
              format,
              index,
              bytes: btoa(String.fromCharCode(...bytes)),
            });
            index += 1;
          }
        });
        void current.save.catch(() => setError("save"));
      });
      recorder.addEventListener("error", () => setError("microphone"));
      recorder.start(1000);
      session.current = current;
      setReadings({ level: 0, seconds: 0 });
      setActiveProject(target.title);
      setStatus("recording");
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

  const togglePause = () => {
    const current = session.current;
    if (!current) return;
    const now = captureClock();
    if (status === "recording") {
      current.recorder.requestData();
      current.recorder.pause();
      current.elapsed = captureElapsed(current, now);
      current.started = undefined;
      setStatus("paused");
    } else if (status === "paused") {
      current.recorder.resume();
      current.started = now;
      setStatus("recording");
    }
  };

  const stop = async () => {
    const current = session.current;
    if (!current || status === "saving") return;
    setStatus("saving");
    await andFinally(
      async () => {
        try {
          if (current.recorder.state !== "inactive") current.recorder.stop();
          await current.stopped;
          current.stream.getTracks().forEach((track) => track.stop());
          await current.save.catch(() => undefined);
          const { source } = await transcriptionCommand(
            "capture-finish",
            current.project.workspaceRoot,
            { id: current.id },
          );
          if (!source) fail("No recording was saved");
          setOpen(false);
          setDestination("");
          setSaved({ source, project: current.project });
          setError(undefined);
        } catch {
          setError("save");
          setOpen(true);
        }
      },
      () => {
        current.stream.getTracks().forEach((track) => track.stop());
        void current.context.close().catch(() => undefined);
        session.current = null;
        setStatus("idle");
      },
    );
  };

  const active = status === "recording" || status === "paused" || status === "saving";
  return (
    <>
      {active && (
        <div className="fixed start-1/2 top-1 z-50 -translate-x-1/2 [-webkit-app-region:no-drag]">
          <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
            <MicIcon />{" "}
            {status === "paused"
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
            <DialogTitle>{gt("Record audio")}</DialogTitle>
            <DialogDescription>
              {active ? activeProject : gt("Save a microphone recording to a project.")}
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            {active ? (
              <div className="flex items-center gap-3 py-3">
                <span className="text-sm tabular-nums">{recordingTime(readings.seconds)}</span>
                <meter
                  className="w-full"
                  min={0}
                  max={1}
                  value={readings.level}
                  aria-label={gt("Microphone level")}
                />
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
            {error && (
              <p role="status" className="mt-2 text-sm text-muted-foreground">
                {error === "permission"
                  ? gt("Microphone access was denied. Allow it in system settings to record.")
                  : error === "save"
                    ? gt("Could not save all of the recording.")
                    : gt("Could not open the microphone.")}
              </p>
            )}
          </DialogPanel>
          <DialogFooter>
            {active ? (
              <>
                <Button variant="outline" disabled={status === "saving"} onClick={togglePause}>
                  {status === "paused" ? <PlayIcon /> : <PauseIcon />}
                  {status === "paused" ? gt("Resume") : gt("Pause")}
                </Button>
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
