// The voice bridge exists only in Electron; every consumer must treat its absence on web as an
// optional capability.
import type { DesktopVoiceBridge } from "@t3tools/contracts";

/**
 * The desktop voice bridge, or `null` on web builds / when the desktop host
 * predates the voice surface. All UI must handle `null`.
 */
export function getVoiceBridge(): DesktopVoiceBridge | null {
  if (typeof window === "undefined") return null;
  return window.desktopBridge?.voice ?? null;
}

import type { VoiceJobTranscriber } from "./voiceProcessing";

export interface VoiceSetupSnapshot {
  readonly runtimeAvailable: boolean;
  readonly runtimeMessage?: string;
  readonly selectedModelId: string | null;
  readonly recommendation: { readonly modelId: string; readonly language?: string | null } | null;
  readonly models: readonly {
    readonly id: string;
    readonly displayName: string;
    readonly description: string;
    readonly byteSize: number;
    readonly grade?: string | undefined;
    readonly state:
      | { readonly state: "ready" | "missing" | "downloading" }
      | { readonly state: "error" | "unavailable"; readonly message: string };
  }[];
}

export interface VoiceSetupClient extends VoiceJobTranscriber {
  readonly requestMicrophoneAccess?: DesktopVoiceBridge["requestMicrophoneAccess"];
  getModelsState(): Promise<VoiceSetupSnapshot>;
  selectModel(request: { modelId: string }): Promise<VoiceSetupSnapshot>;
  downloadModel(request: {
    modelId: string;
    selectOnSuccess?: boolean;
  }): Promise<VoiceSetupSnapshot>;
  cancelModelDownload(request: { modelId: string }): Promise<void>;
  onModelDownloadProgress(
    listener: (progress: { modelId: string; downloadedBytes: number; totalBytes: number }) => void,
  ): () => void;
  readonly forModel?: (modelId: string) => VoiceJobTranscriber;
}
