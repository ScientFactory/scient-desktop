import { openSharedLocalEngine, openVad } from "../transcription/local.ts";
import { beforeEach, expect, vi } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as TestClock from "effect/testing/TestClock";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Scheduler from "effect/Scheduler";
import * as Scope from "effect/Scope";
import * as Exit from "effect/Exit";
import * as PlatformError from "effect/PlatformError";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS } from "@t3tools/contracts";
import * as ServerSettings from "../serverSettings.ts";
import { listNativeSpeechGpuDevices } from "./native.ts";
import * as SpeechModelStore from "./SpeechModelStore.ts";
import * as SpeechService from "./SpeechService.ts";
import { SILERO_VAD } from "./silero.ts";

const native = vi.hoisted(() => ({
  backend: "Vulkan0",
  supportsStreaming: true,
  supportsLongForm: false,
  supportsTranslation: true,
  supportsVocabulary: false,
  languages: ["en", "fr"] as readonly string[],
  begin: vi.fn(async (_options?: unknown, _filterSilence?: boolean, _vadPath?: string) => {}),
  feed: vi.fn(async (_pcm: Float32Array) => ({
    revision: 1,
    text: { committed: "", tentative: "hello" },
  })),
  finish: vi.fn(async () => "hello"),
  reset: vi.fn(async () => {}),
  dispose: vi.fn(),
  scoreFrames: vi.fn(async () => [0.8]),
  transcribe: vi.fn(async (_pcm: Float32Array, _options?: unknown) => ({ text: "hello" })),
}));
const loadNative = vi.hoisted(() =>
  vi.fn(
    async (
      _path: string,
      _signal: AbortSignal,
      _moduleUrl?: string,
      backend: "auto" | "cpu" = "auto",
    ) => {
      native.backend = backend === "cpu" ? "CPU" : "Vulkan0";
      return native;
    },
  ),
);
const installedFile = vi.hoisted(() => ({ path: "test.gguf" }));
const readyModels = vi.hoisted(() => new Set(["test-model", "fallback-model"]));
const modelDefinitions = vi.hoisted(() => [
  {
    id: "test-model",
    filename: "test.gguf",
    name: "test",
    description: "test",
    size: 4,
    languages: ["en", "fr"],
    accuracy: 1,
    benchmark: {
      accuracy: { en: { grade: "A-", errorPercent: 4 } },
      secondsPer30s: { cpu: 3, accelerated: 1.2 },
    },
    speed: 1,
    recommended: true,
    supportsStreaming: true,
    supportsLanguageDetection: false,
    supportsTranslation: true,
  },
  {
    id: "fallback-model",
    filename: "fallback.gguf",
    name: "fallback",
    description: "fallback",
    size: 8,
    languages: ["en", "fr"],
    accuracy: 2,
    speed: 2,
    recommended: false,
    supportsStreaming: false,
    supportsLanguageDetection: false,
    supportsTranslation: true,
  },
]);
vi.mock("./native.ts", () => ({
  loadNativeSpeechModel: loadNative,
  listNativeSpeechGpuDevices: vi.fn(async () => [{ id: '["vulkan","gpu-1"]', name: "Test GPU" }]),
}));
vi.mock("./model.ts", () => ({
  DEFAULT_SPEECH_MODEL_ID: "test-model",
  SPEECH_MODELS: modelDefinitions,
  getSpeechModel: (modelId: string) => modelDefinitions.find((model) => model.id === modelId),
  effectiveSpeechLanguage: (model: { languages: string[] }, intent: string) =>
    intent !== "auto" && model.languages.includes(intent) ? intent : "en",
}));
const download = vi.fn<SpeechModelStore.SpeechModelStore["Service"]["download"]>(() =>
  Effect.succeed("test.gguf"),
);
const store = Layer.succeed(
  SpeechModelStore.SpeechModelStore,
  SpeechModelStore.SpeechModelStore.of({
    isReady: (model) => Effect.sync(() => readyModels.has(model.id)),
    installedPath: (model) =>
      Effect.sync(() => (readyModels.has(model.id) ? installedFile.path : undefined)),
    download,
    link: () => Effect.succeed([]),
    linkedFrom: () => Effect.undefined,
    remove: (model) =>
      Effect.sync(() => {
        readyModels.delete(model.id);
      }),
  }),
);
const layer = SpeechService.layer.pipe(
  Layer.provide(store),
  Layer.provideMerge(ServerSettings.layerTest({ speechModelId: "test-model" })),
  Layer.provide(NodeServices.layer),
);
const pcm = () => new Uint8Array(new Float32Array([0.25]).buffer);

beforeEach(() => {
  vi.clearAllMocks();
  loadNative.mockReset();
  native.finish.mockReset();
  native.backend = "Vulkan0";
  installedFile.path = "test.gguf";
  native.supportsVocabulary = false;
  native.supportsStreaming = true;
  native.languages = ["en", "fr"];
  readyModels.clear();
  readyModels.add("test-model");
  readyModels.add("fallback-model");
});

it("decodes a pooled Node Buffer without reading adjacent bytes", () => {
  const pool = Buffer.allocUnsafe(64);
  pool.fill(0xff);
  Buffer.from(new Float32Array([0.25]).buffer).copy(pool, 20);
  expect([...SpeechService.decodeSpeechPcm(pool.subarray(20, 24))]).toEqual([0.25]);
});

it("rejects empty, misaligned, non-finite, and oversized PCM as invalid audio", () => {
  for (const input of [
    new Uint8Array(),
    new Uint8Array(3),
    new Uint8Array(new Float32Array([Number.NaN]).buffer),
    new Uint8Array(SpeechService.MAX_SPEECH_BYTES + 4),
  ]) {
    expect(() => SpeechService.decodeSpeechPcm(input)).toThrow(
      expect.objectContaining({ _tag: "SpeechInvalidAudioError" }),
    );
  }
});

