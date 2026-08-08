// Pure decision function for whether the live provisional-transcript preview
// should run on this machine. Preview replays the whole growing clip through
// whisper on a ~2.5s cadence, so it is only worth enabling when decode is
// comfortably faster than real time and the model loads quickly — otherwise a
// single snapshot would still be running when the next one is due.
//
// This module is NEW (no old-app equivalent) and pure: no Effect runtime, no
// Node builtins, no side effects.

import type { VoiceBenchmarkResult, VoiceCapabilityProbe } from "./capabilityProbe.ts";

/**
 * Enable preview only when a snapshot decodes in at most this fraction of the
 * audio's own length. At 0.6, a ~2.5s snapshot finishes in ~1.5s — well under
 * the base interval, leaving headroom for the next one.
 */
export const LIVE_PREVIEW_MAX_RTF = 0.6;

/** Enable preview only when the model loads in at most this many milliseconds. */
export const LIVE_PREVIEW_MAX_LOAD_MS = 4_000;

export interface LivePreviewGateInput {
  readonly benchmark: VoiceBenchmarkResult | null;
  readonly probe?: VoiceCapabilityProbe;
}

/**
 * Decide whether the live preview loop should run. Pure and deterministic.
 *
 * Requires a measured benchmark that decodes comfortably faster than real time
 * (`0 < rtf <= LIVE_PREVIEW_MAX_RTF`) and loads quickly
 * (`loadMs <= LIVE_PREVIEW_MAX_LOAD_MS`). A `null` benchmark means "unknown",
 * which is treated as off — the caller may still self-gate once it measures.
 * Degenerate (non-finite / non-positive) measurements are treated as off.
 */
export function shouldEnableLivePreview(input: LivePreviewGateInput): boolean {
  const { benchmark } = input;
  if (benchmark === null) {
    return false;
  }
  const { rtf, loadMs } = benchmark;
  if (!Number.isFinite(rtf) || rtf <= 0 || rtf > LIVE_PREVIEW_MAX_RTF) {
    return false;
  }
  if (!Number.isFinite(loadMs) || loadMs > LIVE_PREVIEW_MAX_LOAD_MS) {
    return false;
  }
  return true;
}
