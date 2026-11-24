import { expect, it, vi } from "vite-plus/test";
import { sampleSpeechLanguage } from "./languageSample.ts";
import { sampleRate } from "./windows.ts";

it("samples at most eight seconds of speech and uses the detected language", async () => {
  const recognize = vi.fn(async () => [{ language: "he", text: "שלום" }]);
  const close = vi.fn(async () => {});
  async function* frames() {
    yield { pcm: new Float32Array(sampleRate).fill(-1), speech: false };
    yield { pcm: new Float32Array(10 * sampleRate).fill(1), speech: true };
  }
  expect(
    await sampleSpeechLanguage(frames(), async () => ({
      recognize,
      close,
      supportsLanguageDetection: true,
    })),
  ).toBe("he");
  expect(recognize).toHaveBeenCalledWith(new Float32Array(8 * sampleRate).fill(1), false);
  expect(close).toHaveBeenCalledOnce();
});

it("does not load an engine for a silent or insufficient sample", async () => {
  async function* frames() {
    yield { pcm: new Float32Array(sampleRate), speech: true };
  }
  const open = vi.fn();
  expect(await sampleSpeechLanguage(frames(), open)).toBeNull();
  expect(open).not.toHaveBeenCalled();
});
