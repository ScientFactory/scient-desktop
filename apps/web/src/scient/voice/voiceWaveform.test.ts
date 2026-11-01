import { describe, expect, it } from "vite-plus/test";
import { buildVoiceWaveformLevels, VOICE_WAVEFORM_LEVEL_COUNT } from "./voiceWaveform.ts";

describe("live waveform window", () => {
  it("starts empty and grows as measurements arrive", () => {
    expect(buildVoiceWaveformLevels([])).toEqual([]);
    expect(buildVoiceWaveformLevels([0.1])).toEqual([0.1]);
    expect(buildVoiceWaveformLevels([0.1, 0.2])).toEqual([0.1, 0.2]);
  });

  it("shows fresh speech immediately after a compact row fills, before the history fills", () => {
    const history = [...Array<number>(32).fill(0), 0.2];
    const window = buildVoiceWaveformLevels(history);
    expect(window.slice(-32).at(-1)).toBe(0.2);
    expect(window.slice(-32).filter((level) => level > 0)).toHaveLength(1);
    expect(history).toHaveLength(33);
  });

  // regression: 56f111fc99 fix(voice): center footer presentation and keep waveforms live
  it("keeps the newest audio visible through long recordings and width changes", () => {
    // The recorder keeps the last VOICE_WAVEFORM_LEVEL_COUNT samples; check
    // each side of every visible width and of the history bound.
    for (const sample of [1, 8, 9, 32, 33, 112, 113, 4_500]) {
      const kept = Math.min(sample, VOICE_WAVEFORM_LEVEL_COUNT);
      const history = Array.from({ length: kept }, (_, index) => sample - kept + 1 + index);
      const window = buildVoiceWaveformLevels(history);
      expect(window).toHaveLength(Math.min(sample, 112));
      for (const visibleBars of [1, 8, 32, 64, 96, 112]) {
        const visible = window.slice(-visibleBars);
        expect(visible.at(-1)).toBe(sample);
        expect(visible.filter((level) => level > 0)).toEqual(
          Array.from(
            { length: Math.min(sample, visibleBars) },
            (_, index) => Math.max(1, sample - visibleBars + 1) + index,
          ),
        );
      }
    }
  });

  it("bounds oversized input without mutating it", () => {
    const history = Object.freeze(Array.from({ length: 1_000 }, (_, index) => index));
    expect(buildVoiceWaveformLevels(history)).toEqual(history.slice(-112));
    expect(history).toHaveLength(1_000);
  });
});
