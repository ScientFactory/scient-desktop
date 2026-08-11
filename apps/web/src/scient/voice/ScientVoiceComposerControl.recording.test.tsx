import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

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
      phase: "recording" as const,
      levels: [],
      elapsedMs: 0,
      errorMessage: null,
      downloadPercent: 0,
      activate: async () => undefined,
      setupModel: async () => undefined,
      dismissSetup: () => undefined,
      stop: async () => undefined,
      cancel: async () => undefined,
    }),
  };
});

import { ScientVoiceComposerControl } from "./ScientVoiceComposerControl.tsx";

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
});
