import type { SpeechService } from "../speech/SpeechService.ts";
import { loadNativeSpeechModel } from "../speech/native.ts";
import { nativeSpeechLanguage } from "../speech/nativeLanguage.ts";
import type { Engine, Recognition, RecognitionHints } from "./job.ts";
import { frameSize, sampleRate } from "./windows.ts";

const minimum = sampleRate / 4;

function tokenConfidence(tokens: readonly { p: number }[] | undefined) {
  const probabilities = (tokens ?? [])
    .map(({ p }) => p)
    .filter((value) => Number.isFinite(value) && value >= 0 && value <= 1);
  return probabilities.length
    ? { confidence: probabilities.reduce((sum, value) => sum + value, 0) / probabilities.length }
    : {};
}

export async function openLocalEngine(
  path: string,
  language: string,
  signal: AbortSignal,
  acceleration = "auto",
  load = loadNativeSpeechModel,
): Promise<Engine> {
  const worker = await load(path, signal, undefined, acceleration, true);
  return localEngine(worker, language, signal);
}

export async function openSharedLocalEngine(
  speech: SpeechService["Service"],
  path: string,
  language: string,
  signal: AbortSignal,
  acceleration: string,
): Promise<Engine> {
  const lease = <A>(use: (engine: Engine) => Promise<A>) =>
    speech.withRecordingWindow(path, acceleration, signal, (worker, attempt) =>
      use(localEngine(worker, language, attempt)),
    );
  const capabilities = await lease(async (engine) => engine);
  return {
    ...capabilities,
    recognize: (pcm, retry, hints) => lease((engine) => engine.recognize(pcm, retry, hints)),
    close: async () => {},
  };
}

function localEngine(
  worker: Awaited<ReturnType<typeof loadNativeSpeechModel>>,
  language: string,
  signal: AbortSignal,
): Engine {
  const hint = nativeSpeechLanguage(worker.languages, language);
  const recognize = async (
    pcm: Float32Array,
    offset: number,
    retry: boolean,
    hints?: RecognitionHints,
  ): Promise<Recognition[]> => {
    const duration = pcm.length / sampleRate;
    const split = async () => {
      const middle = Math.floor(pcm.length / 2);
      return [
        ...(await recognize(pcm.subarray(0, middle), offset, false)),
        ...(await recognize(pcm.subarray(middle), offset + middle / sampleRate, false)),
      ];
    };
    if (retry && pcm.length >= 2 * minimum) return split();

    const padded = pcm.length >= minimum ? pcm : new Float32Array(minimum);
    if (padded !== pcm) padded.set(pcm);
    const infer = async () => {
      try {
        return await worker.recognizeWindow(padded, {
          language: hint,
          vocabulary: hints?.terms,
          prompt: hints?.prompt,
        });
      } catch (error) {
        signal.throwIfAborted();
        if (!(error instanceof Error) || error.name !== "InputTooShort") throw error;
        const withSilence = new Float32Array(Math.max(sampleRate, padded.length + minimum));
        withSilence.set(pcm);
        return worker.recognizeWindow(withSilence, {
          language: hint,
          vocabulary: hints?.terms,
          prompt: hints?.prompt,
        });
      }
    };
    try {
      const result = await infer();
      const detected = [result.language, hint].find((value) => value && value !== "auto") ?? "und";
      if (result.segments.length === 0 || result.timestampKind === "none") {
        return [
          {
            text: result.text,
            language: detected,
            start: offset,
            end: offset + duration,
            ...tokenConfidence(result.tokens),
          },
        ];
      }
      const bound = (ms: number) => offset + Math.max(0, Math.min(duration, ms / 1_000));
      return result.segments.map((segment) => ({
        text: segment.text,
        start: bound(segment.t0Ms),
        end: bound(segment.t1Ms),
        language: detected,
        ...tokenConfidence(
          result.tokens?.slice(segment.firstToken, segment.firstToken + segment.nTokens),
        ),
      }));
    } catch (error) {
      signal.throwIfAborted();
      if (!(error instanceof Error)) throw error;
      if (
        pcm.length >= 2 * minimum &&
        ["InputTooLong", "OutputTruncated", "OutputRepetition"].includes(error.name)
      ) {
        return split();
      }
      if (error.name === "OutputRepetition" || error.name === "InputTooShort") {
        return [{ text: "", start: offset, end: offset + duration, needsReview: true }];
      }
      throw error;
    }
  };
  return {
    retryWithSplit: true,
    recognitionHints: worker.supportsWindowHints === true,
    supportsLanguageDetection: worker.supportsLanguageDetection,
    supportsPrompt: worker.supportsInitialPrompt || worker.supportsContextPrompt,
    recognize: (pcm, retry, hints) => recognize(pcm, 0, retry, retry ? undefined : hints),
    close: worker.dispose,
  };
}

export async function openVad(speech: SpeechService["Service"], signal: AbortSignal) {
  const worker = await speech.openRecordingVad(signal);
  return {
    async score(frames: readonly Float32Array[]) {
      const pcm = new Float32Array(frames.length * frameSize);
      frames.forEach((frame, index) => pcm.set(frame, index * frameSize));
      const scores = await worker.scoreFrames(pcm);
      if (scores.length !== frames.length) throw new Error("Incomplete Silero frame batch.");
      return scores.map((score, index) =>
        frames[index]?.some((sample) => sample !== 0) ? score : 0,
      );
    },
    close: worker.dispose,
  };
}
