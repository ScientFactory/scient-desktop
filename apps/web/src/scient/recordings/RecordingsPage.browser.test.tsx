import { expect, it, vi } from "vite-plus/test";
import { page } from "vitest/browser";
import { render } from "../../../test/render";
import lectureVideoUrl from "../../../test/fixtures/recording-lecture.mp4?url";
import "../../index.css";
import { useState } from "react";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { scientRecordingSurface } from "../rightPanel/surfaces";
import RecordingPanel from "./RecordingPanel";
import { RecordingsPage } from "./RecordingsPage";
import { TranscribeDialog } from "./TranscribeDialog";

const fixtures = vi.hoisted(() => {
  const job = {
    id: "2026-11-22-lecture-12345678",
    source: "/class/Lecture 4.mp4",
    input: { size: 29000 },
    settings: { engine: "local", model: "local", language: "he" },
  };
  return {
    job,
    command: vi.fn(),
    consent: vi.fn(),
    makeNotes: vi.fn(),
    addFiles: vi.fn(),
    setPrompt: vi.fn(),
    newThread: vi.fn(async () => ({ draftId: "recording-draft", threadId: "recording-thread" })),
    linkThread: vi.fn(),
    readThread: vi.fn(),
    openPanel: vi.fn(),
    maximize: vi.fn(),
    setMaximized: vi.fn(),
    importFile: vi.fn(),
  };
});

vi.mock("../../rpc/transcription", () => ({
  transcriptionCommand: fixtures.command,
  consentToTranscriptionEngine: fixtures.consent,
  listRecordingThreads: async () => [],
  listRecordingNotes: async () => [],
  makeRecordingNotes: fixtures.makeNotes,
  linkRecordingThread: fixtures.linkThread,
}));
vi.mock("../../rightPanelStore", () => ({
  useRightPanelStore: {
    getState: () => ({
      openFile: vi.fn(),
      openScient: fixtures.openPanel,
      requestMaximize: fixtures.maximize,
      setMaximized: fixtures.setMaximized,
    }),
  },
}));
vi.mock("../../hooks/useHandleNewThread", () => ({
  useNewThreadHandler: () => fixtures.newThread,
}));
vi.mock("../../composerDraftStore", async () => {
  const Schema = await import("effect/Schema");
  return {
    DraftId: Schema.String.pipe(Schema.brand("DraftId")),
    useComposerDraftStore: {
      getState: () => ({
        addFiles: fixtures.addFiles,
        getDraftIdByRef: () => "recording-draft",
        getDraftThreadByRef: () => null,
        getComposerDraft: () => undefined,
        setPrompt: fixtures.setPrompt,
      }),
    },
  };
});
vi.mock("../../components/chat/composerAttachmentFiles", () => ({
  composerFileAttachmentMimeType: (file: File) => file.type,
}));
vi.mock("../../hooks/useSettings", () => ({
  useClientSettings: (select: (settings: { contentDirection: string }) => unknown) =>
    select({ contentDirection: "auto" }),
}));
vi.mock("../../speech/runEnvironmentSpeech", () => ({ runEnvironmentSpeech: vi.fn() }));
vi.mock("@t3tools/client-runtime/voice-input", () => ({ downloadEnvironmentSpeechModel: vi.fn() }));
vi.mock("./CorrectionModelPicker", () => ({
  CorrectionModelPicker: ({
    selection,
    onChange,
    label,
  }: {
    selection?: { model: string };
    label?: string;
    onChange: (model: { instanceId: string; model: string }) => void;
  }) => (
    <button
      type="button"
      onClick={() => onChange({ instanceId: "test-text", model: "Test text model" })}
    >
      {selection?.model ?? label ?? "Choose correction model"}
    </button>
  ),
}));
vi.mock("./copyRecording", () => ({ copyRecording: {} }));
vi.mock("../../state/entities", () => ({
  readThreadShell: fixtures.readThread,
  useProjects: () => [
    { id: "class", environmentId: "test", workspaceRoot: "/class", title: "Quantum course" },
  ],
}));
vi.mock("../../state/environments", () => ({
  usePrimaryEnvironmentId: () => "test",
  readPrimaryEnvironmentId: () => "test",
  useEnvironmentHttpBaseUrl: () => window.location.origin,
}));
vi.mock("../../state/session", () => ({
  useEnvironmentScope: () => true,
  readPreparedConnection: () => null,
}));
vi.mock("../../state/assets", () => ({ assetEnvironment: {} }));
vi.mock("../../state/use-atom-query-runner", () => ({
  useAtomQueryRunner: () => async () => ({
    _tag: "Success",
    value: { relativeUrl: lectureVideoUrl },
  }),
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => fixtures.importFile }));

