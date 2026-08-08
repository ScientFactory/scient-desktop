// The repo has no jsdom/@testing-library/react (default test env is `node`), so
// DOM click-through isn't available. We render with `react-dom/server` — the
// same approach the neighbouring composer tests use — to assert the
// support-gated rendering, and cover the interaction/branching logic through
// the component's exported pure helpers. `window.desktopBridge.voice` and
// `getUserMedia` are stubbed per the mocking requirement.

import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  EMPTY_TRANSCRIPT_MESSAGE,
  MODEL_DOWNLOAD_LABEL,
  ScientVoiceComposerControl,
  describeTranscriptionError,
  describeVoiceRecorderError,
  formatVoiceTimer,
} from "./ScientVoiceComposerControl.tsx";

function stubVoiceBridge(): void {
  const voice = {
    getCapability: vi.fn().mockResolvedValue({
      probe: { arch: "arm64", cpuCount: 8, totalMemBytes: 0, hasAvx2: false },
      tier: "fast",
    }),
    getModelState: vi.fn().mockResolvedValue({ state: "missing" }),
    downloadModel: vi.fn().mockResolvedValue({ state: "ready", modelPath: "/m", byteSize: 1 }),
    removeModel: vi.fn().mockResolvedValue({ state: "missing" }),
    transcribe: vi.fn().mockResolvedValue({ text: "hello", engine: "local" }),
    cancelTranscription: vi.fn().mockResolvedValue(undefined),
    onModelDownloadProgress: vi.fn().mockReturnValue(() => undefined),
  };
  vi.stubGlobal("window", { desktopBridge: { voice } });
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: vi.fn() } });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ScientVoiceComposerControl rendering", () => {
  it("renders nothing when the desktop voice bridge is absent (web build)", () => {
    const markup = renderToStaticMarkup(
      <ScientVoiceComposerControl onTranscript={() => undefined} />,
    );
    expect(markup).toBe("");
  });

  it("renders the mic affordance when the voice bridge is present", () => {
    stubVoiceBridge();
    const markup = renderToStaticMarkup(
      <ScientVoiceComposerControl onTranscript={() => undefined} />,
    );
    expect(markup).toContain('aria-label="Dictate a voice message"');
  });
});

describe("formatVoiceTimer", () => {
  it("formats sub-minute durations as mm:ss", () => {
    expect(formatVoiceTimer(0)).toBe("00:00");
    expect(formatVoiceTimer(5_000)).toBe("00:05");
  });

  it("rolls minutes over correctly and clamps negatives", () => {
    expect(formatVoiceTimer(75_000)).toBe("01:15");
    expect(formatVoiceTimer(-1)).toBe("00:00");
  });
});

describe("describeVoiceRecorderError", () => {
  it("gives macOS-specific guidance for denied permission", () => {
    expect(describeVoiceRecorderError("permission-denied")).toContain("System Settings");
  });

  it("maps every recorder error kind to non-empty copy", () => {
    for (const kind of ["no-microphone", "device-in-use", "unsupported", "unknown"] as const) {
      expect(describeVoiceRecorderError(kind).length).toBeGreaterThan(0);
    }
  });
});

describe("describeTranscriptionError", () => {
  it("prefers the host safeMessage when present", () => {
    expect(describeTranscriptionError({ safeMessage: "Model is warming up" })).toBe(
      "Model is warming up",
    );
  });

  it("sanitizes a raw error message, stripping stack frames and paths", () => {
    const shown = describeTranscriptionError(
      new Error("No speech detected\n    at file:///Users/x/secret.ts:1:1"),
    );
    expect(shown).toBe("No speech detected");
    expect(shown).not.toContain("file://");
  });

  it("falls back to a non-empty generic line for opaque non-errors", () => {
    expect(describeTranscriptionError(null).length).toBeGreaterThan(0);
    expect(describeTranscriptionError({}).length).toBeGreaterThan(0);
  });
});

describe("voice copy constants", () => {
  it("labels the one-time model download with its size", () => {
    expect(MODEL_DOWNLOAD_LABEL).toContain("182 MB");
  });

  it("has a dedicated empty-transcript message", () => {
    expect(EMPTY_TRANSCRIPT_MESSAGE).toBe("No speech detected");
  });
});
