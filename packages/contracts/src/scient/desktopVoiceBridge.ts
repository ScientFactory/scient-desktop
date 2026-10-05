import type {
  VoiceModelDownloadRequest,
  VoiceModelDownloadProgress,
  VoiceModelOperationRequest,
  VoiceModelRemoveRequest,
  VoiceModelsSnapshot,
  VoiceMicrophoneAccessStatus,
  VoiceTranscribeRequest,
  VoiceCancelTranscriptionRequest,
  VoiceTranscript,
} from "../voice.ts";

/**
 * Desktop-only local voice transcription bridge. All audio and the whisper
 * runtime stay on-device; nothing here reaches the network except the one-time
 * model download performed by the main process.
 */
export interface DesktopVoiceBridge {
  /**
   * Ask the native host to establish microphone consent before Chromium opens
   * the capture device. Optional while older desktop shells host a newer UI.
   */
  requestMicrophoneAccess?: () => Promise<VoiceMicrophoneAccessStatus>;
  /** Current catalog, selection and install/download state. */
  getModelsState: () => Promise<VoiceModelsSnapshot>;
  /** Download + verify one model, optionally selecting it after verification. */
  downloadModel: (request: VoiceModelDownloadRequest) => Promise<VoiceModelsSnapshot>;
  /** Cancel the matching in-flight model download, preserving partial data. */
  cancelModelDownload: (request: VoiceModelOperationRequest) => Promise<void>;
  /** Select an already-installed model for the next transcription. */
  selectModel: (request: VoiceModelOperationRequest) => Promise<VoiceModelsSnapshot>;
  /** Remove one model and optionally select a confirmed fallback. */
  removeModel: (request: VoiceModelRemoveRequest) => Promise<VoiceModelsSnapshot>;
  /** Transcribe one validated clip. Rejects with a safe, user-facing message. */
  transcribe: (request: VoiceTranscribeRequest) => Promise<VoiceTranscript>;
  /** Legacy cancellation, restricted to requests without an identity. */
  cancelTranscription: () => Promise<void>;
  /** Optional on older hosts. Never fall back to legacy global cancellation. */
  cancelTranscriptionRequest?: (request: VoiceCancelTranscriptionRequest) => Promise<void>;
  /**
   * Observe model-download progress. Implemented by polling `getModelsState`
   * from the preload bridge, so it needs no dedicated push channel. Returns an
   * unsubscribe function.
   */
  onModelDownloadProgress: (listener: (progress: VoiceModelDownloadProgress) => void) => () => void;
}
