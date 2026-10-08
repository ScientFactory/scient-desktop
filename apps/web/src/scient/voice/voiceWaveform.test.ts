import { describe, expect, it } from "vite-plus/test";
import { buildVoiceWaveformLevels, VOICE_WAVEFORM_LEVEL_COUNT } from "./voiceWaveform.ts";

describe("live waveform window", () => {
  it("reserves its full width before audio arrives", () => {
    expect(buildVoiceWaveformLevels([])).toEqual(Array<number>(112).fill(0));
  });

  it("shows fresh speech immediately after a compact row fills, before the history fills", () => {
    const history = [...Array<number>(32).fill(0), 0.2];
    const window = buildVoiceWaveformLevels(history);
    expect(window.slice(-32).at(-1)).toBe(0.2);
    expect(window.slice(-32).filter((level) => level > 0)).toHaveLength(1);
    expect(history).toHaveLength(33);
  });

  it("keeps the newest audio visible through thousands of samples and width changes", () => {
    let history: number[] = [];
    for (let sample = 1; sample <= 4_500; sample += 1) {
      history = [...history, sample].slice(-VOICE_WAVEFORM_LEVEL_COUNT);
      const window = buildVoiceWaveformLevels(history);
      expect(window).toHaveLength(112);
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
