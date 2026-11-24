import type { Engine } from "./job.ts";
import { sampleRate, type Frame } from "./windows.ts";

export async function sampleSpeechLanguage(
  frames: AsyncIterable<Frame>,
  open: () => Promise<Engine>,
): Promise<string | null> {
  const pcm = new Float32Array(8 * sampleRate);
  let used = 0;
  for await (const frame of frames) {
    if (!frame.speech) continue;
    const count = Math.min(frame.pcm.length, pcm.length - used);
    pcm.set(frame.pcm.subarray(0, count), used);
    used += count;
    if (used === pcm.length) break;
  }
  if (used < 2 * sampleRate) return null;
  const engine = await open();
  try {
    if (!engine.supportsLanguageDetection) return null;
    const recognized = await engine.recognize(pcm.subarray(0, used), false);
    const weights = new Map<string, number>();
    for (const segment of recognized) {
      const language = segment.language;
      const size = segment.text.trim().length;
      if (
        language &&
        size &&
        language !== "und" &&
        language !== "auto" &&
        /^[a-z]{2,3}(-[a-zA-Z0-9]{2,8})*$/.test(language)
      ) {
        weights.set(language, (weights.get(language) ?? 0) + size);
      }
    }
    return [...weights.entries()].sort((left, right) => right[1] - left[1])[0]?.[0] ?? null;
  } finally {
    await engine.close();
  }
}