it.effect.each(["CPU", "Vulkan0"])(
  "prepares a batch model on %s before audio arrives and reuses it for transcription",
  (backend) =>
    Effect.gen(function* () {
      const speech = yield* SpeechService.SpeechService;
      yield* speech.selectModel("fallback-model");
      loadNative.mockImplementationOnce(async () => {
        native.backend = backend;
        return native;
      });
      yield* speech.prepareModel;
      expect(yield* speech.status).toMatchObject({
        benchmarkTier: backend === "CPU" ? "cpu" : "accelerated",
      });
      expect(loadNative).toHaveBeenCalledTimes(1);
      expect(native.transcribe).not.toHaveBeenCalled();
      native.supportsStreaming = false;
      yield* Effect.gen(function* () {
        const stream = yield* speech.startStream({
          ...DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS,
          speechLanguage: "fr",
          speechTranslateToEnglish: true,
          speechSilenceFiltering: false,
        });
        expect(native.begin).toHaveBeenLastCalledWith(
          { timestamps: "none", language: "fr", task: "translate", targetLanguage: "en" },
          false,
          "test.gguf",
        );
        expect(yield* stream.finish).toBe("hello");
      }).pipe(Effect.scoped);
      expect(yield* speech.transcribe(pcm(), DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS)).toBe("hello");
      expect(loadNative).toHaveBeenCalledTimes(1);
    }).pipe(Effect.provide(layer)),
);

it.effect("sends the chosen language in the spelling the loaded model advertises", () =>
  Effect.gen(function* () {
    const speech = yield* SpeechService.SpeechService;
    // Nemotron Streaming 3.5 advertises regional tags while the catalog lists bare codes.
    native.languages = ["en-US", "en-GB", "fr-FR"];
    yield* Effect.gen(function* () {
      const stream = yield* speech.startStream({
        ...DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS,
        speechLanguage: "fr",
      });
      expect(native.begin).toHaveBeenLastCalledWith(
        { timestamps: "none", language: "fr-FR" },
        true,
        "test.gguf",
      );
      expect(yield* stream.finish).toBe("hello");
    }).pipe(Effect.scoped);
    native.supportsStreaming = false;
    expect(
      yield* speech.transcribe(pcm(), {
        ...DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS,
        speechLanguage: "fr",
      }),
    ).toBe("hello");
    expect(native.transcribe).toHaveBeenLastCalledWith(
      expect.any(Float32Array),
      { timestamps: "none", language: "fr-FR" },
      true,
      "test.gguf",
    );
    // A language the model does not advertise reaches it unchanged, so the model reports it.
    yield* speech.updateAcceleration("cpu");
    native.languages = ["en-US"];
    native.transcribe.mockRejectedValueOnce(new Error("transcribe_run: unsupported language"));
    const rejected = yield* Effect.result(
      speech.transcribe(pcm(), { ...DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS, speechLanguage: "fr" }),
    );
    expect(Result.isFailure(rejected) && rejected.failure).toMatchObject({
      _tag: "SpeechOperationError",
      operation: "inference",
    });
    expect(native.transcribe).toHaveBeenLastCalledWith(
      expect.any(Float32Array),
      { timestamps: "none", language: "fr" },
      true,
      "test.gguf",
    );
    expect(loadNative.mock.calls.map(([path, , , acceleration]) => [path, acceleration])).toEqual([
      ["test.gguf", "auto"],
      ["test.gguf", "cpu"],
    ]);
  }).pipe(Effect.provide(layer)),
);

// SCIENT-FORK:START — Uses the suite's native worker mocks and scoped speech layer.
it.effect.each(["cancellation", "timeout"] as const)(
  "cancels stalled preparation on %s and waits for worker exit before replacement",
  (reason) =>
    Effect.gen(function* () {
      const speech = yield* SpeechService.SpeechService;
      const started = Promise.withResolvers<AbortSignal>();
      const stalled = Promise.withResolvers<typeof native>();
      const disposed = Promise.withResolvers<void>();
      const abandoned = { ...native, dispose: vi.fn(() => disposed.resolve()) };
      loadNative.mockImplementationOnce((_path, signal) => {
        started.resolve(signal);
        return stalled.promise;
      });
      const request = yield* speech.prepareModel.pipe(Effect.forkChild);
      const signal = yield* Effect.promise(() => started.promise);
      try {
        if (reason === "cancellation") {
          yield* Fiber.interrupt(request).pipe(Effect.forkChild({ startImmediately: true }));
        }
        yield* TestClock.adjust(reason === "timeout" ? "2 minutes" : 0);
        expect(signal.aborted).toBe(true);
        const exit = yield* Fiber.await(request);
        expect(Exit.isFailure(exit)).toBe(true);
        if (reason === "timeout") {
          expect(Exit.findErrorOption(exit)).toMatchObject({
            value: { _tag: "SpeechOperationError", operation: "model preparation" },
          });
        }
        const transcribe = speech.dictateLocal(
          "fallback-model",
          pcm(),
          DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS,
        );
        const replacement = yield* transcribe.pipe(Effect.forkChild);
        yield* TestClock.adjust(0);
        expect(loadNative).toHaveBeenCalledTimes(1);
        stalled.resolve(abandoned);
        yield* Effect.promise(() => disposed.promise);
        expect(yield* Fiber.join(replacement)).toBe("hello");
        expect(yield* transcribe).toBe("hello");
        expect(loadNative).toHaveBeenCalledTimes(2);
      } finally {
        stalled.resolve(abandoned);
      }
    }).pipe(Effect.provide(layer)),
);
// SCIENT-FORK:END

it.effect("rejects model mutations outside the offered registry", () =>
  Effect.gen(function* () {
    const speech = yield* SpeechService.SpeechService;
    for (const id of [
      "handy-computer/canary-1b-gguf",
      "handy-computer/granite-speech-5.0-470m-turboctc-nc-gguf",
      "unknown-model",
    ]) {
      for (const mutation of [speech.downloadModel, speech.selectModel, speech.removeModel]) {
        const result = yield* Effect.result(mutation(id));
        expect(Result.isFailure(result) && result.failure).toMatchObject({
          _tag: "SpeechModelNotFoundError",
          modelId: id,
        });
      }
    }
    expect(download).not.toHaveBeenCalled();
    const current = (yield* speech.models(false)).models.find((model) => model.active);
    expect(current?.id).toBe("test-model");
    expect(current).not.toHaveProperty("benchmark");
    expect(
      (yield* speech.models(true)).models.find((model) => model.active)?.benchmark?.secondsPer30s,
    ).toEqual({ cpu: 3, accelerated: 1.2 });
  }).pipe(Effect.provide(layer)),
);