function PanelHarness({ fromThread }: { fromThread?: string } = {}) {
  const [tab, setTab] = useState<{
    thread: ScopedThreadRef;
    surface: ReturnType<typeof scientRecordingSurface>;
  }>();
  const [maximized, setMaximized] = useState(true);
  const [recordingLabel, setRecordingLabel] = useState("");
  fixtures.addFiles.mockImplementation((_target, files) => {
    const source = files[0]?.source;
    if (source?._tag === "recording-transcript") setRecordingLabel(`${source.name} · 0:00–0:29`);
  });
  fixtures.openPanel.mockImplementation((thread, surface) => setTab({ thread, surface }));
  fixtures.setMaximized.mockImplementation((_thread, value) => setMaximized(value));
  return tab ? (
    <div
      className="h-full"
      style={
        maximized
          ? undefined
          : { display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)" }
      }
    >
      {!maximized && (
        <aside className="flex flex-col justify-between border-e p-5">
          <h2>Recording conversation</h2>
          <div className="space-y-2 rounded-xl border bg-card p-3">
            {recordingLabel && (
              <span className="rounded-full border bg-muted px-2 py-1 text-xs">
                {recordingLabel}
              </span>
            )}
            <textarea
              ref={(element) => element?.focus()}
              aria-label="Message"
              placeholder="Ask about this recording…"
              className="w-full"
            />
          </div>
        </aside>
      )}
      <RecordingPanel
        surface={tab.surface}
        threadRef={tab.thread}
        onRevealComposer={() => setMaximized(false)}
        onClose={() => setTab(undefined)}
      />
    </div>
  ) : (
    <RecordingsPage {...(fromThread ? { fromThread } : {})} />
  );
}

async function capture(name: string) {
  const directory = import.meta.env.VITE_SCIENT_RECORDINGS_SCREENSHOTS;
  if (!directory) return;
  for (const animation of document.getAnimations()) {
    if (animation.effect?.getTiming().iterations !== Infinity) animation.finish();
  }
  await page.screenshot({ path: `${directory}/${name}.png` });
  document.documentElement.classList.add("dark");
  try {
    await page.screenshot({ path: `${directory}/${name}-dark.png` });
  } finally {
    document.documentElement.classList.remove("dark");
  }
}

