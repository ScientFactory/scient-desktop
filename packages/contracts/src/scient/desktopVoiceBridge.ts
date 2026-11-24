import type { VoiceMicrophoneAccessStatus } from "../voice.ts";

export interface DesktopVoiceBridge {
  /**
   * Ask the native host to establish microphone consent before Chromium opens
   * the capture device. Optional while older desktop shells host a newer UI.
   */
  requestMicrophoneAccess?: () => Promise<VoiceMicrophoneAccessStatus>;
  hadLegacySelection?: () => Promise<boolean>;
  hasLegacyModels?: () => Promise<boolean>;
  removeLegacyModels?: () => Promise<void>;
}
