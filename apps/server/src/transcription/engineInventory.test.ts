import { expect, it } from "vite-plus/test";
import { audioTranscriptionHourUsd } from "./engineInventory.ts";

it("matches rates to the billing provider and audio transcription model", () => {
  expect(audioTranscriptionHourUsd("openai", "gpt-transcribe")).toBe(0.27);
  expect(audioTranscriptionHourUsd("openai", "gpt-4o-transcribe")).toBe(0.36);
  expect(audioTranscriptionHourUsd("openai", "gpt-4o-mini-transcribe")).toBe(0.18);
  expect(audioTranscriptionHourUsd("xai", "grok-voice-transcribe-2.0")).toBe(0.1);
  expect(audioTranscriptionHourUsd("compatible", "gpt-4o-transcribe")).toBeUndefined();
  expect(audioTranscriptionHourUsd("openrouter", "gpt-4o-transcribe")).toBeUndefined();
  expect(audioTranscriptionHourUsd("openai", "unknown-model")).toBeUndefined();
});