it("shows interrupted work as paused and saves a decision from the transcript", async () => {
  const completed = {
    job: fixtures.job,
    reviewCount: 1,
    modelName: "Whisper Large v3",
    duration: 5400,
    created: 1795382400001,
    state: { stage: "completed", completed: 2 },
  };
  fixtures.command.mockImplementation(
    async (action: string, _project: string, input: { id?: string }) => {
      if (action === "media-list")
        return {
          media: [
            { source: "/class/Unstarted.m4a", size: 16384, created: 1795382400000, duration: 5412 },
            { source: "/class/Queued.m4a", size: 16000, created: 1795382400002, queued: true },
          ],
        };
      if (action === "list")
        return [
          completed,
          {
            job: {
              ...fixtures.job,
              id: "2026-11-22-meeting-12345678",
              source: "/class/Meeting.m4a",
            },
            state: { stage: "interrupted", completed: 4, total: 10 },
          },
        ];
      if (action === "revision" && input.id === fixtures.job.id)
        return {
          segments: [
            {
              id: "opening-en",
              language: "en",
              start: 0,
              end: 4,
              text: "ANA BELL: Today we look at how two waves interfere.",
            },
            {
              id: "opening-en-2",
              language: "en",
              start: 4,
              end: 8,
              text: "Start with the two-state example on the slide.",
            },
            { id: "segment", language: "he", start: 12, end: 19, text: "שלום לכולם" },
            {
              id: "opening-he",
              language: "he",
              start: 20,
              end: 24,
              text: "היום נלמד איך לחשב את ההסתברות של תוצאת המדידה.",
            },
            {
              id: "opening-he-2",
              language: "he",
              start: 24,
              end: 29,
              text: "נתחיל בדוגמה של שני מצבים (superposition).",
            },
          ],
          reviewItems: [
            {
              segmentId: "segment",
              before: "שלום לכולם",
              after: "שלום לכולן",
              reason: "Confirm wording",
            },
          ],
        };
      return completed;
    },
  );
  await page.viewport(1024, 768);
  await using screen = await render(
    <div className="h-screen">
      <PanelHarness />
    </div>,
  );
  await expect.element(screen.getByText("Paused")).toBeVisible();
  await expect.element(screen.getByText("Not transcribed")).toBeVisible();
  await expect.element(screen.getByRole("checkbox", { name: "Select Queued.m4a" })).toBeDisabled();
  await expect.element(screen.getByText(/Hebrew/).first()).toBeVisible();
  await expect.element(screen.getByText(/Whisper Large v3/)).not.toBeInTheDocument();
  expect(
    screen.getByText("Lecture 4.mp4", { exact: true }).element().getBoundingClientRect().left,
  ).toBe(screen.getByText("Unstarted.m4a", { exact: true }).element().getBoundingClientRect().left);
  await capture("recordings");
  const search = screen.getByRole("textbox", { name: "Search recordings and transcripts" });
  await search.fill("unmatched search");
  await expect.element(screen.getByText("No matching recordings")).toBeVisible();
  await capture("recordings-no-results");
  await search.fill("");

  await screen.getByRole("button", { name: /Lecture 4/ }).click();
  await expect
    .element(screen.getByRole("listitem").getByText("שלום לכולם", { exact: true }).first())
    .toBeVisible();
  await screen.getByRole("button", { name: "Notes", exact: true }).click();
  fixtures.makeNotes
    .mockResolvedValueOnce({ needsModel: true })
    .mockResolvedValueOnce({ threadId: "notes" });
  await screen.getByRole("button", { name: "Summary", exact: true }).click();
  await expect
    .element(screen.getByRole("button", { name: "Choose a model for notes" }))
    .toBeVisible();
  await expect
    .element(screen.getByRole("button", { name: "Make notes", exact: true }))
    .toBeDisabled();
  await capture("recording-notes-model");
  await screen.getByRole("button", { name: "Choose a model for notes" }).click();
  await screen.getByRole("button", { name: "Make notes", exact: true }).click();
  expect(fixtures.makeNotes).toHaveBeenCalledWith("/class", fixtures.job.id, "summary", {
    instanceId: "test-text",
    model: "Test text model",
  });
  await screen.getByRole("button", { name: "Transcript", exact: true }).click();
  expect(fixtures.makeNotes).toHaveBeenCalledWith("/class", fixtures.job.id, "summary");
  await expect.element(screen.getByRole("slider", { name: "Playback position" })).toBeEnabled();
  await expect.element(screen.getByRole("combobox", { name: "Version" })).not.toBeInTheDocument();
  await expect.element(screen.getByText(/Transcribed through/)).not.toBeInTheDocument();
  expect(fixtures.maximize).toHaveBeenCalledWith(
    expect.objectContaining({ threadId: "recording-thread" }),
  );
  await capture("recording-narrow");
  await page.viewport(1440, 900);
  await capture("recording-maximized");
  const stage = document.querySelector<HTMLElement>("[data-recording-focus]")!;
  stage.focus();
  stage.dispatchEvent(new KeyboardEvent("keydown", { key: "t", bubbles: true }));
  stage.dispatchEvent(new KeyboardEvent("keydown", { key: "m", bubbles: true }));
  await expect
    .element(screen.getByRole("button", { name: "Mute (M)" }))
    .toHaveAttribute("aria-pressed", "true");
  await expect
    .element(screen.getByRole("button", { name: "Theater (T)" }))
    .toHaveAttribute("aria-pressed", "true");
  await capture("recording-theater");
  await screen.getByRole("button", { name: "Full screen (F)" }).click();
  await expect
    .element(screen.getByRole("button", { name: "Full screen (F)" }))
    .toHaveAttribute("aria-pressed", "true");
  expect(document.fullscreenElement).toBe(stage);
  const frame = stage.querySelector("video")!;
  const transport = stage.querySelector<HTMLElement>(".recording-transport")!;
  expect(frame.getBoundingClientRect().height).toBe(window.innerHeight);
  expect(frame.getBoundingClientRect().width).toBe(window.innerWidth);
  expect(getComputedStyle(frame).objectFit).toBe("contain");
  expect(getComputedStyle(stage).backgroundColor).toBe("rgb(0, 0, 0)");
  expect(getComputedStyle(transport).backgroundImage).toContain("linear-gradient");
  await capture("recording-fullscreen");
  await vi.waitFor(() => expect(transport.classList.contains("opacity-0")).toBe(true), {
    timeout: 3500,
  });
  stage.dispatchEvent(new PointerEvent("pointermove", { bubbles: true }));
  await vi.waitFor(() => expect(transport.classList.contains("opacity-0")).toBe(false));
  stage.dispatchEvent(new KeyboardEvent("keydown", { key: "f", bubbles: true }));
  await vi.waitFor(() => expect(document.fullscreenElement).toBeNull());

  await screen.getByRole("button", { name: "Ask in chat" }).click();
  await vi.waitFor(() =>
    expect(fixtures.addFiles).toHaveBeenCalledWith("recording-draft", [
      expect.objectContaining({
        type: "file",
        name: "Lecture 4.mp4.transcript.md",
        source: {
          _tag: "recording-transcript",
          name: "Lecture 4.mp4",
          revision: fixtures.job.id,
          path: `Transcripts/${fixtures.job.id}/transcript.json`,
          start: 0,
          end: 29,
        },
        file: expect.any(File),
        mimeType: "text/markdown",
      }),
    ]),
  );
  expect(fixtures.linkThread).toHaveBeenCalledWith("/class", fixtures.job.id, "recording-thread", {
    start: 0,
    end: 29,
  });
  expect(fixtures.setPrompt).not.toHaveBeenCalled();
  const attachment = fixtures.addFiles.mock.calls.at(-1)?.[1]?.[0];
  expect(await attachment.file.text()).toContain(`Transcripts/${fixtures.job.id}/transcript.json`);
  await expect.element(screen.getByRole("textbox", { name: "Message" })).toHaveValue("");
  await expect.element(screen.getByRole("textbox", { name: "Message" })).toHaveFocus();
  await expect.element(screen.getByRole("heading", { name: "Lecture 4.mp4" })).toBeVisible();
  await expect
    .element(screen.getByText("Lecture 4.mp4 · 0:00–0:29", { exact: true }))
    .toBeVisible();
  await page.viewport(900, 800);
  await expect.element(screen.getByRole("button", { name: "Volume controls" })).toBeVisible();
  const compactControls = ["Volume controls", "Theater (T)", "Full screen (F)"];
  const buttonCenters = compactControls.map((name) => {
    const { top, height } = screen
      .getByRole("button", { name, exact: true })
      .element()
      .getBoundingClientRect();
    return top + height / 2;
  });
  expect(Math.max(...buttonCenters) - Math.min(...buttonCenters)).toBeLessThan(1);
  await expect.element(screen.getByRole("combobox", { name: "Playback speed" })).toBeVisible();
  await screen.getByRole("button", { name: "Volume controls" }).click();
  await expect.element(page.getByRole("slider", { name: "Volume", exact: true })).toBeVisible();
  await capture("recording-compact-volume");
  await screen.getByRole("button", { name: "Volume controls" }).click();
  await capture("recording-ask-chip");
  await screen.getByRole("button", { name: "Review שלום לכולם" }).click();
  await expect.element(page.getByRole("button", { name: "Accept", exact: true })).toBeVisible();
  await capture("recording-review");
  await page.getByRole("button", { name: "Accept", exact: true }).click();
  expect(fixtures.command).toHaveBeenCalledWith("review-accept", "/class", {
    id: fixtures.job.id,
    item: 0,
  });
});

