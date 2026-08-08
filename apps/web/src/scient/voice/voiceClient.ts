// Web-safe accessor for the desktop voice bridge.
//
// The voice surface is desktop-only: `window.desktopBridge.voice` is present
// only in the Electron build and is `undefined` on the web. Every consumer must
// treat it as optional and degrade gracefully when it is absent, exactly like
// `desktopBridge.preview` does elsewhere in the renderer.
//
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
export function isVoiceSupported(): boolean {
  return getVoiceBridge() !== null;
}
