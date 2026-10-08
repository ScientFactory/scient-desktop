export const VOICE_WAVEFORM_LEVEL_COUNT = 112;

/** Fixed slots keep the timer stationary; the right edge always contains live audio. */
export function buildVoiceWaveformLevels(levels: readonly number[]): readonly number[] {
  const recent = levels.slice(-VOICE_WAVEFORM_LEVEL_COUNT);
  return [...Array<number>(VOICE_WAVEFORM_LEVEL_COUNT - recent.length).fill(0), ...recent];
}