it("opens a recording in the chat that opened its project recordings", async () => {
  fixtures.command.mockImplementation(async (action: string) => {
    if (action === "media-list") return { media: [] };
    if (action === "list") return [{ job: fixtures.job, state: { stage: "completed" } }];
    return { segments: [] };
  });
  fixtures.readThread.mockReturnValue({ projectId: "class" });
  fixtures.newThread.mockClear();
  fixtures.openPanel.mockClear();
  fixtures.linkThread.mockClear();
  try {
    await using screen = await render(
      <div className="h-screen">
        <PanelHarness fromThread="current-chat" />
      </div>,
    );
    await screen.getByRole("button", { name: /Lecture 4\.mp4/ }).click();
    await expect
      .poll(() => fixtures.openPanel.mock.calls.at(-1)?.[0].threadId)
      .toBe("current-chat");
    await expect
      .poll(() => fixtures.linkThread.mock.calls.at(-1))
      .toEqual(["/class", fixtures.job.id, "current-chat"]);
    expect(fixtures.newThread).not.toHaveBeenCalled();
  } finally {
    fixtures.readThread.mockReset();
  }
});

it("starts with the recommended installed engine and preserves the server correction default", async () => {
  fixtures.command.mockReset().mockImplementation(async (action: string) => {
    if (action === "inventory")
      return {
        local: [
          {
            id: "local",
            name: "ivrit.ai Whisper turbo",
            installed: true,
            languages: ["he"],
            size: 1600000000,
            accuracy: { he: { grade: "A", errorPercent: 8.1 } },
            secondsPer30s: { accelerated: 1.4 },
          },
          {
            id: "large",
            name: "Whisper large-v3",
            installed: true,
            size: 3100000000,
            accuracy: { he: { grade: "B", errorPercent: 13.5 } },
            secondsPer30s: { accelerated: 2.5 },
          },
          {
            id: "parakeet",
            name: "Parakeet v3",
            installed: true,
            size: 650000000,
            secondsPer30s: { accelerated: 0.6 },
          },
          {
            id: "medium",
            name: "Whisper medium",
            installed: false,
            size: 1400000000,
            secondsPer30s: { accelerated: null },
          },
        ],
        chatgpt: { enabled: false, signedIn: false },
        cloud: [
          {
            id: "cloud",
            model: "gpt-transcribe",
            provider: "openai",
            origin: "https://api.openai.com",
            audioHourUsd: 0.27,
          },
          {
            id: "compatible",
            model: "external-model",
            provider: "compatible",
            origin: "https://speech.example.test:8443",
          },
          {
            id: "legacy",
            model: "whisper-1",
            provider: "compatible",
            accountName: "Legacy endpoint",
          },
        ],
        recommendations: { he: { id: "local", installed: true } },
      };
    if (action === "sample-language") return { detectedLanguage: "he" };
    if (action === "discover-subtitles") return { duration: 5400, tracks: [], sidecars: [] };
    if (action === "words-list") return [{ term: "Schrödinger", source: "user", language: "und" }];
    return { job: fixtures.job, state: { stage: "decoding", completed: 0 } };
  });
  await page.viewport(1024, 768);
  await using _screen = await render(
    <TranscribeDialog
      project="/class"
      source={fixtures.job.source}
      projectTitle="Quantum course"
      title="Hebrew seminar — Quantum foundations.mp4"
      onClose={() => {}}
      onStart={() => {}}
    />,
  );
  await expect.element(page.getByRole("radio", { name: /ivrit.ai/ })).toBeChecked();
  await expect
    .element(page.getByRole("combobox", { name: "Language", exact: true }))
    .toHaveTextContent("Hebrew (detected)");
  expect(fixtures.command).toHaveBeenCalledWith(
    "inventory",
    "/class",
    { language: "he", details: true },
    expect.any(AbortSignal),
  );
  await page.viewport(1200, 900);
  await expect.element(page.getByRole("radio", { name: "Parakeet v3" })).not.toBeInTheDocument();
  await expect.element(page.getByRole("button", { name: "Sign in" })).not.toBeInTheDocument();
  await capture("transcribe");
  await page.getByRole("button", { name: "More engines" }).click();
  await expect.element(page.getByRole("radio", { name: "Parakeet v3" })).toBeVisible();
  await expect.element(page.getByRole("link", { name: "Sign in" })).toBeVisible();
  await capture("transcribe-options");

  await page.getByRole("radio", { name: /gpt-transcribe/ }).click();
  await expect
    .element(page.getByText(/0\.27 per audio hour.*0\.41 for this recording/).first())
    .toBeVisible();
  await expect
    .element(page.getByText("Cost unknown for this provider", { exact: false }).first())
    .toBeVisible();
  await expect.element(page.getByText("Uses your speech.example.test:8443 key")).toBeVisible();
  await expect.element(page.getByText("Uses your Legacy endpoint key")).toBeVisible();
  await expect.element(page.getByText("Retiring Feb 2027", { exact: true })).toBeVisible();
  await expect.element(page.getByText(/Time estimate unavailable/)).not.toBeInTheDocument();
  await capture("transcribe-cloud");
  await page.getByRole("radio", { name: /ivrit.ai/ }).click();
  await page.getByRole("button", { name: "Transcribe", exact: true }).click();
  expect(fixtures.command).toHaveBeenCalledWith("start", "/class", {
    source: fixtures.job.source,
    model: "local",
    engine: "local",
    language: "he",
  });
});

