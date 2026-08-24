import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it, vi } from "@effect/vitest";
import type { VoiceModelId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";

import type {
  TranscriptionEngine,
  VoiceModelState as CoreVoiceModelState,
} from "@scientfactory/scient-voice";
import {
  makeWithDependencies,
  projectVoiceModelState,
  recommendVoiceModel,
  toVoiceModelRequestError,
  type DesktopVoiceDependencies,
  type DesktopVoiceService,
} from "./DesktopVoice.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as DesktopConfig from "./DesktopConfig.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";

const SMALL_MODEL_ID = "whisper-small-multilingual-q5_1";
const MEDIUM_MODEL_ID = "whisper-medium-multilingual-q5_0";

interface FakeEngineHarness {
  readonly engine: TranscriptionEngine;
  readonly downloadStarted: Promise<void>;
  readonly ensureModel: ReturnType<typeof vi.fn>;
  readonly removeModel: ReturnType<typeof vi.fn>;
  readonly transcribe: ReturnType<typeof vi.fn>;
}

function ready(modelId: VoiceModelId): CoreVoiceModelState {
  return { state: "ready", modelPath: `/private/${modelId}.bin`, byteSize: 10 };
}

function makeFakeEngine(options?: {
  readonly runtimeAvailable?: boolean;
  readonly runtimeProbeFails?: boolean;
  readonly downloadWaitsForAbort?: boolean;
  readonly states?: Partial<Record<VoiceModelId, CoreVoiceModelState>>;
}): FakeEngineHarness {
  const states: Record<VoiceModelId, CoreVoiceModelState> = {
    [SMALL_MODEL_ID]: { state: "missing" },
    [MEDIUM_MODEL_ID]: { state: "missing" },
    ...options?.states,
  };
  let markDownloadStarted: () => void = () => undefined;
  const downloadStarted = new Promise<void>((resolve) => {
    markDownloadStarted = resolve;
  });
  const ensureModel = vi.fn(async (modelId: VoiceModelId, signal: AbortSignal): Promise<string> => {
    signal.throwIfAborted();
    markDownloadStarted();
    if (options?.downloadWaitsForAbort) {
      await new Promise<never>((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => {
            const error = new Error("cancelled");
            error.name = "AbortError";
            reject(error);
          },
          { once: true },
        );
      });
    }
    states[modelId] = ready(modelId);
    return `/private/${modelId}.bin`;
  });
  const removeModel = vi.fn(async (modelId: VoiceModelId): Promise<void> => {
    states[modelId] = { state: "missing" };
  });
  const transcribe = vi.fn(async (modelId: VoiceModelId) => ({
    text: `transcribed with ${modelId}`,
    engine: "local" as const,
  }));
  return {
    downloadStarted,
    ensureModel,
    removeModel,
    transcribe,
    engine: {
      engine: "local",
      getModelState: async (modelId) => states[modelId as VoiceModelId] ?? { state: "missing" },
      getModelStates: async () => ({ ...states }),
      ensureModel,
      removeModel,
      stopRuntime: async () => undefined,
      isRuntimeInstalled: async () => {
        if (options?.runtimeProbeFails) throw new Error("probe failed");
        return options?.runtimeAvailable ?? true;
      },
      transcribe,
      dispose: async () => undefined,
    },
  };
}

function environmentLayer() {
  return DesktopEnvironment.layer({
    dirname: "/repo/apps/desktop/src",
    homeDirectory: "/tmp/scient-voice-desktop-test",
    platform: "darwin",
    processArch: "arm64",
    appVersion: "0.0.1",
    appPath: "/repo",
    isPackaged: true,
    resourcesPath: "/resources",
    runningUnderArm64Translation: false,
  }).pipe(
    Layer.provide(
      Layer.mergeAll(
        NodeServices.layer,
        DesktopConfig.layerTest({ SCIENT_NEXT_HOME: "/tmp/scient-voice-desktop-test" }),
      ),
    ),
  );
}

function dependencies(
  harness: FakeEngineHarness,
  freeBytes = Number.POSITIVE_INFINITY,
): DesktopVoiceDependencies {
  return {
    createEngine: () => harness.engine,
    resolveFreeBytes: async () => freeBytes,
    readDeviceCapacity: () => ({
      availableParallelism: 10,
      totalMemoryBytes: 32 * 1024 ** 3,
    }),
  };
}

function withVoice<A, E>(
  dependencyOverrides: DesktopVoiceDependencies,
  use: (
    voice: DesktopVoiceService,
    settings: DesktopAppSettings.DesktopAppSettings["Service"],
  ) => Effect.Effect<A, E>,
  initialSettings = DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS,
) {
  return Effect.gen(function* () {
    const voice = yield* makeWithDependencies(dependencyOverrides);
    const settings = yield* DesktopAppSettings.DesktopAppSettings;
    return yield* use(voice, settings);
  }).pipe(
    Effect.provide(
      Layer.mergeAll(DesktopAppSettings.layerTest(initialSettings), environmentLayer()),
    ),
    Effect.scoped,
  );
}

describe("projectVoiceModelState", () => {
  it("never exposes the installed model path", () => {
    expect(
      projectVoiceModelState({
        state: "ready",
        modelPath: "/Users/example/private/voice/model.bin",
        byteSize: 190_085_487,
      }),
    ).toEqual({ state: "ready", byteSize: 190_085_487 });
  });

  it("never exposes a usable repair path while a download is active", () => {
    expect(
      projectVoiceModelState({
        state: "downloading",
        downloadedBytes: 10,
        totalBytes: 20,
        readyModelPath: "/Users/example/private/voice/model.bin",
      }),
    ).toEqual({ state: "downloading", downloadedBytes: 10, totalBytes: 20 });
  });
});