it.effect("keeps a detached download exclusive until the transfer finishes", () =>
  Effect.gen(function* () {
    const speech = yield* SpeechService.SpeechService;
    const started = yield* Deferred.make<void>();
    const finish = yield* Deferred.make<void>();
    const helperStarted = yield* Deferred.make<void>();
    let helperStartedDuringInstall = false;
    let helperInterrupted = false;
    download
      .mockImplementationOnce(() =>
        Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Deferred.await(finish)),
          Effect.as("test.gguf"),
        ),
      )
      .mockImplementationOnce(() =>
        Deferred.isDone(finish).pipe(
          Effect.tap((done) =>
            Effect.sync(() => {
              helperStartedDuringInstall = !done;
            }),
          ),
          Effect.andThen(Deferred.succeed(helperStarted, undefined)),
          Effect.andThen(Effect.never),
          Effect.onInterrupt(() =>
            Effect.sync(() => {
              helperInterrupted = true;
            }),
          ),
        ),
      );
    const request = yield* speech.downloadModel("test-model").pipe(Effect.forkChild);
    yield* Deferred.await(started);
    yield* Deferred.await(helperStarted);
    yield* Fiber.interrupt(request);
    yield* Deferred.succeed(finish, undefined);
    yield* TestClock.adjust("16 seconds");
    expect(helperInterrupted).toBe(false);
    const removed = yield* Effect.result(speech.removeModel("test-model"));
    expect(Result.isFailure(removed) && removed.failure).toMatchObject({ _tag: "SpeechBusyError" });
    const join = yield* speech
      .downloadModel("test-model")
      .pipe(Effect.forkChild({ startImmediately: true }));
    yield* TestClock.adjust("2 minutes");
    expect(helperInterrupted).toBe(true);
    yield* Fiber.join(join);
    expect(download.mock.calls.map(([model]) => model.id)).toEqual(["test-model", SILERO_VAD.id]);
    expect(helperStartedDuringInstall).toBe(true);
    yield* speech.removeModel("test-model");
    expect(readyModels.has("test-model")).toBe(false);
  }).pipe(Effect.provide(layer)),
);

it.effect("reports cancellation even after the speech weights are installed", () =>
  Effect.gen(function* () {
    const speech = yield* SpeechService.SpeechService;
    readyModels.delete("fallback-model");
    const weightsInstalled = yield* Deferred.make<void>();
    const helperStarted = yield* Deferred.make<void>();
    download
      .mockImplementationOnce(() =>
        Effect.sync(() => {
          readyModels.add("fallback-model");
        }).pipe(
          Effect.andThen(Deferred.succeed(weightsInstalled, undefined)),
          Effect.as("test.gguf"),
        ),
      )
      .mockImplementationOnce(() =>
        Deferred.succeed(helperStarted, undefined).pipe(Effect.andThen(Effect.never)),
      );

    const request = yield* speech.downloadModel("fallback-model").pipe(Effect.forkChild);
    yield* Deferred.await(weightsInstalled);
    yield* Deferred.await(helperStarted);
    yield* speech.cancelDownload("fallback-model");

    expect(yield* Fiber.join(request)).toMatchObject({
      cancelled: true,
      models: expect.arrayContaining([
        expect.objectContaining({ id: "fallback-model", state: "installed", active: false }),
        expect.objectContaining({ id: "test-model", active: true }),
      ]),
    });
  }).pipe(Effect.provide(layer)),
);

it.effect("preserves the current model when another client removes a selection candidate", () =>
  Effect.gen(function* () {
    const speech = yield* SpeechService.SpeechService;
    yield* speech.removeModel("fallback-model");
    const selection = yield* Effect.result(speech.selectModel("fallback-model"));
    expect(Result.isFailure(selection) && selection.failure).toMatchObject({
      _tag: "SpeechModelNotFoundError",
      modelId: "fallback-model",
    });
    expect(yield* speech.status).toMatchObject({ supported: true, modelId: "test-model" });
  }).pipe(Effect.provide(layer)),
);