it("estimates a Thorough rerun with the chosen correction model and recording Words scope", async () => {
  fixtures.command
    .mockReset()
    .mockImplementation(async (action: string, _project: string, input: { level?: string }) => {
      if (action === "sample-language") return { detectedLanguage: "he" };
      if (action === "inventory")
        return {
          local: [
            { id: "local", name: "Whisper", installed: true, secondsPer30s: { accelerated: 1 } },
          ],
          chatgpt: { enabled: false, signedIn: false },
          cloud: [],
          recommendations: { he: { id: "local", installed: true } },
        };
      if (action === "discover-subtitles") return { duration: 5400, tracks: [], sidecars: [] };
      if (action === "words-list")
        return input.level === "recording"
          ? [{ term: "Dirac", source: "user", language: "und" }]
          : [];
      if (action === "correction-estimate")
        return { estimateId: "preview-id", estimate: { wallSeconds: 180 } };
      return { job: fixtures.job, state: { stage: "decoding", completed: 0 } };
    });
  await using _screen = await render(
    <TranscribeDialog
      project="/class"
      source={fixtures.job.source}
      projectTitle="Quantum course"
      title="Lecture 4.mp4"
      previousId={fixtures.job.id}
      onClose={() => {}}
      onStart={() => {}}
    />,
  );
  await page.getByRole("button", { name: "Choose correction model" }).click();
  await page.getByRole("button", { name: "Thorough" }).click();
  await expect.element(page.getByText("Correction estimate: up to 3:00")).toBeVisible();
  await page.getByText("Show saved words").click();
  await expect.element(page.getByText("Dirac", { exact: true })).toBeVisible();
  await capture("transcribe-correction");
  await page.getByRole("button", { name: "Transcribe", exact: true }).click();
  const correctionModel = { instanceId: "test-text", model: "Test text model" };
  expect(fixtures.command).toHaveBeenCalledWith(
    "correction-estimate",
    "/class",
    {
      source: fixtures.job.source,
      language: "he",
      mode: "thorough",
      useWords: true,
      resume: fixtures.job.id,
      correctionModel,
    },
    expect.any(AbortSignal),
  );
  expect(fixtures.command).toHaveBeenCalledWith("start", "/class", {
    source: fixtures.job.source,
    language: "he",
    engine: "local",
    model: "local",
    mode: "thorough",
    revisionMode: "rerun",
    resume: fixtures.job.id,
    correctionModel,
    estimateId: "preview-id",
  });
});