describe("toVoiceModelRequestError", () => {
  it("reports cancellation without exposing internal errors", () => {
    const cause = new Error("private path");
    cause.name = "AbortError";
    expect(toVoiceModelRequestError(cause, "download")).toMatchObject({
      kind: "cancelled",
      safeMessage: "Offline voice setup was cancelled.",
    });
  });

  it("uses operation-specific safe messages", () => {
    expect(toVoiceModelRequestError(new Error("/private/model.bin"), "download")).toMatchObject({
      kind: "provider-error",
      safeMessage: "Offline voice setup failed. Please try again.",
    });
    expect(toVoiceModelRequestError(new Error("/private/model.bin"), "remove")).toMatchObject({
      kind: "provider-error",
      safeMessage: "The offline voice model could not be removed. Please try again.",
    });
  });
});

describe("recommendVoiceModel", () => {
  const capableDevice = {
    platform: "darwin" as const,
    runningUnderArm64Translation: false,
    availableParallelism: 10,
    totalMemoryBytes: 32 * 1024 ** 3,
    freeModelStorageBytes: 4 * 1024 ** 3,
  };

  it("recommends Medium only when the runtime and device can support it", () => {
    expect(recommendVoiceModel(true, capableDevice)?.modelId).toBe(MEDIUM_MODEL_ID);
    expect(
      recommendVoiceModel(true, {
        ...capableDevice,
        runningUnderArm64Translation: true,
      })?.modelId,
    ).toBe(SMALL_MODEL_ID);
    expect(
      recommendVoiceModel(true, {
        ...capableDevice,
        freeModelStorageBytes: 0,
      })?.modelId,
    ).toBe(SMALL_MODEL_ID);
  });

  it("does not recommend a model when the runtime is unavailable", () => {
    expect(recommendVoiceModel(false, capableDevice)).toBeNull();
  });
});

describe("DesktopVoice model lifecycle", () => {
  it.effect("downloads, selects, and removes models with a verified fallback", () => {
    const harness = makeFakeEngine();
    return withVoice(dependencies(harness), (voice, settings) =>
      Effect.gen(function* () {
        const initial = yield* voice.getModelsState;
        expect(initial.selectedModelId).toBeNull();
        expect(initial.recommendation?.modelId).toBe(MEDIUM_MODEL_ID);

        const downloadedMedium = yield* voice.downloadModel({
          modelId: MEDIUM_MODEL_ID,
          selectOnSuccess: true,
        });
        expect(downloadedMedium.selectedModelId).toBe(MEDIUM_MODEL_ID);
        expect((yield* settings.get).voiceSelectedModelId).toBe(MEDIUM_MODEL_ID);

        yield* voice.downloadModel({ modelId: SMALL_MODEL_ID });
        const selectedSmall = yield* voice.selectModel({ modelId: SMALL_MODEL_ID });
        expect(selectedSmall.selectedModelId).toBe(SMALL_MODEL_ID);

        const removedSmall = yield* voice.removeModel({ modelId: SMALL_MODEL_ID });
        expect(removedSmall.selectedModelId).toBe(MEDIUM_MODEL_ID);
        expect((yield* settings.get).voiceSelectedModelId).toBe(MEDIUM_MODEL_ID);
        expect(harness.removeModel).toHaveBeenCalledWith(SMALL_MODEL_ID);
      }),
    );
  });

  it.effect("retains an existing verified Small installation without downloading it again", () => {
    const harness = makeFakeEngine({ states: { [SMALL_MODEL_ID]: ready(SMALL_MODEL_ID) } });
    return withVoice(dependencies(harness), (_voice, settings) =>
      Effect.gen(function* () {
        expect((yield* settings.get).voiceSelectedModelId).toBe(SMALL_MODEL_ID);
        expect(harness.ensureModel).not.toHaveBeenCalled();
      }),
    );
  });

  it.effect("fails closed without preventing startup when the runtime probe fails", () => {
    const harness = makeFakeEngine({ runtimeProbeFails: true });
    return withVoice(dependencies(harness), (voice) =>
      Effect.gen(function* () {
        const snapshot = yield* voice.getModelsState;
        expect(snapshot.runtimeAvailable).toBe(false);
        expect(snapshot.recommendation).toBeNull();
      }),
    );
  });

  it.effect("rejects a download before transfer when free space is insufficient", () => {
    const harness = makeFakeEngine();
    return withVoice(dependencies(harness, 0), (voice) =>
      Effect.gen(function* () {
        const error = yield* voice.downloadModel({ modelId: SMALL_MODEL_ID }).pipe(Effect.flip);
        expect(error).toMatchObject({ kind: "insufficient-storage" });
        expect(harness.ensureModel).not.toHaveBeenCalled();
      }),
    );
  });

  it.effect("cancels the matching download and clears the active operation", () => {
    const harness = makeFakeEngine({ downloadWaitsForAbort: true });
    return withVoice(dependencies(harness), (voice) =>
      Effect.gen(function* () {
        const download = yield* voice
          .downloadModel({ modelId: SMALL_MODEL_ID, selectOnSuccess: true })
          .pipe(Effect.forkChild);
        yield* Effect.promise(() => harness.downloadStarted);
        yield* voice.cancelModelDownload({ modelId: SMALL_MODEL_ID });
        const error = yield* Fiber.join(download).pipe(Effect.flip);
        expect(error).toMatchObject({ kind: "cancelled" });
        expect((yield* voice.getModelsState).activeDownloadModelId).toBeNull();
      }),
    );
  });
});
