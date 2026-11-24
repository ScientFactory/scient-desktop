// The Node test environment has no DOM runner; use server rendering for support gating and pure
// helpers for interaction branches. Stub desktop voice and getUserMedia at the boundary.

import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { ScientVoiceComposerControl } from "./ScientVoiceComposerControl.tsx";
import { describeVoiceRecorderError, formatVoiceTimer } from "./useScientVoiceController.ts";
import { describeVoiceError } from "./voiceErrorPresentation.ts";

vi.mock("gt-react", async (importOriginal) =>
  (await import("~/scient/testing/englishGTReact")).englishGTReact(await importOriginal()),
);

const catalog = vi.hoisted(() => ({ setup: null as object | null }));
vi.mock("./catalogDictation", () => ({
  useCatalogDictation: () => ({ enabled: catalog.setup !== null, setup: catalog.setup }),
}));

function stubCatalog(): void {
  const voice = {
    getModelsState: vi.fn().mockResolvedValue({
      runtimeAvailable: true,
      selectedModelId: null,
      recommendation: {
        modelId: "catalog/example-small",
        reason: "Test recommendation",
      },
      activeDownloadModelId: null,
      models: [
        {
          id: "catalog/example-small",
          displayName: "Multilingual Small",
          description: "Test Small model",
          byteSize: 1,
          state: { state: "missing" },
        },
        {
          id: "catalog/example-medium",
          displayName: "Multilingual Medium",
          description: "Test Medium model",
          byteSize: 2,
          state: { state: "missing" },
        },
        {
          id: "catalog/example-turbo",
          displayName: "Multilingual Turbo",
          description: "Test Turbo model",
          byteSize: 3,
          state: { state: "missing" },
        },
      ],
    }),
    downloadModel: vi.fn().mockResolvedValue({
      runtimeAvailable: true,
      selectedModelId: "catalog/example-small",
      recommendation: null,
      activeDownloadModelId: null,
      models: [],
    }),
    cancelModelDownload: vi.fn().mockResolvedValue(undefined),
    selectModel: vi.fn().mockResolvedValue({}),
    removeModel: vi.fn().mockResolvedValue({}),
    transcribe: vi.fn().mockResolvedValue({ text: "hello", engine: "local" }),
    cancelTranscription: vi.fn().mockResolvedValue(undefined),
    onModelDownloadProgress: vi.fn().mockReturnValue(() => undefined),
  };
  catalog.setup = voice;
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: vi.fn() } });
}

afterEach(() => {
  catalog.setup = null;
  vi.unstubAllGlobals();
});

describe("ScientVoiceComposerControl rendering", () => {
  it("renders nothing when local catalog dictation is unavailable", () => {
    const markup = renderToStaticMarkup(
      <ScientVoiceComposerControl onTranscript={() => undefined} />,
    );
    expect(markup).toBe("");
  });

  it("renders the mic affordance when local catalog dictation is available", () => {
    stubCatalog();
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
  it("gives cross-platform guidance for denied permission", () => {
    expect(describeVoiceRecorderError("permission-denied")).toContain("system privacy settings");
  });
});

describe("describeVoiceError", () => {
  it("prefers the host safeMessage when present", () => {
    expect(describeVoiceError({ safeMessage: "Model is warming up" })).toBe("Model is warming up");
  });

  it("sanitizes a raw error message, stripping stack frames and paths", () => {
    const shown = describeVoiceError(
      new Error("No speech detected\n    at file:///Users/x/secret.ts:1:1"),
    );
    expect(shown).toBe("No speech detected");
    expect(shown).not.toContain("file://");
  });

  it.each([
    {
      safeMessage:
        "  VoiceTranscriptionError: Voice messages must be between 1 ms and 180 seconds.",
    },
    new Error(
      "Error invoking remote method 'voice.transcribe': Error: VoiceTranscriptionError: Voice messages must be between 1 ms and 180 seconds.",
    ),
  ])("compacts duration validation errors and removes nested transport names", (error) => {
    expect(describeVoiceError(error)).toBe("Record speech, up to 3 minutes.");
  });

  it("sanitizes safe messages as well as ordinary Error messages", () => {
    expect(
      describeVoiceError({
        safeMessage:
          "Error: VoiceTranscriptionError: Model is warming up\n    at file:///secret.ts:1",
      }),
    ).toBe("Model is warming up");
  });

  it("falls back to a non-empty generic line for opaque non-errors", () => {
    expect(describeVoiceError(null).length).toBeGreaterThan(0);
    expect(describeVoiceError({}).length).toBeGreaterThan(0);
  });
});