it("queues two selected recordings with one engine choice", async () => {
  const sources = ["/class/First.m4a", "/class/Second.m4a"];
  fixtures.command.mockReset().mockImplementation(async (action: string) => {
    if (action === "list") return [];
    if (action === "media-list")
      return { media: sources.map((source) => ({ source, size: 16000, created: 1 })) };
    if (action === "inventory")
      return {
        local: [
          { id: "local", name: "Whisper", installed: true, secondsPer30s: { accelerated: 1 } },
        ],
        chatgpt: { enabled: false, signedIn: false },
        cloud: [],
        recommendations: { auto: { id: "local", installed: true } },
      };
    if (action === "start-batch") return { queued: 2 };
    throw new Error("Unexpected batch request");
  });
  await using screen = await render(
    <div className="h-screen">
      <PanelHarness />
    </div>,
  );
  await screen.getByRole("checkbox", { name: "Select First.m4a" }).click();
  await screen.getByRole("checkbox", { name: "Select Second.m4a" }).click();
  await screen.getByRole("button", { name: "Transcribe selected" }).click();
  await page.getByRole("button", { name: "Transcribe", exact: true }).click();
  expect(fixtures.command).toHaveBeenCalledWith("start-batch", "/class", {
    source: sources[0],
    sources,
    engine: "local",
    model: "local",
    language: "auto",
  });
});

