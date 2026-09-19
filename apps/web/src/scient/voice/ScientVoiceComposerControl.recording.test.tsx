import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const controllerState = vi.hoisted(() => ({
  phase: "recording" as "idle" | "recording" | "correcting" | "setup-prompt",
  errorMessage: null as string | null,
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
      levels: [],
      elapsedMs: 0,
      errorMessage: controllerState.errorMessage,
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
  controllerState.phase = "recording";
  controllerState.errorMessage = null;
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

  it("stacks the recording surface above the footer's z-30 provider icon", () => {
    const markup = renderToStaticMarkup(
      <ScientVoiceComposerControl onTranscript={() => undefined} />,
    );

    expect(markup).toContain("z-40");
  });

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
});
