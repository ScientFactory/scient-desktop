// FILE: voiceIpcChannels.ts
// Purpose: Defines dependency-free IPC names shared by Electron main and preload.
// Layer: Desktop voice IPC contract

export const DESKTOP_VOICE_IPC_CHANNELS = {
  transcribe: "desktop:server-transcribe-voice",
  cancelTranscription: "desktop:voice-cancel-transcription",
  getState: "desktop:voice-get-state",
  downloadModel: "desktop:voice-download-model",
  removeModel: "desktop:voice-remove-model",
  repairModel: "desktop:voice-repair-model",
} as const;
