import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const controllerState = vi.hoisted(() => ({
  phase: "recording" as "recording" | "correcting",
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
      errorMessage: null,
      downloadPercent: 0,
      modelSnapshot: null,
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
});

describe("ScientVoiceComposerControl recording actions", () => {
  it("offers transcript insertion without exposing stale pending-answer submission", () => {
    const markup = renderToStaticMarkup(
      <ScientVoiceComposerControl onTranscript={() => undefined} />,
    );

    expect(markup).toContain('aria-label="Transcribe and insert (Enter)"');
    expect(markup).not.toContain('aria-label="Transcribe and send"');
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
});
