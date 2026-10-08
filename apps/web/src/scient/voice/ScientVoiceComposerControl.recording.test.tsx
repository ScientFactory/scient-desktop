import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { VoicePhase } from "./useScientVoiceController.ts";

const controllerState = vi.hoisted(() => ({
  phase: "recording" as VoicePhase,
  levels: [] as number[],
  errorMessage: null as string | null,
  microphonePermissionDenied: false,
  modelSnapshot: null as null | {
    runtimeAvailable: boolean;
    selectedModelId: null;
    recommendation: null;
    activeDownloadModelId: null;
    models: [];
  },
}));

vi.mock("./voiceClient.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./voiceClient.ts")>();
  return {
    ...actual,
    getVoiceBridge: () => ({}),
  };
});

vi.mock("./useScientVoiceController.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./useScientVoiceController.ts")>();
  return {
    ...actual,
    useScientVoiceController: () => ({
      phase: controllerState.phase,
      levels: controllerState.levels,
      elapsedMs: 0,
      errorMessage: controllerState.errorMessage,
      microphonePermissionDenied: controllerState.microphonePermissionDenied,
      downloadPercent: 0,
      modelSnapshot: controllerState.modelSnapshot,
      activate: async () => undefined,
      setupModel: async () => undefined,
      dismissSetup: () => undefined,
      stop: async () => undefined,
      cancel: async () => undefined,
      useOriginal: () => undefined,
    }),
  };
});

import { ScientVoiceComposerControl } from "./ScientVoiceComposerControl.tsx";

afterEach(() => {
  vi.unstubAllGlobals();
  controllerState.phase = "recording";
  controllerState.levels = [];
  controllerState.errorMessage = null;
  controllerState.microphonePermissionDenied = false;
  controllerState.modelSnapshot = null;
});

describe("ScientVoiceComposerControl recording actions", () => {
  it("offers transcript insertion without exposing stale pending-answer submission", () => {
    const markup = renderToStaticMarkup(
      <ScientVoiceComposerControl onTranscript={() => undefined} />,
    );

    expect(markup).toContain('aria-label="Transcribe and insert (Enter)"');
    expect(markup).not.toContain('aria-label="Transcribe and send"');
  });

  it("uses a transparent inline row instead of covering the provider and toolbar", () => {
    const markup = renderToStaticMarkup(
      <ScientVoiceComposerControl onTranscript={() => undefined} />,
    );

    expect(markup).toContain('data-scient-voice-surface="true"');
    expect(markup).not.toContain("bg-background");
    expect(markup).not.toContain("absolute inset-y-0");
    expect(markup).not.toContain('aria-label="Dictate a voice message"');
  });

  it.each(["composer", "compact"] as const)(
    "keeps the latest sample at the visible right edge with fixed bar geometry in %s",
    (presentation) => {
      controllerState.levels = [...Array<number>(32).fill(0), 0.2];
      const markup = renderToStaticMarkup(
        <ScientVoiceComposerControl presentation={presentation} onTranscript={() => undefined} />,
      );
      expect(markup).toContain("justify-end overflow-hidden");
      expect(markup.match(/w-0\.5 shrink-0 rounded-full bg-primary\/60/g)).toHaveLength(112);
      expect(markup).toContain("height:22px");
      expect(markup).toContain('dir="ltr"');
    },
  );

  it.each([
    ["requesting-permission", "Waiting for microphone access…", "Cancel microphone request"],
    ["transcribing", "Transcribing…", "Cancel transcription"],
    ["correcting", "Correcting transcript…", "Use original"],
  ] as const)(
    "centers %s with a separate action rail on both surfaces",
    (phase, status, action) => {
      controllerState.phase = phase;
      for (const presentation of ["composer", "compact"] as const) {
        const markup = renderToStaticMarkup(
          <ScientVoiceComposerControl presentation={presentation} onTranscript={() => undefined} />,
        );
        expect(markup).toContain('data-scient-voice-center="true"');
        expect(markup).toContain("justify-center");
        expect(markup).toContain('role="status"');
        expect(markup).toContain(status);
        expect(markup).toContain(action);
        expect(markup).toContain('data-scient-voice-actions="true"');
        expect(markup).not.toContain("bg-background");
      }
    },
  );

  it("offers transcript submission when the host supplies a submit callback", () => {
    const markup = renderToStaticMarkup(
      <ScientVoiceComposerControl
        onTranscript={() => undefined}
        onRequestSubmit={() => undefined}
      />,
    );

    expect(markup).toContain('aria-label="Transcribe and send"');
  });

  it("offers the exact local transcript while correction is pending", () => {
    controllerState.phase = "correcting";
    const markup = renderToStaticMarkup(
      <ScientVoiceComposerControl onTranscript={() => undefined} />,
    );

    expect(markup).toContain("Correcting transcript…");
    expect(markup).toContain("Use original");
  });

  it("does not turn a ready-only consumer into another model setup surface", () => {
    controllerState.phase = "setup-prompt";
    const markup = renderToStaticMarkup(
      <ScientVoiceComposerControl
        onTranscript={() => undefined}
        readyModelOnly
        ariaLabel="Dictate citation comment"
      />,
    );

    expect(markup).toBe("");
    expect(markup).not.toContain("Choose voice model");
  });

  it("hides a ready-only control when activation can no longer verify setup", () => {
    controllerState.phase = "idle";
    controllerState.errorMessage = "Voice setup could not be checked";
    const markup = renderToStaticMarkup(
      <ScientVoiceComposerControl onTranscript={() => undefined} readyModelOnly />,
    );

    expect(markup).toBe("");
  });

  it("offers macOS Settings recovery when microphone access was denied", () => {
    controllerState.phase = "idle";
    controllerState.errorMessage = "Allow microphone access, then try again.";
    controllerState.microphonePermissionDenied = true;
    vi.stubGlobal("window", {
      desktopBridge: {
        getClientPlatform: () => "darwin",
        openSystemSettings: vi.fn().mockResolvedValue(true),
      },
    });

    const markup = renderToStaticMarkup(
      <ScientVoiceComposerControl onTranscript={() => undefined} />,
    );

    expect(markup).toContain("Open Settings");
    expect(markup).toContain("Allow microphone access");
  });
});
