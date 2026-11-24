import * as Speech from "./SpeechService.ts";
import { RateLimited } from "../transcription/job.ts";
import * as ServerSettings from "../serverSettings.ts";
import { dictationPcm, readDictationWav } from "./dictationAudio.ts";
import { DictationError, ProviderInstanceId, WS_METHODS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { it } from "@effect/vitest";
import { expect, vi } from "vite-plus/test";
import type { ScientProviderInstance } from "../provider/ScientProviderInstance.ts";
import { CloudEngineError } from "../transcription/CloudEngines.ts";
import { makeDictationRpcHandlers } from "./DictationRpcHandlers.ts";

function clip(samples = 3) {
  const wav = Buffer.alloc(44 + samples * 2);
  wav.write("RIFF");
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(24_000, 24);
  wav.writeUInt32LE(48_000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(wav.length - 44, 40);
  return wav;
}

function harness() {
  const local = vi.fn((): Effect.Effect<string, Speech.SpeechError> => Effect.succeed("local"));
  const recognize = vi.fn(async () => [{ text: "cloud" }]);
  const resolve = vi.fn((_id: string) =>
    Effect.succeed({
      provider: "openai" as const,
      model: "gpt-transcribe",
      origin: "https://api.openai.com",
      accountName: "fixture",
      fingerprint: "fixture",
      maxAudioBytes: 1_000_000,
      open: () => ({ recognitionHints: true, recognize, close: async () => {} }),
    }),
  );
  const chat = vi.fn(() => Effect.succeed({ text: "chatgpt" }));
  const getInstance = vi.fn((): Effect.Effect<ScientProviderInstance | undefined> =>
    Effect.succeed({
      enabled: true,
      voiceDictation: { dictate: chat },
    } as unknown as ScientProviderInstance),
  );
  const handlers = makeDictationRpcHandlers({
    observeRpcEffect: (_method, effect) => effect,
    speech: { dictateLocal: local, waitingForWorker: Effect.succeed(false) },
    cloud: { resolve },
    providerInstances: { getInstance },
  });
  return {
    invoke: handlers[WS_METHODS.voiceDictate],
    local,
    resolve,
    recognize,
    chat,
    getInstance,
  };
}

const wav = clip();
const audioBase64 = wav.toString("base64");
const cloud = { kind: "cloud", engineId: "engine" } as const;
const chatgpt = { kind: "chatgpt", instanceId: ProviderInstanceId.make("codex") } as const;

it.effect("dispatches local, consented cloud and ChatGPT audio while agent uploads are off", () =>
  Effect.gen(function* () {
    const settings = yield* ServerSettings.ServerSettingsService;
    expect((yield* settings.getSettings).transcription.agentsMayUseCloudEngines).toBe(false);
    const { invoke, local, resolve, recognize, chat, getInstance } = harness();
    const localModel = "vladkens/ivrit-whisper-large-v3-turbo-gguf";
    expect(
      yield* invoke({
        audioBase64,
        language: "he",
        selection: { kind: "local", modelId: localModel },
      }),
    ).toEqual({ text: "local" });
    expect(local).toHaveBeenCalledWith(
      localModel,
      new Uint8Array(8),
      expect.objectContaining({ speechLanguage: "he" }),
    );
    expect(yield* invoke({ audioBase64, selection: cloud, hints: ["Scient"] })).toEqual({
      text: "cloud",
    });
    expect(resolve).toHaveBeenCalledWith(cloud.engineId);
    expect(recognize).toHaveBeenCalledWith(new Float32Array(2), false, { terms: ["Scient"] });
    expect(yield* invoke({ audioBase64, selection: chatgpt })).toEqual({
      text: "chatgpt",
    });
    expect(getInstance).toHaveBeenCalledWith(chatgpt.instanceId);
    expect(chat).toHaveBeenCalledWith({ wav });
  }).pipe(
    Effect.provide(
      ServerSettings.layerTest({ transcription: { agentsMayUseCloudEngines: false } }),
    ),
  ),
);

it.effect(
  "refuses missing consent or an unavailable ChatGPT instance without routing elsewhere",
  () =>
    Effect.gen(function* () {
      const { invoke, recognize, chat, getInstance } = harness();
      getInstance.mockReturnValue(Effect.undefined);
      expect(yield* Effect.flip(invoke({ audioBase64, selection: chatgpt }))).toMatchObject({
        reason: "agent-unavailable",
      });
      expect(chat).not.toHaveBeenCalled();

      const handlers = makeDictationRpcHandlers({
        observeRpcEffect: (_method, effect) => effect,
        speech: undefined,
        cloud: {
          resolve: () =>
            Effect.fail(new CloudEngineError({ code: "consent-required", detail: "" })),
        },
        providerInstances: { getInstance },
      });
      expect(
        yield* Effect.flip(handlers[WS_METHODS.voiceDictate]({ audioBase64, selection: cloud })),
      ).toMatchObject({ reason: "consent-required" });
      expect(recognize).not.toHaveBeenCalled();
    }),
);

it("validates WAV bounds and resamples the shortest accepted clip", () => {
  expect(() => readDictationWav(clip(1).toString("base64"))).toThrow();
  expect(() => readDictationWav(clip(180 * 24_000 + 1).toString("base64"))).toThrow();
  const shortest = clip(2);
  shortest.writeInt16LE(16384, 44);
  expect([...dictationPcm(readDictationWav(shortest.toString("base64")))]).toEqual([
    Math.fround(1 / 3),
  ]);
});

it.effect("returns the speech service's wait flag through the RPC", () =>
  Effect.gen(function* () {
    const handlers = makeDictationRpcHandlers({
      speech: { waitingForWorker: Effect.succeed(true), dictateLocal: () => Effect.die("unused") },
      cloud: undefined,
      providerInstances: { getInstance: () => Effect.undefined },
      observeRpcEffect: (_method, effect) => effect,
    });
    expect(yield* handlers[WS_METHODS.voiceDictationWait]()).toEqual({ waiting: true });
  }),
);

it.effect.each([
  ["model-not-found", new Speech.SpeechModelNotFoundError({ modelId: "missing" })],
  ["unsupported-language", new Speech.SpeechUnsupportedLanguageError({ language: "he" })],
  ["invalid-audio", new Speech.SpeechInvalidAudioError({ byteLength: 0, message: "empty" })],
  ["local-unavailable", new Speech.SpeechBusyError({ operation: "transcription" })],
] as const)("maps local dictation failures to %s", ([reason, failure]) =>
  Effect.gen(function* () {
    const { invoke, local } = harness();
    local.mockReturnValueOnce(Effect.fail(failure));
    const error = yield* Effect.flip(
      invoke({
        selection: { kind: "local", modelId: "fixture" },
        audioBase64,
      }),
    );
    expect(error).toBeInstanceOf(DictationError);
    expect(error).toMatchObject({ reason });
    expect(error.message).not.toBe("");
  }),
);

it.effect("rejects malformed audio before invoking the recognizer", () =>
  Effect.gen(function* () {
    const { invoke, resolve } = harness();
    expect(yield* Effect.flip(invoke({ selection: cloud, audioBase64: "AA==" }))).toMatchObject({
      reason: "invalid-audio",
    });
    expect(resolve).not.toHaveBeenCalled();
  }),
);

it.effect.each([
  ["rate-limited", new RateLimited()],
  ["cloud-unavailable", new Error("provider unavailable")],
] as const)("maps recognition failures to %s", ([reason, failure]) =>
  Effect.gen(function* () {
    const { invoke, recognize } = harness();
    recognize.mockRejectedValueOnce(failure);
    const error = yield* Effect.flip(invoke({ selection: cloud, audioBase64 }));
    expect(error).toBeInstanceOf(DictationError);
    expect(error).toMatchObject({ reason });
    expect(error.message).not.toBe("");
  }),
);
