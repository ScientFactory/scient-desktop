// The voice bridge exists only in Electron; every consumer must treat its absence on web as an
// optional capability.
import type { DesktopVoiceBridge } from "@t3tools/contracts";

/** Adapter surface consumed by the UI; Electron is only one implementation. */
export type VoiceTranscriptionClient = DesktopVoiceBridge;

/**
 * The desktop voice bridge, or `null` on web builds / when the desktop host
 * predates the voice surface. All UI must handle `null`.
 */
export function getVoiceBridge(): VoiceTranscriptionClient | null {
  if (typeof window === "undefined") return null;
  return window.desktopBridge?.voice ?? null;
}

/** Whether local voice dictation is available in this runtime. */
function isVoiceSupported(): boolean {
  return getVoiceBridge() !== null;
}