it("adds a file already in the project where it is, without copying it", async () => {
  const source = "/class/Downloads/Talk.mp4";
  vi.stubGlobal("desktopBridge", {
    getPathForFile: () => source,
    getLocalEnvironmentBootstraps: () => [],
  });
  fixtures.importFile.mockReset();
  fixtures.command.mockReset().mockImplementation(async (action: string) => {
    if (action === "list") return [];
    if (action === "media-list") return { media: [] };
    if (action === "media-register") return { media: [{ source, size: 5, created: 1 }] };
    if (action === "inventory")
      return {
        local: [],
        chatgpt: { enabled: false, signedIn: false },
        cloud: [],
        recommendations: {},
      };
    return { detectedLanguage: null };
  });
  try {
    await using screen = await render(<RecordingsPage lockedProject="class" />);
    const picker = screen.container.querySelector<HTMLInputElement>('input[accept^="audio/"]')!;
    const files = new DataTransfer();
    files.items.add(new File(["video"], "Talk.mp4", { type: "video/mp4" }));
    picker.files = files.files;
    picker.dispatchEvent(new Event("change", { bubbles: true }));
    await expect.element(page.getByRole("dialog")).toBeVisible();
    expect(fixtures.command).toHaveBeenCalledWith("media-register", "/class", {
      source,
      onlyInProject: true,
    });
    expect(fixtures.importFile).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
  }
});

