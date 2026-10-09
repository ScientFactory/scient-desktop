export const VOICE_WAVEFORM_LEVEL_COUNT = 112;

/** Grow from the left, then keep only recent audio once the display fills. */
export function buildVoiceWaveformLevels(levels: readonly number[]): readonly number[] {
  return levels.slice(-VOICE_WAVEFORM_LEVEL_COUNT);
}