it.effect("bounds missing Silero recovery during recording and continues with raw audio", () =>
  Effect.gen(function* () {
    const helperStarted = yield* Deferred.make<void>();
    const helperInterrupted = yield* Deferred.make<void>();
    download.mockImplementationOnce(() =>
      Deferred.succeed(helperStarted, undefined).pipe(
        Effect.andThen(Effect.never),
        Effect.onInterrupt(() => Deferred.succeed(helperInterrupted, undefined)),
      ),
    );
    const speech = yield* SpeechService.SpeechService;
    const recording = yield* speech
      .startStream(DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS)
      .pipe(Effect.forkChild);
    yield* Deferred.await(helperStarted);
    yield* TestClock.adjust("14999 millis");
    expect(native.begin).not.toHaveBeenCalled();
    yield* TestClock.adjust("1 millis");
    yield* Deferred.await(helperInterrupted);
    const stream = yield* Fiber.join(recording);
    expect(native.begin).toHaveBeenLastCalledWith(expect.anything(), true, undefined);
    yield* stream.feed(pcm());
    expect(yield* stream.finish).toBe("hello");
  }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.effect("keeps the installed speech model usable when optional Silero acquisition fails", () =>
  Effect.gen(function* () {
    download
      .mockImplementationOnce(() => Effect.succeed("test.gguf"))
      .mockImplementationOnce(() =>
        Effect.fail(
          new PlatformError.PlatformError(
            new PlatformError.SystemError({
              _tag: "NotFound",
              module: "FileSystem",
              method: "open",
            }),
          ),
        ),
      );
    const speech = yield* SpeechService.SpeechService;
    const installed = yield* speech.downloadModel("test-model");
    expect(installed).toHaveProperty("cancelled", false);
    expect(installed.models.find((model) => model.id === "test-model")?.state).toBe("installed");
    expect(yield* speech.transcribe(pcm(), DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS)).toBe("hello");
    yield* Effect.scoped(
      Effect.gen(function* () {
        const stream = yield* speech.startStream(DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS);
        expect(yield* stream.finish).toBe("hello");
      }),
    );
    expect(download).toHaveBeenCalledTimes(2);
    yield* TestClock.adjust("10 minutes");
    expect(yield* speech.transcribe(pcm(), DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS)).toBe("hello");
    expect(download).toHaveBeenCalledTimes(3);
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "allows another model operation after an already-installed download completes immediately",
  () =>
    Effect.gen(function* () {
      const speech = yield* SpeechService.SpeechService;
      const models = yield* speech.downloadModel("test-model").pipe(
        Effect.provideService(Scheduler.Scheduler, {
          executionMode: "sync",
          shouldYield: () => false,
          makeDispatcher: () => ({ scheduleTask: (task) => task(), flush: () => {} }),
        }),
      );
      expect(models.models.find((model) => model.id === "test-model")?.state).toBe("installed");
      yield* speech.selectModel("fallback-model");
    }).pipe(Effect.provide(layer)),
);

// SCIENT-FORK:START — Uses the suite's native worker mocks and scoped speech layer.
it.effect("keeps released-client dictionary spellings and recognition hints working", () =>
  Effect.gen(function* () {
    const speech = yield* SpeechService.SpeechService;
    native.supportsVocabulary = true;
    native.transcribe.mockResolvedValueOnce({ text: "C sharp, but plain C." });
    expect(
      yield* speech.transcribe(pcm(), {
        ...DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS,
        speechCustomWords: [{ term: "C#", aliases: ["C sharp"] }],
      }),
    ).toBe("C#, but plain C.");
    expect(native.transcribe.mock.lastCall?.[1]).toMatchObject({ vocabulary: ["C#"] });
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "passes vocabulary only for supported transcription without rewriting engine output",
  () =>
    Effect.gen(function* () {
      for (const supportsVocabulary of [false, true]) {
        for (const translate of [false, true]) {
          yield* Effect.gen(function* () {
            native.supportsVocabulary = supportsVocabulary;
            const speech = yield* SpeechService.SpeechService;
            const options = {
              ...DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS,
              speechLanguage: "fr" as const,
              speechTranslateToEnglish: translate,
              speechHints: ["Server", "GitHub", "Bob", "T3 Code"],
            };
            const vocabulary =
              supportsVocabulary && !translate ? ["Server", "GitHub", "Bob", "T3 Code"] : undefined;
            native.transcribe.mockResolvedValueOnce({ text: "git hub and Robert on the server" });
            expect(yield* speech.transcribe(pcm(), options)).toBe(
              "git hub and Robert on the server",
            );
            const delivered = native.transcribe.mock.lastCall?.[1];
            expect(delivered).toEqual({
              timestamps: "none",
              language: "fr",
              ...(translate ? { task: "translate", targetLanguage: "en" } : {}),
              ...(vocabulary ? { vocabulary } : {}),
            });
            if (translate) return;
            native.feed.mockResolvedValueOnce({
              revision: 1,
              text: { committed: "git hub", tentative: "Robert" },
            });
            native.finish.mockResolvedValueOnce("git hub and Robert on the server");
            const stream = yield* speech.startStream(options);
            expect(yield* stream.feed(pcm())).toEqual({
              revision: 1,
              text: { committed: "git hub", tentative: "Robert" },
            });
            expect(yield* stream.finish).toBe("git hub and Robert on the server");
            expect(native.begin.mock.lastCall).toEqual([
              { timestamps: "none", language: "fr", ...(vocabulary ? { vocabulary } : {}) },
              true,
              "test.gguf",
            ]);
          }).pipe(Effect.scoped, Effect.provide(layer));
        }
      }
    }),
);
// SCIENT-FORK:END

it.effect("unloads after the chosen idle period and reloads on the next recording", () =>
  Effect.gen(function* () {
    const speech = yield* SpeechService.SpeechService;
    yield* speech.updateModelUnloadTimeout("min_2");
    yield* speech.transcribe(pcm(), DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS);
    yield* TestClock.adjust(2 * 60_000 - 1);
    expect(native.dispose).not.toHaveBeenCalled();
    yield* TestClock.adjust(1);
    expect(native.dispose).toHaveBeenCalledOnce();
    yield* speech.transcribe(pcm(), DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS);
    expect(loadNative).toHaveBeenCalledTimes(2);
  }).pipe(Effect.provide(layer)),
);

it.effect.each([
  {
    cue: undefined,
    remove: true,
    text: "First paragraph.\n\nSecond paragraph.",
    expected: "First paragraph.\n\nSecond paragraph.",
  },
  {
    cue: undefined,
    remove: true,
    text: "First um\n\nuh Second.",
    expected: "First\n\nSecond.",
  },
  {
    cue: undefined,
    remove: true,
    text: "First um\r\n\r\nuh Second.",
    expected: "First\r\n\r\nSecond.",
  },
  { cue: "um", remove: true, text: "Make it red, um, blue.", expected: "Make it red, um, blue." },
  {
    cue: "uh no",
    remove: true,
    text: "Make it red, uh no, blue.",
    expected: "Make it red, uh no, blue.",
  },
  {
    cue: "uh no",
    remove: true,
    text: "Uh, Make it red, UH  NO, blue. Uh nope.",
    expected: "Make it red, UH NO, blue. nope.",
  },
  {
    cue: " UM ",
    remove: true,
    text: "Uh, Make it red, um, blue.",
    expected: "Make it red, um, blue.",
  },
  {
    cue: undefined,
    remove: true,
    text: "Uh, Make it red, um, blue.",
    expected: "Make it red, blue.",
  },
  {
    cue: "um",
    remove: false,
    text: "Uh, Make it red, um, blue.",
    expected: "Uh, Make it red, um, blue.",
  },
])(
  "preserves only an explicit correction cue during batch and stream filler removal: $cue / $remove",
  ({ cue, remove, text, expected }) =>
    Effect.gen(function* () {
      const speech = yield* SpeechService.SpeechService;
      const options = {
        ...DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS,
        speechLanguage: "en",
        speechRemoveFillerWords: remove,
        speechHints: ["um"],
        ...(cue === undefined ? {} : { speechCorrectionWord: cue }),
      };
      native.transcribe.mockResolvedValueOnce({ text });
      native.finish.mockResolvedValueOnce(text);
      expect(yield* speech.transcribe(pcm(), options)).toBe(expected);
      const stream = yield* speech.startStream(options);
      expect(yield* stream.finish).toBe(expected);
    }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.effect("holds model ownership until the stream scope closes and preserves silence", () =>
  Effect.gen(function* () {
    const speech = yield* SpeechService.SpeechService;
    yield* Effect.gen(function* () {
      const stream = yield* speech.startStream(DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS);
      const busy = yield* Effect.result(speech.selectModel("fallback-model"));
      expect(Result.isFailure(busy) && busy.failure).toMatchObject({ _tag: "SpeechBusyError" });
      yield* stream.feed(new Uint8Array(new Float32Array(160).buffer));
      expect(native.feed.mock.calls[0]?.[0]).toHaveLength(160);
      expect(yield* stream.finish).toBe("hello");
    }).pipe(Effect.scoped);
    expect(native.dispose).not.toHaveBeenCalled();
    yield* speech.selectModel("fallback-model");
    expect(native.dispose).toHaveBeenCalledOnce();
  }).pipe(Effect.provide(layer)),
);

it.effect("resets cancelled streams and reuses the loaded model", () =>
  Effect.gen(function* () {
    const speech = yield* SpeechService.SpeechService;
    yield* speech.startStream(DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS).pipe(Effect.scoped);
    expect(native.reset).toHaveBeenCalledOnce();
    expect(native.dispose).not.toHaveBeenCalled();
    yield* Effect.gen(function* () {
      const stream = yield* speech.startStream(DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS);
      yield* stream.feed(pcm());
      yield* stream.finish;
    }).pipe(Effect.scoped);
    expect(loadNative).toHaveBeenCalledOnce();
  }).pipe(Effect.provide(layer)),
);

it.effect("releases a failed stream start without waiting for its socket scope to close", () =>
  Effect.gen(function* () {
    const speech = yield* SpeechService.SpeechService;
    const socket = yield* Scope.fork(yield* Effect.scope);
    yield* speech.updateAcceleration("cpu");
    native.begin.mockRejectedValueOnce(new Error("cannot start streaming"));
    const error = yield* speech
      .startStream(DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS)
      .pipe(Scope.provide(socket), Effect.flip);
    expect(error._tag).toBe("SpeechOperationError");
    expect(yield* speech.status).toMatchObject({ state: "ready" });
    expect(native.dispose).toHaveBeenCalledOnce();
    const next = yield* speech.startStream(DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS);
    yield* Scope.close(socket, Exit.void);
    expect(yield* speech.status).toMatchObject({ state: "transcribing" });
    expect(yield* next.finish).toBe("hello");
  }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.effect("closes its scope without waiting for hung native inference", () =>
  Effect.gen(function* () {
    const started = Promise.withResolvers<void>();
    native.transcribe.mockImplementationOnce(() => {
      started.resolve();
      return new Promise(() => {});
    });
    yield* Effect.gen(function* () {
      const speech = yield* SpeechService.SpeechService;
      const request = yield* speech
        .transcribe(pcm(), DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS)
        .pipe(Effect.forkChild);
      yield* Effect.promise(() => started.promise);
      yield* Fiber.interrupt(request);
    }).pipe(Effect.provide(layer));
    expect(native.dispose).toHaveBeenCalledOnce();
  }),
);

it.effect("reports unsupported hosts without wrapping a synthetic cause", () =>
  Effect.gen(function* () {
    const result = yield* Effect.gen(function* () {
      const speech = yield* SpeechService.SpeechService;
      return yield* Effect.result(speech.transcribe(pcm(), DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS));
    }).pipe(
      Effect.provide(layer),
      Effect.provideService(HostProcess.Platform, "win32"),
      Effect.provideService(HostProcess.Architecture, "arm64"),
    );
    expect(Result.isFailure(result) && result.failure).toMatchObject({
      _tag: "SpeechUnsupportedPlatformError",
      platform: "win32",
      architecture: "arm64",
    });
  }),
);

it.effect.each([{ devices: [] }, { devices: [{ id: "gpu", name: "Test GPU" }] }])(
  "retries failed GPU discovery without repeatedly probing on status polls: $devices",
  ({ devices }) =>
    Effect.gen(function* () {
      const speech = yield* SpeechService.SpeechService;
      const discover = vi.mocked(listNativeSpeechGpuDevices).mockReset();
      discover.mockRejectedValueOnce(new Error("driver not ready")).mockResolvedValueOnce(devices);
      expect(yield* speech.status).toMatchObject({ gpuDevices: [], benchmarkTier: "cpu" });
      yield* speech.status;
      expect(discover).toHaveBeenCalledOnce();
      yield* TestClock.adjust("1 minute");
      expect(yield* speech.status).toMatchObject({
        gpuDevices: devices,
        benchmarkTier: devices.length ? "accelerated" : "cpu",
      });
      expect(yield* speech.updateAcceleration("cpu")).toMatchObject({ benchmarkTier: "cpu" });
      expect(yield* speech.updateAcceleration('gpu:["vulkan","gpu-1"]')).toMatchObject({
        benchmarkTier: "accelerated",
      });
      yield* speech.updateAcceleration("auto");
      yield* TestClock.adjust("1 minute");
      expect(yield* speech.status).toMatchObject({ gpuDevices: devices });
      expect(discover).toHaveBeenCalledTimes(2);
    }).pipe(Effect.provide(layer)),
);

// SCIENT-FORK:START — Uses the suite's native worker mocks and scoped speech layer.
it.effect("retries Auto-placed inference with the CPU's vocabulary capability", () =>
  Effect.gen(function* () {
    for (const cpuSupportsVocabulary of [true, false]) {
      yield* Effect.gen(function* () {
        native.supportsVocabulary = true;
        loadNative.mockImplementationOnce(async () => native);
        loadNative.mockImplementationOnce(async () => ({
          ...native,
          backend: "CPU",
          supportsVocabulary: cpuSupportsVocabulary,
        }));
        native.transcribe
          .mockRejectedValueOnce(new Error("worker stopped"))
          .mockResolvedValueOnce({ text: "git hub Robert" });
        const options = {
          ...DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS,
          speechHints: ["GitHub", "Bob"],
        };
        const speech = yield* SpeechService.SpeechService;
        expect(yield* speech.status).toMatchObject({ benchmarkTier: "accelerated" });
        expect(yield* speech.transcribe(pcm(), options)).toBe("git hub Robert");
        expect(yield* speech.status).toMatchObject({ benchmarkTier: "cpu" });
        expect(yield* speech.transcribe(pcm(), DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS)).toBe("hello");
        expect(loadNative.mock.calls.slice(-2).map((call) => call[3])).toEqual(["auto", "cpu"]);
        expect(native.transcribe.mock.calls.slice(-3, -1).map((call) => call[1])).toEqual([
          { timestamps: "none", language: "en", vocabulary: ["GitHub", "Bob"] },
          {
            timestamps: "none",
            language: "en",
            ...(cpuSupportsVocabulary ? { vocabulary: ["GitHub", "Bob"] } : {}),
          },
        ]);
      }).pipe(Effect.provide(layer));
    }
  }),
);
// SCIENT-FORK:END

it.effect("reports a failure on a GPU the person chose instead of switching to CPU", () =>
  Effect.gen(function* () {
    const failure = new Error("GPU failed");
    native.transcribe.mockRejectedValueOnce(failure);
    const speech = yield* SpeechService.SpeechService;
    const acceleration = 'gpu:["vulkan","gpu-1"]';
    yield* speech.updateAcceleration(acceleration);
    const result = yield* Effect.result(
      speech.transcribe(pcm(), DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS),
    );
    expect(Result.isFailure(result) && result.failure).toMatchObject({
      _tag: "SpeechOperationError",
      operation: "inference",
      cause: failure,
    });
    expect(loadNative).toHaveBeenCalledTimes(1);
    expect(loadNative.mock.calls[0]?.[3]).toBe(acceleration);
  }).pipe(Effect.provide(layer)),
);

it.effect("replays streamed audio on CPU after an Auto-placed feed crashes, once", () =>
  Effect.gen(function* () {
    for (const cpuSupportsVocabulary of [true, false]) {
      yield* Effect.gen(function* () {
        native.supportsVocabulary = true;
        const feedCalls = native.feed.mock.calls.length;
        const text = { committed: "", tentative: "git hub Robert" };
        const options = {
          ...DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS,
          speechHints: ["GitHub", "Bob"],
        };
        native.feed
          .mockResolvedValueOnce({ revision: 3, text })
          .mockRejectedValueOnce(new Error("worker stopped"))
          .mockResolvedValueOnce({ revision: 1, text })
          .mockResolvedValueOnce({ revision: 2, text })
          .mockResolvedValueOnce({ revision: 3, text });
        loadNative.mockImplementationOnce(async () => native);
        loadNative.mockImplementationOnce(async () => ({
          ...native,
          backend: "CPU",
          supportsVocabulary: cpuSupportsVocabulary,
        }));
        const speech = yield* SpeechService.SpeechService;
        const stream = yield* speech.startStream(options);
        expect(yield* stream.feed(pcm())).toEqual({ revision: 3, text });
        const recovered = {
          committed: "",
          tentative: "git hub Robert",
        };
        expect(yield* stream.feed(pcm())).toEqual({ revision: 5, text: recovered });
        expect(loadNative.mock.calls.slice(-2).map((call) => call[3])).toEqual(["auto", "cpu"]);
        expect(native.begin.mock.calls.slice(-2).map(([options]) => options)).toEqual([
          { timestamps: "none", language: "en", vocabulary: ["GitHub", "Bob"] },
          {
            timestamps: "none",
            language: "en",
            ...(cpuSupportsVocabulary ? { vocabulary: ["GitHub", "Bob"] } : {}),
          },
        ]);
        expect(native.feed).toHaveBeenCalledTimes(feedCalls + 4);
        expect(yield* stream.feed(pcm())).toEqual({ revision: 6, text: recovered });
        const loads = loadNative.mock.calls.length;
        native.finish.mockRejectedValueOnce(new Error("CPU finish failed"));
        expect(Result.isFailure(yield* Effect.result(stream.finish))).toBe(true);
        expect(Result.isFailure(yield* Effect.result(stream.feed(pcm())))).toBe(true);
        expect(loadNative).toHaveBeenCalledTimes(loads);
      }).pipe(Effect.scoped, Effect.provide(layer));
    }
  }),
);

it.effect.each([false, true])(
  "recovers Auto stream finalization on a fresh CPU worker with retained audio: %s",
  (withAudio) =>
    Effect.gen(function* () {
      const cpu = {
        ...native,
        backend: "CPU",
        begin: vi.fn(async (_options?: unknown) => {}),
        feed: vi.fn(async (_pcm: Float32Array) => ({
          revision: 1,
          text: { committed: "", tentative: "" },
        })),
        finish: vi.fn(async () => "Robert"),
        dispose: vi.fn(),
      };
      const gpu = {
        ...native,
        finish: vi.fn(async () => {
          throw new Error("GPU finish failed");
        }),
      };
      loadNative.mockResolvedValueOnce(gpu).mockResolvedValueOnce(cpu);
      const speech = yield* SpeechService.SpeechService;
      const chunks = withAudio ? [new Float32Array([0.25, 0]), new Float32Array([-0.5])] : [];
      yield* Effect.gen(function* () {
        const stream = yield* speech.startStream({
          ...DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS,
          speechLanguage: "fr",
          speechHints: ["Bob"],
        });
        for (const chunk of chunks) yield* stream.feed(new Uint8Array(chunk.buffer));
        expect(yield* stream.finish).toBe("Robert");
        expect(cpu.feed.mock.calls.map(([chunk]) => [...chunk])).toEqual(
          chunks.map((chunk) => [...chunk]),
        );
        expect(cpu.begin).toHaveBeenCalledWith(
          { timestamps: "none", language: "fr" },
          true,
          "test.gguf",
        );
        expect(gpu.dispose).toHaveBeenCalledOnce();
        expect(cpu.dispose).not.toHaveBeenCalled();
        const busy = yield* Effect.result(speech.selectModel("fallback-model"));
        expect(Result.isFailure(busy) && busy.failure).toMatchObject({ _tag: "SpeechBusyError" });
      }).pipe(Effect.scoped);
      expect(loadNative.mock.calls.map(([path, , , acceleration]) => [path, acceleration])).toEqual(
        [
          ["test.gguf", "auto"],
          ["test.gguf", "cpu"],
        ],
      );
      yield* speech.selectModel("fallback-model");
      expect(cpu.dispose).toHaveBeenCalledOnce();
    }).pipe(Effect.provide(layer)),
);

it.effect.each(["auto", 'gpu:["vulkan","gpu-1"]', "cpu"] as const)(
  "reports finalization failure without repeated or explicit-backend fallback: %s",
  (acceleration) =>
    Effect.gen(function* () {
      const failure = new Error("finish failed");
      const worker = {
        ...native,
        backend: acceleration === "cpu" ? "CPU" : "Vulkan0",
        finish: vi.fn(async () => {
          throw failure;
        }),
      };
      const cpu = { ...worker, backend: "CPU", dispose: vi.fn() };
      loadNative.mockResolvedValueOnce(worker);
      if (acceleration === "auto") loadNative.mockResolvedValueOnce(cpu);
      const speech = yield* SpeechService.SpeechService;
      yield* speech.updateAcceleration(acceleration);
      const stream = yield* speech.startStream(DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS);
      expect(Result.isFailure(yield* Effect.result(stream.finish))).toBe(true);
      expect(worker.finish).toHaveBeenCalledTimes(acceleration === "auto" ? 2 : 1);
      expect(loadNative).toHaveBeenCalledTimes(acceleration === "auto" ? 2 : 1);
    }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.effect("does not restart a stream cancelled while native finalization is pending", () =>
  Effect.gen(function* () {
    const pending = Promise.withResolvers<string>();
    const started = Promise.withResolvers<void>();
    native.finish.mockImplementationOnce(() => {
      started.resolve();
      return pending.promise;
    });
    const speech = yield* SpeechService.SpeechService;
    const streamScope = yield* Scope.make();
    const stream = yield* speech
      .startStream(DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS)
      .pipe(Effect.provideService(Scope.Scope, streamScope));
    const request = yield* Effect.result(stream.finish).pipe(Effect.forkChild);
    yield* Effect.promise(() => started.promise);
    yield* Scope.close(streamScope, Exit.void);
    pending.reject(new Error("cancelled worker stopped"));
    expect(Result.isFailure(yield* Fiber.join(request))).toBe(true);
    expect(loadNative).toHaveBeenCalledOnce();
    expect(native.reset).toHaveBeenCalledOnce();
  }).pipe(Effect.provide(layer)),
);

// SCIENT-FORK:START — Uses the suite's native worker mocks and scoped speech layer.
it.effect("preempts a recording window at two seconds and retries after dictation", () =>
  Effect.gen(function* () {
    const speech = yield* SpeechService.SpeechService;
    const started = Promise.withResolvers<void>();
    const aborted = Promise.withResolvers<void>();
    const retired = Promise.withResolvers<void>();
    const events: string[] = [];
    let attempts = 0;
    const recognizeWindow = async () => {
      attempts++;
      events.push("window");
      return { text: "recorded", segments: [], timestampKind: "none" };
    };
    loadNative.mockImplementation(async () => ({ ...native, recognizeWindow }));
    const stopped = Promise.withResolvers<void>();
    loadNative.mockImplementationOnce(async () => ({
      ...native,
      recognizeWindow: async () => {
        attempts++;
        events.push("window");
        started.resolve();
        await stopped.promise;
        return { text: "abandoned", segments: [], timestampKind: "none" };
      },
      dispose: vi.fn(() => {
        stopped.resolve();
        aborted.resolve();
        return retired.promise;
      }),
    }));
    const recording = yield* Effect.promise(async (signal) => {
      const engine = await openSharedLocalEngine(speech, "test.gguf", "en", signal, "auto");
      return engine.recognize(new Float32Array(4000), false);
    }).pipe(Effect.forkChild);
    yield* Effect.promise(() => started.promise);
    native.transcribe.mockImplementationOnce(async () => {
      events.push("dictation");
      return { text: "dictated" };
    });
    const dictation = yield* speech
      .dictateLocal("test-model", pcm(), DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS)
      .pipe(Effect.forkChild({ startImmediately: true }));
    try {
      yield* TestClock.adjust("1999 millis");
      expect(yield* speech.waitingForWorker).toBe(false);
      yield* TestClock.adjust("1 millis");
      yield* Effect.promise(() => aborted.promise);
      expect(yield* speech.waitingForWorker).toBe(true);
      expect(loadNative).toHaveBeenCalledTimes(1);
      expect(events).toEqual(["window"]);
    } finally {
      retired.resolve();
    }
    expect(yield* Fiber.join(dictation)).toBe("dictated");
    expect(yield* Fiber.join(recording)).toMatchObject([{ text: "recorded" }]);
    expect(attempts).toBe(2);
    expect(yield* speech.waitingForWorker).toBe(false);
    expect(events).toEqual(["window", "dictation", "window"]);
    expect(loadNative).toHaveBeenCalledTimes(2);
  }).pipe(Effect.provide(layer)),
);

it.effect("shares Windows catalog paths and retires the worker before removing the model", () =>
  Effect.gen(function* () {
    installedFile.path = "C:\\models\\test.gguf";
    const speech = yield* SpeechService.SpeechService;
    yield* Effect.promise((signal) =>
      speech.withRecordingWindow("c:/MODELS/TEST.gguf", "auto", signal, async () => undefined),
    );
    expect(
      yield* speech.dictateLocal("test-model", pcm(), DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS),
    ).toBe("hello");
    expect(loadNative).toHaveBeenCalledTimes(1);
    yield* speech.removeModel("test-model");
    expect(native.dispose).toHaveBeenCalledTimes(1);
  }).pipe(Effect.provide(layer)),
);

it.effect("opens the recording VAD in a CPU scoring worker using the shared store", () =>
  Effect.gen(function* () {
    const speech = yield* SpeechService.SpeechService;
    const vad = yield* Effect.promise((signal) => openVad(speech, signal));
    const frame = new Float32Array(512).fill(0.25);
    expect(yield* Effect.promise(() => vad.score([frame]))).toEqual([0.8]);
    expect(download).toHaveBeenCalledWith(SILERO_VAD);
    expect(loadNative).toHaveBeenCalledWith(
      "test.gguf",
      expect.any(AbortSignal),
      undefined,
      "cpu",
      true,
      "vad",
    );
    yield* Effect.promise(async () => vad.close());
  }).pipe(Effect.provide(layer)),
);

it.effect.each(["upload", "stream"] as const)(
  "admits a legacy %s at the next recording window boundary",
  (kind) =>
    Effect.gen(function* () {
      const speech = yield* SpeechService.SpeechService;
      const started = Promise.withResolvers<void>();
      const finish = Promise.withResolvers<void>();
      const window = yield* Effect.promise((signal) =>
        speech.withRecordingWindow("test.gguf", "auto", signal, async () => {
          started.resolve();
          await finish.promise;
        }),
      ).pipe(Effect.forkChild);
      yield* Effect.promise(() => started.promise);
      const settings = yield* ServerSettings.ServerSettingsService;
      yield* settings.updateSettings({
        transcriptionWords: [
          ...Array.from({ length: 33 }, (_, index) => ({
            term: `word${index}`,
            language: "en",
            source: "user" as const,
          })),
          { term: "Alpha Beta", variants: ["alfa"], language: "en", source: "user" },
          { term: "Gamma", variants: ["Beta"], language: "en", source: "user" },
        ],
      });
      native.supportsVocabulary = true;
      native.transcribe.mockResolvedValueOnce({ text: "alfa" });
      native.finish.mockResolvedValueOnce("alfa");
      const options = {
        ...DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS,
        speechLanguage: "en",
        speechCustomWords: [{ term: "Wrong", aliases: ["Alpha Beta", "alfa"] }],
      };
      const request =
        kind === "upload"
          ? speech.transcribe(pcm(), options)
          : Effect.scoped(
              Effect.gen(function* () {
                const stream = yield* speech.startStream(options);
                yield* stream.feed(pcm());
                return yield* stream.finish;
              }),
            );
      const dictation = yield* request.pipe(Effect.forkChild({ startImmediately: true }));
      expect(dictation.pollUnsafe()).toBeUndefined();
      finish.resolve();
      yield* Fiber.join(window);
      expect(yield* Fiber.join(dictation)).toBe("Alpha Beta");
      const nativeOptions =
        kind === "upload" ? native.transcribe.mock.lastCall?.[1] : native.begin.mock.lastCall?.[0];
      expect(nativeOptions).toMatchObject({
        vocabulary: Array.from({ length: 16 }, (_, index) => `word${index}`),
      });
    }).pipe(Effect.provide(layer)),
);

it.effect("a canceled queued dictation leaves the active recording window in place", () =>
  Effect.gen(function* () {
    const speech = yield* SpeechService.SpeechService;
    const started = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const window = yield* Effect.promise((signal) =>
      speech.withRecordingWindow("test.gguf", "auto", signal, async (_worker, attempt) => {
        started.resolve();
        await finish.promise;
        expect(attempt.aborted).toBe(false);
      }),
    ).pipe(Effect.forkChild);
    yield* Effect.promise(() => started.promise);
    const dictation = yield* speech
      .dictateLocal("fallback-model", pcm(), DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS)
      .pipe(Effect.forkChild({ startImmediately: true }));
    try {
      yield* TestClock.adjust("1 second");
      yield* Fiber.interrupt(dictation);
      yield* TestClock.adjust("2 seconds");
      expect(yield* speech.waitingForWorker).toBe(false);
      expect(native.transcribe).not.toHaveBeenCalled();
      for (const change of [
        speech.selectModel("fallback-model"),
        speech.removeModel("test-model"),
      ]) {
        expect(yield* Effect.flip(change)).toBeInstanceOf(SpeechService.SpeechBusyError);
      }
    } finally {
      finish.resolve();
    }
    yield* Fiber.join(window);
    expect(loadNative).toHaveBeenCalledTimes(1);
  }).pipe(Effect.provide(layer)),
);

it.effect("rejects an unsupported dictation language before loading the selected model", () =>
  Effect.gen(function* () {
    const speech = yield* SpeechService.SpeechService;
    const failure = yield* Effect.flip(
      speech.dictateLocal("test-model", pcm(), {
        ...DEFAULT_SPEECH_TRANSCRIPTION_OPTIONS,
        speechLanguage: "he",
      }),
    );
    expect(failure).toBeInstanceOf(SpeechService.SpeechUnsupportedLanguageError);
    expect(failure).toMatchObject({ language: "he" });
    expect(loadNative).not.toHaveBeenCalled();
  }).pipe(Effect.provide(layer)),
);

it.effect("removing a catalog model leaves an unrelated same-name recording worker loaded", () =>
  Effect.gen(function* () {
    installedFile.path = "C:\\models\\test.gguf";
    const speech = yield* SpeechService.SpeechService;
    yield* Effect.promise((signal) =>
      speech.withRecordingWindow(
        "C:\\recordings\\test.gguf",
        "auto",
        signal,
        async () => undefined,
      ),
    );
    yield* speech.removeModel("test-model");
    expect(native.dispose).not.toHaveBeenCalled();
    yield* Effect.promise((signal) =>
      speech.withRecordingWindow("c:/RECORDINGS/test.gguf", "auto", signal, async () => undefined),
    );
    expect(loadNative).toHaveBeenCalledTimes(1);
  }).pipe(Effect.provide(layer)),
);
// SCIENT-FORK:END