it("groups independent runs of the same source and opens the newest version with older versions available", async () => {
  const newest = { ...fixtures.job, id: "2026-11-24-lecture-12345678" };
  const older = { ...fixtures.job, id: "2026-11-23-lecture-12345678" };
  const queued = {
    ...fixtures.job,
    id: "2026-11-22-seminar-12345678",
    source: "/class/Seminar.mp4",
  };
  fixtures.command
    .mockReset()
    .mockImplementation(
      async (action: string, _project: string, input: { id?: string; query?: string }) => {
        if (action === "list")
          return [
            {
              job: { ...newest, recording: newest.id },
              created: 1795478400000,
              state: { stage: "interrupted", completed: 1 },
            },
            {
              job: { ...older, recording: older.id },
              ...(input.query ? { snippet: "Earlier transcript", matchTime: 0 } : {}),
              created: 1795392000000,
              state: { stage: "completed", completed: 2 },
            },
            {
              job: { ...fixtures.job, recording: fixtures.job.id },
              created: 1795305600000,
              state: { stage: "completed", completed: 2 },
            },
            { job: queued, created: 1795305600001, state: { stage: "completed", completed: 2 } },
          ];
        if (action === "media-list")
          return {
            media: [
              { source: newest.source, size: 29000, created: 1795305600000 },
              { source: queued.source, size: 29000, created: 1795305600001, queued: true },
            ],
          };
        if (action === "revision")
          return {
            segments: [
              {
                id: "segment",
                start: 0,
                end: 1,
                language: "en",
                text: input.id === newest.id ? "Newest transcript" : "Earlier transcript",
              },
              {
                id: "late-he",
                start: 90_123.25,
                end: 90_129,
                language: "he",
                text: "שלום לכולם",
                speaker: "דנה",
              },
            ],
          };
        throw new Error("Unexpected request");
      },
    );

  await using screen = await render(
    <div className="h-screen">
      <PanelHarness />
    </div>,
  );
  const lecture = screen.getByRole("button", { name: /Lecture 4/ });
  await expect.element(lecture.getByText("Paused", { exact: true })).toBeVisible();
  await expect
    .element(screen.getByRole("button", { name: /Seminar/ }).getByText("Queued", { exact: true }))
    .toBeVisible();

  await lecture.click();
  await expect.element(screen.getByText("Newest transcript")).toBeVisible();
  await screen.getByRole("combobox", { name: "Version" }).click();
  await expect.element(page.getByRole("option", { name: /^Version 3\b/ })).toBeVisible();
  await expect.element(page.getByRole("option", { name: /^Version 1\b/ })).toBeVisible();
  await page.getByRole("option", { name: /^Version 2\b/ }).click();
  await expect
    .element(screen.getByRole("combobox", { name: "Version" }))
    .toHaveTextContent("Version 2");
  await expect.element(screen.getByText("Earlier transcript")).toBeVisible();
  await screen.getByRole("button", { name: "Back to recordings" }).click();
  await screen.getByRole("textbox", { name: "Search recordings and transcripts" }).fill("Earlier");
  await expect.element(screen.getByRole("button", { name: /Open match/ })).toBeVisible();
  await capture("recordings-search");
  await screen.getByRole("button", { name: /Open match/ }).click();
  await expect.element(screen.getByText("Earlier transcript")).toBeVisible();
  await expect.element(screen.getByRole("textbox", { name: "Find text" })).toHaveValue("Earlier");
  const clipboard = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
  const files: { name: string; href: string }[] = [];
  const snapshots: Blob[] = [];
  const createUrl = vi.spyOn(URL, "createObjectURL").mockImplementation((blob) => {
    snapshots.push(blob as Blob);
    return `blob:transcript-test-${snapshots.length}`;
  });
  const download = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    files.push({ name: this.download, href: this.href });
  });
  const menu = screen.getByRole("button", { name: "More recording actions" });
  try {
    await menu.click();
    await expect.element(page.getByRole("menuitem", { name: "Copy transcript" })).toBeVisible();
    await capture("recording-export");
    await page.getByRole("menuitem", { name: "Copy transcript" }).click();
    expect(clipboard).toHaveBeenCalledWith("Earlier transcript\n\nדנה: שלום לכולם");
    const exports = [
      ["md", "Markdown (.md)"],
      ["txt", "Plain text (.txt)"],
      ["srt", "Subtitles (.srt)"],
      ["vtt", "WebVTT (.vtt)"],
    ] as const;
    for (const [index, [format, label]] of exports.entries()) {
      await menu.click();
      await page.getByRole("menuitem", { name: "Export transcript" }).click();
      await page.getByRole("menuitem", { name: label }).click();
      expect(files[index]?.name).toBe(`Lecture 4.mp4.${format}`);
      const text = await snapshots[index]!.text();
      expect(text).toContain("דנה: שלום לכולם");
      if (format === "srt") expect(text).toContain("25:02:03,250 --> 25:02:09,000");
      if (format === "vtt") expect(text).toContain("25:02:03.250 --> 25:02:09.000");
    }
  } finally {
    clipboard.mockRestore();
    createUrl.mockRestore();
    download.mockRestore();
  }
});

it("blocks transcription and explains setup when the server has no FFmpeg", async () => {
  fixtures.command.mockImplementation(async (action: string) => {
    if (action === "inventory") {
      return {
        mediaAvailable: false,
        local: [
          {
            id: "local",
            name: "Local model",
            installed: true,
            secondsPer30s: { accelerated: null },
          },
        ],
        chatgpt: { enabled: false, signedIn: false },
        cloud: [],
        recommendations: {},
      };
    }
    if (action === "sample-language") return { detectedLanguage: null };
    if (action === "discover-subtitles") return { tracks: [], sidecars: [] };
    return [];
  });
  await using screen = await render(
    <TranscribeDialog
      project="/class"
      source={fixtures.job.source}
      title="Lecture 4.mp4"
      onClose={() => {}}
      onStart={() => {}}
    />,
  );

  await expect.element(screen.getByText(/Install FFmpeg/)).toBeVisible();
  await expect.element(screen.getByRole("button", { name: "Transcribe" })).toBeDisabled();
  await capture("transcribe-ffmpeg-required");
});
