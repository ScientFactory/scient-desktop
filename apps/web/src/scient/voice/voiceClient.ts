// Web-safe accessor for the desktop voice bridge.
//
// The voice surface is desktop-only: `window.desktopBridge.voice` is present
// only in the Electron build and is `undefined` on the web. Every consumer must
// treat it as optional and degrade gracefully when it is absent, exactly like
// `desktopBridge.preview` does elsewhere in the renderer.
//
// The bridge shape is fixed by the host implementation. It is declared locally
// here (rather than imported) because the `voice` member is not yet part of the
// published `DesktopBridge` contract; the runtime shape is guaranteed to match
// what the host exposes. Once `@t3tools/contracts` gains `voice?: ...` on
// `DesktopBridge`, this can collapse to a direct property read.

import type {
  DesktopBridge,
  VoiceCapabilityProbe,
  VoiceCapabilityTier,
  VoiceModelDownloadProgress,
  VoiceModelState,
  VoiceTranscribeRequest,
  VoiceTranscript,
} from "@t3tools/contracts";

/** The desktop-only, host-provided voice IPC surface. */
export interface DesktopVoiceBridge {
  getCapability: () => Promise<{
    readonly probe: VoiceCapabilityProbe;
    readonly tier: VoiceCapabilityTier;
  }>;
  getModelState: () => Promise<VoiceModelState>;
  /** Resolves once the model is ready; rejects on download/verification failure. */
  downloadModel: () => Promise<VoiceModelState>;
  removeModel: () => Promise<VoiceModelState>;
  transcribe: (request: VoiceTranscribeRequest) => Promise<VoiceTranscript>;
  cancelTranscription: () => Promise<void>;
  onModelDownloadProgress: (listener: (progress: VoiceModelDownloadProgress) => void) => () => void;
}

/**
 * `window.desktopBridge` widened to expose the optional `voice` member. This is
 * a structural widening (never `any`), safe because `voice` is optional so any
 * real `DesktopBridge` satisfies it.
 */
type DesktopBridgeWithVoice = DesktopBridge & { readonly voice?: DesktopVoiceBridge };

/**
 * The desktop voice bridge, or `null` on web builds / when the desktop host
 * predates the voice surface. All UI must handle `null`.
 */
export function getVoiceBridge(): DesktopVoiceBridge | null {
  if (typeof window === "undefined") return null;
  const bridge = window.desktopBridge as DesktopBridgeWithVoice | undefined;
  return bridge?.voice ?? null;
}

/** Whether local voice dictation is available in this runtime. */
export function isVoiceSupported(): boolean {
  return getVoiceBridge() !== null;
}
