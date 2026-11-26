import { expect, it, vi } from "vite-plus/test";
import { page } from "vitest/browser";
import { render } from "../../../test/render";
import "../../index.css";
import { RecordingCapture } from "./RecordingCapture";
import { openRecordingCapture } from "./recordingCaptureStore";

const mocks = vi.hoisted(() => ({
  microphone: vi.fn(),
  command: vi.fn(),
  navigate: vi.fn(),
  captions: vi.fn(),
  setPaused: vi.fn(),
  closeCall: vi.fn(async () => {}),
}));
vi.mock("../../speech/requestMicrophone", () => ({ requestMicrophone: mocks.microphone }));
vi.mock("../../speech/browserMicrophones", () => ({
  chooseRecordingMicrophone: async () => "test-mic",
  listBrowserMicrophones: async () => [{ deviceId: "test-mic", label: "Lecture microphone" }],
}));
vi.mock("../../rpc/transcription", () => ({
  transcriptionCommand: mocks.command,
  startLessonTalkThread: vi.fn(),
}));
vi.mock("@tanstack/react-router", async (load) => ({
  ...(await load<typeof import("@tanstack/react-router")>()),
  useRouter: () => ({ navigate: mocks.navigate }),
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("./lessonCaptions", () => ({ tapLessonCaptions: mocks.captions }));
vi.mock("./LessonTalk", () => ({
  lessonTalkAgent: () => null,
  LessonTalk: ({
    onEnded,
    closeRef,
  }: {
    onEnded: (error?: string) => void;
    closeRef: { current: (() => Promise<void>) | null };
  }) => {
    closeRef.current = mocks.closeCall;
    return <button onClick={() => onEnded("The conversation stopped.")}>Lesson answer</button>;
  },
}));
vi.mock("./TranscribeDialog", () => ({
  TranscribeDialog: () => <p>Transcribe saved recording</p>,
}));
vi.mock("../../state/entities", () => ({
  useProjects: () => [
    { id: "class", environmentId: "test", workspaceRoot: "/class", title: "Quantum course" },
  ],
}));
vi.mock("../../state/environments", () => ({
  usePrimaryEnvironmentId: () => "test",
  useEnvironmentProviders: () => new Map(),
}));

class Recorder extends EventTarget {
  static isTypeSupported() {
    return true;
  }
  state = "inactive";
  start() {
    this.state = "recording";
  }
  pause() {
    this.state = "paused";
  }
  resume() {
    this.state = "recording";
  }
  requestData() {
    this.dispatchEvent(new BlobEvent("dataavailable", { data: new Blob(["audio"]) }));
  }
  stop() {
    this.requestData();
    this.state = "inactive";
    this.dispatchEvent(new Event("stop"));
  }
}

it("records only after explicit start, handles permission denial, and keeps a global indicator through pause and resume", async () => {
  vi.stubGlobal("MediaRecorder", Recorder);
  const context = new AudioContext();
  const stream = context.createMediaStreamDestination().stream;
  mocks.microphone
    .mockRejectedValueOnce(new DOMException("denied", "NotAllowedError"))
    .mockResolvedValueOnce(stream);
  mocks.command.mockImplementation(async (action: string) =>
    action === "capture-start"
      ? { captured: true, language: "auto", talk: { openai: false } }
      : { source: "/class/Recording.webm" },
  );
  await using screen = await render(
    <>
      <button onClick={() => openRecordingCapture("class")}>Record</button>
      <RecordingCapture />
    </>,
  );
  try {
    await vi.waitFor(() =>
      expect(mocks.command).toHaveBeenCalledWith(
        "capture-recover",
        "/class",
        {},
        expect.any(AbortSignal),
      ),
    );
    await screen.getByRole("button", { name: "Record", exact: true }).click();
    expect(mocks.microphone).not.toHaveBeenCalled();
    await page.getByRole("button", { name: "Start recording" }).click();
    await expect.element(page.getByText(/Microphone access was denied/)).toBeVisible();
    await page.getByRole("button", { name: "Start recording" }).click();
    await expect.element(page.getByRole("meter", { name: "Microphone level" })).toBeVisible();
    expect(mocks.microphone).toHaveBeenLastCalledWith("test-mic");
    await expect.element(page.getByRole("dialog").getByText("0:01", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Pause", exact: true }).click();
    const timer = page.getByRole("dialog").getByText(/^[0-9]+:[0-9]{2}$/);
    const paused = timer.element().textContent;
    await page.getByRole("dialog").getByRole("button", { name: "Close" }).click();
    await page.getByRole("button", { name: /Recording paused/ }).click();
    await page.getByRole("button", { name: "Resume", exact: true }).click();
    await vi.waitFor(() => expect(timer.element().textContent).not.toBe(paused), { timeout: 2500 });
    const directory = import.meta.env.VITE_SCIENT_RECORDINGS_SCREENSHOTS;
    if (directory) {
      await page.screenshot({ path: `${directory}/record-audio.png` });
      document.documentElement.classList.add("dark");
      await page.screenshot({ path: `${directory}/record-audio-dark.png` });
      document.documentElement.classList.remove("dark");
    }
    await page.getByRole("button", { name: "Stop", exact: true }).click();
    await expect.element(page.getByText("Transcribe saved recording")).toBeVisible();
    await expect
      .element(page.getByRole("button", { name: /^Recording ·/ }))
      .not.toBeInTheDocument();
    expect(mocks.command).toHaveBeenCalledWith(
      "capture-chunk",
      "/class",
      expect.objectContaining({ index: 0 }),
    );
  } finally {
    vi.unstubAllGlobals();
    await context.close();
  }
});

it("shows live captions, pauses the lesson while you talk, and opens the lesson when it ends", async () => {
  vi.stubGlobal("MediaRecorder", Recorder);
  const context = new AudioContext();
  const stream = context.createMediaStreamDestination().stream;
  mocks.microphone.mockResolvedValue(stream);
  mocks.captions.mockImplementation(async (input: { onCaption: (caption: object) => void }) => {
    setTimeout(() =>
      input.onCaption({ window: 0, start: 0, end: 12, text: "Entropy always increases." }),
    );
    return {
      cut: vi.fn(),
      setPaused: mocks.setPaused,
      settle: async () => {},
      close: vi.fn(),
    };
  });
  mocks.command.mockImplementation(async (action: string) =>
    action === "capture-start"
      ? {
          captured: true,
          language: "en",
          captions: { kind: "local", modelId: "whisper" },
          talk: { openai: true },
        }
      : action === "capture-finish"
        ? { captured: true, source: "/class/Lesson.weba", transcription: "started" }
        : { captured: true },
  );
  await using screen = await render(
    <>
      <button onClick={() => openRecordingCapture("class")}>Record</button>
      <RecordingCapture />
    </>,
  );
  try {
    await screen.getByRole("button", { name: "Record", exact: true }).click();
    await expect.element(page.getByRole("heading", { name: "Record a lesson" })).toBeVisible();
    await page.getByRole("button", { name: "Start recording" }).click();
    await expect.element(page.getByText(/Entropy always increases\./)).toBeVisible();
    await page.getByRole("button", { name: "Talk", exact: true }).click();
    await expect.element(page.getByText(/Paused · Talking/)).toBeVisible();
    expect(mocks.setPaused).toHaveBeenLastCalledWith(true);
    await expect.element(page.getByRole("button", { name: "Lesson answer" })).toBeVisible();
    await page.getByRole("button", { name: "End and resume" }).click();
    // The call is closed before the lesson records again.
    await vi.waitFor(() => expect(mocks.setPaused).toHaveBeenLastCalledWith(false));
    expect(mocks.closeCall.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.setPaused.mock.invocationCallOrder.at(-1)!,
    );
    await page.getByRole("button", { name: "Talk", exact: true }).click();
    await page.getByRole("button", { name: "Lesson answer" }).click();
    await expect.element(page.getByText("The conversation stopped.")).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Resume", exact: true })).toBeVisible();
    const directory = import.meta.env.VITE_SCIENT_RECORDINGS_SCREENSHOTS;
    if (directory) await page.screenshot({ path: `${directory}/record-lesson.png` });
    await page.getByRole("button", { name: "Stop", exact: true }).click();
    await vi.waitFor(() =>
      expect(mocks.navigate).toHaveBeenCalledWith({
        to: "/recordings",
        search: { project: "class", source: "/class/Lesson.weba" },
      }),
    );
    expect(mocks.command).toHaveBeenCalledWith("capture-finish", "/class", {
      id: expect.any(String),
      lesson: { language: "en" },
    });
    expect(mocks.command).toHaveBeenCalledWith("capture-start", "/class", {
      id: expect.any(String),
      language: expect.any(String),
    });
  } finally {
    vi.unstubAllGlobals();
    await context.close();
  }
});
