import { expect, it } from "vite-plus/test";
import { loadNativeSpeechModel } from "../speech/native.ts";
import { openLocalEngine } from "./local.ts";
import { frameSize, scoreSpeech } from "./windows.ts";

it("pads a short tail, retries short input and uses the advertised language and source bounds", async () => {
  const fixture =
    "data:text/javascript," +
    encodeURIComponent(`
    class InputTooShort extends Error {}
    export const TranscribeModel = { load: async () => ({
      capabilities: { languages: ["de-DE"] }, supports: () => false,
      transcribe: async (pcm, options) => {
        if (pcm.length < 16000) throw new InputTooShort("too short");
        return { text: options.language, language: "", timestampKind: "none", segments: [{ t0Ms: 0, t1Ms: 0 }] };
      },
    }) };
  `);
  const engine = await openLocalEngine(
    "fixture",
    "de",
    new AbortController().signal,
    "cpu",
    (path, signal, _module, acceleration, graceful) =>
      loadNativeSpeechModel(path, signal, fixture, acceleration, graceful),
  );
  try {
    expect(await engine.recognize(new Float32Array(100), true)).toEqual([
      { text: "de-DE", language: "de-DE", start: 0, end: 100 / 16_000 },
    ]);
  } finally {
    await engine.close();
  }
});

it("recovers structured repetition errors and flags irreducible spans", async () => {
  const fixture =
    "data:text/javascript," +
    encodeURIComponent(`
    class OutputRepetition extends Error {}
    export const TranscribeModel = { load: async () => ({
      capabilities: {}, supports: () => false,
      transcribe: async (pcm) => {
        if (pcm.length > 4000 || pcm[0] === 0) throw new OutputRepetition("repeated");
        return { text: "recovered", language: "", timestampKind: "none", segments: [] };
      },
    }) };
  `);
  const engine = await openLocalEngine(
    "fixture",
    "auto",
    new AbortController().signal,
    "cpu",
    (path, signal) => loadNativeSpeechModel(path, signal, fixture, "cpu", true),
  );
  try {
    const pcm = new Float32Array(8000);
    pcm[4000] = 1;
    expect(await engine.recognize(pcm, false)).toEqual([
      { text: "", start: 0, end: 0.25, needsReview: true },
      { text: "recovered", start: 0.25, end: 0.5, language: "und" },
    ]);
  } finally {
    await engine.close();
  }
});

it("scores VAD batches in the worker and rejects clicks while preserving speech across batches", async () => {
  const fixture =
    "data:text/javascript," +
    encodeURIComponent(`
    export const TranscribeModel = { load: async () => ({
      vadInfo: { sampleRate: 16000, frameSamples: 512 },
      createVadSession: () => ({
        streamFeed: async (pcm) => ({ probs: Array.from({ length: pcm.length / 512 }, (_, index) => pcm[index * 512]) }),
      }),
    }) };
  `);
  const worker = await loadNativeSpeechModel(
    "fixture",
    new AbortController().signal,
    fixture,
    "cpu",
    true,
    "vad",
  );
  async function* frames() {
    for (let index = 0; index < 40; index++) {
      const pcm = new Float32Array(frameSize);
      pcm[0] = index === 0 || index === 29 ? 0.8 : index > 29 ? 0.4 : 0;
      yield pcm;
    }
  }
  try {
    const result = await Array.fromAsync(
      scoreSpeech(frames(), async (batch) => {
        const pcm = new Float32Array(batch.length * frameSize);
        batch.forEach((frame, index) => pcm.set(frame, index * frameSize));
        return worker.scoreFrames(pcm);
      }),
    );
    expect(result.map((frame) => frame.speech)).toEqual([
      ...Array.from({ length: 29 }, () => false),
      ...Array.from({ length: 11 }, () => true),
    ]);
  } finally {
    await worker.dispose();
  }
});

it("uses the native tokenizer to cap Whisper prompts and clears hints on a split retry", async () => {
  const fixture =
    "data:text/javascript," +
    encodeURIComponent(`
    export const TranscribeModel = { load: async () => ({
      capabilities: {}, supports: (feature) => feature === "initial_prompt" || feature === "temperature_fallback",
      tokenize: (text) => new Int32Array([...text].length * 2),
      transcribe: async (_pcm, options) => ({
        text: options.family.initialPrompt ?? "no prompt", language: "en", timestampKind: "none", segments: [],
      }),
    }) };
  `);
  const engine = await openLocalEngine(
    "fixture",
    "auto",
    new AbortController().signal,
    "cpu",
    (path, signal) => loadNativeSpeechModel(path, signal, fixture, "cpu", true),
  );
  try {
    const pcm = new Float32Array(8_000);
    const relevant = "ا".repeat(40);
    const terms = [relevant, "too long to fit"];
    expect(await engine.recognize(pcm, false, { terms })).toMatchObject([{ text: relevant }]);
    const notes = Array.from({ length: 20 }, () => "notes").join(" ");
    expect(await engine.recognize(pcm, false, { prompt: notes })).toMatchObject([
      { text: Array.from({ length: 8 }, () => "notes").join(" ") },
    ]);
    expect(await engine.recognize(pcm, true, { terms, prompt: notes })).toMatchObject([
      { text: "no prompt" },
      { text: "no prompt" },
    ]);
  } finally {
    await engine.close();
  }
});
